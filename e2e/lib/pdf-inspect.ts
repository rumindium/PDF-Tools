import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { planWorkerExec } from '../../scripts/dev/worker-transport';

/**
 * The repository root as the host's own path — **`fileURLToPath`, never `URL.pathname`.**
 *
 * Measured on Windows, where the gap is not cosmetic: `new URL('../..', import.meta.url).pathname` returns
 * `/D:/…` (a URL path, leading slash and all), and `spawn('docker', …, { cwd: '/D:/…' })` fails with ENOENT
 * under both runtimes — the *directory* does not exist, so the docker executable is never even looked up. The
 * harness calls this file from Bun (the golden suite) and from Node (the Playwright browser stage), where
 * `typeof Bun` is `undefined` and `Bun`-only spellings like `import.meta.dir` throw; `fileURLToPath` is
 * implemented by both and round-trips `import.meta.url` to the real directory on every platform.
 *
 * The other half of the Windows hang this fixed: a spawn that fails to start emits an `error` event and —
 * under Bun, measured — no `close` at all, so a plain `await close` waits forever. Every `node:child_process`
 * spawn in this file therefore races `error` against `close`, so a broken bridge answers `null` ("no container
 * answered") in the same breath the process would have failed — instead of hanging the suite.
 */
export function repoRootFrom(moduleUrl: URL): string {
  return fileURLToPath(moduleUrl);
}

//
// Every reader in this file runs its statement through `planWorkerExec` (`scripts/dev/worker-transport.ts`), which
// sends it to `docker compose exec worker-light` when a Docker daemon answers and runs it on this host otherwise — the
// `scripts/noroot-stack.sh` case, where the engines are on `PATH` instead of in a container and a reader that only
// knew the container would answer `null` ("no container was reachable") on a stack that was up.
//

/**
 * Reading a PDF's bytes, for the E2E suites.
 *
 * The point of these checks is that they do not trust the API: a job that reports "5 pages" while serving a
 * truncated or reversed document passes every response-level assertion and fails here. Two facts about PDF output
 * make the difference between a working check and a decorative one, and both were learned the hard way:
 *
 *   1. **Page count must come from the document**, so it is counted from `/Type /Page` objects rather than from a
 *      field in a JSON response.
 *   2. **Text is usually compressed.** qpdf and Ghostscript compress streams that arrive uncompressed
 *      (`--compress-streams=y` is qpdf's default), so searching raw bytes for a label finds nothing even when the
 *      content is intact. Streams are inflated first.
 *   3. **Objects can be inside object streams.** PDF/A-2 and -3 output is PDF 1.7, where Ghostscript compresses the
 *      `/OutputIntents` dictionary into a `/Type /ObjStm` stream — so a search that stops at the first half reports a
 *      perfectly archival file as missing the intent it unmistakably has. Every literal search here covers the raw
 *      bytes *and* every inflated stream, and the walks are exhaustive rather than first-match.
 *   4. **A text run can be a hex string.** A producer writes `(literal)` while the text fits the font's encoding and
 *      switches to `<hex>` the moment it does not — so the *same* words are two different byte runs depending on who
 *      wrote the file. Measured: `redact`'s output carries the page label `redact fixture — page 1 of 1` as
 *      `<726564616374206669787475726520e2809420…> Tj` where the input carried it as a `(…) Tj` literal. A search
 *      that reads only literals therefore reports a page that *still has its label* as one that has lost it — which
 *      turns a presence control into a false accusation, and makes every absence assertion a statement about the
 *      encoding rather than about the text. Every haystack here covers the decoded hex strings too.
 *   5. **And a literal string's own escapes.** The other spelling of the same problem: a PDF string is written between
 *      parentheses, and the three characters that cannot appear raw — `(`, `)`, and the backslash — arrive with a
 *      backslash in front of them. Measured on this repository's own fixture, a `PAREN(9X7)` text run is written
 *      `(PAREN\(9X7\)) Tj`, and that is exactly what a redaction leaves untouched; searching for the token's *text*
 *      found nothing while the token was plainly in the file. Octal escapes (`\351` for `é`) and the `\<newline>`
 *      continuation are the same shape of problem. Both spellings are decoded into the haystacks.
 */

/**
 * The permission names `qpdf --show-encryption` prints, keyed by the contract's flag names.
 *
 * Deliberately a **copy** of the product's `PERMISSION_TABLE` rather than an import of it. The harness reads the file
 * with a different engine from the one that wrote it, and a shared table would mean a renamed flag on the product side
 * silently renamed the assertion here — the two readings have to be able to disagree for either to be worth anything.
 * The unit tests own the product's mapping; this file owns qpdf's vocabulary.
 */
export const QPDF_PERMISSION_LINES: Record<string, string> = {
  accessibility: 'extract for accessibility',
  copy: 'extract for any purpose',
  print: 'print low resolution',
  printHighRes: 'print high resolution',
  modify: 'modify other',
  annotate: 'modify annotations',
  fillForms: 'modify forms',
  assemble: 'modify document assembly',
};

export interface EncryptionReading {
  /** What **qpdf** says: the revision, the cipher, the per-flag permissions, and *which* password it was given. */
  qpdf: {
    encrypted: boolean;
    revision: number | null;
    method: string | null;
    permissions: Record<string, boolean>;
    /**
     * Which password qpdf was handed — `owner`, `user`, `incorrect`, or `none` when it said neither.
     *
     * **The only reading that answers "is this value actually the owner password".** "The file opened" does not: on a
     * `restrict` output poppler opens it with any `-opw` value. qpdf validates the supplied password against both keys
     * and says which one matched, which is what separates the value the engine applied from a plausible string the job
     * produced beside it. `null` when no owner password was supplied to this call — an empty `--password=` matches a
     * file whose user password is empty, and reading that as an answer would be reading it as the wrong question.
     */
    passwordRole: 'owner' | 'user' | 'incorrect' | 'none' | null;
    /** The same reading for the deliberately-wrong value the caller supplied as a control — `null` when none was. */
    nearMissPasswordRole: 'owner' | 'user' | 'incorrect' | 'none' | null;
  };
  /**
   * What **poppler** says, asked without a password and then with one.
   *
   * A second reader on purpose: poppler shares no code with pikepdf/qpdf, so "the file opens with this password" is a
   * claim two independent implementations agree on. It is also the reader that answers the question the harness cannot
   * ask qpdf — whether the document opens *without* a password — because `qpdf --show-encryption` exits 0 either way.
   */
  poppler: {
    opensWithoutPassword: boolean;
    opensWithPassword: boolean;
    encrypted: boolean;
    algorithm: string | null;
    pages: number | null;
    permissions: Record<string, boolean>;
    /**
     * Whether poppler opens the document with the **owner** password — `null` when no owner password was supplied.
     *
     * A user password and an owner password both open a document, so the two readings have to be asked separately —
     * but this leg is only as strong as the file it is asked about, and on a `restrict` output it is worth nothing:
     * the user password there is empty, and **measured**, `pdfinfo -opw <anything>` exits 0 on such a file, so a random
     * string satisfies it. It is kept because on a file that demands a user password poppler's refusal is an
     * independent witness; the load-bearing reading is `qpdf.passwordRole` below.
     */
    opensWithOwnerPassword: boolean | null;
  };
}

/**
 * Which password qpdf says it was given, out of `--show-encryption`'s own report.
 *
 * Three lines, all observed rather than assumed (qpdf 12.2.0, in the light image): `Supplied password is owner
 * password`, `Supplied password is user password`, and `Incorrect password supplied` — the last one printed *before*
 * the rest of the report, so a file whose dictionary is readable is not mistaken for one that opened.
 */
export function suppliedPasswordRole(text: string): 'owner' | 'user' | 'incorrect' | 'none' {
  if (/^Supplied password is owner password$/m.test(text)) return 'owner';
  if (/^Supplied password is user password$/m.test(text)) return 'user';
  if (/Incorrect password supplied/.test(text)) return 'incorrect';
  return 'none';
}

/**
 * Read a document's encryption state with two engines, in one container call.
 *
 * The bytes go in on stdin (neither `qpdf --show-encryption` nor `pdfinfo` accepts `-`, but a shell can stage them),
 * and both readers report in one pass so a case pays one process spawn for two independent opinions.
 *
 * `null` is returned when no container is reachable, and the caller must treat that as a failure rather than a skip:
 * a `--expect-encrypted` case that silently checked nothing is the failure mode this whole file is written against.
 */
