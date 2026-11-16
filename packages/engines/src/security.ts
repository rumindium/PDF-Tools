import { randomBytes } from 'node:crypto';
import { config } from '@pdftools/config';
import { JobFailure } from '@pdftools/errors';
import { parseJsonLine, runPythonScriptStdin } from './python';
import { type RunOptions, run } from './run';

/**
 * The encryption engine shared by `encrypt`, `restrict`, and `unlock` (`docs/10-PROTECT-AND-UNLOCK.md`).
 *
 * Three tool ids, one engine call, and two things make this module unlike the others in this package. Both are about
 * not believing what you produced:
 *
 *  1. **A secret travels through it.** The password never reaches argv (`run`'s `stdin` option, `python.ts`), and the
 *     password verifier is not allowed to be a string comparison against what we just wrote: it is `qpdf` opening the
 *     *file* with the password and reading its page count. That is the only check that would fail if the transport
 *     mangled the password on the way in.
 *  2. **The output makes a claim that can be false.** "This file is encrypted" and "printing is denied" are properties
 *     of the bytes, readable from the encryption dictionary, and a file that says it is encrypted while a reader opens
 *     it without a password is worse than a failed job. So every write is read back (`readEncryptionState`) and every
 *     permission flag is compared against `qpdf --show-encryption`'s own reading of the file.
 *
 * The engine is pikepdf rather than qpdf's CLI, and that is a deliberate departure from the doc's §4 recipe. qpdf can
 * only take the passwords being *set* as arguments (`--user-password=`/`--owner-password=`, or positional) — there is
 * no `--password-file` for the write path, only for reading — so the doc's own promise ("passed to qpdf via a file
 * descriptor rather than argv") is unimplementable through the CLI. pikepdf writes the same encryption handlers
 * through the same library, takes the whole request in one payload, and gets it on stdin.
 *
 * `metadata` is passed explicitly here rather than inherited, because the default that changes between pikepdf releases
 * must not be what decides whether a document's metadata is protected: the flag exists so a caller *can* ask for
 * cleartext metadata (`--cleartext-metadata`). It is `true` for the AES revisions and `false` for `rc4-128`, and that
 * split is not a preference — pikepdf raises `ValueError: Cannot encrypt metadata when R < 4`, and the legacy revisions
 * have no metadata flag in the format, so `false` is the only expressible value there. Measured in both directions: the
 * refusal on the way in, and a `/Title` planted in the document staying unreadable in the output's raw bytes with
 * `false` set.
 */

/** What a reader may do with the document, as the shipped contract's `permissions` object names it. */
export interface SecurityPermissions {
  print: boolean;
  printHighRes: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
  accessibility: boolean;
}

/**
 * The one table that maps a contract flag to a pikepdf permission field and to the line qpdf prints for it.
 *
 * Measured, one flag at a time, by writing a file with pikepdf and reading it back with `qpdf --show-encryption`; the
 * `qpdfLine` column is the *observed* text, not a paraphrase of it. Keeping both columns here is what lets the unit
 * tests assert the mapping and the golden suite assert the file — the same claim at two levels, from one source.
 *
 * The eight flags are independent in the file even though qpdf's *CLI* presents some of them as levels
 * (`--modify=form` implies `--modify=assembly`). Written as bits, `fillForms: true` with `annotate: false` is a real
 * state — "fill in existing fields, do not comment" — and it reads back that way, which is a correction to
 * `10-PROTECT-AND-UNLOCK.md` §2, where that combination is listed as rejected. The doc's rule is right about qpdf's
 * flag interface and wrong about the format.
 */
export const PERMISSION_TABLE: ReadonlyArray<{
  flag: keyof SecurityPermissions;
  pikepdf: string;
  qpdfLine: string;
}> = [
  { flag: 'accessibility', pikepdf: 'accessibility', qpdfLine: 'extract for accessibility' },
  { flag: 'copy', pikepdf: 'extract', qpdfLine: 'extract for any purpose' },
  { flag: 'print', pikepdf: 'print_lowres', qpdfLine: 'print low resolution' },
  { flag: 'printHighRes', pikepdf: 'print_highres', qpdfLine: 'print high resolution' },
  { flag: 'modify', pikepdf: 'modify_other', qpdfLine: 'modify other' },
  { flag: 'annotate', pikepdf: 'modify_annotation', qpdfLine: 'modify annotations' },
  { flag: 'fillForms', pikepdf: 'modify_form', qpdfLine: 'modify forms' },
  { flag: 'assemble', pikepdf: 'modify_assembly', qpdfLine: 'modify document assembly' },
];

