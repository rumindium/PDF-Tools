import { z } from 'zod';
import { PAGE_RANGE_PATTERN } from './page-ranges';

/**
 * Option schemas — transcribed from `docs/0-TOOL-REGISTRY.md` §4.
 *
 * The API parses with these (`.strict()`, so an unknown key is a `VALIDATION_ERROR` rather than a silent
 * no-op) and the workers re-validate the payload at claim time. The web app renders its forms from the same
 * schemas via `optionsUi`, so "what the form allowed" and "what the API accepts" cannot drift.
 */

// The grammar itself lives in `./page-ranges` and is imported by all three layers that spell it — this schema, the
// web form, and the workers' expansion. It was a literal copy here and a subset parser there, which is how `4-z`,
// `even` and `odd` stayed documented in `docs/02-SPLIT-AND-EXTRACT.md` §2 while every submission of them was refused
// at this line.
export const PageRange = z.string().regex(PAGE_RANGE_PATTERN, 'Use a page (7), a range (1-5), 10-z, even, or odd');

/**
 * A colour, as `#rrggbb`.
 *
 * Parsed as hex by every tool that draws: the value becomes three 0–1 channels that go straight into a PostScript
 * `setrgbcolor`. An unvalidated string is therefore not a cosmetic looseness — `"red"` parses to `NaN NaN NaN`, and the
 * failure surfaces as a Ghostscript syntax error inside a job instead of as a `VALIDATION_ERROR` at the door. The
 * regex was written inline for `watermark` first and is shared here so the tools that followed cannot forget it.
 */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour, e.g. #ff8800');

/**
 * `13-EDIT-AND-ANNOTATE.md` §6's "5 000 freehand points per element", as a number the contract can enforce.
 *
 * Beside `HexColor` rather than inside `EditElement`: the handler re-checks the same figure, and two spellings of a
 * limit is how one of them becomes stale.
 */
export const FREEHAND_POINTS_MAX = 5000;

// ─── Organize ───────────────────────────────────────────────────────────────

export const MergeOptions = z
  .object({
    order: z.array(z.string().uuid()).optional(),
    bookmarks: z.enum(['none', 'keep', 'flatten']).default('keep'),
  })
  .strict();

export const SplitOptions = z
  .object({
    mode: z.enum(['ranges', 'every-n', 'by-size', 'by-bookmarks']).default('ranges'),
    ranges: z.array(z.array(PageRange)).max(100).optional(),
    everyNPages: z.number().int().min(1).max(500).optional(),
    bySizeMb: z.number().min(0.1).max(500).optional(),
    byBookmarks: z.enum(['level1', 'level2', 'all']).optional(),
    mergeOutputs: z.boolean().default(false),
  })
  .strict();

export const ExtractPagesOptions = z
  .object({
    pages: z.array(PageRange).min(1).max(5000),
    mode: z.enum(['include', 'exclude']).default('include'),
  })
  .strict();

export const DeletePagesOptions = z
  .object({
    pages: z.array(PageRange).min(1).max(5000),
  })
  .strict();

export const ReorderPagesOptions = z
  .object({
    order: z.array(z.number().int().min(1)).optional(),
    duplicate: z.array(z.number().int().min(1)).optional(),
    reverse: z.boolean().default(false),
  })
  .strict()
  .refine((v) => (v.order?.length ?? 0) > 0 || (v.duplicate?.length ?? 0) > 0 || v.reverse, {
    message: 'Provide a page order, a set of pages to duplicate, or reverse',
  });
// There is no `insertPages` (pass 5, defect 138). The option was declared here, rendered in the form as a JSON box, and
// documented in `03-ORGANIZE-ROTATE-CROP.md` §2.1/§4/§7 as "insert selected pages of another upload" — but this tool's
// input is `{ ...PDF }`, i.e. `maxFiles: 1`, so a second document can never be part of a `reorder-pages` job and the API
// rejects the request that would carry it. Nothing could ever act on it: the handler warned and reordered without the
// insertions. Removing the option is the fix the `zipSingle` removal (defect 128) already established — a declared,
// rendered, documented option that no code path can honour is worse than no option at all, because the JSON box invites
// a caller to build a document that the product then silently declines to build.

export const RotateOptions = z
  .object({
    angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).default(90),
    pages: z.array(PageRange).optional(),
    perPage: z.record(z.string(), z.union([z.literal(90), z.literal(180), z.literal(270)])).optional(),
  })
  .strict();