export async function readEncryption(
  bytes: Uint8Array | Buffer,
  opts: { password?: string; ownerPassword?: string; ownerPasswordNearMiss?: string; repoRoot: string },
): Promise<EncryptionReading | null> {
  const statement = [
    'rm -f /tmp/e2e-encryption.pdf',
    'cat > /tmp/e2e-encryption.pdf',
    'printf "### PDFINFO-NO-PASSWORD\n"',
    'pdfinfo /tmp/e2e-encryption.pdf 2>&1; printf "### EXIT %s\n" "$?"',
    'printf "### PDFINFO-WITH-PASSWORD\n"',
    'pdfinfo -upw "$E2E_PASSWORD" /tmp/e2e-encryption.pdf 2>&1; printf "### EXIT %s\n" "$?"',
    'printf "### PDFINFO-WITH-OWNER-PASSWORD\n"',
    'pdfinfo -opw "$E2E_OWNER_PASSWORD" /tmp/e2e-encryption.pdf 2>&1; printf "### EXIT %s\n" "$?"',
    'printf "### QPDF\n"',
    'qpdf --show-encryption /tmp/e2e-encryption.pdf 2>&1; printf "### EXIT %s\n" "$?"',
    'printf "### QPDF-OWNER-PASSWORD\n"',
    'qpdf --password="$E2E_OWNER_PASSWORD" --show-encryption /tmp/e2e-encryption.pdf 2>&1; printf "### EXIT %s\n" "$?"',
    'printf "### QPDF-NEAR-MISS-PASSWORD\n"',
    'qpdf --password="$E2E_OWNER_NEAR_MISS" --show-encryption /tmp/e2e-encryption.pdf 2>&1; printf "### EXIT %s\n" "$?"',
  ].join('\n');

  const plan = planWorkerExec(
    'worker-light',
    {
      E2E_PASSWORD: opts.password ?? '',
      E2E_OWNER_PASSWORD: opts.ownerPassword ?? '',
      E2E_OWNER_NEAR_MISS: opts.ownerPasswordNearMiss ?? '',
    },
    statement,
  );

  try {
    const proc = Bun.spawn(plan.argv, {
      cwd: opts.repoRoot,
      env: plan.env,
      stdin: bytes instanceof Buffer ? bytes : Buffer.from(bytes),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 && stdout.trim() === '') return null;

    const section = (name: string): { text: string; exitCode: number | null } => {
      const start = stdout.indexOf(`### ${name}`);
      if (start < 0) return { text: '', exitCode: null };
      const rest = stdout.slice(start + name.length + 4);
      const next = rest.indexOf('### ');
      const text = next < 0 ? rest : rest.slice(0, next);
      const exit = /### EXIT (-?\d+)/.exec(next < 0 ? rest : rest.slice(next))?.[1];
      return { text, exitCode: exit == null ? null : Number(exit) };
    };

    const noPassword = section('PDFINFO-NO-PASSWORD');
    const withPassword = section('PDFINFO-WITH-PASSWORD');
    const withOwnerPassword = section('PDFINFO-WITH-OWNER-PASSWORD');
    const qpdf = section('QPDF');
    const qpdfWithOwner = section('QPDF-OWNER-PASSWORD');
    const qpdfWithNearMiss = section('QPDF-NEAR-MISS-PASSWORD');

    const popplerFields = (text: string): Record<string, string> => {
      const fields: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const match = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
        if (match) fields[match[1]!.trim()] = match[2]!.trim();
      }
      return fields;
    };

    // The encryption line is looked for in **both** reports: a file with a user password refuses poppler without one
    // ("Command Line Error: Incorrect password"), so reading only the first report is how a correctly protected
    // document came back with `algorithm: null` here while qpdf was confirming revision 6 and AESv3.
    const encryptedLine = /^Encrypted:\s*yes \((.*)\)$/m.exec(`${noPassword.text}\n${withPassword.text}`)?.[1] ?? null;
    const popplerPermissions: Record<string, boolean> = {};
    for (const dimension of ['print', 'copy', 'change', 'addNotes']) {
      const flag = new RegExp(`(?:^|\\s)${dimension}:(yes|no)(?:\\s|$)`, 'i').exec(encryptedLine ?? '')?.[1];
      if (flag) popplerPermissions[dimension] = flag.toLowerCase() === 'yes';
    }
    const algorithm = /algorithm:([^\s)]+)/.exec(encryptedLine ?? '')?.[1] ?? null;

    const qpdfPermissions: Record<string, boolean> = {};
    for (const [flag, line] of Object.entries(QPDF_PERMISSION_LINES)) {
      const value = new RegExp(`^${line}: (allowed|not allowed)$`, 'm').exec(qpdf.text)?.[1];
      if (value) qpdfPermissions[flag] = value === 'allowed';
    }

    return {
      qpdf: {
        encrypted: !/File is not encrypted/.test(qpdf.text) && /^R = \d+$/m.test(qpdf.text),
        revision: Number(/^R = (\d+)$/m.exec(qpdf.text)?.[1] ?? Number.NaN) || null,
        method: /^stream encryption method: (.+)$/m.exec(qpdf.text)?.[1]?.trim() ?? null,
        permissions: qpdfPermissions,
        passwordRole: opts.ownerPassword ? suppliedPasswordRole(qpdfWithOwner.text) : null,
        nearMissPasswordRole: opts.ownerPasswordNearMiss ? suppliedPasswordRole(qpdfWithNearMiss.text) : null,
      },
      poppler: {
        opensWithoutPassword: noPassword.exitCode === 0,
        opensWithPassword: withPassword.exitCode === 0,
        encrypted: encryptedLine != null || /Incorrect password/.test(noPassword.text),
        algorithm,
        pages: popplerFields(withPassword.text).Pages ? Number(popplerFields(withPassword.text).Pages) : null,
        permissions: popplerPermissions,
        // `null` rather than `false` when nothing was asked: an empty `-opw` is not "this password failed", it is
        // "no owner password was tried", and reporting it as a denial would make the caller's check vacuous.
        opensWithOwnerPassword: opts.ownerPassword ? withOwnerPassword.exitCode === 0 : null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * How the words a case is written in (the contract's `highlight`, `underline`, `strike`, `note`) map onto the names the
 * file itself carries — `/Highlight`, `/Underline`, `/StrikeOut`, `/Text`.
 *
 * A deliberate **copy** of the product's table, for the same reason `QPDF_PERMISSION_LINES` is a copy of the permission
 * mapping: one side writes the file and the other reads it, and a shared constant would let a mistranslation agree with
 * itself. This table is what makes `--expect-annotation strike=1` a statement about a `/StrikeOut` dictionary; without
 * it, the case has to speak the PDF's vocabulary and stops being a check on the translation at all.
 */
export const ANNOTATION_SUBTYPES_IN_FILE: Record<string, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'StrikeOut',
  note: 'Text',
};

/**
 * A subtype name as a case writes it: the contract's word where the file's word has a contract equivalent, and the
 * file's own lowercase name otherwise (a document can arrive with an annotation kind this product never writes).
 */
export function canonicalSubtype(name: string): string {
  const raw = name.replace(/^\//, '').toLowerCase();
  for (const [contract, inFile] of Object.entries(ANNOTATION_SUBTYPES_IN_FILE)) {
    if (inFile.toLowerCase() === raw) return contract;
  }
  return raw;
}

export interface AnnotationReading {
  total: number;
  pages: Array<{ page: number; subtypes: string[]; quadPoints: number; allPrint: boolean }>;
}

/**
 * Read a document's annotations with **pikepdf**, in the `worker-light` container.
 *
 * An annotation check that looked for `/Subtype /Highlight` in the raw bytes would be a check on compression rather
 * than on content: pikepdf writes the objects, and the `/Annots` array of a page can sit inside a `/Type /ObjStm`
 * stream. It also would not answer the two questions these assertions are actually about — *how many* marks of each
 * kind, and whether each one carries the print flag (`/F 4`) — because both live in dictionaries, not in a byte run.
 *
 * pikepdf rather than qpdf, unlike `readEncryption`: the reader here may share an implementation with the writer, which
 * is a weakness, so the assertions that matter draw their evidence from somewhere else too — the *ink* a flattened mark
 * leaves is measured from a poppler render (`inkShare`), and a subtype this reader reported is cross-checked against the
 * contract's own name for it. `null` means no container is reachable, and every caller must fail rather than skip.
 */
export async function readAnnotationState(
  bytes: Uint8Array | Buffer,
  opts: { repoRoot: string },
): Promise<AnnotationReading | null> {
  const program = [
    'import json, pikepdf',
    'pdf = pikepdf.Pdf.open("/tmp/e2e-annots.pdf")',
    'pages = []',
    'total = 0',
    'for index, page in enumerate(pdf.pages, start=1):',
    '    subtypes = []',
    '    quads = 0',
    '    prints = True',
    '    for annot in page.obj.get("/Annots", []):',
    '        subtype = str(annot.get("/Subtype", "")).lstrip("/")',
    '        if subtype:',
    '            subtypes.append(subtype)',
    '        if "/QuadPoints" in annot:',
    '            quads += len(annot["/QuadPoints"]) // 8',
    '        if not int(annot.get("/F", 0)) & 4:',
    '            prints = False',
    '        total += 1',
    '    pages.append({"page": index, "subtypes": subtypes, "quadPoints": quads, "allPrint": prints})',
    'print(json.dumps({"total": total, "pages": pages}))',
  ].join('\n');

  // Base64 rather than a quoted here-document: stdin is already carrying the PDF, and a program with quotes and
  // slashes in it survives one more layer of shell only if it is not text any more.
  const encoded = Buffer.from(program, 'utf8').toString('base64');
  const statement = [
    'rm -f /tmp/e2e-annots.pdf',
    'cat > /tmp/e2e-annots.pdf',
    'printf %s "$E2E_ANN_PROG" | base64 -d > /tmp/e2e-annots.py',
    'python3 /tmp/e2e-annots.py',
  ].join('\n');

  const annotPlan = planWorkerExec('worker-light', { E2E_ANN_PROG: encoded }, statement);

  try {
    const proc = Bun.spawn(annotPlan.argv, {
      cwd: opts.repoRoot,
      env: annotPlan.env,
      stdin: bytes instanceof Buffer ? bytes : Buffer.from(bytes),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 && stdout.trim() === '') return null;
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('{'));
    if (!line) return null;
    return JSON.parse(line) as AnnotationReading;
  } catch {
    return null;
  }
}

export interface FormFieldReading {
  /** Whether the catalog has an `/AcroForm` at all — a form whose fields were dropped usually loses this too. */
  hasAcroForm: boolean;
  /** `/T` of every field, in document order, including those reached through a parent's `/Kids`. */
  names: string[];
  /** Widget annotations, which is the count a form that survived has and a flattened one does not. */
  widgets: number;
}

/**
 * The form fields a document still has, read with **pikepdf** in the `worker-light` container.
 *
 * `merge`'s contract says a merge is not a flatten operation, so the fields of every input must be in the output —
 * a claim no page count, text extraction or byte search can see, because a field is a dictionary that no page content
 * references. A raw-byte search for `/T (employee_name)` would also pass on a document whose `/AcroForm` had been
 * detached, which is exactly the failure `n-up` produced (defect 83) for a different reason.
 *
 * The `/Kids` walk is the load-bearing part: a radio group is one field with two widgets, so a walk that only read
 * `/Fields` would report four fields for a five-field form and call it correct.
 */
export async function readFormFields(
  bytes: Uint8Array | Buffer,
  opts: { repoRoot: string },
): Promise<FormFieldReading | null> {
  const program = [
    'import json, pikepdf',
    'pdf = pikepdf.Pdf.open("/tmp/e2e-fields.pdf")',
    'acroform = pdf.Root.get("/AcroForm")',
    'names = []',
    'def walk(fields, depth=0):',
    '    for field in fields or []:',
    '        if not isinstance(field, pikepdf.Dictionary):',
    '            continue',
    '        title = field.get("/T")',
    '        if title is not None:',
    '            names.append(str(title))',
    '        kids = field.get("/Kids")',
    '        if depth < 20 and kids is not None:',
    '            walk(kids, depth + 1)',
    'walk(acroform.get("/Fields") if acroform is not None else None)',
    'widgets = 0',
    'for page in pdf.pages:',
    '    for annot in page.obj.get("/Annots", []):',
    '        if str(annot.get("/Subtype", "")) == "/Widget":',
    '            widgets += 1',
    'print(json.dumps({"hasAcroForm": acroform is not None, "names": names, "widgets": widgets}))',
  ].join('\n');

  const encoded = Buffer.from(program, 'utf8').toString('base64');
  const statement = [
    'rm -f /tmp/e2e-fields.pdf',
    'cat > /tmp/e2e-fields.pdf',
    'printf %s "$E2E_FIELDS_PROG" | base64 -d > /tmp/e2e-fields.py',
    'python3 /tmp/e2e-fields.py',
  ].join('\n');

  const fieldsPlan = planWorkerExec('worker-light', { E2E_FIELDS_PROG: encoded }, statement);

  try {
    const proc = Bun.spawn(fieldsPlan.argv, {
      cwd: opts.repoRoot,
      env: fieldsPlan.env,
      stdin: bytes instanceof Buffer ? bytes : Buffer.from(bytes),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 && stdout.trim() === '') return null;
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('{'));
    if (!line) return null;
    return JSON.parse(line) as FormFieldReading;
  } catch {
    return null;
  }
}

export interface AnnotationGeometry {
  page: number;
  /** The contract's name for the subtype, where it has one (`highlight`, `note`…). */
  subtype: string;
  /** `/Rect` as the file stores it: `[llx, lly, urx, ury]`, in points from the page's lower-left. */
  rect: [number, number, number, number];
  /** How many quads `/QuadPoints` holds, i.e. `length / 8`. */
  quadPoints: number;
  hasPrintFlag: boolean;
}

/**
 * Every annotation in a document, with its own rectangle — **pikepdf**, in the `worker-light` container.
 *
 * `readAnnotationState` answers "how many marks of each kind, and do they print"; this answers "*where* is this mark",
 * which is the question a placement canvas exists to get right. Both are read from the dictionaries rather than from
 * the bytes: a `/Rect` inside an object stream or a compressed `/Annots` array is invisible to a text search, and the
 * four numbers being compared are exactly what a byte scan cannot compare.
 *
 * `null` means no container is reachable, and every caller fails rather than skipping: a placement check that silently
 * passes when the stack is down is a check that has never run.
 *
 * Spawned through `node:child_process`, not `Bun.spawn`, for the reason `pdfPageTexts` records: the **browser** case for
 * `annotate` reads its mark back with this function, Playwright runs its workers under Node even when the command was
 * `bun run test:browser`, and `Bun.spawn` there threw — the catch returned `null` and the case failed with "no pikepdf
 * container is reachable" on a stack that was up. `node:child_process` is implemented by Bun as well, so one spelling
 * serves both runners. A `repoRoot` of `URL.pathname` (`/D:/…` on Windows) kills this spawn with ENOENT, and a spawn
 * whose `error` nobody watches waits forever for a `close` that never comes — the Windows hang `repoRootFrom` and
 * `pdfPageTexts` document, and the reason the await below races `error` against `close`.
 */
export async function readAnnotationGeometry(
  bytes: Uint8Array | Buffer,
  opts: { repoRoot: string },
): Promise<AnnotationGeometry[] | null> {
  const program = [
    'import json, pikepdf',
    'pdf = pikepdf.Pdf.open("/tmp/e2e-annots.pdf")',
    'marks = []',
    'for index, page in enumerate(pdf.pages, start=1):',
    '    for annot in page.obj.get("/Annots", []):',
    '        subtype = str(annot.get("/Subtype", "")).lstrip("/")',
    '        rect = [float(value) for value in annot.get("/Rect", [])]',
    '        marks.append({',
    '            "page": index,',
    '            "subtype": subtype,',
    '            "rect": rect,',
    '            "quadPoints": len(annot["/QuadPoints"]) // 8 if "/QuadPoints" in annot else 0,',
    '            "hasPrintFlag": bool(int(annot.get("/F", 0)) & 4),',
    '        })',
    'print(json.dumps(marks))',
  ].join('\n');

  // Base64 rather than a quoted here-document: stdin is already carrying the PDF, and a program with quotes and slashes
  // in it survives one more layer of shell only if it is not text any more.
  const encoded = Buffer.from(program, 'utf8').toString('base64');
  const statement = [
    'rm -f /tmp/e2e-annots.pdf',
    'cat > /tmp/e2e-annots.pdf',
    'printf %s "$E2E_ANN_GEOM_PROG" | base64 -d > /tmp/e2e-annots-geom.py',
    'python3 /tmp/e2e-annots-geom.py',
  ].join('\n');

  const geomPlan = planWorkerExec('worker-light', { E2E_ANN_GEOM_PROG: encoded }, statement);

  try {
    const proc = spawn(geomPlan.argv[0]!, geomPlan.argv.slice(1), { cwd: opts.repoRoot, env: geomPlan.env });
    // Both pipes are drained rather than one being closed: a child that fills the other one's buffer blocks forever.
    proc.stderr.resume();
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // The document goes in on stdin, and the write has to be *ended*: `cat` writes `<<<EOF` and the shell runs on.
    // A spawn that never starts emits an `error` event and, under Bun, no `close` at all — the await races the
    // two, so a bridge that cannot start answers `null` instead of hanging the suite.
    proc.stdin.on('error', () => {});
    proc.stdin.end(bytes instanceof Buffer ? bytes : Buffer.from(bytes));
    const code = await new Promise<number | null>((resolve) => {
      proc.on('error', () => resolve(null));
      proc.on('close', resolve);
    });
    const stdout = Buffer.concat(chunks).toString('utf8');
    if (code !== 0 && stdout.trim() === '') return null;
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('['));
    if (!line) return null;
    return JSON.parse(line) as AnnotationGeometry[];
  } catch {
    return null;
  }
}

const PAGE_OBJECT = /\/Type\s*\/Page(?![s])/g;

/**
 * Pages, by counting page objects — in the file **or** inside its compressed object streams.
 *
 * The second place matters: Ghostscript (and therefore OCRmyPDF and the PDF/A path) writes the page tree into
 * `/Type /ObjStm` object streams, so `/Type /Page` exists only after decompression and a plain-text scan reports
 * a perfectly good PDF as having zero pages. That is how a completed OCR job looked broken.
 */
export function countPdfPages(bytes: Uint8Array | Buffer): number {
  const raw = Buffer.from(bytes).toString('latin1');
  const literal = raw.match(PAGE_OBJECT)?.length ?? 0;
  if (literal > 0) return literal;

  let total = 0;
  for (const stream of inflatedStreams(raw)) total += stream.match(PAGE_OBJECT)?.length ?? 0;
  return total;
}

/**
/**
 * Everything structural about a produced document: pages, and what still points at pages that are gone.
 *
 * A tool that removes a page can take it out of the *tree* and leave the object behind, because something still
 * references it: an `/AcroForm` field's `/P` kept every removed page of an `n-up` output in the file, where no
 * reader could see it and every other check in this harness agreed with the tree (defect 83). Page count, text
 * extraction, rendered ink and the API's own reporting are all **tree**-shaped, so none of them can answer it.
 *
 * Three readers, and that is the point rather than an accident. `objects` comes from the bytes (regex, inflated
 * object streams included) — a scan with no PDF parser in it. `parserObjects`, `orphanPages`, `danglingFields` and
 * `danglingAnnotations` come from **pikepdf**, which enumerates every indirect object and can therefore name a page
 * object the tree does not list. `tree` comes from **poppler**. A check that counted all three the same way would
 * only ever agree with itself, and this invariant exists precisely because the previous pass found a defect by
 * accident: a case written about signatures happened to compare two numbers that disagreed.
 */
export interface PdfHealth {
  /** Page objects counted in the bytes, by regex. */
  objects: number;
  /** Pages a reader shows (`pdfinfo`), or `null` when no engine is reachable. */
  tree: number | null;
  /** Page objects an independent parser enumerates, or `null` when it could not open the file. */
  parserObjects: number | null;
  /** Page objects the parser found that its own page tree does not list, as `"10 0 R"`. */
  orphanPages: string[] | null;
  /** Form fields with a `/P` that is not a page in the tree — a field no page can display. */
  danglingFields: number | null;
  /** Annotations with a `/P` that is not a page in the tree. */
  danglingAnnotations: number | null;
  /** Why the parser could not read the file (an encrypted output the caller did not open), or `null`. */
  parserError: string | null;
}

/**
 * The parser half of the report, written as a program rather than as flags because it has to walk the object graph:
 * the unreferenced pages are only visible to something that can enumerate every object in the file.
 *
 * `password` is passed for the security tools: their output is *supposed* to refuse to open, so a reader that cannot
 * get in must report "not measured" rather than "nothing wrong".
 */
const HEALTH_PROGRAM = [
  'import json, os, pikepdf',
  'out = {"parserObjects": None, "orphanPages": None, "danglingFields": None, "danglingAnnotations": None, "error": None}',
  'try:',
  '    pdf = pikepdf.open("/tmp/e2e-health.pdf", password=os.environ.get("E2E_HEALTH_PASSWORD", ""))',
  'except Exception as exc:',
  '    out["error"] = type(exc).__name__',
  '    print("HEALTH:" + json.dumps(out))',
  '    raise SystemExit(0)',
  'page_set = set(page.objgen for page in pdf.pages)',
  'page_dicts = [obj for obj in pdf.objects if isinstance(obj, pikepdf.Dictionary) and obj.get("/Type") == "/Page"]',
  'out["parserObjects"] = len(page_dicts)',
  'out["orphanPages"] = sorted("%d %d R" % obj.objgen for obj in page_dicts if obj.objgen not in page_set)',
  'def dangling_fields(fields, depth=0):',
  '    count = 0',
  '    for field in fields or []:',
  '        if not isinstance(field, pikepdf.Dictionary):',
  '            continue',
  '        target = field.get("/P")',
  '        if target is not None and target.is_indirect and target.objgen not in page_set:',
  '            count += 1',
  '        if depth < 20:',
  '            count += dangling_fields(field.get("/Kids"), depth + 1)',
  '    return count',
  'acroform = pdf.Root.get("/AcroForm")',
  'out["danglingFields"] = dangling_fields(acroform.get("/Fields") if acroform is not None else None)',
  'annotations = 0',
  'for page in pdf.pages:',
  '    for annot in page.obj.get("/Annots", []):',
  '        target = annot.get("/P")',
  '        if target is not None and target.is_indirect and target.objgen not in page_set:',
  '            annotations += 1',
  'out["danglingAnnotations"] = annotations',
  'print("HEALTH:" + json.dumps(out))',
].join('\n');

/**
 * Read the structure through the container bridge, for the same reason the text checks do: the engines live in the
 * worker image and the host is not required to have any. A `null` field means "could not be measured", never "no
 * orphans" — a caller must not turn an unavailable reader into a passing check.
 */
export async function readPdfHealth(
  bytes: Uint8Array | Buffer,
  repoRoot: string,
  password = '',
  service = 'worker-light',
): Promise<PdfHealth> {
  const objects = countPdfPages(bytes);
  const empty: PdfHealth = {
    objects,
    tree: null,
    parserObjects: null,
    orphanPages: null,
    danglingFields: null,
    danglingAnnotations: null,
    parserError: null,
  };

  // Base64 rather than a quoted here-document, the same way `readAnnotationState` does it: stdin is already carrying
  // the PDF, so a program with quotes and slashes in it survives the shell only if it is not text any more.
  const encoded = Buffer.from(HEALTH_PROGRAM, 'utf8').toString('base64');
  const statement = [
    'rm -f /tmp/e2e-health.pdf /tmp/e2e-health.py',
    'cat > /tmp/e2e-health.pdf',
    'printf %s "$E2E_HEALTH_PROG" | base64 -d > /tmp/e2e-health.py',
    // `-upw` so an encrypted output is read like any other: poppler without a password prints nothing at all, which
    // would leave the tree count unknown on exactly the family of jobs that rewrites the bytes most thoroughly.
    "pdfinfo -upw \"$E2E_HEALTH_PASSWORD\" /tmp/e2e-health.pdf 2>/dev/null | sed -n 's/^Pages:[[:space:]]*//p' | sed 's/^/TREE:/'",
    'python3 /tmp/e2e-health.py',
  ].join('\n');

  const plan = planWorkerExec(service, { E2E_HEALTH_PROG: encoded, E2E_HEALTH_PASSWORD: password }, statement);

  try {
    const proc = Bun.spawn(plan.argv, {
      cwd: repoRoot,
      env: plan.env,
      stdin: bytes instanceof Buffer ? bytes : Buffer.from(bytes),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 && stdout.trim() === '') return empty;

    const tree = /^TREE:(\d+)$/m.exec(stdout)?.[1];
    const health = /^HEALTH:(\{.*\})$/m.exec(stdout)?.[1];
    if (!health) return empty;
    const parsed = JSON.parse(health) as Omit<PdfHealth, 'objects' | 'tree'>;
    return { ...parsed, objects, tree: tree ? Number(tree) : null };
  } catch {
    return empty;
  }
}

const IMAGE_OBJECT = /\/Subtype\s*\/Image/g;
const SOFT_MASK = /\/SMask/g;

/**
 * Image objects in the file, and how many of them carry a soft mask.
 *
 * This is how a watermarked page is proved to contain a *transparent* image rather than a rectangle: an image with
 * no `/SMask` is opaque, and an opaque logo pasted over a page is the one failure a page count and a text search
 * both miss. Declarations are looked for in the file and in its inflated object streams, for the same reason the
 * page count is: the object dictionary can live in a `/Type /ObjStm` stream.
 */
export function countPdfImages(bytes: Uint8Array | Buffer): { images: number; softMasked: number } {
  const raw = Buffer.from(bytes).toString('latin1');
  const candidates = [raw, ...inflatedStreams(raw)];

  // The dictionaries only, not the compressed image bodies: a stream of pixel data can contain the byte sequence
  // `/Subtype/Image` by coincidence, and counting that would make the check pass for the wrong document.
  let images = 0;
  let softMasked = 0;
  for (const candidate of candidates) {
    const dictionaries = candidate.split('stream').filter((part) => part.includes('/Subtype'));
    for (const dictionary of dictionaries) {
      const found = dictionary.match(IMAGE_OBJECT)?.length ?? 0;
      if (found === 0) continue;
      images += found;
      softMasked += Math.min(found, dictionary.match(SOFT_MASK)?.length ?? 0);
    }
  }
  return { images, softMasked };
}

const SIGNATURE_OBJECT = /\/Type\s*\/Sig(?![a-zA-Z])/g;
const SIGNATURE_FIELD = /\/FT\s*\/Sig(?![a-zA-Z])/g;
const BYTE_RANGE = /\/ByteRange\s*\[/g;
const PERMS = /\/Perms(?![a-zA-Z])/g;

/**
 * The vocabulary of a **digitally** signed document: `/Type /Sig` and `/FT /Sig` objects, a `/ByteRange`, and the
 * trailer's `/Perms`.
 *
 * `sign` claims it produces none of these — it draws ink and writes metadata — and that claim is the whole difference
 * between an honest ink signature and a file some validator calls "signature broken". It is asserted as an
 * **absence**, from the file's own bytes and inflated object streams rather than from a viewer, because the failure it
 * guards against is invisible: nothing about the rendered page changes when a signature dictionary is attached.
 *
 * A false positive would fail a case loudly, which is the right direction for an absence assertion: the alternative —
 * trusting the job's own report — is exactly what this file exists not to do.
 */
export function readSignatureMarkers(bytes: Uint8Array | Buffer): {
  signatureObjects: number;
  byteRange: number;
  perms: number;
} {
  const raw = Buffer.from(bytes).toString('latin1');
  const candidates = [raw, ...inflatedStreams(raw)];

  let signatureObjects = 0;
  let byteRange = 0;
  let perms = 0;
  for (const candidate of candidates) {
    // Image bodies are skipped for the same reason the image count skips them: a stream of pixel bytes can contain
    // a dictionary key by coincidence, and counting that would fail a case for a document that has no such key.
    for (const chunk of candidate.split('stream').filter((part) => !isBinaryish(part))) {
      signatureObjects += chunk.match(SIGNATURE_OBJECT)?.length ?? 0;
      signatureObjects += chunk.match(SIGNATURE_FIELD)?.length ?? 0;
      byteRange += chunk.match(BYTE_RANGE)?.length ?? 0;
      perms += chunk.match(PERMS)?.length ?? 0;
    }
  }
  return { signatureObjects, byteRange, perms };
}

/**
 * A chunk that is mostly non-printable bytes is compressed data, not a dictionary.
 *
 * `inflatedStreams()` hands back the *decompressed* body of every stream, so an image's pixel data arrives here as
 * hundreds of kilobytes of arbitrary bytes. A dictionary is ASCII, so the share of non-printable bytes is the
 * difference — and it is measured rather than guessed: a real dictionary chunk is under 5 % non-printable, a
 * 600×220 RGB body is over 90 %.
 */
function isBinaryish(chunk: string): boolean {
  if (chunk.length === 0) return false;
  let binary = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    const code = chunk.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32) || code > 126) binary += 1;
  }
  return binary / chunk.length > 0.5;
}

/**
 * Every Flate-compressed stream in the file, inflated.
 *
 * Bodies are delimited by `stream`/`endstream` and then tried at three lengths, because the newline before
 * `endstream` is excluded from `/Length` and a deflate stream with one stray trailing byte refuses to inflate.
 * Where `/Length` is an indirect reference (`/Length 11 0 R`) — normal for Ghostscript output — there is no
 * usable number at all, which is the other reason this does not rely on it.
 */
function inflatedStreams(raw: string): string[] {
  const out: string[] = [];
  const marker = /\bstream\r?\n/g;

  let match = marker.exec(raw);
  while (match) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;

    const body = Buffer.from(raw.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    for (const length of [body.length, body.length - 1, body.length - 2]) {
      if (length <= 0) continue;
      try {
        out.push(inflateSync(body.subarray(0, length)).toString('latin1'));
        break;
      } catch {
        // Try one byte shorter; a body that never inflates contributes nothing.
      }
    }

    marker.lastIndex = end + 'endstream'.length;
    match = marker.exec(raw);
  }

  return out;
}

/**
 * The text inside every stream, decompressed, in file order.
 *
 * Slicing is driven by each stream's own `/Length`, not by a search for `endstream`: the exact byte count is the
 * only way to exclude the newline before `endstream`, and a deflate stream with one stray trailing byte fails to
 * inflate. Scanning by `endstream` decoded exactly one of five streams the first time this ran, which read as a
 * merge bug for a while.
 */
export function decodedPdfText(bytes: Uint8Array | Buffer): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const byLength = decodedTextByLength(raw);
  if (byLength.trim().length > 0) return withPdfStrings(byLength);
  // Nothing came out of the `/Length` walk — the streams are likely inside object streams, where only the
  // `stream`/`endstream` walk can reach them.
  return withPdfStrings(inflatedStreams(raw).join('\n'));
}

/**
 * The `<hex>` strings in a chunk of text, decoded and joined by newlines.
 *
 * A PDF string is written either as a literal — `(page 1 of 1)`, with backslash escapes — or as a run of hex digits
 * between angle brackets, and a producer picks the hex form as soon as the text does not fit the font's own encoding.
 * Both spellings say the same thing, so a reader that knows only one of them answers a different question than the one
 * it was asked (see fact 4 at the top of this file).
 *
 * The angle brackets are the whole reason this cannot be a plain `<[0-9a-f]+>` search: `<<` opens a dictionary, and
 * `<< /A 1 >>` does contain a bracket pair — whose inside is not an even run of hex digits, so it is rejected and the
 * scan moves on to find the real string inside it. A run with an odd number of digits is not a string either (each
 * byte is two of them), and neither is an empty one.
 *
 * The bytes are read back the way a PDF reader would. A leading `FEFF` says UTF-16BE, which is the spec's encoding for
 * text a single-byte code page cannot hold; otherwise the bytes are tried as UTF-8 and fall back to latin1, so a run
 * written from a WinAnsi string (`e9` for `é`) still reads as that character instead of as mojibake.
 */
export function decodePdfHexStrings(text: string): string {
  const decoded: string[] = [];
  for (const match of text.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const digits = match[1]!.replace(/\s+/g, '');
    if (digits.length === 0 || digits.length % 2 !== 0) continue;
    const bytes = Buffer.from(digits, 'hex');
    if (bytes.length === 0) continue;
    decoded.push(decodePdfStringBytes(bytes));
  }
  return decoded.join('\n');
}

/** The characters a PDF hex string's bytes stand for — UTF-16BE when the BOM says so, UTF-8 when they are valid, latin1 otherwise. */
function decodePdfStringBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let body = bytes.subarray(2);
    // An odd trailing byte cannot be half of a UTF-16 code unit, so it is dropped rather than passed to `swap16`.
    if (body.length % 2 !== 0) body = body.subarray(0, body.length - 1);
    return body.swap16().toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/**
 * The `(literal)` strings in a chunk of text, with their escapes resolved, joined by newlines.
 *
 * The other half of the same fact (fact 5 above), and the half a byte search cannot paper over: the string `PAREN(9X7)`
 * is written `(PAREN\(9X7\))`, so looking for the token's text finds nothing while the token is unambiguously in the
 * file. Octal escapes and the backslash-newline continuation are the same problem in other clothes.
 *
 * Balanced parentheses are counted rather than matched to the first `)`: `(a(b)c)` is *one* string whose text is
 * `a(b)c`, and a pattern stopping at the first closing bracket would read `a(b`. The scan is a single pass with a
 * stack — and a run whose bracket is never closed contributes nothing, which is what keeps a stray `(` inside
 * compressed image data from turning the rest of the file into one enormous "string".
 */
export function decodePdfLiteralStrings(text: string): string {
  const decoded: string[] = [];
  let start = -1;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char === '\\') {
      // A backslash protects the character after it, whatever it is — including a bracket that would otherwise count.
      index += 1;
      continue;
    }
    if (char === '(') {
      // Only the outermost bracket *opens* a string: an inner pair is part of the text the outer one already covers.
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== ')' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      decoded.push(decodePdfEscapes(text.slice(start + 1, index)));
      start = -1;
    }
  }
  return decoded.join('\n');
}

