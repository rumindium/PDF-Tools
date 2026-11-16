// The marker and the rule are *shared* with the service rather than restated here, because a harness with its own
// idea of what "redacted" means would be testing that idea: `secretViolations` is the function the audit script
// uses, and `SECRET_PLACEHOLDER` is what the API writes. Which *keys* are secret comes from the running stack, not
// from this import — the catalog over HTTP is what proves the deployed build declares them (`docs/0-SECURITY.md` §5).
import { SECRET_PLACEHOLDER, secretViolations } from '@pdftools/contracts';
// The stash *key* is imported rather than spelled out here. A check that spelled it out would pass by looking at a
// name nothing writes to, and a check that cannot fail is documentation: renaming the key must move this assertion
// with it. Importing the module opens no connection — `redisConnection()` is lazy and nothing here calls it.
import { jobSecretsKey } from '@pdftools/queue';
import { readImageHeader } from './lib/image-inspect';
import { MISSING, parseJsonPathPair, readJsonPath } from './lib/json-path';
import {
  archiveEntryText,
  canonicalSubtype,
  countPdfImages,
  countPdfPages,
  countZipEntries,
  decodedPdfText,
  firstPageCropBox,
  firstPageMediaBox,
  hasLinearizationDict,
  pdfPageTexts,
  readAnnotationState,
  readEncryption,
  readOutlineAndInfo,
  readPageGeometry,
  readPdfHealth,
  readSignatureMarkers,
  repoRootFrom,
  searchableBytes,
} from './lib/pdf-inspect';
import { inkShare, parseRegion, renderPageGray } from './lib/render';
import { requireAnonymousUse, stackGap } from './lib/stack-gap';

// The container bridge spawns `docker compose` from the repository root, so the root has to be the host's own
// spelling of the path — `fileURLToPath`, because `URL.pathname` is `/D:/…` on Windows and a cwd that does not
// exist kills every spawn with ENOENT (`repoRootFrom` documents the hang that produced this line).
const REPO_ROOT = repoRootFrom(new URL('..', import.meta.url));

/**
 * The password the case itself declared, for the tools whose output is *supposed* to refuse to open.
 *
 * Without it an encrypted output reports "the walk could not run" — which is honest but useless, and worse, it is the
 * state a reader would have to interpret. With it, `encrypt`'s own output is walked like any other file, and the
 * reference check runs on the one family of jobs that encrypts.
 */
/**
 * Every bookmark title in an outline tree, at every level.
 *
 * At every level on purpose. A split part's outline is rebuilt from the source, and where an entry lands in the tree
 * depends on whether its parent's page is in the same part (a parent in another part hands its children up one
 * level). A check that only looked at the top level would call a correct part broken and a hoisted child missing.
 */
function outlineTitles(entries: Array<{ title: string; children: Array<{ title: string }> }>): string[] {
  const titles: string[] = [];
  const walk = (nodes: Array<{ title: string; children: unknown[] }>) => {
    for (const node of nodes) {
      titles.push(node.title);
      if (Array.isArray(node.children)) walk(node.children as Array<{ title: string; children: unknown[] }>);
    }
  };
  walk(entries as Array<{ title: string; children: unknown[] }>);
  return titles;
}

/** The page a titled entry points at, for the case that wants the number as well as the title. */
function entryTitlesAtPage(
  entry: { title: string; page: number | null; children: Array<{ title: string; page: number | null }> },
  title: string,
): number[] {
  const pages: number[] = [];
  const walk = (nodes: Array<{ title: string; page: number | null; children: unknown[] }>) => {
    for (const node of nodes) {
      if (node.title === title && node.page != null) pages.push(node.page);
      if (Array.isArray(node.children))
        walk(node.children as Array<{ title: string; page: number | null; children: unknown[] }>);
    }
  };
  walk([entry]);
  return pages;
}

function declaredUserPassword(options: Record<string, unknown>): string {
  const value = options.userPassword;
  return typeof value === 'string' ? value : '';
}

/**
 * The output's real text, via an engine rather than a regular expression.
 *
 * Returns `null` when no engine is reachable (no Docker, no running stack), which the caller treats as "fall back
 * to the byte search" rather than as a failure — the harness is still useful without containers, just weaker.
 */