/**
 * The share of a page a crop has to keep for the engine to accept it.
 *
 * A **plausibility guard, not a preference**: auto-crop measures the content box, and a noise speck in the corner of a
 * scan produces a technically correct bounding box the size of a full stop — cropping to it hands back a document that
 * looks blank. The writing pass skips any page under this ratio and warns (`AUTO_CROP_MARGIN_GUARD`).
 *
 * It lives here, in the package the UI and the worker both import, because it is a property of the *request*: a form
 * that let a user drag a 4 % box would be drawing a crop the job silently declines to make, and a second copy of the
 * constant is how the two would come to disagree. `apps/web/src/features/page-crop/model.ts` clamps the drag to it.
 */
export const CROP_MIN_KEPT_RATIO = 0.1;

export const CropOptions = z
  .object({
    auto: z.boolean().default(false),
    box: z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() }).optional(),
    units: z.enum(['mm', 'pt', 'percent']).default('mm'),
    pages: z.array(PageRange).optional(),
  })
  .strict();

export const NUpOptions = z
  .object({
    perSheet: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(9), z.literal(16)]).default(2),
    pageSize: z.enum(['a4', 'a3', 'letter', 'legal', 'source']).default('a4'),
    orientation: z.enum(['portrait', 'landscape']).default('portrait'),
    gap: z.number().min(0).max(20).default(3),
    border: z.boolean().default(false),
  })
  .strict();

// ─── Convert ────────────────────────────────────────────────────────────────

export const ImagesToPdfOptions = z
  .object({
    pageSize: z.enum(['fit', 'a4', 'a3', 'letter', 'legal']).default('fit'),
    orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
    fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
    margin: z.number().min(0).max(50).default(0),
    order: z.array(z.string()).optional(),
    heicFallback: z.enum(['convert', 'reject']).default('convert'),
  })
  .strict();

export const PdfToImagesOptions = z
  .object({
    format: z.enum(['jpg', 'png', 'webp']).default('jpg'),
    dpi: z.number().int().min(36).max(600).default(150),
    quality: z.number().int().min(1).max(100).default(85),
    pages: z.array(PageRange).optional(),
    colorMode: z.enum(['color', 'grayscale', 'bw']).default('color'),
    // No `zipSingle`. The option was declared here, rendered in the form, documented in `06-PDF-TO-IMAGES.md` §2 and
    // read by **no code at all**: the runtime packs an archive only when there is more than one output, and the API
    // advertises `archiveUrl` only for a multi-part result, so a one-page export returned the image itself with the
    // option on *and* off — while the form's hint said a one-page PDF comes back as a ZIP unless it was on (defect
    // 128, pass 3). Implementing it would have meant teaching the runtime, the API and the result panel to produce
    // and serve a one-entry archive for a single image: three layers of code to make a *worse* default true. The rule
    // that exists is the one `split` documents — one output is served as itself, `?part=archive` on it serves that
    // output rather than a 404 — and it is asserted now instead of described.
  })
  .strict();

export const PdfToTextOptions = z
  .object({
    pages: z.array(PageRange).optional(),
    layout: z.enum(['plain', 'preserve']).default('plain'),
    ocrFallback: z.boolean().default(false),
  })
  .strict();

export const OfficeToPdfOptions = z
  .object({
    /**
     * A **page** range for the export, in LibreOffice's own grammar (`1`, `1-3`, `1,3-5`).
     *
     * It was `sheetRange` and it was a worksheet selector, which this engine cannot do: measured in the pool, the
     * Calc export filter's `PageRange` numbers the *document's* pages across sheets (`PageRange: '3'` on a
     * three-sheet workbook returned page 3 — sheet 2's first page, proved by which sheet's marker text the output
     * carried — while a sheet *name* produced no file at all). The same property works for Writer and Impress, so
     * the option is named for what it does and applies to all three families (`docs/07-OFFICE-TO-PDF.md` §2).
     */
    pageRange: z.string().max(64).optional(),
    slideNotes: z.boolean().default(false),
    fitToPage: z.boolean().default(true),
  })
  .strict();

export const HtmlToPdfOptions = z
  .object({
    pageSize: z.enum(['a4', 'a3', 'letter', 'legal']).default('a4'),
    landscape: z.boolean().default(false),
    marginMm: z.number().min(0).max(50).default(12),
    printBackground: z.boolean().default(true),
  })
  .strict();

export const PdfToHtmlOptions = z
  .object({
    mode: z.enum(['reflow', 'fixed']).default('reflow'),
    pages: z.array(PageRange).optional(),
    embedImages: z.boolean().default(true),
    singleFile: z.boolean().default(false),
    responsive: z.boolean().default(true),
  })
  .strict();

