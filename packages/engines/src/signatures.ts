import { JobFailure } from '@pdftools/errors';
import { hexToRgbTriplet } from './fonts';
import { type RunOptions, runPdfToText } from './index';
import type { ImageStampPage, OverlayPage, OverlayPlacement, OverlayVector } from './overlay';
import { parseJsonLine, runPythonScript } from './python';

/**
 * `sign` — `docs/14-SIGN-AND-FORMS.md`.
 *
 * This is an **ink signature**, and the module is arranged around not pretending otherwise: ink goes on the page, the
 * signer, the reason and the time go into the document's metadata, and the job reports `NOT_A_DIGITAL_SIGNATURE` on
 * every success. There is deliberately no `/Sig` field, no `/ByteRange` and no `/Perms` in the output, because a
 * signature dictionary without a certificate produces documents some validators report as "signature broken" —
 * worse than an honest ink mark, and impossible to tell apart from a real signature by looking at the page.
 * `readSignatureRecord()` exists so that claim is *checked on the output* rather than asserted in a comment: the
 * handler runs it and reports what it found, and a golden case reads the same facts from the bytes.
 *
 * Four decisions worth knowing before reading the code:
 *
 *  1. **Geometry is PDF user space — points from the page's bottom-left — like every other placement in this
 *     codebase.** `units` converts the caller's numbers once, in `planSignaturePlacements`. A browser preview has its
 *     origin at the top-left and flips `y` at its own boundary; a hidden flip here would make this tool's `y` mean the
 *     opposite of `edit-pdf`'s with nothing in the payload to say so.
 *  2. **Two builders, and one job may use both.** Text is typeset by Ghostscript (`renderOverlayPdf`) because only a
 *     typesetter can measure a face; a bitmap needs a matrix, so it is assembled by pikepdf (`buildImageOverlayPdf`).
 *     A drawn signature with a date under it is therefore two overlays merged in sequence, not one builder asked to do
 *     the other's job.
 *  3. **Overlay pages are sized to the page they land on.** pikepdf's `add_overlay` scales the overlay page to the
 *     target rectangle, so an overlay page of the wrong size stretches every stamp on it — the defect
 *     `docs/0-TESTING.md` §5 records for an earlier tool.
 *  4. **The script face is embedded, and it is the only embedded font in this build.** Measured in the heavy image:
 *     `ZapfChancery-MediumItalic` resolves to URW's chancery (base-35 `Z003`) and Ghostscript writes a **subset**
 *     (`pdffonts`: `emb=yes sub=yes`), while `Times-Roman` and `Helvetica` stay non-embedded base-14. Asking for
 *     `script` costs a font program in the output; asking for `serif`/`sans` costs nothing.
 */

/** Family name → the PostScript name Ghostscript resolves. Verified against `pdffonts`, not assumed. */
export const SIGNATURE_FONTS: Record<string, string> = {
  script: 'ZapfChancery-MediumItalic',
  serif: 'Times-Roman',
  sans: 'Helvetica',
};

/**
 * The documented ceiling, restated here so a worker handed a bad payload cannot exceed it.
 *
 * The contract already rejects a 21st placement with a `VALIDATION_ERROR` (`docs/14-SIGN-AND-FORMS.md` §7); the
 * handler re-checks because a worker is a second entry point — a payload can arrive from the queue's replay path
 * rather than from the API's parser.
 */
export const SIGNATURE_PLACEMENT_MAX = 20;

/**
 * `14-SIGN-AND-FORMS.md` §6: the signature image is at most 4 MB and at most 4 000 px on either axis.
 *
 * Both are refusals rather than warnings, because both are free to check and expensive to discover later: an 8 000 px
 * scan placed as a signature multiplies the document's size by tens and there is no option that would fix it after the
 * fact. The byte cap is checked against the uploaded file and the pixel cap against what the engine opened.
 */
export const SIGNATURE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const SIGNATURE_IMAGE_MAX_PX = 4000;

/** The PostScript name for a family, or `null` when this build has no such face. */
export function signatureFont(family: string): string | null {
  return SIGNATURE_FONTS[family.trim().toLowerCase()] ?? null;
}

export function availableSignatureFonts(): string[] {
  return Object.keys(SIGNATURE_FONTS);
}

export interface PageBox {
  widthPt: number;
  heightPt: number;
}

/** A placement as the caller sent it: a box in the units they chose. */
export interface SignaturePlacementInput {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  units: 'pt' | 'mm' | 'percent';
}

