import { join } from 'node:path';
import type { PageNumberOptions } from '@pdftools/contracts/tools';
import {
  type OverlayPage,
  type OverlayPlacement,
  availablePostScriptFonts,
  countPdfPages,
  hexToRgbTriplet,
  mergeOverlayPdf,
  readPageBoxes,
  readSignatureRecord,
  renderOverlayPdf,
  resolvePostScriptFont,
  runPdfToText,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `page-numbers` — `docs/12-PAGE-NUMBERS-HEADERS-FOOTERS.md`.
 *
 * A thin policy layer over the shared overlay pipeline (`packages/engines/src/overlay.ts`): the only decisions here
 * are which pages get a stamp, what each stamp says, and where it sits. The drawing and the merge are the same code
 * `watermark` and `header-footer` will use, which is the point of that module existing.
 *
 * Four behaviours are deliberate:
 *
 *  1. **One overlay page per stamped page.** The number changes per page, so a single overlay repeated by `qpdf
 *     --repeat` cannot express it. The overlay is nevertheless *one* Ghostscript invocation: the program emits N
 *     pages, so a 500-page document costs one engine spawn, not 500.
 *  2. **Each overlay page is sized to its target page.** `readPageBoxes` reads every media box first, so a document
 *     that mixes A4 and letter gets correctly placed stamps on both. One overlay stretched across mixed sizes is how
 *     "the number is half off the page" happens on the three pages the user cares about.
 *  3. **`{total}` is the last number that will be shown**, so numbering that starts at 3 across five pages reads
 *     "3 of 7" through "7 of 7". The alternative — counting stamped pages — produces a document whose last page says
 *     "7 of 5", which is worse than any amount of arithmetic.
 *  4. **Stamp placement never relies on font metrics.** Ghostscript measures the string with `stringwidth`, so
 *     centring is exact for the chosen font and size rather than approximately right for the average width.
 *  5. **`countFrom` decides *which* page shows "1", `startAt` decides what that number *is*.** The displayed number
 *     of a page is `startAt + (page - displayBase)`, where the base is `countFrom` when it is set and the first
 *     stamped page otherwise — so a selection that starts at page 2 and a document numbered from page 1 give the same
 *     answers as before, and `countFrom: 3` is "the third page is 1" (`12-…` §4, which is the paragraph that made the
 *     distinction necessary). Pages before the base are not stamped at all: the same rule `skipFirstPage` applies.
 *  6. **A number already printed in the band is reported, not silently doubled.** The tool draws *over* whatever is
 *     there, so a document that arrives pre-numbered ends up with two numbers in the same corner — the defect every
 *     reader has seen in the wild and the one `12-…` §1 promises a warning for. The probe reads page one's **word
 *     boxes** and looks only at the band this job is about to stamp, which is what keeps it from firing on body text
 *     that happens to say "page 3 of 12".
 */

/** The four presets the shipped option surface exposes (`docs/12-…` §2 describes a freer template; this is the contract). */
const FORMAT_TEMPLATES: Record<PageNumberOptions['format'], (page: number, total: number) => string> = {
  n: (page) => `${page}`,
  'n-of-total': (page, total) => `${page} of ${total}`,
  'page-n': (page) => `Page ${page}`,
  'page-n-of-total': (page, total) => `Page ${page} of ${total}`,
};

/**
 * `PREFIX000142SUFFIX` — Bates numbering (`12-…` §2).
 *
 * `digits` is a **minimum** width: a run that passes `999999` with `digits: 6` prints seven digits rather than
 * silently repeating a number, which in a discovery set is a correctness problem and not a cosmetic one.
 */
function batesText(number: number, bates: NonNullable<PageNumberOptions['bates']>): string {
  return `${bates.prefix}${String(number).padStart(bates.digits, '0')}${bates.suffix}`;
}

/**
 * The numbering already printed on page one, inside the band this job would stamp — or `null`.
 *
 * Read from `pdftotext -bbox`, whose word boxes are measured from the **top** of the page. The band is the stamp's
 * own row extended sideways across the whole page, because the point of the question is "is *this* corner already
 * numbered" and a wider band would only find body text. Two consequences worth knowing: a scan has no text layer to
 * read (so no warning, correctly), and a margin far enough in to cover a body line can read that line as a number.
 */
async function existingNumbering(
  input: string,
  opts: Parameters<typeof runPdfToText>[1],
  pageHeightPt: number,
  bandPt: number,
  top: boolean,
): Promise<string | null> {
  const result = await runPdfToText(['-bbox', '-f', '1', '-l', '1', input, '-'], {
    ...opts,
    timeoutMs: Math.min(opts.timeoutMs, 20_000),
  });
  if (result.code !== 0) return null;

  const words: string[] = [];
  for (const match of result.stdout.matchAll(WORD_BOX)) {
    const yMin = Number.parseFloat(match[1] ?? '');
    const yMax = Number.parseFloat(match[2] ?? '');
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) continue;
    const inside = top ? yMin <= bandPt : yMax >= pageHeightPt - bandPt;
    if (inside) words.push(match[3] ?? '');
  }
  if (words.length === 0) return null;

  const text = decodeEntities(words.join(' '));
  return text.match(NUMBERING_PATTERN)?.[0] ?? null;
}

