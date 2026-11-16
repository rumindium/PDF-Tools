import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STACK_GAP_EXIT_CODE, requireAnonymousUse, stackGapReason } from '../../e2e/lib/stack-gap';

/**
 * The golden suite (`docs/0-CICD.md` §1 stage 7, `docs/0-TESTING.md`) as one command.
 *
 * Named `test:golden` because that is what `docs/0-TESTING.md` §2 promises. Every case here previously existed only
 * as a command someone had to remember to type: the per-pool evidence in `docs/0-IMPLEMENTATION-STATUS.md` was
 * produced by hand, which is how a defect could sit in the heavy pool for a whole phase without anyone noticing. A
 * case is a tool, the fixtures it eats, and what the output must prove — page counts are re-derived from the
 * downloaded bytes by the harness, not trusted from the API.
 *
 * A case also declares *every* fixture it needs, including uploads named by an option, so a fixture that was never
 * generated is reported as "not run" with the command that makes it. It cannot be mistaken for a product failure,
 * and it cannot pass by never running.
 *
 *   bun run test:golden                     every pool
 *   bun run test:golden -- --pool light     one pool (what each CI matrix job runs)
 *   bun run test:golden -- --base http://localhost:8080
 *
 * Cases that cannot run yet are listed with the reason rather than omitted, so a gap shows up in the output of
 * every run instead of only in a document nobody re-reads. The list is intentionally short: a case is added when
 * the tool has a real handler *and* a fixture that can prove it worked. The other twenty-odd registry entries are
 * stubs (`enabled: false`), and `e2e/tool.e2e.ts` refuses a disabled tool by design.
 */

type Pool = 'light' | 'office' | 'heavy' | 'ocr';

interface GoldenCase {
  tool: string;
  pool: Pool;
  files: string[];
  options?: Record<string, unknown>;
  expectPages?: number;
  /** How many parts `/result` must list — the assertion a page selection is measured by. */
  expectParts?: number;
  /** Page numbers a part must declare (`pdf-to-images` labels each part with the page it came from). */
  expectPartPages?: Array<{ index: number; pages: number[] }>;
  /**
   * The parts must **partition** this many pages — every page exactly once, and each part's own page objects must
   * agree with the page list it declares.
   *
   * `split`'s central promise, and the one no other assertion here can see: a part is a perfectly good PDF holding
   * *some* pages, so a dropped page, a duplicated page and a mislabelled part all pass `expectParts` and `expectPages`.
   */
  expectPartition?: number;
  /** A bookmark a **part**'s own outline must carry, as `{ index: 0, title: 'Chapter 1' }`. */
  expectPartOutlines?: Array<{ index: number; title: string }>;
  /**
   * A substring a **named part** must contain, as `{ index: 1, text: 'Check,Owner,Result' }`.
   *
   * `expectBytes` reads the primary part, which is the whole output for every tool whose product is one file. It is not
   * the whole output for `pdf-to-csv`, whose `allTables: true` writes one CSV per detected table: the second table's
   * cells live in a part nothing else in the suite opens, so "the second table is really in the second file" needed an
   * assertion of its own (`e2e/tool.e2e.ts` explains it at the flag).
   */
  expectPartText?: Array<{ index: number; text: string }>;
  /** A bookmark the primary output's outline must carry, at any level. */
  expectOutline?: string[];
  /** A bookmark the primary output's outline must **not** carry. */
  expectAbsentOutline?: string[];
  expectText?: string;
  /**
   * A substring a specific **page** must contain, as `{ index: 0, text: 'page 1 of 6' }` (0-based page index).
   *
   * The only assertion in this file that can see **order**, and its absence is why `reorder-pages` had two golden cases
   * and neither could fail for the wrong arrangement: `expectText` searches the whole document's text at once, so
   * `1,2,3` and `3,2,1` are the same haystack, and `expectPages` counts pages, which a reordered document has just as
   * many of. A tool whose entire product is the arrangement of pages was measured by a count (defect 226). Read page by
   * page with poppler (`pdfPageTexts`), because the page boundary is the fact under test.
   */
  expectPageText?: Array<{ index: number; text: string }>;
  /** Text the output must *not* contain — the only way to prove a page selection was honoured. */
  expectAbsentText?: string;
  /** Image objects in the output that must carry a soft mask — the transparency check for image watermarks. */
  expectSmaskImages?: number;
  /**
   * The container a delivered part must be in, as `{ index: 0, format: 'webp' }`.
   *
   * Read from the part's own header rather than from the job's report, because "asked for WEBP, got PNG" leaves every
   * other assertion in this file satisfied: the parts are right, their labels are right and their dimensions are
   * right. `format` had three cases on this tool before pass 3 and not one of them looked at an image.
   */
  expectImageFormat?: Array<{ index: number; format: 'png' | 'jpeg' | 'webp' }>;
  /**
   * Pixel dimensions a delivered part must have, as `{ index: 0, width: 2480, height: 3509 }`.
   *
   * The only assertion that can reach `dpi` (a resolution is invisible to page counts) and the only one that can
   * reach "a rotated page is rendered upright": `/Rotate` is applied by the renderer, so the *trace* of it in the
   * output is that an A4 portrait page comes back 842×595.
   */
  expectImageSize?: Array<{ index: number; width: number; height: number }>;
  /** Bits per channel a delivered part must declare — how `colorMode: 'bw'` became an assertion (1-bit). */
  expectImageBits?: Array<{ index: number; bits: number }>;
  /** Channels a delivered part must declare — how `colorMode: 'grayscale'` became an assertion (one). */
  expectImageChannels?: Array<{ index: number; channels: number }>;
  /**
   * The result must not advertise an archive, and `?part=archive` must serve the part itself.
   *
   * The documented rule for a single-output job, and what replaced the `zipSingle` option (defect 128, pass 3): one
   * output is served as itself because an archive of one file is an archive nobody asked for. Both halves are
   * asserted, so "no archive" cannot pass by the URL simply having been left out.
   */
  expectNoArchive?: boolean;
  /** The output must be linearized: hint dictionary at the head, walkable by qpdf. */
  expectLinearized?: boolean;
  /**
   * The queue the job must be **accepted** on, as `expectQueue: 'pdf-heavy'`.
   *
   * Asserted against the `POST /jobs` response rather than the finished job, because those are two different claims:
   * a job created on `light` and moved to `heavy` afterwards by the worker's re-check of the *real* sizes ends on
   * heavy too, and only acceptance tells the two routing points apart. The pool decides the job's time budget, so a
   * routing rule that stopped applying still produces a correct file — with the wrong deadline.
   */
  expectQueue?: string;
  /**
   * The queue the job must **finish** on — `expectFinalQueue: 'pdf-heavy'` for a job the worker re-routed.
   *
   * Read from the job's own record, and about the *second* routing decision rather than the first: the API routes on
   * what its byte scan could see, and the worker re-checks the files themselves at claim time
   * (`workers/shared/src/runtime.ts` step 5). A case whose subject is that re-check is only asserting its subject if
   * it names both answers.
   */
  expectFinalQueue?: string;
  /**
   * Metric paths that must be **greater than** a number — `expectMetricsOver: { inputBytes: 100 * 1024 * 1024 }`.
   *
   * The counterpart to `expectMetrics`, for a measurement the fixture owns rather than the product: a case asserts the
   * threshold its own premise depends on instead of restating the fixture's byte count in a second place.
   */
  expectMetricsOver?: Record<string, number>;
  /**
   * The upload ceiling this case needs the **stack** to have, in MB — `requireUploadCeilingMb: 100`.
   *
   * The case's fixture is bigger than the deployment's default `MAX_FILE_SIZE_MB`, and an API that refuses the upload
   * is right to. Declaring it makes that refusal a **gap** that names the setting rather than a failed case, so a
   * default stack still reports a green suite and the case says what it needs (see `e2e/lib/stack-gap.ts`).
   */
  requireUploadCeilingMb?: number;
  /**
   * Literal strings that must be found in the output's raw bytes or inflated streams.
   *
   * These exist because metadata is not page content: `expectText` reads the document's *text* with `pdftotext`,
   * which cannot see a `/Info` entry or an XMP packet. The presence direction matters as much as the absence one —
   * it is what proves the search can see the string at all, so an absence assertion cannot pass vacuously.
   */
  expectBytes?: string[];
  /** Literal strings that must be gone from both the raw bytes and the inflated streams. */
  expectAbsentBytes?: string[];
  /** The first page's size in points — the one check that can see an orientation or paper-size option. */
  expectPageSize?: { widthPt: number; heightPt: number };
  /**
   * The first page's `/CropBox` in points.
   *
   * Paired with `expectPageSize` in every `crop` case on purpose: cropping is non-destructive, so the MediaBox must
   * *not* change. Asserting only the crop box would also pass for a handler that re-wrote the page, and asserting
   * only the MediaBox would pass for a crop that did nothing.
   */
  expectCropBox?: { widthPt: number; heightPt: number };
  /**
   * Regions in PDF points (`page,x,y,w,h`) that must contain ink once the page is rendered.
   *
   * The only assertion in this file that can see *placement*: a mark on the wrong page, or half off the page, passes
   * every structural check here — which is how the `n-up` rotation defect survived its own suite. Requires `pdftoppm`
   * in `worker-light`, and fails rather than skipping when the page cannot be rendered, because a placement case that
   * silently checks nothing is worse than no case.
   */
  expectInkRegion?: string[];
  /** Regions that must be blank, so a case can assert "here and not there" instead of only "here". */
  expectBlankRegion?: string[];
  /**
   * Per-page `/Rotate`, keyed by 1-based page number — `{ 2: 180 }`.
   *
   * The whole product of a rotation, and the one thing a case had never asserted before pass 5: `rotate`'s three cases
   * measured page counts and warnings, both of which a job that rotated nothing satisfies.
   */
  expectPageRotate?: Record<string, number>;
  /**
   * Every page's `/MediaBox` in points, **in page order** — what makes "one page per TIFF frame, in frame order" a
   * checkable claim rather than a page count.
   */
  expectMediaBoxes?: Array<{ widthPt: number; heightPt: number }>;
  /** Minimum image objects — proves a document's referenced asset was found and embedded. */
  expectImages?: number;
  /**
   * The output must carry **no** signature dictionary (`/Type /Sig`, `/FT /Sig`, `/ByteRange`, `/Perms`).
   *
   * `sign`'s honesty claim, and the only assertion that can see it: attaching a signature dictionary changes nothing
   * about the rendered page, so every other check in this file passes either way.
   */
  expectNoSignatureDictionary?: boolean;
  /** Warning codes the job must report — how an unhonoured option is pinned down instead of quietly ignored. */
  expectWarnings?: string[];
  /**
   * Warning codes the job must **not** report — the negative half of the pair.
   *
   * `ELECTRONIC_SIGNATURE_INVALIDATED` is the reason it exists: five tools now report it when the input carries a
   * signature, and a case that only asserts its presence would pass against a handler that prints the sentence for
   * every file. The unsigned twin of each signed case is what makes the warning a statement about the document.
   */
  expectAbsentWarnings?: string[];
  /**
   * The primary output must be byte-for-byte the *n*-th input (1-based) — the assertion for a tool that says "the
   * original file is returned unchanged", which no page count, text search or render check can distinguish from a
   * re-encoded copy. `compress` is why it exists: its "never bigger" branch returns the input verbatim, and a signature
   * in that input is therefore still valid, so the invalidation warning has to be **absent** there.
   */
  expectIdenticalInput?: number;
  /**
   * Values the job's own `metrics` must carry, at dotted paths.
   *
   * The only assertion that can reach a *worker's* claim about a PDF it produced — `expectJsonPaths` reads the
   * downloaded body, which is not JSON for a PDF tool, and a page count says how many page objects a file contains
   * rather than how many sheets the job meant to compose.
   */
  expectMetrics?: Record<string, unknown>;
  /** The job must *fail* with this code. The only way to prove a refusal happens instead of a bad output. */
  expectError?: string;
  /** A substring the refusal's message must carry, for the codes that answer two different questions (see the runner). */
  expectErrorMessage?: string;
  /** Entry names a package must contain — `word/document.xml`, `ppt/slides/slide1.xml`, `xl/…`. */
  expectEntries?: string[];
  /**
   * Strings the archive's **inflated** entries must contain.
   *
   * Needed because a `.docx`/`.xlsx`/`.pptx` is a ZIP whose readable XML is deflated: `expectBytes` searches raw
   * bytes, which finds nothing in one even when the word the user typed is in the file.
   */
  expectArchiveText?: string[];
  /**
   * Strings the archive's inflated entries must **not** contain — the archive counterpart of `expectAbsentBytes`.
   *
   * The OOXML facts worth asserting are mostly absences: a Word table that should not be there, a spreadsheet whose
   * first cell should no longer be a synthetic column index.
   */
  expectAbsentArchiveText?: string[];
  /**
   * Fixtures this case needs that are not documents: the tool's `auxiliaryFiles` options, given as
   * `{ option: '<file name in fixtures/generated>' }`. They are uploaded by the harness and referenced by id.
   */
  auxiliary?: Record<string, string>;
  /**
   * Run this case as a plan (`free`/`pro`/`business`) instead of as the anonymous session the stack defaults to.
   *
   * The API grants it through the dev plan switch, which refuses to be enabled in production, and the harness
   * *verifies the grant* before running the case — so a case that needs a gated tool cannot pass by accident on a
   * stack where nobody is Pro.
   */
  plan?: 'free' | 'pro' | 'business';
  /**
   * Overrides the catalog's declared output kind. Needed where one branch of a tool returns something else: `split`
   * declares a zip, and with `mergeOutputs` it returns a single PDF (`02-SPLIT-AND-EXTRACT.md` §1).
   */
  expectKind?: 'pdf' | 'zip' | 'image-zip' | 'json' | 'text';
  /**
   * Whether the output is encrypted, as qpdf reads the file itself. Asserted in both directions: "the extraction was
   * refused" and "the password was removed" are the same field with opposite values.
   */
  expectEncrypted?: boolean;
  /** The cipher poppler names (`AES-256`, `AES`). Poppler rather than qpdf because the *cipher* is its own opinion. */
  expectAlgorithm?: string;
  /** Whether the output opens with no password — `restrict`'s promise, and the failure mode `encrypt` must not have. */
  expectOpenWithoutPassword?: boolean;
  /** A password the output must open with, proving the value survived the transport that carried it. */
  expectOpensWith?: string;
  /** Permissions keyed by contract flag (`{ copy: false, print: true }`), as qpdf reads them out of the output. */
  expectPermissions?: Record<string, boolean>;
  /**
   * Assert the reveal channel: this job generated an owner password and must hand it to its caller.
   *
   * The flag does four things, all of them in `e2e/tool.e2e.ts`'s `auditReveal` and the encryption block beside it: a
   * plain GET must not carry the value, `?reveal=1` must return it in the engine's own 24-character shape with the
   * response marked `no-store`, **qpdf must read that value as the output's owner password** (with a one-character
   * variation of it rejected in the same run, so the reading is not vacuous), and no row of the database nor any
   * container's output may contain it.
   *
   * Carried by both tools that generate a value — `encrypt` and `restrict` — because the engine generates it for either
   * and `restrict` is where the *owning* half matters most: nobody sets a user password there, so without this channel a
   * user could restrict their own document and never be able to change it again.
   */
  expectOwnerPasswordRevealed?: boolean;
  /**
   * Annotation counts by `/Subtype` in the output — `{ highlight: 2, note: 1 }`.
   *
   * `annotate` is the only tool whose product is a dictionary rather than paint, and the two are indistinguishable on
   * a rendered page: this is the assertion that tells them apart, read from the file's own `/Subtype` values.
   */
  expectAnnotations?: Record<string, number>;
  /** The output's total annotation count. `0` is how a flattening job asserts it added no dictionaries at all. */
  expectAnnotationCount?: number;
  /** Whether every annotation in the output carries `/F 4`, the print flag. */
  expectAnnotationsPrint?: boolean;
  /** `/QuadPoints` groups per page, keyed by page number — what makes a mark a *markup* rather than a rectangle. */
  expectQuadPoints?: Record<string, number>;
  /**
   * Values the JSON body must carry, at dotted paths with optional `[index]` steps — `{'fields[0].name': 'employee_name'}`.
   *
   * `extract-fields` is the first tool in this build whose output is data, and "it parses as JSON" is satisfied by
   * `{"fields": []}` as readily as by a correct field list. This is the assertion that says *which* field, *which*
   * type, and *which* value — the data counterpart of `expectText`, compared against the parsed body so the writer's
   * formatting is not what a case is testing.
   */
  expectJsonPaths?: Record<string, unknown>;
  /** Set instead of `files` when the case cannot run yet. Printed on every run, never silently skipped. */
  skipped?: string;
}

const ROOT = join(import.meta.dir, '..', '..');
const FIXTURE_DIR = join(ROOT, 'fixtures', 'generated');
/** Git-ignored, and uploaded by CI: the machine-readable form of this run (`docs/0-TESTING.md` §5). */
const ARTIFACT_DIR = join(ROOT, 'e2e', 'artifacts');

interface SuiteResult {
  suite: string;
  tool: string;
  pool: Pool;
  status: 'passed' | 'failed';
  exitCode: number;
  durationMs: number;
  /** Checks the harness reported, or null when its summary line could not be read — never a guess. */
  checks: number | null;
  files: string[];
  options?: Record<string, unknown>;
}

/** `merge` escalates above 20 files, so 21 identical two-page inputs is the smallest honest escalation test. */
const ESCALATION_FILES = Array.from({ length: 21 }, () => 'merge-two-a4.pdf');

/**
 * The redaction fixture's geometry, repeated from `scripts/dev/make-redact-fixture.ts`.
 *
 * Repeated rather than imported because that file *builds* the fixture when it is run, and importing it from the suite
 * would rebuild it on every run. The numbers cannot drift silently: the generator measures each token's real bounding
 * box with PyMuPDF and refuses to write the fixture unless the rectangle below contains it.
 */
const REDACT_SECRET_RECT = { x: 66, y: 594, w: 380, h: 24 };
const REDACT_SHARED_RECT = { x: 66, y: 474, w: 380, h: 24 };
const REDACT_SECOND_PAGE_RECT = { x: 66, y: 594, w: 380, h: 24 };
/** The band between the marked line and the one below it: blank before the job and blank after it. */
const REDACT_GAP_REGION = '1,66,572,380,16';

/**
 * A freehand stroke of exactly `count` points, inside page 1 of `pages-six-a4.pdf`.
 *
 * Generated rather than written out because the two cases that use it are about a *number*: `13-EDIT-AND-ANNOTATE.md`
 * §6 caps a stroke at 5 000 points, so the pair is 5 000 (legal, the strict edge) and 5 001 (refused). Every point
 * stays inside the page's rectangle, so the cap is the only thing either case can be about — an off-page warning
 * would otherwise be a second reason for the same job to say something.
 */
function freehandStroke(count: number): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, index) => ({
    x: 100 + ((index * 7) % 300),
    y: 400 + ((index * 11) % 100),
  }));
}

