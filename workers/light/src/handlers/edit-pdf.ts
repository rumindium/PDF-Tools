import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FREEHAND_POINTS_MAX } from '@pdftools/contracts/tools';
import type { EditElement, EditPdfOptions } from '@pdftools/contracts/tools';
import {
  type ImageStampPage,
  type MarkBox,
  type OverlayPage,
  type OverlayPlacement,
  type OverlayVector,
  availablePostScriptFonts,
  buildImageOverlayPdf,
  countPdfPages,
  hexToRgbTriplet,
  marksOutsidePage,
  mergeOverlayPdf,
  readPageBoxes,
  readSignatureRecord,
  renderOverlayPdf,
  resolvePostScriptFont,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `edit-pdf` — `docs/13-EDIT-AND-ANNOTATE.md` §2, the first of the phase-5 editing tools.
 *
 * Five element types, two drawing mechanisms, one output. Text, shapes, freehand marks and checkboxes are **glyphs and
 * paths**, so they go through the shared overlay pipeline (`renderOverlayPdf`); an image is a bitmap that has to be
 * placed with a matrix, so it is assembled by pikepdf (`buildImageOverlayPdf`). The two rejoin at the merge, which is
 * why a job containing both is two passes rather than one — and why a job containing neither cannot happen: the
 * contract requires at least one element.
 *
 * Four decisions are deliberate, and each is a place where the obvious implementation is wrong:
 *
 *  1. **Coordinates are PDF user space — points from the page's bottom-left.** The document this tool comes from draws
 *     its examples with a top-left origin and a `units` field, but the shipped contract has neither, and every other
 *     measurement in this codebase (an overlay's `yPt`, a rule's `yPt`, `placementGeometry`) is bottom-left points.
 *     Inventing a hidden flip would make this tool's `y` mean the opposite of `crop`'s with nothing in the payload to
 *     say so; a browser canvas subtracts from the page height at its own boundary instead. The convention travels back
 *     in `metrics.coordinateSystem`, because it is the one thing a caller cannot discover from a successful result.
 *  2. **An element naming a page the document does not have is refused, not ignored.** Silently skipping it is how a
 *     user finds out weeks later that their fifth mark never happened.
 *  3. **Text is placed by its baseline.** A text box the user dragged has a start point, and centring it would require
 *     measuring the string in the caller to work out where its centre is.
 *  4. **The marks are burned into the page content, and `flatten: false` says so.** Drawing into the page is what an
 *     overlay *is*, so the tool honours the default and cannot honour the opposite. A warning states the difference and
 *     names `annotate` as the tool for marks a reader can select and delete — returning the same file for both settings
 *     without a word is the failure that warning exists to prevent.
 */

/** `13-EDIT-AND-ANNOTATE.md` §2: 40 elements per page (the contract caps a whole job at 200). */
const MAX_ELEMENTS_PER_PAGE = 40;

/**
 * `13-EDIT-AND-ANNOTATE.md` §6: an image element's file is at most 4 MB.
 *
 * §6 has promised this since the document was written and nothing enforced it — measured in pass 9, where an element
 * image is only bounded by the *upload* ceiling a plan allows. The check is here rather than in the contract because the
 * size of a file the API resolved is not something a schema can see, and it happens before the bitmap is embedded.
 */
const MAX_ELEMENT_IMAGE_BYTES = 4 * 1024 * 1024;

/** Everything except an image, which is the split between the typesetter and pikepdf. */
type TypesetElement = Exclude<EditElement, { type: 'image' }>;
type ImageElement = Extract<EditElement, { type: 'image' }>;

export const editPdf: Handler<EditPdfOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  // The document is whatever is not an attachment: an image element's file arrives as an attachment, so position in
  // the list is not what identifies the PDF — the same rule `watermark` follows, for the same reason.
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to edit.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to edit.' });
  }

  // Before a single mark is drawn. Drawing into the page changes the bytes a signature's `/ByteRange` covers, so the
  // sentence belongs to a user who still has the original and can decide not to run this at all.
  const signature = await readSignatureRecord(document.path, runOpts);

  // §6's freehand cap, checked here as well as in the contract: the worker is the second entry point, and a stroke
  // above the limit is a PostScript path of unbounded length rather than a bigger file.
  for (const element of options.elements) {
    if (element.type === 'draw' && element.points.length > FREEHAND_POINTS_MAX) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `A freehand element on page ${element.page} has ${element.points.length} points; the limit is ${FREEHAND_POINTS_MAX} per element.`,
      });
    }
  }

  const byPage = groupByPage(options.elements, pages);
  const boxes = await readPageBoxes(document.path, runOpts);
  // What the caller marked beyond the paper. Counted before anything is drawn, and reported rather than refused: the
  // mark is real and merely larger than the page, which is the same sentence `redact` owes for its rectangles
  // (`docs/13-EDIT-AND-ANNOTATE.md` §3, where §6's limits and this warning are two halves of one promise).
  const offPage = marksOutsidePage(boxes, options.elements.map(elementBox));
  const plans = [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, elements]) => ({
      page,
      typeset: elements.filter(isTypeset),
      images: elements.filter(isImage),
    }));

  const changes: Array<Record<string, unknown>> = [];
  let currentPath = document.path;
  let overlayBytes = 0;

  // ── Pass 1: text, shapes, freehand marks, checkboxes ───────────────────────
  const typesetPlans = plans.filter((plan) => plan.typeset.length > 0);
  if (typesetPlans.length > 0) {
    report({ progress: 30, phase: 'processing', message: 'Drawing the marks.' });

    const overlayPages: OverlayPage[] = typesetPlans.map((plan) => {
      const box = boxes[plan.page - 1] ?? boxes[0]!;
      return {
        widthPt: box.widthPt,
        heightPt: box.heightPt,
        placements: plan.typeset.filter(isText).map(textPlacement),
        // Vectors are drawn *before* the placements, so a whiteout rectangle or a highlight cannot land on top of the
        // text that was placed with it.
        vectors: plan.typeset.filter(isVector).map(vectorOf),
      };
    });

    const overlayPath = join(workDir, 'edit-overlay.pdf');
    const rendered = await renderOverlayPdf(overlayPages, overlayPath, {
      ...runOpts,
      timeoutMs: Math.min(runOpts.timeoutMs, 180_000),
    });
    overlayBytes = rendered.bytes;

    const markedPath = join(workDir, 'marked.pdf');
    await mergeOverlayPdf(
      document.path,
      overlayPath,
      markedPath,
      typesetPlans.map((plan, index) => ({ page: plan.page, overlayPage: index + 1 })),
      runOpts,
    );
    currentPath = markedPath;
    changes.push({
      kind: 'ELEMENTS_DRAWN',
      detail: `${typesetPlans.reduce((total, plan) => total + plan.typeset.length, 0)} element(s) drawn on ${typesetPlans.length} page(s)`,
    });
  }

  // ── Pass 2: images, which only pikepdf can place ───────────────────────────
  const images = plans.flatMap((plan) => plan.images);
  let imagesPlaced = 0;
  if (images.length > 0) {
    report({ progress: 65, phase: 'processing', message: 'Placing the images.' });
    const placed = await placeImages(images, files, boxes, runOpts, workDir, currentPath);
    currentPath = placed.path;
    overlayBytes += placed.bytes;
    imagesPlaced = placed.placed;
    changes.push({ kind: 'IMAGES_PLACED', detail: `${imagesPlaced} image(s) placed` });
  }

  report({ progress: 90, phase: 'finalizing' });

  // ── The invariant: editing must never add or drop a page ───────────────────
  const outputPath = join(outputDir, 'edited.pdf');
  if (currentPath !== outputPath) {
    await Bun.write(outputPath, Bun.file(currentPath));
  }
  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Editing changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (!options.flatten) {
    warnings.push({
      code: 'LAYER_NOT_SEPARATE',
      detail:
        'The marks are drawn into the page content, because that is what an overlay is — a reader cannot select or move them. Use `annotate` for editable marks, or leave `flatten` at its default to say this explicitly.',
    });
  }
  if (offPage.length > 0) {
    warnings.push({
      code: 'ELEMENT_OFF_PAGE',
      detail: `${offPage.length} element(s) extend past the edge of their page and are not visible there: ${[
        ...new Set(offPage.map((index) => options.elements[index]!.page)),
      ]
        .sort((a, b) => a - b)
        .map((page) => `page ${page}`)
        .join(', ')}.`,
    });
  }

  return {
    outputs: [{ name: 'edited.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      pagesEdited: plans.length,
      elements: options.elements.length,
      elementsDrawn: options.elements.length - imagesPlaced,
      imagesPlaced,
      offPage: offPage.length,
      offPagePages: [...new Set(offPage.map((index) => options.elements[index]!.page))].sort((a, b) => a - b),
      overlayBytes,
      coordinateSystem: 'pdf-user-space-bottom-left-points',
      flattenRequested: options.flatten,
      // Read before the first mark was drawn; `signatureValues` is what the warning above is gated on, so a caller
      // who sees the warning can see the number behind it.
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
      changes,
    },
    warnings,
    engine: { name: imagesPlaced > 0 ? 'ghostscript+pikepdf' : 'ghostscript' },
  };
};

