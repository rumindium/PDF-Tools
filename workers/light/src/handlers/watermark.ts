import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WatermarkOptions } from '@pdftools/contracts/tools';
import {
  type OverlayPage,
  type OverlayPlacement,
  availablePostScriptFonts,
  buildImageOverlayPdf,
  countPdfPages,
  hexToRgbTriplet,
  mergeOverlayPdf,
  readPageBoxes,
  readSignatureRecord,
  renderOverlayPdf,
  resolvePostScriptFont,
  signatureInvalidatedWarning,
  watermarkStampPoints,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `watermark` — `docs/11-WATERMARK.md`.
 *
 * Two kinds, one pipeline. Text is drawn through the shared overlay module (Ghostscript for the glyphs, because
 * `stringwidth` is what makes a centred or rotated stamp exact for the chosen font and size). An image cannot come
 * from a typesetter at all, so it is assembled directly as a PDF image object — and the two paths rejoin for the
 * merge, which is the half that has to be identical or one kind would quietly behave unlike the other.
 *
 * Five decisions are deliberate:
 *
 *  1. **One overlay page per stamped page, in one engine call.** The stamp is per page (it can carry `{page}` and
 *     `{total}`), so a single shared overlay cannot express it; but the program emits N pages in one Ghostscript
 *     invocation, so a 500-page document costs one spawn, not 500.
 *  2. **Each overlay page is sized to its target page.** Media boxes are read first, which is what keeps a watermark
 *     on the page in a document that mixes A4 and letter.
 *  3. **Opacity is applied once, at the PDF level.** An ExtGState fill alpha wraps the finished overlay, so text
 *     attenuates and an image's own per-pixel alpha multiplies with the requested opacity — one mechanism, rather
 *     than one path that fakes transparency and another that means it.
 *  4. **Rotation pivots on the stamp's centre**, not its baseline: a 45° stamp rotated about its baseline drifts by
 *     half its own width, which is exactly the "watermark half off the corner" complaint.
 *  5. **Under-content is a different merge call, not a content-stream rewrite** (`add_underlay`), so a background
 *     watermark cannot corrupt the page it sits behind.
 *  6. **The image watermark enforces the caps its document always published.** A file above 8 MB is refused before it
 *     is opened, a bitmap above 8 000 px on either axis is refused after being measured, and one above 4 000 px is
 *     reduced to 4 000 and reported as `IMAGE_LARGE` — the document's own two numbers, which no code had read.
 *  7. **An unresolvable `{token}` prints literally and is named in a warning.** `{user}` is the case that matters:
 *     filling it would need the Auth Platform session this worker does not have, so it is left visible and reported
 *     rather than guessed at, and the same sentence `header-footer` uses is reused so the family has one vocabulary.
 */

/** Above this many per-page overlay pages the job is refused rather than left to run past its budget. */
const PER_PAGE_OVERLAY_MAX = 2000;

/**
 * The image watermark's own caps (`11-WATERMARK.md` §6), both of which the document named from the start and neither
 * of which any code read.
 *
 * `MAX_PX` is a refusal and `DOWNSAMPLE_PX` is a warning, which is the shape the document describes and the reason
 * they are two numbers rather than one: a 12 000 px logo is refused because a watermark is drawn at a share of the
 * page and that resolution is unreachable on paper, while a 5 000 px one is reduced and *said to be reduced*, because
 * losing a factor of 1.25 is not worth a failed job. The byte cap is the same family — a 40 MB PNG would otherwise be
 * decompressed to RGB in the worker's memory before the page ever sees it.
 *
 * The refusal reads the **source** dimensions, which is why the builder reports them separately: a cap applied before
 * the check would turn "too large to accept" into "quietly shrunk to 4 000", and no assertion could tell them apart.
 */
const WATERMARK_IMAGE_MAX_PX = 8000;
const WATERMARK_IMAGE_DOWNSAMPLE_PX = 4000;
const WATERMARK_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** The three substitutions `11-WATERMARK.md` §2 documents for text. `{user}` is not among them: the worker has no
 *  identity in its payload, and inventing one would stamp the wrong name on a legal document. */
const VARIABLES = /\{(page|total|date)\}/g;

/**
 * Every `{name}` in a text template, so the ones that are **not** substituted can be named.
 *
 * The three known variables print their value; everything else prints verbatim — which is the right *behaviour* (a
 * token the reader can see beats a plausible name nobody asked for) and was, until this pass, the wrong *silence*: a
 * typo like `{custmer}` or `{user}` came out looking like a deliberate part of the stamp, and the document's own §3
 * example is written with `{user}`. `header-footer` has warned about exactly this since it was written; this is the
 * same sentence, so a caller meets one vocabulary for the whole family.
 */
const ANY_VARIABLE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN_VARIABLES = new Set(['page', 'total', 'date']);

/** The variables a text template names that this worker cannot fill, in the order they appear. */
function unresolvedVariables(template: string): string[] {
  const names = [...template.matchAll(ANY_VARIABLE)]
    .map((match) => match[1] ?? '')
    .filter((name) => !KNOWN_VARIABLES.has(name));
  return [...new Set(names)];
}

/**
 * What an overlay build reports back, beyond the bytes.
 *
 * The image half carries the upload's own dimensions and size, because the caps above are checked against what the
 * *file* held rather than against what was drawn: a build that resized silently would otherwise be indistinguishable
 * from one that never had to.
 */
interface OverlayBuild {
  bytes: number;
  seconds: number;
  image?: {
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
    downsampled: boolean;
    inputBytes: number;
  };
}

/** Stamps one page's worth of overlay, whichever kind is being built. */
interface PageOverlayPlan {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  /** Where each stamp's centre goes, and how far it is turned. */
  stamps: Array<{ x: number; y: number; rotationDeg: number }>;
}

export const watermark: Handler<WatermarkOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  // The document is whatever is not an attachment: `imageFileId` is resolved by the API into an attachment
  // (`ToolAuxiliaryFile`), so position in the list is not what identifies the PDF.
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to watermark.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to watermark.' });
  }

  // Before the overlay is merged. A watermark is drawn into the page content, which is inside the bytes a signature's
  // `/ByteRange` covers — the mark is the *visible* change, and the invisible one is that the signature stops verifying.
  const signature = await readSignatureRecord(document.path, runOpts);

  const stamped = resolveStampedPages(options.pages, pages, options.skipFirstPage);
  if (stamped.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'No page in this document matches that selection.' });
  }
  if (stamped.length > PER_PAGE_OVERLAY_MAX) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `Watermarking ${stamped.length} pages in one job is above the limit of ${PER_PAGE_OVERLAY_MAX}. Split the document first.`,
    });
  }

  report({ progress: 20, phase: 'processing', message: 'Measuring pages.' });
  const boxes = await readPageBoxes(document.path, runOpts);
  const plan: PageOverlayPlan[] = stamped.map((pageNumber) => {
    const box = boxes[pageNumber - 1] ?? boxes[0]!;
    return {
      pageNumber,
      widthPt: box.widthPt,
      heightPt: box.heightPt,
      stamps: watermarkStampPoints(options.position, options.tile, box.widthPt, box.heightPt).map((point) => ({
        ...point,
        rotationDeg: options.rotation,
      })),
    };
  });

  const overlayPath = join(workDir, 'watermark-overlay.pdf');
  const overlay =
    options.kind === 'image'
      ? await buildImageOverlay(overlayPath, plan, options, files, runOpts)
      : await buildTextOverlay(overlayPath, plan, pages, options, runOpts);

  report({ progress: 80, phase: 'processing', message: 'Stamping the pages.' });
  const outputPath = join(outputDir, 'watermarked.pdf');
  const merged = await mergeOverlayPdf(
    document.path,
    overlayPath,
    outputPath,
    stamped.map((page, index) => ({ page, overlayPage: index + 1 })),
    { ...runOpts, underContent: options.underContent, alpha: options.opacity },
  );

  // The invariant worth re-reading from the file rather than trusting: decorating must never add or drop a page.
  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Watermarking changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (options.opacity < 0.05) {
    warnings.push({
      code: 'OPACITY_VERY_LOW',
      detail: `An opacity of ${options.opacity} is invisible in most print workflows.`,
    });
  }
  const unresolved = options.kind === 'text' ? unresolvedVariables(options.text ?? '') : [];
  if (unresolved.length > 0) {
    warnings.push({
      code: 'UNKNOWN_VARIABLE',
      detail: `Printed literally, because this build cannot resolve: ${unresolved.map((name) => `{${name}}`).join(', ')}.`,
    });
  }
  if (overlay.image?.downsampled) {
    warnings.push({
      code: 'IMAGE_LARGE',
      detail: `The watermark image arrived at ${overlay.image.sourceWidth}×${overlay.image.sourceHeight} px and was reduced to ${overlay.image.width}×${overlay.image.height}; above ${WATERMARK_IMAGE_DOWNSAMPLE_PX} px is unreachable at the size a watermark is drawn.`,
    });
  }

  report({ progress: 95, phase: 'finalizing' });
  return {
    // `pages` on an output descriptor is the per-output page list for tools that split a document; a single-PDF
    // tool reports its count in metrics instead (the same convention `page-numbers` follows).
    outputs: [{ name: 'watermarked.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      pagesStamped: stamped.length,
      pagesSkipped: outputPages - stamped.length,
      overlayPages: plan.length,
      stampsPerPage: plan[0]?.stamps.length ?? 0,
      overlayBytes: overlay.bytes,
      overlaySeconds: overlay.seconds,
      mergeSeconds: merged.seconds,
      kind: options.kind,
      position: options.position,
      rotation: options.rotation,
      opacity: options.opacity,
      skipFirstPage: options.skipFirstPage,
      firstStampedPage: stamped[0]!,
      underContent: options.underContent,
      ...(options.kind === 'text'
        ? {
            font: options.font,
            fontSize: options.fontSize,
            textLength: (options.text ?? '').length,
            // What the warning above is about, so "no UNKNOWN_VARIABLE" is a fact about the template rather than about
            // the scan not having run.
            unresolvedVariables: unresolved,
          }
        : {
            scalePercent: options.scalePercent,
            imageWidth: overlay.image?.width ?? 0,
            imageHeight: overlay.image?.height ?? 0,
            // The file's own dimensions and size, so "it was not resized" and "it was, and by this much" are both
            // facts about the upload rather than about the absence of a message.
            imageSourceWidth: overlay.image?.sourceWidth ?? 0,
            imageSourceHeight: overlay.image?.sourceHeight ?? 0,
            imageDownsampled: overlay.image?.downsampled ?? false,
            imageInputBytes: overlay.image?.inputBytes ?? 0,
          }),
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: options.kind === 'image' ? 'pikepdf' : 'ghostscript+pikepdf' },
  };
};