const CASES: GoldenCase[] = [
  // ── security (light) ─────────────────────────────────────────────────────────────────────────────────────
  //
  // Four cases for three tools, and every one of them asserts something a page count and a text search cannot see: a
  // document that is "protected" and is not, a restriction that was never applied, a password the file does not
  // accept, and a decryption that left the encryption in place. The passwords are constants here on purpose — they are
  // sent in the request body by the harness, so the assertion is "the value the caller typed is the value the file
  // wants", which a randomly generated password could not distinguish from a file keyed to nothing.
  {
    // AES-256 and the strictest permission set. `copy: false` is the load-bearing assertion: qpdf reports it as
    // "extract for any purpose: not allowed", a flag a reader has to have been *written* to honour, so it is the one
    // that proves the permission block was applied rather than the file merely being encrypted.
    //
    // `expectOpensWith` is the transport check — the password travels to pikepdf on stdin, and this is what fails if
    // any layer on the way re-encodes or truncates it.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      userPassword: 'e2e-user-secret',
      encryption: 'aes-256',
      permissions: {
        print: true,
        printHighRes: false,
        copy: false,
        modify: false,
        annotate: false,
        fillForms: false,
        assemble: false,
        accessibility: true,
      },
    },
    expectEncrypted: true,
    expectAlgorithm: 'AES-256',
    expectOpenWithoutPassword: false,
    expectOpensWith: 'e2e-user-secret',
    expectPermissions: {
      copy: false,
      print: true,
      printHighRes: false,
      modify: false,
      annotate: false,
      assemble: false,
    },
    expectPages: 6,
    // No `ownerPassword` was given, so one had to be generated — and the warning is the only way a caller learns that
    // the permissions are now guarded by a value nobody holds. Asserted here rather than described in the docs,
    // because the alternative (no owner password at all) silently produces a document that opens for everyone.
    expectWarnings: ['OWNER_PASSWORD_GENERATED', 'PERMISSIONS_READER_DEPENDENT'],
  },
  {
    // AES-128, because the cipher is not a detail a case may assume: `R = 4` and `AESv2` are what an older reader
    // needs, and a handler that ignored the option would pass the AES-256 case above unchanged.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { userPassword: 'e2e-user-secret', encryption: 'aes-128', permissions: { copy: false } },
    expectEncrypted: true,
    expectAlgorithm: 'AES',
    expectOpensWith: 'e2e-user-secret',
    expectPermissions: { copy: false },
    expectPages: 6,
  },
  {
    // The reveal channel, end to end, and the only case that asserts it: no owner password is supplied, so the engine
    // generates one — and it has to reach the caller, open the file as its owner, and be findable in no row and in no
    // log. `OWNER_PASSWORD_GENERATED` is required alongside it, so the warning and the value cannot drift apart.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { userPassword: 'e2e-user-secret', encryption: 'aes-256', permissions: { copy: false } },
    expectEncrypted: true,
    expectAlgorithm: 'AES-256',
    expectOpenWithoutPassword: false,
    expectOpensWith: 'e2e-user-secret',
    expectOwnerPasswordRevealed: true,
    expectPages: 6,
    expectWarnings: ['OWNER_PASSWORD_GENERATED'],
  },
  {
    // The one revision where `accessibility: false` is honoured rather than dropped, and therefore the reason `rc4-128`
    // is in the contract at all. Two assertions make it a check rather than a claim: qpdf must read the flag as
    // **denied** out of the file, and the job must *not* report the warning that says the flag was ignored.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      userPassword: 'e2e-user-secret',
      encryption: 'rc4-128',
      permissions: { accessibility: false, copy: false },
    },
    expectEncrypted: true,
    expectAlgorithm: 'RC4',
    expectOpenWithoutPassword: false,
    expectOpensWith: 'e2e-user-secret',
    expectPermissions: { accessibility: false, copy: false },
    expectPages: 6,
    expectWarnings: ['LEGACY_ENCRYPTION'],
    expectAbsentWarnings: ['ACCESSIBILITY_FLAG_IGNORED'],
  },
  {
    // The same request on an AES revision, where the flag is genuinely dropped: the pair of case and warning is what
    // makes either of them worth reading. Note `expectPermissions.accessibility: true` — the file allows what the
    // caller denied, which is the measurement behind the warning rather than a restatement of the option.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      userPassword: 'e2e-user-secret',
      encryption: 'aes-256',
      permissions: { accessibility: false, copy: false },
    },
    expectEncrypted: true,
    expectAlgorithm: 'AES-256',
    expectOpensWith: 'e2e-user-secret',
    expectPermissions: { accessibility: true, copy: false },
    expectPages: 6,
    expectWarnings: ['ACCESSIBILITY_FLAG_IGNORED'],
    expectAbsentWarnings: ['LEGACY_ENCRYPTION'],
  },
  {
    // The floor every plan shares, and the reason it is a *floor* rather than the policy: three characters is not a
    // weak password, it is a value that is not a password — and a document keyed to it is a document with a lock drawn
    // on it. Refused at the door, so no worker ever sees it and no file is written.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { userPassword: 'abc', encryption: 'aes-256', permissions: { copy: false } },
    expectError: 'WEAK_PASSWORD',
  },
  {
    // The policy, on the plan that asks for it: eight characters and **two** classes is short of the three the policy
    // requires, and Business is where that stops being a remark and becomes a refusal. `--plan business` is the whole
    // measurement here — the same options one case above and one case below are accepted, so what this asserts is the
    // plan's rule rather than the password's shape alone.
    tool: 'encrypt',
    pool: 'light',
    plan: 'business',
    files: ['pages-six-a4.pdf'],
    options: { userPassword: 'abcd1234', encryption: 'aes-256', permissions: { copy: false } },
    expectError: 'WEAK_PASSWORD',
  },
  {
    // The same eight-character password on a plan that does not require the policy. It runs, the document is protected
    // by it, and the job **says** the password is weak rather than letting it pass in silence — the pair to the case
    // above, and the only thing that distinguishes "this plan allows it" from "this build forgot to check".
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { userPassword: 'abcd1234', encryption: 'aes-256', permissions: { copy: false } },
    expectEncrypted: true,
    expectAlgorithm: 'AES-256',
    expectOpenWithoutPassword: false,
    expectOpensWith: 'abcd1234',
    expectPages: 6,
    expectWarnings: ['WEAK_PASSWORD_ACCEPTED'],
  },
  {
    // And the other edge of the same rule: on Business, a password that *meets* the policy is accepted silently. Without
    // this case, a handler that warned unconditionally — or an API that refused unconditionally — would pass both cases
    // above, and the option would read as "Business may not protect anything".
    tool: 'encrypt',
    pool: 'light',
    plan: 'business',
    files: ['pages-six-a4.pdf'],
    options: { userPassword: 'Abcd1234', encryption: 'aes-256', permissions: { copy: false } },
    expectEncrypted: true,
    expectOpenWithoutPassword: false,
    expectOpensWith: 'Abcd1234',
    expectPages: 6,
    expectAbsentWarnings: ['WEAK_PASSWORD_ACCEPTED'],
  },
  {
    // The same rule seen from the other side of the tool: `restrict` chooses one password, and the policy judges that
    // one. Deliberately a *weaker* claim than the encrypt cases — the owner password here is 12 characters and two
    // classes, so it is over the policy's length and under its classes, which is what makes the warning fire on the
    // class count rather than on a length the schema already enforces (`ownerPassword` is `min(6)`).
    tool: 'restrict',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { ownerPassword: 'ownersecret1', encryption: 'aes-256', permissions: { copy: false } },
    expectEncrypted: true,
    expectOpenWithoutPassword: true,
    expectPages: 6,
    expectWarnings: ['WEAK_PASSWORD_ACCEPTED'],
  },
  {
    // `restrict`: opens freely, printing allowed, copying and modification denied. The two open-with assertions are
    // the pair that makes this tool's promise checkable — the file must open with *no* password (or it is a lockout)
    // and must not be readable-without-password in the way `encrypt` is.
    tool: 'restrict',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      encryption: 'aes-256',
      permissions: {
        print: true,
        printHighRes: false,
        copy: false,
        modify: false,
        annotate: false,
        fillForms: false,
        assemble: false,
        accessibility: true,
      },
    },
    expectEncrypted: true,
    expectAlgorithm: 'AES-256',
    expectOpenWithoutPassword: true,
    expectPermissions: { copy: false, modify: false, assemble: false, print: true },
    expectPages: 6,
    // The honest caveat ships with every real restriction, and the generated owner password is the warning a caller
    // has to see at least once. The reveal is asserted here rather than only on `encrypt` because this is the case where
    // a dropped value is unrecoverable in practice: the file opens freely, so nothing else in it tells the caller that
    // an owner password exists at all.
    expectWarnings: ['PERMISSIONS_READER_DEPENDENT', 'OWNER_PASSWORD_GENERATED'],
    expectOwnerPasswordRevealed: true,
  },
  {
    // `unlock`, against the fixture built by `bun run fixtures:encrypted` (AES-256, user + owner password, copy
    // denied). The output must be *not* encrypted and must still have all six pages — and the restrictions that
    // cannot survive decryption have to be reported rather than silently dropped.
    tool: 'unlock',
    pool: 'light',
    plan: 'pro',
    files: ['protected-aes256-a4.pdf'],
    options: { password: 'fixture-user-pass' },
    expectEncrypted: false,
    expectOpenWithoutPassword: true,
    expectPages: 6,
    expectWarnings: ['RESTRICTIONS_REMOVED'],
  },
  {
    // The wrong password is a typed refusal, not a partial file. Nothing about the output can be asserted because
    // there must not be one, which is exactly why this case is worth running: a handler that wrote the file first and
    // checked afterwards would leave a still-encrypted "unlocked.pdf" behind with a 200 alongside it.
    tool: 'unlock',
    pool: 'light',
    plan: 'pro',
    files: ['protected-aes256-a4.pdf'],
    options: { password: 'not-the-password' },
    expectError: 'WRONG_PASSWORD',
  },
  {
    // The owner password opens the file too, which is the behaviour `unlock` relies on instead of trying user-then-
    // owner itself. A case for it, because "the supplied password is tried as both" is a claim about the engine that a
    // future swap to qpdf's CLI would break.
    tool: 'unlock',
    pool: 'light',
    plan: 'pro',
    files: ['protected-aes256-a4.pdf'],
    options: { password: 'fixture-owner-pass' },
    expectEncrypted: false,
    expectPages: 6,
  },
  {
    // `unlock` on a file that was never encrypted. Point 1 of the handler's own contract, and until this case existed
    // it was checked by nothing: the behaviour is a *success* whose only evidence is a warning, so a build that had
    // started refusing such a file (or quietly dropped the warning) would have gone on passing every other case here.
    // The tool's promise is "this file will have no password afterwards" — already true of a plain document — and
    // refusing would fail the user who cannot tell whether their file is protected, which is most of the callers who
    // reach for this tool at all (`workers/light/src/handlers/security.ts`).
    tool: 'unlock',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { password: 'anything-at-all' },
    expectEncrypted: false,
    expectOpenWithoutPassword: true,
    expectPages: 6,
    expectWarnings: ['INPUT_NOT_ENCRYPTED'],
    // The pair matters as much as the warning: `RESTRICTIONS_REMOVED` is what the *encrypted* branch reports, and a
    // handler that ran the decryption path over a plain file would announce restrictions it never found.
    expectAbsentWarnings: ['RESTRICTIONS_REMOVED'],
  },
  {
    // `encrypt` with an owner password and every permission granted: a job that restricted **nothing**, said out loud.
    // The warning is the whole point of the case, because the alternative — a success that reads like protection — is
    // how a user comes to believe a document is protected when it is not. The pair of assertions is what makes it a
    // fact about the file rather than a sentence about the handler: `PERMISSIONS_READER_DEPENDENT` must be **absent**
    // (there is nothing to caveat) while `NO_RESTRICTION_APPLIED` is present.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      // Three classes and sixteen characters: chosen so the *strength* warning cannot fire and leave the case
      // asserting two warnings where it means to assert one.
      ownerPassword: 'E2e-0wner-Secret!',
      encryption: 'aes-256',
      permissions: {
        print: true,
        printHighRes: true,
        copy: true,
        modify: true,
        annotate: true,
        fillForms: true,
        assemble: true,
        accessibility: true,
      },
    },
    expectEncrypted: true,
    expectAlgorithm: 'AES-256',
    // No user password was set, and that is the observation: the file opens with nothing typed into it.
    expectOpenWithoutPassword: true,
    expectPages: 6,
    expectWarnings: ['NO_RESTRICTION_APPLIED'],
    expectAbsentWarnings: ['PERMISSIONS_READER_DEPENDENT', 'WEAK_PASSWORD_ACCEPTED'],
  },
  {
    // `encrypt` refuses a **protected input** rather than re-keying it, and this is the refusal this tool's own
    // document claimed while nothing tested it: the case that looked like this one in the suite was `split`'s, a
    // different tool whose answer is right for a different reason (`split` has no password option at all). Re-keying
    // would need the old password — measured, the engine fails with `invalid password` — so the only other outcome
    // would be a document silently keeping its old key while the job reported the new one.
    //
    // What this case can and cannot see, stated because the document claims more than it: the *outcome* is asserted,
    // and **two** layers produce it — the handler's `refuseEncryptedInput` before anything is spawned, and the write
    // script's `except pikepdf.PasswordError` behind it. Removing either one alone leaves the code unchanged, so this
    // case cannot tell "refused at the door" from "refused by the engine"; the difference is that the handler's
    // message names the remedy, and that is what `0-E2E-CHECKLIST.md` records as still unasserted.
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['protected-aes256-a4.pdf'],
    options: { userPassword: 'e2e-user-secret', encryption: 'aes-256', permissions: { copy: false } },
    expectError: 'ENCRYPTED_INPUT',
  },
  {
    // The same refusal on the tool that never sets a user password, because the two reach it through one function and
    // a claim about one of them is not a claim about both: `restrict` is the case a user is most likely to attempt on
    // a protected document, expecting the permissions to be *replaced*.
    tool: 'restrict',
    pool: 'light',
    plan: 'pro',
    files: ['protected-aes256-a4.pdf'],
    options: { encryption: 'aes-256', permissions: { copy: false } },
    expectError: 'ENCRYPTED_INPUT',
  },

  // ── light ────────────────────────────────────────────────────────────────────────────────────────────────
  // Page selections are `PageRange[]` (`packages/contracts/src/tools/options.ts`), the shape the web's `pages`
  // control parses a typed "1-5, 9" into — so they are passed as arrays here, not as the string a user types.
  {
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['1-3'] },
    expectPages: 3,
  },
  {
    // The last-page spelling from `02-SPLIT-AND-EXTRACT.md` §2. It is a *grammar* case: `2-z` is what a user types for
    // "from here to the end", and until this case existed nothing in the build accepted it — the schema refused the
    // token and the worker's parser had never heard of `z` (defect 124).
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['2-z'] },
    expectPages: 5,
  },
  {
    // The other two documented spellings, in one case each: `odd` selects 1, 3, 5 and `even` selects 2, 4, 6, so a
    // parser that resolved both to "every page" would produce six and fail here.
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['odd'] },
    expectPages: 3,
  },
  {
    tool: 'delete-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['even'] },
    expectPages: 3,
  },
  {
    // `exclude` is the same pages from the other side, which is what the web form's toggle sends.
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['1', '3', '5'], mode: 'exclude' },
    expectPages: 3,
  },
  {
    tool: 'delete-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['1-2'] },
    expectPages: 4,
  },
  {
    // Removing every page is refused rather than producing an empty document, which is the one rule §3.2 states about
    // this tool. A case for it because a refusal is only visible if something asks for one.
    tool: 'delete-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['1-z'] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // Two malformed selections, one per layer: a backwards range is grammar the shared parser refuses, and a page
    // beyond the document is a fact about the file. Both have to fail *before* an engine runs.
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['9-5'] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['1-99'] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // `9-z` on a six-page document resolves to nothing at all, which is refused with the real page count instead of
    // silently producing an empty selection.
    tool: 'extract-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['9-z'] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // The bookmarks and metadata half of "extract the pages you need": a page selection goes through the same
    // `qpdf --empty --pages` call a split part does, so it loses the outline and `/Info` the same way (defect 125).
    // The title is asserted, not just the page count, because a file with two pages and no bookmarks passes every
    // other check in this suite.
    tool: 'extract-pages',
    pool: 'light',
    files: ['bookmark-toc.pdf'],
    options: { pages: ['2-z'] },
    expectPages: 2,
    expectOutline: ['Chapter 2'],
    expectAbsentOutline: ['Chapter 1'],
    expectMetrics: { outlineEntries: 2 },
  },
  {
    //
    // `reverse` was one of the two cases this tool had, and it asserted a page **count** — which is the same number
    // whether the handler reversed the document or wrote it back untouched. Six assertions on six labelled pages now:
    // the last page's text first, the first page's text last, and the fixture's own wording in between. `pdftotext`
    // reads each page separately, so a copy that arrived in the wrong place fails here (defect 226).
    //
    tool: 'reorder-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { reverse: true },
    expectPages: 6,
    expectPageText: [
      { index: 0, text: 'page 6 of 6' },
      { index: 1, text: 'page 5 of 6' },
      { index: 5, text: 'page 1 of 6' },
    ],
  },
  {
    //
    // The duplicate's **position**, which nothing had ever asserted — and the document has promised it since the
    // option was written: `03-ORGANIZE-ROTATE-CROP.md` §2.1 says `duplicate` repeats a page "immediately after
    // itself", while the handler appended the copies at the end of the document (`1,2,3,4,5,6,3` for `duplicate: [3]`,
    // measured with qpdf and `pdftotext`). A copy at the back of the file is not a duplicate of anything the user can
    // see — it reads as the page having moved there. Page 4 is the assertion: it is the page that has to come *after*
    // the copy, and it is the one a handler that appends would put in position 3.
    //
    tool: 'reorder-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { duplicate: [3, 3] },
    expectPages: 8,
    expectPageText: [
      { index: 2, text: 'page 3 of 6' },
      { index: 3, text: 'page 3 of 6' },
      { index: 4, text: 'page 3 of 6' },
      { index: 5, text: 'page 4 of 6' },
      { index: 7, text: 'page 6 of 6' },
    ],
    expectMetrics: { duplicated: 2, outputPages: 8 },
  },
  {
    // The two options **composing**: an explicit order says where page 3 goes, and the copy follows it there rather
    // than following the source numbering. `{ order: [3,1,2], duplicate: [3] }` is `3,3,1,2` — the reading that keeps
    // the options from contradicting each other, and the one the UI's board writes when a page that has been dragged
    // is duplicated (`features/page-order/`).
    //
    tool: 'reorder-pages',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { order: [3, 1, 2, 4, 5, 6], duplicate: [3] },
    expectPages: 7,
    expectPageText: [
      { index: 0, text: 'page 3 of 6' },
      { index: 1, text: 'page 3 of 6' },
      { index: 2, text: 'page 1 of 6' },
      { index: 6, text: 'page 6 of 6' },
    ],
    expectMetrics: { duplicated: 1, outputPages: 7 },
  },
  {
    // The same two losses the page-selection tools decorate for, because it is the same command: `qpdf --empty
    // --pages` builds a fresh document, so the output has no `/Outlines` and an empty `/Info`. Measured on this
    // handler's own output before the fix — `qpdf --json --json-key=outlines` printed `"outlines": []` — and it was
    // silent, while `extract-pages` and `delete-pages` both lifted the outline and warned when they could not
    // (defect 143). The nested title is asserted as well as the parents: a decorator that lifted only top-level
    // entries passes a case that asks for a parent name.
    tool: 'reorder-pages',
    pool: 'light',
    files: ['bookmark-toc.pdf'],
    options: { order: [3, 1, 2] },
    expectPages: 3,
    expectOutline: ['Chapter 1', 'Chapter 2', 'Section 1.1'],
    expectMetrics: { outlineEntries: 3 },
  },
  {
    tool: 'rotate',
    pool: 'light',
    files: ['rotate-landscape-a4.pdf'],
    options: { angle: 90 },
    expectPages: 2,
  },
  {
    // One output per range, so the twelve-page fixture has to come back as four files — and the parts have to be the
    // document: every page exactly once, each part's own objects matching the page list it declares.
    tool: 'split',
    pool: 'light',
    files: ['split-twelve-a4.pdf'],
    options: { mode: 'ranges', ranges: [['1-3'], ['4-6'], ['7-9'], ['10-12']] },
    expectParts: 4,
    expectPartition: 12,
    expectPartPages: [
      { index: 0, pages: [1, 2, 3] },
      { index: 3, pages: [10, 11, 12] },
    ],
    expectMetrics: { mode: 'ranges', parts: 4, inputPages: 12, outlineEntries: 0 },
  },
  {
    // The same document split by count: three parts, the last one short. `everyNPages` is the option the web form
    // defaults to when the user picks "Every N pages", and the *last* part is the one that proves the arithmetic — a
    // handler that dropped the remainder produces two parts of five and no complaint.
    tool: 'split',
    pool: 'light',
    files: ['split-twelve-a4.pdf'],
    options: { mode: 'every-n', everyNPages: 5 },
    expectParts: 3,
    expectPartition: 12,
    expectPartPages: [{ index: 2, pages: [11, 12] }],
  },
  {
    // Greedy packing by measured page weight, against a fixture whose pages are deliberately unequal (two of ~60 kB,
    // three of ~30 kB). At 0.1 MB the only correct answer is [1], [2,3], [4,5]: a packer that ignored the target would
    // produce one part, and one that split a page would produce something with a different partition.
    tool: 'split',
    pool: 'light',
    files: ['split-weighted-a4.pdf'],
    options: { mode: 'by-size', bySizeMb: 0.1 },
    expectParts: 3,
    expectPartition: 5,
    expectPartPages: [
      { index: 0, pages: [1] },
      { index: 1, pages: [2, 3] },
      { index: 2, pages: [4, 5] },
    ],
  },
  {
    // The outline is the *input* to this mode, so the assertion is the page map it derives: level 1 has two entries
    // (pages 1 and 4), which span [1..3] and [4..6].
    tool: 'split',
    pool: 'light',
    files: ['split-bookmarked-a4.pdf'],
    options: { mode: 'by-bookmarks', byBookmarks: 'level1' },
    expectParts: 2,
    expectPartition: 6,
    expectPartPages: [
      { index: 0, pages: [1, 2, 3] },
      { index: 1, pages: [4, 5, 6] },
    ],
    // The decoration claim, in the direction that is easy to lose: the *children* of each part's entry. `Part 1.1` and
    // `Part 2.1` are nested in the source, so a handler that only lifted top-level entries fails here while every page
    // count still matches. Four entries in total: two parents and their two children, spread across the two parts.
    expectPartOutlines: [
      { index: 0, title: 'Part 1.1' },
      { index: 1, title: 'Part 2.1' },
    ],
    expectMetrics: { outlineEntries: 4 },
  },
  {
    // Every bookmark, nested or not: entries at pages 1, 2, 4 and 5 become [1], [2..3], [4] and [5..6], and the fourth
    // part's entry is hoisted to its root because its parent lives in the third — which is the case that caught an
    // off-by-one in the page map, where a part carried the *next* page's bookmark.
    tool: 'split',
    pool: 'light',
    files: ['split-bookmarked-a4.pdf'],
    options: { mode: 'by-bookmarks', byBookmarks: 'all' },
    expectParts: 4,
    expectPartition: 6,
    expectPartPages: [
      { index: 0, pages: [1] },
      { index: 1, pages: [2, 3] },
      { index: 2, pages: [4] },
      { index: 3, pages: [5, 6] },
    ],
    expectPartOutlines: [
      { index: 0, title: 'Part 1' },
      { index: 3, title: 'Part 2.1' },
    ],
  },
  {
    // "Also return one merged copy" — a branch that runs only when the user ticks a box, and which therefore hid a
    // repeated-`--pages` bug from every previous run of this suite. It is one flag, so it is worth a case.
    tool: 'split',
    pool: 'light',
    files: ['split-twelve-a4.pdf'],
    options: { mode: 'ranges', ranges: [['1-5'], ['6-12']], mergeOutputs: true },
    expectKind: 'pdf',
    expectPages: 12,
  },
  {
    // The same flag on a bookmarked document, where the merged copy has something to lose: §7 says "mergeOutputs keeps
    // a merged outline", and re-assembling the pieces puts the original outline back — nested, in document order —
    // rather than the per-part or flattened one a decorator that treated the parts as sources would produce.
    tool: 'split',
    pool: 'light',
    files: ['split-bookmarked-a4.pdf'],
    options: { mode: 'ranges', ranges: [['1-3'], ['4-6']], mergeOutputs: true },
    expectKind: 'pdf',
    expectPages: 6,
    expectOutline: ['Part 1', 'Part 2'],
    // Eight, not four: `outlineEntries` counts what this job **wrote**, and with `mergeOutputs` it wrote three files —
    // two parts carrying two entries each and the assembled copy carrying all four. The merged copy is decorated from
    // the source rather than from the parts precisely so that its four are the original outline, nested.
    expectMetrics: { mergeOutputs: true, outputs: 1, outlineEntries: 8, parts: 2 },
  },
  {
    // Splitting by bookmarks a document that has none is a refusal with a reason, not an empty result: the message
    // names the two modes that would work instead.
    tool: 'split',
    pool: 'light',
    files: ['split-twelve-a4.pdf'],
    options: { mode: 'by-bookmarks', byBookmarks: 'level1' },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // A password-protected input is refused before any work (§7). Split has no `password` option at all, so the only
    // correct answer is to say so — and a job that "succeeded" on an encrypted file would have produced parts nobody
    // can open.
    tool: 'split',
    pool: 'light',
    files: ['protected-aes256-a4.pdf'],
    options: { mode: 'ranges', ranges: [['1-2']] },
    expectError: 'ENCRYPTED_INPUT',
  },
  {
    // Sixty parts, which is the count that broke the decoration: the Python bridge's result is one object per output,
    // and at 60 of them the JSON is ~6.5 kB — past the wrapper's 4 KB capture, so the parse failed and every part came
    // back with a warning that its bookmarks could not be restored (defect 126). The absence assertion is the point: a
    // broken bridge produces *a warning per part*, so "no warning" is what a working one looks like.
    tool: 'split',
    pool: 'light',
    files: ['split-sixty-a4.pdf'],
    options: { mode: 'every-n', everyNPages: 1 },
    expectParts: 60,
    expectPartition: 60,
    expectAbsentWarnings: ['OUTPUT_NOT_DECORATED', 'METADATA_NOT_COPIED'],
  },
  {
    // `by-size` on a document whose object table is **larger than the engine wrapper's 4 KB log tail** (4 978 bytes for
    // this fixture). The mode cannot work without the whole table, so this is the case that pins defect 123 down: it
    // passed nothing before the payload-sized read budget existed, and it fails again if that budget goes away.
    tool: 'split',
    pool: 'light',
    files: ['split-bookmarked-a4.pdf'],
    options: { mode: 'by-size', bySizeMb: 0.1 },
    expectParts: 3,
    expectPartition: 6,
    expectPartPages: [
      { index: 0, pages: [1, 2] },
      { index: 2, pages: [5, 6] },
    ],
  },
  {
    // A range beyond the document is refused with the real page count (§2). The parts that *could* be written are not
    // written, which is what makes this a validation rule rather than a clipping rule.
    tool: 'split',
    pool: 'light',
    files: ['split-twelve-a4.pdf'],
    options: { mode: 'ranges', ranges: [['1-3'], ['11-20']] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pdf-to-images-two.pdf'],
    options: { format: 'png', dpi: 72 },
    expectParts: 2,
    expectImageFormat: [{ index: 0, format: 'png' }],
    // A multi-output job is the archive case: two images come back as a ZIP, and every entry inside it is one of
    // them. The single-output half of this rule is the one-page case below.
    expectEntries: ['page-001.png', 'page-002.png'],
  },
  {
    // Selecting one page out of six, which is the option this case exists for and the one nothing asserted until
    // defect 102: `-p` is mutool draw's *password* flag, so the range was ignored, all six pages were rendered, and
    // the parts were labelled `[1, null, null, null, null, null]` — the first by luck, the rest by a loop walking a
    // six-file list against a one-page selection. The count is the half that catches "the selection did nothing";
    // the label is the half the placement canvas reads to find the image for the page it is showing.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'png', dpi: 72, pages: ['3'] },
    expectParts: 1,
    expectPartPages: [{ index: 0, pages: [3] }],
    // The job's own numbers, at the harness's array syntax — the third place the selection is visible, and the only
    // one that says what the handler *meant* to render rather than what the file contains.
    expectMetrics: { 'renderedPageNumbers[0]': 3 },
    // One output, so no archive is advertised and `?part=archive` serves the image itself. The rule that replaced
    // `zipSingle` (defect 128), asserted in both halves rather than described in a document.
    expectNoArchive: true,
    expectImageSize: [{ index: 0, width: 595, height: 842 }],
  },
  {
    // A range, because the two plausible implementations of "selection" disagree here: a dense list ("render 2 and 3")
    // and an offset pair ("render two pages from page 2") both produce two parts, and only the labels say which pages
    // they are. `2-3` must come back labelled `[2]` and `[3]`, in that order.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'png', dpi: 72, pages: ['2-3'] },
    expectParts: 2,
    expectPartPages: [
      { index: 0, pages: [2] },
      { index: 1, pages: [3] },
    ],
  },
  {
    // 300 dpi on one page: the dimension assertion, and the first case in this suite that can see the resolution at
    // all. A4 is 595×842 pt, and the renderer produces **2480 × 3509** px — one pixel taller than the reference table
    // in the document said (2480 × 3508) until pass 3 measured it. The case asserts what the engine produces; the
    // table was corrected to match, because a number nobody measures is wrong the first time someone checks.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'png', dpi: 300, pages: ['1'] },
    expectParts: 1,
    expectImageSize: [{ index: 0, width: 2480, height: 3509 }],
  },
  {
    // Grayscale, asserted in bytes: one channel at 8 bits. The document promised a single-channel file and nothing
    // in the suite looked at an image, so the option's *visible* half was a sentence in a table.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'png', dpi: 72, colorMode: 'grayscale', pages: ['1'] },
    expectImageChannels: [{ index: 0, channels: 1 }],
    expectImageBits: [{ index: 0, bits: 8 }],
  },
  {
    // `bw` on PNG must be **1-bit**, which is what the option promises and what it did not do: the handler copied the
    // render through untouched and answered with a warning instead (defect 127, pass 3). The warning must be
    // *absent* here, which is what makes the pair with the JPEG case below a statement about the container rather
    // than about the handler's willingness to print a sentence.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'png', dpi: 72, colorMode: 'bw', pages: ['1'] },
    expectImageBits: [{ index: 0, bits: 1 }],
    expectImageChannels: [{ index: 0, channels: 1 }],
    expectAbsentWarnings: ['BW_REQUESTED'],
  },
  {
    // The same request in a container that cannot hold one bit per channel. JPEG's minimum precision is 8, so the
    // warning here is *correct* and asserted: one component (grey), 8 bits, and the sentence that says why.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'jpg', dpi: 72, colorMode: 'bw', pages: ['1'] },
    expectImageFormat: [{ index: 0, format: 'jpeg' }],
    expectImageChannels: [{ index: 0, channels: 1 }],
    expectImageBits: [{ index: 0, bits: 8 }],
    expectWarnings: ['BW_REQUESTED'],
  },
  {
    // WEBP, asserted for the first time. Its dimensions live in the container rather than in a header field that every
    // producer writes the same way, which is why the image reader parses all three WEBP shapes.
    //
    // 150 dpi on A4 is **1240×1755**, not the 1240×1754 the document's reference table said: mutool *ceils* each
    // dimension (842 × 150/72 = 1754.17), which this case is what discovered — every row of that table was checked
    // against a real render and two of them were off by a pixel (pass 3).
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'webp', dpi: 150, pages: ['1'] },
    expectImageFormat: [{ index: 0, format: 'webp' }],
    expectImageSize: [{ index: 0, width: 1240, height: 1755 }],
  },
  {
    // The archival row, measured for the same reason the two above are: 600 dpi on A4 is 4959×7017 by the ceil rule
    // (595 × 600/72 = 4958.33, 842 × 600/72 = 7016.67). It also exercises the projection guard on its largest legal
    // input — 139 MB of pixels for one page, under the 512 MB per-page cap — which is the case that keeps the cap and
    // the renderer's own arithmetic honest about each other.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'jpg', dpi: 600, pages: ['1'], quality: 80 },
    expectImageSize: [{ index: 0, width: 4959, height: 7017 }],
  },
  {
    // A rotated document: four A4 *portrait* pages each carrying `/Rotate 90`, which the renderer applies — so the
    // images come back 842×595. The dimensions are the assertion because that is the only trace rotation leaves: the
    // page box is unchanged, the text is unchanged, and a renderer that ignored `/Rotate` would produce a perfectly
    // good upright-looking image of a page lying on its side. The warning is the second half, and it is the one the
    // document promised while nothing emitted it.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['nup-rotated-a4.pdf'],
    options: { format: 'png', dpi: 72 },
    expectParts: 4,
    expectImageSize: [
      { index: 0, width: 842, height: 595 },
      { index: 3, width: 842, height: 595 },
    ],
    expectWarnings: ['PAGE_ROTATION_NORMALIZED'],
  },
  {
    // The page with no ink, which is what `BLANK_PAGES_DETECTED` is for: page 2 of the fixture is empty by
    // construction (no label, no rules, no text), so its darkest pixel is pure white and the job says so — naming
    // the page of the *document*, not the index of the file, because the user selected pages.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pdf-to-images-blank-a4.pdf'],
    options: { format: 'png', dpi: 72 },
    expectParts: 3,
    expectWarnings: ['BLANK_PAGES_DETECTED'],
    expectMetrics: { 'blankPages[0]': 2 },
  },
  {
    // The control for the case above, and the reason it is a statement about the *document*: the same request on a
    // fixture where every page has ink must be silent. Without this, a handler that printed the sentence
    // unconditionally would pass the blank case and every user would be told their pages were empty.
    tool: 'pdf-to-images',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'png', dpi: 72 },
    expectAbsentWarnings: ['BLANK_PAGES_DETECTED', 'PAGE_ROTATION_NORMALIZED'],
  },
  {
    // Three formats in one job on purpose: every input goes through the same ImageMagick call, so a change that
    // works for PNG and silently breaks JPEG has nowhere else to show up.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-portrait.png', 'images-to-pdf-landscape.jpg', 'images-to-pdf-square.webp'],
    expectPages: 3,
    // `fit` is the one mode that keeps the alpha channel (measured: the delivered page renders `srgba`), so the warning
    // about flattening must be **absent** here — the negative half of the pair below.
    expectAbsentWarnings: ['ALPHA_FLATTENED', 'EXIF_ORIENTATION_APPLIED'],
  },
  {
    // The other half of the handler: a fixed page box with `orientation: auto` (which has to measure each image),
    // cover scaling and a margin, rather than the default "page follows the image".
    //
    // `IMAGE_UPSCALED` is owed here and is the reason the option is worth warning about: a 400×600 photo on A4 is
    // enlarged to 595×893 at 72 dpi, which the document says the UI answers with "use fit instead" (defect 139: the
    // warning existed in §3 and in no handler).
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-portrait.png', 'images-to-pdf-landscape.jpg'],
    options: { pageSize: 'a4', orientation: 'auto', fit: 'cover', margin: 10 },
    expectPages: 2,
    expectWarnings: ['IMAGE_UPSCALED'],
  },
  {
    // EXIF orientation, and the case is a **pair** because either half alone is satisfied by a handler that ignores the
    // tag: this fixture is `images-to-pdf-portrait.jpg` with nothing changed but an APP1 segment declaring orientation 6
    // ("rotate 90 CW"), so the page it produces has to be the *displayed* frame — 600×400 — where the same pixels
    // without the tag give 400×600.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-exif-6.jpg'],
    expectPages: 1,
    expectPageSize: { widthPt: 600, heightPt: 400 },
    expectWarnings: ['EXIF_ORIENTATION_APPLIED', 'PAGE_SIZE_FOLLOWS_IMAGE'],
  },
  {
    // The control: byte-identical pixels, no orientation tag. Without it, "the page is 600×400" would be a statement
    // about this handler's defaults rather than about the tag it was handed.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-portrait.jpg'],
    expectPages: 1,
    expectPageSize: { widthPt: 400, heightPt: 600 },
    expectAbsentWarnings: ['EXIF_ORIENTATION_APPLIED'],
  },
  {
    // One page per TIFF frame **in frame order** — three frames of three different sizes, so the assertion is about the
    // sequence of page boxes and not about how many pages there are. Before pass 5 the assembly asked qpdf for page 1 of
    // each per-image document, so a three-frame scan arrived as one page (defect 140).
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-frames.tiff'],
    expectPages: 3,
    expectMediaBoxes: [
      { widthPt: 120, heightPt: 90 },
      { widthPt: 90, heightPt: 120 },
      { widthPt: 60, heightPt: 60 },
    ],
    expectWarnings: ['PAGE_SIZE_FOLLOWS_IMAGE'],
  },
  {
    // The single-frame twin: TIFF as an input format, without any dependency on the frame walk.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-single.tiff'],
    expectPages: 1,
    expectMediaBoxes: [{ widthPt: 100, heightPt: 100 }],
  },
  {
    // Transparency, in the mode that keeps it: `fit` gives a page the size of the image, and the image is a disc on a
    // fully transparent 400×400 canvas, so the middle must carry ink and the corner must be blank. That corner is what
    // says the alpha survived — a flattened page would be white or black there, and only the render can see it.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['watermark-logo.png'],
    expectPages: 1,
    expectPageSize: { widthPt: 400, heightPt: 400 },
    expectInkRegion: ['1,140,140,120,120'],
    expectBlankRegion: ['1,4,4,24,24'],
    expectAbsentWarnings: ['ALPHA_FLATTENED'],
  },
  {
    // The same image on a fixed page box, where the alpha is composited away — and the case asserts *onto what*: the
    // blank corner has to stay blank, which fails if the transparency was flattened onto black (`inkShare` measures
    // darkness, so a black corner is ink). This is the pair `ALPHA_FLATTENED` needed: an unconditional sentence about
    // alpha would pass on a handler that always flattens and one that never does.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['watermark-logo.png'],
    options: { pageSize: 'a4', fit: 'contain' },
    expectPages: 1,
    expectPageSize: { widthPt: 595, heightPt: 842 },
    expectWarnings: ['ALPHA_FLATTENED', 'IMAGE_UPSCALED'],
    expectInkRegion: ['1,200,300,120,120'],
    expectBlankRegion: ['1,10,140,30,30'],
  },
  {
    // The HEIC **policy**, which is not a statement about this file at all: the tenant forbids transcoding, so the answer
    // is a refusal before an engine is asked to look at the image. The message is asserted because the code cannot carry
    // the distinction — the case below reports the same code for the opposite reason.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-heic-branded.heic'],
    options: { heicFallback: 'reject' },
    expectError: 'UNSUPPORTED_CONTENT',
    expectErrorMessage: 'reject them rather than transcode',
  },
  {
    // The default policy on a HEIC this installation cannot decode: the job fails with a sentence about the file rather
    // than delivering a blank page, which is the promise §2 of the document makes about a missing delegate.
    tool: 'images-to-pdf',
    pool: 'light',
    files: ['images-to-pdf-heic-branded.heic'],
    expectError: 'UNSUPPORTED_CONTENT',
    expectErrorMessage: 'could not be decoded',
  },
  {
    // Compression must not cost pages: the check is that all four pages of the fixture survive the rewrite.
    tool: 'compress',
    pool: 'light',
    files: ['compress-text-a4.pdf'],
    expectPages: 4,
  },
  {
    // The stamp has to be real page content: the harness reads the output with `pdftotext`, so a number drawn as
    // pixels — the obvious way to do this, and the way that makes it unsearchable — fails here.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'page-n-of-total', position: 'bottom-center' },
    expectPages: 6,
    expectText: 'Page 6 of 6',
  },
  {
    // Two facts in one case: only pages 2–4 are stamped (so page 1's number must be *absent*), and numbering from 3
    // across three pages ends at 5, so `{total}` is the last number shown rather than the count of stamps.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'page-n-of-total', pages: ['2-4'], startAt: 3, position: 'top-right' },
    expectPages: 6,
    expectText: 'Page 5 of 5',
    expectAbsentText: 'Page 2 of 5',
  },
  {
    // `countFrom` — the option `12-…` §4 spends a paragraph on and nothing read until pass 43. The third page of the
    // document displays "1" and `{total}` is the last number shown, so a twelve-page document with a cover and a
    // contents page ends at "10 of 10". Both halves travel in the metrics: the page the sequence starts at, and how
    // many pages were stamped, which is what page 1's *absence* is measured by in the twin below.
    tool: 'page-numbers',
    pool: 'light',
    files: ['cover-toc-body-a4.pdf'],
    options: { format: 'n-of-total', countFrom: 3, startAt: 1 },
    expectPages: 12,
    expectText: '10 of 10',
    expectMetrics: { pagesStamped: 10, firstStampedPage: 3, displayBase: 3, countFrom: 3, lastNumber: 10 },
  },
  {
    // The same document numbered from page one: the control for the case above, and the reason its numbers mean
    // something. Twelve stamps, and the last one says "12 of 12" — a handler that ignored `countFrom` produces
    // exactly this output for the `countFrom` case, which is why this is the pair rather than a second success.
    tool: 'page-numbers',
    pool: 'light',
    files: ['cover-toc-body-a4.pdf'],
    options: { format: 'n-of-total' },
    expectPages: 12,
    expectText: '12 of 12',
    expectMetrics: { pagesStamped: 12, firstStampedPage: 1, countFrom: null, lastNumber: 12 },
  },
  {
    // `skipFirstPage`, proved by counterfactual the way the header-footer case is: with it "Page 1 of 6" cannot
    // appear anywhere while the *last* page's number must — and the last number is 5, not 6, because `{total}` is the
    // last number shown and page 1 is not part of the sequence (the same rule `countFrom` states). The fixture's own
    // body says "page 1 of 6" in lower case, so the capital-P form can only have come from a stamp.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'page-n-of-total', skipFirstPage: true },
    expectPages: 6,
    expectText: 'Page 5 of 5',
    expectAbsentText: 'Page 1 of 6',
    expectMetrics: { pagesStamped: 5, firstStampedPage: 2, displayBase: 2, skipFirstPage: true },
  },
  {
    // The colour reaches the engine, asserted from the file rather than from the option: `#ffffff` is written as
    // `1 1 1 rg`, which is exact in any quantisation (a grey like the default is not — Ghostscript rounds it to
    // 1/256 steps, so pinning `#333333` would pin the engine rather than the option). The default is asserted
    // *absent* in the twin below, which is what keeps this from being a statement about white existing somewhere.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'n', color: '#ffffff' },
    expectPages: 6,
    expectBytes: ['1 1 1 rg'],
    expectMetrics: { color: '#ffffff' },
  },
  {
    // The control for the case above: the default colour, which is not white, on the same fixture.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'n' },
    expectPages: 6,
    expectAbsentBytes: ['1 1 1 rg'],
    expectMetrics: { color: '#333333' },
  },
  {
    // Bates numbering replaces the format (`12-…` §2): `PREFIX000142SUFFIX` from the first stamped page, six digits
    // wide. The *last* page's number is the assertion — it is the one that proves the sequence advanced rather than
    // the same string being stamped six times — and the format's own words are asserted absent, because "overrides
    // `format`" is the rule.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { bates: { prefix: 'INV', digits: 6, startAt: 142 } },
    expectPages: 6,
    expectText: 'INV000147',
    expectAbsentText: 'Page 1 of 6',
    expectMetrics: { numbering: 'bates', firstNumber: 142, lastNumber: 147 },
  },
  {
    // `digits` is a **minimum** width, not a truncation: a run that starts at 999 with three digits passes 1000, and
    // the number must get wider rather than wrap. A Bates number that repeats is a correctness problem in a
    // discovery set, so the alternative — `slice(-digits)` — is what this case exists to refuse.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { bates: { prefix: 'INV', digits: 3, startAt: 999 } },
    expectPages: 6,
    expectText: 'INV1004',
    expectMetrics: { numbering: 'bates', firstNumber: 999, lastNumber: 1004 },
  },
  {
    // A document that **arrives numbered**: four pages carrying "Page 1 of 40" in the bottom-centre band, which is the
    // doubled-numbering defect `12-…` §1 promises a warning for. The metrics carry what the probe read, so the warning
    // is a statement about this page rather than about the probe having run.
    //
    // The stamp is asserted from the output's own objects rather than with `--expect-text`, and the fixture is why: the
    // new stamp lands on the printed number, and `pdftotext` then reads the two overlapping runs interleaved ("Page 1
    // of 404") — the overlap is the defect the warning is about, and it is unreadable on purpose. "Page 4 of 4" can
    // only have been written by this job: every page of the fixture says "Page 1 of 40".
    tool: 'page-numbers',
    pool: 'light',
    files: ['numbered-invoices-a4.pdf'],
    options: { format: 'page-n-of-total' },
    expectPages: 4,
    expectBytes: ['Page 4 of 4'],
    expectWarnings: ['NUMBERING_ALREADY_PRESENT'],
    expectMetrics: { existingNumbering: 'Page 1 of 40' },
  },
  {
    // The control: a document with no printed number in that band — whose body *does* say "page 1 of 6", at the top
    // of the page, outside the band a bottom stamp occupies. Without this pair the warning could pass by firing on
    // any document whose text mentions a page number at all, which every page of every fixture does.
    tool: 'page-numbers',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { format: 'page-n-of-total' },
    expectPages: 6,
    expectAbsentWarnings: ['NUMBERING_ALREADY_PRESENT'],
    expectMetrics: { existingNumbering: null },
  },
  {
    // A text watermark, and the `{page}`/`{total}` variables with it: the stamp has to be real page content (the
    // harness reads it with `pdftotext`), and the page count must survive being decorated.
    //
    // Unrotated *explicitly*, because the option default is −45°: a rotated stamp is still extractable text, but
    // `pdftotext` returns rotated glyph runs as fragments in reverse order (`AL|TI|EN|D…` for `CONFIDENTIAL`), so a
    // substring check on a rotated watermark would be testing the extractor's line ordering rather than the product.
    // Rotation gets its own case below.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'CONFIDENTIAL {page} of {total}', opacity: 0.25, rotation: 0 },
    expectPages: 6,
    expectText: 'CONFIDENTIAL 6 of 6',
    // The three known variables are the *only* ones this template names, so the absence of both warnings is part of
    // the case: an implementation that warned unconditionally would otherwise look identical here.
    expectAbsentWarnings: ['UNKNOWN_VARIABLE', 'IMAGE_LARGE'],
    // The token list is the text branch's own metric, so the *empty* list is what says the warning above is about this
    // template rather than raised by a handler that never looked. The image branch's metrics are asserted in the image
    // cases — a text stamp has no image to resize.
    expectMetrics: { unresolvedVariables: [] },
  },
  {
    // `skipFirstPage` is the page selection asked the other way round, and the two numbers are what make it checkable:
    // `{total}` still counts the whole document (6) while `pagesStamped` counts what was drawn (5). An implementation
    // that dropped page one from the *document* rather than from the *selection* would print "MARK 5/5" and fail on
    // both, and one that kept the flag in the schema and ignored it fails on the absence of "MARK 1/6".
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'MARK {page}/{total}', rotation: 0, skipFirstPage: true },
    expectPages: 6,
    expectText: 'MARK 6/6',
    expectAbsentText: 'MARK 1/6',
    expectMetrics: { pagesStamped: 5, firstStampedPage: 2, skipFirstPage: true },
  },
  {
    // A token this build cannot fill. Two halves, and the document's own §3 example is written with `{user}`: the
    // token has to survive in the output *literally* (a stamp that silently lost a word is worse than one carrying a
    // visible placeholder), and the job has to say which token it could not resolve, so a typo is not discovered on
    // 400 invoices. The metric is what makes the warning checkable rather than merely present.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'CONFIDENTIAL {user}', rotation: 0 },
    expectPages: 6,
    expectText: '{user}',
    expectWarnings: ['UNKNOWN_VARIABLE'],
    expectMetrics: { unresolvedVariables: ['user'] },
  },
  {
    // The page selection, *proved* rather than assumed: `{page}` makes the stamp page-specific, so "DRAFT 1" can only
    // appear in the output if the first page was stamped after all. This is the case that would fail if `pages` were
    // quietly ignored — which is why it is a single unrotated stamp, not a tiled one (see below).
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'DRAFT {page}', pages: ['2-4'], rotation: 0 },
    expectPages: 6,
    expectText: 'DRAFT 4',
    expectAbsentText: 'DRAFT 1',
  },
  {
    // Tiled and under-content: the stamp is laid out on a grid and merged with `add_underlay` instead of
    // `add_overlay` — the two paths that differ structurally from the case above. Only the page count is asserted,
    // and deliberately: a grid of nine overlapping stamps comes out of `pdftotext` as fragments in glyph order
    // (`T|AF|R|D`, `2|2|2`), so any substring check here would be testing the extractor's line reconstruction. The
    // check that matters — that the document survives being decorated twice over — is the page count.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'DRAFT {page}', position: 'tile', pages: ['2-4'], underContent: true },
    expectPages: 6,
  },
  {
    // The tile grid itself, which the tiled case above cannot see: a 50 % gap is `round(100 / 50)` = two per axis, so
    // the page must carry exactly four stamps — and one overlay page per stamped page, which is what makes a tiled
    // watermark six Ghostscript pages rather than one. Only the arithmetic is asserted, because a grid of overlapping
    // stamps extracts as fragments in glyph order.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'DRAFT', position: 'tile', tile: { x: 50, y: 50 }, rotation: 0 },
    expectPages: 6,
    expectMetrics: { stampsPerPage: 4, overlayPages: 6, pagesStamped: 6 },
  },
  {
    // The other end of the range, at the boundary: 10 % is the tightest gap the schema allows and therefore the ceiling
    // of the stamp count (100 per page), which is the number §6 publishes and the reason the gap is bounded at all. The
    // four stamps of the case above and these hundred are the same rule read at both ends.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'DRAFT', position: 'tile', tile: { x: 10, y: 10 }, rotation: 0 },
    expectPages: 6,
    expectMetrics: { stampsPerPage: 100, overlayPages: 6 },
  },
  {
    // A tile gap below the published 10 % is refused by name, and the refusal is worth a case because the number it
    // stands for is a *cost*: the gap is a stamp count (`round(100 / gap)` per axis), so 5 % is 400 placements on every
    // page and 1 % is 10 000. Nothing else in the suite can see that — every other tiled case uses a sane gap.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'DRAFT', position: 'tile', tile: { x: 5, y: 5 } },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // Rotation: a PostScript `gsave`/`translate`/`rotate`/`grestore` around the stamp, pivoting on its centre rather
    // than its baseline. Structural for the same reason as the tiled case — rotated glyph runs extract as reversed
    // fragments — so this proves the transform does not break the document, and the pivot itself is pinned by the
    // overlay unit tests instead.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'text', text: 'BACKGROUND', rotation: -45, opacity: 0.15, underContent: true },
    expectPages: 6,
  },
  {
    // The image kind, end to end: the option names an upload, the API pulls it into the job as an attachment, and the
    // output must carry it as a soft-masked image — a logo that lost its alpha paints a white box over the page.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'image', scalePercent: 40, opacity: 0.5, rotation: 0, position: 'center' },
    auxiliary: { imageFileId: 'watermark-logo.png' },
    expectPages: 6,
    expectSmaskImages: 1,
    // A 400 px logo is under both caps, so "not resized" is asserted as a metric rather than left to the absence of a
    // warning — which the oversized case below also produces by *not running the check at all*.
    expectAbsentWarnings: ['IMAGE_LARGE'],
    expectMetrics: { imageSourceWidth: 400, imageSourceHeight: 400, imageWidth: 400, imageDownsampled: false },
  },
  {
    // The downsample cap (`11-WATERMARK.md` §6), with the file's dimensions and the drawn ones both asserted: the
    // upload is 4 200 px wide, the stamp is placed from a 4 000 px bitmap, and the job reports the reduction. A build
    // that skipped the resize fails the width, one that resized silently fails the warning, and one that wrote the
    // source size into the metric fails `imageWidth`.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'image', scalePercent: 40, rotation: 0, position: 'center' },
    auxiliary: { imageFileId: 'watermark-logo-large.png' },
    expectPages: 6,
    expectWarnings: ['IMAGE_LARGE'],
    expectMetrics: { imageWidth: 4000, imageHeight: 571, imageSourceWidth: 4200, imageDownsampled: true },
  },
  {
    // The refusal cap, measured against the **source**: 8 200 px is refused even though the builder above would have
    // shrunk it to 4 000. That distinction is the whole case — an implementation that checks the *placed* dimensions
    // passes every other assertion in this file while accepting a document-breaking bitmap.
    tool: 'watermark',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'image', scalePercent: 40, rotation: 0, position: 'center' },
    auxiliary: { imageFileId: 'watermark-logo-huge.png' },
    expectError: 'VALIDATION_ERROR',
    expectErrorMessage: '8200×8',
  },
  {
    // The header band, with the page variables in it and the rule on: the band has to be real page content (the
    // harness reads it back with `pdftotext`), the variables have to resolve per page, and decorating the document
    // must not change how many pages it has. The footer band is the case below; this one is deliberately the header
    // so that a handler wiring only `bottom-*` anchors fails here.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { header: { center: 'Rumindium page {page} of {total}', rule: true }, marginMm: 12 },
    expectPages: 6,
    expectText: 'Rumindium page 6 of 6',
  },
  {
    // The footer band and the page selection, proved by counterfactual the same way the watermark case is: with
    // `skipFirstPage` the first page must carry nothing, so "Page 1 of 6" cannot appear anywhere while "Page 2 of
    // 6" must. A handler that ignored the option would stamp page 1 and fail the absence check — and because the
    // fixture's own body text says "page 1 of 6" in lowercase, the check cannot pass by accident.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: {
      footer: { left: 'Confidential', right: 'Page {page} of {total}', rule: true },
      skipFirstPage: true,
    },
    expectPages: 6,
    expectText: 'Page 2 of 6',
    expectAbsentText: 'Page 1 of 6',
  },
  {
    // The logo path: the same upload plumbing as the image watermark, but sized by height and pinned to the left of
    // the header band. Asserted as a soft-masked image for the same reason — a logo that lost its alpha paints a
    // white box across the header, which neither the page count nor `pdftotext` would notice. Two overlay passes
    // run here (text, then the bitmap), so the page count is asserted too.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { header: { center: 'Rumindium' }, logoHeightMm: 8 },
    auxiliary: { logoFileId: 'watermark-logo.png' },
    expectPages: 6,
    expectSmaskImages: 1,
  },
  {
    // An unknown variable must survive verbatim rather than vanish: `{custmer}` is a typo the user should see in the
    // output, not silently blank, and it raises `UNKNOWN_VARIABLE` (checked below as a warning, not a failure).
    // `{user}` is deliberately unsupported too — it needs a session this worker does not have — so a build that
    // quietly dropped unresolved braces would fail this case.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { header: { center: '{custmer}' } },
    expectPages: 6,
    expectText: '{custmer}',
  },
  {
    // `{filename}` is the one template variable whose value cannot be invented: the fixture's stem appears nowhere in
    // its own text (which reads "Page operations fixture"), so a handler that resolved it to the document title, to a
    // date or to an empty string fails here. The zone is otherwise the ordinary numbered one, so the case also proves
    // the substitution happens per zone rather than per band. `{date}`/`{time}`/`{datetime}` stay uncovered on
    // purpose: asserting a clock is how a suite starts failing at midnight.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { footer: { left: '{filename}', right: 'Page {page} of {total}' } },
    expectPages: 6,
    expectText: 'pages-six-a4',
  },
  {
    // `differentFirstPage`: page one carries the override band and **not** the document's own one, which is what
    // "replaces, does not merge" means. Three assertions, each catching a different regression: the override's text is
    // present (a handler that never draws it fails), "Body page 1" is absent (a handler that ignored the option
    // fails), and the ordinary band is still there on a later page (a handler that applied the override to every page
    // fails). The last one is read from the output's own objects rather than from the job's metrics — the band is real
    // page content, and a metric is a claim about the handler that wrote it.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: {
      header: { center: 'Body page {page}' },
      differentFirstPage: { header: { left: 'Cover sheet - internal use' } },
    },
    expectPages: 6,
    expectText: 'Cover sheet - internal use',
    expectAbsentText: 'Body page 1',
    expectBytes: ['Body page 6'],
    expectMetrics: { differentFirstPage: true },
  },
  {
    // The control: the same band without the override, so "Body page 1" is exactly what the case above would have
    // printed had the option been ignored. Without this, the other case's absence assertion could pass against a band
    // that never draws page one for an unrelated reason.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { header: { center: 'Body page {page}' } },
    expectPages: 6,
    expectText: 'Body page 1',
    expectMetrics: { differentFirstPage: false },
  },
  {
    // A band left out of the override is a band page one does not carry — the reason `differentFirstPage` replaces
    // rather than merges, and the shape a cover sheet needs. The document has a footer on every page and the override
    // names only a header, so page one loses its footer: "Page 1 of 6" cannot appear anywhere, while the ordinary
    // header's own page variable still prints. (That absence is also what `skipFirstPage` would produce — which is
    // why this case exists for the *documented meaning* of the option rather than as a second proof of the mechanism.)
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: {
      footer: { left: 'Confidential', right: 'Page {page} of {total}' },
      header: { center: 'Body page {page}' },
      differentFirstPage: { header: { center: 'Cover sheet' } },
    },
    expectPages: 6,
    expectText: 'Cover sheet',
    expectAbsentText: 'Page 1 of 6',
    expectMetrics: { differentFirstPage: true },
  },
  {
    // `logoOpacity`: the attenuation has to reach the file, and it has to be the logo's alone. The state is asserted by
    // name (`/GSwm` is the merge module's own ExtGState) because "some transparency exists" is also what a
    // half-transparent PNG's own `/SMask` would say.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { header: { center: 'Rumindium' }, logoHeightMm: 8, logoOpacity: 0.4 },
    auxiliary: { logoFileId: 'watermark-logo.png' },
    expectPages: 6,
    expectBytes: ['/GSwm'],
    expectSmaskImages: 1,
    expectMetrics: { 'logo.opacity': 0.4 },
  },
  {
    // The control: a solid logo writes no constant-alpha state at all, so the case above is a statement about the
    // *option* rather than about the pipeline always emitting an ExtGState. The `/SMask` is asserted here too — the
    // logo's own alpha is what must survive an opacity of 1.
    tool: 'header-footer',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { header: { center: 'Rumindium' }, logoHeightMm: 8 },
    auxiliary: { logoFileId: 'watermark-logo.png' },
    expectPages: 6,
    expectAbsentBytes: ['/GSwm'],
    expectSmaskImages: 1,
    expectMetrics: { 'logo.opacity': 1 },
  },

  // ── office ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    // LibreOffice, not a text extraction: the fixture is a plain-text file and a CSV precisely because they take
    // the same conversion path a .docx does, so this proves the office image works without a DOCX writer here.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-report.txt', 'office-to-pdf-table.csv'],
    expectText: 'LibreOffice',
  },
  {
    // Macros are refused, and the refusal has to happen for the *document* rather than for its name: upload typing
    // reads magic bytes, a `.xlsm` and a `.xlsx` are the same ZIP there, so a MIME set could never have caught this
    // (`workers/shared/src/guards/macro-carriers.ts`). The fixture carries a `vbaProject.bin`, the part that makes a
    // workbook macro-enabled in the format's own terms.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-macro.xlsm'],
    expectError: 'UNSUPPORTED_CONTENT',
  },
  {
    // The same claim in ODF, so the guard is not proved for one container format only. Note what is *not* asserted,
    // and it is not an omission: nothing here claims a macro would have run, because the engine *can* run one
    // (measured — `bun run test:isolation` executes a profile macro), and a case asserting "no macro ran" would be
    // asserting a consequence of LibreOffice's configuration rather than of this service. The refusal is the
    // product's promise, and it is the only half a code change can silently remove (`falsify` claim `macro-refusal`).
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-macro.odt'],
    expectError: 'UNSUPPORTED_CONTENT',
  },

  {
    // `fitToPage: true` (the default) asks the engine for **one page per sheet** — `SinglePageSheets`, measured: the
    // fixture's three sheets are 150 rows tall, so at the engine's own scale each is three pages and the workbook is
    // nine. Three is the assertion, and the twin below (nine) is what makes it a statement about the option: a case
    // that only ever saw three pages would pass for a handler that never let anything paginate.
    //
    // The option used to set this property to `false` when it was `true` — the engine's own default — so it did
    // nothing in either direction and this case is the first thing that could tell.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-sheets.xlsx'],
    options: { fitToPage: true },
    expectPages: 3,
    expectText: 'ALPHA SHEET MARKER',
    expectMetrics: { outputFiles: 1, outputPages: 3 },
  },
  {
    // The same workbook with the option off: every sheet paginates naturally, which is nine pages — three per sheet,
    // in sheet order. The page size is deliberately not asserted — it is the engine's layout of this fixture's cells,
    // not a number this product promises — while the page *count* is the option's whole effect.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-sheets.xlsx'],
    options: { fitToPage: false },
    expectPages: 9,
  },
  {
    // `pageRange` is a **page** range, and this case is the measurement that settled it. The fixture's nine pages are
    // three per sheet in sheet order, so page 4 is sheet 2's first page: the assertion is that Beta's marker is there
    // *and* its neighbours' are not. A selection that silently kept the first sheet, or that kept everything, passes
    // a page count and fails here.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-sheets.xlsx'],
    options: { fitToPage: false, pageRange: '4' },
    expectPages: 1,
    expectText: 'BETA SHEET MARKER',
    expectAbsentText: 'ALPHA SHEET MARKER',
  },
  {
    // A sheet *name* is not a page range. Measured: handed `PageRange: 'Beta'`, LibreOffice writes **no file at all**
    // and prints nothing about why, so without the handler's own grammar check this request would be reported as
    // `CONVERSION_FAILED` — "LibreOffice produced no PDF output" — with no mention of the option that caused it.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-sheets.xlsx'],
    options: { pageRange: 'Beta' },
    expectError: 'VALIDATION_ERROR',
    expectErrorMessage: 'not a page range',
  },
  {
    // `slideNotes` — the option that turns a deck into its slides *and* their notes pages. Measured: the fixture is
    // two slides and one page of notes, and `ExportNotesPages` makes it four pages with the notes text on the third.
    // The handler used to send `ExportNotes`, which is not a property of this filter and was ignored in silence.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-notes.odp'],
    options: { slideNotes: true },
    expectPages: 4,
    expectText: 'ODP SPEAKER NOTES MARKER',
  },
  {
    // The negative control for the case above, and the reason its own assertion means anything: the same deck without
    // the option is two slides with no notes page. Without this, "the notes text is in the output" would pass for a
    // handler that always exported notes pages, i.e. for an option that does nothing.
    tool: 'office-to-pdf',
    pool: 'office',
    files: ['office-to-pdf-notes.odp'],
    expectPages: 2,
    expectAbsentText: 'ODP SPEAKER NOTES MARKER',
  },

  {
    // `html-to-pdf` on a plain file: no assets, so a failure here is the conversion. The page size is asserted as
    // well as the text, because the geometry is the option LibreOffice's export filter cannot carry — it is applied
    // by injecting an `@page` rule into the HTML, and a case that only checked the text would pass for a handler that
    // quietly returned A4 portrait for a landscape request.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-invoice.html'],
    options: { pageSize: 'a4', landscape: true, marginMm: 12 },
    expectText: 'HTML PDF FIXTURE MARKER',
    expectPageSize: { widthPt: 841.89, heightPt: 595.28 },
  },
  {
    // A portrait request on the same file, so the orientation is proved in both directions rather than once: the
    // landscape case alone would also pass for a handler that always produced landscape.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-invoice.html'],
    options: { pageSize: 'a3', marginMm: 20 },
    expectText: 'HTML PDF FIXTURE MARKER',
    expectPageSize: { widthPt: 841.89, heightPt: 1190.55 },
  },
  {
    // An option this engine cannot honour, asserted through the warning that says so. Without this case the honest
    // warning is indistinguishable from dead code, and "remove the option that does nothing" becomes the tempting
    // fix — which would leave the flag in the schema, accepted, and silent.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-invoice.html'],
    options: { printBackground: false },
    expectText: 'HTML PDF FIXTURE MARKER',
    expectWarnings: ['BACKGROUNDS_NOT_SUPPRESSED'],
  },
  {
    // The bundle: a zip whose `index.html` references `assets/logo.png` by a *relative* path, so the image has to be
    // extracted with its directory intact and then found by the engine. A flattened extraction, or one that dropped
    // the assets, leaves no image object — which is why the check is an image count and not a text search: the text
    // would be there either way.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-bundle.zip'],
    expectText: 'HTML BUNDLE MARKER',
    expectImages: 1,
  },
  {
    // The document names its image by URL, which the renderer *would* fetch — measured, not assumed — and the product
    // never fetches (`0-SECURITY.md` §7). So this must be a refusal naming the reference rather than a conversion with
    // a silent hole in it. The case above is its negative control: a relative asset beside the page still converts.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-remote-asset.html'],
    expectError: 'REMOTE_RESOURCES_BLOCKED',
  },
  {
    // The same vector with no tag to catch it: the reference lives in a stylesheet, which the engine resolves while
    // drawing. One case would have left this half of the guard unproven, and it is the half a website export hits.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-remote-css.html'],
    expectError: 'REMOTE_RESOURCES_BLOCKED',
  },
  {
    // The reference appears only *after* extraction, in a stylesheet the bundle brings along. A scan limited to the
    // entry document converts this bundle and fetches the import while rendering it — the hole this case closes.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-bundle-remote-css.zip'],
    expectError: 'REMOTE_RESOURCES_BLOCKED',
  },
  {
    // A URI *scheme* the engine resolves and executes (`macro:///…`, measured in `test:isolation`), named where an
    // image would be. The guard refuses any scheme rather than the two it was written for, and this is the case that
    // says so end to end.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-macro-uri.html'],
    expectError: 'REMOTE_RESOURCES_BLOCKED',
  },
  {
    // The HTML path's macro question in the form HTML can carry: a script. It must **convert** — a page with a script
    // tag, a `data:` image and a hyperlink is ordinary HTML, and a guard that refused it would be worse than none.
    // That the script did not *run* is not visible here (no case can see a request that never happened); it is
    // measured with a loopback listener in `test:isolation`, and both halves are needed.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-script.html'],
    expectText: 'HTML SCRIPT FIXTURE MARKER',
  },
  {
    // A bundle past the **entry-count** bound (`docs/07-OFFICE-TO-PDF.md` §6, 2 000 members): 2 001 files, which is
    // what a site export looks like rather than an attack, refused before anything is written. The refusal has to
    // name the number it read, because "the bundle could not be extracted" is also what a corrupt archive produces
    // and only one of the two tells the caller to send fewer files.
    tool: 'html-to-pdf',
    pool: 'office',
    files: ['html-to-pdf-bundle-too-many-entries.zip'],
    expectError: 'UNSUPPORTED_CONTENT',
    expectErrorMessage: 'limit is 2000',
  },

  // ── heavy ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    // Routed to `pdf-heavy` by `aboveFiles: 20`; 42 pages is the arithmetic that proves all 21 inputs arrived.
    tool: 'merge',
    pool: 'heavy',
    files: ESCALATION_FILES,
    expectPages: 42,
  },
  {
    // The one case whose subject is a **routing decision** rather than a document, and the first of its kind: 320
    // pages is past `compress`'s 300-page threshold (`04-COMPRESS.md` §6), so the job has to be accepted on
    // `pdf-heavy` and run with that pool's 420 s budget.
    //
    // Two assertions because the catalog's rule is applied in two places, and they are not the same claim. `expectQueue`
    // reads the `POST /jobs` response — the API routing on the size the *upload claimed* — while `budgetSeconds` is the
    // budget the worker really ran with, and the worker re-routes on the sizes that turned out to be true. A job
    // accepted on `light` would therefore still end on `heavy` with 420 s, which is why the acceptance is the half that
    // can fail here; the budget is what makes the pair add up to "the first decision was right *and* it stuck".
    //
    // `plan: 'pro'` is for the page limit rather than the tool gate: 320 pages sits inside Pro's 500 and outside Free's
    // 200, so without it the job would be refused `PAGE_LIMIT_EXCEEDED` before any routing could be observed.
    tool: 'compress',
    pool: 'heavy',
    plan: 'pro',
    files: ['compress-large-320p.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectQueue: 'pdf-heavy',
    expectPages: 320,
    expectMetrics: { budgetSeconds: 420 },
  },
  {
    // The **other** half of that rule: 110 MB and two pages, so nothing about this job's size is a page count and the
    // only threshold it can cross is `aboveBytes`. The twin above proves pages route; this proves bytes do, which had
    // no case at all until now — the boundary every large file users actually hit was configuration, and configuration
    // that had never fired on a default stack either (the upload ceiling `MAX_FILE_SIZE_MB` defaults to 50 MB, so
    // nothing above the threshold could even be uploaded; the CI job raises it, and `0-TESTING.md` §4 says so).
    //
    // `plan: 'pro'` for the ceilings rather than for a tool gate: the job needs a plan that can *hold* a file this
    // size, and Pro is 300 MB per file / 600 MB per job. Worth knowing which plans cannot: **Free is 100 MB per file
    // — exactly the threshold** — so on Free the byte axis is unreachable by construction, and the deployment's own
    // `MAX_FILE_SIZE_MB` (50 MB by default) puts it out of reach on *every* plan until an operator raises it. That is
    // why the CI job sets it, and why `0-TESTING.md` §4 records the requirement beside the fixture.
    //
    // `expectMetricsOver` is the premise, not a decoration: the case is only about the byte threshold if the job really
    // received more than 100 MB, and the number belongs to the fixture (see `fixtures:large`), so it is stated as a
    // threshold here rather than copied in. `expectPages: 2` is what makes it a *byte* case — a fixture that had grown
    // pages would cross the other threshold and pass this one for the wrong reason.
    tool: 'compress',
    pool: 'heavy',
    plan: 'pro',
    files: ['compress-over-100mb.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectQueue: 'pdf-heavy',
    expectPages: 2,
    expectMetricsOver: { inputBytes: 100 * 1024 * 1024 },
    expectMetrics: { budgetSeconds: 420 },
    // The stack half of the premise, declared rather than assumed: the default `MAX_FILE_SIZE_MB` is 50 MB, so on an
    // unconfigured deployment the API refuses this fixture long before any routing happens — correctly, and as a gap
    // with the setting named rather than as a failing case.
    requireUploadCeilingMb: 100,
  },
  {
    // The **worker's** half of the same rule, and the only shape where the two routing decisions disagree: a document
    // the API's byte scan cannot size at all.
    //
    // `apps/api/src/shared/pdf-probe.ts` reads two windows of the file — its first 4 KB and its last 512 KB — and
    // `compress-hidden-pages-620p.pdf` is built so that neither contains a page marker: 620 pages push the `/Count`
    // past the first window, and 600 KB of trailing padding pushes every page object before the last one. The scan
    // answers `null`, so the API has no page count to route on and files the job on **`pdf-light`** (asserted, and
    // asserted *why*: `claimedInputPages` is 0, which is the scan's answer and not a page count).
    //
    // 620 real pages is more than twice the 300-page threshold, so the worker's own read of the file has to move it —
    // `--expect-final-queue pdf-heavy` and the 420 s budget are that move. Before this case existed the worker
    // re-read the *payload's* number instead of the file's (defect 153), and this job ran on `pdf-light` with the
    // light pool's 300 s budget: the documented re-check had never happened once.
    //
    // The metrics are the evidence rather than a decoration: `claimedInputPages: 0` and `measuredInputPages: 620` are
    // the two numbers step 5 compared, and they are what makes this case about a *measurement* instead of about a
    // fixture name. `plan: 'pro'` because 620 pages is inside Pro's 2000 and outside Free's 500 — which is also the
    // number that exposes a second hole this pass found and did not close: while the count is unknown the API cannot
    // check the plan limit either (defect 154, `04-COMPRESS.md` §6).
    tool: 'compress',
    pool: 'heavy',
    plan: 'pro',
    files: ['compress-hidden-pages-620p.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectQueue: 'pdf-light',
    expectFinalQueue: 'pdf-heavy',
    expectPages: 620,
    expectMetrics: { claimedInputPages: 0, measuredInputPages: 620, budgetSeconds: 420 },
  },
  {
    // The plan's *ceiling*, on the same fixture, and the half of defect 154 that could not be checked before the job
    // payload carried the number: 620 pages the byte scan cannot size, so the API has no count to compare against
    // `plan.maxPages` and accepts the job. Under `--plan free` (500 pages) the worker's own read is the only thing that
    // can refuse it, and that refusal is the case.
    //
    // `expectQueue: 'pdf-light'` is the **premise** rather than routing detail: it says the API took a job it could not
    // size, which is the entire reason the ceiling has to travel with the job. The refusal comes *before* the escalation
    // check (asserted by the job's own record still naming `pdf-light`), because a job too big for its plan is not a job
    // that belongs on a bigger pool.
    //
    // Both the code and the sentence are asserted. The sentence is what the user reads, and the two numbers in it are
    // the two halves of the claim: the page count the worker measured and the ceiling the API resolved.
    tool: 'compress',
    pool: 'heavy',
    plan: 'free',
    files: ['compress-hidden-pages-620p.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectQueue: 'pdf-light',
    expectError: 'PAGE_LIMIT_EXCEEDED_JOB',
    expectErrorMessage: "above the free plan's limit of 500 pages",
  },
  {
    // Reflow is defined by three absences: no absolute positioning, no `assets/` directory, and no page 1 — the
    // first is what makes it a different output from the fixed case below, the second is the page raster being
    // dropped (this fixture's only image is Poppler's picture of the page), and the last proves `pages: ['2-3']`
    // narrowed the conversion, exactly as the `pdf-to-text` case does. `index.html` is present in the same case so
    // the absences cannot pass by the archive being empty.
    //
    // The consequence worth stating: with these fixtures, `embedImages: false` in reflow has nothing to write, so it
    // is the *fixed* case that proves the `assets/` path. A fixture whose image is a real figure rather than a page
    // raster would exercise the combination, and is recorded as a gap in `0-TESTING.md`.
    tool: 'pdf-to-html',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { mode: 'reflow', pages: ['2-3'] },
    expectKind: 'zip',
    expectBytes: ['index.html', 'page 2 of 6', 'page 3 of 6'],
    expectAbsentBytes: ['position:absolute', 'assets/', 'page 1 of 6', 'data:image/png;base64'],
    expectWarnings: ['PAGE_RASTER_DROPPED'],
  },
  {
    // The same document in fixed mode, which is the mode that must *keep* the positioning — so the byte that was
    // absent above has to be present here, and the layout warning has to be there with it. A handler that ignored
    // `mode` entirely would fail one of these two cases whichever way it leaned.
    tool: 'pdf-to-html',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { mode: 'fixed', embedImages: false },
    expectKind: 'zip',
    expectBytes: ['position:absolute', 'assets/', 'page 6 of 6'],
    expectAbsentBytes: ['data:image/png;base64'],
    expectWarnings: ['LAYOUT_APPROXIMATE'],
  },
  {
    // Inlining: no `assets/` at all, and the image is in the HTML as a data URI. Paired with the case above so the
    // two spellings of the same option cannot both pass by accident.
    tool: 'pdf-to-html',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { mode: 'fixed', embedImages: true },
    expectKind: 'zip',
    expectBytes: ['data:image/png;base64', 'page 1 of 6'],
    expectAbsentBytes: ['assets/'],
  },
  {
    // The fail-fast from `docs/08-…` §5. The raster fixture has no text layer at all, so an HTML conversion could
    // only be a picture of the page — which is why this must be a refusal naming `ocr` rather than a successful job
    // with an image-only file in it.
    tool: 'pdf-to-html',
    pool: 'heavy',
    files: ['ocr-scan-eng-raster.pdf'],
    expectError: 'UNSUPPORTED_CONTENT',
  },
  {
    // The ruled path: `lattice` reads the drawn grid, so the header row and both values are cell-exact. The fixture's
    // price column is European on purpose and is asserted *unparsed* here — this case is the control for the
    // `decimalComma` case below, which is the only way to tell a parser from a pass-through.
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { tableStrategy: 'ruled' },
    expectKind: 'text',
    // Two strings rather than one row, because the price cell contains the delimiter and is therefore quoted — a
    // single-row assertion would be pinning the writer's quoting rule instead of the extraction.
    expectBytes: ['Item,Qty,Price', 'Widget', '1.234,56'],
    // And the first line has to be the table's own header, not the engine's synthetic column indices: Camelot 2
    // returns a RangeIndex, so writing `frame.columns` put a `0,1,2` line above every table. Absence is the only
    // assertion that can see that, because the file "contains the header" either way.
    expectAbsentBytes: ['0,1,2'],
  },
  {
    // The same cells with the rules off, read by alignment instead: this is what proves `stream` is a second reader
    // rather than a second name for `lattice` — that flavour finds *nothing* in this file (measured, not assumed).
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-stream-a4.pdf'],
    options: { tableStrategy: 'stream' },
    expectKind: 'text',
    expectBytes: ['Qty', 'Widget'],
  },
  {
    // `decimalComma: true` has to reach the file as a number, not as the same string it came in as. Paired with the
    // ruled case above, one of the two must fail if the option is ignored in either direction.
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { tableStrategy: 'ruled', decimalComma: true },
    expectKind: 'text',
    expectBytes: ['1234.56'],
    expectAbsentBytes: ['1.234,56'],
  },
  {
    // `docx` through pdf2docx: a layout reconstruction that also emits real Word tables. Asserted *inside* the
    // package — `word/document.xml` is deflated, so a byte search for `Widget` would find nothing even with the text
    // in the file, and the entry name is asserted too because a package without that part is not a Word document.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { target: 'docx', detectTables: true },
    expectKind: 'zip',
    expectEntries: ['word/document.xml'],
    expectArchiveText: ['<w:tbl>', 'Widget'],
    expectWarnings: ['LAYOUT_APPROXIMATE'],
  },
  {
    // The same document with `keepLayout: false`, which pdf2docx cannot express — so it routes to the paragraph
    // builder. The absence of `<w:tbl>` is what proves the route changed, which is the only visible difference
    // between two DOCX files that both contain the text.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { target: 'docx', keepLayout: false },
    expectKind: 'zip',
    expectEntries: ['word/document.xml'],
    expectArchiveText: ['Widget'],
  },
  {
    // `xlsx` is the table extractor plus openpyxl, so the evidence is the workbook's own shared strings and a cell.
    // `oneSheetPerPage` is left off, which is the branch that produces one sheet per *table*.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { target: 'xlsx' },
    expectKind: 'zip',
    expectEntries: ['xl/workbook.xml'],
    expectArchiveText: ['Widget', 'Item'],
    // The same defect as the CSV case above, one format over: with the engine's `RangeIndex` written as a row, cell
    // **A1 was the number 0** and the table only started at row 2. A1 must be the table's own first cell.
    expectAbsentArchiveText: ['<c r="A1" t="n">'],
  },
  {
    // `pptx`: one slide per page, a page image as its background, and the page's text as editable boxes. Both halves
    // are asserted because either alone is a different product: an image-only slide has no editable text, and a
    // text-only slide has lost the layout the format is for.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { target: 'pptx', pages: ['1-2'] },
    expectKind: 'zip',
    expectEntries: ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'],
    expectArchiveText: ['page 1 of 6'],
    expectWarnings: ['LAYOUT_APPROXIMATE'],
  },
  {
    // A non-contiguous selection on the one branch that can only take a range: `pdf2docx` converts a span, so `1,3`
    // becomes `1-3` and the job has to say so rather than silently returning a different document than was asked
    // for. The warning is the only visible difference, which is why it is asserted instead of the page count.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { target: 'docx', pages: ['1', '3'] },
    expectKind: 'zip',
    expectEntries: ['word/document.xml'],
    expectWarnings: ['LAYOUT_APPROXIMATE', 'SELECTION_WIDENED'],
  },
  {
    // A scan has no text to rebuild. The document names `IMAGE_ONLY_PAGES` as the *failure* here (with `ocr` as the
    // next action), rather than a job that succeeds by embedding pictures of words.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { target: 'docx' },
    expectError: 'IMAGE_ONLY_PAGES',
  },
  {
    // Semicolons: a delimiter option that never reached the writer would pass every case above, so the output is
    // searched for the separator itself.
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { tableStrategy: 'ruled', delimiter: ';' },
    expectKind: 'text',
    expectBytes: ['Item;Qty;Price'],
  },
  {
    // A document with no table at all. The six-page fixture has text and two rules per page and no grid, so this has
    // to be the typed refusal rather than an empty CSV — which is the failure mode the whole tool exists to avoid.
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    expectError: 'TABLE_NOT_FOUND',
  },
  {
    // An option the engine cannot honour, pinned by its warning. The *reason* changed once the engine was measured:
    // Camelot 2 does not consume a header at all, so the handler promotes the first row itself; the two settings then
    // differ in nothing but the name of the first line, so the job says so (`printBackground` precedent).
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-ruled-a4.pdf'],
    options: { tableStrategy: 'ruled', headerRow: false },
    expectKind: 'text',
    expectBytes: ['Item,Qty,Price'],
    expectWarnings: ['HEADER_ROW_NOT_HONOURED'],
  },

  // ── pass 8: the branches two tables on four pages separate, and the options no fixture could reach ────────
  {
    // **Two tables are two CSVs.** Every earlier case in this chapter ate a one-page, one-table document, so
    // `allTables` had nothing to choose between and `expectParts` was never anything but 1. This is the fixture the
    // option needed: five rows on page 1, three on page 3, and two pages with none.
    //
    // `PAGES_WITHOUT_TABLES` is asserted in the same case on purpose. It is the *only* warning whose meaning depends
    // on the document rather than on the settings, and it is a sentence about pages 2 and 4 — which cannot be said by
    // a document whose every page carries a table.
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-mixed-a4.pdf'],
    options: { tableStrategy: 'ruled' },
    expectKind: 'text',
    expectParts: 2,
    // The first table is read out of the primary part, the second out of part 1 — a distinction that only exists
    // because this tool writes several files. `expectBytes` alone searches the primary, so before `expectPartText` the
    // only statements this case could make about the second table were its *count* and the row total in the metrics.
    expectBytes: ['Round,Team,Score', 'Round 2,Beta,22'],
    expectPartText: [
      { index: 1, text: 'Check,Owner,Result' },
      { index: 1, text: 'Sign-off,Gamma,pass' },
    ],
    expectMetrics: { tables: 2, rows: 8 },
    expectWarnings: ['PAGES_WITHOUT_TABLES'],
  },
  {
    // **`allTables: false` keeps the *largest* table.** With one table in the document this flag was a no-op, so no
    // case could tell "kept the largest" from "kept the first" or from "ignored the flag altogether". Here the sizes
    // differ (five rows against three), and the smaller table's own words are absent from the output — the assertion a
    // `expectParts: 1` alone cannot make, because a handler that kept the wrong single table would satisfy it.
    tool: 'pdf-to-csv',
    pool: 'heavy',
    files: ['tables-mixed-a4.pdf'],
    options: { tableStrategy: 'ruled', allTables: false },
    expectKind: 'text',
    expectParts: 1,
    expectBytes: ['Round,Team,Score', 'Round 2,Beta,22'],
    expectAbsentBytes: ['Sign-off', 'Check,Owner,Result'],
    expectMetrics: { tables: 1, rows: 5 },
  },
  {
    // **`oneSheetPerPage: false` is one sheet per table, and the sheet names say which table and which page.** The
    // name is the assertion rather than a sheet count: a workbook with the right number of sheets and the wrong
    // grouping is what a handler that ignored the flag on a *fallback* document would produce, and the previous case
    // (`tables-ruled-a4.pdf`, one page, one table) could not distinguish the two branches at all — they are
    // byte-identical there, measured.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['tables-mixed-a4.pdf'],
    options: { target: 'xlsx' },
    expectKind: 'zip',
    expectEntries: ['xl/workbook.xml'],
    expectArchiveText: ['table-01-p1', 'table-02-p3'],
    expectAbsentArchiveText: ['page-1'],
    expectMetrics: { tables: 2, target: 'xlsx' },
    expectWarnings: ['LAYOUT_APPROXIMATE'],
  },
  {
    // The same document with `oneSheetPerPage: true`: one worksheet per **page** the selection covers, tables stacked
    // inside the sheet they came from. The absence of the per-table names is the load-bearing half — a handler that
    // created both namings would satisfy the presence assertions.
    //
    // What this case does *not* prove, and what the branch order means: on a document where no table is detected at
    // all, `xlsx` falls back to one text column per page and the flag changes nothing — which is why the fallback is
    // asserted by its own warning below rather than folded in here.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['tables-mixed-a4.pdf'],
    options: { target: 'xlsx', oneSheetPerPage: true },
    expectKind: 'zip',
    expectEntries: ['xl/workbook.xml'],
    expectArchiveText: ['page-1', 'page-3'],
    expectAbsentArchiveText: ['table-01-p1', 'table-02-p3'],
    expectMetrics: { tables: 2, target: 'xlsx' },
  },
  {
    // The `xlsx` fallback, which is the one branch of this tool that turns a *failure* into a warning: a document with
    // no table at all that was asked for a spreadsheet gets one column of text per page plus `TABLES_NOT_FOUND_FALLBACK`,
    // because failing a job whose user asked for a workbook is worse than handing them something to work from. The
    // warning is what makes it honest, so it is what the case asserts.
    tool: 'pdf-to-office',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { target: 'xlsx' },
    expectKind: 'zip',
    expectEntries: ['xl/workbook.xml'],
    expectArchiveText: ['page 3 of 6'],
    expectMetrics: { tables: 0, target: 'xlsx' },
    expectWarnings: ['LAYOUT_APPROXIMATE', 'TABLES_NOT_FOUND_FALLBACK'],
  },
  {
    // `responsive` in reflow mode, and the pair matters: the viewport meta is the whole visible difference between the
    // two settings, so one case asserts it is there and the next asserts it is not. The archive's members are stored
    // rather than deflated (measured), which is what lets a byte search see inside the zip.
    tool: 'pdf-to-html',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { mode: 'reflow', responsive: true },
    expectKind: 'zip',
    expectBytes: ['<meta name="viewport"', 'page 6 of 6'],
  },
  {
    // The off half. A container class rather than a media query is the other thing this option changes, so the case
    // asserts the meta — the one a browser acts on.
    tool: 'pdf-to-html',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { mode: 'reflow', responsive: false },
    expectKind: 'zip',
    expectAbsentBytes: ['<meta name="viewport"'],
    expectBytes: ['page 6 of 6'],
  },
  {
    // The columns of a table kept on one line, which is what `layout: 'preserve'` (`pdftotext -layout`) is for, and the
    // spacing is the assertion: Poppler's `-layout` pads a row's cells onto one line, and the default mode writes each
    // cell on its own. A handler that ignored the option fails this case, and the twin below fails the one that always
    // passed `-layout`.
    tool: 'pdf-to-text',
    pool: 'light',
    files: ['tables-ruled-a4.pdf'],
    options: { layout: 'preserve' },
    expectText: 'Item            Qty              Price',
    expectMetrics: { layout: 'preserve' },
  },
  {
    // The default, asserted as the absence of that row form plus the presence of the words themselves: the second half
    // is what proves the search could see the string at all, so the first half is not an absence for free.
    tool: 'pdf-to-text',
    pool: 'light',
    files: ['tables-ruled-a4.pdf'],
    options: { layout: 'plain' },
    expectText: 'Gadget',
    expectAbsentText: 'Item            Qty              Price',
  },
  {
    // A non-contiguous selection on a tool whose engine takes only `-f`/`-l`: pages 1 and 3 really extract the **span**
    // 1-3, and the metrics say so rather than implying only the two listed pages came out (`pagesExtracted: 3` against
    // `pages: 6`). This is a documented limitation, and the case is what keeps it documented — a handler that honoured
    // the list exactly, or that silently narrowed to the first page, fails here.
    tool: 'pdf-to-text',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['1', '3'] },
    expectText: 'page 3 of 6',
    expectAbsentText: 'page 4 of 6',
    expectMetrics: { pages: 6, pagesExtracted: 3 },
  },

  // ── ocr ──────────────────────────────────────────────────────────────────────────────────────────────────
  {
    // The raster fixture has no text layer at all (`bun run fixtures:scan` verifies that), so finding the word
    // means Tesseract read pixels — with a text fixture the handler would correctly skip and prove nothing.
    //
    // `expectQueue` is from pass 5's finding that `POST /jobs` answers the *queue* name while `GET /jobs/:id` answers
    // the pool id: the two spellings of one job are asserted together, so a client reading either sees the pool the
    // document names (`docs/15-OCR.md` §6, `pdf-ocr`).
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    expectText: 'fixture',
    expectQueue: 'pdf-ocr',
    expectMetrics: { pagesProcessed: 1, oversampleDpi: null, clean: false, imageInputs: 0 },
  },
  {
    // `outputMode: 'text-only'` — the mode that was **dead** until this pass: `--output-type none` still needs its
    // positional output argument (OCRmyPDF exits 2 without it, which the caller saw as `CONVERSION_FAILED`), and the
    // verification then read the `.txt` with `pdftotext`. One part, no PDF, and the words really in it.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { outputMode: 'text-only' },
    expectKind: 'text',
    expectParts: 1,
    expectPartText: [{ index: 0, text: 'fixture' }],
    expectMetrics: { outputMode: 'text-only' },
  },
  {
    // The two-part mode, and the *second* part is the assertion: a job that returned the PDF alone still satisfies
    // `expectText`, so the sidecar has to be read where it lands. This is also the pair `packArchive` needs — the
    // ocr image had no `zip`, so every multi-part OCR job ended as `ENGINE_UNAVAILABLE`.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { outputMode: 'pdf-and-text' },
    expectParts: 2,
    expectPartText: [{ index: 1, text: 'fixture' }],
    expectText: 'fixture',
    expectMetrics: { outputMode: 'pdf-and-text' },
  },
  {
    // The same branch through the option's other spelling — `sidecar: true` with the default mode. Two spellings of
    // one request, asserted twice, because the document used to describe only the one that did not exist under that
    // name (`textSidecarOnly`).
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { sidecar: true },
    expectParts: 2,
    expectPartText: [{ index: 1, text: 'fixture' }],
    expectMetrics: { outputMode: 'searchable-pdf' },
  },
  {
    // A page selection, and the fixture makes the halves separable: the document has three pages, only page 1 is
    // selected, so "page 3 was not recognised" is provable from the output's own text. The metrics carry both numbers
    // (`pagesSelected` against `pagesProcessed`) and `pagesWithoutText` is **empty**, which is the second half of the
    // rule: a page nobody asked for is not a page that failed.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-blank-a4.pdf'],
    options: { pages: ['1'] },
    expectPages: 3,
    expectText: 'page 1 of 3',
    expectAbsentText: 'page 3 of 3',
    expectMetrics: { pagesProcessed: 3, pagesSelected: 1, pagesWithoutText: [] },
    expectAbsentWarnings: ['PAGE_PARTIALLY_RECOGNISED'],
  },
  {
    // The same document with no selection, so every page is judged: the middle page is blank (the fixture has no ink
    // there) and the warning names it. This is the pair that makes `PAGE_PARTIALLY_RECOGNISED` a statement about the
    // document rather than a sentence printed on every job — the case below is the negative control.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-blank-a4.pdf'],
    expectPages: 3,
    expectWarnings: ['PAGE_PARTIALLY_RECOGNISED'],
    expectMetrics: { pagesWithoutText: [2] },
  },
  {
    // The control: one clean 300 dpi page, every page recognised, so the warning must be **absent**. Without this the
    // case above passes against a handler that prints the sentence for every job.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    expectText: 'fixture',
    expectAbsentWarnings: ['PAGE_PARTIALLY_RECOGNISED'],
    expectMetrics: { pagesWithoutText: [] },
  },
  {
    // `dpi` asked for explicitly, and the metric is what proves it reached the engine: `oversampleDpi` is the value
    // handed to `--oversample`, not a restatement of the option. `measuredDpi` stays the *scan's* own resolution
    // (300), because the two are different claims and a handler that conflated them would look identical here.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { dpi: 600 },
    expectText: 'fixture',
    expectMetrics: { oversampleDpi: 600, measuredDpi: 300 },
  },
  {
    // The automatic path on the same fixture: 300 dpi is above the document's own threshold (200), so nothing is
    // re-sampled and the metric is `null`. A handler that always passed `--oversample` would pass the case above and
    // fail this one.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    expectMetrics: { oversampleDpi: null },
  },
  {
    // Below 120 dpi the tool refuses instead of spending two minutes producing garbage, and the message carries the
    // number it measured — the fixture's own 96 dpi, which `fixtures:scan` asserted when it wrote the file.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-96dpi.pdf'],
    expectError: 'UNSUPPORTED_CONTENT',
    expectErrorMessage: 'at least 120 dpi',
  },
  {
    // An image input, which could not work at all before this pass: `qpdf --show-npages` on a PNG exits 2, so every
    // image job was `INVALID_FILE: The document could not be read.` The PNG carries its own 300 dpi (PNG stores
    // pixels per metre, so 299 is the same number) and the words are in the output, which means Tesseract read the
    // pixels of an image that was never a PDF.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng.png'],
    expectPages: 1,
    expectText: 'fixture',
    expectMetrics: { imageInputs: 1, pagesProcessed: 1 },
  },
  {
    // Two images are two pages, and page 2's own words are asserted: a merge that dropped the second image still
    // produces a valid one-page PDF whose text contains the first one's label, so only the second page's label tells
    // the two apart.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-two-p1.png', 'ocr-scan-two-p2.png'],
    expectPages: 2,
    expectText: 'page 2 of 2',
    expectMetrics: { imageInputs: 2, pagesProcessed: 2 },
  },
  {
    // A document that already has a text layer: `--skip-text` leaves it alone, the handler says so, and the input's
    // own words are still in the output. The twin below is the control — a real scan carries no such warning.
    tool: 'ocr',
    pool: 'ocr',
    files: ['pages-six-a4.pdf'],
    expectPages: 6,
    expectText: 'page 2 of 6',
    expectWarnings: ['EXISTING_TEXT_PRESERVED'],
  },
  {
    // The control for that warning: nothing to preserve in a raster scan, so the sentence must be absent.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    expectText: 'fixture',
    expectAbsentWarnings: ['EXISTING_TEXT_PRESERVED'],
  },
  {
    // The comma-separated spelling the form's text box produces, read back out of the metrics: `languages` is what the
    // handler asked the engine for, so a coercion that produced `['eng, ind']` as one code would fail here (and would
    // also be refused, since no such language is installed).
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { languages: 'eng, ind' },
    expectText: 'fixture',
    expectMetrics: { languages: ['eng', 'ind'] },
  },
  {
    // A language the image does not ship is refused before any page is read, and the message names the code. The
    // document used to promise its own error code for this (`LANGUAGE_NOT_AVAILABLE`); the shipped vocabulary is
    // `VALIDATION_ERROR`, which is what this pins.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { languages: 'xyz' },
    expectError: 'VALIDATION_ERROR',
    expectErrorMessage: 'not installed',
  },
  {
    // Two documents is a merge, not an OCR job — and before this rule the handler read `files[0]` and silently dropped
    // the second, so a two-document job looked like a success (defect 172). Images merge; documents do not.
    tool: 'ocr',
    pool: 'ocr',
    files: ['merge-two-a4.pdf', 'merge-three-a4.pdf'],
    expectError: 'VALIDATION_ERROR',
    expectErrorMessage: 'merge',
  },
  {
    // The speckled scan **without** `clean`, and the assertion is the fixture's own premise: at 2 % salt-and-pepper the
    // recogniser reads "page tof" where the page says "page 1 of 1" (measured through this exact pipeline — the ratio
    // is written down in `scripts/dev/make-scan-fixture.ts` because 1 %, 3 % and 5 % each destroy one half of the
    // pair). The job still succeeds: this is a *misreading*, not a refusal, which is what makes it comparable to the
    // case below.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-speckle-a4.png'],
    expectText: 'fixture',
    expectAbsentText: 'page 1 of 1',
    expectMetrics: { clean: false, imageInputs: 1 },
  },
  {
    // The same image with `clean: true`: the words come out exactly, so the pair is the whole of what the option
    // claims — and the metrics carry `clean`, so a handler that dropped the flag from the argument list fails on the
    // same run as the misreading above.
    tool: 'ocr',
    pool: 'ocr',
    files: ['ocr-scan-speckle-a4.png'],
    options: { clean: true },
    expectText: 'page 1 of 1',
    expectMetrics: { clean: true },
  },

  // ── organize ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    // A manual box, and *both* boxes asserted. The fixture is 595 × 842 pt (A4), so 20 mm off each edge leaves
    // 210 − 40 = 170 mm by 297 − 40 = 257 mm, i.e. 481.89 × 728.50 pt, and the MediaBox must stay A4 — that pair is
    // the whole promise of a non-destructive crop, and neither half is provable from the other.
    tool: 'crop',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { box: { top: 20, right: 20, bottom: 20, left: 20 }, units: 'mm' },
    expectPages: 6,
    expectPageSize: { widthPt: 595.28, heightPt: 841.89 },
    expectCropBox: { widthPt: 481.89, heightPt: 728.5 },
  },
  {
    // The same file cropped to a *selection*, so the per-page box is proven not to leak onto the other pages: only
    // the first page carries a crop box, which is why the check reads page one and the count stays six.
    tool: 'crop',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    // All four edges are required by the schema, so a horizontal-only crop says `0` for the other two rather than
    // omitting them — the zero is the crop, and an omitted key would be a 422.
    options: { box: { top: 0, right: 10, bottom: 0, left: 10 }, units: 'pt', pages: ['1'] },
    expectPages: 6,
    expectPageSize: { widthPt: 595.28, heightPt: 841.89 },
    expectCropBox: { widthPt: 575.28, heightPt: 841.89 },
  },
  {
    // Auto-crop: the content box measured by Ghostscript's `bbox` device. The fixture draws its title at x = 72 and
    // its rules from x = 72 to x = width − 72; the measured box is 71.74 × 641.99 → 523.26 × 760.81 pt — 451.52 by
    // 118.82 — which is exactly the arithmetic this case pins down. A handler that applied the *page* box instead,
    // or that forgot the device's origin, lands somewhere else entirely.
    tool: 'crop',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { auto: true },
    expectPages: 6,
    expectPageSize: { widthPt: 595.28, heightPt: 841.89 },
    expectCropBox: { widthPt: 451.52, heightPt: 118.82 },
  },
  {
    // 2-up: six pages onto three A4 sheets. The text check is what proves both cells were filled — the second cell
    // holds page 2's label, so a layout that placed only the first page of each pair still has the right page count.
    tool: 'n-up',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { perSheet: 2, pageSize: 'a4', orientation: 'portrait' },
    expectPages: 3,
    expectText: 'page 2 of 6',
    expectPageSize: { widthPt: 595.28, heightPt: 841.89 },
  },
  {
    // Pages that carry `/Rotate 90`, four to a portrait sheet. A form XObject keeps the page's *unrotated* box and
    // carries the display rotation in its own `/Matrix`, so this is the branch that has to read the displayed
    // rectangle rather than the box.
    //
    // What this case pins: the sheet's size, its page count, and that all four pages' content reached the sheet (page
    // 4's label is only in the file if the fourth form was drawn). What it does **not** pin is where each page landed:
    // off-canvas content still extracts, and the fixture's own rotated text is extractable either way, so a placement
    // error would pass every check here. That was measured by rendering instead — the four placements and their ink
    // boxes are recorded in `docs/08-…` §6 and 0-IMPLEMENTATION-STATUS.md; asserting placement in the suite needs a
    // renderer in the harness, which is listed as a gap in `0-TESTING.md`.
    tool: 'n-up',
    pool: 'light',
    files: ['nup-rotated-a4.pdf'],
    options: { perSheet: 4, pageSize: 'a4', orientation: 'portrait' },
    expectPages: 1,
    expectText: 'page 4 of 4',
    expectPageSize: { widthPt: 595.28, heightPt: 841.89 },
  },
  {
    // 4-up landscape: six pages onto two landscape sheets, which is the branch that swaps the grid (2 × 2 either way
    // here, four cells always) *and* the page box. Asserted by the MediaBox, because a landscape request that came
    // out portrait would satisfy every other check in this case.
    tool: 'n-up',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { perSheet: 4, pageSize: 'a4', orientation: 'landscape', gap: 6 },
    expectPages: 2,
    expectText: 'page 4 of 6',
    expectPageSize: { widthPt: 841.89, heightPt: 595.28 },
  },

  // ── optimize ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    // `remove-metadata` removes three separate stores, and a fixture that carried only one would let a handler that
    // deleted just the `/Info` dictionary pass. This is the default (empty `keep`): the author's name, the XMP
    // packet's marker, and the embedded file's payload must all be gone, while the pages must all survive.
    tool: 'remove-metadata',
    pool: 'light',
    files: ['metadata-rich-a4.pdf'],
    expectPages: 3,
    expectAbsentBytes: ['Dana Scully', 'METADATA-XMP-MARKER', 'PAYLOAD-METADATA-ATTACHMENT'],
  },
  {
    // The other direction, and the reason the check above means something: keeping `/Info` must leave the author in
    // the file while still removing the XMP packet and the attachment. Without this case, a handler that deleted
    // *everything* — and one whose removal silently did nothing — would both pass the case above.
    //
    // `keep` is sent as the comma-separated *string* on purpose: that is what the `text` control in the options panel
    // sends, and the API accepts it (`MetadataStore` preprocesses it into an array). The array spelling is covered by
    // the contracts unit test; this case is the end-to-end proof that the form's own spelling gets through.
    tool: 'remove-metadata',
    pool: 'light',
    files: ['metadata-rich-a4.pdf'],
    options: { keep: 'docinfo' },
    expectPages: 3,
    expectBytes: ['Dana Scully'],
    expectAbsentBytes: ['METADATA-XMP-MARKER', 'PAYLOAD-METADATA-ATTACHMENT'],
  },
  {
    // Linearization is a *position* property, so the check is structural: the hint dictionary has to be in the
    // first 2 KB, and qpdf has to be able to walk it. A rebuilt file that merely contains `/Linearized` somewhere
    // is what a handler wrapping the wrong qpdf invocation produces, and it would fail the second half.
    tool: 'linearize',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    expectPages: 6,
    expectLinearized: true,
  },
  {
    // `--optimize-images` is the second pass; the case exists because it is the option most likely to be wired to
    // nothing, and the page count is what a failed image rewrite would move.
    tool: 'linearize',
    pool: 'light',
    files: ['compress-text-a4.pdf'],
    options: { optimizeImages: true },
    expectPages: 4,
    expectLinearized: true,
  },
  {
    // `pdf-to-text` returns a text file, so this is the rare case whose assertion runs on the output's raw bytes
    // rather than through `pdftotext` (the harness only reaches for the engine when the output is a PDF). The
    // fixture's body text is the label written on every page, which is why the last page's words are the check.
    tool: 'pdf-to-text',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    expectText: 'Page operations fixture',
  },
  {
    // The page window: `pages: ['2-3']` maps to `-f 2 -l 3`, so page 4's label cannot appear. Extraction order is
    // the document's, so this asserts the *window* rather than a position — and absence is the only way to prove it.
    tool: 'pdf-to-text',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { pages: ['2-3'] },
    expectText: 'page 2 of 6',
    expectAbsentText: 'page 4 of 6',
  },

  // ── edit-pdf ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    // Text, placed by its baseline. Two regions, because "the mark landed where it was asked for" and "somewhere" are
    // different claims: the ink has to be *below* the baseline region and the word has to extract, which together say
    // the text went where the caller put it and not merely onto the page.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [{ type: 'text', page: 1, x: 72, y: 600, text: 'APPROVED', size: 18, color: '#0b6e2f' }],
    },
    expectPages: 6,
    expectText: 'APPROVED',
    expectInkRegion: ['1,72,592,120,28'],
    expectBlankRegion: ['1,72,480,120,28', '2,72,592,120,28'],
  },
  {
    // The vector half: a filled rectangle, a freehand mark and a ticked checkbox, each in its own place. The blank
    // regions are the load-bearing assertions — a rectangle drawn on every page would pass every ink check above.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [
        {
          type: 'shape',
          shape: 'rect',
          page: 1,
          x: 300,
          y: 500,
          width: 200,
          height: 80,
          fill: '#ff00ff',
          stroke: '#000000',
        },
        { type: 'checkbox', page: 1, x: 100, y: 400, size: 24, checked: true },
        {
          type: 'draw',
          page: 2,
          color: '#111111',
          strokeWidth: 3,
          points: [
            { x: 400, y: 300 },
            { x: 500, y: 350 },
            { x: 600, y: 300 },
          ],
        },
      ],
    },
    expectPages: 6,
    expectInkRegion: ['1,300,500,200,80', '1,100,400,24,24', '2,400,290,200,70'],
    expectBlankRegion: ['2,300,500,200,80', '1,400,290,200,70'],
  },
  {
    // An image element, whose file the caller names *inside* the element list. The two image assertions are what prove
    // the pixels arrived rather than a placeholder: one `/Subtype /Image` XObject, and it carries a soft mask, because
    // the fixture logo has transparency and an opaque white square is the failure mode a page count cannot see.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [
        {
          type: 'image',
          page: 1,
          x: 72,
          y: 200,
          width: 120,
          height: 120,
          fileId: '@upload:fixtures/generated/watermark-logo.png',
        },
      ],
    },
    expectPages: 6,
    // **Two** image objects, not one, and the number is the point: the fixture logo is a `PaletteAlpha` PNG, so the
    // placed image is one `/Subtype /Image` stream and its transparency is a second one (the `/SMask`). A case that
    // asserted one would fail on a correct output, and a case that asserted none could not tell the logo from a
    // placeholder — which is what `expectSmaskImages` is for.
    expectImages: 2,
    expectSmaskImages: 1,
    expectInkRegion: ['1,72,200,120,120'],
    expectBlankRegion: ['2,72,200,120,120'],
  },
  {
    // An element that names a page the document does not have is refused rather than skipped: the alternative is a
    // user discovering much later that their fifth mark never happened. The refusal happens inside the worker, which
    // is the shape the runner needed to learn for `pdf-to-csv` (defect 45).
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [{ type: 'text', page: 99, x: 72, y: 600, text: 'nope' }],
    },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // `ELEMENT_OFF_PAGE` for `edit-pdf`, which §3 has promised since the document was written and which no handler
    // raised — measured in pass 9, where a shape hanging 20 pt below the page's bottom edge completed silently. The
    // sentence is the whole point: the caller's mark is real, merely larger than the paper, and the part of it that is
    // not on the page is a fact only this warning carries.
    //
    // The visible band is asserted with it, because a warning printed over a mark that was *dropped* would be a true
    // sentence about the wrong thing: the fill is magenta and 60 pt tall from y=-20, so the 40 pt that are on the page
    // have ink and the same rectangle on page 2 — where nothing was asked for — does not.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [{ type: 'shape', shape: 'rect', page: 1, x: 300, y: -20, width: 200, height: 60, fill: '#ff00ff' }],
    },
    expectPages: 6,
    expectWarnings: ['ELEMENT_OFF_PAGE'],
    expectMetrics: { offPage: 1, offPagePages: [1] },
    expectInkRegion: ['1,300,0,200,40'],
    expectBlankRegion: ['2,300,0,200,40'],
  },
  {
    // The negative twin, and it is what makes the case above an assertion rather than a habit: the same rectangle
    // moved up so that all of it is on the page — its lower edge exactly on the page's own edge, which is also the
    // strict side of the 0.01 pt tolerance — must complete **without** the warning. A handler that printed the sentence
    // for every job would pass the case above and fail this one.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [{ type: 'shape', shape: 'rect', page: 1, x: 300, y: 0, width: 200, height: 60, fill: '#ff00ff' }],
    },
    expectPages: 6,
    expectAbsentWarnings: ['ELEMENT_OFF_PAGE'],
    expectMetrics: { offPage: 0, offPagePages: [] },
    expectInkRegion: ['1,300,0,200,60'],
  },
  {
    // §6's "image element ≤ 4 MB", promised since the document was written and enforced nowhere: measured in pass 9,
    // an image element was bounded only by the upload ceiling the plan allowed. The fixture proves *which* rule
    // refuses this job — 1200×1200 is an unremarkable bitmap and its 4.1 MB is the only thing over any limit here,
    // the mirror of `signature-oversize.png`, which is the pixel cap with a file of 2.8 KB.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      elements: [
        {
          type: 'image',
          page: 1,
          x: 72,
          y: 200,
          width: 120,
          height: 120,
          fileId: '@upload:fixtures/generated/element-image-oversize.png',
        },
      ],
    },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // §6's freehand cap, which nothing enforced: 5 001 points completed in pass 9, and every point is a segment of a
    // PostScript path, so the number was the only bound on a single option value. The refusal is the contract's
    // `.max(FREEHAND_POINTS_MAX)` — a 422 at the door rather than a job that draws an unbounded path.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { elements: [{ type: 'draw', page: 1, points: freehandStroke(5001) }] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // The strict edge, and the half that keeps the cap from being a guess: 5 000 points is legal. A fix that refused
    // one point too many would fail here while passing the case above — so the pair is the claim, not either one.
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { elements: [{ type: 'draw', page: 1, strokeWidth: 2, points: freehandStroke(5000) }] },
    expectPages: 6,
    expectInkRegion: ['1,100,400,300,100'],
    expectAbsentWarnings: ['ELEMENT_OFF_PAGE'],
  },
  {
    // `annotate` — the tool whose product is a *dictionary* rather than paint, which is the one difference a rendered
    // page cannot show. Every assertion here therefore comes from the file's own objects: two highlights (one element
    // carrying two rectangles, which is what a three-line selection is), an underline, a strike on another page, and a
    // note with an author.
    //
    // The marks sit in the band below the fixture's own text (which is at y≈741–760, measured with `pdftotext -bbox`),
    // because an ink check over a region that already has ink passes with or without the mark. The colours are not
    // the contract's defaults, and that is deliberate: **poppler renders markup lines lighter than the harness's ink
    // threshold** — measured, a black underline comes out at 165/255 gray and the contract's blue `#1a73e8` at 201,
    // above the 200 cutoff — so the placement evidence uses black, and the light-colour behaviour is asserted through
    // the dictionaries below instead. A highlighter yellow (`#ffe066`, 219 gray) is invisible to this check at any
    // alpha, which is why the highlight assertions are counts and quad points rather than ink.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      annotations: [
        {
          type: 'highlight',
          page: 4,
          rects: [
            { x: 72, y: 400, width: 200, height: 19 },
            { x: 320, y: 400, width: 200, height: 19 },
          ],
        },
        { type: 'underline', page: 4, rects: [{ x: 72, y: 340, width: 200, height: 19 }], color: '#000000' },
        { type: 'strike', page: 6, rects: [{ x: 72, y: 400, width: 200, height: 19 }], color: '#000000' },
        {
          type: 'note',
          page: 4,
          x: 460,
          y: 600,
          text: 'Check the tolerance on this line.',
          author: 'boni.paratama@rumindium.com',
        },
      ],
      flatten: false,
    },
    expectPages: 6,
    expectAnnotations: { highlight: 2, underline: 1, strike: 1, note: 1 },
    expectAnnotationCount: 5,
    expectAnnotationsPrint: true,
    // Two highlight rectangles and the underline on page 4, the strike on page 6. A case that only counted
    // annotations would pass for a write that produced bare rectangles, which a reader can select but cannot align
    // to the text.
    expectQuadPoints: { 4: 3, 6: 1 },
    expectInkRegion: ['4,72,340,200,19', '6,72,400,200,19'],
    // The strike was asked for on page 6; the same coordinates on page 5 must be blank. And the band between the
    // underline and the highlight is blank in the fixture, so the ink above is the mark rather than the page.
    expectBlankRegion: ['5,72,400,200,19', '4,72,380,200,19'],
    expectText: 'page 4 of 6',
  },
  {
    // The other mechanism: `flatten: true` draws the marks into the page content, so the file must gain **no**
    // annotation dictionaries at all. That count is the assertion — a flattened mark is paint, and a build that
    // quietly wrote dictionaries would look identical on screen.
    //
    // The highlight is a dark colour here on purpose. Flattening draws the fill at 45 % alpha, and a highlighter
    // yellow at that alpha lands at 239/255 gray — above the harness's ink threshold, so the placement of the fill
    // could not be asserted with it. A dark fill also makes the *scaling* visible: the overlay page is sized to the
    // target page, so a mismatch would move or stretch this region out from under the check.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      annotations: [
        { type: 'highlight', page: 4, rects: [{ x: 72, y: 400, width: 200, height: 60 }], color: '#333333' },
        { type: 'underline', page: 4, rects: [{ x: 320, y: 400, width: 200, height: 19 }], color: '#000000' },
        { type: 'note', page: 4, x: 460, y: 600, text: 'Flattened, so this is only an icon.', author: 'reviewer' },
      ],
      flatten: true,
    },
    expectPages: 6,
    expectAnnotationCount: 0,
    expectInkRegion: ['4,72,400,200,60'],
    expectBlankRegion: ['4,72,340,200,19'],
    // A flattened note is its icon: the text is in the request, not in the output, and that limitation is reported
    // rather than left for the caller to discover.
    expectWarnings: ['NOTE_FLATTENED_AS_ICON'],
  },
  {
    // A page the document does not have is a refusal, not a skip: silently dropping the mark is how a user finds out
    // weeks later. Same shape as the `edit-pdf` case above, one tool over.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { annotations: [{ type: 'highlight', page: 99, rects: [{ x: 72, y: 400, width: 100, height: 19 }] }] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // The documented per-page cap (100), which the contract's 500-per-job limit cannot express: one element with 101
    // rectangles is 101 marks on one page, and a write that accepted it would put an unbounded amount of work behind
    // a single request. The refusal comes from the worker, so this case also proves the API let it through to there.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      annotations: [
        {
          type: 'highlight',
          page: 1,
          rects: Array.from({ length: 101 }, (_, index) => ({ x: 72, y: 100 + index * 20, width: 200, height: 19 })),
        },
      ],
    },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // `ELEMENT_OFF_PAGE` one tool over, and the mark is still written: a highlight that runs past the paper is a real
    // mark, merely larger than the page, so the job reports the fact instead of refusing the job. The annotation count
    // and the quad points are asserted beside the warning for that reason — a "fix" that dropped the mark would make
    // the warning false.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      annotations: [
        { type: 'highlight', page: 3, rects: [{ x: 500, y: -12, width: 200, height: 40 }], color: '#000000' },
      ],
      flatten: false,
    },
    expectPages: 6,
    expectAnnotations: { highlight: 1 },
    expectAnnotationCount: 1,
    expectQuadPoints: { 3: 1 },
    expectWarnings: ['ELEMENT_OFF_PAGE'],
    expectMetrics: { offPage: 1, offPagePages: [3] },
  },
  {
    // The twin: the same mark moved wholly onto the page carries no warning and no off-page count. A highlight is
    // invisible to this suite's ink checks (219/255 against a 200 cutoff, `0-TESTING.md` §5), which is exactly why the
    // pair is asserted through the job's own words and the file's own objects rather than through a render.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      annotations: [
        { type: 'highlight', page: 3, rects: [{ x: 400, y: 0, width: 150, height: 40 }], color: '#000000' },
      ],
      flatten: false,
    },
    expectPages: 6,
    expectAnnotations: { highlight: 1 },
    expectAbsentWarnings: ['ELEMENT_OFF_PAGE'],
    expectMetrics: { offPage: 0, offPagePages: [] },
  },
  // ── pdf-to-pdfa (heavy) ──────────────────────────────────────────────────────────────────────────────────
  //
  // Six cases over four fixtures, and the group is about what the job *knows* rather than what the file says: the
  // archival claim itself (XMP + output intent) is asserted in bytes, but the two things a caller cannot check by
  // opening the file — which fonts were not embedded, and which images were above the normalising resolution — are
  // asserted through the job's own metrics, measured by `pdffonts` and `pdfimages` rather than stated by the handler.
  {
    // The case that can run everywhere: an anonymous session with no plan at all gets the same archival file as the
    // Pro case below — no tool in the registry is plan-gated, so the job is created, not refused. Deliberately the
    // same fixture, profile and byte assertions as the Pro case: the pair proves the plan changes nothing about the
    // deliverable, only the limits around it.
    tool: 'pdf-to-pdfa',
    pool: 'heavy',
    files: ['pages-six-a4.pdf'],
    options: { profile: '1b' },
    expectPages: 6,
    expectBytes: ["pdfaid:part='1'", 'GTS_PDFA1'],
    expectMetrics: {
      'conformance.tool': 'verapdf',
      'conformance.result': 'PASS',
      fontPass: 'embed',
      fontsTotal: 1,
      fontsNotEmbeddedInInput: 1,
      fontsSubstituted: 1,
      imagesTotal: 0,
      imagesDownsampled: 0,
    },
    expectMetricsOver: { fontsEmbedded: 0 },
    expectWarnings: ['FONT_SUBSTITUTED'],
  },
  {
    // The tool itself, which was written long before it could run: the Pro plan is granted by the stack's own switch
    // (the harness verifies the grant first), the output must keep its pages, and the archival marker has to be in the
    // bytes — Ghostscript writes the PDF/A identification into the file's metadata, and "the job succeeded" is not
    // evidence that it did.
    //
    // `1b` is deliberate: it is the conformance level that forbids transparency and JavaScript, so a pass on it is a
    // stronger claim than `2b` would be on this fixture.
    tool: 'pdf-to-pdfa',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { profile: '1b' },
    expectPages: 6,
    // The literal, not the word `pdfaid:part`: the level is what the caller chose, and a case that only proves the
    // claim exists cannot tell PDF/A-1 from a file that says PDF/A-3. That distinction is exactly how `3b` was found
    // to be answered with a PDF/A-2 document.
    expectBytes: ["pdfaid:part='1'", 'GTS_PDFA1'],
    // What the xmp and the intent cannot say: that the file **conforms**. The validator runs against the produced
    // document (veraPDF ships in the heavy image), and the case asserts the verdict the job reports — the same claim
    // `bun run test:pdfa` reproduces by running veraPDF over the delivered bytes itself.
    //
    // The three census facts beside it are the other half of the same idea, and they are **measurements of this
    // fixture** rather than of the tool: it names `Helvetica` without a font program, which is why `fontsEmbedded` is
    // above zero at all, and it contains no image, so both image counts are zero. `fontsEmbedded` being a `>` rather
    // than an `=` is deliberate — the exact number is a property of the fixture, and a case that restated it would be
    // asserting the fixture twice; what the case claims is that a font which had no program now has one.
    //
    // `FONT_SUBSTITUTED` is the fifth tool's version of a warning about the *delivered* file: a base-14 font can only
    // be embedded by finding a real program for it, which means the archival file carries a substitute for the family
    // the document named. It fires here because this fixture is such a document.
    expectMetrics: {
      'conformance.tool': 'verapdf',
      'conformance.result': 'PASS',
      fontPass: 'embed',
      fontsTotal: 1,
      fontsNotEmbeddedInInput: 1,
      fontsSubstituted: 1,
      imagesTotal: 0,
      imagesDownsampled: 0,
    },
    expectMetricsOver: { fontsEmbedded: 0 },
    expectWarnings: ['FONT_SUBSTITUTED'],
  },
  {
    // The images, and the only fixture in the build whose resolution is not uniform: a 1200 px image drawn 120 pt
    // wide (720 dpi) beside a 200 px image drawn 144 pt wide (100 dpi). `imagesDownsampled: 1` is therefore two
    // assertions in one — that the high-resolution image was above the threshold and that the low-resolution one was
    // not. The only alternative arrangement, two fixtures, would leave "the control image really is below the
    // threshold" as an unstated property of the other file.
    //
    // It is also the case that pins the *threshold* rather than the normalising itself. Ghostscript's default
    // downsample threshold is 1.5 — images between 300 and 450 dpi are left alone — while the census counts anything
    // above 300 as reduced, so the handler passes `-d*ImageDownsampleThreshold=1.0` explicitly
    // (`workers/heavy/src/handlers/pdf-to-pdfa.ts`, `IMAGE_DPI`). Removing that flag makes this case's number a
    // claim about a document the pass did not fully normalise, which is the disagreement the flag exists to prevent.
    tool: 'pdf-to-pdfa',
    pool: 'heavy',
    plan: 'pro',
    files: ['pdf-to-pdfa-images-a4.pdf'],
    options: { profile: '2b' },
    expectPages: 1,
    expectBytes: ["pdfaid:part='2'", 'GTS_PDFA1'],
    expectMetrics: {
      'conformance.result': 'PASS',
      imagesTotal: 2,
      imagesDownsampled: 1,
    },
  },
  {
    // `embedAllFonts: false`, which is now read. The option's observable effect is that one prepass does not run, and
    // that changes no property of the delivered file — measured: the PDF/A pass embeds fonts itself, so the output is
    // embedded either way (the same fixture, `fontPass: 'embed'` in the case above and `'skipped'` here, both with a
    // valid archival file). The job's own account is therefore the only place the difference can be seen, which is
    // why the assertion is on the metric rather than on bytes.
    //
    // The warning is asserted beside it because "skipped" alone would also describe a handler that never ran the
    // prepass at all — and the case above is the control for that, since it requires `fontPass: 'embed'` on the same
    // fixture.
    tool: 'pdf-to-pdfa',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { profile: '2b', embedAllFonts: false },
    expectPages: 6,
    expectBytes: ["pdfaid:part='2'", 'GTS_PDFA1'],
    expectMetrics: { 'conformance.result': 'PASS', fontPass: 'skipped' },
    expectMetricsOver: { fontsEmbedded: 0 },
    expectWarnings: ['FONT_EMBEDDING_SKIPPED'],
  },
  {
    // The third level, which this case exists for: `3b` used to fall into the `2` branch, so the tool produced a
    // PDF/A-2 file (its own XMP saying `pdfaid:part='2'`) for a caller who asked for PDF/A-3. Ghostscript does support
    // `-dPDFA=3`; the loss was entirely in the argument mapping.
    tool: 'pdf-to-pdfa',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { profile: '3b' },
    expectPages: 6,
    expectBytes: ["pdfaid:part='3'", 'GTS_PDFA1'],
    expectMetrics: { 'conformance.tool': 'verapdf', 'conformance.result': 'PASS' },
  },
  {
    // The other colour strategy, and the reason it is a case rather than a note: `forceSrgb: false` used to mean
    // "convert nothing", and the two ways to get that wrong are to drop the intent (the defect above) or to keep
    // claiming sRGB while the content stays in its own spaces. The intent has to be there in both branches, and the
    // mismatch has to be *said* — hence the warning assertion rather than a second profile check the harness cannot
    // make from bytes.
    tool: 'pdf-to-pdfa',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { profile: '2b', forceSrgb: false },
    expectPages: 6,
    expectBytes: ["pdfaid:part='2'", 'GTS_PDFA1'],
    // The level is asserted in both directions: `GTS_PDFA1` alone cannot tell which part was produced, and a
    // conversion that answers the wrong level is the defect the `3b` case above was written for.
    expectAbsentBytes: ["pdfaid:part='3'"],
    // The warning about the colour *strategy* stays; the warning about validation does not, and its absence is the
    // assertion: `PDFA_VALIDATE` is on in this stack, so a job that still said "not validated" would be the old
    // behaviour surviving a configuration change. The verdict is asserted beside it, because a job that skipped the
    // check would satisfy the absence and fail here.
    expectWarnings: ['COLOURS_NOT_CONVERTED'],
    expectAbsentWarnings: ['CONFORMANCE_NOT_VALIDATED'],
    expectMetrics: { 'conformance.tool': 'verapdf', 'conformance.result': 'PASS' },
  },

  // ── forms (light + heavy) ────────────────────────────────────────────────────────────────────────────────
  //
  // Five cases over two tools and one fixture, and every assertion here is one a page count cannot make: the field
  // walk has to follow `/Kids` (a radio group is two boxes and one field — a walk over `/AcroForm /Fields` reports it
  // once with no rectangle), a filled value has to be *on the page* rather than merely in the file, and a flatten has
  // to leave no widget behind while keeping the other annotations or baking them in.
  //
  // The fixture's geometry lives in `scripts/dev/make-form-fixture.ts` (`FORM_FIXTURE_BOXES`); the numbers are repeated
  // here because that file builds the fixture when it is *run*, and importing it from the suite would build it again.
  {
    // The walk itself. `fields[3].rects[1].xPt` is the load-bearing assertion: it can only hold if the reader followed
    // the radio group's `/Kids`, which is the decision the whole module is written around. `fields[0].hasAppearance`
    // being `false` is the fixture's deliberate omission, and `fields[2].value` being `"IT"` is the pre-filled choice
    // — a value read out of the document rather than one the reader made up.
    tool: 'extract-fields',
    pool: 'light',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    //
    // Deliberately **not** `widgets: 6` here: the widget count lives in the job's `metrics`, not in the file, and the
    // first version of this case asserted it against the JSON body and failed against a correct output. The claim it
    // was there to make is already carried by data — `fields[3].rects[1].xPt` can only hold if six widgets were walked.
    expectJsonPaths: {
      'fields[0].name': 'employee_name',
      'fields[0].type': 'text',
      'fields[0].value': null,
      'fields[0].required': true,
      'fields[0].readOnly': false,
      'fields[0].maxLength': 80,
      'fields[0].hasAppearance': false,
      'fields[1].type': 'checkbox',
      'fields[1].value': false,
      'fields[1].hasAppearance': true,
      'fields[2].type': 'choice',
      'fields[2].value': 'IT',
      'fields[3].name': 'shift',
      'fields[3].type': 'radio',
      'fields[3].value': false,
      'fields[3].rects[0].xPt': 72,
      'fields[3].rects[1].xPt': 100,
      'fields[4].name': 'approver_signature',
      'fields[4].type': 'signature',
    },
    // The fixture's text field has no appearance stream on purpose, so the warning is asserted rather than tolerated:
    // a read tool that stopped saying "a reader may show this empty" would otherwise pass every case above.
    expectWarnings: ['APPEARANCE_MISSING'],
  },
  {
    // The schema branch. `options,value` is the exact tail of the header **with** values, so its absence is the only
    // assertion that can tell a schema export from an export whose value column happens to be empty — and the value
    // column is what `includeValues: false` exists to drop.
    tool: 'extract-fields',
    pool: 'light',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: { format: 'csv', includeValues: false },
    expectKind: 'text',
    expectText: 'employee_name,text,1,true,false,80,',
    expectAbsentText: 'options,value',
  },
  {
    // Filling **without** flattening, and the ink assertion is the point: a text field's `/V` can be set while its
    // `/AP` is missing, which is a value that reads back correctly from every API and shows as an empty box. Ink in
    // the box is the only check here that can tell those apart, and 7 annotations is the widget count (6) plus the
    // highlight the fixture ships with — so a handler that flattened anyway would fail this case rather than pass it.
    //
    // `APPEARANCE_MISSING` is asserted rather than tolerated because the signature field genuinely cannot have an
    // appearance, and the caller is owed that sentence: every other field in this document got one.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: {
      fields: { employee_name: 'Boni Pratama', acknowledged: true, department: 'Operations', shift: true },
      flatten: false,
    },
    expectText: 'Boni Pratama',
    expectInkRegion: ['1,72,640,248,24'],
    expectAnnotationCount: 7,
    expectWarnings: ['APPEARANCE_MISSING'],
  },
  {
    // The default mode, and the reason it is the default: three widgets and the highlight were flattened — the
    // highlight as **ink in its own box**, which is the assertion that a bake happened rather than a deletion. The
    // three that remain are the fields the caller did not fill (two radio boxes and the signature placeholder), which
    // is the whole point of 'filled': the next person can still complete them.
    //
    // A count is the only check that can see this. "The output has fewer annotations than it used to" is satisfied by
    // a flatten that deleted everything, including the values it was supposed to preserve.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: {
      fields: { employee_name: 'Boni Pratama', acknowledged: true, department: 'Operations' },
      flatten: true,
      flattenMode: 'filled',
    },
    expectText: 'Boni Pratama',
    expectInkRegion: ['1,72,600,14,14', '1,72,430,248,14'],
    expectAnnotationCount: 3,
    expectWarnings: ['APPEARANCE_MISSING'],
  },
  {
    // The same fill with `all`, and the pair is the whole reason the option is worth having: a mode whose two values
    // produce the same file is a mode that lies. Zero annotations here against three above, same input, same values —
    // the only difference is what the caller asked for.
    //
    // `approver_signature` is a field type that cannot be filled, so `FIELD_SKIPPED` is asserted: a caller who sent a
    // value needs to hear that the document has no field for it rather than be told the job succeeded. It is also the
    // one field an `'all'` flatten cannot bake (no appearance is possible for a signature), so the job removes the
    // empty placeholder and says so — the alternative, leaving it interactive, is a form the recipient can still type
    // into, and the alternative before that was failing a job whose output was correct.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: {
      fields: { employee_name: 'Boni Pratama', approver_signature: 'Boni Pratama' },
      flatten: true,
      flattenMode: 'all',
    },
    expectText: 'Boni Pratama',
    expectAnnotationCount: 0,
    expectWarnings: ['FIELD_SKIPPED', 'EMPTY_FIELDS_REMOVED'],
  },
  {
    // A value longer than the field's own `/MaxLen`, which this document has promised a case for since the tool was
    // built (§7's struck-through row) and which is the second skip the engine performs. The assertion that matters is
    // the **absence**: `employee_name` allows 80 characters, 120 were sent, and a job that truncated would put a run
    // of `x`s on the page — so the case looks for one. `FIELD_SKIPPED` names the reason, and the second value in the
    // same request is written, which is what makes this a per-field decision rather than a refusal of the job.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: { fields: { employee_name: 'x'.repeat(120), acknowledged: true }, flatten: false },
    expectPages: 1,
    expectAbsentText: 'xx',
    expectWarnings: ['FIELD_SKIPPED', 'APPEARANCE_MISSING'],
    expectMetrics: { fieldsFilled: 1, fieldsSkipped: 1, fieldsRequested: 2 },
  },
  {
    // The second form model, on a fixture built for it in pass 9: the same six fields with an `/XFA` packet beside
    // them. `FORM_XFA` was documented in §3 and had no raise site and no fixture to be raised on, so this is the case
    // the warning was missing — and the assertion beside it is that the packet is **untouched**: an XFA-aware reader
    // may show the packet's own data, which is why the sentence exists, and a handler that cleared the packet to make
    // the two models agree would be rewriting a document it does not own.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-xfa-a4.pdf'],
    options: { fields: { employee_name: 'Boni Pratama' }, flatten: false },
    expectPages: 1,
    expectText: 'Boni Pratama',
    expectBytes: ['PDFTOOLS-XFA-DATA'],
    expectWarnings: ['FORM_XFA', 'APPEARANCE_MISSING'],
    expectMetrics: { fieldsFilled: 1, fieldsSkipped: 0 },
  },
  {
    // The same sentence on the read side: a caller handed six fields from a document whose reader shows the packet
    // deserves to know which model they read — `xfa: true` in the metrics is the machine-readable half of it.
    tool: 'extract-fields',
    pool: 'light',
    plan: 'pro',
    files: ['form-xfa-a4.pdf'],
    expectJsonPaths: { 'fields[0].name': 'employee_name', 'fields[0].maxLength': 80 },
    expectWarnings: ['FORM_XFA', 'APPEARANCE_MISSING'],
    expectMetrics: { xfa: true, widgets: 6 },
  },
  {
    // The placeholder case, and it is a fix rather than a case: the form fixture's `approver_signature` is an **empty**
    // `/FT /Sig` field, and the job's own signature invariant used to compare the output against zero — so signing a
    // form that is waiting for a signature failed with `CONVERSION_FAILED`, which is the ordinary case for this tool.
    // The claim is two sentences: this job adds no signature dictionary (`signatureObjects: 0` while the input carries
    // a placeholder), and an unfilled placeholder is **not** a signature to invalidate (no
    // `ELECTRONIC_SIGNATURE_INVALIDATED`).
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: {
      kind: 'typed',
      signature: 'Boni Pratama',
      fields: [{ page: 1, x: 72, y: 470, w: 168, h: 24, units: 'pt' }],
      showDateStamp: false,
    },
    expectPages: 1,
    expectText: 'Boni Pratama',
    expectInkRegion: ['1,72,470,168,24'],
    expectWarnings: ['NOT_A_DIGITAL_SIGNATURE'],
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
    expectMetrics: { signatureObjects: 0, inputSignatureValues: 0, inputUnsignedSignatureFields: 1 },
  },
  {
    // The other half: signing a document that already carries a signature **value** is legal and must say what it
    // broke. `redact-signed-a4.pdf` is the fixture with a real signature dictionary, so this case would have failed
    // before pass 9's fix — the job refused it — and the warning is the honest answer: the ink this tool draws covers
    // bytes the existing signature's `/ByteRange` names, so the signature it arrived with is no longer valid. The
    // metrics carry both halves, and the absence of `NOT_A_DIGITAL_SIGNATURE`'s counterpart is asserted through the
    // job's own signature count rather than through a dictionary check that **must** now find the input's.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: {
      kind: 'typed',
      signature: 'Alice Tan',
      fields: [{ page: 1, x: 100, y: 500, w: 180, h: 60 }],
      showDateStamp: false,
    },
    expectPages: 3,
    expectText: 'Alice Tan',
    expectInkRegion: ['1,100,500,180,60'],
    expectWarnings: ['NOT_A_DIGITAL_SIGNATURE', 'ELECTRONIC_SIGNATURE_INVALIDATED'],
    // Two *signature values*, not one, and the fixture is why: it carries a `/Type /Sig` value dictionary **and** a
    // `/FT /Sig` field holding a `/V`, and both are a signature a reader will verify. Counted rather than assumed —
    // the first version of this case said one and the job said two.
    expectMetrics: { signatureObjects: 0, signatureValues: 0, inputSignatureValues: 2 },
  },
  {
    // The typed signature, end to end, on page 2 of a six-page document: the name has to be **readable text in the
    // output** (poppler, a different engine from the Ghostscript that typeset it), the metadata has to carry who signed
    // and why, the border has to be ink inside the box that was asked for, and the document must not have gained or
    // lost a page. Every one of those is a different engine's opinion of the same file.
    //
    // `NOT_A_DIGITAL_SIGNATURE` is asserted rather than merely documented: a caller who believes they have a
    // cryptographically signed contract has been misled, and the warning in the API response is where they find out.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      kind: 'typed',
      signature: 'Boni Patama',
      signerName: 'Boni Patama',
      reason: 'Approved the contract',
      location: 'Jakarta',
      fields: [{ page: 2, x: 100, y: 400, w: 220, h: 70 }],
      borderColor: '#9aa0a6',
    },
    expectPages: 6,
    expectText: 'Boni Patama',
    expectBytes: ['reason=Approved the contract', 'signed_at='],
    expectInkRegion: ['2,100,400,220,70'],
    expectWarnings: ['NOT_A_DIGITAL_SIGNATURE'],
    expectNoSignatureDictionary: true,
  },
  {
    // The drawn signature — a transparent PNG, contained in a box whose aspect ratio is *not* the image's — and this
    // case is really two assertions in one.
    //
    // **Alpha:** the output must carry the bitmap as a soft-masked image; without an `/SMask` the signature arrives as
    // a rectangle of whatever colour its transparent pixels happened to hold. **Containment:** the canvas is 600×220
    // and the box is 200×150, so keeping the aspect ratio puts the ink at 358–399 pt where stretching the same bitmap
    // would put it at 340–425 — `signature-ink.png` confines its ink to canvas rows 37–161 for exactly this reason.
    // The two blank regions are that difference: neither can be blank under a stretch, so together with the ink
    // assertion they prove the bitmap was fitted rather than stretched to fill the box.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      kind: 'image',
      reason: 'Witnessed',
      location: 'Jakarta',
      fields: [{ page: 1, x: 72, y: 300, w: 200, h: 150 }],
    },
    auxiliary: { imageFileId: 'signature-ink.png' },
    expectPages: 6,
    expectSmaskImages: 1,
    expectInkRegion: ['1,82,378,178,20'],
    expectBlankRegion: ['1,82,342,178,12', '1,82,404,178,18'],
    // The date line is text, not part of the bitmap — so it proves the second overlay (the meta line under the image)
    // merged on top of the first.
    expectText: 'Jakarta',
    expectWarnings: ['NOT_A_DIGITAL_SIGNATURE'],
    expectNoSignatureDictionary: true,
  },
  {
    // Two signatures on one page — the shape a contract actually takes, a signer and a witness on the same sheet —
    // and it was silently broken until the image overlay builder stopped wrapping a whole run of stamps in one
    // `q`/`Q`: the file carried both `Do` operations, `pdftoppm` painted only the first, and the job reported success
    // over a page with one signature on it (defect 110). Two boxes far apart on purpose, so a pass cannot come from
    // one stamp drawn twice, and one `/SMask` image between them, so the fix did not cost the shared-stream design.
    //
    // The date line is off because it is text: it would be ink of its own in a band these assertions do not expect.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      kind: 'image',
      reason: 'Witnessed',
      fields: [
        { page: 1, x: 72, y: 300, w: 200, h: 150 },
        { page: 1, x: 323, y: 300, w: 200, h: 150 },
      ],
      showDateStamp: false,
      showSignerName: false,
    },
    auxiliary: { imageFileId: 'signature-ink.png' },
    expectPages: 6,
    // One bitmap stream, placed twice: the pixels are shared, only the matrix differs.
    expectSmaskImages: 1,
    expectInkRegion: ['1,82,378,178,20', '1,333,378,178,20'],
    expectWarnings: ['NOT_A_DIGITAL_SIGNATURE'],
    expectNoSignatureDictionary: true,
  },
  {
    // A typed signature with nothing to type: an empty box inked onto the page and reported as success is the failure
    // this refusal exists for, and it is one a `fields: []` check cannot catch — the contract's `.min(1)` already
    // makes *zero placements* a validation error at the door.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'typed', fields: [{ page: 1, x: 100, y: 400, w: 200, h: 60 }] },
    expectError: 'SIGNATURE_REQUIRED',
  },
  {
    // A drawn signature whose image never made it into the job: `imageFileId` names an upload the API resolves into an
    // attachment, so this is the case where the id was forgiven and the signature would otherwise be a silent no-op.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'drawn', fields: [{ page: 1, x: 100, y: 400, w: 200, h: 60 }] },
    expectError: 'IMAGE_REQUIRED',
  },
  {
    // The pixel cap of §6, and the fixture is built to prove *which* cap ran: `signature-oversize.png` is 4 100 px wide
    // and 2.8 KB, so the file-size check it passes cannot be what refuses this job. Had it broken both limits, the case
    // would have passed against a handler that only ever looked at bytes.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: { kind: 'image', fields: [{ page: 1, x: 72, y: 300, w: 200, h: 60 }] },
    auxiliary: { imageFileId: 'signature-oversize.png' },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // The placement ceiling, refused at the contract: `fields` is `.max(20)`, so a 21st is a 422 rather than a job that
    // inks a page 21 times and reports success.
    tool: 'sign',
    pool: 'heavy',
    plan: 'pro',
    files: ['pages-six-a4.pdf'],
    options: {
      kind: 'typed',
      signature: 'Boni Patama',
      fields: Array.from({ length: 21 }, (_, index) => ({ page: 1, x: 60 + index * 5, y: 300, w: 100, h: 40 })),
    },
    expectError: 'VALIDATION_ERROR',
  },

  // ── redaction (heavy) ───────────────────────────────────────────────────────────────────────────────────────
  //
  // Seven cases over one tool whose product is an **absence**, and the assertions are built so that absence cannot be
  // reached from a job that erased nothing:
  //
  //  - every "gone" string is paired with a presence assertion on the same file, so a search that sees nothing fails
  //    instead of passing (`PUBLIC-KEEP-0001` and the second copy of `SHARED-7731` are the strings that must survive);
  //  - the marked text is removed from the page *and* from the three metadata stores, with one case keeping the
  //    metadata on purpose so those two options cannot be one behaviour with a flag;
  //  - the refusal cases are geometric, because a rectangle on page 99 and a rectangle off the page are the two ways a
  //    caller's coordinates are wrong, and both would otherwise be jobs that painted a box and removed nothing.
  //
  // The ink assertion is what makes "the box was painted" a fact, and the blank band above the marked line is what
  // makes "and nowhere else" one.
  {
    // The whole tool in one case: two rectangles on page 1 and one on page 2, the page text gone, the copy in the
    // `/Info` dictionary, the XMP packet and the embedded file gone with it, and the two strings that must survive
    // still there. The gap band is asserted blank so a job that covered the page would fail rather than pass.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: {
      regions: [
        { page: 1, rects: [REDACT_SECRET_RECT, REDACT_SHARED_RECT] },
        { page: 2, rects: [REDACT_SECOND_PAGE_RECT] },
      ],
    },
    expectPages: 3,
    expectAbsentText: 'ACCT-4471-9930',
    expectBytes: ['PUBLIC-KEEP-0001', 'SHARED-7731'],
    expectAbsentBytes: [
      'ACCT-4471-9930',
      'PIN-2299-4417',
      'DOCINFO-REDACT-MARKER',
      'XMP-REDACT-MARKER',
      'ATTACHMENT-REDACT-MARKER',
    ],
    expectInkRegion: ['1,66,594,380,24'],
    expectBlankRegion: [REDACT_GAP_REGION],
  },
  {
    // The same removal with the metadata left alone, which is what proves the three options in §2 are three decisions:
    // the secret is gone from the page and still present in the file's bytes, in the same job. A handler that treated
    // `removeMetadata` as decoration would fail the presence half; one that always stripped would fail it too.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: {
      regions: [{ page: 1, rects: [REDACT_SECRET_RECT] }],
      removeMetadata: false,
      removeAttachments: false,
    },
    expectPages: 3,
    expectAbsentText: 'ACCT-4471-9930',
    expectBytes: ['ACCT-4471-9930', 'DOCINFO-REDACT-MARKER', 'XMP-REDACT-MARKER', 'ATTACHMENT-REDACT-MARKER'],
    expectInkRegion: ['1,66,594,380,24'],
  },
  {
    // Visual-only masking, and the warning is the assertion rather than the tolerance: `REDACTION_NOT_REMOVED` has to
    // be there, and the text has to still extract, because a warning that is not backed by the file is a lie and a
    // masking job whose text vanished would be a different tool than the one that was asked for.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: { regions: [{ page: 1, rects: [REDACT_SECRET_RECT] }], removeContent: false },
    expectText: 'ACCT-4471-9930',
    expectInkRegion: ['1,66,594,380,24'],
    expectWarnings: ['REDACTION_NOT_REMOVED'],
  },
  {
    // A rectangle off the page: a coordinate mistake, refused with nothing written rather than reported as a job that
    // removed the content under it.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: { regions: [{ page: 1, rects: [{ x: 66, y: 900, w: 380, h: 24 }] }] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // A rectangle on a page that does not exist. The contract cannot see this one — it has no idea how long the
    // document is — so it is the case that proves the *worker* re-checks the geometry it is handed.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: { regions: [{ page: 99, rects: [REDACT_SECRET_RECT] }] },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // The byte half of the verification, aimed at the one failure a text layer cannot see: the value the box covers is
    // drawn on the page, and a **second copy** of the same value sits in a stream nothing reads — reached from the page
    // dictionary rather than from `/Contents`, and carried as a `<hex>` string. The job must refuse, and the refusal is
    // the point: the page copy was removed correctly and the file still holds what the user marked, in a spelling only
    // a hex-decoding byte search reads. This case is what makes the handler's `hex` haystack load-bearing — the
    // falsification claim `redact-hex-copy-is-a-leak` drops that haystack and watches this same document complete.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-carrier-hex.pdf'],
    options: { regions: [{ page: 1, rects: [{ x: 64, y: 652, w: 260, h: 40 }] }] },
    expectError: 'CONVERSION_FAILED',
    expectErrorMessage: 'can still be found in the output',
  },
  {
    // §6's ceiling, refused at the contract: 209 rectangles across 11 pages groups is under the per-page limit and over
    // the job's, which is exactly the arithmetic a naive per-page check misses.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: {
      regions: Array.from({ length: 11 }, () => ({
        page: 1,
        rects: Array.from({ length: 19 }, () => REDACT_SECRET_RECT),
      })),
    },
    expectError: 'VALIDATION_ERROR',
  },
  {
    // A page with no text layer at all: there is nothing extractable to remove, so the job paints the box and says so.
    // Without that sentence a user would reasonably conclude the black rectangle had erased the pixels under it.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['ocr-scan-eng-raster.pdf'],
    options: { regions: [{ page: 1, rects: [{ x: 66, y: 400, w: 380, h: 40 }] }] },
    expectInkRegion: ['1,66,400,380,40'],
    expectWarnings: ['IMAGE_ONLY_PAGE'],
  },
  {
    // A document that really carries a signature: any content change invalidates it, and the warning is the whole
    // point of the case. The fixture is checked at generation time to have a `/Sig` field and a `/ByteRange`, and the
    // unsigned fixture is checked to have neither — otherwise this case would pass against any file at all.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: { regions: [{ page: 1, rects: [REDACT_SECRET_RECT] }] },
    expectAbsentText: 'ACCT-4471-9930',
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // An annotation sitting inside a marked area, on the form fixture that already has one (the highlight at 72,430).
    // A highlight over a redacted value still shows it, so the default deletes it and counts what it deleted — seven
    // annotations in, six out, and the widget tree of the rest of the form is not what this case is about.
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: { regions: [{ page: 1, rects: [{ x: 72, y: 430, w: 248, h: 14 }] }] },
    expectAnnotationCount: 6,
    expectWarnings: ['ANNOTATION_REMOVED'],
  },
  {
    // The same job with the scrub switched off, and the pair (seven in the file against six above) is what makes the
    // option real rather than decorative. Measured, and it corrected the assumption this case was first written on:
    // PyMuPDF's `apply_redactions` does **not** remove an annotation whose area it rewrites — the highlight stays — so
    // with the scrub off the mark survives and the job reports no removal at all. The invalidation warning is **not**
    // reported here, and that is correct rather than incidental: this fixture's `/FT /Sig` is an empty placeholder, so
    // there is no signature for the rewrite to invalidate (the gate is `signatureValues`; see the pair at the end).
    tool: 'redact',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: { regions: [{ page: 1, rects: [{ x: 72, y: 430, w: 248, h: 14 }] }], scrubAnnotations: false },
    expectAnnotationCount: 7,
  },

  // ── `ELECTRONIC_SIGNATURE_INVALIDATED`, from the other four tools that rewrite a document ──────────────────────
  //
  // A signature's `/ByteRange` covers the file's bytes, so there is no such thing as editing a signed contract and
  // keeping the signature: `redact` was the first tool to say so, and these four make the same claim on the same
  // fixture. Each signed case is paired with an **unsigned twin**, because a warning asserted only in the positive
  // direction is a sentence about the handler rather than about the input — one that printed it for every file would
  // pass every case above.
  {
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: { elements: [{ type: 'text', page: 1, x: 66, y: 520, text: 'DRAFT', size: 18 }] },
    expectPages: 3,
    expectText: 'DRAFT',
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'edit-pdf',
    pool: 'light',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: { elements: [{ type: 'text', page: 1, x: 66, y: 520, text: 'DRAFT', size: 18 }] },
    expectPages: 3,
    expectText: 'DRAFT',
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // A mark is not a content edit — it is an object added to the file — and it invalidates a signature all the same,
    // because the bytes the signature covers are no longer the bytes it was computed over.
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: {
      annotations: [
        { type: 'underline', page: 1, rects: [{ x: 66, y: 544, width: 380, height: 19 }], color: '#000000' },
      ],
    },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'annotate',
    pool: 'light',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: {
      annotations: [
        { type: 'underline', page: 1, rects: [{ x: 66, y: 544, width: 380, height: 19 }], color: '#000000' },
      ],
    },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // The one where the sentence is least obvious and most needed: the *only* thing this job changes is the metadata
    // the signature's byte range covers, and a user who strips it from a signed contract has invalidated the signature
    // without touching a mark on the page.
    tool: 'remove-metadata',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'remove-metadata',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // The field *beside* the signature, which is what the fixture's `ApprovedBy` text field exists for: the value is
    // written into the form and the signature it was written next to is reported as gone.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: { fields: { ApprovedBy: 'Boni Pratama' }, flatten: false },
    expectText: 'Boni Pratama',
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // The negative direction, and the reason the gate reads `signatureValues` rather than `signatureObjects`: this
    // fixture carries a real `/FT /Sig` **placeholder** — the box a signer will eventually fill — and nothing in it is
    // signed, so warning here would be a sentence about a signature that does not exist.
    tool: 'fill-form',
    pool: 'heavy',
    plan: 'pro',
    files: ['form-five-fields-a4.pdf'],
    options: { fields: { employee_name: 'Boni Pratama' }, flatten: false },
    expectText: 'Boni Pratama',
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },

  // ── The same sentence from the rest of the tools that hand back *the same document*, rewritten ──────────────────
  //
  // The line this block draws, and it is a judgment rather than a mechanical rule: these tools **replace** the document
  // the user gave them — a crop box written, a number stamped, the file re-encrypted — so a signature inside it is
  // invalidated by the job and the sentence belongs on the result. The page-*composition* tools (`merge`, `split`,
  // `extract-pages`, `delete-pages`, `reorder-pages`, `images-to-pdf`) are deliberately outside it: they assemble a
  // different document from pages, and a user extracting three pages of a signed contract is not asking for those
  // three pages to keep the signature — the original they hold still does. `unlock` is outside it for a mechanical
  // reason recorded in `0-IMPLEMENTATION-STATUS.md` §6: its input cannot be opened without the password the job itself
  // carries, so running the check in it would fail jobs that work today.
  {
    tool: 'crop',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { box: { top: 20, right: 20, bottom: 20, left: 20 }, units: 'mm' },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'crop',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { box: { top: 20, right: 20, bottom: 20, left: 20 }, units: 'mm' },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'rotate',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { angle: 90 },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
    // The angle itself, which no earlier case ever asserted: `/Rotate` changes no page count, no text and no page size,
    // so all three of `rotate`'s cases passed for a job that wrote nothing (pass 5, defect 141).
    expectPageRotate: { 1: 90, 2: 90, 3: 90 },
  },
  {
    tool: 'rotate',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { angle: 90 },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // A *selection*: the page named gets the rotation and the others keep theirs. The pair of angles is the assertion —
    // "page 2 is 90°" alone is also true of a job that rotated the whole document.
    tool: 'rotate',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { angle: 270, pages: ['2'] },
    expectPages: 6,
    expectPageRotate: { 1: 0, 2: 270, 3: 0 },
  },
  {
    // `perPage`, the option §2.2 documents and nothing had ever exercised: two different angles in one job, which qpdf can
    // only do as two invocations over the same file (the handler groups by angle for exactly that reason). `pages` is
    // supplied as well, so the case also pins the documented precedence *and* the warning that says which of the two the
    // job used — page 1 must stay unrotated even though it was selected.
    tool: 'rotate',
    pool: 'light',
    files: ['pages-six-a4.pdf'],
    options: { perPage: { '2': 180, '5': 270 }, pages: ['1'] },
    expectPages: 6,
    expectPageRotate: { 1: 0, 2: 180, 3: 0, 5: 270, 6: 0 },
    expectWarnings: ['PAGES_IGNORED'],
  },
  {
    // The one case that exercises the *reference* half of the structural invariant on a real handler: the page it
    // removes is the page the document's form lives on, so a page-selection tool that dropped the page but kept the
    // `/AcroForm` would fail here with a field naming a page the tree does not have (defect 83's shape, one tool over).
    // Measured: qpdf drops the field with its page, the output is clean, and no signature warning is owed — this is a
    // page-composition tool, which hands back a *different* document (see §6 of the status doc for the boundary).
    tool: 'delete-pages',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { pages: ['1'] },
    expectPages: 2,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // Two sheets are composed and the file holds **two** page objects, which is the assertion this pair was written
    // for: before defect 83 the signed fixture gave two sheets and *three* page objects, because the signature field's
    // `/P` still named page 1 from an `/AcroForm` the trailer reached — the object, and its bytes, outlived the page
    // tree that stopped listing it. Readers follow the tree, so only a check on the bytes sees it, and only this input
    // can show it: the twin below has no form and never had the extra object.
    tool: 'n-up',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { perSheet: 2, pageSize: 'a4', orientation: 'portrait' },
    expectPages: 2,
    expectMetrics: { sheets: 2, placed: 3, acroFormDropped: true },
    // Both warnings are owed here and for different reasons: the file was rewritten, and the form was not carried.
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED', 'FORM_FIELDS_DROPPED'],
  },
  {
    // The twin, and the control for the comment above: the *same document* without a form loses its originals cleanly,
    // so two sheets are two page objects. The difference between the two cases is one `/FT /Sig` field — and with it
    // the `FORM_FIELDS_DROPPED` warning, which must not appear on a document that has no form to drop.
    tool: 'n-up',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { perSheet: 2, pageSize: 'a4', orientation: 'portrait' },
    expectPages: 2,
    expectMetrics: { sheets: 2, placed: 3, acroFormDropped: false },
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED', 'FORM_FIELDS_DROPPED'],
  },
  {
    tool: 'watermark',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { kind: 'text', text: 'CONFIDENTIAL', opacity: 0.25, rotation: 0 },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'watermark',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { kind: 'text', text: 'CONFIDENTIAL', opacity: 0.25, rotation: 0 },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'header-footer',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { footer: { center: 'Confidential' }, marginMm: 12 },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'header-footer',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { footer: { center: 'Confidential' }, marginMm: 12 },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'page-numbers',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { format: 'page-n-of-total', position: 'bottom-center' },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'page-numbers',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { format: 'page-n-of-total', position: 'bottom-center' },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // Restructuring rather than editing: not a byte of content changes and the signature still stops verifying, because
    // linearization moves the objects the `/ByteRange` offsets point at.
    tool: 'linearize',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    expectPages: 3,
    expectLinearized: true,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'linearize',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    expectPages: 3,
    expectLinearized: true,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: { userPassword: 'e2e-user-secret', encryption: 'aes-256', permissions: { copy: false } },
    expectEncrypted: true,
    expectOpensWith: 'e2e-user-secret',
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'encrypt',
    pool: 'light',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: { userPassword: 'e2e-user-secret', encryption: 'aes-256', permissions: { copy: false } },
    expectEncrypted: true,
    expectOpensWith: 'e2e-user-secret',
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // The only case that supplies an `ownerPassword` rather than letting the engine generate one, and it exists for
    // the *audit* rather than for the tool: `restrict` declares `ownerPassword` a secret, and a declaration no case
    // ever exercises is a declaration the durable-record check never runs against (0-SECURITY.md §7.1). Everything
    // this case asserted before is unaffected — the owner password decides who may *change* the restrictions, not
    // whether the file opens without a password — so the cost of covering the third key was one line.
    tool: 'restrict',
    pool: 'light',
    plan: 'pro',
    files: ['redact-signed-a4.pdf'],
    options: {
      ownerPassword: 'e2e-owner-secret',
      encryption: 'aes-256',
      permissions: { copy: false, modify: false },
    },
    expectEncrypted: true,
    expectOpenWithoutPassword: true,
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'restrict',
    pool: 'light',
    plan: 'pro',
    files: ['redact-secret-a4.pdf'],
    options: { encryption: 'aes-256', permissions: { copy: false, modify: false } },
    expectEncrypted: true,
    expectOpenWithoutPassword: true,
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    // `compress` needs **two** cases on the same signed input, because it has a branch that hands the file back
    // untouched and the pair is the only way to see it: measured on this fixture, the default job strips the metadata
    // (3 289 bytes) and then linearises (3 818 bytes), which is *larger* than the input, so the never-bigger rule
    // returns the original **byte for byte** — and a signature in it is therefore still valid, so the warning must be
    // absent. Without `--expect-identical-input` nothing but a page count stands behind that sentence.
    tool: 'compress',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    expectPages: 3,
    expectWarnings: ['NO_SAVINGS'],
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
    expectIdenticalInput: 1,
  },
  {
    // The other branch, reached by dropping the linearisation pass that made the file bigger: 3 289 < 3 796, so this
    // output *is* a rewrite and the warning is owed. The pair is the assertion — one fixture, one tool, two branches,
    // and the warning tracks the branch rather than the tool's name.
    tool: 'compress',
    pool: 'light',
    files: ['redact-signed-a4.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectPages: 3,
    expectWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  {
    tool: 'compress',
    pool: 'light',
    files: ['redact-secret-a4.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectPages: 3,
    expectAbsentWarnings: ['ELECTRONIC_SIGNATURE_INVALIDATED'],
  },
  // ── `targetSizeMb`, the one mode with a loop in it, and it had no case at all ──────────────────────────────────
  //
  // The fixture is a page-sized JPEG of plasma noise that Ghostscript passes straight through, so no rung of the ladder
  // can make it smaller — verified when the fixture is generated, not assumed here. That makes the two halves of the
  // documented search measurable on the same file: a target above the document's own size stops after **one** pass, and a
  // target below what the ladder's floor can reach walks **all four** rungs and says so.
  {
    tool: 'compress',
    pool: 'light',
    files: ['compress-noise-a4.pdf'],
    options: { preset: 'recommended', targetSizeMb: 5 },
    expectPages: 1,
    // One attempt is the whole claim: the search stops at the first rung that fits rather than walking the ladder to the
    // floor, because every later rung is worse quality for no reason.
    expectMetrics: { targetReached: true, attempts: 1, rungs: 4, targetSizeMb: 5 },
    expectAbsentWarnings: ['TARGET_SIZE_UNREACHED'],
    // And the never-bigger rule holds on an image-heavy file too: the passthrough JPEG comes out no smaller, so the
    // original bytes are returned — with the warning that says so, and without invalidating anything.
    expectWarnings: ['NO_SAVINGS'],
    expectIdenticalInput: 1,
  },
  {
    tool: 'compress',
    pool: 'light',
    files: ['compress-noise-a4.pdf'],
    options: { preset: 'recommended', targetSizeMb: 0.05 },
    expectPages: 1,
    // Four attempts is the documented cap (`docs/04-COMPRESS.md` §4: "never more than four"), and `rungs` is here so a
    // future ladder with six rungs cannot quietly run six passes and still satisfy this case.
    expectMetrics: { targetReached: false, attempts: 4, rungs: 4, targetSizeMb: 0.05 },
    expectWarnings: ['TARGET_SIZE_UNREACHED', 'NO_SAVINGS'],
    expectIdenticalInput: 1,
  },
  {
    // The outline, through the rewrite rather than around it: `04-COMPRESS.md` §6 claims bookmarks survive, and
    // until pass 5 nothing measured it. `linearize: false` is what puts the job on the rewrite branch (the default
    // job grows this fixture and hands the input back byte for byte, which would prove nothing about Ghostscript).
    tool: 'compress',
    pool: 'light',
    files: ['bookmark-toc.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectPages: 3,
    expectOutline: ['Chapter 1'],
  },
  // ── the interactive form, which this rewrite cannot carry ────────────────────────────────────────────────────
  //
  // `04-COMPRESS.md` §6 promised "annotations and forms preserved (-dPreserveAnnots=true); form fields are not
  // flattened". Measured through Ghostscript's `pdfwrite`: six widgets and the `/AcroForm` dictionary leave the file,
  // a `/Highlight` on the same page stays, and the job said nothing (defect 144). The two cases below are the pair
  // that makes the warning a statement about the *input*: the fixture that has a form reports it, its formless twin
  // does not, and the absence of `/AcroForm` in the delivered bytes is what the sentence claims.
  {
    tool: 'compress',
    pool: 'light',
    files: ['form-five-fields-a4.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectPages: 1,
    expectWarnings: ['FORM_FIELDS_DROPPED'],
    expectAbsentBytes: ['/AcroForm'],
    expectMetrics: { formFields: 6, acroFormDropped: true },
  },
  {
    tool: 'compress',
    pool: 'light',
    files: ['compress-text-a4.pdf'],
    options: { stripMetadata: true, linearize: false },
    expectPages: 4,
    expectAbsentWarnings: ['FORM_FIELDS_DROPPED'],
    expectMetrics: { formFields: 0, acroFormDropped: false },
  },
];

/** The sentinel the harness replaces with an uploaded file id, spelled once (`e2e/tool.e2e.ts`). */
const UPLOAD_SENTINEL = '@upload:';

/**
 * Fixture names an `@upload:` sentinel in the options names — the nested form the harness accepts, where a case puts
 * the upload inside an element rather than in `auxiliary`.
 *
 * Collected so a missing fixture is reported as **not run** with the command that generates it, which is the same
 * treatment `fixtures` entries get: a case that cannot run is a gap to print, never a product failure.
 */
function sentinelFixtures(options: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith(UPLOAD_SENTINEL)) found.push(value.slice(UPLOAD_SENTINEL.length).split('/').pop()!);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  walk(options);
  return found;
}

function parseArgs(): { pool: Pool | null; base: string } {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const pool = value('--pool');
  if (pool && !['light', 'office', 'heavy', 'ocr'].includes(pool)) {
    console.error(`unknown pool ${pool}; expected light, office, heavy, or ocr`);
    process.exit(2);
  }
  return { pool: (pool as Pool | undefined) ?? null, base: value('--base') ?? 'http://localhost:8080' };
}

/**
 * Run one suite, timing it and capturing what it printed.
 *
 * `tee`-style rather than `stdout: 'pipe'` alone: the output still has to reach the CI log as it happens, because the
 * interesting part of a failure is the lines *before* the summary. The summary line is parsed for the check count so
 * the artifact can say how much was actually asserted — and yields `null` if the format ever changes, rather than a
 * number nobody verified.
 */
async function runSuite(command: string[]): Promise<{ code: number; output: string; durationMs: number }> {
  const started = performance.now();
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return { code, output: `${stdout}\n${stderr}`, durationMs: Math.round(performance.now() - started) };
}

/**
 * The harness prints two summary shapes, and both have to be read:
 *
 *   split E2E passed — 18 checks against http://localhost:8080
 *   split E2E passed — the refusal was the point (7 checks against http://localhost:8080)
 *
 * The refusal form was not parsed until pass 3 (defect 129): thirty cases — every expected-rejection case in the
 * suite — reported `checks: null` while still counting as `passed`, so the headline number was quietly short of the
 * assertions actually made. `checksUnread` in the artifact was the tell and the run still exited 0; now an unread
 * count fails the run, because "the number nobody verified" is exactly what this project keeps finding.
 */
/** The last `count` non-empty lines of a run's output — what a failed suite is asked for in the artifact. */
function tailLines(output: string, count: number): string[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

function countChecks(output: string): number | null {
  const match = /— (?:the refusal was the point \()?(\d+) checks? against/.exec(output);
  return match ? Number(match[1]) : null;
}

async function main(): Promise<void> {
  const { pool, base } = parseArgs();

  // Before the first case, and before the summary line that promises a verdict: this suite runs as a caller with no
  // account, and on a stack that requires one every case would stop at its first upload. The verdict owed to a reader
  // is then one named gap, not a few hundred identical failures with the real defect buried inside them
  // (`e2e/lib/stack-gap.ts` explains the reasoning, and `docs/0-CICD.md` §3.10 how to read the line).
  await requireAnonymousUse(base, 'the golden suite drives every case as a caller with no account');

  const selected = CASES.filter((entry) => entry.skipped == null && (pool == null || entry.pool === pool));
  const skipped = CASES.filter((entry) => entry.skipped != null && (pool == null || entry.pool === pool));

  console.log(`pdf-tools golden suite → ${base}${pool ? ` (pool: ${pool})` : ' (all pools)'}\n`);

  const results: SuiteResult[] = [];

  // `merge` is the reference path and asserts page *order*, which the generic harness does not; it runs with the
  // light pool because that is the pool it lands on with two inputs.
  if (pool == null || pool === 'light') {
    console.log('── merge (reference suite) ──');
    const outcome = await runSuite(['bun', 'run', 'e2e/merge.e2e.ts', '--base', base]);
    results.push({
      suite: 'merge',
      tool: 'merge',
      pool: 'light',
      status: outcome.code === 0 ? 'passed' : 'failed',
      exitCode: outcome.code,
      durationMs: outcome.durationMs,
      checks: countChecks(outcome.output),
      files: [],
    });
    console.log('');
  }

  // A fixture that was never generated is not a product failure, so it must not be reported as one — and it must
  // not pass silently either. Each case declares the files it needs, and a missing one becomes "not run" with the
  // command that produces it. This is how `images-to-pdf` was found to be untested in CI: its fixtures are made by
  // `fixtures:images` (which needs a running worker), and nothing ran it.
  const missingFixtures = new Map<string, string[]>();
  for (const entry of selected) {
    const needed = [...entry.files, ...Object.values(entry.auxiliary ?? {}), ...sentinelFixtures(entry.options)];
    const absent = needed.filter((file) => !existsSync(join(FIXTURE_DIR, file)));
    if (absent.length > 0) missingFixtures.set(`${entry.tool} [${entry.pool}]`, absent);
  }

  for (const entry of selected) {
    const label = `${entry.tool} [${entry.pool}]`;
    const absent = missingFixtures.get(label);
    if (absent) {
      console.log(`── ${label} ──`);
      console.log(`  · not run — missing fixture(s): ${absent.join(', ')}`);
      console.log('');
      skipped.push({
        tool: entry.tool,
        pool: entry.pool,
        files: entry.files,
        // Every fixture-producing script, because a case can be blocked by any of them and the reader of this line is
        // usually someone who just pulled the branch.
        skipped: `missing fixture(s): ${absent.join(', ')} — run \`bun run fixtures\` plus \`fixtures:images\`, \`fixtures:compress\`, \`fixtures:large\`, \`fixtures:form\`, \`fixtures:redact\`, \`fixtures:scan\``,
      });
      continue;
    }

    console.log(`── ${label} ──`);
    const command = ['bun', 'run', 'e2e/tool.e2e.ts', '--base', base, '--tool', entry.tool];
    for (const file of entry.files) command.push('--file', join(FIXTURE_DIR, file));
    const options = { ...entry.options };
    for (const [option, fixture] of Object.entries(entry.auxiliary ?? {})) {
      options[option] = `@upload:${join(FIXTURE_DIR, fixture)}`;
    }
    if (entry.options || entry.auxiliary) command.push('--options', JSON.stringify(options));
    if (entry.plan) command.push('--plan', entry.plan);
    if (entry.expectKind) command.push('--expect-kind', entry.expectKind);
    if (entry.expectPages != null) command.push('--expect-pages', String(entry.expectPages));
    if (entry.expectParts != null) command.push('--expect-parts', String(entry.expectParts));
    for (const part of entry.expectPartPages ?? []) {
      command.push('--expect-part-pages', `${part.index}:${part.pages.join(',')}`);
    }
    if (entry.expectPartition != null) command.push('--expect-partition', String(entry.expectPartition));
    for (const part of entry.expectPartOutlines ?? []) {
      command.push('--expect-part-outline', `${part.index}=${part.title}`);
    }
    for (const part of entry.expectPartText ?? []) {
      command.push('--expect-part-text', `${part.index}=${part.text}`);
    }
    for (const part of entry.expectImageFormat ?? []) {
      command.push('--expect-image-format', `${part.index}=${part.format}`);
    }
    for (const part of entry.expectImageSize ?? []) {
      command.push('--expect-image-size', `${part.index}=${part.width}x${part.height}`);
    }
    for (const part of entry.expectImageBits ?? []) {
      command.push('--expect-image-bits', `${part.index}=${part.bits}`);
    }
    for (const part of entry.expectImageChannels ?? []) {
      command.push('--expect-image-channels', `${part.index}=${part.channels}`);
    }
    if (entry.expectNoArchive) command.push('--expect-no-archive');
    for (const title of entry.expectOutline ?? []) command.push('--expect-outline', title);
    for (const title of entry.expectAbsentOutline ?? []) command.push('--expect-absent-outline', title);
    if (entry.expectText) command.push('--expect-text', entry.expectText);
    if (entry.expectAbsentText) command.push('--expect-absent-text', entry.expectAbsentText);
    for (const page of entry.expectPageText ?? []) {
      command.push('--expect-page-text', `${page.index}=${page.text}`);
    }
    if (entry.expectSmaskImages != null) command.push('--expect-smask-images', String(entry.expectSmaskImages));
    if (entry.expectLinearized) command.push('--expect-linearized');
    if (entry.expectNoSignatureDictionary) command.push('--expect-no-signature-dictionary');
    for (const wanted of entry.expectBytes ?? []) command.push('--expect-bytes', wanted);
    for (const unwanted of entry.expectAbsentBytes ?? []) command.push('--expect-absent-bytes', unwanted);
    if (entry.expectPageSize) {
      command.push('--expect-page-size', `${entry.expectPageSize.widthPt}x${entry.expectPageSize.heightPt}`);
    }
    if (entry.expectImages != null) command.push('--expect-images', String(entry.expectImages));
    if (entry.expectError) command.push('--expect-error', entry.expectError);
    if (entry.expectErrorMessage) command.push('--expect-error-message', entry.expectErrorMessage);
    for (const name of entry.expectEntries ?? []) command.push('--expect-entry', name);
    for (const text of entry.expectArchiveText ?? []) command.push('--expect-archive-text', text);
    for (const text of entry.expectAbsentArchiveText ?? []) command.push('--expect-absent-archive-text', text);
    if (entry.expectCropBox) {
      command.push('--expect-crop-box', `${entry.expectCropBox.widthPt}x${entry.expectCropBox.heightPt}`);
    }
    for (const warning of entry.expectWarnings ?? []) command.push('--expect-warning', warning);
    for (const warning of entry.expectAbsentWarnings ?? []) command.push('--expect-no-warning', warning);
    if (entry.expectIdenticalInput != null) {
      command.push('--expect-identical-input', String(entry.expectIdenticalInput));
    }
    if (entry.expectQueue) command.push('--expect-queue', entry.expectQueue);
    for (const [path, wanted] of Object.entries(entry.expectMetrics ?? {})) {
      command.push('--expect-metric', `${path}=${JSON.stringify(wanted)}`);
    }
    for (const [path, floor] of Object.entries(entry.expectMetricsOver ?? {})) {
      command.push('--expect-metric-over', `${path}=${floor}`);
    }
    if (entry.requireUploadCeilingMb != null) {
      command.push('--require-upload-ceiling-mb', String(entry.requireUploadCeilingMb));
    }
    if (entry.expectFinalQueue != null) command.push('--expect-final-queue', entry.expectFinalQueue);
    for (const region of entry.expectInkRegion ?? []) command.push('--expect-ink-region', region);
    for (const region of entry.expectBlankRegion ?? []) command.push('--expect-blank-region', region);
    for (const [page, angle] of Object.entries(entry.expectPageRotate ?? {})) {
      command.push('--expect-page-rotate', `${page}=${angle}`);
    }
    for (const box of entry.expectMediaBoxes ?? []) {
      command.push('--expect-media-box', `${box.widthPt}x${box.heightPt}`);
    }
    if (entry.expectEncrypted != null)
      command.push(entry.expectEncrypted ? '--expect-encrypted' : '--expect-not-encrypted');
    if (entry.expectAlgorithm) command.push('--expect-algorithm', entry.expectAlgorithm);
    if (entry.expectOwnerPasswordRevealed) command.push('--expect-owner-password-revealed');
    if (entry.expectOpenWithoutPassword != null) {
      command.push(entry.expectOpenWithoutPassword ? '--expect-open-without-password' : '--expect-requires-password');
    }
    if (entry.expectOpensWith) command.push('--expect-opens-with', entry.expectOpensWith);
    for (const [path, wanted] of Object.entries(entry.expectJsonPaths ?? {})) {
      // JSON-encoded so a value that is a string, a number, `true` or `null` arrives as exactly that type; the harness
      // parses it back with `JSON.parse` and compares by deep equality.
      command.push('--expect-json-path', `${path}=${JSON.stringify(wanted)}`);
    }
    for (const [flag, allowed] of Object.entries(entry.expectPermissions ?? {})) {
      command.push('--expect-permission', `${flag}=${allowed ? 'yes' : 'no'}`);
    }
    for (const [subtype, count] of Object.entries(entry.expectAnnotations ?? {})) {
      command.push('--expect-annotation', `${subtype}=${count}`);
    }
    if (entry.expectAnnotationCount != null) {
      command.push('--expect-annotation-count', String(entry.expectAnnotationCount));
    }
    if (entry.expectAnnotationsPrint) command.push('--expect-annotations-print');
    for (const [page, count] of Object.entries(entry.expectQuadPoints ?? {})) {
      command.push('--expect-quad-points', `${page}=${count}`);
    }

    const outcome = await runSuite(command);
    // A case whose stack requirement this deployment does not meet did not run, and did not fail — the same verdict
    // shape as a missing fixture, for the same reason: neither is a statement about the product.
    if (outcome.code === STACK_GAP_EXIT_CODE) {
      const reason = stackGapReason(outcome.output) ?? 'the stack cannot carry this case';
      skipped.push({ tool: entry.tool, pool: entry.pool, files: entry.files, skipped: reason });
      console.log('');
      continue;
    }
    results.push({
      suite: label,
      tool: entry.tool,
      pool: entry.pool,
      status: outcome.code === 0 ? 'passed' : 'failed',
      exitCode: outcome.code,
      durationMs: outcome.durationMs,
      checks: countChecks(outcome.output),
      files: entry.files,
      ...(entry.options ? { options: entry.options } : {}),
      // A failed suite carries what it printed, because the artifact is the part of a run that survives.
      //
      // Measured, not theorised: one heavy-pool run had two `pdf-to-html` suites exit 1 in ~160 ms, and the artifact
      // recorded `exitCode: 1, checks: null` with **nothing else** — the reason was printed to a console nobody had
      // kept. The runner has always held the output (`runSuite` returns it) and used it for the check count and for
      // the one-line summary; writing it down on failure is the difference between "this case failed" and "this case
      // failed because …", which is the rule this stage already applies to itself in `assertRunningTheBuiltImage`.
      // Kept to the tail: what a failing case owes is the assertion it missed, and a passing case records nothing.
      ...(outcome.code === 0 ? {} : { output: tailLines(outcome.output, 40) }),
    });
    console.log('');
  }

  if (skipped.length > 0) {
    console.log('not run:');
    for (const entry of skipped) console.log(`  · ${entry.tool} — ${entry.skipped}`);
    console.log('');
  }

  const failures = results.filter((result) => result.status === 'failed');
  const report = {
    generatedAt: new Date().toISOString(),
    base,
    pool: pool ?? 'all',
    suites: results,
    notRun: skipped.map((entry) => ({ tool: entry.tool, pool: entry.pool, reason: entry.skipped })),
    totals: {
      suites: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      checks: results.reduce((sum, result) => sum + (result.checks ?? 0), 0),
      checksUnread: results.filter((result) => result.checks == null).length,
      durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
  };

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const artifact = join(ARTIFACT_DIR, `golden-${pool ?? 'all'}.json`);
  await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${artifact}`);

  if (failures.length > 0) {
    console.error(`golden suite failed: ${failures.map((f) => f.suite).join(', ')}`);
    process.exit(1);
  }
  console.log(
    `golden suite passed — ${results.length} suite(s) · ${report.totals.checks} checks · ${skipped.length} documented gap(s)`,
  );
  if (report.totals.checksUnread > 0) {
    const unread = results.filter((result) => result.checks == null).map((result) => result.suite);
    console.error(
      `\ngolden suite counted no checks for ${report.totals.checksUnread} suite(s), so ${report.totals.checks} is\nnot the number of assertions made — the summary line of each of these was unreadable:\n${unread.map((suite) => `  · ${suite}`).join('\n')}\nFix \`countChecks\` before trusting a total.`,
    );
    process.exit(1);
  }
}

await main();