export const PdfToCsvOptions = z
  .object({
    pages: z.array(PageRange).optional(),
    tableStrategy: z.enum(['auto', 'ruled', 'stream', 'lattice']).default('auto'),
    allTables: z.boolean().default(true),
    delimiter: z.enum([',', ';', '\t']).default(','),
    decimalComma: z.boolean().default(false),
    headerRow: z.boolean().default(true),
  })
  .strict();

/**
 * One band: the three zones, the type, and the rule — the shape `header` and `footer` share, and the shape
 * `differentFirstPage` overrides with.
 *
 * Declared once because it is now spelled in three places, and a band that is `header` here and something narrower
 * there is how `12-…` §2's table drifted from this schema in the first place.
 */
const HeaderFooterBand = z.object({
  left: z.string().max(120).optional(),
  center: z.string().max(120).optional(),
  right: z.string().max(120).optional(),
  fontSize: z.number().min(6).max(18).default(9),
  color: HexColor.default('#333333'),
  rule: z.boolean().default(false),
});

export const HeaderFooterOptions = z
  .object({
    header: HeaderFooterBand.optional(),
    footer: HeaderFooterBand.optional(),
    /**
     * The bands page **one** uses instead of `header`/`footer` (`12-…` §2, §5).
     *
     * Replacement rather than merge, which is what a cover page needs: a band left out here is a band that page
     * does not carry, so `{ footer: {…} }` alone gives page one a footer and no header even when the document has
     * one on every other page. Word's "different first page" behaves the same way, and the merge reading — "keep
     * everything and change one zone" — makes "no footer on the cover" impossible to say.
     *
     * Page *one* of the document, not the first page this job stamps: a job that also sets `skipFirstPage` never
     * draws page one, so the option has nothing to change there and the metrics say so rather than a band quietly
     * appearing on page two.
     */
    differentFirstPage: z
      .object({ header: HeaderFooterBand.optional(), footer: HeaderFooterBand.optional() })
      .optional(),
    logoFileId: z.string().uuid().optional(),
    /**
     * Which end of the header band the logo sits at.
     *
     * `12-…` §2 puts this inside `logo.position`; the shipped surface flattens it, because a nested object has no
     * control and would have made the whole logo a JSON blob. The band's own `left`/`right` text is *not* moved
     * aside — a logo and a zone that both claim the same end will overlap, and the user chose both.
     */
    logoPosition: z.enum(['left', 'right']).default('left'),
    /** The logo's height; the width follows from the image's aspect ratio. */
    logoHeightMm: z.number().min(4).max(40).default(8),
    /**
     * The logo's opacity, applied as a constant fill alpha on the logo's own overlay.
     *
     * `12-…` §2 lists it inside `logo`; the shipped surface flattens it like the rest of the logo's keys. The
     * attenuation is the merge's existing `/ExtGState` mechanism, so the logo's own per-pixel alpha multiplies with
     * it instead of being replaced by it.
     */
    logoOpacity: z.number().min(0.02).max(1).default(1),
    pages: z.array(PageRange).optional(),
    skipFirstPage: z.boolean().default(false),
    marginMm: z.number().min(5).max(40).default(12),
  })
  .strict()
  .refine((v) => v.header || v.footer, { message: 'Provide header or footer content' });

export const PdfToOfficeOptions = z
  .object({
    target: z.enum(['docx', 'xlsx', 'pptx']),
    pages: z.array(PageRange).optional(),
    /**
     * `docx` only: reproduce the page's layout. False gives flowing paragraphs instead — and so does
     * `detectTables: false`, because the layout engine always emits tables.
     */
    keepLayout: z.boolean().default(true),
    /** `docx`/`xlsx`: emit real tables (Word tables, one sheet per table) rather than paragraphs and a text grid. */
    detectTables: z.boolean().default(true),
    /** `pptx`: JPEG quality of each slide's page image. 1–100. */
    imageQuality: z.number().int().min(1).max(100).default(85),
    /** `xlsx`: one worksheet per PDF page instead of one sheet per detected table. */
    oneSheetPerPage: z.boolean().default(false),
  })
  .strict();

export const PdfToPdfaOptions = z
  .object({
    profile: z.enum(['1b', '2b', '3b']).default('2b'),
    embedAllFonts: z.boolean().default(true),
    forceSrgb: z.boolean().default(true),
  })
  .strict();

// ─── Optimize ───────────────────────────────────────────────────────────────

export const CompressOptions = z
  .object({
    preset: z.enum(['extreme', 'recommended', 'light', 'custom']).default('recommended'),
    targetSizeMb: z.number().min(0.05).max(500).optional(),
    imageQuality: z.number().int().min(10).max(100).default(70),
    dpi: z.number().int().min(36).max(300).default(150),
    stripMetadata: z.boolean().default(true),
    linearize: z.boolean().default(true),
  })
  .strict();