/** `<word xMin="72" yMin="81.6" xMax="118.7" yMax="100.1">Page</word>` — the three fields the probe needs. */
const WORD_BOX = /<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g;

/** "Page 1 of 20" and "1 of 6": the word `of` is what separates a page number from a date or a fraction. */
const NUMBERING_PATTERN = /\b(?:page\s+)?\d+\s+of\s+\d+\b/i;

/** The five entities a word box can carry; anything else is left as it is rather than guessed at. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Above this, per-page overlays are worth a warning; above the hard cap the job is refused (`docs/12-…` §4 notes). */
const PER_PAGE_OVERLAY_WARN = 1000;
const PER_PAGE_OVERLAY_MAX = 2000;

const MM_TO_PT = 72 / 25.4;

export const pageNumbers: Handler<PageNumberOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const font = resolvePostScriptFont(options.font);
  if (!font) {
    throw new JobFailure('FONT_NOT_FOUND', {
      message: `"${options.font}" is not a font this build can stamp with. Available: ${availablePostScriptFonts().join(', ')}.`,
    });
  }

  const pages = await countPdfPages(input, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to number.' });
  }

  // Before the overlay is merged: stamping a number writes to the page content a signature's `/ByteRange` covers.
  const signature = await readSignatureRecord(input, runOpts);

  const stamped = resolveStampedPages(options.pages, pages, options.skipFirstPage, options.countFrom);
  if (stamped.length === 0) {
    // Two different reasons, and the caller can act on only one of them: a selection that matches nothing is a
    // typo, while a `countFrom` past the end of the document is an arithmetic mistake about its length.
    const message =
      options.countFrom != null && options.countFrom > pages
        ? `Numbering starts at page ${options.countFrom}, and this document has ${pages} page(s).`
        : 'No page in this document matches that selection.';
    throw new JobFailure('VALIDATION_ERROR', { message });
  }
  if (stamped.length > PER_PAGE_OVERLAY_MAX) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `Numbering ${stamped.length} pages in one job is above the limit of ${PER_PAGE_OVERLAY_MAX}. Split the document first.`,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (stamped.length > PER_PAGE_OVERLAY_WARN) {
    warnings.push({
      code: 'PER_PAGE_OVERLAYS_LARGE',
      detail: `${stamped.length} pages are stamped individually; splitting the document first would be faster.`,
    });
  }

  report({ progress: 20, phase: 'processing', message: 'Measuring pages.' });
  const boxes = await readPageBoxes(input, runOpts);

  const marginPt = options.marginMm * MM_TO_PT;
  const color = hexToRgbTriplet(options.color);
  // Which page shows "1" (`12-…` §4), and what that number is: `countFrom` moves the base, `startAt` (or Bates's own
  // start) sets the value. Deciding both here keeps the two independent, which is the whole reason they are two options.
  const displayBase = options.countFrom ?? stamped[0]!;
  const firstNumber = options.bates?.startAt ?? options.startAt;
  const displayed = (pageNumber: number): number => firstNumber + (pageNumber - displayBase);
  const lastNumber = displayed(stamped[stamped.length - 1]!);
  const render = (number: number): string =>
    options.bates ? batesText(number, options.bates) : FORMAT_TEMPLATES[options.format](number, lastNumber);

  const existing = await existingNumbering(
    input,
    runOpts,
    boxes[0]?.heightPt ?? 842,
    marginPt + options.fontSize * 1.8,
    options.position.startsWith('top'),
  );
  if (existing) {
    warnings.push({
      code: 'NUMBERING_ALREADY_PRESENT',
      detail: `This page already appears to carry a page number ("${existing}") in the band where this job stamps one, and the stamp is drawn over it.`,
    });
  }

  const overlayPages: OverlayPage[] = stamped.map((pageNumber) => {
    const box = boxes[pageNumber - 1] ?? boxes[0]!;
    const placement: OverlayPlacement = {
      text: render(displayed(pageNumber)),
      font,
      sizePt: options.fontSize,
      color,
      anchor: options.position,
      marginPt,
    };
    return { widthPt: box.widthPt, heightPt: box.heightPt, placements: [placement] };
  });

  report({ progress: 45, phase: 'processing', message: `Building ${overlayPages.length} overlay page(s).` });
  const overlayPath = join(workDir, 'page-numbers-overlay.pdf');
  const overlay = await renderOverlayPdf(overlayPages, overlayPath, {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 120_000),
  });

  report({ progress: 80, phase: 'processing', message: 'Stamping the pages.' });
  const outputPath = join(outputDir, 'numbered.pdf');
  const merged = await mergeOverlayPdf(
    input,
    overlayPath,
    outputPath,
    stamped.map((page, index) => ({ page, overlayPage: index + 1 })),
    runOpts,
  );

  // The one invariant worth re-checking from the file rather than trusting: decorating must never add or drop a page.
  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Numbering changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  report({ progress: 95, phase: 'finalizing' });
  return {
    // `pages` on an output descriptor is the per-output page list, so a single-document tool leaves it off and
    // reports the count in metrics (same as `images-to-pdf`).
    outputs: [{ name: 'numbered.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      pagesStamped: stamped.length,
      pagesSkipped: outputPages - stamped.length,
      overlayPages: overlayPages.length,
      overlayBytes: overlay.bytes,
      overlaySeconds: overlay.seconds,
      mergeSeconds: merged.seconds,
      firstNumber,
      lastNumber,
      // `startAt` and `countFrom` are two answers to two different questions, so both travel: a client that shows
      // "page 3 of 10" reads the arithmetic rather than re-deriving it from the options it sent.
      startAt: options.startAt,
      countFrom: options.countFrom ?? null,
      displayBase,
      firstStampedPage: stamped[0]!,
      skipFirstPage: options.skipFirstPage,
      color: options.color,
      numbering: options.bates ? 'bates' : 'format',
      format: options.format,
      bates: options.bates ?? null,
      // What the probe read, so "no warning" is a fact about the document rather than about the probe not running.
      existingNumbering: existing,
      position: options.position,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: 'ghostscript+pikepdf' },
  };
};

/**
 * The pages to stamp, in ascending order, with a range that leaves the document refused rather than ignored.
 *
 * `skipFirstPage` and `countFrom` are the same rule asked two ways — a page that is not part of the numbered sequence
 * does not carry one of its numbers — so both are applied to the list rather than inside the program, which is what
 * keeps `{total}` and the last stamped page's number consistent with each other.
 */
function resolveStampedPages(
  selection: string[] | undefined,
  pageCount: number,
  skipFirstPage: boolean,
  countFrom: number | undefined,
): number[] {
  const requested =
    selection && selection.length > 0
      ? expandRanges(selection, pageCount).filter((page) => page <= pageCount)
      : Array.from({ length: pageCount }, (_, index) => index + 1);
  const unique = [...new Set(requested)].sort((a, b) => a - b);
  return unique.filter((page) => (!skipFirstPage || page !== 1) && (countFrom == null || page >= countFrom));
}