/** The pikepdf field order, which is positional in the constructor (`Permissions(*values)`). */
const PIKEPDF_PERMISSION_ORDER = [
  'accessibility',
  'extract',
  'modify_annotation',
  'modify_assembly',
  'modify_form',
  'modify_other',
  'print_lowres',
  'print_highres',
] as const;

export interface EncryptionRequest {
  /** `''` (or absent) means the file opens without a password — what `restrict` is. */
  userPassword?: string;
  /**
   * The owner password, or absent to have one generated. **It is never empty**, and that is not a convenience: see
   * `resolveOwnerPassword`.
   */
  ownerPassword?: string;
  encryption: EncryptionName;
  permissions: SecurityPermissions;
}

export interface EncryptionState {
  encrypted: boolean;
  /** `6` for AES-256, `4` for AES-128, `3` for RC4-128, `null` when the file is not encrypted. */
  revision: number | null;
  /**
   * `AESv3`, `AESv2`, `RC4`… — the file's own `stream encryption method`, not what we asked for.
   *
   * **`null` for revision 3**, and that is qpdf's report rather than a parsing gap: `--show-encryption` prints no
   * `stream encryption method` line for the RC4 revisions (measured on a file this build wrote). The revision is the
   * only cipher statement available for those files, which is why the golden case asserts the cipher through poppler
   * (`algorithm: RC4`) and the revision through qpdf.
   */
  method: string | null;
  /** Keyed by the flag name, valued by what qpdf read out of the file. Empty for an unencrypted file. */
  permissions: Partial<Record<keyof SecurityPermissions, boolean>>;
  /** The load-bearing one: `qpdf` opened the file with **no password** and read its page count. */
  opensWithoutPassword: boolean;
  /** Page count, when the file could be opened at all. */
  pages: number | null;
}

/**
 * Refuse the one combination that cannot be expressed.
 *
 * `printHighRes: true` with `print: false` does not produce a contradictory file — **measured**: the bits come back as
 * "print low resolution: allowed, print high resolution: allowed", because high-resolution printing implies printing.
 * So the caller who asked to deny printing receives a fully printable document, which is the worst outcome available
 * here: a restriction that silently is not one. Refusing is the only honest answer.
 */
export function assertPermissionsCoherent(permissions: SecurityPermissions): void {
  if (permissions.printHighRes && !permissions.print) {
    throw new JobFailure('VALIDATION_ERROR', {
      message:
        'permissions.printHighRes cannot be true while permissions.print is false: high-resolution printing implies printing, so the output would be fully printable. Set printHighRes to false, or print to true.',
    });
  }
}

/**
 * What this format cannot do, said out loud rather than discovered later.
 *
 * `accessibility: false` is silently ineffective on every AES revision — **measured twice**: qpdf's CLI prints
 * `-accessibility=n is ignored for modern encryption formats`, and a pikepdf write with the flag off reads back
 * "extract for accessibility: allowed". The flag stays in the contract because removing an option is a breaking
 * change, and because there is one revision where it *does* work: `rc4-128`, where the same write reads back
 * "extract for accessibility: not allowed" (asserted by a golden case — see below). So the warning is no longer a
 * blanket one; it fires only for the revisions that genuinely drop the flag, which is what makes it precise enough
 * to be believed rather than noise a caller learns to scroll past.
 *
 * The legacy cipher gets a warning of its own, for the opposite reason: there the request is honoured and the
 * problem is the cipher. RC4-128 is broken by construction, and a caller who picked it for an old reader should be
 * told what they are trading away rather than discovering it in a security review.
 */
export function permissionWarnings(
  permissions: SecurityPermissions,
  encryption: EncryptionName,
): Array<{ code: string; detail: string }> {
  const warnings: Array<{ code: string; detail: string }> = [];
  if (!permissions.accessibility && isAes(encryption)) {
    warnings.push({
      code: 'ACCESSIBILITY_FLAG_IGNORED',
      detail:
        'accessibility: false was ignored: neither qpdf nor the AES encryption handlers can deny accessibility extraction, and the output allows it. Every other permission you set is honoured. The RC4-128 revision is the one that enforces this flag.',
    });
  }
  if (encryption === 'rc4-128') {
    warnings.push({
      code: 'LEGACY_ENCRYPTION',
      detail:
        'The document was protected with RC4-128, a cipher that is broken by modern standards and is offered only for readers that cannot do better. Its permissions are enforced by the reader, and its encryption does not resist a determined attacker: re-protect the document with AES-256 as soon as the old reader is out of the way.',
    });
  }
  return warnings;
}