/** The three stores a PDF keeps its identity in, in the order the UI lists them. */
export const MetadataStore = z.enum(['xmp', 'docinfo', 'attachments']);

export const RemoveMetadataOptions = z
  .object({
    // The `text` control renders what the user typed, so `"xmp, docinfo"` is the *form's* spelling and an array is
    // the API's. Accepting only the array would leave an enabled tool whose one option cannot be set from the UI —
    // a gap the registry test cannot see, because it checks that a control exists, not that what the control sends
    // validates. Blank entries are dropped so a trailing comma is not a 422.
    keep: z.preprocess(
      (value) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : value,
      z.array(MetadataStore).max(3).default([]),
    ),
  })
  .strict();

export const LinearizeOptions = z
  .object({
    optimizeImages: z.boolean().default(false),
  })
  .strict();

// ─── Security ───────────────────────────────────────────────────────────────

/**
 * What a reader may do with a protected document.
 *
 * Every field has a default, so a caller sends only what they want to change (`{"copy": false}`) and the parsing
 * result always carries all eight flags. That completeness is load-bearing rather than tidy: the encryption engine
 * writes one permission bit per flag and cannot distinguish "false" from "absent", so a schema that let fields be
 * missing would push a second set of defaults into the engine — one that the UI, the API, and the handler would each
 * eventually express differently. There is deliberately no `.partial()` here: it is redundant next to per-field
 * defaults, and its only other effect was to type the parsed object as optional (`options.permissions.print` being
 * `boolean | undefined`), which is a type that contradicts what parsing actually returns.
 */
export const PermissionFlags = z.object({
  print: z.boolean().default(true),
  printHighRes: z.boolean().default(false),
  copy: z.boolean().default(false),
  modify: z.boolean().default(false),
  annotate: z.boolean().default(true),
  fillForms: z.boolean().default(true),
  assemble: z.boolean().default(false),
  accessibility: z.boolean().default(true),
});

/**
 * The revisions this build can write, and the one fact that decides whether `accessibility: false` means anything.
 *
 * `rc4-128` is offered because the flag opposite it — `accessibility` — is honoured **only** there, which made leaving
 * it out of the enum a contradiction: the engine carried a warning saying the flag is pointless on AES
 * ("meaningful for the RC4 revisions") while the contract made those revisions unreachable, so `accessibility: false`
 * was an option that could never do anything. It stays opt-in and last: RC4 is cryptographically broken and the tool
 * says so in its own warning, but refusing outright breaks the legitimate "my 2009 ERP only reads RC4" case, and the
 * choice is the caller's to make with the cost stated.
 */
export const EncryptionRevisions = z.enum(['aes-256', 'aes-128', 'rc4-128']);

/**
 * "Hold me to the strength policy even though my plan does not" — `./password-strength.ts`, `strongPasswordsRequired`.
 *
 * Optional and **without a default**, which is load-bearing rather than a style choice: a schema default would make an
 * absent field indistinguishable from an explicit `false`, and the API resolves the field from the caller's plan for the
 * passwords this tool *sets*. `.optional()` leaves the distinction intact — absent means "use my plan's rule", `true`
 * means "apply it regardless", and `false` is accepted but cannot lower a plan that already requires it.
 */
const requireStrongPasswordsField = z.boolean().optional();

export const EncryptOptions = z
  .object({
    userPassword: z.string().min(1).max(128).optional(),
    ownerPassword: z.string().min(6).max(128).optional(),
    encryption: EncryptionRevisions.default('aes-256'),
    permissions: PermissionFlags.default({}),
    requireStrongPasswords: requireStrongPasswordsField,
  })
  .strict()
  .refine((v) => v.userPassword || v.ownerPassword, { message: 'Provide a user or owner password' });

export const RestrictOptions = z
  .object({
    ownerPassword: z.string().min(6).max(128).optional(),
    encryption: EncryptionRevisions.default('aes-256'),
    permissions: PermissionFlags.default({}),
    requireStrongPasswords: requireStrongPasswordsField,
  })
  .strict();

export const UnlockOptions = z
  .object({
    password: z.string().min(1).max(128),
  })
  .strict();

// ─── Edit ───────────────────────────────────────────────────────────────────