/** A placement in points, carrying the page it belongs to and the one fact the caller cannot know. */
export interface PlannedSignature {
  /** 1-based page number in the source document. */
  page: number;
  xPt: number;
  yPt: number;
  wPt: number;
  hPt: number;
  /** The target page's own size — what an overlay page has to match, not the box's extent. */
  pageWidthPt: number;
  pageHeightPt: number;
  units: SignaturePlacementInput['units'];
  /** True when any part of the box falls outside the page. The job still draws it, and reports it. */
  offPage: boolean;
}

const PT_PER_MM = 72 / 25.4;

/**
 * Every placement, in points, validated against the document.
 *
 * `percent` is a share of the **page**: `x`/`w` are fractions of the page's width and `y`/`h` of its height, which is
 * the only reading that keeps a signature in the same place on a portrait and on a landscape page. A page number
 * outside the document is refused rather than clamped — a signature quietly moved to another page is a different
 * document.
 */
export function planSignaturePlacements(
  fields: readonly SignaturePlacementInput[],
  boxes: readonly PageBox[],
): PlannedSignature[] {
  if (fields.length === 0) {
    throw new JobFailure('SIGNATURE_REQUIRED', { message: 'The job has no place to put a signature.' });
  }
  if (fields.length > SIGNATURE_PLACEMENT_MAX) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `${fields.length} placements is above the limit of ${SIGNATURE_PLACEMENT_MAX} for one job.`,
    });
  }

  return fields.map((field) => {
    const box = boxes[field.page - 1];
    if (!box) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `There is no page ${field.page} in this document; it has ${boxes.length}.`,
      });
    }
    const xPt = round2(convert(field.x, field.units, box.widthPt));
    const wPt = round2(convert(field.w, field.units, box.widthPt));
    const yPt = round2(convert(field.y, field.units, box.heightPt));
    const hPt = round2(convert(field.h, field.units, box.heightPt));
    return {
      page: field.page,
      xPt,
      yPt,
      wPt,
      hPt,
      pageWidthPt: box.widthPt,
      pageHeightPt: box.heightPt,
      units: field.units,
      offPage: xPt < 0 || yPt < 0 || xPt + wPt > box.widthPt + 0.01 || yPt + hPt > box.heightPt + 0.01,
    };
  });
}

function convert(value: number, units: SignaturePlacementInput['units'], extentPt: number): number {
  if (units === 'mm') return value * PT_PER_MM;
  if (units === 'percent') return (value / 100) * extentPt;
  return value;
}

/** The lines a signature is made of, and the two toggles that decide which of them are drawn. */
export interface SignatureLines {
  /** The name to set in type, in the chosen face. */
  name: string;
  /** `"Alice Tan · 2026-09-17"` — printed under the name, or under the image. `null` when nothing is printed. */
  meta: string | null;
}

/**
 * The text of the signature block.
 *
 * The date is the caller's when they gave one (an ISO string, parsed and re-formatted) and the job's own clock
 * otherwise. The signer name is printed only when `showSignerName` is on: `signature` is what the user wrote and
 * `signerName` is who they say they are, and printing a name the user did not type into the face they chose would be
 * this module inventing part of the signature.
 */
export function signatureLines(options: {
  signature: string;
  signerName?: string | undefined;
  location?: string | undefined;
  showSignerName: boolean;
  showDateStamp: boolean;
  signedAt: Date;
}): SignatureLines {
  const parts: string[] = [];
  if (options.showSignerName && options.signerName) parts.push(options.signerName);
  if (options.showDateStamp) parts.push(options.signedAt.toISOString().slice(0, 10));
  if (options.showDateStamp && options.location) parts.push(options.location);
  return { name: options.signature, meta: parts.length > 0 ? parts.join(' · ') : null };
}

/**
 * The shape a signing date has to have: ISO 8601, with the date part mandatory.
 *
 * Checked *before* `new Date()`, which is the whole point: V8 happily parses `"17 September 2026"`, `"2026"` and a
 * dozen other locale- and implementation-dependent forms, each to a moment the caller may not have meant — and a
 * signature dated by a parser's guess is worse than one dated by the job clock. The contract carries the same regex,
 * so a non-ISO string is a `VALIDATION_ERROR` at the door; this copy exists because a worker is a second entry point
 * and can be handed a payload from the queue's replay path.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** `2026-09-17T09:30:00Z`, from the caller when they gave one and from the job otherwise. */
export function resolveSignedAt(date: string | undefined, now: Date): Date {
  if (!date) return now;
  const parsed = ISO_DATE.test(date.trim()) ? new Date(date.trim()) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `"${date}" is not ISO 8601, which is the only date form this tool accepts. Use 2026-09-17 or 2026-09-17T09:30:00Z.`,
    });
  }
  return parsed;
}