/**
 * A password the transport can carry.
 *
 * Both transports truncate: `--password-file` uses the **first line** (and qpdf warns "all but the first line of the
 * password file are ignored" while succeeding), and a pikepdf string would keep the newline and produce a file keyed
 * to something *different* from what the user typed. Accepting a newline would mean writing a document that its owner
 * cannot open with the password they believe they set. Trailing spaces and tabs were measured and do survive, so only
 * the line terminators are refused.
 */
export function assertPasswordTransportable(password: string, label: string): void {
  if (/[\r\n]/.test(password)) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `${label} cannot contain a line break: the password is carried over a pipe as a single line, so anything after the first break would be silently dropped.`,
    });
  }
}

/**
 * The owner password given to a caller who did not choose one: 18 random bytes, base64url, 24 characters.
 *
 * `randomBytes`, not a UUID: a UUID v4 has 122 bits but a fixed, recognisable shape, and this value is the one thing
 * standing between the document and having its permissions changed by whoever finds the file. 24 URL-safe characters
 * fit a password manager field and can be read out loud without ambiguity.
 */
export function generateOwnerPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * The owner password that will actually be written — never an empty one.
 *
 * **Measured, and it is the difference between a protected document and an unprotected one.** qpdf treats an empty
 * owner password as “no owner password”, which makes the *owner* role openable by anyone: a file written as
 * `Encryption(owner='', user='secret')` requires no password at all — `qpdf --show-npages` returns the page count
 * without being asked for one, and `pdfinfo` reports it as encrypted while serving it to anyone. The first version of
 * this module passed the caller's empty owner password straight through, and the `encrypt` golden case failed with
 * "the output opens without a password" instead of shipping a document that looked protected and was not.
 *
 * So: an absent or empty owner password becomes a generated one. The caller who supplied only a user password gets the
 * same treatment as the one who supplied neither, and `ownerPasswordGenerated` is what tells them a value they do not
 * hold is now guarding the permissions.
 */
function resolveOwnerPassword(requested: string | undefined): { password: string; generated: boolean } {
  if (requested && requested !== '') return { password: requested, generated: false };
  return { password: generateOwnerPassword(), generated: true };
}

/** The three revisions this build writes, as the contract names them. */
export type EncryptionName = 'aes-256' | 'aes-128' | 'rc4-128';

/** Whether a revision is AES — the question the accessibility warning actually turns on. */
export function isAes(name: EncryptionName): boolean {
  return name !== 'rc4-128';
}

/**
 * The R (revision) and `aes` flag for a contract encryption name.
 *
 * `rc4-128` is revision **3** with `aes=False`, and that pair is the whole point of offering it: the accessibility
 * permission is read out of the same dictionary, and it is only on the legacy revisions that a reader honours it.
 * Measured on the output rather than taken from pikepdf's docs — a golden case asks qpdf what the file says.
 */
export function encryptionSettings(name: EncryptionName): { revision: number; aes: boolean } {
  if (name === 'aes-256') return { revision: 6, aes: true };
  if (name === 'aes-128') return { revision: 4, aes: true };
  return { revision: 3, aes: false };
}

/** One `Permissions(...)` value per pikepdf field name, in the positional order the constructor takes. */
export function buildPermissionValues(
  permissions: SecurityPermissions,
): Record<(typeof PIKEPDF_PERMISSION_ORDER)[number], boolean> {
  const values = {} as Record<(typeof PIKEPDF_PERMISSION_ORDER)[number], boolean>;
  for (const entry of PERMISSION_TABLE) {
    values[entry.pikepdf as (typeof PIKEPDF_PERMISSION_ORDER)[number]] = permissions[entry.flag];
  }
  for (const name of PIKEPDF_PERMISSION_ORDER) values[name] ??= false;
  return values;
}

/**
 * What the write produced, as read back from the file.
 *
 * `generatedOwnerPassword` is the one field here that must not be treated like the others, and the type says so by
 * being optional: a handler receives it, hands it to the runtime's `reveal` channel, and it is never part of the job
 * record. Everything else a handler returns — metrics, warnings — is written into the `jobs` row as JSON, so a
 * generated owner password put there would be the plaintext secret in the database that `0-SECURITY.md` forbids. The
 * distinction is worth the awkwardness: the alternative, dropping the value on the floor, is what the first version
 * did, and it left the caller holding a document whose permissions only this service could ever change. That is also
 * how Acrobat behaves, and it is a worse story than giving the password to the person who owns the file.
 */