export const WatermarkOptions = z
  .object({
    kind: z.enum(['text', 'image']).default('text'),
    text: z.string().min(1).max(200).optional(),
    imageFileId: z.string().uuid().optional(),
    font: z.string().default('Helvetica'),
    fontSize: z.number().min(6).max(200).default(48),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#9aa0a6'),
    opacity: z.number().min(0.02).max(1).default(0.25),
    rotation: z.number().min(-90).max(90).default(-45),
    position: z.enum(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'tile']).default('center'),
    /**
     * Tile gaps, as a percentage of the page, per axis — the shipped spelling of `11-WATERMARK.md` §2's
     * `tileSpacingPercent`, which the schema never had.
     *
     * **10–90 %, and the bound is the product's own.** The gap decides the grid (`round(100 / gap)` stamps per axis), so
     * the range is a stamp count and `0.5` was 200 stamps a page: a 200-page document would ask Ghostscript for 40 000
     * text placements in one program, inside a 150 s budget. The document has published the range since it was written
     * (§6: "spacing 10–90 % → 1–100 stamps per page") and the handler's clamp now says the same thing, so a caller that
     * ignored it is refused by name instead of stalling a worker.
     */
    tile: z.object({ x: z.number().min(10).max(90), y: z.number().min(10).max(90) }).optional(),
    /**
     * Image watermarks only: how wide the image may be, as a share of the target page's width.
     *
     * The height follows from the image's own aspect ratio, so a wide logo and a square seal both come out
     * undistorted without a second dimension to get wrong.
     */
    scalePercent: z.number().int().min(10).max(100).default(100),
    pages: z.array(PageRange).optional(),
    /**
     * Cover-page handling (`11-WATERMARK.md` §2): page one is either stamped or it is not.
     *
     * The document has named this since it was written, and its own §3 example and §7 assertion are written with it —
     * while the schema, which is `.strict()`, refused the key. The rule is the one `page-numbers` and `header-footer`
     * apply to the same word: the page is removed from the **selection**, so nothing about it is drawn.
     */
    skipFirstPage: z.boolean().default(false),
    underContent: z.boolean().default(false),
  })
  .strict()
  .refine((v) => (v.kind === 'text' ? Boolean(v.text) : Boolean(v.imageFileId)), {
    message: 'Text watermarks need text; image watermarks need an image file',
  });

/**
 * Bates numbering: `PREFIX000123SUFFIX`, the shape legal discovery requires.
 *
 * `12-PAGE-NUMBERS-HEADERS-FOOTERS.md` §2 has carried this object since the document was written, with the rule that
 * it overrides `format`, and nothing read it. `digits` is a **minimum** width, not a truncation: a run that reaches
 * `1000000` with `digits: 6` prints seven digits rather than dropping the leading one, because a Bates number that
 * silently repeats is worse than one that is a digit wider.
 */
export const BatesNumbering = z
  .object({
    prefix: z.string().max(40).default(''),
    suffix: z.string().max(40).default(''),
    digits: z.number().int().min(1).max(12).default(6),
    /** The number the first stamped page carries; absent means "follow `startAt`". */
    startAt: z.number().int().min(0).optional(),
  })
  .strict();

export const PageNumberOptions = z
  .object({
    position: z
      .enum(['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'])
      .default('bottom-center'),
    format: z.enum(['n', 'n-of-total', 'page-n', 'page-n-of-total']).default('n-of-total'),
    startAt: z.number().int().min(1).default(1),
    /**
     * The PDF page the displayed numbering starts at, separate from `startAt`.
     *
     * `countFrom: 3, startAt: 1` means the third page of the document displays "1" — how unnumbered front matter
     * (a cover, a table of contents) is skipped without renumbering the body by hand. Pages before it are not
     * stamped, which is the same rule `skipFirstPage` applies to page one: a page that is not part of the numbered
     * sequence has no business carrying one of its numbers.
     */
    countFrom: z.number().int().min(1).optional(),
    pages: z.array(PageRange).optional(),
    /**
     * The stamp's colour, defaulting to the document's own grey.
     *
     * `12-…` §4 makes the case for `#333333` over pure black ("a stamp in pure black looks like part of the
     * document"), and then offers the reader the ability to change it — which no schema field existed for. The
     * document's own default is the schema's default.
     */
    color: HexColor.default('#333333'),
    font: z.string().default('Helvetica'),
    fontSize: z.number().min(6).max(36).default(10),
    marginMm: z.number().min(2).max(40).default(12),
    /** Cover-page handling: page one is either stamped or it is not. */
    skipFirstPage: z.boolean().default(false),
    /** Bates numbering; when present it replaces the `format` presets. */
    bates: BatesNumbering.optional(),
  })
  .strict();

