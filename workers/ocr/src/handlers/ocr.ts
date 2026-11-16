import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OcrOptions } from '@pdftools/contracts/tools';
import { ocrmypdfOrThrow, parseJsonLine, pythonOrThrow, runPdfImages, runPdfToText, runQpdf } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, type OutputDescriptor, expandRanges } from '@pdftools/worker-shared';

/**
 * `ocr` — `docs/15-OCR.md`.
 *
 * Behaviours here that are correctness rather than polish:
 *
 *  1. **`--skip-text` always.** A mixed document (typed pages plus scanned inserts) must not have its good pages
 *     re-recognised: re-OCR of already-correct text can only introduce errors, and it throws away any manual
 *     corrections the source contained.
 *  2. **Refusal below 120 dpi.** Recognition accuracy collapses at low resolution, so spending two minutes to
 *     produce confident-looking garbage is worse than refusing and asking for a 300 dpi rescan.
 *  3. **Every declared output is written into `outputDir`.** The runtime verifies an output by `stat`-ing
 *     `join(outputDir, name)` — the sidecar used to be written into `workDir`, where nothing looks, so
 *     `outputMode: 'text-only'`, `sidecar: true` and `outputMode: 'pdf-and-text'` all ended as
 *     `CONVERSION_FAILED: The tool reported success but produced no usable output.` Two of the three documented
 *     output modes were dead, and the third was only alive because it writes no sidecar (defect 171).
 *  4. **A page nobody could read is named.** `PAGE_PARTIALLY_RECOGNISED` lists the pages that came back empty; on a
 *     scanned archive an unreadable page is a fact the caller needs, and the document-level guard ("no text at all
 *     anywhere") says nothing about it.
 *
 * What this handler deliberately does **not** report: a "mean confidence" number. OCRmyPDF does not expose one, and
 * deriving a plausible-looking percentage from nothing would be worse than saying nothing — the metrics simply omit
 * it, and text extraction after the fact is the verification that actually means something.
 */

const AVAILABLE_LANGUAGES = [
  'eng',
  'ind',
  'deu',
  'fra',
  'spa',
  'ita',
  'por',
  'nld',
  'jpn',
  'kor',
  'chi_sim',
  'chi_tra',
  'ara',
  'rus',
  'hin',
  'tha',
  'vie',
  'msa',
];

const MIN_DPI = 120;
/** Below this, the automatic path re-samples; the document's own rule is "only up-rasters when below 200". */
const AUTO_UPSCALE_BELOW = 200;
/** What the automatic path re-samples *to*, and what `preset: 'accurate'` raises it to. */
const AUTO_UPSCALE_DPI = 300;
const ACCURATE_UPSCALE_DPI = 400;
const MIN_TEXT_CHARS = 20;

/**
 * Language codes reach the engine joined with `+`; the schema accepts `['eng+ind']` as well as `['eng','ind']`,
 * because both spellings are used in the wild and only one of them was ever documented.
 */
function requestedLanguages(options: OcrOptions): string[] {
  return [...new Set(options.languages.flatMap((entry) => entry.split('+')).filter((code) => code.length > 0))];
}

/**
 * The image → PDF bridge: Pillow for the resolution and the frames, img2pdf for the page.
 *
 * Two engines because each owns half the problem. Pillow is the only reader in this pool that opens TIFF (img2pdf
 * refuses the 16-bit one) and the only one that can walk a multi-frame TIFF — a multi-page scan, which this pool
 * receives as one file. img2pdf then embeds the JPEG/PNG data **losslessly** and derives the page box from the
 * resolution, which is the part a hand-written pikepdf page would get wrong.
 *
 * A resolution nobody recorded is not guessed. img2pdf's own default is 96 dpi (measured), which would silently turn
 * an unlabelled photo into a 96 dpi page and then fail the low-resolution gate with "rescan at 300 dpi" — a true
 * sentence about the wrong thing. The caller is asked instead, through the `dpi` option that exists for it.
 *
 * An image Pillow cannot open (HEIC, in this image) is reported by name so the refusal can point at
 * `images-to-pdf`, which transcodes it.
 */