export interface EncryptionResult {
  ownerPasswordGenerated: boolean;
  /** Present **only** when the password was generated here, and destined for the reveal channel, never the record. */
  generatedOwnerPassword?: string;
  revision: number;
  method: string | null;
  permissions: Partial<Record<keyof SecurityPermissions, boolean>>;
  opensWithoutPassword: boolean;
  /** Page count read back from the **written** file by opening it with the password just applied. */
  pages: number | null;
  seconds: number;
}

/**
 * Write an encrypted copy of `input` at `output`, then read the result back.
 *
 * The read-back is not decoration: `pages` and `opensWithoutPassword` come from opening the file that was just
 * written, so a job that claims to have restricted a document has a second, independent witness that it did.
 */
export async function encryptPdf(
  input: string,
  output: string,
  request: EncryptionRequest,
  opts: Omit<RunOptions, 'engine'>,
): Promise<EncryptionResult> {
  assertPermissionsCoherent(request.permissions);
  const userPassword = request.userPassword ?? '';
  assertPasswordTransportable(userPassword, 'userPassword');
  if (request.ownerPassword) assertPasswordTransportable(request.ownerPassword, 'ownerPassword');
  const owner = resolveOwnerPassword(request.ownerPassword);
  const ownerPassword = owner.password;

  const { revision, aes } = encryptionSettings(request.encryption);
  const result = await runPythonScriptStdin(
    WRITE_ENCRYPTED,
    {
      input,
      output,
      userPassword,
      ownerPassword,
      revision,
      aes,
      // `true` means "encrypt the metadata", and it is refused below R=4 rather than ignored: pikepdf raises
      // `ValueError: Cannot encrypt metadata when R < 4` (**measured** in the light image, and it is what made the
      // first `rc4-128` job fail with an unhelpful `CONVERSION_FAILED`). The legacy revisions have no metadata flag in
      // the format at all — measured the other way as well: with `false`, a `/Title` planted in the document is not
      // readable in the output's raw bytes, so nothing is being given away here.
      metadata: isAes(request.encryption),
      permissionOrder: PIKEPDF_PERMISSION_ORDER,
      permissions: buildPermissionValues(request.permissions),
    },
    opts,
  );

  const parsed = parseJsonLine<{
    written?: true;
    pages?: number;
    verifyPages?: number;
    error?: { code: string; detail?: string };
  }>(result.stdout);
  if (parsed?.error) {
    throw new JobFailure(mapScriptError(parsed.error.code), {
      message: parsed.error.detail ?? 'The document could not be encrypted.',
    });
  }
  if (!parsed?.written) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The document was not written.',
      stderrTail: result.stdout + result.stderr,
    });
  }

  const state = await readEncryptionState(output, opts);
  if (!state.encrypted) {
    // The one failure this tool must never have: a file the caller believes is protected and is not.
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The output is not encrypted, so it was not delivered.',
    });
  }
  if (parsed.verifyPages == null) {
    // The script reopens its own output with the password it just set; a missing count means it could not, which is
    // "the file is keyed to something other than the password the user typed" — the one transport failure that would
    // otherwise be discovered by the user, locked out of their own document.
    throw new JobFailure('CONVERSION_FAILED', {
      message:
        'The written document could not be reopened with the password that was applied, so it was not delivered.',
    });
  }

  return {
    ownerPasswordGenerated: owner.generated,
    ...(owner.generated ? { generatedOwnerPassword: owner.password } : {}),
    revision: state.revision ?? revision,
    method: state.method,
    permissions: state.permissions,
    opensWithoutPassword: state.opensWithoutPassword,
    pages: parsed.verifyPages,
    seconds: Math.round(result.durationMs / 100) / 10,
  };
}

/**
 * What the file itself says about its encryption — never what the caller asked for.
 *
 * Parsed out of `qpdf --show-encryption`, which is the reader's view rather than the writer's. Two facts are easy to
 * get wrong and are both handled here:
 *
 *  - `--show-encryption` exits **0** even with no password and even with a wrong one; it prints "Incorrect password
 *    supplied" and still lists the dictionary's revision and permissions. So it is the right tool for "what does this
 *    file claim" and the wrong tool for "does this password open it" — for that, `opensWithoutPassword` runs a second
 *    command that actually reads the page tree (`--show-npages`), which exits 2 with `invalid password` when the
 *    password is missing or wrong.
 *  - "Supplied password is user password" is printed whenever the user password is **empty**, including when the
 *    caller supplied nothing at all (`restrict`'s output does this). It is not evidence that a password was given.
 */