/**
 * Place every image element, one overlay pass per distinct image file.
 *
 * Grouped by file rather than run once per element because the pixels are embedded once per overlay in
 * `buildImageOverlayPdf` — a job that puts the same logo on forty pages should carry one copy of it, not forty.
 */
async function placeImages(
  images: ImageElement[],
  files: ReadonlyArray<{ id: string; kind?: string; path: string }>,
  boxes: Array<{ widthPt: number; heightPt: number }>,
  runOpts: Parameters<typeof readPageBoxes>[1],
  workDir: string,
  inputPath: string,
): Promise<{ path: string; placed: number; bytes: number }> {
  const entries = await Promise.all(
    images.map(async (element) => {
      const attachment = files.find((file) => file.kind === 'attachment' && file.id === element.fileId);
      if (!attachment) {
        // The remedy is always the same — upload the image, use the id that comes back — which is the code
        // `11-WATERMARK.md` §3 defined for it.
        throw new JobFailure('IMAGE_REQUIRED', {
          message: `The image named by an element on page ${element.page} was not part of this job. Upload it and use the id that comes back.`,
        });
      }
      // §6's 4 MB ceiling, before the bitmap is embedded: a refusal here writes no output at all.
      const bytes = (await stat(attachment.path).catch(() => null))?.size ?? 0;
      if (bytes > MAX_ELEMENT_IMAGE_BYTES) {
        throw new JobFailure('VALIDATION_ERROR', {
          message: `The image named by an element on page ${element.page} is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ELEMENT_IMAGE_BYTES / 1024 / 1024} MB per element.`,
        });
      }
      return { element, path: attachment.path };
    }),
  );

  const byFile = new Map<string, typeof entries>();
  for (const entry of entries) {
    byFile.set(entry.path, [...(byFile.get(entry.path) ?? []), entry]);
  }

  let total = 0;
  let index = 0;
  let stage = inputPath;
  let bytes = 0;
  for (const [imagePath, group] of byFile) {
    index += 1;
    const sorted = group.slice().sort((a, b) => a.element.page - b.element.page);
    const imagePages: ImageStampPage[] = sorted.map(({ element }) => {
      const box = boxes[element.page - 1] ?? boxes[0]!;
      return {
        widthPt: box.widthPt,
        heightPt: box.heightPt,
        // The element gives the image's box in points and the builder centres a stamp, so the centre is derived here
        // rather than becoming a second convention for `x`/`y` in the payload.
        stamps: [
          {
            x: element.x + element.width / 2,
            y: element.y + element.height / 2,
            rotationDeg: 0,
            widthPt: element.width,
            heightPt: element.height,
          },
        ],
      };
    });

    const overlayPath = join(workDir, `edit-image-${index}.pdf`);
    const built = await buildImageOverlayPdf(imagePath, imagePages, overlayPath, {
      ...runOpts,
      timeoutMs: Math.min(runOpts.timeoutMs, 180_000),
    });

    const target = join(workDir, `imaged-${index}.pdf`);
    await mergeOverlayPdf(
      stage,
      overlayPath,
      target,
      sorted.map(({ element }, overlayPage) => ({ page: element.page, overlayPage: overlayPage + 1 })),
      runOpts,
    );
    stage = target;
    bytes += built.bytes;
    total += sorted.length;
  }
  return { path: stage, placed: total, bytes };
}