/** The border a `borderColor` draws around each placement, as the overlay's own vector kind. */
export function signatureBorders(plan: readonly PlannedSignature[], color: string | undefined): OverlayVector[] {
  if (!color) return [];
  const stroke = hexToRgbTriplet(color);
  return plan.map((placement) => ({
    kind: 'rect' as const,
    xPt: placement.xPt,
    yPt: placement.yPt,
    widthPt: placement.wPt,
    heightPt: placement.hPt,
    stroke,
    fill: null,
    strokeWidthPt: 0.75,
  }));
}

/** Type sizes as fractions of the box a caller drew, so a signature in a big box scales its ink with it. */
const NAME_SIZE_OF_BOX = 0.42;
const NAME_SIZE_MIN_PT = 9;
const NAME_SIZE_MAX_PT = 28;
const META_SIZE_PT = 7.5;

/**
 * The typed signature: the name, and the meta line, both **inside** the box the caller drew.
 *
 * Centred rather than left-aligned: a signature starting at the box's left edge looks wrong in every box wider than
 * the name, and measuring a string is the one thing only the typesetter can do (`stringwidth`). The meta line sits
 * below the name in the same box, which is how a signature block reads.
 */
export function signatureTextOverlay(
  plan: readonly PlannedSignature[],
  lines: SignatureLines,
  font: string,
  color = '#12224a',
  borderColor?: string | undefined,
): OverlayPage[] {
  const rgb = hexToRgbTriplet(color);
  return overlayPages(plan, borderColor, (placements) => {
    const text: OverlayPlacement[] = [];
    for (const box of placements) {
      const size = round2(clamp(box.hPt * NAME_SIZE_OF_BOX, NAME_SIZE_MIN_PT, NAME_SIZE_MAX_PT));
      text.push({
        text: lines.name,
        font,
        sizePt: size,
        color: rgb,
        // Required by the placement type and never consulted once `centerPt` is set — the same note `watermark`
        // carries. A signature is centred on the box it was drawn in, which is what `centerPt` means.
        anchor: 'bottom-center',
        marginPt: 0,
        centerPt: {
          x: round2(box.xPt + box.wPt / 2),
          y: round2(box.yPt + box.hPt * (lines.meta ? 0.62 : 0.5)),
        },
      });
      if (lines.meta) {
        text.push({
          text: lines.meta,
          font,
          sizePt: META_SIZE_PT,
          color: rgb,
          anchor: 'bottom-center',
          marginPt: 0,
          centerPt: { x: round2(box.xPt + box.wPt / 2), y: round2(box.yPt + box.hPt * 0.2) },
        });
      }
    }
    return { placements: text };
  });
}

/**
 * The meta line for an **image** signature, which has no text inside its box.
 *
 * Below the box, centred, because that is where a signature block puts it — and at the top *inside* the box when
 * there is no room under it (a box against the page's bottom edge), because a date drawn off the page is a date the
 * user asked for and cannot see. There is no line at all when the caller turned both toggles off, which is why this
 * can return an empty plan and the handler then skips the second merge.
 */
export function signatureMetaOverlay(
  plan: readonly PlannedSignature[],
  lines: SignatureLines,
  font: string,
  color = '#12224a',
  borderColor?: string | undefined,
): OverlayPage[] {
  if (!lines.meta) return [];
  const rgb = hexToRgbTriplet(color);
  return overlayPages(plan, borderColor, (placements) => ({
    placements: placements.map((box) => {
      const below = box.yPt - META_SIZE_PT - 3;
      const inside = box.yPt + box.hPt - META_SIZE_PT;
      return {
        text: lines.meta!,
        font,
        sizePt: META_SIZE_PT,
        color: rgb,
        anchor: 'bottom-center' as const,
        marginPt: 0,
        centerPt: {
          x: round2(box.xPt + box.wPt / 2),
          // 8 pt clears the page's bottom edge; anything at or below it is off the page on most printers.
          y: round2(below >= 8 ? below : inside),
        },
      };
    }),
  }));
}

/**
 * The bitmap overlay, one page per page being signed.
 *
 * `fit: 'contain'` rather than the module's default `stretch`: a drawn signature squeezed into a box the user dragged
 * is a *different* signature — thinner or fatter than the one they drew — and no structural assertion can see it,
 * because the box is exactly where it was asked to be. The fitting happens in the engine because the aspect ratio is
 * only knowable where the file is opened.
 */