export async function readEncryptionState(
  path: string,
  opts: Omit<RunOptions, 'engine'> & { probeOpen?: boolean },
): Promise<EncryptionState> {
  const shown = await run(resolveQpdf(), ['--show-encryption', path], { ...opts, engine: 'qpdf' });

  // The page probe runs for an unencrypted file too, and the first version returning `pages: null` there is exactly
  // how `unlock` came to reject its own correct output: the handler reads "pages is null" as "the file could not be
  // opened", and the reader had not tried. The count means "what a caller without a password can see", which is a
  // real answer for a plain document — it is the page count.
  let opensWithoutPassword = true;
  let pages: number | null = null;
  if (opts.probeOpen !== false) {
    const opened = await run(resolveQpdf(), ['--show-npages', path], {
      ...opts,
      engine: 'qpdf',
      timeoutMs: Math.min(opts.timeoutMs, 30_000),
    });
    opensWithoutPassword = opened.code === 0;
    const count = Number.parseInt(opened.stdout.trim(), 10);
    pages = Number.isFinite(count) ? count : null;
  }

  if (shown.code !== 0 || /File is not encrypted/.test(shown.stdout)) {
    return {
      encrypted: false,
      revision: null,
      method: null,
      permissions: {},
      opensWithoutPassword,
      pages,
    };
  }

  const parsed = parseEncryptionReport(shown.stdout);
  return {
    encrypted: true,
    revision: parsed.revision,
    method: parsed.method,
    permissions: parsed.permissions,
    opensWithoutPassword,
    pages,
  };
}

/**
 * The `qpdf --show-encryption` report, as data.
 *
 * Split out from the call so it can be tested against **captured** output — the exact text qpdf 12.2.0 printed for an
 * AES-256 file, a restricted file, and a plain one. The parsing is the part that a qpdf upgrade would break, and it is
 * the part that can be exercised without an engine in the test environment.
 *
 * `permissions` is keyed by the contract flag and only carries the flags the report actually named: a report that is
 * missing a line must read as "unknown", not as "denied", because the difference decides whether a job claims to have
 * restricted something.
 */
export function parseEncryptionReport(stdout: string): {
  revision: number | null;
  method: string | null;
  permissions: Partial<Record<keyof SecurityPermissions, boolean>>;
} {
  const revision = /^R = (\d+)$/m.exec(stdout);
  const method = /^stream encryption method: (.+)$/m.exec(stdout);
  const permissions: Partial<Record<keyof SecurityPermissions, boolean>> = {};
  for (const entry of PERMISSION_TABLE) {
    const line = new RegExp(`^${entry.qpdfLine}: (allowed|not allowed)$`, 'm').exec(stdout);
    if (line) permissions[entry.flag] = line[1] === 'allowed';
  }
  return {
    revision: revision ? Number(revision[1]) : null,
    method: method ? method[1]!.trim() : null,
    permissions,
  };
}

/**
 * Remove encryption with a password the caller supplied — a password that may be either the user's or the owner's.
 *
 * No two-attempt loop: qpdf and pikepdf both try the supplied password as the user password and then as the owner
 * password, and the owner password was **measured** to open a file created by `encrypt` directly. A retry loop here
 * would make a wrong password cost two spawns and would report the same `WRONG_PASSWORD` anyway.
 *
 * The output is verified to be *not encrypted* rather than trusted to be: `Pdf.save` without an `encryption` argument
 * is the mechanism, and "the mechanism should have worked" is exactly the claim the `pdf-to-pdfa` output intent taught
 * this codebase not to accept.
 */
export async function decryptPdf(
  input: string,
  output: string,
  password: string,
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ pages: number | null; seconds: number }> {
  assertPasswordTransportable(password, 'password');

  const result = await runPythonScriptStdin(REMOVE_ENCRYPTION, { input, output, password }, opts);
  const parsed = parseJsonLine<{ pages?: number; error?: { code: string; detail?: string } }>(result.stdout);
  if (parsed?.error) {
    throw new JobFailure(mapScriptError(parsed.error.code), {
      message: parsed.error.detail ?? 'The document could not be unlocked.',
    });
  }
  if (parsed?.pages == null) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The document was not written.',
      stderrTail: result.stdout + result.stderr,
    });
  }

  const pages = Number.isFinite(parsed.pages) ? parsed.pages : null;
  return { pages, seconds: Math.round(result.durationMs / 100) / 10 };
}

