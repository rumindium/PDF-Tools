import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PdfToImagesOptions } from '@pdftools/contracts/tools';
import { magickOrThrow, readPageRotations, runMagick, runMutool, runQpdf } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler, OutputDescriptor } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `pdf-to-images` — `docs/06-PDF-TO-IMAGES.md`.
 *
 * Two decisions worth stating, because both are things a naive implementation gets wrong:
 *
 *  1. **Only the selected pages are rendered.** Rendering 500 pages to delete 490 of them costs the user 30
 *     seconds of their life and a lot of CPU; `mutool -p` renders the selection directly.
 *  2. **Output names are dense and 1-based within the selection.** Exporting "pages 5-9" must produce
 *     `page-001..page-005`, not `page-005..page-009` — the sparse naming is a classic source of confusion when
 *     people combine the images back into a document.
 *
 * The output projection is checked *before* rendering: at 600 dpi a single A4 page is ~50 MB of pixels, and a
 * 200-page job would fill the volume. Failing with a suggestion to lower the dpi is far better than an OOM kill.
 */

const MAX_RENDER_BYTES_PER_PAGE = 512 * 1024 * 1024;
const MAX_RENDER_BYTES_TOTAL = 4 * 1024 * 1024 * 1024;

/**
 * The most `magick identify` is allowed to print.
 *
 * One line per part, and the parts are bounded by the plan's page limit — but the engine wrapper's default is a 4 KB
 * *log* tail, and a line per output is not a log (defects 123 and 126 were both a read that shared that budget). At
 * 200 parts the default would truncate the list silently, and the warning it drives would be about pages nobody read.
 */
const IDENTIFY_STDOUT_BYTES = 64 * 1024;