/** Text overlay: the shared Ghostscript path, one page per stamped page so `{page}` can differ per page. */
async function buildTextOverlay(
  overlayPath: string,
  plan: PageOverlayPlan[],
  documentPages: number,
  options: WatermarkOptions,
  runOpts: Parameters<typeof mergeOverlayPdf>[4],
): Promise<OverlayBuild> {
  const font = resolvePostScriptFont(options.font);
  if (!font) {
    throw new JobFailure('FONT_NOT_FOUND', {
      message: `"${options.font}" is not a font this build can stamp with. Available: ${availablePostScriptFonts().join(', ')}.`,
    });
  }
  const color = hexToRgbTriplet(options.color);
  const template = options.text ?? '';
  const date = new Date().toISOString().slice(0, 10);

  const overlayPages: OverlayPage[] = plan.map(({ pageNumber, widthPt, heightPt, stamps }) => {
    const text = template.replace(VARIABLES, (_match, variable: string) => {
      if (variable === 'page') return String(pageNumber);
      if (variable === 'total') return String(documentPages);
      return date;
    });
    const placements: OverlayPlacement[] = stamps.map((stamp) => ({
      text,
      font,
      sizePt: options.fontSize,
      color,
      // `anchor` and `marginPt` are required by the placement type but unused once `centerPt` is set; the anchor
      // passed here is never consulted, and a centre is what every watermark placement actually means.
      anchor: 'bottom-center',
      marginPt: 0,
      centerPt: { x: stamp.x, y: stamp.y },
      rotationDeg: stamp.rotationDeg,
    }));
    return { widthPt, heightPt, placements };
  });

  return renderOverlayPdf(overlayPages, overlayPath, {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 120_000),
  });
}