/**
 * One literal string's body, with the escapes a PDF reader would resolve.
 *
 * `\ddd` is **octal** — one to three digits — and it is the only escape that stands for a byte rather than a
 * character: `\351` is `é`, and reading it as the three characters `351` would fail a search for the text exactly
 * where the same search for the bytes succeeds. A backslash before a newline is a continuation and contributes nothing.
 */
function decodePdfEscapes(run: string): string {
  let out = '';
  for (let index = 0; index < run.length; index += 1) {
    const char = run[index] ?? '';
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = run[index + 1];
    // A trailing backslash stands for nothing at all, which is also how a reader treats it.
    if (next == null) break;
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '\n') {
      // A continuation: the line break itself is not part of the text.
    } else if (next === '\r') {
      if (run[index + 1] === '\n') index += 1;
    } else if (next >= '0' && next <= '7') {
      let digits = next;
      while (digits.length < 3) {
        const digit = run[index + 1];
        if (digit == null || digit < '0' || digit > '7') break;
        index += 1;
        digits += digit;
      }
      out += String.fromCharCode(Number.parseInt(digits, 8));
    } else {
      out += next;
    }
  }
  return out;
}

/**
 * A haystack chunk, plus the text of the strings inside it — hex and literal.
 *
 * Applied where the haystacks are assembled rather than inside the walkers, because the walkers are also read for
 * *structure* — `countPdfPages`, `countPdfImages` and `readSignatureMarkers` all look for dictionaries in them, and a
 * decoded string is text, not an object. Both readings are **appended**, never substituted: the chunk as it stands is
 * what every structural reader sees, so a decoder that reads a chunk wrongly can only add text, never hide it.
 */