export const pdfToImages: Handler<PdfToImagesOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;

  report({ progress: 8, phase: 'staging' });

  const totalPages = await countPages(input, workDir, limits.timeoutSeconds * 1000);
  const selected = options.pages ? expandRanges(options.pages, totalPages).filter((p) => p <= totalPages) : null;
  const pageList = selected ?? Array.from({ length: totalPages }, (_, i) => i + 1);

  // `/Rotate`, read for the warning and nothing else.
  //
  // Read *after* the page count and not before, because `countPages` has already proved qpdf can open the file: a
  // document that cannot be read fails there, with the message it owes. A failure here is a file qpdf opened but
  // could not describe, and it must not fail a job whose images are right — mutool applies `/Rotate` on its own, so
  // the render is unaffected and the warning is simply not emitted. That is the honest degradation: the alternative
  // (throw) turns a cosmetic sentence into a failed export, and the alternative after that (assume zero) turns it
  // into a wrong sentence.
  const rotations = await readPageRotations(input, {
    cwd: workDir,
    timeoutMs: Math.min(limits.timeoutSeconds * 1000, 30_000),
  }).catch(() => null);
  const rotatedPages = rotations ? pageList.filter((page) => (rotations[page - 1] ?? 0) % 360 !== 0) : [];

  if (pageList.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'None of the requested pages exist in this document.' });
  }
  // The plan's ceiling, not the tool's `maxPages` (which is `0` for every tool in the registry and made this check
  // unreachable — defect 154). It is about the pages this *job* will render, which a selection can make larger than the
  // document's own count, so step 5's measurement of the inputs does not replace it.
  if (limits.planMaxPages > 0 && pageList.length > limits.planMaxPages) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `Exporting ${pageList.length} pages exceeds this plan's limit of ${limits.planMaxPages}.`,
    });
  }

  // ── Projection guard ──────────────────────────────────────────────────────
  const geometry = await pageGeometry(input, workDir);
  const widest = geometry.reduce((max, g) => Math.max(max, g.width, g.height), 0) || 595;
  const projection = projectBytes(pageList.length, widest, options.dpi, options.colorMode);
  if (projection.perPage > MAX_RENDER_BYTES_PER_PAGE || projection.total > MAX_RENDER_BYTES_TOTAL) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `${options.dpi} dpi on ${pageList.length} pages would need about ${Math.round(projection.total / 1024 ** 2)} MB of pixels. Lower the resolution and try again.`,
      stderrTail: JSON.stringify(projection),
    });
  }

  report({ progress: 15, phase: 'processing', message: `Rendering ${pageList.length} pages at ${options.dpi} dpi.` });

  const rawDir = await ensure(join(workDir, 'raw'));
  // Parts are written directly into `output/`, not an `output/parts/` subdirectory. Verification resolves every
  // declared output name against `outputDir` — `stat(join(outputDir, name))` — and `SAFE_NAME` rejects names with a
  // path separator, so a subdirectory cannot be declared at all: each job rendered its pages, declared them, and
  // then failed with "missing or empty: page-001.jpg". The archive is created by the runtime from the verified
  // list, so a tidy subdirectory was never needed.
  const partsDir = outputDir;

  // mutool names output with %03d over the *rendered* set, so its numbering is already dense.
  //
  // **The page selection is a trailing positional argument, and `-p` is the *password*.** The version that shipped got
  // this wrong: `-p 1` was read by mutool as "password: 1", the range was silently ignored, and a job that asked for one
  // page rendered all six of the fixture while declaring `pages: [1, null, null, null, null, null]` on its parts —
  // because the labelling loop walks the *rendered* files against a list of one. Measured on mutool 1.25.1:
  // `mutool draw … -p 1 fixture.pdf` writes six images, `mutool draw … fixture.pdf 1` writes one (defect 102).
  const pageSpec = selected ? [pageList.join(',')] : [];
  const colorFlag =
    options.colorMode === 'color' ? ['-c', 'rgb'] : options.colorMode === 'grayscale' ? ['-c', 'gray'] : [];

  await runMutool(
    [
      'draw',
      '-r',
      String(options.dpi),
      ...colorFlag,
      '-o',
      join(rawDir, 'page-%03d.png'),
      '-F',
      'png',
      input,
      ...pageSpec,
    ],
    { cwd: workDir, timeoutMs: limits.timeoutSeconds * 1000, memoryMb: limits.memoryMb, ...(signal ? { signal } : {}) },
  );

  const rendered = (await readdir(rawDir)).filter((name) => name.endsWith('.png')).sort();
  if (rendered.length === 0) {
    throw new JobFailure('CONVERSION_FAILED', { message: 'No pages could be rendered.' });
  }
  // The parts are labelled by pairing each rendered file with the page it came from (`pageList[index]`), so the two
  // lists have to be the same length. When they are not, the pairing is meaningless and every part after the first
  // would carry `pages: [null]` — a lie in the metadata the UI reads to find the image for a page. That is how a page
  // selection that did nothing stayed invisible: the job succeeded and the parts looked plausible (defect 102).
  if (rendered.length !== pageList.length) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `The renderer produced ${rendered.length} image(s) for ${pageList.length} selected page(s), so the parts cannot be labelled with the pages they came from.`,
    });
  }

  // ── Format conversion ─────────────────────────────────────────────────────
  const warnings: Array<{ code: string; detail?: string }> = [];
  const outputs: OutputDescriptor[] = [];
  const ext = options.format === 'jpg' ? 'jpg' : options.format === 'png' ? 'png' : 'webp';
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/webp';

  for (const [index, file] of rendered.entries()) {
    const stem = `page-${String(index + 1).padStart(3, '0')}`;
    const target = join(partsDir, `${stem}.${ext}`);
    // A PNG render is the requested output only when nothing has to be *applied* to it. `bw` used to be skipped for
    // PNG — the file was copied and the request was answered with a warning, so `colorMode: 'bw'` produced
    // 8-bit/color RGB and the option did nothing (defect 127, measured with `file` on the delivered page). Going
    // through ImageMagick for that combination is what makes "`bw` produces 1-bit output" true: `-monochrome`
    // writes a depth-1 grey PNG, and the harness's image reader now asserts the bit depth rather than the sentence.
    const applyNothing = options.format === 'png' && options.colorMode !== 'bw';
    if (applyNothing) {
      // Already PNG; copy instead of re-encoding so byte-identical output is possible.
      await Bun.write(target, Bun.file(join(rawDir, file)));
    } else {
      await magickOrThrow(
        [
          join(rawDir, file),
          ...(options.colorMode === 'bw' ? ['-monochrome'] : []),
          '-quality',
          String(options.quality),
          target,
        ],
        {
          cwd: workDir,
          timeoutMs: limits.timeoutSeconds * 1000,
          memoryMb: limits.memoryMb,
          ...(signal ? { signal } : {}),
        },
      );
    }
    outputs.push({ name: `${stem}.${ext}`, mime, pages: [pageList[index]!] });
    if (index % 10 === 0) {
      report({ progress: 20 + Math.round((index / rendered.length) * 65), phase: 'processing' });
    }
  }

  // The limit that is a property of the *container*, not of this handler: a JPEG's minimum precision is 8 bits and
  // WEBP is 8 bits per channel by construction, so "1-bit" cannot be delivered in either. Asserted rather than
  // claimed — a `bw` JPEG is asserted to carry one component (grey) at 8 bits, which is what the format can hold.
  if (options.colorMode === 'bw' && options.format !== 'png') {
    warnings.push({
      code: 'BW_REQUESTED',
      detail: `${options.format.toUpperCase()} stores at least 8 bits per channel, so black-and-white output is a monochrome render saved at that depth. Choose PNG for a 1-bit file.`,
    });
  }

  // ── Pages with no ink, measured ───────────────────────────────────────────
  //
  // The warning the document promises (`BLANK_PAGES_DETECTED`) and that nothing emitted. The rule is exact rather
  // than a threshold: a file whose **darkest pixel is pure white** carries no ink at all — one flat white field,
  // whatever the page was supposed to contain. A threshold would have to be invented (how grey is "blank"?), and an
  // invented number is what this repository keeps replacing with a measurement. One process for the whole job, not
  // one per page.
  const blankPages = await blankPagesAmong(outputs, partsDir, workDir, pageList, limits.timeoutSeconds * 1000);
  if (blankPages.length > 0) {
    warnings.push({
      code: 'BLANK_PAGES_DETECTED',
      detail: `Page${blankPages.length === 1 ? '' : 's'} ${blankPages.join(', ')} of the document ${blankPages.length === 1 ? 'renders' : 'render'} with no ink at all. Check the page selection if that was not intended.`,
    });
  }
  if (rotatedPages.length > 0) {
    warnings.push({
      code: 'PAGE_ROTATION_NORMALIZED',
      detail: `Page${rotatedPages.length === 1 ? '' : 's'} ${rotatedPages.join(', ')} carr${rotatedPages.length === 1 ? 'ies' : 'y'} a /Rotate value, which the renderer applied so the ${rotatedPages.length === 1 ? 'image is' : 'images are'} upright.`,
    });
  }

  outputs[0]!.primary = true;
  report({ progress: 92, phase: 'finalizing', message: 'Packaging pages.' });

  return {
    outputs,
    metrics: {
      renderedPages: outputs.length,
      // The pages the handler actually rendered, not the ones it was asked for. `pages` used to be accepted, ignored
      // and reported nowhere, so nothing — no case, no operator, no dashboard — could see the difference between a
      // selection that worked and one that did nothing (defect 102).
      renderedPageNumbers: pageList,
      dpi: options.dpi,
      format: options.format,
      projectedPixels: projection.totalPixels,
      // The two warnings above, as numbers. A warning is a sentence; a count is something a dashboard can chart, and
      // the difference between "no blank pages" and "nobody measured" has to be visible somewhere (defect 102's
      // lesson: an option that was accepted, ignored and reported nowhere stayed invisible for eight passes).
      blankPages,
      rotatedPages,
    },
    warnings,
    engine: { name: 'mutool' },
  };
};