export function signatureImageOverlay(plan: readonly PlannedSignature[]): ImageStampPage[] {
  const byPage = groupByPage(plan);
  return [...byPage.values()].map((placements) => ({
    widthPt: placements[0]!.pageWidthPt,
    heightPt: placements[0]!.pageHeightPt,
    scalePercent: 100,
    stamps: placements.map((box) => ({
      x: round2(box.xPt + box.wPt / 2),
      y: round2(box.yPt + box.hPt / 2),
      rotationDeg: 0,
      widthPt: box.wPt,
      heightPt: box.hPt,
      fit: 'contain' as const,
    })),
  }));
}

/** Grouped while keeping the document's own page order, so the merge map is a straight index walk. */
function groupByPage(plan: readonly PlannedSignature[]): Map<number, PlannedSignature[]> {
  const grouped = new Map<number, PlannedSignature[]>();
  for (const placement of plan) {
    const existing = grouped.get(placement.page);
    if (existing) existing.push(placement);
    else grouped.set(placement.page, [placement]);
  }
  return new Map([...grouped.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * One overlay page per signed page, sized to the **target page** and never to the union of its boxes.
 *
 * Both builders need the same shape, and the size is the part that must not differ: pikepdf's `add_overlay` scales
 * the overlay page to the rectangle it decorates, so a page of the wrong size stretches everything on it.
 */
function overlayPages(
  plan: readonly PlannedSignature[],
  borderColor: string | undefined,
  build: (placements: readonly PlannedSignature[]) => { placements: OverlayPlacement[] },
): OverlayPage[] {
  const byPage = groupByPage(plan);
  return [...byPage.values()].map((placements) => {
    const { placements: text } = build(placements);
    const vectors = signatureBorders(placements, borderColor);
    return {
      widthPt: placements[0]!.pageWidthPt,
      heightPt: placements[0]!.pageHeightPt,
      placements: text,
      ...(vectors.length > 0 ? { vectors } : {}),
    };
  });
}

/**
 * Write the signature's identity into the document's `/Info`.
 *
 * `Subject` and `Keywords` only. `/Author` is deliberately left alone: a signature says who signed, not who wrote the
 * document, and overwriting an authorship field is the kind of side effect a user finds out about later.
 *
 * pikepdf rather than PyMuPDF, for the reason `docs/14-SIGN-AND-FORMS.md` §8 records for `fill-form`: pikepdf edits
 * the object graph directly, which is what keeps `/Info` exactly as written instead of rewritten by a library's own
 * document model.
 */
export async function writeSignatureMetadata(
  inputPath: string,
  outputPath: string,
  meta: { subject: string; keywords: string },
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ seconds: number }> {
  const result = await runPythonScript(
    `import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
with pikepdf.Pdf.open(payload['input']) as pdf:
    info = pdf.docinfo
    info['/Subject'] = payload['subject']
    info['/Keywords'] = payload['keywords']
    pdf.save(payload['output'])
print(json.dumps({'ok': True}))`,
    { input: inputPath, output: outputPath, subject: meta.subject, keywords: meta.keywords },
    opts,
  );
  const parsed = parseJsonLine<{ ok: boolean }>(result.stdout);
  if (!parsed?.ok) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The signature metadata could not be written.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return { seconds: Math.round(result.durationMs / 100) / 10 };
}

export interface SignatureRecord {
  pages: number;
  subject: string | null;
  keywords: string | null;
  /**
   * Objects whose `/Type` or `/FT` is `/Sig` — the signed-document vocabulary. **Zero** is the honest result for an
   * ink signature, and the handler fails the job if it is not: a `/Sig` without a certificate is a broken signature.
   */
  signatureObjects: number;
  /**
   * How many of those actually **are** a signature: a `/Type /Sig` value dictionary, or a `/FT /Sig` field carrying
   * a `/V`.
   *
   * The distinction from `signatureObjects` is what stops the invalidation warning from firing on a document that has
   * nothing to invalidate: a form with an empty signature placeholder — the box a signer will eventually fill — is
   * the vocabulary without a signature, and telling that user "no reader will verify it" would be a sentence about a
   * signature that does not exist. Measured on both fixtures in `fixtures:redact` and on the form fixture's
   * `/FT /Sig` placeholder, which is counted here as `unsignedSignatureFields` instead.
   */
  signatureValues: number;
  /** `/FT /Sig` fields with no `/V`: a form waiting for a signature rather than one that has been signed. */
  unsignedSignatureFields: number;
  /** Any object carrying `/ByteRange` — the byte range a real signature covers. Zero for an ink signature. */
  byteRange: boolean;
  /** The trailer's `/Perms` — where a certified signature's permissions live. Absent for an ink signature. */
  perms: boolean;
  producer: string | null;
}

/**
 * Read back what the file actually says, with pikepdf — the same engine family that wrote it, used here only for
 * structural facts, never for the claim that ink is on the page (that is `readSignedText` and the golden render).
 */
export async function readSignatureRecord(path: string, opts: Omit<RunOptions, 'engine'>): Promise<SignatureRecord> {
  const result = await runPythonScript(
    `import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
with pikepdf.Pdf.open(payload['input']) as pdf:
    info = pdf.docinfo
    def text(key):
        value = info.get(key)
        return None if value is None else str(value)
    signature_objects = 0
    signature_values = 0
    unsigned_fields = 0
    byte_range = False
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary):
            is_value = False
            is_field = False
            for key, wanted in (('/Type', '/Sig'), ('/FT', '/Sig')):
                value = obj.get(key)
                if value is not None and str(value) == wanted:
                    if key == '/FT':
                        is_field = True
                    else:
                        is_value = True
            if is_value or is_field:
                signature_objects += 1
                # A value dictionary is a signature; a field is one only once it carries a /V. The pair is what
                # separates "signed" from "waiting to be signed", which the warning above depends on.
                if is_value or (is_field and '/V' in obj and obj.get('/V') is not None):
                    signature_values += 1
                else:
                    unsigned_fields += 1
            if '/ByteRange' in obj:
                byte_range = True
    print(json.dumps({
        'pages': len(pdf.pages),
        'subject': text('/Subject'),
        'keywords': text('/Keywords'),
        'signatureObjects': signature_objects,
        'signatureValues': signature_values,
        'unsignedSignatureFields': unsigned_fields,
        'byteRange': byte_range,
        'perms': '/Perms' in pdf.trailer,
        'producer': text('/Producer'),
    }))`,
    { input: path },
    opts,
  );
  const parsed = parseJsonLine<SignatureRecord>(result.stdout);
  if (!parsed) {
    throw new JobFailure('ENCRYPTED_INPUT', {
      engine: 'python',
      message: 'The signed document could not be read back; it may be encrypted.',
    });
  }
  return parsed;
}

/**
 * The sentence a **content-changing** tool owes a user whose document is already signed, or `null` when there is no
 * signature to invalidate.
 *
 * Every tool that rewrites a document invalidates a signature in it, because a signature's `/ByteRange` covers the
 * file's bytes: there is no such thing as editing a signed contract and keeping the signature. The failure this
 * prevents is not a corrupt file but a **silent** one — a user strips the metadata, draws over the page or fills the
 * field beside the signature, is told the job succeeded, and sends it on believing the signature still stands.
 *
 * It lives here rather than in one handler because the check is a property of the *input*, not of any one tool, and
 * the vocabulary it reads (`/Type /Sig`, `/FT /Sig`, `/ByteRange`, `/Perms`) is the same one `readSignatureRecord`
 * was written for. The wording says *this job rewrites the file* rather than naming a specific edit, so the same
 * sentence is true for redaction, an overlay, an annotation, a filled form and a metadata scrub.
 */
export function signatureInvalidatedWarning(record: SignatureRecord): { code: string; detail: string } | null {
  // `signatureValues`, not `signatureObjects`: an empty `/FT /Sig` placeholder is a form waiting to be signed, and a
  // warning about invalidating a signature that does not exist yet is worse than no warning — it teaches the reader
  // to discount the one that matters.
  if (record.signatureValues === 0 && !record.byteRange && !record.perms) return null;
  return {
    code: 'ELECTRONIC_SIGNATURE_INVALIDATED',
    detail: `The document carries ${record.signatureValues} signature(s) (byte range: ${record.byteRange}, perms: ${record.perms}). This job rewrites the file, so the bytes the signature covers change: it is no longer valid and no reader will verify it.`,
  };
}

/**
 * Does the document's *text* contain the name that was set in type?
 *
 * A second engine (poppler, not the Ghostscript that drew the glyphs), and the check that catches the failure this
 * tool is most exposed to: an overlay that merged, reported success, and left a page with no visible name on it. The
 * meta line is checked with it, because a date under the signature is part of what the user asked for.
 */
export async function readSignedText(
  path: string,
  wanted: readonly string[],
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ text: string; missing: string[] }> {
  const result = await runPdfToText(['-layout', path, '-'], opts);
  if (result.code !== 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'pdftotext',
      message: 'The signed document could not be read back as text.',
      stderrTail: result.stderr.slice(-2000),
    });
  }
  const missing = wanted.filter((value) => value.length > 0 && !result.stdout.includes(value));
  return { text: result.stdout, missing };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