/** Elements per page, refusing a page that does not exist and a page over the documented maximum. */
function groupByPage(elements: EditElement[], pages: number): Map<number, EditElement[]> {
  const byPage = new Map<number, EditElement[]>();
  for (const element of elements) {
    if (element.page > pages) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `An element targets page ${element.page}, but the document has ${pages}.`,
      });
    }
    byPage.set(element.page, [...(byPage.get(element.page) ?? []), element]);
  }
  for (const [page, list] of byPage) {
    if (list.length > MAX_ELEMENTS_PER_PAGE) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `Page ${page} carries ${list.length} elements; the limit is ${MAX_ELEMENTS_PER_PAGE} per page.`,
      });
    }
  }
  return byPage;
}

/**
 * An element's own rectangle, in PDF user space.
 *
 * Text is the one kind whose extent is unknowable here — it is typeset by Ghostscript, and measuring the string would
 * mean measuring it twice — so its box is the baseline start plus its font size. The consequence is deliberate and
 * stated in `13-EDIT-AND-ANNOTATE.md` §8: a text whose *anchor* is on the page is not reported as off-page even when a
 * long string runs past the right edge, because that is a claim this handler cannot make. The other four kinds are
 * exact, and they are the ones the warning is for.
 */
function elementBox(element: EditElement): MarkBox {
  if (element.type === 'text') {
    return { page: element.page, xPt: element.x, yPt: element.y, widthPt: 0, heightPt: element.size };
  }
  if (element.type === 'checkbox') {
    return { page: element.page, xPt: element.x, yPt: element.y, widthPt: element.size, heightPt: element.size };
  }
  if (element.type === 'draw') {
    const xs = element.points.map((point) => point.x);
    const ys = element.points.map((point) => point.y);
    const half = element.strokeWidth / 2;
    return {
      page: element.page,
      xPt: Math.min(...xs) - half,
      yPt: Math.min(...ys) - half,
      widthPt: Math.max(...xs) - Math.min(...xs) + element.strokeWidth,
      heightPt: Math.max(...ys) - Math.min(...ys) + element.strokeWidth,
    };
  }
  return { page: element.page, xPt: element.x, yPt: element.y, widthPt: element.width, heightPt: element.height };
}