function withPdfStrings(text: string): string {
  const decoded = [decodePdfHexStrings(text), decodePdfLiteralStrings(text)].filter((piece) => piece.length > 0);
  return decoded.length > 0 ? `${text}\n${decoded.join('\n')}` : text;
}

/**
 * How far back to look for the dictionary that belongs to a stream body: the object it is in, or — for a body with no
 * `endobj` before it, which is what an object-stream member looks like — the previous 4 000 characters.
 */
function streamDictionary(raw: string, marker: number): string {
  const objectStart = raw.lastIndexOf('endobj', marker);
  return raw.slice(objectStart >= 0 ? objectStart : Math.max(0, marker - 4000), marker);
}

function decodedTextByLength(raw: string): string {
  let out = '';

  // `/Length 11 0 R` — an indirect length — is skipped rather than read as 11 bytes: half of Ghostscript's output
  // stores the count that way, and slicing by an object number would cut bodies in the middle. Those streams are
  // still reachable through the `stream`/`endstream` walk in `inflatedStreams`.
  const lengths = /\/Length\s+(\d+)(?!\s+\d+\s+R)/g;
  let match = lengths.exec(raw);
  while (match) {
    const length = Number(match[1]);
    const marker = raw.indexOf('stream', match.index);
    if (marker < 0) break;

    let start = marker + 'stream'.length;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;

    const body = Buffer.from(raw.slice(start, start + length), 'latin1');
    if (body.length > 0) {
      // The filter is read from the whole object, not from the characters between the `/Length` match and `stream`.
      // Those two are not ordered in the format, and pikepdf writes `<< /Filter /FlateDecode /Length 100 >>` — so a
      // reader that looked only *after* `/Length` classified every pikepdf-written body as uncompressed text and
      // returned compressed bytes as if they were page text. That is how a correct merge whose streams pikepdf had
      // re-compressed reported "the output does not contain the source text".
      if (/\/Fl(ateDecode)?\b/.test(streamDictionary(raw, marker))) {
        try {
          out += inflateSync(body).toString('utf8');
        } catch {
          // A stream we cannot inflate contributes no text; page-count checks cover structural integrity.
        }
      } else {
        out += body.toString('utf8');
      }
    }

    // Continue past this body, so a stream whose payload happens to contain `stream` cannot be mistaken for one.
    lengths.lastIndex = start + length;
    match = lengths.exec(raw);
  }

  return out;
}