async function extractTextWithEngine(bytes: Uint8Array): Promise<string | null> {
  try {
    const proc = Bun.spawn(['docker', 'compose', 'exec', '-T', 'worker-light', 'pdftotext', '-', '-'], {
      cwd: REPO_ROOT,
      stdin: bytes,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? stdout : null;
  } catch {
    return null;
  }
}

/**
 * Verify any one tool end to end, against a running stack.
 *
 *   bun run e2e/tool.e2e.ts --tool office-to-pdf --file fixtures/generated/office-to-pdf-report.txt
 *   bun run e2e/tool.e2e.ts --tool merge --file a.pdf --file b.pdf --expect-pages 5
 *   bun run e2e/tool.e2e.ts --tool pdf-to-pdfa --file a.pdf --options '{"profile":"9z"}' --expect-error VALIDATION_ERROR
 *   bun run e2e/tool.e2e.ts --tool page-numbers --file a.pdf --expect-text 'Page 4 of 4' \
 *                            --expect-absent-text 'Page 1 of 4'      # proves pages= skipped page 1
 *   bun run e2e/tool.e2e.ts --tool compress --file a.pdf --expect-identical-input 1   # byte-for-byte the input
 *
 * `merge` has its own suite because it is the reference path and asserts page *order*; this harness is the same
 * standard applied to every other tool, so verifying the remaining thirty is one command each rather than thirty
 * new scripts. What it refuses to accept:
 *
 *   - a job that ends in anything other than COMPLETED (or an explicitly expected error, via `--expect-error`);
 *   - a download with zero bytes, or a byte count that disagrees with what `/result` reported;
 *   - a PDF whose page count, read from the bytes, is 0 or differs from what the API claimed;
 *   - a PDF whose *structure* disagrees with itself: page objects in the file that its page tree does not list, which
 *     is invisible to every other check here and is how `n-up` kept pages it had removed (defect 83);
 *   - a ZIP with no entries;
 *   - text the tool was supposed to preserve, missing from the output — `--expect-text` is how "LibreOffice lost
 *     the document body" is caught rather than assumed away.
 *
 * The text check reads the PDF with `pdftotext` from the `worker-light` container when one is reachable, because a
 * font-subset PDF (LibreOffice, Tesseract, Ghostscript) stores text as glyph indices, not as ASCII — searching raw
 * bytes for a word those engines wrote finds nothing even when the words are right there and perfectly extractable.
 * Without a container it falls back to the byte-level search, which is honest for uncompressed PDFs and says so.
 *
 * An option may itself name an upload — a watermark image — written as `"@upload:<path>"`. The harness resolves those
 * through the ordinary upload endpoint before submitting, so a job that needs a second file is tested the way a
 * client would submit it rather than by hand-pasting an id.
 *
 * Exits non-zero with a readable reason on the first failed check.
 */

interface Args {
  base: string;
  tool: string;
  files: string[];
  options: Record<string, unknown>;
  timeoutSeconds: number;
  /** Evaluate this session as a plan (`free`/`pro`/`business`) — needs `DEV_PLAN_TOKEN` on the stack. */
  plan: 'free' | 'pro' | 'business' | null;
  planToken: string;
  expectPages: number | null;
  expectText: string | null;
  expectAbsentText: string | null;
  /**
   * A substring a **specific page** must contain, as `--expect-page-text 0=page 1 of 6` (0-based page index : text).
   *
   * The one assertion `expectText` cannot make, and the one `reorder-pages` needed: `expectText` concatenates the whole
   * document, so `1,2,3` and `3,2,1` produce the same string — a tool whose entire product is the arrangement of pages
   * was measured by a page count, and a page count cannot tell a reordered document from an untouched one. Read page by
   * page with poppler (`pdfPageTexts`), because the bytes of a content stream are not the answer to "what does page 3
   * say", and a reader written in this repository would agree with whatever the handler wrote.
   */
  expectPageText: Array<{ index: number; text: string }>;
  expectError: string | null;
  /**
   * Substrings the refusal's *message* must not contain, asserted when `expectError` matched.
   *
   * The code is half of a refusal and the sentence is the other half: a message that names the staging path, a
   * container path or another job is a leak with a correct status code attached, and every check that only read the
   * code passed. Used by `test:falsify` to keep the redaction of engine output load-bearing.
   */
  expectErrorAbsent: string[];
  /**
   * A substring the refusal's *message* must contain, asserted when `expectError` matched — `--expect-error-message`.
   *
   * Needed where one error code is the right answer for two different situations and which one happened is the whole
   * point. `images-to-pdf` refuses an undecodable HEIC with `UNSUPPORTED_CONTENT` under the default policy and refuses
   * any HEIC with the same code under the `reject` policy, and the two messages are what separates "we could not decode
   * this" from "your tenant policy says not to" — a distinction a code-only assertion flattens to one case.
   */
  expectErrorMessage: string | null;
  /** Entry names a ZIP/package must contain (`word/document.xml`, `ppt/slides/slide1.xml`, …). */
  expectEntries: string[];
  /** Strings the archive's *inflated* entries must contain — how an OOXML package is asserted at all. */
  expectArchiveText: string[];
  /**
   * Strings that must be *gone* from the inflated entries — the archive counterpart of `expectAbsentBytes`.
   *
   * Needed because the interesting OOXML facts are absences: `pdf2docx` writes a Word table and the paragraph builder
   * does not, and a spreadsheet whose first cell is a synthetic column index looks right until you open it.
   */
  expectAbsentArchiveText: string[];
  expectKind: string | null;
  /**
   * How many parts `/result` must list — `--expect-parts 1`.
   *
   * The count of *pages rendered*, which for a tool with a page selection is the option under test: a selection that
   * is silently ignored produces a six-part result for a one-page request, and every other check in this file (page
   * count, text, ink) passes because each part is a perfectly good image of a page nobody asked for.
   */
  expectParts: number | null;
  /**
   * Page numbers a part must declare, as `--expect-part-pages 0:3` (part index : the pages it came from).
   *
   * `pdf-to-images` numbers its parts `page-001…` over the *rendered* set, so a part's own `pages` is the only place
   * that says which page of the document it is. The placement canvas finds the image for the page it is showing by
   * reading exactly this field, which is why "labelled with its position instead of its page" is a product defect
   * rather than a cosmetic one.
   */
  expectPartPages: Array<{ index: number; pages: number[] }>;
  /**
   * The parts must **partition** the document: `--expect-partition 12` for a twelve-page input.
   *
   * The assertion a split needs and a page count cannot make. Every part is a perfectly good PDF containing
   * *some* pages, so dropping page 7, duplicating page 3 or renumbering the labels all pass `--expect-parts 3` and
   * `--expect-pages`. This reads every part's declared pages, requires each page of the input exactly once, and
   * downloads each part to check that the page objects in the file agree with the label — the disagreement that
   * made a merged document claim four pages while carrying six (defect 83).
   */
  expectPartition: number | null;
  /**
   * A bookmark title a part's own outline must carry, as `--expect-part-outline 0=Chapter 1` (part index : title).
   *
   * The half of a split that `qpdf --empty --pages` silently drops: a part is a **new** document, so its `/Outlines`
   * is absent and its `/Info` empty unless the handler puts them back. Nothing else here can see it — a part with no
   * bookmarks renders, extracts and counts exactly like one with them.
   */
  expectPartOutlines: Array<{ index: number; title: string }>;
  /**
   * A substring a **named part** of a multi-part result must contain, as `--expect-part-text 1=Check,Owner,Result`.
   *
   * Every text assertion in this file reads one part: the primary. That is enough while a tool's output is one file,
   * and it stops being enough the moment a job returns several — `pdf-to-csv` writes one CSV per table, so "the second
   * table is in the second file" is a claim nothing here could check, and a handler that wrote the first table into
   * every part would satisfy the part count, the row total in the metrics and the primary part's own bytes. The index
   * is the part's position in `/result`; the text is searched in that part's raw bytes (these outputs are text, so
   * the byte search *is* the content check — no engine is involved, and none should be).
   */
  expectPartText: Array<{ index: number; text: string }>;
  /**
   * The queue the job must be **accepted** on — `--expect-queue pdf-heavy`.
   *
   * Read from the `POST /jobs` response, not from the finished job, because the two mean different things: a job
   * created on `light` and moved to `heavy` later by the worker's re-check of the real input sizes also *ends* on
   * heavy. A pool is not cosmetic — it carries the time budget — so a routing rule that stopped applying would still
   * deliver a correct file, just on the smaller pool with the smaller deadline, and nothing else here would notice.
   */
  expectQueue: string | null;
  /**
   * The queue the job **finished** on — `--expect-final-queue pdf-heavy`.
   *
   * The companion to `--expect-queue`, and not a duplicate of it: that one reads the *acceptance* response, which is
   * the routing decision the API made from what it could see, while this one reads the job's own record after the
   * worker has re-checked the real input sizes (`workers/shared/src/runtime.ts` step 5). A job accepted on
   * `pdf-light` and finished on `pdf-heavy` is the one shape where the two differ, so a case *about* the second
   * decision has to assert the second answer — otherwise it passes on the strength of the first.
   */
  expectFinalQueue: string | null;
  /** A bookmark title the primary output's outline must carry, at any level (`--expect-outline 'Chapter 1'`). */
  expectOutline: string[];
  /** A bookmark title that must be **gone** from the primary output, read from its outline tree. */
  expectAbsentOutline: string[];
  /** How many soft-masked (transparent) images the output must contain — the alpha check for image watermarks. */
  expectSmaskImages: number | null;
  /**
   * The container a part is delivered in, as `--expect-image-format 0=png` (part index : format).
   *
   * The first thing about a rasterized output that can be wrong without any page count noticing: a job asked for WEBP
   * that returns PNG has the right number of parts, the right page labels and the right dimensions, and only the
   * bytes disagree. Read from the file's own header (`e2e/lib/image-inspect.ts`), not from the job's report.
   */
  expectImageFormat: Array<{ index: number; value: string }>;
  /**
   * The pixel dimensions a part must have, as `--expect-image-size 0=2480x3509`.
   *
   * This is how `dpi` and "rendered upright" are asserted at all. A page's `/Rotate` is applied by the renderer, so
   * the *only* trace of it in the output is that the image is landscape while the page box is portrait — which is why
   * the case uses a fixture whose four A4 pages each carry `/Rotate 90` and requires 842×595.
   */
  expectImageSize: Array<{ index: number; width: number; height: number }>;
  /**
   * The bit depth a part must declare, as `--expect-image-bits 0=1`.
   *
   * `colorMode: 'bw'` promised 1-bit output in the document while the PNG path copied the render through untouched,
   * so a black-and-white request produced 8-bit/color RGB and said so only in a warning (defect 127, pass 3). The bit
   * depth is the assertion that stops that from being a sentence again.
   */
  expectImageBits: Array<{ index: number; value: number }>;
  /** The channel count a part must declare, as `--expect-image-channels 0=1` — what `grayscale` means in bytes. */
  expectImageChannels: Array<{ index: number; value: number }>;
  /**
   * The result must **not** advertise an archive, and `?part=archive` must serve the part itself.
   *
   * The documented behaviour of a single-output job, and the rule that replaced the `zipSingle` option (defect 128):
   * `?part=archive` serves the one part rather than a one-entry ZIP or a 404, because a URL a client kept is not
   * allowed to become an error. Asserted rather than described, in both halves.
   */
  expectNoArchive: boolean;
  /** The output must carry a linearization dictionary at its head and qpdf must be able to walk it. */
  expectLinearized: boolean;
  /**
   * The output must carry **no** signature dictionary: no `/Type /Sig`, no `/FT /Sig`, no `/ByteRange`, no `/Perms`.
   *
   * `sign`'s honesty claim, asserted as an absence read from the file rather than trusted from the job's report: an
   * attached signature dictionary changes nothing about the rendered page, so no rendering check can see it.
   */
  expectNoSignatureDictionary: boolean;
  /** Literal strings that must be findable in the output's raw bytes or inflated streams (metadata, not text). */
  expectBytes: string[];
  /** Literal strings that must be gone from both — how "the author's name was removed" is proved. */
  expectAbsentBytes: string[];
  /**
   * The first page's size in points, as `WxH` — `--expect-page-size 841.89x595.28`. Used where the page *size* is the
   * option under test (page geometry, orientation), which no page count and no text search can see.
   */
  expectPageSize: { widthPt: number; heightPt: number } | null;
  /** At least this many image XObjects in the output — how "the referenced asset actually embedded" is proved. */
  expectImages: number | null;
  /**
   * Warning codes the completed job must carry.
   *
   * How a *limitation* is pinned down: `html-to-pdf` cannot suppress CSS backgrounds on this engine, and the only
   * thing standing between that fact and silent data loss is a warning. Asserting it means an option that appears to
   * do nothing cannot be "cleaned up" by deleting the warning instead of fixing the behaviour.
   */
  expectWarnings: string[];
  /**
   * Warning codes the completed job must **not** carry — the other half of `expectWarnings`.
   *
   * A case that only asserts a warning is present passes against the presence of *any* file that has a signature, and
   * says nothing about a job that reports the warning whether or not one is there. Pairing each signed case with an
   * unsigned one that must be silent is what makes the pair a fact about the input rather than about the handler's
   * willingness to print a sentence.
   */
  expectAbsentWarnings: string[];
  /**
   * The primary output must be **byte-for-byte** the *n*-th input (1-based) — `--expect-identical-input 1`.
   *
   * Exists because "the original file is returned unchanged" is a claim a tool makes about itself and nothing else here
   * can see: a page count, a text search and an ink measurement all pass for a re-encoded file too, and that difference
   * is exactly what a signature can feel. `compress`'s "never bigger" rule is the tool that needed it: the branch
   * returns the input verbatim, so a signature in it still verifies and the invalidation warning must be **absent**.
   */
  expectIdenticalInput: number | null;
  /**
   * Values the job's `metrics` must carry, at dotted paths — `--expect-metric sheets=2`.
   *
   * For a tool whose output is a PDF, `--expect-json-path` cannot reach the metrics: that flag reads the *downloaded
   * body*, which is only JSON when the tool's product is data. These are the numbers the worker reported about its own
   * work, which is the only place a claim like "two sheets were composed" is stated at all — the page count of a file
   * says how many page objects it contains, not how many sheets the job meant to make.
   */
  expectMetrics: Record<string, unknown>;
  /**
   * Metric paths that must be **above** a number — `--expect-metric-over inputBytes=104857600`.
   *
   * For a measurement whose exact value belongs to the fixture rather than to the product. `inputBytes` is the one
   * case today: the claim it makes ("the job received more than 100 MB") *is* the premise the escalation rule it is
   * testing rests on, so stating it as a threshold keeps the fixture as the single place the size is defined.
   */
  expectMetricsOver: Record<string, number>;
  /**
   * The upload ceiling this case needs the **stack** to have, in MB — `--require-upload-ceiling-mb 100`.
   *
   * Not a claim about the product: the fixture this case sends is bigger than the deployment's default
   * `MAX_FILE_SIZE_MB`, and an API that refuses it is configured correctly. Declaring the requirement turns that
   * refusal into a gap that names the setting (see `lib/stack-gap.ts`) instead of a failed case nobody can act on.
   */
  requireUploadCeilingMb: number | null;
  /**
   * The first page's `/CropBox` in points, as `WxH` — how a non-destructive crop is proved. The MediaBox has to be
   * unchanged in the same job, so a case asserts both; without the pair, "the crop worked" and "the crop did
   * nothing" are indistinguishable.
   */
  expectCropBox: { widthPt: number; heightPt: number } | null;
  /**
   * Regions, in PDF points, that must contain ink once the page is rendered — `--expect-ink-region 1,72,700,120,20`.
   *
   * The only check here that can see *placement*. A mark on the wrong page, or half off the page, extracts the same
   * text and counts the same pages, which is how the `n-up` rotation defect survived its own suite.
   */
  expectInkRegion: string[];
  /** Regions that must be blank, so "the mark is here and not there" is one case rather than two different kinds. */
  expectBlankRegion: string[];
  /**
   * Per-page `/Rotate`, keyed by 1-based page number — `--expect-page-rotate 2=180`.
   *
   * The assertion a rotation tool needs and nothing else in this file can make: rotating a page changes no page count,
   * no text and no page size. `rotate` had three cases before pass 5 and every one of them passed for a job that rotated
   * nothing at all.
   */
  expectPageRotate: Record<string, number>;
  /**
   * Every page's `/MediaBox`, in page-tree order — `--expect-media-box 100x200 --expect-media-box 200x300`.
   *
   * Written for `images-to-pdf`'s multi-frame TIFF promise (one page per frame, in frame order), which is a claim about
   * the *sequence* of sizes rather than about how many pages there are: four frames of four different sizes give four
   * pages whatever order they end up in.
   */
  expectMediaBoxes: Array<{ widthPt: number; heightPt: number }>;
  /**
   * Whether the output is encrypted, according to qpdf — `true` or `false`.
   *
   * The security tools' central claim, and the only one that cannot be seen in a page count or a text search: a
   * "protected" document that opens freely is byte-for-byte plausible. Both directions are asserted from the same
   * field, because "encryption was removed" is as much a claim as "encryption was applied".
   */
  expectEncrypted: boolean | null;
  /** The cipher poppler names in its own words (`AES-256`, `AES`, `RC4`). */
  expectAlgorithm: string | null;
  /** Whether the output opens with **no** password at all — `restrict`'s whole promise. */
  expectOpenWithoutPassword: boolean | null;
  /** A password the output must open with (poppler's `-upw`), proving the transport delivered what was typed. */
  expectOpensWith: string | null;
  /**
   * Permissions, keyed by the contract's flag names, that qpdf must read out of the output — `--expect-permission
   * copy=no`. Asserting a **denial** is the point: a restriction that was not applied reads as "allowed".
   */
  expectPermissions: Record<string, boolean>;
  /**
   * Whether this job must hand a generated value back to its caller — `--expect-owner-password-revealed`.
   *
   * The reveal channel's whole contract in one flag: the job produced an owner password nobody typed, so `?reveal=1`
   * must return it, a plain GET of the same job must not, the response that carries it must be marked `sensitive` and
   * `no-store`, the value must open the document as its owner, and it must be in no row of the database and in nothing
   * the stack printed. A case with no generated secret pays nothing and asserts nothing.
   */
  expectOwnerPasswordRevealed: boolean;
  /**
   * Annotation counts by `/Subtype`, as the output's own dictionaries report them — `--expect-annotation output=2`.
   *
   * The assertion that separates `annotate` from `edit-pdf`: a drawn rectangle and a highlight annotation look the
   * same on a rendered page and extract the same text, so every other check in this file passes for both. Reading the
   * subtype out of the file is the only way to know which one was written — and it is a check the harness could not
   * make with a byte search, because an annotation dictionary can live inside a compressed object stream.
   */
  expectAnnotations: Record<string, number>;
  /** The output's total annotation count — `0` is how "flattening added no dictionaries" is asserted. */
  expectAnnotationCount: number | null;
  /** Whether every annotation in the output carries `/F 4`. An unprintable mark is invisible on paper. */
  expectAnnotationsPrint: boolean;
  /**
   * `/QuadPoints` groups per page, as `--expect-quad-points 4=1`.
   *
   * A markup annotation without quad points is a rectangle a reader can select but cannot align to the text; the
   * count is what proves the four corners arrived, and the *order* of those corners is pinned by the engine's unit
   * tests (a wrong order rotates the mark, which no count and no ink region can see).
   */
  expectQuadPoints: Record<string, number>;
  /**
   * Values a **JSON body** must carry, at dotted paths — `--expect-json-path fields[0].name=employee_name`.
   *
   * `extract-fields` is the first tool whose product is data rather than a document, and "the output parses as JSON"
   * is the only thing a byte search cannot lie about but also cannot *strengthen*: an empty `{"fields": []}` parses.
   * A path check is the counterpart of `expectText` for a data output — the field name that must be there, the value
   * read out of the document, the warning that must not be. Compared with deep equality against the parsed body, so
   * `2` and `"2"`, or an array of one widget and an array of two, are different answers.
   */
  expectJsonPaths: Record<string, unknown>;
}

/**
 * `WxH` in points, from the command line.
 *
 * A malformed value is a harness usage error, not a product failure, so it exits rather than reporting a failed
 * check against the wrong number.
 */
function parsePageSize(value: string | undefined): { widthPt: number; heightPt: number } | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) {
    console.error(`--expect-page-size expects WxH in points, e.g. 841.89x595.28 (got ${JSON.stringify(value)})`);
    process.exit(2);
  }
  return { widthPt: Number(match[1]), heightPt: Number(match[2]) };
}

/**
 * `<index>=<value>` pairs for the image assertions, shared by the four of them.
 *
 * One parser rather than four, because the failure they have in common is a *quietly wrong index*: a case that says
 * `--expect-image-bits 1=1` when it meant part 0 asserts a bit depth about an image the case never looked at, and a
 * second copy of this code is where that drifts. A malformed value exits rather than reporting a failed check.
 */
function imageExpectations(specs: string[]): Array<{ index: number; value: string }> {
  return specs.map((spec) => {
    const separator = spec.indexOf('=');
    const index = separator < 0 ? Number.NaN : Number(spec.slice(0, separator));
    const value = separator < 0 ? '' : spec.slice(separator + 1);
    if (!Number.isInteger(index) || value.length === 0) {
      console.error(
        `--expect-image-* expects <index>=<value>, e.g. 0=png or 0=2480x3509 (got ${JSON.stringify(spec)})`,
      );
      process.exit(2);
    }
    return { index, value };
  });
}

/**
 * Whether the downloaded bytes begin with `signature` — compared as **bytes**, not as a string.
 *
 * The tests in this file were written as `bytes.subarray(0, 2).toString() === 'PK'`, which is a comparison a
 * `Uint8Array` can never satisfy: its `toString()` is the comma-separated list of code points, so the left side is
 * `"80,75"`. In a `Buffer` (where the idiom comes from — `apps/api/src/shared/multipart.ts` uses it on a boundary)
 * that call decodes to text and works; here it silently returned `false` every time. Two of the three sites were
 * harmless because their branches also test the declared kind; the ZIP one mattered the moment a branch depended on it
 * (defect 103).
 */
function startsWith(bytes: Uint8Array, signature: string): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature.charCodeAt(index)) return false;
  }
  return true;
}

