import { join } from 'node:path';
import { CROP_MIN_KEPT_RATIO, type CropOptions } from '@pdftools/contracts/tools';
import {
  countPdfPages,
  pythonOrThrow,
  readSignatureRecord,
  runGhostscript,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `crop` — `docs/03-ORGANIZE-ROTATE-CROP.md`.
 *
 * **The crop is non-destructive, and that is the whole design.** Only the `/CropBox` is written: the `/MediaBox` and
 * every content stream stay exactly as they were, so a page cropped too aggressively can be recovered by cropping it
 * again, and a PDF consumer that ignores the crop box still shows a complete page. Destroying the off-crop content
 * belongs to redaction (`docs/13-EDIT-AND-ANNOTATE.md`), which is a different tool with a different promise. The
 * golden cases assert *both* boxes for that reason: a check on the MediaBox alone would pass for a crop that did
 * nothing, and a check on the CropBox alone would pass for one that also re-wrote the page.
 *
 * Two modes:
 *
 *   * **manual** — insets from each edge, in millimetres, points, or percent of the page. Percent is per axis, which
 *     is what "trim 10% of the width and 10% of the height" means; applying one percentage to both would silently
 *     miss on a landscape page.
 *   * **auto** — the content box, measured by Ghostscript's `bbox` device. The recipe in the doc names `mutool`,
 *     which has no bounding-box output; `gs -sDEVICE=bbox` prints a `%%HiResBoundingBox` per page and is already in
 *     this image. Its limitations are handled rather than trusted: a blank page yields a degenerate box, and a
 *     detection that would throw away almost the whole page is refused per page with a warning instead of producing
 *     a document that looks empty.
 */

const MM_TO_PT = 72 / 25.4;

/**
 * A page is left alone when the kept rectangle covers less than this share of it.
 *
 * Not a quality threshold — a plausibility one, and the reason is *auto*-crop: a noise speck in the corner of a scan
 * produces a technically correct bounding box the size of a full stop, and cropping to it would hand back a document
 * that appears blank. The doc's `AUTO_CROP_MARGIN_GUARD` is this warning.
 *
 * Imported from the contracts rather than declared here, because the **manual** path enforces it too — both modes share
 * one writing script — and the crop board clamps a drag to it, so the number the user's box is measured against and the
 * number this pass refuses are the same number by construction, not by convention.
 */
const MIN_CONTENT_AREA_RATIO = CROP_MIN_KEPT_RATIO;

export const crop: Handler<CropOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to crop.' });
  }
  if (!options.auto && !options.box) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: 'Crop needs either `auto: true` or a `box` with at least one edge.',
    });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);

  // Read before the crop box is written. "Crop only changes the crop box" is true of the page and not of the file: the
  // write is a new revision, and a signature's `/ByteRange` covers the bytes of the revision it was computed over.
  const signature = await readSignatureRecord(document.path, runOpts);

  const selected = options.pages
    ? [...new Set(expandRanges(options.pages, pages).filter((page) => page >= 1 && page <= pages))].sort(
        (a, b) => a - b,
      )
    : Array.from({ length: pages }, (_, index) => index + 1);
  if (selected.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'No page in this document matches that selection.' });
  }

  report({ progress: 20, phase: 'processing', message: options.auto ? 'Detecting the content box.' : 'Cropping.' });

  // The detected boxes and the page geometry both come from the engine, in one Python pass that also does the
  // writing: reading the page sizes separately would mean a second spawn and a second chance to disagree with the
  // pass that wrote the file.
  const sizes = await measurePages(document.path, runOpts);
  if (sizes.length !== pages) {
    // A disagreement between the two readers is not something to paper over: the boxes are per page and an off-by-one
    // would crop the wrong page while every count still looked right.
    throw new JobFailure('CONVERSION_FAILED', {
      message: `The page count disagrees between readers: ${pages} pages, ${sizes.length} measured.`,
    });
  }

  const boxes: Array<[number, number, number, number] | null> = options.auto
    ? // Auto boxes are absolute and come from the engine; a page the detector did not report is left alone rather
      // than guessed at, because every alternative is a silent wrong crop.
      (await detectContentBoxes(document.path, runOpts)).map((box) => box)
    : sizes.map((size, index) => boxFromInsets(options, size, index));

  const result = await pythonOrThrow(
    CROP_SCRIPT,
    {
      input: document.path,
      output: join(outputDir, 'cropped.pdf'),
      pages: selected,
      // Absolute rectangles, one per page, in document order — the insets were converted in TypeScript so the script
      // has no unit arithmetic to get wrong.
      boxes,
    },
    runOpts,
  );

  let written: { cropped?: number[]; skipped?: number[] } = {};
  try {
    const line = result.stdout.trim().split('\n').at(-1) ?? '{}';
    written = JSON.parse(line) as { cropped?: number[]; skipped?: number[] };
  } catch {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The crop pass did not report which pages it wrote.',
      stderrTail: result.stdout.slice(-400),
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  // Hedged on the way out rather than raised as an error: cropping is non-destructive to the *content* (only the
  // `/CropBox` is written), and this sentence exists so nobody assumes that makes it non-destructive to a signature.
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if ((written.skipped?.length ?? 0) > 0) {
    warnings.push({
      code: 'AUTO_CROP_MARGIN_GUARD',
      detail: `Left untouched because the detected content would have removed almost the whole page: page(s) ${written.skipped!.join(', ')}. Use a manual box for those pages.`,
    });
  }
  if (selected.length < pages) {
    warnings.push({
      code: 'PARTIAL_CROP',
      detail: `Pages outside the selection keep their original crop box: ${pages - selected.length} of ${pages}.`,
    });
  }

  report({ progress: 92, phase: 'finalizing' });
  return {
    outputs: [{ name: 'cropped.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages,
      pagesCropped: written.cropped?.length ?? 0,
      pagesSkipped: written.skipped?.length ?? 0,
      mode: options.auto ? 'auto' : 'manual',
      units: options.auto ? 'pt' : options.units,
      // The MediaBox is deliberately not in these metrics: it did not change, and listing it would imply otherwise.
      cropBoxes: boxes.slice(0, 3),
      pageSizes: sizes.slice(0, 3),
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: options.auto ? 'ghostscript' : 'pikepdf' },
  };
};

/** Page sizes, in points, in document order. */
async function measurePages(
  path: string,
  runOpts: Parameters<typeof pythonOrThrow>[2],
): Promise<Array<[number, number]>> {
  const result = await pythonOrThrow(MEASURE_SCRIPT, { input: path }, runOpts);
  const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { sizes?: Array<[number, number]> };
  if (!parsed.sizes || parsed.sizes.length === 0) {
    throw new JobFailure('CONVERSION_FAILED', { message: 'The document reported no page sizes.' });
  }
  return parsed.sizes;
}

/** The manual box, as an absolute rectangle per page. */
function boxFromInsets(options: CropOptions, size: [number, number], index: number): [number, number, number, number] {
  const [width, height] = size;
  const box = options.box!;
  const scale = options.units === 'percent' ? null : options.units === 'mm' ? MM_TO_PT : 1;
  const axis = (value: number, extent: number) => (scale == null ? (value / 100) * extent : value * scale);

  const top = axis(box.top ?? 0, height);
  const bottom = axis(box.bottom ?? 0, height);
  const left = axis(box.left ?? 0, width);
  const right = axis(box.right ?? 0, width);

  const result: [number, number, number, number] = [left, bottom, width - right, height - top];
  if (result[2] - result[0] <= 0 || result[3] - result[1] <= 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `The box on page ${index + 1} leaves no area to keep: the insets add up to more than the page (${width.toFixed(1)} × ${height.toFixed(1)} pt).`,
    });
  }
  return result;
}