/** The script error codes, mapped onto the API's vocabulary (`packages/contracts/src/errors.ts`). */
function mapScriptError(code: string): 'ENCRYPTED_INPUT' | 'WRONG_PASSWORD' | 'CONVERSION_FAILED' {
  if (code === 'ENCRYPTED_INPUT') return 'ENCRYPTED_INPUT';
  if (code === 'WRONG_PASSWORD') return 'WRONG_PASSWORD';
  // `PASSWORD_NOT_APPLIED` included: there is no error code for "the file is keyed to something else", and a new one
  // would have to be added to the API's status table for a case the caller cannot act on differently from a failed
  // conversion. The message is what carries the distinction.
  return 'CONVERSION_FAILED';
}

function resolveQpdf(): string {
  // `qpdf` is on PATH in every worker image, and `ENGINE_QPDF_PATH` can point somewhere else; the light pool's engine
  // check already refuses to start without it, so there is no ENGINE_UNAVAILABLE branch to write here.
  return config.engines.qpdf ?? 'qpdf';
}

/**
 * Write an encrypted copy, or report *why* it could not.
 *
 * The payload arrives on stdin (`runPythonScriptStdin`) because it contains passwords. The script prints one JSON line
 * and never a traceback for the two failures a caller can cause; anything else — a corrupt input, a pikepdf internal —
 * exits non-zero and surfaces as `CONVERSION_FAILED` with its stderr, because that is a bug here and not in the file.
 */
const WRITE_ENCRYPTED = `import json, sys
import pikepdf

payload = json.load(sys.stdin)
allow = pikepdf.Permissions(*[bool(payload['permissions'][name]) for name in payload['permissionOrder']])
try:
    pdf = pikepdf.Pdf.open(payload['input'])
except pikepdf.PasswordError:
    print(json.dumps({'error': {'code': 'ENCRYPTED_INPUT', 'detail': 'The document is already password protected.'}}))
    sys.exit(0)
with pdf:
    if pdf.is_encrypted:
        print(json.dumps({'error': {'code': 'ENCRYPTED_INPUT', 'detail': 'The document is already password protected.'}}))
        sys.exit(0)
    pages = len(pdf.pages)
    pdf.save(
        payload['output'],
        encryption=pikepdf.Encryption(
            owner=payload['ownerPassword'],
            user=payload['userPassword'],
            R=payload['revision'],
            allow=allow,
            aes=payload['aes'],
            metadata=payload['metadata'],
        ),
    )

# Read the file back with the password that was just applied. This is the only check that fails when the password
# transport mangles the value, and it is what makes 'the password you typed opens this file' a measured claim.
try:
    reopened = pikepdf.Pdf.open(payload['output'], password=payload['userPassword'])
except pikepdf.PasswordError:
    print(json.dumps({'error': {'code': 'PASSWORD_NOT_APPLIED'}}))
    sys.exit(0)
with reopened:
    verifyPages = len(reopened.pages)
print(json.dumps({'written': True, 'pages': pages, 'verifyPages': verifyPages}))`;

/**
 * Remove encryption, with the two outcomes a caller can cause separated from a crash.
 *
 * `PasswordError` is the whole point of the try: it is the difference between "you gave me the wrong password" (a 422
 * with a remedy) and "this file is broken" (a 500 with an engine tail). Writing the output before that distinction
 * would be how a partial, still-encrypted file reaches the user.
 */
const REMOVE_ENCRYPTION = `import json, sys
import pikepdf

payload = json.load(sys.stdin)
try:
    pdf = pikepdf.Pdf.open(payload['input'], password=payload['password'])
except pikepdf.PasswordError:
    print(json.dumps({'error': {'code': 'WRONG_PASSWORD'}}))
    sys.exit(0)
with pdf:
    pages = len(pdf.pages)
    # encryption=False is load-bearing: pikepdf REMEMBERS the encryption of the document it opened and re-applies it on
    # save, so a plain save(output) writes a file that is still encrypted — which is what the first version did, and
    # what the handler's "the output is still encrypted" refusal caught. Removing encryption is something this call has
    # to ask for, not something that happens by leaving the argument out. (No backticks in here: this comment lives
    # inside a TypeScript template literal, and one would end the string — the defect this repository has now recorded
    # four times, see 0-IMPLEMENTATION-STATUS.md.)
    pdf.save(payload['output'], encryption=False)
print(json.dumps({'pages': pages}))`;