function isTypeset(element: EditElement): element is TypesetElement {
  return element.type !== 'image';
}

function isImage(element: EditElement): element is ImageElement {
  return element.type === 'image';
}

function isText(element: EditElement): element is Extract<EditElement, { type: 'text' }> {
  return element.type === 'text';
}

function isVector(element: EditElement): element is Exclude<TypesetElement, { type: 'text' }> {
  return element.type !== 'text' && element.type !== 'image';
}

/** A text element as a placed stamp: its `x`/`y` is the baseline start, not a centre. */
function textPlacement(element: Extract<EditElement, { type: 'text' }>): OverlayPlacement {
  const font = resolvePostScriptFont(element.font);
  if (!font) {
    throw new JobFailure('FONT_NOT_FOUND', {
      message: `"${element.font}" is not a font this build can draw with. Available: ${availablePostScriptFonts().join(', ')}.`,
    });
  }
  return {
    text: element.text,
    font,
    sizePt: element.size,
    color: hexToRgbTriplet(element.color),
    // Unused once `baselinePt` is set, but a placement is either anchored or placed and this one is placed.
    anchor: 'bottom-left',
    marginPt: 0,
    baselinePt: { x: element.x, y: element.y },
    rotationDeg: element.rotation,
  };
}

/** A shape, freehand mark or checkbox as one vector. */
function vectorOf(element: Exclude<TypesetElement, { type: 'text' }>): OverlayVector {
  if (element.type === 'shape') {
    return {
      kind: element.shape,
      xPt: element.x,
      yPt: element.y,
      widthPt: element.width,
      heightPt: element.height,
      stroke: element.stroke ? hexToRgbTriplet(element.stroke) : null,
      fill: element.fill ? hexToRgbTriplet(element.fill) : null,
      strokeWidthPt: element.strokeWidth,
    };
  }
  if (element.type === 'draw') {
    const first = element.points[0]!;
    return {
      kind: 'polyline',
      xPt: first.x,
      yPt: first.y,
      widthPt: 0,
      heightPt: 0,
      stroke: hexToRgbTriplet(element.color),
      fill: null,
      strokeWidthPt: element.strokeWidth,
      points: element.points,
    };
  }
  return {
    kind: 'checkbox',
    xPt: element.x,
    yPt: element.y,
    widthPt: element.size,
    heightPt: element.size,
    stroke: hexToRgbTriplet(element.color),
    fill: null,
    strokeWidthPt: 1,
    checked: element.checked,
  };
}
