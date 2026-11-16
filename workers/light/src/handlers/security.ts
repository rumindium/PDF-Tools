import { join } from 'node:path';
import { evaluatePasswordStrength } from '@pdftools/contracts';
import type { EncryptOptions, RestrictOptions, UnlockOptions } from '@pdftools/contracts/tools';
import {
  type SecurityPermissions,
  countPdfPages,
  decryptPdf,
  encryptPdf,
  generateOwnerPassword,
  permissionWarnings,
  readEncryptionState,
  readSignatureRecord,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler, JobContext } from '@pdftools/worker-shared';

/**
 * `encrypt`, `restrict`, and `unlock` — `docs/10-PROTECT-AND-UNLOCK.md`, the whole `security` category.
 *
 * Three tools in one file for the same reason `handlers/pages.ts` holds the three page operations: they are one
 * engine call apart from each other, and the differences between them are *invariants* rather than mechanisms. Those
 * invariants are the substance here, because each one is a way the tool can quietly do the opposite of what it says:
 *
 *  - `encrypt` must produce a file that **cannot** be opened without the password.
 *  - `restrict` must produce a file that **can** be opened without a password — the entire promise is "readable, not
 *    printable", and a file that demands a password it never told the user about is a lockout, not a restriction.
 *  - `unlock` must produce a file with **no** encryption left.
 *
 * Every one of those is checked by reading the written file back (`readEncryptionState`), never by trusting the call
 * that wrote it. The page count is carried across the same way: read from the output by opening it the way the
 * recipient will, and compared with the input's.
 *
 * The owner password is the fourth thing the handler has to get right, and it is the only one that is about a value
 * rather than a file. When the caller does not supply one it is generated (18 random bytes, base64url) and applied; the
 * caller receives it through the runtime's `reveal` channel, which holds it in Redis for exactly as long as the output
 * exists and never writes it into the job row, the queue payload, the event stream, or a log line. See
 * `EncryptionResult` in `@pdftools/engines`. The distinction matters because a security tool whose owner password sits
 * in the `jobs` row is worse than one whose owner password is unrecoverable — and both are worse than one that hands it
 * to the person who owns the file, which is what this does now.
 */

/** What a caller actually denied. The permissions object always carries all eight flags, so "empty" is a real answer. */
function deniedPermissions(permissions: SecurityPermissions): Array<keyof SecurityPermissions> {
  return (Object.entries(permissions) as Array<[keyof SecurityPermissions, boolean]>)
    .filter(([, allowed]) => !allowed)
    .map(([flag]) => flag);
}

function documentOf(ctx: JobContext<unknown>): { path: string } {
  const document = ctx.files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document.' });
  }
  return document;
}