export const EditElement = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    text: z.string().max(2000),
    font: z.string().default('Helvetica'),
    size: z.number().min(4).max(144).default(12),
    color: HexColor.default('#111111'),
    rotation: z.number().default(0),
  }),
  z.object({
    type: z.literal('image'),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    fileId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('shape'),
    page: z.number().int().min(1),
    shape: z.enum(['rect', 'ellipse', 'line', 'arrow']),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    stroke: HexColor.default('#1a73e8'),
    fill: HexColor.nullable().default(null),
    strokeWidth: z.number().min(0.5).max(20).default(1),
  }),
  z.object({
    type: z.literal('draw'),
    page: z.number().int().min(1),
    color: HexColor.default('#111111'),
    strokeWidth: z.number().min(0.5).max(20).default(2),
    /**
     * A freehand stroke's points, in PDF user space.
     *
     * Capped at `FREEHAND_POINTS_MAX` because the number is the only bound on a single option value: every point becomes
     * a PostScript path segment, and `13-EDIT-AND-ANNOTATE.md` §6 has promised "5 000 per element" since the document
     * was written while nothing enforced it — measured in pass 9 with 5 001 points, which completed. The handler checks
     * it again, because a worker is the second entry point.
     */
    points: z
      .array(z.object({ x: z.number(), y: z.number() }))
      .min(2)
      .max(FREEHAND_POINTS_MAX),
  }),
  z.object({
    type: z.literal('checkbox'),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    size: z.number().min(4).max(40).default(12),
    checked: z.boolean().default(true),
    color: HexColor.default('#111111'),
  }),
]);

export const EditPdfOptions = z
  .object({
    elements: z.array(EditElement).min(1).max(200),
    flatten: z.boolean().default(true),
  })
  .strict();

export const AnnotationElement = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('highlight'),
    page: z.number().int().min(1),
    rects: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).min(1),
    color: HexColor.default('#ffe066'),
  }),
  z.object({
    type: z.literal('underline'),
    page: z.number().int().min(1),
    rects: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).min(1),
    color: HexColor.default('#1a73e8'),
  }),
  z.object({
    type: z.literal('strike'),
    page: z.number().int().min(1),
    rects: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).min(1),
    color: HexColor.default('#d93025'),
  }),
  z.object({
    type: z.literal('note'),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    text: z.string().max(2000),
    author: z.string().max(80).default('PDF Tools'),
  }),
]);

export const AnnotateOptions = z
  .object({
    annotations: z.array(AnnotationElement).min(1).max(500),
    flatten: z.boolean().default(false),
  })
  .strict();

/**
 * One rectangle to erase, on one page.
 *
 * `x`/`y` are the rect's **lower-left** corner with the page's own lower-left origin — the same convention
 * `annotate`'s markup rects use, because both come from the same drag on the same preview canvas. PyMuPDF's rects
 * are upper-left, so the flip happens once inside the redaction engine, where `redaction.ts` documents it.
 */
export const RedactRect = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .strict();

/** The rectangles drawn on one page, which is how a redaction UI collects them. */
export const RedactRegion = z
  .object({
    page: z.number().int().min(1),
    rects: z.array(RedactRect).min(1).max(20),
    /** Overrides the job-wide `fill` for this page's rectangles, as `docs/13-EDIT-AND-ANNOTATE.md` §2 specifies. */
    fill: HexColor.optional(),
  })
  .strict();

/**
 * `redact` — `docs/13-EDIT-AND-ANNOTATE.md` §2.
 *
 * The only tool in this build whose whole product is an **absence**, so its options are the four separate decisions
 * that absence is made of: remove the content (`removeContent`), remove what described it (`removeMetadata`,
 * `removeAttachments`), and remove what would still show it if left alone (`scrubAnnotations`). Every one defaults to
 * `true`; `removeContent: false` is deliberately available as visual-only masking and the job says so with
 * `REDACTION_NOT_REMOVED`, which `13-EDIT-AND-ANNOTATE.md` §7 asserts rather than tolerates.
 *
 * `pages` was in the document's first draft and is not here: a region already names its page, and a second page
 * selector that can disagree with the first is a way to redact the wrong page while the payload reads correctly.
 * `13-EDIT-AND-ANNOTATE.md` §8 records the removal.
 */
export const RedactOptions = z
  .object({
    regions: z.array(RedactRegion).min(1).max(64),
    fill: HexColor.default('#000000'),
    removeContent: z.boolean().default(true),
    removeMetadata: z.boolean().default(true),
    removeAttachments: z.boolean().default(true),
    scrubAnnotations: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The cap that matters is rectangles, not page groups: each one becomes a redaction annotation and an area the
    // verification has to read back. §6's "200 regions, 20/page" is enforced here so an oversized job is refused at
    // the door rather than after the file is written.
    const rects = value.regions.reduce((total, region) => total + region.rects.length, 0);
    if (rects > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: `A redaction job takes at most 200 rectangles; this one has ${rects}.`,
      });
    }
  });

// ─── Document and OCR ───────────────────────────────────────────────────────