/**
 * Everything a search for a literal string should look through: the raw bytes *and* the inflated streams.
 *
 * Both halves are load-bearing. A `/Info` dictionary is a plain object, so it is only in the raw bytes; an XMP packet
 * is a stream, so it may only be in the inflated half; and an embedded file is a stream that is usually neither
 * compressed nor filtered. A check that searched only one of them would pass by accident — which is the failure mode
 * a "this string is gone" assertion cannot afford, so both the presence and the absence assertions use this
 * function, and the presence case is what proves the search actually sees the string.
 *
 * Each half is then read again through `withPdfStrings`: the text of every `<hex>` string and of every `(…)` literal,
 * escapes resolved. A run is therefore found whichever way the producer wrote it — hex, plain literal, or literal with
 * its brackets and backslashes escaped — which is the difference between an assertion about the document's text and
 * one about its encoding.
 */
export function searchableBytes(bytes: Uint8Array | Buffer): string {
  const raw = Buffer.from(bytes).toString('latin1');
  // Both walks, always — deliberately *not* `decodedPdfText`, which returns as soon as either walk produces anything.
  // When the by-`/Length` walk finds page text (it usually does) the `stream`/`endstream` walk never runs, and with it
  // goes every `/Type /ObjStm` object stream. That is where a PDF/A-2 output keeps its `/OutputIntents` dictionary, so
  // the first version of this function reported a correct archival file as missing the intent it plainly has — a
  // false negative, which is the one direction this check must never fail in.
  return [raw, decodedTextByLength(raw), ...inflatedStreams(raw)].map(withPdfStrings).join('\n');
}