const IMAGE_SCRIPT = `
import json, os, sys

import img2pdf
from PIL import Image, ImageSequence

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
requested_dpi = payload.get('dpi')
frames_dir = payload['framesDir']
os.makedirs(frames_dir, exist_ok=True)

pages = []
resolutions = []
unreadable = []
without_resolution = []

for index, path in enumerate(payload['files']):
    try:
        with Image.open(path) as image:
            dpi = image.info.get('dpi')
            source = path
            if getattr(image, 'n_frames', 1) > 1:
                # A multi-frame TIFF is a multi-page scan: every frame is a page. Frames are re-encoded as PNG
                # because img2pdf takes one file per page and a *frame* has no path of its own.
                source = None
                for frame_index, frame in enumerate(ImageSequence.Iterator(image)):
                    target = os.path.join(frames_dir, f'frame-{index}-{frame_index}.png')
                    frame.convert('RGB').save(target, dpi=dpi if dpi else None)
                    pages.append(target)
                if not dpi:
                    without_resolution.append(os.path.basename(path))
                continue
            if not dpi:
                without_resolution.append(os.path.basename(path))
            else:
                resolutions.append(float(dpi[0]))
            pages.append(source)
    except Exception as error:  # noqa: BLE001 — the reason is reported, not swallowed
        unreadable.append({'name': os.path.basename(path), 'reason': str(error)})

result = {
    'pages': pages,
    'resolutions': resolutions,
    'unreadable': unreadable,
    'withoutResolution': without_resolution,
    'resolution': None,
    'bytes': 0,
}

if not pages:
    print(json.dumps(result))
    sys.exit(0)

resolution = float(requested_dpi) if requested_dpi else (min(resolutions) if resolutions else None)
layout = img2pdf.get_fixed_dpi_layout_fun((resolution, resolution)) if resolution else img2pdf.default_layout_fun
try:
    with open(payload['output'], 'wb') as handle:
        handle.write(img2pdf.convert(pages, layout_fun=layout))
except Exception as error:  # noqa: BLE001 — img2pdf reports per-image reasons (bit depth, colour space)
    result['error'] = str(error)
else:
    result['resolution'] = resolution
    result['bytes'] = os.path.getsize(payload['output'])

print(json.dumps(result))
`;

interface ImageBridgeResult {
  pages: string[];
  resolutions: number[];
  unreadable: Array<{ name: string; reason: string }>;
  withoutResolution: string[];
  resolution: number | null;
  bytes: number;
  error?: string;
}