/**
 * A place to sign: a rectangle in PDF user space, or in millimetres, or as a share of the page.
 *
 * `x`/`y` are the box's **lower-left** corner and the origin is the page's lower-left, which is the same convention
 * every other placement in this contract uses (`edit-pdf`'s rects, an overlay's `yPt`). A browser preview has its
 * origin at the top-left and flips `y` once at the boundary; the alternative — a hidden flip inside the engine —
 * would make this `y` mean the opposite of `edit-pdf`'s with nothing in the payload to say so.
 */
export const SignaturePlacement = z
  .object({
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    units: z.enum(['pt', 'mm', 'percent']).default('pt'),
  })
  .strict();

/**
 * `sign` — `docs/14-SIGN-AND-FORMS.md` §2.
 *
 * The names are the document's, not the ones this module carried before the tool was implemented: `kind` is
 * `typed`/`drawn`/`image` (the first draft said `type`/`draw`, which read like a verb beside `image`, a noun), the
 * image is named by `imageFileId` like every other upload in the catalog, and the typed name is `signature`.
 *
 * `date` is an **ISO string** and `showDateStamp` is the toggle that draws it — the earlier `date: boolean` merged
 * two different questions ("what date was this signed" and "do you want it printed") into one field that could not
 * answer either. Left unset, the job time is used, which is what a signature means anyway.
 */
export const SignOptions = z
  .object({
    kind: z.enum(['typed', 'drawn', 'image']).default('typed'),
    /** The name to render, in a handwriting-ish face. Required when `kind` is `typed` (`SIGNATURE_REQUIRED`). */
    signature: z.string().max(120).optional(),
    /** The uploaded PNG for `kind: 'drawn'` (a browser canvas export) or `kind: 'image'`. */
    imageFileId: z.string().uuid().optional(),
    font: z.enum(['script', 'serif', 'sans']).default('script'),
    fields: z.array(SignaturePlacement).min(1).max(20),
    reason: z.string().max(200).default('Signed with PDF Tools'),
    location: z.string().max(200).optional(),
    /**
     * ISO 8601. Defaults to the job's own time, and lands in the document metadata either way.
     *
     * Constrained rather than merely typed as a string: `new Date('17 September 2026')` parses, so a free-form date
     * would let a locale-dependent string set the date on a legal document. The date part is mandatory; a time and an
     * offset are optional, and a date alone means UTC midnight.
     */
    date: z
      .string()
      .max(40)
      .regex(
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/,
        'Use ISO 8601, e.g. 2026-09-17 or 2026-09-17T09:30:00Z',
      )
      .optional(),
    signerName: z.string().max(120).optional(),
    signerEmail: z.string().max(160).email().optional(),
    showDateStamp: z.boolean().default(true),
    showSignerName: z.boolean().default(false),
    /** Draw a visible box around each signature. Unset means no border. */
    borderColor: HexColor.optional(),
  })
  .strict();

export const FillFormOptions = z
  .object({
    fields: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])),
    /**
     * `docs/14-SIGN-AND-FORMS.md` §4: filling a form is usually the *send it back to HR* flow, where the point is that
     * the recipient cannot change what was typed — so locking is the default, not an extra step.
     */
    flatten: z.boolean().default(true),
    /**
     * `'filled'` keeps the fields the caller did not fill interactive (`14-SIGN-AND-FORMS.md` §4), `'all'` flattens
     * every field — an empty one that cannot be drawn is removed, because a form the recipient can still type into is
     * not a flattened form.
     */
    flattenMode: z.enum(['filled', 'all']).default('filled'),
  })
  .strict();