/** Image overlay: pikepdf assembles the pages, because placing a bitmap is matrix work, not typesetting. */
async function buildImageOverlay(
  overlayPath: string,
  plan: PageOverlayPlan[],
  options: WatermarkOptions,
  files: ReadonlyArray<{ kind?: string; attachmentOption?: string; path: string }>,
  runOpts: Parameters<typeof mergeOverlayPdf>[4],
): Promise<OverlayBuild> {
  const attachment = files.find((file) => file.kind === 'attachment' && file.attachmentOption === 'imageFileId');
  if (!attachment) {
    throw new JobFailure('IMAGE_REQUIRED', {
      message: 'The watermark image named by `imageFileId` was not part of this job.',
    });
  }

  // The byte cap first, before the pixels are opened: decompressing a 40 MB PNG is the cost this refusal exists to
  // avoid, and it is knowable from the file system alone.
  const inputBytes = (await stat(attachment.path).catch(() => null))?.size ?? 0;
  if (inputBytes > WATERMARK_IMAGE_MAX_BYTES) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `The watermark image is ${(inputBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${WATERMARK_IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
    });
  }

  const built = await buildImageOverlayPdf(
    attachment.path,
    plan.map(({ widthPt, heightPt, stamps }) => ({
      widthPt,
      heightPt,
      scalePercent: options.scalePercent,
      stamps,
    })),
    overlayPath,
    { ...runOpts, timeoutMs: Math.min(runOpts.timeoutMs, 120_000) },
    { downsampleAbovePx: WATERMARK_IMAGE_DOWNSAMPLE_PX },
  );

  // Against the source, not the placed size: the builder has already shrunk anything above the downsample cap, so a
  // check on `imageWidth` would pass for a 12 000 px file that the cap exists to refuse.
  if (built.sourceWidth > WATERMARK_IMAGE_MAX_PX || built.sourceHeight > WATERMARK_IMAGE_MAX_PX) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `The watermark image is ${built.sourceWidth}×${built.sourceHeight} px; the limit is ${WATERMARK_IMAGE_MAX_PX} px on either axis.`,
    });
  }

  return {
    bytes: built.bytes,
    seconds: built.seconds,
    image: {
      width: built.imageWidth,
      height: built.imageHeight,
      sourceWidth: built.sourceWidth,
      sourceHeight: built.sourceHeight,
      downsampled: built.downsampled,
      inputBytes,
    },
  };
}

/**
 * The pages to stamp, in ascending order, with a range that leaves the document refused rather than ignored.
 *
 * `skipFirstPage` and `pages` are the same rule asked two ways — a page outside the selection carries nothing — so it
 * is applied here, to the list, rather than inside the drawing program: a condition in there would still build an
 * overlay page for page one and still count it in `pagesStamped`.
 */
function resolveStampedPages(selection: string[] | undefined, pageCount: number, skipFirstPage: boolean): number[] {
  const requested =
    !selection || selection.length === 0
      ? Array.from({ length: pageCount }, (_, index) => index + 1)
      : expandRanges(selection, pageCount).filter((page) => page <= pageCount);
  const unique = [...new Set(requested)].sort((a, b) => a - b);
  return skipFirstPage ? unique.filter((page) => page !== 1) : unique;
}