/**
 * The pages whose delivered image carries no ink, by the rule "the darkest pixel is pure white".
 *
 * Returns page numbers of the **source document** rather than file indices, because that is what the user selected:
 * a job asked for pages 5–9 that reports "page 2 is blank" is talking about the second file, which is the kind of
 * almost-right answer the placement canvas was built to stop (defect 102).
 *
 * A failure of the measurement is not a failure of the job: a format ImageMagick cannot read, or an output the
 * wrapper could not describe, means the warning is not emitted — the images are delivered either way.
 */
async function blankPagesAmong(
  outputs: OutputDescriptor[],
  outputDir: string,
  cwd: string,
  pageList: number[],
  timeoutMs: number,
): Promise<number[]> {
  if (outputs.length === 0) return [];
  const result = await runMagick(
    ['identify', '-format', '%f\t%[fx:minima]\n', ...outputs.map((output) => join(outputDir, output.name))],
    { cwd, timeoutMs: Math.min(timeoutMs, 60_000), stdoutLimitBytes: IDENTIFY_STDOUT_BYTES },
  );
  if (result.code !== 0) return [];

  const blank: number[] = [];
  for (const line of result.stdout.split('\n')) {
    const [name, value] = line.split('\t');
    if (!name || value === undefined) continue;
    const darkest = Number(value);
    if (!Number.isFinite(darkest) || darkest < 1) continue;
    const index = outputs.findIndex((output) => output.name === name);
    if (index >= 0) blank.push(pageList[index] ?? index + 1);
  }
  return blank;
}

function projectBytes(
  pages: number,
  widthPt: number,
  dpi: number,
  colorMode: string,
): {
  perPage: number;
  total: number;
  totalPixels: number;
} {
  const scale = dpi / 72;
  // Assume a square-ish page when the real height is unknown: an under-estimate would defeat the guard.
  const px = Math.round(widthPt * scale);
  const perPagePixels = px * Math.round(px * Math.SQRT2);
  const channels = colorMode === 'color' ? 4 : 1;
  const perPage = perPagePixels * channels;
  return { perPage, total: perPage * pages, totalPixels: perPagePixels * pages };
}

async function countPages(path: string, cwd: string, timeoutMs: number): Promise<number> {
  const result = await runQpdf(['--show-npages', path], { cwd, timeoutMs: Math.min(timeoutMs, 30_000) });
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (result.code !== 0 || !Number.isFinite(value)) {
    throw new JobFailure('INVALID_FILE', { message: 'The PDF could not be read.' });
  }
  return value;
}

/** Page boxes from mutool, so the projection uses the real geometry rather than an assumption. */
async function pageGeometry(path: string, cwd: string): Promise<Array<{ width: number; height: number }>> {
  const result = await runMutool(['info', path], { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) return [];
  const boxes: Array<{ width: number; height: number }> = [];
  for (const line of result.stdout.split('\n')) {
    const match = /MediaBox:\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(line);
    if (!match) continue;
    const [, x0, y0, x1, y1] = match.map(Number) as unknown as number[];
    if ([x0, y0, x1, y1].every((n) => Number.isFinite(n))) {
      boxes.push({ width: Math.abs(x1! - x0!), height: Math.abs(y1! - y0!) });
    }
  }
  return boxes;
}

async function ensure(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}