/**
 * The first page's `/MediaBox`, in points — the page's declared size, read from the object rather than rendered.
 *
 * Deliberately the *first* box found by walking `/Type /Page` objects in file order, with the caveat noted at the
 * call site: an inheriting page tree puts `/MediaBox` on the `/Pages` node instead, and a document this harness cares
 * about (anything built by qpdf, Ghostscript, LibreOffice or pikepdf from a fixture) writes it on every page. A null
 * return is reported as "could not read the size", never as a pass.
 */
export function firstPageMediaBox(bytes: Uint8Array | Buffer): { width: number; height: number } | null {
  // Raw bytes *and* inflated streams. A page dictionary can live inside a compressed object stream — `n-up`'s output
  // does, because it is written with `object_stream_mode=generate` — and a raw-byte search then finds no `/MediaBox`
  // at all, which reads as "the page has no size" rather than "this parser cannot see the object".
  const raw = searchableBytes(bytes);
  const page = /\/Type\s*\/Page[^s]/.exec(raw);
  if (page) {
    const window = raw.slice(page.index, page.index + 1200);
    const box = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(window);
    if (box) {
      const width = Number(box[3]) - Number(box[1]);
      const height = Number(box[4]) - Number(box[2]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { width, height };
      }
    }
  }
  // A page tree that inherits the box: fall back to the first `/MediaBox` anywhere, which for a single-size
  // document is the same answer.
  const inherited = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(raw);
  if (!inherited) return null;
  const width = Number(inherited[3]) - Number(inherited[1]);
  const height = Number(inherited[4]) - Number(inherited[2]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Every page's `/MediaBox`, in file order, with the reader that found it.
 *
 * `merge` is the tool whose *stated* behaviour is that page sizes are preserved as-is rather than normalised, and
 * that claim cannot be checked from a page count or from the first page alone: a merged A4+A3 document whose output
 * was silently resized to A4 has five pages, the right text, and one size. Every box in the file is read here, from
 * both the raw bytes and the inflated streams, so a page dictionary inside an object stream is still counted.
 */
export function mediaBoxes(bytes: Uint8Array | Buffer): Array<{ width: number; height: number }> {
  const raw = searchableBytes(bytes);
  const boxes: Array<{ width: number; height: number }> = [];
  const pattern = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g;
  for (const match of raw.matchAll(pattern)) {
    const width = Number(match[3]) - Number(match[1]);
    const height = Number(match[4]) - Number(match[2]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      boxes.push({ width, height });
    }
  }
  return boxes;
}

export interface PageGeometry {
  /** 1-based, in the page tree's own order. */
  page: number;
  /** `/Rotate` as the file stores it, `0` when the page has none — the value a renderer applies. */
  rotate: number;
  widthPt: number;
  heightPt: number;
}

/**
 * Every page's `/Rotate` and `/MediaBox`, **in page-tree order**, read with pikepdf in `worker-light`.
 *
 * Two claims need this and neither can be made any other way. `rotate`'s whole product is a number written into the page
 * dictionary: it changes nothing about the page count, the text or the size, so a case that only asserted those passes
 * for a job that rotated nothing (and the pass-5 review found that no case had ever asserted a single angle, for any
 * tool). And `images-to-pdf` promises that a multi-frame TIFF contributes one page per frame — which is a claim about
 * the *order and size* of the pages, not about how many there are.
 *
 * pikepdf rather than `mediaBoxes()` above, which regex-scans the bytes: that reader cannot see a page order at all —
 * it reports the boxes in the order they appear in the file, and an object stream can put them anywhere.
 *
 * `null` means no container was reachable, and every caller fails rather than skipping.
 */
export async function readPageGeometry(
  bytes: Uint8Array | Buffer,
  opts: { repoRoot: string },
): Promise<PageGeometry[] | null> {
  const program = [
    'import json, pikepdf',
    'pdf = pikepdf.Pdf.open("/tmp/e2e-geometry.pdf")',
    'pages = []',
    'for index, page in enumerate(pdf.pages, start=1):',
    '    box = [float(value) for value in page.MediaBox]',
    '    pages.append({',
    '        "page": index,',
    '        "rotate": int(page.get("/Rotate", 0) or 0) % 360,',
    '        "widthPt": box[2] - box[0],',
    '        "heightPt": box[3] - box[1],',
    '    })',
    'print(json.dumps(pages))',
  ].join('\n');

  // Base64 rather than a quoted here-document, the same way the annotation readers do it: stdin is already carrying the
  // PDF, so a program with quotes and slashes in it survives the shell only if it is not text any more.
  const encoded = Buffer.from(program, 'utf8').toString('base64');
  const statement = [
    'rm -f /tmp/e2e-geometry.pdf',
    'cat > /tmp/e2e-geometry.pdf',
    'printf %s "$E2E_GEOMETRY_PROG" | base64 -d > /tmp/e2e-geometry.py',
    'python3 /tmp/e2e-geometry.py',
  ].join('\n');

  const geometryPlan = planWorkerExec('worker-light', { E2E_GEOMETRY_PROG: encoded }, statement);

  try {
    //
    // `node:child_process` rather than `Bun.spawn`, for the reason `pdfPageTexts` records at length: the **browser**
    // stage asks Playwright, and Playwright runs its workers under Node even when the command was `bun run
    // test:browser` — `typeof Bun` is `undefined` in there, so a `Bun.spawn` helper returns `null` and the case fails on
    // a stack that is up. The golden suite runs under Bun, where `node:child_process` is implemented, so one spelling
    // serves both. This reader is the one the rotate case needs, because a rotation is invisible to every other check.
    // And the same Windows hang as everywhere else — an ENOENT spawn whose `error` nobody watched — is raced away
    // in the await below, exactly as `repoRootFrom` documents.
    //
    const proc = spawn(geometryPlan.argv[0]!, geometryPlan.argv.slice(1), {
      cwd: opts.repoRoot,
      env: geometryPlan.env,
    });
    proc.stderr.resume();
    // A spawn that never starts emits an `error` event and, under Bun, no `close` at all — the await races the
    // two, so a bridge that cannot start answers the same `null` as an empty result instead of hanging the suite
    // (the second half of the Windows hang `repoRootFrom` documents).
    proc.stdin.on('error', () => {});
    proc.stdin.end(bytes instanceof Buffer ? bytes : Buffer.from(bytes));
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => {
      proc.on('error', () => resolve(null));
      proc.on('close', resolve);
    });
    const stdout = Buffer.concat(chunks).toString('utf8');
    if (code !== 0 && stdout.trim() === '') return null;
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('['));
    if (!line) return null;
    return JSON.parse(line) as PageGeometry[];
  } catch {
    return null;
  }
}