/** An option value that means "upload this path first, and use the id" (`--options '{"imageFileId":"@upload:…"}'`). */
const UPLOAD_SENTINEL = '@upload:';

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const values = (flag: string): string[] => {
    const out: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === flag && argv[index + 1]) out.push(argv[index + 1]!);
    }
    return out;
  };

  const tool = value('--tool') ?? process.env.TOOL;
  if (!tool) {
    console.error("usage: bun run e2e/tool.e2e.ts --tool <id> --file <path> [--file <path>…] [--options '{}']");
    process.exit(2);
  }

  const files = values('--file');
  if (files.length === 0) {
    console.error('at least one --file is required');
    process.exit(2);
  }

  // `--expect-identical-input` with no number means the first file, and a number that is not a number (the flag followed
  // by another flag) means the same: the flag is a claim, the index is an optional detail.
  const identicalRaw = value('--expect-identical-input');
  const identicalParsed = identicalRaw === undefined ? Number.NaN : Number(identicalRaw);
  const identicalInputIndex = !argv.includes('--expect-identical-input')
    ? null
    : Number.isInteger(identicalParsed) && identicalParsed >= 1
      ? identicalParsed
      : 1;

  return {
    base: value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080',
    tool,
    files,
    options: value('--options') ? JSON.parse(value('--options')!) : {},
    timeoutSeconds: Number(value('--timeout')) || 180,
    plan: (value('--plan') as 'free' | 'pro' | 'business' | undefined) ?? null,
    planToken: value('--plan-token') ?? process.env.DEV_PLAN_TOKEN ?? 'dev-plan-token',
    expectPages: value('--expect-pages') ? Number(value('--expect-pages')) : null,
    expectText: value('--expect-text') ?? null,
    expectAbsentText: value('--expect-absent-text') ?? null,
    expectPageText: values('--expect-page-text').map((spec) => {
      const separator = spec.indexOf('=');
      const index = separator < 0 ? Number.NaN : Number(spec.slice(0, separator));
      const text = separator < 0 ? '' : spec.slice(separator + 1);
      if (!Number.isInteger(index) || text.length === 0) {
        console.error(`--expect-page-text expects <index>=<text>, e.g. 0=page 1 of 6 (got ${JSON.stringify(spec)})`);
        process.exit(2);
      }
      return { index, text };
    }),
    expectError: value('--expect-error') ?? null,
    expectErrorAbsent: values('--expect-error-absent'),
    expectErrorMessage: value('--expect-error-message') ?? null,
    expectEntries: values('--expect-entry'),
    expectArchiveText: values('--expect-archive-text'),
    expectAbsentArchiveText: values('--expect-absent-archive-text'),
    expectKind: value('--expect-kind') ?? null,
    expectParts: value('--expect-parts') ? Number(value('--expect-parts')) : null,
    expectPartition: value('--expect-partition') ? Number(value('--expect-partition')) : null,
    expectPartOutlines: values('--expect-part-outline').map((spec) => {
      const separator = spec.indexOf('=');
      const index = separator < 0 ? Number.NaN : Number(spec.slice(0, separator));
      const title = separator < 0 ? '' : spec.slice(separator + 1);
      if (!Number.isInteger(index) || title.length === 0) {
        console.error(`--expect-part-outline expects <index>=<title>, e.g. 0=Chapter 1 (got ${JSON.stringify(spec)})`);
        process.exit(2);
      }
      return { index, title };
    }),
    expectPartText: values('--expect-part-text').map((spec) => {
      const separator = spec.indexOf('=');
      const index = separator < 0 ? Number.NaN : Number(spec.slice(0, separator));
      const text = separator < 0 ? '' : spec.slice(separator + 1);
      if (!Number.isInteger(index) || text.length === 0) {
        console.error(
          `--expect-part-text expects <index>=<text>, e.g. 1=Check,Owner,Result (got ${JSON.stringify(spec)})`,
        );
        process.exit(2);
      }
      return { index, text };
    }),
    expectQueue: value('--expect-queue') ?? null,
    expectFinalQueue: value('--expect-final-queue') ?? null,
    expectOutline: values('--expect-outline'),
    expectAbsentOutline: values('--expect-absent-outline'),
    expectPartPages: values('--expect-part-pages').map((spec) => {
      const [index, pages] = spec.split(':') as [string, string | undefined];
      const parsedPages = (pages ?? '')
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((part) => Number.isInteger(part));
      if (!Number.isInteger(Number(index)) || parsedPages.length === 0) {
        console.error(`--expect-part-pages expects <index>:<page>[,<page>…], e.g. 0:3 (got ${JSON.stringify(spec)})`);
        process.exit(2);
      }
      return { index: Number(index), pages: parsedPages };
    }),
    expectImageFormat: imageExpectations(values('--expect-image-format')),
    expectImageSize: imageExpectations(values('--expect-image-size')).map(({ index, value }) => {
      const match = /^(\d+)x(\d+)$/.exec(value);
      if (!match) {
        console.error(`--expect-image-size expects <index>=<W>x<H>, e.g. 0=2480x3509 (got ${JSON.stringify(value)})`);
        process.exit(2);
      }
      return { index, width: Number(match[1]), height: Number(match[2]) };
    }),
    expectImageBits: imageExpectations(values('--expect-image-bits')).map(({ index, value }) => ({
      index,
      value: Number(value),
    })),
    expectImageChannels: imageExpectations(values('--expect-image-channels')).map(({ index, value }) => ({
      index,
      value: Number(value),
    })),
    expectNoArchive: argv.includes('--expect-no-archive'),
    expectSmaskImages: value('--expect-smask-images') ? Number(value('--expect-smask-images')) : null,
    expectLinearized: argv.includes('--expect-linearized'),
    expectNoSignatureDictionary: argv.includes('--expect-no-signature-dictionary'),
    expectBytes: values('--expect-bytes'),
    expectAbsentBytes: values('--expect-absent-bytes'),
    requireUploadCeilingMb: value('--require-upload-ceiling-mb') ? Number(value('--require-upload-ceiling-mb')) : null,
    expectPageSize: parsePageSize(value('--expect-page-size')),
    expectImages: value('--expect-images') ? Number(value('--expect-images')) : null,
    expectWarnings: values('--expect-warning'),
    expectAbsentWarnings: values('--expect-no-warning'),
    expectIdenticalInput: identicalInputIndex,
    expectMetrics: Object.fromEntries(
      values('--expect-metric').map((pair) => {
        const separator = pair.indexOf('=');
        if (separator < 1) {
          console.error(`--expect-metric expects <path>=<json>, got ${JSON.stringify(pair)}`);
          process.exit(2);
        }
        return [pair.slice(0, separator), JSON.parse(pair.slice(separator + 1))];
      }),
    ),
    expectMetricsOver: Object.fromEntries(
      values('--expect-metric-over').map((pair) => {
        const separator = pair.indexOf('=');
        if (separator < 1) {
          console.error(`--expect-metric-over expects <path>=<number>, got ${JSON.stringify(pair)}`);
          process.exit(2);
        }
        return [pair.slice(0, separator), Number(pair.slice(separator + 1))];
      }),
    ),
    expectCropBox: parsePageSize(value('--expect-crop-box')),
    expectInkRegion: values('--expect-ink-region'),
    expectBlankRegion: values('--expect-blank-region'),
    expectPageRotate: Object.fromEntries(
      values('--expect-page-rotate').map((pair) => {
        const separator = pair.indexOf('=');
        const page = separator < 0 ? Number.NaN : Number(pair.slice(0, separator));
        const angle = separator < 0 ? Number.NaN : Number(pair.slice(separator + 1));
        if (!Number.isInteger(page) || page < 1 || !Number.isFinite(angle)) {
          console.error(`--expect-page-rotate expects <page>=<degrees>, e.g. 2=180 (got ${JSON.stringify(pair)})`);
          process.exit(2);
        }
        return [String(page), angle];
      }),
    ),
    expectMediaBoxes: values('--expect-media-box').map((spec) => {
      const box = parsePageSize(spec);
      if (!box) {
        console.error(`--expect-media-box expects WxH in points, e.g. 100x200 (got ${JSON.stringify(spec)})`);
        process.exit(2);
      }
      return box;
    }),
    expectEncrypted: argv.includes('--expect-encrypted')
      ? true
      : argv.includes('--expect-not-encrypted')
        ? false
        : null,
    expectAlgorithm: value('--expect-algorithm') ?? null,
    expectOpenWithoutPassword: argv.includes('--expect-open-without-password')
      ? true
      : argv.includes('--expect-requires-password')
        ? false
        : null,
    expectOpensWith: value('--expect-opens-with') ?? null,
    expectOwnerPasswordRevealed: argv.includes('--expect-owner-password-revealed'),
    expectAnnotations: Object.fromEntries(
      values('--expect-annotation').map((pair) => {
        const [subtype, count] = pair.split('=');
        if (!subtype || Number.isNaN(Number(count))) {
          console.error(`--expect-annotation expects subtype=count, e.g. highlight=2 (got ${JSON.stringify(pair)})`);
          process.exit(2);
        }
        return [subtype, Number(count)];
      }),
    ),
    expectAnnotationCount: value('--expect-annotation-count') ? Number(value('--expect-annotation-count')) : null,
    expectAnnotationsPrint: argv.includes('--expect-annotations-print'),
    expectQuadPoints: Object.fromEntries(
      values('--expect-quad-points').map((pair) => {
        const [page, count] = pair.split('=');
        if (!page || Number.isNaN(Number(count))) {
          console.error(`--expect-quad-points expects page=count, e.g. 4=1 (got ${JSON.stringify(pair)})`);
          process.exit(2);
        }
        return [page, Number(count)];
      }),
    ),
    expectJsonPaths: Object.fromEntries(values('--expect-json-path').map(parseJsonPathArg)),
    expectPermissions: Object.fromEntries(
      values('--expect-permission').map((pair) => {
        const [flag, verdict] = pair.split('=');
        if (!flag || (verdict !== 'yes' && verdict !== 'no')) {
          console.error(`--expect-permission expects <flag>=yes|no, got ${pair}`);
          process.exit(2);
        }
        return [flag, verdict === 'yes'];
      }),
    ),
  };
}

/** One `--expect-json-path` argument, or a harness usage error rather than a failed check against the wrong path. */
function parseJsonPathArg(raw: string): [string, unknown] {
  const parsed = parseJsonPathPair(raw);
  if (!parsed) {
    console.error(`--expect-json-path expects <path>=<value>, e.g. fields[0].name=employee_name (got ${raw})`);
    process.exit(2);
  }
  return parsed;
}

const args = parseArgs();
const steps: string[] = [];
let cookie = '';

function step(text: string): void {
  steps.push(text);
  console.log(`  ✓ ${text}`);
}