export const ocr: Handler<OcrOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const warnings: Array<{ code: string; detail?: string }> = [];
  const outputs: OutputDescriptor[] = [];

  const requested = requestedLanguages(options);
  const unknown = requested.filter((code) => !AVAILABLE_LANGUAGES.includes(code));
  if (unknown.length > 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `These languages are not installed: ${unknown.join(', ')}.`,
      stderrTail: `available: ${AVAILABLE_LANGUAGES.join(' ')}`,
    });
  }
  if (requested.length > 3) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'Use at most three languages in one job.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  report({ progress: 5, phase: 'staging', message: 'Inspecting the document.' });

  // ── Which kind of job is this? ─────────────────────────────────────────────
  //
  // The catalog accepts one document or up to twenty images, and nothing told the handler which it had: it read
  // `files[0]` and every further file was silently ignored, so a two-document job looked like a success that had
  // quietly dropped an input (defect 172). The kinds are now separated, and a combination the tool cannot honour is
  // named rather than half-done.
  const stages = files.filter((file) => (file.kind ?? 'input') === 'input');
  const documents = stages.filter((file) => file.detectedType === 'application/pdf');
  const images = stages.filter((file) => (file.detectedType ?? '').startsWith('image/'));
  const unclassified = stages.filter((file) => !documents.includes(file) && !images.includes(file));
  if (unclassified.length > 0) {
    throw new JobFailure('UNSUPPORTED_FILE_TYPE', {
      message:
        'OCR reads PDF documents and images (JPG, PNG, TIFF). Run other formats through the tool that converts them first.',
      stderrTail: `unreadable as a document or an image: ${unclassified.map((file) => file.name).join(', ')}`,
    });
  }
  if (documents.length > 1 || (documents.length > 0 && images.length > 0)) {
    throw new JobFailure('VALIDATION_ERROR', {
      message:
        'OCR takes one document, or up to 20 images which are merged into one PDF first. Two documents is a merge — run them through `merge` first.',
      stderrTail: `received ${documents.length} document(s) and ${images.length} image(s)`,
    });
  }
  if (stages.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'Add a document or an image to OCR.' });
  }

  // ── The input the rest of this handler works on ────────────────────────────
  //
  // Exactly one of these two branches runs, because the rules above leave no third case. It used to read
  // `documents[0].path` unconditionally with a non-null assertion, which an image-only job turned into
  // `TypeError: undefined is not an object` — reported to the caller as `INTERNAL_ERROR`, since a plain TypeError is
  // not a classified failure (measured before the first image case could pass).
  let input: string;
  let measuredDpi: number | null = null;
  if (documents.length > 0) {
    input = documents[0]!.path;
  } else {
    const built = join(workDir, 'images.pdf');
    const bridge = await pythonOrThrow(
      IMAGE_SCRIPT,
      {
        files: images.map((file) => file.path),
        output: built,
        framesDir: join(workDir, 'frames'),
        dpi: options.dpi ?? null,
      },
      runOpts,
    );
    const result = parseJsonLine<ImageBridgeResult>(bridge.stdout);
    if (!result) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: 'The images could not be prepared for recognition.',
        stderrTail: bridge.stderr,
      });
    }
    if (result.unreadable.length > 0) {
      throw new JobFailure('UNSUPPORTED_FILE_TYPE', {
        message: `${result.unreadable.map((entry) => entry.name).join(', ')} could not be read as an image. HEIC needs \`images-to-pdf\`, which converts it to a PDF this tool can read.`,
        stderrTail: result.unreadable.map((entry) => `${entry.name}: ${entry.reason}`).join('; '),
      });
    }
    if (result.withoutResolution.length > 0 && options.dpi == null) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `${result.withoutResolution.join(', ')} do not say what resolution they were scanned at, so their page size is unknown. Set \`dpi\` to the resolution they were scanned at.`,
        stderrTail: 'img2pdf defaults to 96 dpi, which this tool refuses below 120 — guessing would hide the reason',
      });
    }
    if (result.error || result.bytes === 0) {
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message: 'These images could not be placed on a page.',
        stderrTail: result.error ?? 'no PDF was written',
      });
    }
    input = built;
    measuredDpi = result.resolution;
  }

  const totalPages = await countPages(input, workDir, limits.timeoutSeconds * 1000);
  // `planMaxPages` is the plan's ceiling as the API resolved it; `limits.maxPages` is the tool's cap and is `0` for
  // every tool in the registry, so a comparison against it could never fire (defect 154).
  if (limits.planMaxPages > 0 && totalPages > limits.planMaxPages) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `This document has ${totalPages} pages, above this plan's OCR limit of ${limits.planMaxPages}.`,
    });
  }

  // ── Resolution: measured rather than assumed, and up-sampled on the document's own rule ──
  //
  // A document carries its resolution in its embedded images; an image input carries it in its own metadata and the
  // bridge has already read it. `dpi` wins over both because it is the caller *saying* what the resolution is — which
  // is also the only way an image with no resolution can be processed at all.
  if (measuredDpi == null) measuredDpi = await measureDpi(input, workDir);
  if (measuredDpi != null && measuredDpi < MIN_DPI) {
    throw new JobFailure('UNSUPPORTED_CONTENT', {
      message: `This scan is about ${Math.round(measuredDpi)} dpi. OCR needs at least ${MIN_DPI} dpi — please rescan at 300 dpi.`,
      stderrTail: `measured dpi: ${measuredDpi}`,
    });
  }
  const oversampleDpi =
    options.dpi ??
    (measuredDpi != null && measuredDpi < AUTO_UPSCALE_BELOW
      ? options.preset === 'accurate'
        ? ACCURATE_UPSCALE_DPI
        : AUTO_UPSCALE_DPI
      : null);

  if (await hasExistingTextLayer(input, workDir)) {
    warnings.push({
      code: 'EXISTING_TEXT_PRESERVED',
      detail:
        'Pages that already contain text are left untouched (--skip-text), so an earlier layer is never replaced.',
    });
  }

  // ── The page selection ─────────────────────────────────────────────────────
  //
  // OCRmyPDF's `--pages` limits recognition to the pages named and **keeps the rest of the document** (measured on a
  // three-page scan: `--pages 1` produced three pages, with only page 1 recognised). That is the promise the document
  // makes and the control the UI renders — and nothing read the option before this, so a selection was silently
  // ignored (defect 173).
  const selected = options.pages
    ? [...new Set(expandRanges(options.pages, totalPages).filter((page) => page >= 1 && page <= totalPages))].sort(
        (a, b) => a - b,
      )
    : null;
  if (selected && selected.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'No page in this document matches that selection.' });
  }

  const languageFlag = requested.join('+');

  // OCRmyPDF's own spellings, not Tesseract's. `--oem`/`--psm` are Tesseract CLI flags; OCRmyPDF does not forward
  // unknown options, so passing them made *every* OCR job die in argument parsing ("unrecognized arguments: --oem
  // --psm") before a single page was read. The equivalent knobs are `--tesseract-oem` and `--tesseract-pagesegmode`.
  const presetFlags =
    options.preset === 'fast'
      ? ['--tesseract-oem', '1', '--tesseract-pagesegmode', '6']
      : options.preset === 'accurate'
        ? ['--tesseract-oem', '3', '--tesseract-pagesegmode', '1']
        : ['--tesseract-oem', '1', '--tesseract-pagesegmode', '3'];

  const commonFlags = [
    '--language',
    languageFlag,
    ...presetFlags,
    '--skip-text',
    ...(selected ? ['--pages', selected.join(',')] : []),
    ...(options.clean ? ['--clean'] : []),
    ...(oversampleDpi ? ['--oversample', String(oversampleDpi)] : []),
  ];

  // Both of these live in `outputDir` because that is where the runtime looks for a declared output. They used to be
  // `workDir`, which is what made the text modes fail the job (defect 171).
  const sidecarPath = join(outputDir, 'ocr-text.txt');
  const searchablePath = join(outputDir, 'searchable.pdf');

  report({
    progress: 15,
    phase: 'processing',
    message: `Recognising ${selected ? selected.length : totalPages} of ${totalPages} pages in ${languageFlag}.`,
  });

  const wantSidecar = options.sidecar || options.outputMode === 'pdf-and-text';
  if (options.outputMode === 'text-only') {
    // `--output-type none` writes only the sidecar: the fastest path to text, and no PDF is produced in vain.
    //
    // The trailing `-` is a **required positional**, and leaving it out is what the first version of this handler
    // did — OCRmyPDF then exits 2 with "the following arguments are required: output_pdf", which the caller saw as
    // `CONVERSION_FAILED` and the document described as a working mode. `-` rather than a path because with
    // `--output-type none` it writes nothing (measured: the stream is 0 bytes), while any real path gets a warning
    // about a file that "cannot be produced" and a stray name in the work directory.
    await ocrmypdfOrThrow([...commonFlags, '--sidecar', sidecarPath, '--output-type', 'none', input, '-'], runOpts);
    outputs.push({ name: 'ocr-text.txt', mime: 'text/plain', primary: true });
  } else {
    const args = [
      ...commonFlags,
      '--output-type',
      'pdf',
      '--optimize',
      '1',
      '--jobs',
      '2',
      '--tesseract-timeout',
      String(Math.min(limits.timeoutSeconds, 600)),
    ];
    if (options.deskew) args.push('--deskew', '--rotate-pages');
    if (wantSidecar) args.push('--sidecar', sidecarPath);
    args.push(input, searchablePath);

    await ocrmypdfOrThrow(args, runOpts);

    outputs.push({ name: 'searchable.pdf', mime: 'application/pdf', primary: true });
    if (wantSidecar) outputs.push({ name: 'ocr-text.txt', mime: 'text/plain' });
  }

  report({ progress: 88, phase: 'finalizing', message: 'Verifying the text layer.' });

  // ── Verification: an OCR job that produced no text is a failure ────────────
  //
  // Read with the reader that fits the product: `pdftotext` for a PDF, and the file itself when the product *is* the
  // text. The first version ran `pdftotext` over `ocr-text.txt` in `text-only` mode — a text file is not a PDF, so
  // every successful text job was reported as "No text could be recognised", which is the second half of defect 171.
  const recognised =
    options.outputMode === 'text-only'
      ? (await readFile(sidecarPath, 'utf8').catch(() => '')).trim()
      : ((
          await runPdfToText([searchablePath, '-'], { cwd: workDir, timeoutMs: 60_000 }).catch(() => null)
        )?.stdout.trim() ?? '');
  if (recognised.length < MIN_TEXT_CHARS) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'No text could be recognised. The scan may be too low quality for OCR.',
    });
  }

  // ── The per-page half of that guard ────────────────────────────────────────
  //
  // Both products separate pages with a form feed — `pdftotext` on a PDF, and OCRmyPDF's own sidecar (measured on a
  // three-page scan: three segments, the blank page's one empty) — so every page's text is read in one call. That is
  // the point: a page the recogniser could not read at all is named rather than averaged away by the document-level
  // count. Pages outside the selection are not judged, because nobody asked for them.
  const pageTexts = recognised.split('\f');
  const judged = selected ?? Array.from({ length: totalPages }, (_, index) => index + 1);
  const pagesWithoutText = judged.filter((page) => (pageTexts[page - 1] ?? '').trim().length === 0);
  if (pagesWithoutText.length > 0) {
    warnings.push({
      code: 'PAGE_PARTIALLY_RECOGNISED',
      detail: `No text could be read from page(s) ${pagesWithoutText.join(', ')} — they may be blank, or too poor to recognise.`,
    });
  }

  return {
    outputs,
    metrics: {
      pagesProcessed: totalPages,
      // OCR never changes the page count, and reporting it is what lets a client (and the E2E harness) check the
      // output against the input instead of trusting the status.
      outputPages: totalPages,
      pagesSelected: selected ? selected.length : totalPages,
      languages: requested,
      preset: options.preset,
      outputMode: options.outputMode,
      measuredDpi,
      // What was actually handed to `--oversample`, so "the option reached the engine" is a fact rather than a
      // reading of the argument list: `null` means the automatic path found nothing to re-sample.
      oversampleDpi,
      clean: options.clean,
      imageInputs: images.length,
      pagesWithoutText,
      recognisedCharacters: recognised.length,
    },
    warnings,
    engine: { name: 'ocrmypdf' },
  };
};