/** One outline entry, as **qpdf** reports it — titles and nesting, not pikepdf's view of the same tree. */
export interface OutlineEntryReading {
  title: string;
  /** 1-based page, from qpdf's own `destpageposfrom1`; null when the entry has no resolvable destination. */
  page: number | null;
  children: OutlineEntryReading[];
}

export interface OutlineAndInfoReading {
  entries: OutlineEntryReading[];
  /** Entries at every level — the number a claim like "one entry per input" has to be checked against. */
  total: number;
  /** Whether the catalog carries an `/Outlines` dictionary at all, which an empty list cannot say. */
  hasOutlines: boolean;
  /** `/Info` values by key without the slash. Empty for a document with no `/Info` reference. */
  docinfo: Record<string, string>;
}

/**
 * Read the outline tree and `/Info` with **qpdf**, not with pikepdf.
 *
 * The handler that writes these uses pikepdf, so a reader built on pikepdf would agree with a bug rather than catch
 * it: two implementations, one writer and one reader, is the only arrangement in which "the bookmarks survived" is a
 * fact about the file. qpdf's `--json-key=outlines` prints the tree with `destpageposfrom1` (the page the entry
 * points at), and the trailer names the `/Info` object, whose dictionary is then printed verbatim.
 *
 * `null` means no container was reachable — the caller must treat that as a failure, never a skip.
 */