function fail(reason: string, detail?: unknown): never {
  console.error(`\n  ✗ ${reason}`);
  if (detail !== undefined) {
    console.error(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
  }
  if (steps.length > 0) console.error(`\nreached:\n${steps.map((s) => `  · ${s}`).join('\n')}`);
  process.exit(1);
}

/**
 * The other half of a refusal: the sentence the user reads.
 *
 * A correct error code with a staging path in it is a leak, and a suite that only compares codes cannot tell the two
 * apart — this is the assertion `--expect-error-absent` carries, and the reason it is checked *before* the case is
 * declared passed.
 */
function assertRefusalMessageIsClean(message: string): void {
  const leaked = args.expectErrorAbsent.filter((needle) => message.includes(needle));
  if (leaked.length > 0) {
    fail(
      `the refusal message mentions ${leaked.map((needle) => JSON.stringify(needle)).join(', ')}, which is server state rather than the user's file`,
      message,
    );
  }
  if (args.expectErrorAbsent.length > 0) {
    step(`the refusal message carries none of ${args.expectErrorAbsent.join(', ')}: "${message}"`);
  }
}

/**
 * The positive half of the same sentence: `--expect-error-message <substring>`.
 *
 * For the case where a code alone cannot say which refusal happened — two policies that both end in
 * `UNSUPPORTED_CONTENT` and differ in what they mean for the caller. Substring rather than equality so a case does not
 * restate the whole sentence, and case-insensitive because the sentence is prose and a capitalization change is not a
 * behaviour change.
 */
function assertRefusalMessageSays(message: string): void {
  if (!args.expectErrorMessage) return;
  if (!message.toLowerCase().includes(args.expectErrorMessage.toLowerCase())) {
    fail(`the refusal message should mention ${JSON.stringify(args.expectErrorMessage)}`, { message });
  }
  step(`the refusal explains itself: "${message}"`);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  // `--plan pro` asks the API to evaluate this session as that plan. It only has an effect on a dev/test stack that
  // set `DEV_PLAN_TOKEN` — a production process refuses the header and refuses to boot with the token set — so a case
  // that needs a gated tool is expressed as "this caller is Pro" and cannot quietly pass on a stack where nobody is.
  if (args.plan) {
    headers.set('x-dev-plan', args.plan);
    headers.set('x-dev-plan-token', args.planToken);
  }
  const response = await fetch(`${args.base}${path}`, { ...init, headers, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    if (pair?.startsWith('pdft_session=')) cookie = pair;
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  const text = await response.text();
  if (!response.ok) {
    fail(`${init?.method ?? 'GET'} ${path} returned ${response.status}`, text.slice(0, 600));
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

interface HealthView {
  status: string;
  checks?: {
    pools?: Record<string, { workers: number; queueDepth: number }>;
  };
}

interface CatalogTool {
  id: string;
  title: string;
  queue: string;
  enabled: boolean;
  available: boolean;
  requiresPlan?: string[];
  output: { kind: string; mime: string; archive?: boolean };
  input: { accepts: string[]; minFiles: number; maxFiles: number };
  /** Uploads the tool needs beyond its documents, named by option (`ToolAuxiliaryFile`). */
  auxiliaryFiles?: Array<{ option: string; label: string; accepts: string[] }>;
  /** Option keys whose values this build never persists. Read from the API, not from the local checkout. */
  secrets?: string[];
}

interface JobView {
  id: string;
  status: string;
  progress: number;
  phase: string;
  /**
   * The queue **name** the job was accepted on, as the job's own record spells it.
   *
   * Present so that this process can hold the acceptance response and the record to the same spelling — see the check
   * after `waitForJob`, which exists because they once disagreed (`heavy` on submit, `pdf-heavy` on read).
   */
  queue: string;
  output: { bytes: number; pages: number | null; parts: number; name: string } | null;
  error: { code: string; message: string } | null;
  warnings: Array<{ code: string; detail?: string }>;
  metrics?: Record<string, unknown>;
}

async function upload(path: string, accepts: string[]): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const name = path.split('/').pop()!;
  const form = new FormData();
  form.append('kind', 'input');
  form.append('file', new File([bytes], name, { type: 'application/octet-stream' }));

  const response = await call('/api/v1/files', { method: 'POST', body: form });
  const text = await response.text();
  if (response.status !== 201) {
    // A refusal for **size** is the API enforcing the deployment's ceiling, and a case that needs to be bigger than
    // that ceiling cannot run here. Reported as a gap rather than a failure — see `lib/stack-gap.ts` — but only when
    // the case asked for it, so every other upload refusal stays a failure.
    if (args.requireUploadCeilingMb != null && /FILE_TOO_LARGE|JOB_SIZE_EXCEEDED/.test(text)) {
      stackGap(
        `this case needs a stack that accepts a ${args.requireUploadCeilingMb} MB upload, and this one refused a ${(
          bytes.length / 1024 / 1024
        ).toFixed(1)} MB file`,
        'raise `MAX_FILE_SIZE_MB` for the api service and restart it (`docs/0-TESTING.md` §4) — the product is right and the stack is small',
      );
    }
    fail(`uploading ${name} returned ${response.status}`, text.slice(0, 600));
  }

  const body = JSON.parse(text) as { id: string; detectedType: string };
  if (!accepts.includes(body.detectedType)) {
    fail(`${name} was detected as ${body.detectedType}, which this tool does not accept`, {
      accepts,
    });
  }
  return body.id;
}

async function waitForJob(jobId: string): Promise<JobView> {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let last: JobView | null = null;
  let lastPhase = '';

  while (Date.now() < deadline) {
    const job = await json<JobView>(`/api/v1/jobs/${jobId}`);
    last = job;
    const phase = `${job.status}/${job.phase}`;
    if (phase !== lastPhase) {
      console.log(`    · ${phase} ${job.progress}%`);
      lastPhase = phase;
    }
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') return job;
    await Bun.sleep(400);
  }

  fail(`the job did not finish within ${args.timeoutSeconds}s`, last);
}

/**
 * Run one statement against the stack's own Postgres and return its rows.
 *
 * Deliberately the *container*, not a connection from this process: the question is what the deployed service wrote
 * to the database it actually uses, and a host-side connection would be a second thing that could be pointed at a
 * different database than the one the API is talking to.
 */
async function psqlRows(sql: string): Promise<string[][] | null> {
  try {
    const proc = Bun.spawn(
      [
        'docker',
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'pdftools',
        '-d',
        'pdftools',
        '-tA',
        '-F',
        '\u0001',
        '-c',
        sql,
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      // Distinguishing "no such container" from "the query was wrong" matters: the first is a stack the audit
      // cannot run against, the second is a bug in this file, and they must not read the same in the output.
      if (/No such service|is not running|Cannot connect to the Docker daemon/i.test(stderr)) return null;
      fail('the secrets audit could not run against the stack database', stderr.slice(0, 400));
    }
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('\u0001'));
  } catch {
    return null;
  }
}

/**
 * The durable-record audit (`docs/0-SECURITY.md` §5) — the one claim about a password that no download can test.
 *
 * It runs for any case whose options carry a value the *running build* declares as a secret, and it asks four
 * questions in order of how embarrassing a "yes" would be:
 *
 *   1. is the value in this job's row at all?
 *   2. is it in *any* row for this tool — including rows written before this mechanism existed?
 *   3. is the service still holding it, now that the job has ended?
 *   4. did any container print it, where `docker logs` would hand it to whoever runs the host?
 *
 * (2) is the reason this is a table scan rather than a per-case assertion, and the reason the answer can be checked
 * without knowing the password: the API stores a placeholder, so "this column holds a declared secret that is not the
 * placeholder" is a question about the record alone. (3) is what makes the stash's lifetime a claim rather than an
 * intention — an expired key and a purged key look identical from here, and both are acceptable, but a key that is
 * *still there* after the job finished is neither. (4) is the only one of the four that is not about a store: a
 * command line lives for as long as one engine process, and what can still be inspected afterwards is the output the
 * stack wrote, which is where an engine's own error text ends up.
 */
async function auditDurableRecord(
  tool: CatalogTool,
  options: Record<string, unknown>,
  jobId: string,
  /** ISO timestamp captured just before the job was created — the window the printed-surface check reads. */
  jobWindowStart: string,
): Promise<void> {
  const declared = tool.secrets ?? [];
  const provided = declared.filter((key) => options[key] != null);
  if (provided.length === 0) return;

  const rows = await psqlRows(`select id, options::text from jobs where tool = '${tool.id}'`);
  if (rows === null) {
    step('the stack database was not reachable, so the durable record was not audited');
    return;
  }
  const parsed = rows.map(([id, json]) => [id, JSON.parse(json ?? '{}') as Record<string, unknown>] as const);
  const mine = parsed.find(([id]) => id === jobId);
  if (!mine) fail(`the job's own row was not found in the database after it ended`, { jobId, rows: parsed.length });

  // 1. Present, and redacted — not absent. A row that simply dropped the key would pass a "no password here" check
  //    while losing the fact that the job used one, and the placeholder is what keeps the record honest.
  const unredacted = provided.filter((key) => mine[1][key] !== SECRET_PLACEHOLDER);
  if (unredacted.length > 0) {
    fail(`the job row holds ${unredacted.join(', ')} as something other than the placeholder`, mine[1]);
  }
  step(`the job row carries ${provided.join(', ')} as ${SECRET_PLACEHOLDER}, not the value`);

  // 2. Nowhere else, either. This is the assertion that would catch a second write path — an admin export, a retry
  //    endpoint, an older build's row — which a check on this job alone could not see.
  const offenders = parsed.filter(([, rowOptions]) => secretViolations(tool, rowOptions).length > 0);
  if (offenders.length > 0) {
    fail(
      `${offenders.length} jobs row(s) for ${tool.id} hold a declared secret in the clear (see scripts/ops/scrub-job-secrets.ts)`,
      offenders.map(([id, rowOptions]) => ({ id, keys: secretViolations(tool, rowOptions) })),
    );
  }
  step(`none of the ${parsed.length} ${tool.id} job row(s) in the database holds a password in the clear`);

  // 3. The stash is gone, which is also how the purge is exercised: the key exists while the job runs and must not
  //    exist after it ends.
  const key = jobSecretsKey(jobId);
  const left = await redisExists(key);
  if (left === null) {
    step('redis was not reachable, so the secret stash was not checked');
  } else if (left !== 0) {
    fail(`the service is still holding this job's password (${key} exists after the job ended)`);
  } else {
    step(`the service holds nothing for this job any more (${key} is gone)`);
  }

  // 4. Nor in anything the stack printed, which is the only surface that is neither a store nor this process's memory.
  await auditPrintedSurface(tool, options, jobWindowStart);
}

/**
 * Everything the running stack has printed recently — container stdout **and** stderr, merged.
 *
 * Merged deliberately: an engine that echoes the command line it was given (qpdf names its arguments in several
 * errors) writes to stderr, and the worker's own log lines go to stdout. A check that read only one of them would
 * miss exactly the case it exists for.
 */
async function containerLogs(since: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        'docker',
        'compose',
        'logs',
        '--no-color',
        '--since',
        since,
        'api',
        'worker-light',
        'worker-office',
        'worker-heavy',
        'worker-ocr',
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (/No such service|is not running|Cannot connect to the Docker daemon/i.test(stderr)) return null;
    // A non-zero exit is tolerated: `logs` returns 1 when a service has written to stderr, and refusing to audit the
    // output because the stack logged something would be the wrong way round.
    if (stdout.length === 0 && stderr.length === 0 && code !== 0) return null;
    return `${stdout}\n${stderr}`;
  } catch {
    return null;
  }
}

/**
 * The printed surface — the fourth place a password could be visible, and the only one no other check looks at.
 *
 * §7.1's other questions are about *stores* (the job row, the queue payload, Redis): they are asked of data at rest,
 * where a value either is or is not. A command line is not a store — it is a `/proc/<pid>/cmdline` entry that exists
 * for the life of one engine process, readable by every process in the container. That transient form cannot be
 * reconstructed after the fact, so this asks the question that can be answered afterwards: did the value reach the
 * stack's own output, where anyone with `docker logs` would see it? Engines quote their arguments in errors, so a
 * handler that passed a password as an argument would leave it here exactly the way a leaked value would in production.
 *
 * The window starts just before the job was created rather than covering the machine's history. A request logger writes
 * the value before a worker is ever involved, so the window has to reach back past the POST — but a window that reached
 * further would make the verdict depend on what earlier runs left in the logs, which is the property that made the
 * `down -v` step in `0-CICD.md` §3.1 necessary for the *store*. Logs cannot be recreated, so this asks the narrower
 * question that can still be answered precisely: did **this** job's value reach the output?
 */
async function auditPrintedSurface(tool: CatalogTool, options: Record<string, unknown>, since: string): Promise<void> {
  const declared = tool.secrets ?? [];
  const provided = declared.filter((key) => typeof options[key] === 'string');
  if (provided.length === 0) return;

  const logs = await containerLogs(since);
  if (logs === null) {
    step('the containers were not reachable, so the printed surface was not audited');
    return;
  }

  const offenders = provided.filter((key) => logs.includes(options[key] as string));
  if (offenders.length > 0) {
    fail(`${offenders.join(', ')} was printed by a container (see \`docker compose logs api worker-light\`)`, {
      tool: tool.id,
      searchedCharacters: logs.length,
    });
  }
  step(
    `no password appears in ${logs.length} characters of container output written since this job started ` +
      `(checked: ${provided.join(', ')})`,
  );
}

/**
 * The reveal channel — where a secret this service **produced** is handed out, audited the way the input passwords are.
 *
 * Four questions, and the order is the order of how wrong a "yes" would be:
 *
 *   1. does a plain `GET /jobs/:id` carry it? (It must not. The progress poller hits that route every two seconds, so a
 *      response that revealed whenever a value existed would put a password in every intermediate hop.)
 *   2. does `?reveal=1` return it, in the shape the engine generates, with the response marked uncacheable?
 *   3. does that value actually open the document — as its **owner**, which is the role it is for?
 *   4. is it in any row of the `jobs` table, or in anything the containers printed?
 *
 * (3) is what separates a reveal channel from a value generator: a job that stashed a random string, or the user
 * password by mistake, would pass (1), (2) and (4) and fail here. (4) is the same claim the input-side audit makes, run
 * against a value the harness had to *ask* for rather than one it wrote into the request.
 */
async function auditReveal(jobId: string, since: string): Promise<string> {
  const plain = await json<{ secrets?: Record<string, string> }>(`/api/v1/jobs/${jobId}`);
  if (plain.secrets) {
    fail('a plain GET of the job carried its secrets, so every progress poll and every retry would too', plain.secrets);
  }
  step('a plain GET of the job carries no secrets — the reveal is opt-in');

  const response = await call(`/api/v1/jobs/${jobId}?reveal=1`);
  const text = await response.text();
  const body = JSON.parse(text) as { secrets?: Record<string, string>; sensitive?: boolean };
  const value = body.secrets?.ownerPassword;
  if (typeof value !== 'string' || value.length === 0) {
    fail('the job generated an owner password but did not hand it back to its caller', body);
  }
  if (!/^[A-Za-z0-9_-]{24}$/.test(value)) {
    fail('the revealed owner password is not the 24-character value the engine generates', {
      length: value.length,
      shape: value.replaceAll(/[A-Za-z0-9_-]/g, '. '),
    });
  }
  if (body.sensitive !== true) {
    fail('the response that carried the secret was not marked sensitive');
  }
  if ((response.headers.get('cache-control') ?? '') !== 'no-store') {
    fail('the response that carried the secret is cacheable', {
      cacheControl: response.headers.get('cache-control'),
    });
  }
  step(`the job hands back a ${value.length}-character owner password, marked sensitive and no-store`);

  // Asking twice returns the same value, because the value belongs to a file that can still be downloaded: consuming it
  // on the first read would lose a password to a dropped connection. Pinned here so that a later change to one-shot
  // semantics is a decision rather than an accident.
  const again = await json<{ secrets?: Record<string, string> }>(`/api/v1/jobs/${jobId}?reveal=1`);
  if (again.secrets?.ownerPassword !== value) {
    fail('the reveal was consumed by the first read, so a dropped connection would lose the password', {
      second: again.secrets?.ownerPassword ?? null,
    });
  }
  step('reading the reveal twice returns the same value while the output exists');

  const rows = await psqlRows(`select count(*) from jobs where strpos(row_to_json(jobs)::text, '${value}') > 0`);
  if (rows === null) {
    step('the stack database was not reachable, so the revealed value was not searched for');
  } else if (Number(rows[0]?.[0] ?? '0') > 0) {
    fail('the generated owner password is written into a jobs row', { jobId, matches: rows[0]?.[0] });
  } else {
    step('no jobs row contains the generated owner password');
  }

  const logs = await containerLogs(since);
  if (logs === null) {
    step('the containers were not reachable, so the printed surface was not searched');
  } else if (logs.includes(value)) {
    fail('the generated owner password was printed by a container', { searchedCharacters: logs.length });
  } else {
    step(`the generated owner password is absent from ${logs.length} characters of container output`);
  }

  return value;
}

/**
 * A value one character away from the one under test — the control leg of an assertion about a password.
 *
 * Deliberately same-shaped and nearly identical, because the question the control asks is not "is a wrong password
 * rejected" (any length would answer that) but "does this reader separate the value from a neighbour of it". A probe
 * wired to the wrong variable, or a reader that accepts whatever it is given, answers the first question correctly and
 * fails this one.
 */
function nearMiss(value: string): string {
  const last = value.at(-1) ?? 'A';
  return `${value.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
}

/** How many keys in Redis match — `null` when the container is not reachable. */
async function redisExists(key: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(['docker', 'compose', 'exec', '-T', 'redis', 'redis-cli', 'EXISTS', key], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      if (/No such service|is not running|Cannot connect to the Docker daemon/i.test(stderr)) return null;
      fail('the stash check could not run against the stack redis', stderr.slice(0, 400));
    }
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`pdf-tools ${args.tool} E2E → ${args.base}\n`);

  // This case uploads its fixture as a caller with no account, so the stack has to allow one to exist. Checked here
  // as well as in the runner that invokes it, because a person runs this file directly — `bun run e2e:tool -- --tool
  // merge` — and deserves the named line rather than a refusal they have to interpret (`lib/stack-gap.ts`).
  await requireAnonymousUse(args.base, 'this case uploads its fixture as a caller with no account');

  // `/health` reports the pools under `checks.pools`, keyed by pool id and carrying a depth each. Read for the log
  // line rather than asserted: the *depth* is whatever the stack happens to be doing, and a case that pinned it would
  // fail whenever another suite was still finishing. The field was `queues` at the top level once, which is why this
  // step used to print `api healthy ()` — an empty parenthesis is what a harness reading a renamed field looks like.
  const health = await json<HealthView>('/health');
  if (health.status !== 'ok') fail('the API is not healthy', health);
  step(
    `api healthy (${Object.entries(health.checks?.pools ?? {})
      .map(([pool, state]) => `${pool}:${state.queueDepth}`)
      .join(' ')})`,
  );

  // A case that asks to run as Pro first proves the stack actually granted it. Without this check a gated case on a
  // stack with the switch off would fail with "not part of the Anonymous plan" — correct, but it would read as a
  // product failure instead of a stack misconfiguration, and a *non-gated* case would pass while asserting nothing.
  if (args.plan) {
    const me = await json<{ planId: string; planSource: string }>('/api/v1/me');
    if (me.planId !== args.plan || me.planSource !== 'dev-override') {
      fail(
        `this case needs a ${args.plan} session, but the stack evaluated it as ${me.planId} (planSource: ${me.planSource})`,
        {
          hint: 'set DEV_PLAN_TOKEN on the API (and let workers inherit it) — it is refused when NODE_ENV=production',
        },
      );
    }
    step(`the stack granted this session ${args.plan} (planSource: dev-override, not a subscription)`);
  }

  const catalog = await json<{ tools: CatalogTool[] }>('/api/v1/tools');
  const tool = catalog.tools.find((entry) => entry.id === args.tool);
  if (!tool) fail(`${args.tool} is not in the catalog`);
  if (!tool.enabled) fail(`${args.tool} is disabled in this build`);
  if (!tool.available) fail(`${args.tool} is not in this plan's entitlement list`);
  step(`catalog lists ${tool.id} on the ${tool.queue} pool, enabled and available`);

  if (args.files.length < tool.input.minFiles || args.files.length > tool.input.maxFiles) {
    fail(`${tool.id} takes ${tool.input.minFiles}–${tool.input.maxFiles} files, got ${args.files.length}`);
  }

  const started = Date.now();
  const fileIds: string[] = [];
  for (const path of args.files) fileIds.push(await upload(path, tool.input.accepts));
  step(`uploaded ${fileIds.length} file(s) and had their types accepted`);

  const options = { ...args.options };
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== 'string' || !value.startsWith(UPLOAD_SENTINEL)) continue;
    const declaration = tool.auxiliaryFiles?.find((entry) => entry.option === key);
    if (!declaration) {
      fail(`--options fills ${key} from a file, but ${tool.id} declares no attachment for that option`);
    }
    options[key] = await upload(value.slice(UPLOAD_SENTINEL.length), declaration.accepts);
    step(`uploaded the ${declaration.label} named by ${key} and had its type accepted`);
  }

  // The other declaration shape, which the loop above cannot reach: an id that lives *inside* an array of elements
  // (`edit-pdf.elements[].fileId`). The sentinel is in the array, not at the top level, so it is found by walking the
  // array the declaration names — and the harness learns the field name from the same declaration the API resolves, so
  // a case never has to know how the option is spelled.
  for (const declaration of tool.auxiliaryFiles ?? []) {
    const nested = /^([A-Za-z0-9_]+)\[\]\.([A-Za-z0-9_]+)$/.exec(declaration.option);
    if (!nested) continue;
    const [, key, field] = nested;
    const list = options[key!];
    if (!Array.isArray(list)) continue;

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const element = entry as Record<string, unknown>;
      const value = element[field!];
      if (typeof value !== 'string' || !value.startsWith(UPLOAD_SENTINEL)) continue;
      element[field!] = await upload(value.slice(UPLOAD_SENTINEL.length), declaration.accepts);
      step(`uploaded the ${declaration.label} named by ${key}[].${field} and had its type accepted`);
    }
  }

  // Captured before the request, not after: the value is in that request, so a window that began when the response
  // arrived would be looking past the moment it could have been written. The 5 s of margin absorbs the difference
  // between this process's clock and the containers'.
  const jobWindowStart = new Date(Date.now() - 5_000).toISOString();

  const created = await call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: args.tool, files: fileIds, options }),
  });
  const createdText = await created.text();
  const createdBody = JSON.parse(createdText) as {
    id?: string;
    queue?: string;
    error?: { code: string; message: string };
  };

  if (created.status !== 202) {
    if (args.expectError && createdBody.error?.code === args.expectError) {
      const refusal = createdBody.error?.message ?? '';
      assertRefusalMessageIsClean(refusal);
      assertRefusalMessageSays(refusal);
      step(`job correctly refused with ${args.expectError}`);
      console.log(
        `\n${args.tool} E2E passed — the refusal was the point (${steps.length} checks against ${args.base})`,
      );
      return;
    }
    fail(`creating the job returned ${created.status}`, createdText.slice(0, 600));
  }
  const jobId = createdBody.id!;
  step(`job ${jobId} accepted on ${createdBody.queue}`);
  if (args.expectQueue != null) {
    if (createdBody.queue !== args.expectQueue) {
      fail(
        `the job was accepted on ${createdBody.queue ?? 'no queue'}, not ${args.expectQueue} — the routing rule above this tool's threshold did not apply`,
        { expected: args.expectQueue, accepted: createdBody.queue ?? null },
      );
    }
    step(`the job was accepted on ${args.expectQueue}, the pool its size routes it to`);
  }

  // ── The queue, spelled one way ──────────────────────────────────────────────────────────────────────────
  // `queue` is the *queue* — `pdf-heavy` — and the pool id (`heavy`) is a different thing the stack already publishes
  // under its own name (`/health` → `checks.pools`, and the catalog's per-tool `queue`). Both answers are checked,
  // because both were once the other thing: `POST /jobs` answered with the pool id while `GET /jobs/:id` answered with
  // the queue name, so the submit page and the job page disagreed about the same job. The type made it invisible —
  // `CreatedJob.queue` *was* `ToolQueue`, and the idempotent replay path cast the stored name into it.
  //
  // A **name**, checked by prefix rather than against a list copied here: the list lives in `QUEUE_NAMES`, and a second
  // copy in the harness is how the two drift. `pdf-` is the prefix every one of those names starts with, and the pools
  // are in the message so a failure says which of the two vocabularies it saw.
  const pools = [...new Set(catalog.tools.map((entry) => entry.queue))].join(', ');
  const namedAsQueue = (value: string | undefined): value is string => Boolean(value?.startsWith('pdf-'));
  if (!namedAsQueue(createdBody.queue)) {
    fail(
      `the acceptance response named ${createdBody.queue ?? 'nothing'} as the queue — that is a pool id, and the pools are ${pools}`,
      { accepted: createdBody.queue ?? null },
    );
  }

  const job = await waitForJob(jobId);
  const elapsedSeconds = ((Date.now() - started) / 1000).toFixed(1);

  // Before the unconditional spelling rule below, so a case about the *second* routing decision fails naming that
  // decision rather than tripping over a rule that permits what it is testing.
  if (args.expectFinalQueue != null) {
    if (job.queue !== args.expectFinalQueue) {
      fail(
        `the job's own record says ${job.queue ?? 'nothing'} where the case requires ${args.expectFinalQueue} — the worker did not move it`,
        { expected: args.expectFinalQueue, reported: job.queue ?? null, accepted: createdBody.queue ?? null },
      );
    }
    step(
      args.expectFinalQueue === createdBody.queue
        ? `the job ran and finished on ${args.expectFinalQueue}`
        : `the job was moved from ${createdBody.queue} to ${args.expectFinalQueue} by the worker`,
    );
  }

  // Asserted for every case, not only the ones that name a queue.
  //
  // **Not one equality**, because a job may legitimately change pools: the API routes on the size the upload claimed and
  // the worker re-routes on the size that turned out to be true (`workers/shared/src/runtime.ts`), which moves a job
  // accepted on `pdf-light` to `pdf-heavy`. What cannot happen is a second spelling, or a move *down* — the escalation
  // table in the catalog only ever names `heavy`, so if this ever fires for a real case, a tool learned to escalate to
  // a pool this line has not been told about, which is a fact worth failing loudly over.
  if (!namedAsQueue(job.queue)) {
    fail(
      `the job's own record names ${job.queue ?? 'nothing'} as its queue — that is a pool id, and the pools are ${pools}`,
      { reported: job.queue ?? null },
    );
  }
  if (createdBody.queue !== job.queue && job.queue !== 'pdf-heavy') {
    fail(`the job was accepted on ${createdBody.queue}, but it reports ${job.queue} — one queue, two spellings`, {
      acceptedOn: createdBody.queue,
      reports: job.queue,
    });
  }

  // The job is terminal, so its row and its stash are both final. Audited before any assertion about the *result*,
  // because a password written down is worse than a conversion that went wrong.
  await auditDurableRecord(tool, options, jobId, jobWindowStart);

  // Asked for before the output is downloaded, so the value is available to the encryption checks below: the last
  // question about a revealed password is whether it is the one that opens the file.
  const revealedOwnerPassword = args.expectOwnerPasswordRevealed ? await auditReveal(jobId, jobWindowStart) : null;

  if (args.expectError && job.status === 'COMPLETED') {
    // Checked *before* the success path, and outside the block below, because this case is the one that matters when
    // a guard is removed: the job is expected to be refused, and it ran to completion instead. The first version of
    // this branch sat inside `if (job.status !== 'COMPLETED')`, where it could never run — so a claim that skipped a
    // guard reported `not-falsified` while this harness printed "E2E passed", and the falsification stage caught it.
    fail(`expected the job to fail with ${args.expectError} but it completed`);
  }

  if (job.status !== 'COMPLETED') {
    // A refusal can also happen *while the job runs* — the interesting ones do, because only the tool knows whether
    // the document has a text layer or a table — and `--expect-error` has to accept those too. Otherwise the only
    // testable refusals would be the ones the API can make before a worker ever sees the file.
    if (args.expectError && job.status === 'FAILED' && job.error?.code === args.expectError) {
      assertRefusalMessageIsClean(job.error.message);
      assertRefusalMessageSays(job.error.message);
      step(`the job correctly failed with ${args.expectError}: ${job.error.message}`);
      console.log(
        `\n${args.tool} E2E passed — the refusal was the point (${steps.length} checks against ${args.base})`,
      );
      return;
    }
    fail(`the job ended as ${job.status}`, job.error ?? job);
  }
  step(`job completed in ${elapsedSeconds}s`);

  const result = await json<{
    parts: Array<{ name: string; bytes: number; pages?: number[] }>;
    archiveUrl?: string;
    metrics: Record<string, unknown>;
  }>(`/api/v1/jobs/${jobId}/result`);
  if (result.parts.length === 0) fail('/result lists no parts');
  step(`/result lists ${result.parts.length} part(s): ${result.parts.map((p) => p.name).join(', ')}`);

  if (args.expectParts != null && result.parts.length !== args.expectParts) {
    fail(
      `/result lists ${result.parts.length} part(s) where the case requires ${args.expectParts} — a page selection that did nothing produces a part per page`,
      { parts: result.parts.map((part) => part.name) },
    );
  }
  for (const wanted of args.expectPartPages) {
    const part = result.parts[wanted.index];
    if (!part) fail(`/result has no part ${wanted.index} to read page labels from`);
    const declared = (part.pages ?? []).filter((page): page is number => typeof page === 'number');
    if (declared.join(',') !== wanted.pages.join(',')) {
      fail(
        `part ${wanted.index} (${part.name}) declares pages [${(part.pages ?? []).join(', ')}] where the case requires [${wanted.pages.join(', ')}]`,
        { declared: part.pages ?? null },
      );
    }
    step(
      `part ${wanted.index} (${part.name}) is page ${wanted.pages.join(', ')} of the document, read out of its own label`,
    );
  }

  // Which URL a client is *supposed* to use is part of the contract: a multi-part job exposes `archiveUrl`
  // (`?part=archive`) beside the per-part links, and `?part=primary` means the one flagged part. Asking for
  // `primary` on a 40-image export returns image 1, so a harness that always did that would have accepted a
  // product that hands users a single frame of their result. Resolved here rather than below because the per-part
  // checks need a download of their own.
  const wantsArchive = Boolean(tool.output.archive) && result.parts.length > 1 && Boolean(result.archiveUrl);
  const url = wantsArchive ? result.archiveUrl! : `/api/v1/jobs/${jobId}/download?part=primary`;

  // The single-output rule, both halves: nothing advertises an archive, and asking for one anyway serves the part.
  // The second half is what makes the first a rule about this product rather than about a missing URL — a client that
  // kept `?part=archive` from a previous release still gets its file, and gets the file, not a one-entry ZIP.
  if (args.expectNoArchive) {
    if (result.archiveUrl) {
      fail(`/result advertises an archive for a ${result.parts.length}-part job: ${result.archiveUrl}`);
    }
    const archive = await call(`/api/v1/jobs/${jobId}/download?part=archive`);
    if (!archive.ok) fail(`?part=archive on a single-output job returned ${archive.status}`);
    const archiveBytes = new Uint8Array(await archive.arrayBuffer());
    if (startsWith(archiveBytes, 'PK')) fail('?part=archive served a ZIP for a job with one output');
    const header = readImageHeader(archiveBytes);
    if (!header) {
      fail('?part=archive did not serve the one output', { bytes: archiveBytes.length });
    }
    step(
      `?part=archive serves the one output itself — a ${header.format} ${header.width}×${header.height}, not a one-entry ZIP`,
    );
  }

  const partBytes = async (index: number): Promise<Uint8Array> => {
    const response = await call(`/api/v1/jobs/${jobId}/download?part=${index}`);
    if (!response.ok) fail(`downloading part ${index} returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  // ── What the image itself says ────────────────────────────────────────────
  //
  // Read from each part's own header, because that is the only place these facts live: `/result` reports names, byte
  // counts and page labels, and every one of those can be right while the pixels (or the container, or the depth) are
  // wrong. `pdf-to-images` had three golden cases before this block existed and none of them looked at an image.
  const imageIndexes = [
    ...new Set([
      ...args.expectImageFormat.map((entry) => entry.index),
      ...args.expectImageSize.map((entry) => entry.index),
      ...args.expectImageBits.map((entry) => entry.index),
      ...args.expectImageChannels.map((entry) => entry.index),
    ]),
  ].sort((a, b) => a - b);
  for (const index of imageIndexes) {
    const bytes = await partBytes(index);
    const header = readImageHeader(bytes);
    if (!header) {
      fail(`part ${index} is not an image this harness can read`, { bytes: bytes.length });
    }

    const wantFormat = args.expectImageFormat.find((entry) => entry.index === index)?.value;
    if (wantFormat && header.format !== wantFormat) {
      fail(`part ${index} is ${header.format}, not ${wantFormat}`, { bytes: bytes.length });
    }
    if (wantFormat) step(`part ${index} is delivered as ${header.format} (${header.width}×${header.height})`);

    const wantSize = args.expectImageSize.find((entry) => entry.index === index);
    if (wantSize && (header.width !== wantSize.width || header.height !== wantSize.height)) {
      fail(
        `part ${index} is ${header.width}×${header.height} px where the case requires ${wantSize.width}×${wantSize.height}`,
      );
    }
    if (wantSize) {
      step(`part ${index} is ${header.width}×${header.height} px, read from its own header`);
    }

    const wantBits = args.expectImageBits.find((entry) => entry.index === index)?.value;
    if (wantBits != null) {
      if (header.bitDepth == null) fail(`part ${index} (${header.format}) does not declare a bit depth`);
      if (header.bitDepth !== wantBits) {
        fail(`part ${index} is ${header.bitDepth}-bit where the case requires ${wantBits}-bit`);
      }
      step(`part ${index} is ${header.bitDepth}-bit, which is what the option promised`);
    }

    const wantChannels = args.expectImageChannels.find((entry) => entry.index === index)?.value;
    if (wantChannels != null) {
      if (header.channels == null) fail(`part ${index} (${header.format}) does not declare a channel count`);
      if (header.channels !== wantChannels) {
        fail(`part ${index} carries ${header.channels} channel(s) where the case requires ${wantChannels}`);
      }
      step(`part ${index} carries ${header.channels} channel(s)`);
    }
  }

  //
  // Declared page labels per part — and this block is the reason it is measured rather than assumed: the flag was
  // declared, documented, wired into thirteen golden cases and **never read** for as long as it existed (defect 226).
  // A case that asks for `--expect-part-pages 0:3` and gets a part labelled `0` passed, which is what a check that
  // nothing calls looks like from the outside: the suite is green and the claim was never tested.
  //
  for (const wanted of args.expectPartPages) {
    const part = result.parts[wanted.index];
    if (!part) fail(`/result has no part ${wanted.index} whose page labels could be read`);
    const declared = part.pages ?? [];
    if (declared.join(',') !== wanted.pages.join(',')) {
      fail(
        `part ${wanted.index} (${part.name}) declares pages [${declared.join(', ')}] where [${wanted.pages.join(', ')}] is required — the part is labelled with the wrong pages, or with a position instead of a page`,
        { parts: result.parts.map((entry) => ({ name: entry.name, pages: entry.pages ?? null })) },
      );
    }
    step(`part ${wanted.index} (${part.name}) declares pages [${declared.join(', ')}]`);
  }

  if (args.expectPartition != null) {
    const declared = result.parts.flatMap((part) => part.pages ?? []);
    const sorted = [...declared].sort((a, b) => a - b);
    const wanted = Array.from({ length: args.expectPartition }, (_, index) => index + 1);
    if (sorted.join(',') !== wanted.join(',')) {
      fail(
        `the parts do not partition the document: their declared pages are [${sorted.join(', ')}] where [${wanted.join(', ')}] is required — a page is missing, duplicated, or labelled twice`,
        { parts: result.parts.map((part) => ({ name: part.name, pages: part.pages ?? null })) },
      );
    }
    step(`the parts partition all ${args.expectPartition} pages: no gap, no duplicate`);

    // Read from each part's bytes, not from its label: a label that disagrees with the file is the failure mode this
    // pair exists for.
    for (const [index, part] of result.parts.entries()) {
      const bytes = await partBytes(index);
      const objects = countPdfPages(bytes);
      const declaredCount = (part.pages ?? []).length;
      if (objects !== declaredCount) {
        fail(`part ${index} (${part.name}) declares ${declaredCount} page(s) and carries ${objects} page object(s)`, {
          declared: part.pages ?? null,
        });
      }
    }
    step('every part carries exactly the pages it declares, read from its own bytes');
  }

  for (const wanted of args.expectPartText) {
    const part = result.parts[wanted.index];
    if (!part) fail(`/result has no part ${wanted.index} to read text out of`);
    const haystack = Buffer.from(await partBytes(wanted.index)).toString('utf8');
    if (!haystack.includes(wanted.text)) {
      fail(`part ${wanted.index} (${part.name}) does not contain ${JSON.stringify(wanted.text)}`, {
        // What it does say is the useful half: the *other* table's cells mean the parts were written in a different
        // order, an empty file means the part was created and never filled.
        foundInstead: haystack.trim().slice(0, 200),
      });
    }
    step(`part ${wanted.index} (${part.name}) contains ${JSON.stringify(wanted.text)}`);
  }

  for (const wanted of args.expectPartOutlines) {
    const part = result.parts[wanted.index];
    if (!part) fail(`/result has no part ${wanted.index} to read an outline from`);
    const outline = await readOutlineAndInfo(await partBytes(wanted.index), { repoRoot: REPO_ROOT });
    if (!outline) fail(`the outline of part ${wanted.index} could not be read (no container reachable)`);
    const titles = outlineTitles(outline.entries);
    if (!titles.includes(wanted.title)) {
      fail(
        `part ${wanted.index} (${part.name}) has no bookmark titled ${JSON.stringify(wanted.title)} — its outline is [${titles.join(', ')}]`,
        { hasOutlines: outline.hasOutlines, titles },
      );
    }
    step(`part ${wanted.index} (${part.name}) carries the bookmark ${JSON.stringify(wanted.title)}`);
  }

  // The time budget the job actually ran with. It depends on which pool claimed it, so printing it is how an
  // escalated job is seen to have been given the heavier budget rather than assumed to have been.
  const budget = result.metrics?.budgetSeconds;
  if (budget != null) step(`the job ran with a ${budget} s budget`);

  // The other direction: a metric that has to be **above** a number rather than equal to one.
  //
  // Equality is the right assertion for a verdict (a page count, a flag, a pass number) and the wrong one for a
  // measurement whose exact value is a property of the fixture — `inputBytes` is the size of the file this run sent,
  // and a case that wanted to state it would be restating the fixture's own number in a second place. What such a
  // case actually claims is a threshold: the job received more than 100 MB. That is the premise the routing rule it is
  // testing depends on, so it is asserted here rather than left as a comment beside the fixture name.
  for (const [path, floor] of Object.entries(args.expectMetricsOver)) {
    const actual = readJsonPath(result.metrics ?? {}, path);
    if (typeof actual !== 'number') {
      fail(`the job's metrics have no numeric ${path} to compare with ${floor}`, {
        actual: actual === MISSING ? null : actual,
        keys: Object.keys(result.metrics ?? {}),
      });
    }
    if (!(actual > floor)) {
      fail(`metrics.${path} is ${actual}, not above ${floor}`);
    }
    step(`the job reports metrics.${path} = ${actual}, above ${floor}`);
  }

  // What the worker said it did, at dotted paths — the half of a job's result that no download can be asked for.
  for (const [path, wanted] of Object.entries(args.expectMetrics)) {
    const actual = readJsonPath(result.metrics ?? {}, path);
    if (actual === MISSING) {
      fail(`the job's metrics have no ${path}`, {
        keys: Object.keys(result.metrics ?? {}),
      });
    }
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      fail(`metrics.${path} is ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
    }
    step(`the job reports metrics.${path} = ${JSON.stringify(wanted)}`);
  }

  const download = await call(url);
  if (!download.ok) fail(`the download returned ${download.status}`, (await download.text()).slice(0, 400));
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.length === 0) fail('the download served a zero-byte file');
  step(`downloaded ${bytes.length} bytes from ${wantsArchive ? '?part=archive' : '?part=primary'}`);

  // "The pieces were put back": the outline of the assembled document must carry the entries the product promises,
  // and must not still carry one that belonged to a source nobody merged.
  if ((args.expectOutline.length > 0 || args.expectAbsentOutline.length > 0) && !wantsArchive) {
    const outline = await readOutlineAndInfo(bytes, { repoRoot: REPO_ROOT });
    if (!outline) fail('the outline could not be read (no container reachable)');
    const titles = outlineTitles(outline.entries);
    const at = (title: string) => outline.entries.flatMap((entry) => entryTitlesAtPage(entry, title));
    for (const wanted of args.expectOutline) {
      if (!titles.includes(wanted)) {
        fail(`the output has no bookmark titled ${JSON.stringify(wanted)} — its outline is [${titles.join(', ')}]`, {
          hasOutlines: outline.hasOutlines,
          titles,
        });
      }
      const pages = at(wanted);
      step(
        `the output carries the bookmark ${JSON.stringify(wanted)}${pages.length > 0 ? ` on page ${pages.join('/')}` : ''}`,
      );
    }
    for (const unwanted of args.expectAbsentOutline) {
      if (titles.includes(unwanted)) {
        fail(`the output still carries a bookmark titled ${JSON.stringify(unwanted)}`, { titles });
      }
    }
    if (args.expectAbsentOutline.length > 0) {
      step(`the outline carries none of ${args.expectAbsentOutline.map((t) => JSON.stringify(t)).join(', ')}`);
    }
  }

  // Byte equality, which is the only assertion that can hold a tool to "the original file is returned unchanged". Every
  // other check in this file passes for a re-encoded copy with the same pages, text and marks.
  if (args.expectIdenticalInput != null) {
    const source = args.files[args.expectIdenticalInput - 1];
    if (!source) {
      fail(`--expect-identical-input ${args.expectIdenticalInput} names an input this case does not pass`, {
        files: args.files,
      });
    }
    const original = new Uint8Array(await Bun.file(source!).arrayBuffer());
    const same = original.length === bytes.length && original.every((byte, index) => byte === bytes[index]);
    if (!same) {
      fail(`${source} was not returned unchanged (${original.length} bytes in, ${bytes.length} out)`);
    }
    step(
      `the output is byte-for-byte the input it was given (${bytes.length} bytes, so nothing it carries was rewritten)`,
    );
  }

  if (!wantsArchive) {
    // `/result` does not say which part carries the `primary` flag, so the check is that the bytes served match
    // one of the declared parts — a size that belongs to none of them means the download and the report disagree.
    if (!result.parts.some((p) => p.bytes === bytes.length)) {
      fail(`the download served ${bytes.length} bytes, which matches none of the reported parts`, {
        parts: result.parts.map((p) => `${p.name}:${p.bytes}`),
      });
    }
  } else {
    // Nothing to compare against: the runtime assembles the archive and `/result` does not size it. The entry
    // count below is the check that matters for an archive.
    step('the archive is not sized by /result, so its entry count is the evidence');
  }

  const kind = args.expectKind ?? tool.output.kind;
  if (kind === 'pdf' || startsWith(bytes, '%PDF-')) {
    const pages = countPdfPages(bytes);
    if (pages === 0) fail('the downloaded file has no pages', { bytes: bytes.length });
    if (job.output?.pages != null && pages !== job.output.pages) {
      fail(`the API reported ${job.output.pages} pages but the file contains ${pages}`);
    }
    if (args.expectPages != null && pages !== args.expectPages) {
      fail(`expected ${args.expectPages} pages, found ${pages}`);
    }
    step(`the downloaded PDF contains ${pages} page(s), counted from its bytes`);

    // The structural invariant, checked on **every** PDF this harness downloads rather than on the cases someone
    // remembered: a page object the tree does not list, or a reference to a page that is gone, is invisible to a page
    // count, to a text extraction and to a rendered page — it is how `n-up` kept every page it had removed inside the
    // file (defect 83). Three readers, deliberately: the bytes, pikepdf's object walk, and poppler. A check that
    // counted all three the same way would only ever agree with itself.
    const health = await readPdfHealth(bytes, REPO_ROOT, declaredUserPassword(args.options));
    const readers: Array<[string, number | null]> = [
      ['a byte scan', health.objects],
      ['an object walk', health.parserObjects],
      ['the page tree', health.tree],
    ];
    const known = readers.filter((entry): entry is [string, number] => entry[1] != null);
    const reference = known[0];
    if (!reference) {
      step('no reader was reachable, so the page-object/tree invariant was not checked');
    } else {
      // Every reader that managed to open the file has to agree on how many pages it has — that is the assertion. The
      // byte scan has no PDF parser in it, the object walk can enumerate objects nothing references, and the page tree
      // is what a reader displays, so a disagreement means one of them is looking at something the others cannot see.
      const disagreeing = known.find(([, count]) => count !== reference[1]);
      if (disagreeing) {
        fail(`${disagreeing[0]} counts ${disagreeing[1]} page(s) where ${reference[0]} counts ${reference[1]}`, {
          orphanPages: health.orphanPages,
          readers: Object.fromEntries(known),
        });
      }
      if (health.orphanPages && health.orphanPages.length > 0) {
        fail(`the file holds page object(s) its tree does not list: ${health.orphanPages.join(', ')}`, {
          orphanPages: health.orphanPages,
        });
      }
      if (health.danglingFields || health.danglingAnnotations) {
        fail(
          `the file has ${health.danglingFields ?? 0} form field(s) and ${health.danglingAnnotations ?? 0} annotation(s) pointing at a page its tree does not have`,
          { fields: health.danglingFields, annotations: health.danglingAnnotations },
        );
      }
      step(
        `the file holds ${reference[1]} page object(s) and the reader(s) that could open it agree: ${known.map(([name, count]) => `${name} ${count}`).join(', ')}`,
      );
      if (known.length < 2) {
        step('only one reader could open the file, so the counts were not cross-checked');
      }
      if (health.parserObjects != null) {
        step('no form field or annotation points at a page the tree does not have');
      } else if (health.parserError) {
        step(`the reference walk could not run: ${health.parserError}`);
      }
    }

    // Transparency, read from the objects rather than from a viewer: an image with no soft mask is an opaque
    // rectangle over the page, which no page count and no text search can distinguish from a correct watermark.
    if (args.expectSmaskImages != null) {
      const { images, softMasked } = countPdfImages(bytes);
      if (softMasked < args.expectSmaskImages) {
        fail(
          `expected ${args.expectSmaskImages} transparent image(s), found ${images} image(s) and ${softMasked} soft-masked`,
        );
      }
      step(`the output carries ${images} image object(s), ${softMasked} of them with an alpha channel`);
    }

    if (args.expectImages != null) {
      // Any image object, regardless of alpha: the signal that a document's *referenced asset* was found and embedded.
      // The alternative — asserting the asset's text or colour — is not available: LibreOffice ignores `display: none`
      // in HTML import, so a CSS-based probe tests the engine rather than the extraction.
      const { images } = countPdfImages(bytes);
      if (images < args.expectImages) {
        fail(`expected at least ${args.expectImages} image object(s) in the output, found ${images}`);
      }
      step(`the output embeds ${images} image object(s), so the referenced asset was resolved`);
    }

    // The security tools' claims, read by two engines that share no code: qpdf names the revision, the cipher and
    // every permission flag, and poppler answers the two questions qpdf cannot be asked — does the document open
    // *without* a password, and does it open with the one that was set. A case that expects nothing here pays nothing.
    const wantsEncryption =
      args.expectEncrypted != null ||
      args.expectAlgorithm != null ||
      args.expectOpenWithoutPassword != null ||
      args.expectOpensWith != null ||
      Object.keys(args.expectPermissions).length > 0;

    if (wantsEncryption) {
      const reading = await readEncryption(bytes, {
        ...(args.expectOpensWith ? { password: args.expectOpensWith } : {}),
        ...(revealedOwnerPassword ? { ownerPassword: revealedOwnerPassword } : {}),
        ...(revealedOwnerPassword ? { ownerPasswordNearMiss: nearMiss(revealedOwnerPassword) } : {}),
        repoRoot: REPO_ROOT,
      });
      if (!reading) {
        fail('could not read the output’s encryption state: no worker-light container is reachable', {
          hint: 'the encryption checks need qpdf and pdfinfo from the light image; run `docker compose up -d worker-light`',
        });
      }

      if (args.expectEncrypted != null) {
        if (reading.qpdf.encrypted !== args.expectEncrypted) {
          fail(
            args.expectEncrypted
              ? 'the output is not encrypted, so the document is not protected'
              : 'the output is still encrypted',
            { qpdf: reading.qpdf.method, revision: reading.qpdf.revision },
          );
        }
        step(
          args.expectEncrypted
            ? `qpdf reads the output as encrypted (revision ${reading.qpdf.revision}, ${reading.qpdf.method})`
            : 'qpdf reads the output as not encrypted',
        );
      }

      if (args.expectAlgorithm != null && reading.poppler.algorithm !== args.expectAlgorithm) {
        fail(`expected poppler to report the ${args.expectAlgorithm} cipher, it reported ${reading.poppler.algorithm}`);
      }
      if (args.expectAlgorithm != null) step(`poppler names the cipher ${reading.poppler.algorithm}`);

      if (args.expectOpenWithoutPassword != null) {
        if (reading.poppler.opensWithoutPassword !== args.expectOpenWithoutPassword) {
          fail(
            args.expectOpenWithoutPassword
              ? 'the output cannot be opened without a password, which is a lockout rather than a restriction'
              : 'the output opens without a password, so it is not protected by one',
          );
        }
        step(
          args.expectOpenWithoutPassword
            ? 'poppler opens the output with no password at all'
            : 'poppler cannot open the output without a password',
        );
      }

      if (args.expectOpensWith != null && !reading.poppler.opensWithPassword) {
        fail('the output does not open with the password that was applied to it', {
          hint: 'this is the password transport failing, and it locks the owner out of their own document',
        });
      }
      if (args.expectOpensWith != null) step('poppler opens the output with the password that was set');

      if (revealedOwnerPassword) {
        // The check that distinguishes the right password from a plausible one, asked as a **role** rather than as an
        // opening. "Did poppler open it with this owner password" is the weaker question, and on `restrict` it is no
        // question at all: the user password there is empty, and **measured**, `pdfinfo -opw <anything>` exits 0 on such
        // a file — so a random string, or the user password handed back twice, would pass it. qpdf validates the supplied
        // password against both keys and reports which one matched, and nothing else in either engine says *which*.
        if (reading.qpdf.passwordRole !== 'owner') {
          fail('the value handed back to the caller is not the password this output is keyed to as its owner', {
            hint: 'qpdf read the supplied password as something other than the owner password, so the reveal channel delivered a value the engine never applied',
            role: reading.qpdf.passwordRole,
          });
        }
        step('qpdf reads the password the job handed back as the document’s owner password');

        // And the control that makes the reading above worth having: a value one character away has to be rejected. A
        // reader that answered "owner" to everything — or a probe pointed at the wrong variable — would otherwise look
        // exactly like a passing check.
        if (reading.qpdf.nearMissPasswordRole !== 'incorrect') {
          fail('a one-character variation of the revealed password is accepted as the owner password', {
            hint: 'the assertion above proves nothing if the reader does not separate the value from a near miss',
            role: reading.qpdf.nearMissPasswordRole,
          });
        }
        step('a one-character variation of it is rejected, so that reading is not vacuous');

        // The second, weaker leg, run only where it means something: a file that demands a user password refuses to open
        // in poppler at all without a correct owner password, so there it is an independent witness from a reader that
        // shares no code with qpdf. On a restricted file it is trivially true, and printing it would report a check
        // that measured nothing — which is the shape of defect this harness exists to avoid. Which of the two this file
        // is, is read out of the file ("does it open with no password") rather than taken from what the case declared,
        // so the leg follows the document in front of it instead of the flag someone remembered to pass.
        if (reading.poppler.opensWithoutPassword) {
          step(
            'the poppler owner-password leg was skipped: this file opens without a password, so `-opw` accepts any value on it',
          );
        } else {
          if (reading.poppler.opensWithOwnerPassword !== true) {
            fail('the owner password handed back to the caller does not open the document', {
              hint: 'the value came from the reveal channel and poppler rejected it as the owner password',
            });
          }
          step('poppler opens the output as its owner with the password the job handed back');
        }
      }

      for (const [flag, allowed] of Object.entries(args.expectPermissions)) {
        const read = reading.qpdf.permissions[flag];
        if (read == null) {
          fail(`qpdf reported no ${flag} permission for the output, so it cannot be asserted either way`);
        }
        if (read !== allowed) {
          fail(
            `expected ${flag} to be ${allowed ? 'allowed' : 'denied'}, qpdf reads it as ${read ? 'allowed' : 'denied'}`,
          );
        }
      }
      if (Object.keys(args.expectPermissions).length > 0) {
        step(
          `qpdf reads every asserted permission: ${Object.entries(args.expectPermissions)
            .map(([flag, allowed]) => `${flag}=${allowed ? 'yes' : 'no'}`)
            .join(', ')}`,
        );
      }
    }
    // The archive branch is entered by the *bytes*, or by having asked for the archive — not by the tool's declared
    // output kind.
    //
    // Keying it off the kind was a harness defect that surfaced the moment a single-part case was written for an
    // archive-kind tool (defect 103): `pdf-to-images` declares `image-zip`, so a one-page export — where the download
    // is that page's image, because an archive of one part is served as the part itself — was handed to
    // `countZipEntries` and failed with "the archive contains no entries". Nothing was wrong with the product: the
    // case was asking a PNG to be a ZIP. `wantsArchive` is the honest question (a multi-part archive-kind job must
    // serve a real archive), and the signature covers the tools whose *product* is a package (`docx`, `xlsx`, `pptx`),
    // which are ZIPs whether the caller asked for the archive or for the single part.
    //
    // The second half of the same defect: the signature test that was supposed to be the fallback had never matched
    // anything (`startsWith`, above), so `pdf-to-office`'s five cases lost their three package checks each the moment
    // the branch stopped being keyed on the kind — measured as 442 → 432 checks in the heavy pool. A test that cannot
    // fail and a test that is never reached look identical from a green suite, and both were in this one condition.
  } else if (wantsArchive || startsWith(bytes, 'PK')) {
    const entries = countZipEntries(bytes);
    if (entries === 0) {
      fail(wantsArchive ? 'the archive download did not serve a ZIP' : 'the output is neither a ZIP nor a page of one');
    }
    step(`the archive contains ${entries} entr${entries === 1 ? 'y' : 'ies'}`);

    // An OOXML package is a ZIP whose readable parts are deflated, so `--expect-bytes` cannot see them: a word the
    // user typed into a DOCX is invisible to a byte search even when it is in the file. The entry text is inflated
    // here instead, which makes "the Word document contains the table's cell" an assertion rather than a hope.
    if (args.expectArchiveText.length > 0 || args.expectEntries.length > 0 || args.expectAbsentArchiveText.length > 0) {
      const inside = archiveEntryText(bytes);
      for (const wanted of args.expectEntries) {
        if (!inside.includes(`[entry ${wanted}]`)) fail(`the archive has no entry named ${wanted}`);
      }
      if (args.expectEntries.length > 0) step(`the package contains ${args.expectEntries.join(', ')}`);
      for (const unwanted of args.expectAbsentArchiveText) {
        if (inside.includes(unwanted)) {
          fail(`the archive still carries ${JSON.stringify(unwanted)}`, inside.slice(0, 400));
        }
      }
      if (args.expectAbsentArchiveText.length > 0) {
        step(`the package's entries carry none of "${args.expectAbsentArchiveText.join('", "')}"`);
      }
      for (const wanted of args.expectArchiveText) {
        if (!inside.includes(wanted)) {
          fail(`"${wanted}" is not in any entry of the archive`, inside.slice(0, 400));
        }
      }
      if (args.expectArchiveText.length > 0) {
        step(`the package's entries carry "${args.expectArchiveText.join('", "')}", read after inflating them`);
      }
    }
  } else if (kind === 'json') {
    const text = Buffer.from(bytes).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      fail('the output claims to be JSON but does not parse', text.slice(0, 300));
    }
    step('the output parses as JSON');

    // The paths are asserted against the *parsed* body rather than the text, so a case states what the data is rather
    // than how it happens to be formatted: re-indenting the writer, or switching to a compact encoding, must not be
    // able to break a case that is about a field name.
    for (const [path, wanted] of Object.entries(args.expectJsonPaths)) {
      const actual = readJsonPath(body, path);
      if (actual === MISSING) {
        fail(`the JSON body has no ${path}`, {
          keys: body && typeof body === 'object' ? Object.keys(body) : typeof body,
          body: text.slice(0, 400),
        });
      }
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        fail(`${path} is ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`, { body: text.slice(0, 400) });
      }
      step(`${path} = ${JSON.stringify(wanted)}`);
    }
  } else {
    step(`the output is ${kind} (${bytes.length} bytes)`);
  }

  if (args.expectText) {
    // Prefer the engine: it decodes font subsets, which is the only way "the document body survived OCR or
    // LibreOffice" can be answered. The byte search stays as the fallback and searches both the raw bytes and the
    // inflated streams.
    const isPdf = kind === 'pdf' || startsWith(bytes, '%PDF-');
    const engineText = isPdf ? await extractTextWithEngine(bytes) : null;
    const haystack = engineText ?? `${Buffer.from(bytes).toString('utf8')}\n${decodedPdfText(bytes)}`;

    if (!haystack.includes(args.expectText)) {
      fail(`the output does not contain ${JSON.stringify(args.expectText)}`, {
        checkedWith: engineText != null ? 'pdftotext' : 'raw bytes and inflated streams',
        searched: `${haystack.length} chars`,
        // What the output *does* say is the useful half of this failure: "nothing" and "everything but the word
        // you asked for" are different bugs.
        foundInstead: haystack.trim().slice(0, 200),
      });
    }
    const how = engineText != null ? 'read with pdftotext' : 'found in the bytes';
    step(`the output preserves the expected text (${JSON.stringify(args.expectText.slice(0, 40))}…) — ${how}`);
  }

  if (args.expectAbsentText) {
    // Absence is the only way to prove a *selection* was honoured. "Page 3 of 5 is present" is equally consistent
    // with a handler that stamped every page, or the wrong pages; "Page 1 of 5 is absent" is not.
    const isPdf = kind === 'pdf' || startsWith(bytes, '%PDF-');
    const engineText = isPdf ? await extractTextWithEngine(bytes) : null;
    const haystack = engineText ?? `${Buffer.from(bytes).toString('utf8')}\n${decodedPdfText(bytes)}`;
    if (haystack.includes(args.expectAbsentText)) {
      fail(`the output contains ${JSON.stringify(args.expectAbsentText)}, which it should not`, {
        checkedWith: engineText != null ? 'pdftotext' : 'raw bytes and inflated streams',
      });
    }
    step(`the output does not contain ${JSON.stringify(args.expectAbsentText)}`);
  }

  if (args.expectPageText.length > 0) {
    //
    // Page by page, in order — the assertion a concatenated text search cannot make. It is read from the delivered
    // bytes with poppler rather than through `extractTextWithEngine`, because the *page boundary* is the fact under
    // test: `pdftotext` is the only reader here that reports where one page's text ends.
    //
    const texts = await pdfPageTexts(bytes, { repoRoot: REPO_ROOT });
    if (texts == null) {
      fail('the page-by-page text could not be read: no container answered with a pdftotext result');
    }
    for (const wanted of args.expectPageText) {
      const actual = texts[wanted.index];
      if (actual == null) {
        fail(`the output has no page ${wanted.index}, so its text cannot be read`, { pages: texts.length });
      }
      if (!actual.includes(wanted.text)) {
        fail(
          `page ${wanted.index} does not contain ${JSON.stringify(wanted.text)} — the document's pages are not in the order this case requires`,
          {
            // Every page, not just the wrong one: for an ordering assertion the useful answer is what the whole
            // sequence is, since a swapped pair shows up as two mismatches and a shift shows up as all of them.
            pages: texts.map((text, index) => `${index}: ${text.slice(0, 60)}`),
          },
        );
      }
    }
    step(
      `${args.expectPageText.length} page(s) carry the text they must, read page by page with pdftotext (${texts.length} pages)`,
    );
  }

  if (args.expectPageSize) {
    // The page *size*, which is the whole point of several options (orientation, paper size, crop) and is invisible
    // to every other check here: a document rendered on the wrong paper still has the right page count and the right
    // text. Tolerance is 3 pt, because the engines disagree in the last decimal place — LibreOffice writes A4 as
    // 595.304 × 841.890 where the standard figure is 595.276 × 841.890.
    const box = firstPageMediaBox(bytes);
    if (!box) {
      fail('could not read a /MediaBox from the output, so its page size is unknown');
    }
    const { widthPt, heightPt } = args.expectPageSize;
    const withinTolerance = Math.abs(box.width - widthPt) <= 3 && Math.abs(box.height - heightPt) <= 3;
    if (!withinTolerance) {
      fail(`expected a first page of ${widthPt} × ${heightPt} pt, found ${box.width} × ${box.height} pt`, {
        hint: 'orientation and paper size are the options most likely to be silently ignored',
      });
    }
    step(`the first page is ${box.width.toFixed(2)} × ${box.height.toFixed(2)} pt, as asked`);
  }

  if (args.expectCropBox) {
    const box = firstPageCropBox(bytes);
    if (!box) {
      fail('the output has no /CropBox on its first page, so nothing was cropped');
    }
    const { widthPt, heightPt } = args.expectCropBox;
    // 1 pt of tolerance, the figure `docs/03-ORGANIZE-ROTATE-CROP.md` §7 asks for — units are converted in the
    // handler, and a millimetre is 2.83 pt, so a sloppy conversion shows up well inside this window.
    if (Math.abs(box.width - widthPt) > 1 || Math.abs(box.height - heightPt) > 1) {
      fail(`expected a crop box of ${widthPt} × ${heightPt} pt, found ${box.width} × ${box.height} pt`);
    }
    step(`the first page's crop box is ${box.width.toFixed(2)} × ${box.height.toFixed(2)} pt, as asked`);
  }

  if (args.expectLinearized) {
    // Read structurally, and deliberately after the download rather than from a metric: a job report that says
    // "linearized: true" is the claim, and this is the file. Both halves are checked — the hint dictionary has to
    // be at the *front*, which is the whole property, and qpdf's own reader has to be able to walk it.
    if (!hasLinearizationDict(bytes)) {
      fail('the output has no /Linearized dictionary in its first 2 KB, so it is not linearized', {
        bytes: bytes.length,
        head: Buffer.from(bytes).subarray(0, 120).toString('latin1'),
      });
    }
    // Staged into the container with `cat` rather than piped as `-`: `qpdf --show-linearization` reads a *file*, and
    // given stdin it fails in a way that looks exactly like a missing hint table.
    const walk = Bun.spawn(
      [
        'docker',
        'compose',
        'exec',
        '-T',
        'worker-light',
        'sh',
        '-c',
        'cat > /tmp/linearized-check.pdf && qpdf --show-linearization /tmp/linearized-check.pdf',
      ],
      { cwd: REPO_ROOT, stdin: bytes, stdout: 'pipe', stderr: 'pipe' },
    );
    const [walkOut, walkErr, walkCode] = await Promise.all([
      new Response(walk.stdout).text(),
      new Response(walk.stderr).text(),
      walk.exited,
    ]);
    if (walkCode !== 0 || /not linearized/i.test(walkOut + walkErr)) {
      fail("qpdf cannot walk the output's linearization table", (walkOut + walkErr).slice(0, 300));
    }
    step('the output is linearized: the hint dictionary is at the front and qpdf can walk it');
  }

  if (args.expectNoSignatureDictionary) {
    // `sign`'s central claim, and the one no rendering check can see: an attached signature dictionary leaves the
    // page byte-for-byte plausible. Read from the file and its inflated object streams, by key rather than by
    // substring, so a document whose text happens to say "/Sig" is not mistaken for a signed one.
    const markers = readSignatureMarkers(bytes);
    if (markers.signatureObjects > 0 || markers.byteRange > 0 || markers.perms > 0) {
      fail(
        `the output carries a signature dictionary: ${markers.signatureObjects} /Sig object(s), ${markers.byteRange} /ByteRange, ${markers.perms} /Perms`,
        { hint: 'this tool draws an ink signature; a signature dictionary it did not create is a broken signature' },
      );
    }
    step('the output has no signature dictionary: no /Sig object, no /ByteRange and no /Perms');
  }

  if (args.expectBytes.length > 0 || args.expectAbsentBytes.length > 0) {
    // The raw bytes *and* the inflated streams, always — never the extracted text. Metadata is not page content, so
    // `pdftotext` cannot see any of it, and on a PDF whose objects were repacked into object streams the raw bytes
    // alone cannot see it either. The presence assertion below is what makes the absence assertions meaningful: a
    // search that cannot find a string still in the file would report "removed" for every input.
    const haystack = searchableBytes(bytes);
    for (const wanted of args.expectBytes) {
      if (!haystack.includes(wanted)) {
        fail(`${JSON.stringify(wanted)} is missing from the output, but this case expects it to survive`);
      }
    }
    if (args.expectBytes.length > 0) {
      step(
        `the output still carries ${args.expectBytes.map((b) => JSON.stringify(b)).join(', ')}, read from its objects`,
      );
    }
    for (const unwanted of args.expectAbsentBytes) {
      if (haystack.includes(unwanted)) {
        fail(`${JSON.stringify(unwanted)} is still in the output`, {
          where: haystack.indexOf(unwanted) < Buffer.from(bytes).length ? 'raw bytes' : 'an inflated stream',
        });
      }
    }
    if (args.expectAbsentBytes.length > 0) {
      step(
        `the output no longer contains ${args.expectAbsentBytes.map((b) => JSON.stringify(b)).join(', ')}, read from its objects`,
      );
    }
  }

  if (args.expectWarnings.length > 0) {
    const reported = job.warnings.map((warning) => warning.code);
    for (const expected of args.expectWarnings) {
      if (!reported.includes(expected)) {
        fail(`expected the job to report ${expected}`, {
          reported,
          hint: 'a warning that documents a limitation is part of the contract, not noise',
        });
      }
    }
    step(`the job reports ${args.expectWarnings.join(', ')}, as an unhonoured option must`);
  }

  if (args.expectAbsentWarnings.length > 0) {
    const reported = job.warnings.map((warning) => warning.code);
    for (const unwanted of args.expectAbsentWarnings) {
      if (reported.includes(unwanted)) {
        fail(`expected the job **not** to report ${unwanted}`, {
          reported,
          hint: 'a warning asserted unconditionally is a sentence about the handler rather than about the file',
        });
      }
    }
    step(`the job does not report ${args.expectAbsentWarnings.join(', ')}, so the warning is about the input`);
  }

  if (job.warnings.length > 0) {
    step(`warnings reported rather than hidden: ${job.warnings.map((w) => w.code).join(', ')}`);
  }

  // ── Ink, which is the only way to see placement ─────
  if (args.expectInkRegion.length > 0 || args.expectBlankRegion.length > 0) {
    const rendered = new Map<number, Awaited<ReturnType<typeof renderPageGray>>>();
    const pageFor = async (pageNumber: number) => {
      if (!rendered.has(pageNumber)) rendered.set(pageNumber, await renderPageGray(bytes, pageNumber));
      const page = rendered.get(pageNumber) ?? null;
      if (!page) {
        fail('the output could not be rendered, so placement was not checked', {
          needed: 'pdftoppm in worker-light (docker compose exec)',
          hint: 'a placement case that cannot render must fail rather than pass silently',
        });
      }
      return page;
    };

    for (const spec of args.expectInkRegion) {
      const region = parseRegion(spec);
      if (!region) fail(`--expect-ink-region "${spec}" is not \`page,x,y,w,h\``);
      const { share } = inkShare(await pageFor(region.page), region);
      // 2 % of a region covered in ink is far below any real mark (a single 1 pt line across a 200×20 region is
      // already ~5 %) and far above the antialiasing a blank region picks up from a neighbouring edge.
      if (share < 0.02) {
        fail(`nothing was drawn inside ${spec} — ${(share * 100).toFixed(2)} % of that region is ink`, {
          checkedWith: 'pdftoppm -gray at 72 dpi, one pixel per point',
          hint: 'to answer *where* a mark landed you have to render the page',
        });
      }
      step(`the rendered page has ink at ${spec} (${(share * 100).toFixed(1)} % of the region)`);
    }

    for (const spec of args.expectBlankRegion) {
      const region = parseRegion(spec);
      if (!region) fail(`--expect-blank-region "${spec}" is not \`page,x,y,w,h\``);
      const { share } = inkShare(await pageFor(region.page), region);
      if (share > 0.002) {
        fail(`${spec} should be blank but ${(share * 100).toFixed(2)} % of it is ink`, {
          checkedWith: 'pdftoppm -gray at 72 dpi, one pixel per point',
        });
      }
      step(`the rendered page is blank at ${spec}, so the mark is where it was asked for and not merely somewhere`);
    }
  }

  // ── Page geometry, which a page count, a text search and a render all agree with ─────
  //
  // `/Rotate` and every `/MediaBox`, read from the page tree by a parser rather than from the bytes: both are promises
  // about pages *in order*, and both are invisible to every other check in this file. A rotated page extracts the same
  // text and counts as one page; four TIFF frames arriving in the wrong order still make four pages of the right sizes.
  if (Object.keys(args.expectPageRotate).length > 0 || args.expectMediaBoxes.length > 0) {
    const geometry = await readPageGeometry(bytes, { repoRoot: REPO_ROOT });
    if (!geometry) {
      fail('the pages could not be read out of the output', {
        needed: 'pikepdf in worker-light (docker compose exec)',
        hint: 'a geometry case that cannot read the file must fail rather than pass silently',
      });
    }

    for (const [page, expected] of Object.entries(args.expectPageRotate)) {
      const entry = geometry.find((candidate) => candidate.page === Number(page));
      if (!entry) {
        fail(`the output has no page ${page}, so its rotation was not checked`, { pages: geometry.length });
      }
      if (entry.rotate !== expected) {
        fail(`page ${page} should carry /Rotate ${expected}, and the file says ${entry.rotate}`, {
          readWith: 'pikepdf, from the page dictionary',
          hint: 'a rotation changes no page count, no text and no page size — this is the only place it shows',
        });
      }
      step(`page ${page} carries /Rotate ${expected}, read from the page dictionary`);
    }

    if (args.expectMediaBoxes.length > 0) {
      if (geometry.length !== args.expectMediaBoxes.length) {
        fail(`expected ${args.expectMediaBoxes.length} page box(es), found ${geometry.length}`, {
          readWith: 'pikepdf',
        });
      }
      args.expectMediaBoxes.forEach((expected, index) => {
        const entry = geometry[index]!;
        // A point of tolerance: the box is written from a rounded integer at 72 dpi, and a claim about *order* should not
        // fail over a rounding difference.
        const widthOff = Math.abs(entry.widthPt - expected.widthPt);
        const heightOff = Math.abs(entry.heightPt - expected.heightPt);
        if (widthOff > 1 || heightOff > 1) {
          fail(
            `page ${index + 1} should be ${expected.widthPt}×${expected.heightPt} pt, and the file says ${entry.widthPt}×${entry.heightPt}`,
            { boxes: geometry.map((page) => `${page.page}:${page.widthPt}×${page.heightPt}`) },
          );
        }
        step(`page ${index + 1} is ${Math.round(entry.widthPt)}×${Math.round(entry.heightPt)} pt, in page-tree order`);
      });
    }
  }

  // ── Annotations, which a rendered page cannot distinguish from paint ─────
  const wantsAnnotations =
    Object.keys(args.expectAnnotations).length > 0 ||
    args.expectAnnotationCount != null ||
    args.expectAnnotationsPrint ||
    Object.keys(args.expectQuadPoints).length > 0;
  if (wantsAnnotations) {
    const reading = await readAnnotationState(bytes, { repoRoot: REPO_ROOT });
    if (!reading) {
      fail('the annotations could not be read out of the output', {
        needed: 'pikepdf in worker-light (docker compose exec)',
        hint: 'an annotation case that cannot read the file must fail rather than pass silently',
      });
    }

    // Counted under the contract's words — the file says `/StrikeOut`, the case says `strike=1` — so the comparison
    // is a check on the translation rather than on a vocabulary the harness picked for itself.
    const found = new Map<string, number>();
    for (const page of reading.pages) {
      for (const subtype of page.subtypes) {
        const key = canonicalSubtype(subtype);
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }

    if (args.expectAnnotationCount != null && reading.total !== args.expectAnnotationCount) {
      fail(`expected ${args.expectAnnotationCount} annotation(s) in the output, found ${reading.total}`, {
        bySubtype: Object.fromEntries(found),
        readWith: 'pikepdf',
      });
    }
    if (args.expectAnnotationCount != null) {
      step(`the output's own dictionaries carry ${reading.total} annotation(s)`);
    }

    for (const [subtype, expected] of Object.entries(args.expectAnnotations)) {
      const actual = found.get(subtype.toLowerCase()) ?? 0;
      if (actual !== expected) {
        fail(`expected ${expected} ${subtype} annotation(s), found ${actual}`, {
          bySubtype: Object.fromEntries(found),
          hint: 'counted per /Subtype in the file, not from the request',
        });
      }
      step(`the output contains ${expected} ${subtype} annotation(s), read from the /Subtype of each dictionary`);
    }

    for (const [page, expected] of Object.entries(args.expectQuadPoints)) {
      const entry = reading.pages.find((candidate) => candidate.page === Number(page));
      const actual = entry?.quadPoints ?? 0;
      if (actual !== expected) {
        fail(`page ${page} should carry ${expected} quad point group(s), found ${actual}`, {
          readWith: 'pikepdf',
        });
      }
      step(
        `page ${page} carries ${expected} set(s) of /QuadPoints, so the mark is aligned to the text, not a rectangle`,
      );
    }

    if (args.expectAnnotationsPrint) {
      const unprintable = reading.pages.filter((page) => page.subtypes.length > 0 && !page.allPrint);
      if (unprintable.length > 0) {
        fail(`annotations on page ${unprintable[0]!.page} are missing /F 4 and would not print`, {
          readWith: 'pikepdf',
          hint: 'an annotation that vanishes on paper is the defect `annotate` exists to avoid',
        });
      }
      step('every annotation carries the print flag (/F 4), so the marks survive being printed');
    }
  }

  console.log(`\n${args.tool} E2E passed — ${steps.length} checks against ${args.base}`);
}

await main();