export const ExtractFieldsOptions = z
  .object({
    includeValues: z.boolean().default(true),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

export const OcrOptions = z
  .object({
    // `languages` is the second option in this file whose control is a plain text box and whose schema wanted an
    // array, and it was found the way the first one should have been: by asking the schema what the control can send.
    // Measured, `validateOptions('ocr', { languages: 'eng' })` was `Expected array, received string` — so the OCR form
    // had an enabled tool whose one *required* option could not be set from the UI at all, and the hint beside the box
    // ("e.g. eng, ind — up to three") promised the comma-separated spelling that the schema refused. The schema is the
    // half that was wrong: the form's spelling is the one a person types, and `remove-metadata`'s `keep` above already
    // carries exactly this coercion for exactly this reason. An empty box stays distinguishable from a bad one — it
    // means "not specified" and resolves to the default — so clearing the field is not a 422.
    languages: z.preprocess(
      (value) =>
        typeof value === 'string'
          ? value.trim() === ''
            ? undefined
            : value
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
          : value,
      z
        .array(z.string().regex(/^[a-z]{3}(\+[a-z]{3})*$/))
        .min(1)
        .default(['eng']),
    ),
    preset: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
    outputMode: z.enum(['searchable-pdf', 'text-only', 'pdf-and-text']).default('searchable-pdf'),
    deskew: z.boolean().default(true),
    // The resolution the *recognition* runs at, and — for an image input — the resolution the page is built with.
    //
    // `15-OCR.md` has carried this row since the document was written ("200–600; auto reads the embedded image
    // resolution and only up-rasters when below 200") and no code ever read it. The upper bound is OCRmyPDF's own
    // practical ceiling: past 600 dpi the recognition cost grows and the accuracy does not, and the megapixel guard in
    // the engine starts refusing very large pages. The lower bound is the point below which OCRmyPDF's `--oversample`
    // has nothing to work with on a page that already claims more resolution than it has.
    dpi: z.number().int().min(200).max(600).optional(),
    // "despeckle/binarise before recognition (helps faxes, hurts photos)" — OCRmyPDF's `--clean`, which is the same
    // promise. Off by default because the document says so and because it is the *slower* path: the cleaning pass runs
    // per page before recognition, and on a clean scan it only adds bytes (measured: 36 KB → 52 KB on a 300 dpi A4
    // page), which is exactly why the option exists rather than being unconditional.
    clean: z.boolean().default(false),
    pages: z.array(PageRange).optional(),
    sidecar: z.boolean().default(false),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Parsed option types.
//
// Each schema is exported under the *same* name as its type: TypeScript keeps the value and type namespaces
// separate, so `MergeOptions` is a zod schema where a value is expected and an options object where a type is
// expected. That is what lets a worker write `Handler<MergeOptions>` and a caller write
// `MergeOptions.parse(input)` against one import, instead of every file repeating `z.infer<typeof …>` and one of
// them eventually drifting from the schema.
// ─────────────────────────────────────────────────────────────────────────────

export type MergeOptions = z.infer<typeof MergeOptions>;
export type SplitOptions = z.infer<typeof SplitOptions>;
export type ExtractPagesOptions = z.infer<typeof ExtractPagesOptions>;
export type DeletePagesOptions = z.infer<typeof DeletePagesOptions>;
export type ReorderPagesOptions = z.infer<typeof ReorderPagesOptions>;
export type RotateOptions = z.infer<typeof RotateOptions>;
export type CropOptions = z.infer<typeof CropOptions>;
export type NUpOptions = z.infer<typeof NUpOptions>;
export type ImagesToPdfOptions = z.infer<typeof ImagesToPdfOptions>;
export type PdfToImagesOptions = z.infer<typeof PdfToImagesOptions>;
export type PdfToTextOptions = z.infer<typeof PdfToTextOptions>;
export type OfficeToPdfOptions = z.infer<typeof OfficeToPdfOptions>;
export type HtmlToPdfOptions = z.infer<typeof HtmlToPdfOptions>;
export type PdfToHtmlOptions = z.infer<typeof PdfToHtmlOptions>;
export type PdfToCsvOptions = z.infer<typeof PdfToCsvOptions>;
export type HeaderFooterOptions = z.infer<typeof HeaderFooterOptions>;
export type PdfToOfficeOptions = z.infer<typeof PdfToOfficeOptions>;
export type PdfToPdfaOptions = z.infer<typeof PdfToPdfaOptions>;
export type CompressOptions = z.infer<typeof CompressOptions>;
export type RemoveMetadataOptions = z.infer<typeof RemoveMetadataOptions>;
export type LinearizeOptions = z.infer<typeof LinearizeOptions>;
export type PermissionFlags = z.infer<typeof PermissionFlags>;
export type EncryptOptions = z.infer<typeof EncryptOptions>;
export type RestrictOptions = z.infer<typeof RestrictOptions>;
export type UnlockOptions = z.infer<typeof UnlockOptions>;
export type WatermarkOptions = z.infer<typeof WatermarkOptions>;
export type PageNumberOptions = z.infer<typeof PageNumberOptions>;
export type EditElement = z.infer<typeof EditElement>;
export type EditPdfOptions = z.infer<typeof EditPdfOptions>;
export type AnnotationElement = z.infer<typeof AnnotationElement>;
export type AnnotateOptions = z.infer<typeof AnnotateOptions>;
export type RedactOptions = z.infer<typeof RedactOptions>;
export type SignOptions = z.infer<typeof SignOptions>;
export type FillFormOptions = z.infer<typeof FillFormOptions>;
export type ExtractFieldsOptions = z.infer<typeof ExtractFieldsOptions>;
export type OcrOptions = z.infer<typeof OcrOptions>;