/**
 * Content boxes per page, from Ghostscript.
 *
 * One spawn for the whole document — the device walks every page and prints one pair of lines each. `-dQUIET` is
 * deliberately *not* used: the bounding-box lines are the output, and the device writes them to stderr, which is
 * also where its Fontconfig noise goes, so the parse is a strict match on the marker rather than on line position.
 */
async function detectContentBoxes(
  path: string,
  runOpts: Parameters<typeof pythonOrThrow>[2],
): Promise<Array<[number, number, number, number]>> {
  const result = await runGhostscript(['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=bbox', path], {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 120_000),
  });
  const boxes = [
    ...(result.stderr + result.stdout).matchAll(/%%HiResBoundingBox:\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/g),
  ].map(
    (match) =>
      [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as [number, number, number, number],
  );
  if (boxes.length === 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'Auto-crop could not measure any page content.',
      stderrTail: result.stderr.slice(-400),
    });
  }
  return boxes;
}

/** Page sizes, for the manual mode. */
const MEASURE_SCRIPT = `
import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
pdf = pikepdf.open(payload['input'])
sizes = []
for page in pdf.pages:
    box = [float(value) for value in page.MediaBox]
    sizes.append([box[2] - box[0], box[3] - box[1]])
print(json.dumps({'sizes': sizes}))
`;

/**
 * The writing pass.
 *
 * A rectangle is turned into an absolute `/CropBox` and nothing else changes: the MediaBox, the content streams and
 * the resource dictionaries are untouched, which is what makes the crop reversible. The plausibility guard lives
 * here rather than in the detection step because it needs the page size — a detected box is only suspicious
 * *relative to* the page it sits on.
 */
const CROP_SCRIPT = `
import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
pdf = pikepdf.open(payload['input'])
boxes = payload['boxes']
cropped, skipped = [], []

for page_number in payload['pages']:
    page = pdf.pages[page_number - 1]
    rectangle = boxes[page_number - 1]
    if rectangle is None:
        continue
    media = [float(value) for value in page.MediaBox]
    page_width = media[2] - media[0]
    page_height = media[3] - media[1]
    left, bottom, right, top = [float(value) for value in rectangle]
    width = right - left
    height = top - bottom
    if width <= 1 or height <= 1:
        skipped.append(page_number)
        continue
    if (width * height) / (page_width * page_height) < ${MIN_CONTENT_AREA_RATIO}:
        skipped.append(page_number)
        continue
    page.CropBox = pikepdf.Array([left, bottom, right, top])
    cropped.append(page_number)

pdf.save(payload['output'], object_stream_mode=pikepdf.ObjectStreamMode.preserve)
print(json.dumps({'cropped': cropped, 'skipped': skipped}))
`;