export async function readOutlineAndInfo(
  bytes: Uint8Array | Buffer,
  opts: { repoRoot: string },
): Promise<OutlineAndInfoReading | null> {
  const statement = [
    'rm -f /tmp/e2e-outline.pdf',
    'cat > /tmp/e2e-outline.pdf',
    'printf "### OUTLINES\\n"',
    'qpdf --json --json-key=outlines /tmp/e2e-outline.pdf 2>/dev/null',
    'printf "\\n### CATALOG\\n"',
    'root=$(qpdf --show-object=trailer /tmp/e2e-outline.pdf 2>/dev/null | sed -n "s/.*\\/Root \\([0-9][0-9]*\\) 0 R.*/\\1/p")',
    'if [ -n "$root" ]; then qpdf --show-object=$root /tmp/e2e-outline.pdf 2>&1; else echo "NO-CATALOG"; fi',
    'printf "\\n### INFO\\n"',
    'info=$(qpdf --show-object=trailer /tmp/e2e-outline.pdf 2>/dev/null | sed -n "s/.*\\/Info \\([0-9][0-9]*\\) 0 R.*/\\1/p")',
    'if [ -n "$info" ]; then qpdf --show-object=$info /tmp/e2e-outline.pdf 2>&1; else echo "NO-INFO"; fi',
    'printf "\\n### END\\n"',
  ].join('\n');

  try {
    const outlinePlan = planWorkerExec('worker-light', {}, statement);
    const proc = Bun.spawn(outlinePlan.argv, {
      cwd: opts.repoRoot,
      env: outlinePlan.env,
      stdin: bytes instanceof Buffer ? bytes : Buffer.from(bytes),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 && stdout.trim() === '') return null;

    const section = (name: string): string => {
      const start = stdout.indexOf(`### ${name}`);
      if (start < 0) return '';
      const body = stdout.slice(start + name.length + 4);
      const end = body.indexOf('\n### ');
      return (end < 0 ? body : body.slice(0, end)).trim();
    };

    let entries: OutlineEntryReading[] = [];
    let hasOutlines = false;
    try {
      const parsed = JSON.parse(section('OUTLINES')) as { outlines?: RawOutlineEntry[] };
      entries = (parsed.outlines ?? []).map(normalizeOutlineEntry);
      hasOutlines = entries.length > 0;
    } catch {
      hasOutlines = false;
    }
    // An outline that exists but is empty prints no `outlines` key at all, and "no bookmarks" is a different claim
    // from "no /Outlines dictionary": the first is a document a reader shows an empty sidebar for, the second is one
    // where the sidebar does not exist. The catalog is what tells them apart, read as a dictionary rather than
    // inferred from the absence of entries.
    const catalog = section('CATALOG');
    if (/\/Outlines\s+\d+\s+0\s+R/.test(catalog)) hasOutlines = true;

    const info = section('INFO');
    const docinfo: Record<string, string> = {};
    if (info !== 'NO-INFO') {
      for (const match of info.matchAll(/\/([A-Za-z]+)\s*\(((?:\\.|[^()\\])*)\)/g)) {
        docinfo[`/${match[1]}`] = (match[2] ?? '').replace(/\\([()\\])/g, '$1');
      }
    }

    return {
      entries,
      total: countOutlineEntries(entries),
      hasOutlines,
      docinfo,
    };
  } catch {
    return null;
  }
}

interface RawOutlineEntry {
  title?: unknown;
  destpageposfrom1?: unknown;
  kids?: RawOutlineEntry[];
}

function normalizeOutlineEntry(entry: RawOutlineEntry): OutlineEntryReading {
  return {
    title: typeof entry.title === 'string' ? entry.title : '',
    page: typeof entry.destpageposfrom1 === 'number' ? entry.destpageposfrom1 : null,
    children: (entry.kids ?? []).map(normalizeOutlineEntry),
  };
}

function countOutlineEntries(entries: OutlineEntryReading[]): number {
  return entries.reduce((total, entry) => total + 1 + countOutlineEntries(entry.children), 0);
}

/**
 * The first page's `/CropBox` size in points, or null when the page has none.
 *
 * The counterpart to `firstPageMediaBox`, and the *only* way to see what `crop` did: cropping is deliberately
 * non-destructive (`docs/03-ORGANIZE-ROTATE-CROP.md` §6), so the MediaBox must stay the same and every page-size
 * check on the output would pass for a crop that did nothing at all. A null result means the page inherits its crop
 * box from the page tree, which for a cropped output means the crop never reached this page.
 */
export function firstPageCropBox(bytes: Uint8Array | Buffer): { width: number; height: number } | null {
  // Same reasoning as `firstPageMediaBox`: the box may be inside an object stream.
  const raw = searchableBytes(bytes);
  const box = /\/CropBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(raw);
  if (!box) return null;
  const width = Number(box[3]) - Number(box[1]);
  const height = Number(box[4]) - Number(box[2]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * How many pages carry a `/CropBox` of their own.
 *
 * The counterpart to `firstPageCropBox`, and it exists for the one question that one box cannot answer: **which pages the
 * crop reached**. `crop.pages` is optional and a selection is a *set of pages*, so an output cropped on five of six
 * pages has five explicit boxes — the sixth inherits the page tree's, which is the difference between "untouched" and
 * "cropped to the same place". A file with the same content as its input therefore reports `0`, and the number is read
 * from the bytes rather than from the handler's own `metrics.pagesCropped`, which is the report the case is checking.
 *
 * Object streams are searched for the same reason `firstPageCropBox` searches them: `pikepdf` may write the page
 * dictionaries either way, and a count that only saw the uncompressed half would be a count of luck.
 */
export function cropBoxCount(bytes: Uint8Array | Buffer): number {
  const raw = searchableBytes(bytes);
  return [...raw.matchAll(/\/CropBox\s*\[\s*[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s*\]/g)].length;
}

/**
 * Whether the file carries a linearization parameter dictionary at its head — what "linearized" means, read
 * structurally rather than from a flag.
 *
 * Linearization is defined by *position*: the hint dictionary is the first object in the file, which is what lets a
 * reader fetch page one without the rest. A copy of the dictionary left at the end of a rebuilt file is not
 * linearization, so this only looks at the first 2 048 bytes — and the caller passes the same bytes to
 * `qpdf --show-linearization`, because the two checks fail on different inputs.
 */
export function hasLinearizationDict(bytes: Uint8Array | Buffer): boolean {
  return Buffer.from(bytes).subarray(0, 2048).toString('latin1').includes('/Linearized');
}

/**
 * Does the file declare an `/Encrypt` dictionary — the one thing an encrypted PDF must carry?
 *
 * A raw byte search, and sound for this question for the same reason `qpdf --show-encryption` is: the trailer is never
 * encrypted (a reader needs the key material before it can decrypt anything), so `/Encrypt` is plain ASCII in a file
 * that has one. What it deliberately does **not** answer is whether the file opens without a password — that is a
 * reader's question, and the golden suite asks it with two engines. This is the browser stage's witness that the bytes
 * a user downloaded are protected at all, which is otherwise invisible to a case that only counts pages (`countPdfPages`
 * reads the page tree, whose dictionaries stay readable in an encrypted file — which is precisely why a page count
 * alone would pass for a job that wrote no encryption whatsoever).
 */
export function declaresEncryption(bytes: Uint8Array | Buffer): boolean {
  return Buffer.from(bytes).includes('/Encrypt');
}

/**
 * The ZIP local-file-header signature, `PK\x03\x04`.
 *
 * Byte-wise rather than a regular expression: the pattern contains control characters, and both spellings of them
 * in a regex (raw bytes or `\x03` escapes) trip `noControlCharactersInRegex` — so the rule is respected by not
 * using a regex at all, which also avoids a latin1 round trip.
 */
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Entries in a ZIP, by counting local file headers — enough to prove an archive is real and populated. */
export function countZipEntries(bytes: Uint8Array | Buffer): number {
  const buffer = Buffer.from(bytes);
  let entries = 0;
  let index = buffer.indexOf(ZIP_LOCAL_HEADER);
  while (index >= 0) {
    entries += 1;
    index = buffer.indexOf(ZIP_LOCAL_HEADER, index + 1);
  }
  return entries;
}

/**
 * The decompressed text of every entry in a ZIP, concatenated.
 *
 * This is what makes an OOXML package assertable. A `.docx`, `.xlsx` and `.pptx` are ZIPs whose readable content
 * (`word/document.xml`, `xl/sharedStrings.xml`, `ppt/slides/slide1.xml`) is deflated, so a byte search for a word the
 * user typed finds nothing even when the word is in the file — which is exactly the mistake this helper exists to
 * prevent. Entry names are included, so "the package has a slide" is also assertable.
 *
 * Inflation is driven by each local file header's own compressed size rather than by scanning for the next header,
 * because a deflate stream followed by anything at all fails to inflate on a stray byte. Local headers are used
 * rather than the central directory because `zipfile` (Python) and every OOXML writer put real sizes there — and when
 * one does not (the streaming flag), that entry simply contributes nothing instead of corrupting the rest.
 */
export function archiveEntryText(bytes: Uint8Array | Buffer): string {
  const buffer = Buffer.from(bytes);
  const pieces: string[] = [];
  let index = buffer.indexOf(ZIP_LOCAL_HEADER);

  while (index >= 0) {
    const nameLength = buffer.readUInt16LE(index + 26);
    const extraLength = buffer.readUInt16LE(index + 28);
    const method = buffer.readUInt16LE(index + 8);
    const compressedSize = buffer.readUInt32LE(index + 18);
    const nameStart = index + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    pieces.push(`\n[entry ${name}]\n`);

    if (compressedSize > 0 && method === 8) {
      try {
        pieces.push(inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)).toString('utf8'));
      } catch {
        // An entry that will not inflate contributes its name only; the caller's assertion is then about a missing
        // string rather than a harness crash.
      }
    } else if (compressedSize > 0) {
      // Stored (method 0): the bytes are the content.
      pieces.push(buffer.subarray(dataStart, dataStart + compressedSize).toString('utf8'));
    }

    index = buffer.indexOf(ZIP_LOCAL_HEADER, index + 4);
  }

  return pieces.join('');
}

/**
 * The text of every page of a document, **in order**, one entry per page.
 *
 * The assertion suite's blind spot until now, and it is the one `reorder-pages` needed: every text check in this
 * harness concatenates the whole document (`decodedPdfText`, `--expect-text`), which cannot see *order* — `1,2,3` and
 * `3,2,1` produce the same string. A tool whose entire product is the arrangement of pages was therefore measured by a
 * page count and a page count cannot tell a reordered document from an untouched one (defect 226). `--expect-page-text`
 * is what closes it, and this is the reader behind it.
 *
 * Read with **poppler** in the `worker-light` container, not with this repository's own byte walk, for the reason the
 * rest of this file gives: the bytes of a content stream are not the answer to "what does page 3 say", and a reader
 * written here would agree with whatever the handler wrote. `pdftotext` splits pages on the form feed and writes the
 * document to stdout, so one process spawn returns the whole document's text, page by page.
 *
 * The form feed is a *separator*, not a terminator: a six-page file prints six feeds, and the last piece is empty. That
 * trailing piece is dropped and nothing else is — an internal empty page is a page, and filtering every empty entry
 * would silently renumber the pages after it, which is the defect class this function exists to catch.
 *
 * `null` means no container was reachable, and the caller must fail rather than skip: a silent skip here is a case that
 * checks nothing while reporting green.
 *
 * **Spawned through `node:child_process`, not `Bun.spawn`, and that is a measured requirement rather than a style.**
 * This is the one helper in this file that the **browser** stage calls, and Playwright runs its workers under Node even
 * when the command was `bun run test:browser`: measured in a worker, `typeof Bun` is `undefined`, so `Bun.spawn` threw,
 * the catch below returned `null`, and the case failed with "no container was reachable" on a stack that was up. The
 * golden suite runs under Bun and `node:child_process` is implemented there, so one spelling works for both runners.
 *
 * **Windows broke this bridge twice, and both halves are fixed here.** First, its `repoRoot` used to arrive as
 * `URL.pathname` — `/D:/…` — and the spawn died with ENOENT before docker was ever looked up; the callers now pass
 * `repoRootFrom(import.meta.url)`. Second, a spawn that never starts emits `error` and, under Bun, no `close`, so
 * the await below races the two events and a failed bridge answers `null` — the documented "no container was
 * reachable" — instead of hanging the suite. The pipe itself never was the problem: measured under Bun on Windows,
 * `stdin.end(bytes)` delivers EOF to the container's `cat` perfectly well, and the very statement this function
 * runs completes in under a second once the spawn can start at all.
 */
export async function pdfPageTexts(bytes: Uint8Array | Buffer, opts: { repoRoot: string }): Promise<string[] | null> {
  const statement = [
    'rm -f /tmp/e2e-pages.pdf',
    'cat > /tmp/e2e-pages.pdf',
    'pdftotext /tmp/e2e-pages.pdf - 2>/dev/null',
    'printf "\n### EXIT %s\\n" "$?"',
  ].join('\n');

  try {
    const textsPlan = planWorkerExec('worker-light', {}, statement);
    const proc = spawn(textsPlan.argv[0]!, textsPlan.argv.slice(1), { cwd: opts.repoRoot, env: textsPlan.env });
    // Both pipes are drained rather than one being closed: a child that fills the other one's buffer blocks forever, and
    // this spawn has no timeout around it.
    proc.stderr.resume();
    // A spawn that never starts emits an `error` event and, under Bun, no `close` at all — the await races the
    // two, so a bridge that cannot start answers the same `null` as an empty result instead of hanging the suite
    // (the second half of the Windows hang `repoRootFrom` documents).
    proc.stdin.on('error', () => {});
    proc.stdin.end(bytes instanceof Buffer ? bytes : Buffer.from(bytes));
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => {
      proc.on('error', () => resolve(null));
      proc.on('close', resolve);
    });
    const stdout = Buffer.concat(chunks).toString('utf8');
    if (code !== 0 && stdout.trim() === '') return null;

    const exit = /### EXIT (-?\d+)\s*$/.exec(stdout);
    if (exit == null || Number(exit[1]) !== 0) return null;
    const body = stdout.slice(0, exit.index);
    const pieces = body.split('\f');
    //
    // Exactly **one** trailing piece is the artefact of the separator convention (the feed that ends the last page,
    // followed by nothing), so exactly one is dropped. A loop, or a filter over every empty entry, would also drop a
    // genuinely blank last page — and would renumber every page after any internal blank one, which is the kind of
    // silent shift this reader exists to catch.
    //
    if (pieces.length > 0 && pieces[pieces.length - 1]!.trim() === '') pieces.pop();
    return pieces.map((piece) => piece.replace(/\s+/g, ' ').trim());
  } catch {
    return null;
  }
}