function runOptsOf(ctx: JobContext<unknown>) {
  return {
    cwd: ctx.workDir,
    timeoutMs: ctx.limits.timeoutSeconds * 1000,
    memoryMb: ctx.limits.memoryMb,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

/**
 * `encrypt` and `restrict` refuse an input that is already protected rather than re-keying it.
 *
 * Re-keying would need the *old* password (measured: qpdf fails with `invalid password`, pikepdf raises
 * `PasswordError`), so the only two outcomes are a confusing engine error or silently keeping the old key. The refusal
 * names the remedy instead: unlock it first, then protect it the way you want.
 */
async function refuseEncryptedInput(path: string, opts: Parameters<typeof readEncryptionState>[1]): Promise<void> {
  const state = await readEncryptionState(path, { ...opts, probeOpen: false });
  if (state.encrypted) {
    throw new JobFailure('ENCRYPTED_INPUT', {
      message:
        'The document is already password protected, so its permissions cannot be replaced without the current password. Unlock it first, then protect it again.',
    });
  }
}

/** The honest caveat, present whenever the job actually denied something (`10-PROTECT-AND-UNLOCK.md` §1). */
function readerDependentWarning(denied: Array<keyof SecurityPermissions>): Array<{ code: string; detail: string }> {
  if (denied.length === 0) return [];
  return [
    {
      code: 'PERMISSIONS_READER_DEPENDENT',
      detail: `Permissions are enforced by the reader, not by the cryptography: ${denied.join(', ')} is a request that well-behaved viewers honour. Only a user password actually protects the content.`,
    },
  ];
}

/**
 * A job that restricted nothing, said out loud.
 *
 * `encrypt` with no user password and `restrict` with every permission allowed both produce a file that opens freely
 * and allows everything — the only difference from the input is an owner password nobody holds. Returning that as a
 * success without a word is how a user comes to believe their document is protected when it is not.
 */
function noRestrictionWarning(
  denied: Array<keyof SecurityPermissions>,
  userPassword: string,
): Array<{
  code: string;
  detail: string;
}> {
  if (denied.length > 0 || userPassword !== '') return [];
  return [
    {
      code: 'NO_RESTRICTION_APPLIED',
      detail:
        'No permission was denied and no password is needed to open the output, so the document is not restricted in any way a reader will notice. Set a user password, or deny at least one permission.',
    },
  ];
}

/**
 * The warning that accompanies a generated owner password — true about the *channel* as well as the value.
 *
 * It used to end with "it cannot be recovered later", which was true and useless: the caller had no way to change the
 * permissions on their own document. Now the value is delivered in the same response's `secrets`, and what the warning
 * has to say is the part that is still true — it is held only as long as the output is, and nowhere else — plus the
 * remedy that keeps working after it is gone.
 */
function ownerPasswordWarning(generated: boolean): Array<{ code: string; detail: string }> {
  if (!generated) return [];
  return [
    {
      code: 'OWNER_PASSWORD_GENERATED',
      detail:
        'An owner password was generated for you: it is in this response (`secrets.ownerPassword`) and is not stored with the job. Save it now — the service holds it only while the output file exists. Without it, the permissions on this document can never be changed; re-running this tool on the original is the way to get different ones.',
    },
  ];
}

/**
 * The strength policy's second half — the half the API cannot finish.
 *
 * The API refuses the *request* when the caller's plan requires the policy, because that is the only layer that knows
 * the plan. When it does not require it, the password is accepted — and this is where the product says so rather than
 * letting a weak password pass in silence: the caller who chose `abcd1234` and was allowed to keeps their document and
 * gets one line telling them what it is worth. A job that quietly accepted a weak password is how a user comes to
 * believe a document is protected when it is not, which is the same failure the `NO_RESTRICTION_APPLIED` warning above
 * exists for, one level down.
 *
 * It reads `requireStrongPasswords` from the options rather than re-deriving it from a plan, because the plan is not
 * part of the worker's payload: the flag is the API's decision, frozen into the job. That also means the warning can
 * never disagree with the judgement that let the job through.
 *
 * Only passwords this tool **sets** are judged — `restrict`'s generated user password is empty on purpose, and a
 * generated owner password is 24 random characters that cannot fail a length-and-classes rule.
 */
function weakPasswordWarnings(
  passwords: Array<{ key: string; value: string | undefined }>,
  requireStrongPasswords: boolean,
): Array<{ code: string; detail: string }> {
  if (requireStrongPasswords) return [];
  const warnings: Array<{ code: string; detail: string }> = [];
  for (const { key, value } of passwords) {
    if (!value) continue;
    const strength = evaluatePasswordStrength(value);
    if (strength.meetsPolicy) continue;
    warnings.push({
      code: 'WEAK_PASSWORD_ACCEPTED',
      detail: `${key} was accepted and the document is protected by it, but it is weak: ${strength.issues.join('; ')}. Strength is the only thing standing between this file and whoever finds it — re-run the tool with a longer password, or ask an administrator to require strong passwords on this plan.`,
    });
  }
  return warnings;
}

/**
 * `encrypt` — the only tool in the category that actually protects content.
 *
 * The strength of the output is the strength of the password, and nothing here is rate-limited by the file: the
 * handler's job is to make sure the file is keyed to the password the caller typed, and that is verified by reopening
 * the output with it inside the same engine call.
 */
export const encrypt: Handler<EncryptOptions> = async (ctx) => {
  const { options, outputDir, report } = ctx;
  const document = documentOf(ctx);
  const runOpts = runOptsOf(ctx);

  await refuseEncryptedInput(document.path, runOpts);

  // Safe to read the signature *because* of the refusal above: the input is known not to be encrypted. Protection
  // wraps the file's bytes in a new container, so the offsets a signature's `/ByteRange` names stop pointing at the
  // content that was signed — the signature is invalid from the moment this job runs, not from the moment it leaks.
  const signature = await readSignatureRecord(document.path, runOpts);
  const invalidatedSignature = signatureInvalidatedWarning(signature);

  report({ progress: 20, phase: 'processing', message: 'Encrypting the document.' });

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to protect.' });
  }

  const userPassword = options.userPassword ?? '';
  const outputPath = join(outputDir, 'protected.pdf');
  const result = await encryptPdf(
    document.path,
    outputPath,
    {
      userPassword,
      ...(options.ownerPassword ? { ownerPassword: options.ownerPassword } : {}),
      encryption: options.encryption,
      permissions: options.permissions,
    },
    runOpts,
  );

  if (result.pages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Protecting the document changed its page count: ${pages} in, ${result.pages ?? 0} out.`,
    });
  }
  if (userPassword !== '' && result.opensWithoutPassword) {
    // The measured claim the tool is named after. `encrypt` with a user password has exactly one way to fail badly.
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The output opens without a password, so it was not delivered.',
    });
  }

  const denied = deniedPermissions(options.permissions);
  report({ progress: 95, phase: 'finalizing' });

  return {
    outputs: [{ name: 'protected.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages,
      encryption: options.encryption,
      revision: result.revision,
      method: result.method,
      permissionsDenied: denied,
      permissionsOk: !result.opensWithoutPassword,
      opensWithoutPassword: result.opensWithoutPassword,
      ownerPasswordGenerated: result.ownerPasswordGenerated,
      verify: 'reopened-with-the-applied-password',
      seconds: result.seconds,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings: [
      ...(invalidatedSignature ? [invalidatedSignature] : []),
      ...permissionWarnings(options.permissions, options.encryption),
      ...readerDependentWarning(denied),
      ...noRestrictionWarning(denied, userPassword),
      ...ownerPasswordWarning(result.ownerPasswordGenerated),
      ...weakPasswordWarnings(
        [
          { key: 'userPassword', value: userPassword || undefined },
          { key: 'ownerPassword', value: options.ownerPassword },
        ],
        options.requireStrongPasswords === true,
      ),
    ],
    // The one value this handler produces that must not reach the record. The runtime stashes it for the caller and
    // never merges it into `metrics`, which is the difference between handing someone a password and leaking one.
    ...(result.generatedOwnerPassword ? { reveal: { ownerPassword: result.generatedOwnerPassword } } : {}),
    engine: { name: 'pikepdf' },
  };
};

/**
 * `restrict` — permissions without a password, which is the shape almost everyone actually wants.
 *
 * The difference from `encrypt` is one field (`userPassword: ''`) and one invariant that is promoted to a failure:
 * the output **must** open with no password. If it does not, the tool has produced a lockout, and a lockout the user
 * cannot see is worse than a failed job.
 */
export const restrict: Handler<RestrictOptions> = async (ctx) => {
  const { options, outputDir, report } = ctx;
  const document = documentOf(ctx);
  const runOpts = runOptsOf(ctx);

  await refuseEncryptedInput(document.path, runOpts);

  // The same rewrite as `encrypt`, minus the password, and the same consequence for a signature the document carried.
  const signature = await readSignatureRecord(document.path, runOpts);
  const invalidatedSignature = signatureInvalidatedWarning(signature);

  report({ progress: 20, phase: 'processing', message: 'Applying the restrictions.' });

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to restrict.' });
  }

  const outputPath = join(outputDir, 'restricted.pdf');
  const result = await encryptPdf(
    document.path,
    outputPath,
    {
      userPassword: '',
      ...(options.ownerPassword ? { ownerPassword: options.ownerPassword } : {}),
      encryption: options.encryption,
      permissions: options.permissions,
    },
    runOpts,
  );

  if (result.pages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Restricting the document changed its page count: ${pages} in, ${result.pages ?? 0} out.`,
    });
  }
  if (!result.opensWithoutPassword) {
    throw new JobFailure('CONVERSION_FAILED', {
      message:
        'The output requires a password that was never shown to you, so it was not delivered. The document was left untouched.',
    });
  }

  const denied = deniedPermissions(options.permissions);
  report({ progress: 95, phase: 'finalizing' });

  return {
    outputs: [{ name: 'restricted.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages,
      encryption: options.encryption,
      revision: result.revision,
      method: result.method,
      permissionsDenied: denied,
      opensWithoutPassword: result.opensWithoutPassword,
      ownerPasswordGenerated: result.ownerPasswordGenerated,
      verify: 'opened-with-no-password',
      seconds: result.seconds,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings: [
      ...(invalidatedSignature ? [invalidatedSignature] : []),
      ...permissionWarnings(options.permissions, options.encryption),
      ...readerDependentWarning(denied),
      ...noRestrictionWarning(denied, ''),
      ...ownerPasswordWarning(result.ownerPasswordGenerated),
      ...weakPasswordWarnings(
        [{ key: 'ownerPassword', value: options.ownerPassword }],
        options.requireStrongPasswords === true,
      ),
    ],
    ...(result.generatedOwnerPassword ? { reveal: { ownerPassword: result.generatedOwnerPassword } } : {}),
    engine: { name: 'pikepdf' },
  };
};

/**
 * `unlock` — remove encryption with a password the caller already holds.
 *
 * Three decisions, each one a place where the helpful-looking behaviour is the wrong one:
 *
 *  1. **Unlocking a file that is not encrypted succeeds**, with a warning. The tool's promise is "this file will have
 *     no password afterwards", which is already true; refusing would fail the user who cannot tell whether their
 *     document is protected, which is most of the people who reach for this tool.
 *  2. **An input that was only restricted (no password, permissions set) loses its restrictions**, because that is what
 *     removing encryption means. The restrictions that were dropped are named in the metrics and the warning, so the
 *     user finds out from the job rather than from a reader that now lets them edit.
 *  3. **A wrong password is a `WRONG_PASSWORD`, never a partial file.** The engine writes the output only after the
 *     password is accepted, and the refusal is measured from the file (the same password is used to read its pages).
 */
export const unlock: Handler<UnlockOptions> = async (ctx) => {
  const { options, outputDir, report } = ctx;
  const document = documentOf(ctx);
  const runOpts = runOptsOf(ctx);

  const state = await readEncryptionState(document.path, runOpts);
  if (!state.encrypted) {
    report({ progress: 60, phase: 'processing', message: 'The document is not encrypted.' });
    const outputPath = join(outputDir, 'unlocked.pdf');
    await Bun.write(outputPath, Bun.file(document.path));
    const pages = await countPdfPages(outputPath, runOpts);
    report({ progress: 95, phase: 'finalizing' });
    return {
      outputs: [{ name: 'unlocked.pdf', mime: 'application/pdf', primary: true }],
      metrics: {
        pages,
        wasEncrypted: false,
        restrictionsRemoved: [],
        requiredPassword: false,
        verify: 'not-encrypted-on-output',
      },
      warnings: [
        {
          code: 'INPUT_NOT_ENCRYPTED',
          detail:
            'The document was not password protected, so there was nothing to remove. The output is a copy of the input.',
        },
      ],
      engine: { name: 'qpdf' },
    };
  }

  report({ progress: 30, phase: 'processing', message: 'Removing the encryption.' });
  const removed = (Object.keys(state.permissions) as Array<keyof SecurityPermissions>).filter(
    (flag) => state.permissions[flag] === false,
  );

  const outputPath = join(outputDir, 'unlocked.pdf');
  const result = await decryptPdf(document.path, outputPath, options.password, runOpts);

  // Read the output the way the recipient will: no password at all.
  const after = await readEncryptionState(outputPath, runOpts);
  if (after.encrypted) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The output is still encrypted, so it was not delivered.',
    });
  }
  if (after.pages == null) {
    // Distinct from the check above on purpose: "still encrypted" and "qpdf cannot read the file it just wrote" are
    // different defects, and collapsing them cost an hour when the reader returned `pages: null` for a plain file.
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The output could not be read back, so it was not delivered.',
    });
  }
  if (result.pages != null && after.pages !== result.pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Unlocking changed the page count: ${result.pages} in, ${after.pages} out.`,
    });
  }

  report({ progress: 95, phase: 'finalizing' });
  return {
    outputs: [{ name: 'unlocked.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: after.pages,
      wasEncrypted: true,
      revision: state.revision,
      method: state.method,
      requiredPassword: !state.opensWithoutPassword,
      restrictionsRemoved: removed,
      verify: 'encryption-absent-on-output',
      seconds: result.seconds,
    },
    warnings:
      removed.length > 0
        ? [
            {
              code: 'RESTRICTIONS_REMOVED',
              detail: `The document also carried permission flags (${removed.join(', ')}), which cannot survive decryption: the output allows everything the format can allow.`,
            },
          ]
        : [],
    engine: { name: 'pikepdf' },
  };
};