async function countPages(path: string, cwd: string, timeoutMs: number): Promise<number> {
  const result = await runQpdf(['--show-npages', path], { cwd, timeoutMs: Math.min(timeoutMs, 30_000) });
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (result.code !== 0 || !Number.isFinite(value)) {
    throw new JobFailure('INVALID_FILE', { message: 'The document could not be read.' });
  }
  return value;
}

/**
 * Effective image resolution from `pdfimages -list`, which reports the x/y ppi of each embedded image.
 *
 * `null` means "could not tell" — a text-only PDF has no images at all, and that is not a failure: the OCR pass
 * will handle whatever pages do contain scans.
 */
async function measureDpi(path: string, cwd: string): Promise<number | null> {
  const result = await runPdfImages(['-list', path], { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) return null;

  const values: number[] = [];
  for (const line of result.stdout.split('\n')) {
    const cells = line.trim().split(/\s+/);
    // Columns: page num type width height color comp bpc enc interp object x-ppi y-ppi size ratio
    const xPpi = Number.parseFloat(cells[cells.length - 4] ?? '');
    const yPpi = Number.parseFloat(cells[cells.length - 3] ?? '');
    for (const value of [xPpi, yPpi]) if (Number.isFinite(value) && value > 1) values.push(value);
  }
  if (values.length === 0) return null;
  // The lowest embedded resolution is what governs recognition quality on a mixed scan.
  return Math.min(...values);
}

async function hasExistingTextLayer(path: string, cwd: string): Promise<boolean> {
  const text = await runPdfToText([path, '-'], { cwd, timeoutMs: 30_000 }).catch(() => null);
  return (text?.stdout.trim().length ?? 0) > MIN_TEXT_CHARS;
}
