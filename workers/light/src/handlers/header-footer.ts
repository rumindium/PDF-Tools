import { basename, join } from 'node:path';
import type { HeaderFooterOptions } from '@pdftools/contracts/tools';
import {
  type OverlayPage,
  type OverlayPlacement,
  type OverlayRule,
  availablePostScriptFonts,
  buildImageOverlayPdf,
  countPdfPages,
  hexToRgbTriplet,
  mergeOverlayPdf,
  readPageBoxes,
  readSignatureRecord,
  renderOverlayPdf,
  resolvePostScriptFont,
  runPdfInfo,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `header-footer` — `docs/12-PAGE-NUMBERS-HEADERS-FOOTERS.md`.
 *
 * The same overlay pipeline as `page-numbers` and `watermark`, with two bands instead of one stamp: a header band
 * whose zones sit against the top margin and a footer band against the bottom, each with up to three zones
 * (left/centre/right), plus the rule each band can draw.
 *
 * Five decisions are deliberate:
 *
 *  1. **Zones are the anchor rule the pipeline already has.** A header is `top-left`/`top-center`/`top-right` and a
 *     footer is `bottom-*`, so the geometry, the measurement (`stringwidth`) and the "top margin means the *text*,
 *     not its ascender" behaviour are the ones already proven by `page-numbers` rather than a second implementation
 *     of the same arithmetic.
 *  2. **One overlay page per target page, and one Ghostscript call for the lot.** Each page can carry different
 *     text (`{page}`, `{total}`, `{date}`), so a shared overlay cannot express it; the program emits N pages, so a
 *     500-page document costs one spawn.
 *  3. **A logo is a second overlay, not a second program.** Glyphs come from a typesetter and bitmaps from pikepdf,
 *     and the split is the module's whole design; so the text overlay is merged first and the logo overlay second.
 *     Two passes cost one extra save, and the alternative — giving up the logo's alpha to keep it in the PostScript
 *     program — is exactly the failure (`/SMask` silently dropped) this module exists to avoid.
 *  4. **Unknown variables are loud and literal.** `{custmer}` prints as `{custmer}` *and* raises
 *     `UNKNOWN_VARIABLE`, because a typo silently repeated on 400 invoices is worse than a visible token. `{user}`
 *     and `{tenant}` are in the same bucket on purpose: they need the Auth Platform session, and this worker has no
 *     identity in its payload, so it cannot fill them honestly.
 *  5. **`skipFirstPage` is applied to the page list, not inside the drawing.** The first page is either stamped or it
 *     is not; a condition inside the program would still build an overlay page for it and still number it in
 *     `{total}`.
 *  6. **`differentFirstPage` replaces page one's bands, it does not merge with them.** A band left out of the
 *     override is a band page one does not carry — that is the only way to say "no footer on the cover", and it is
 *     what the option means everywhere else it appears. The override is keyed on **page one of the document** (the
 *     name says so), so a job that also sets `skipFirstPage` never draws it, and the metrics say `false` rather than
 *     silently applying it to page two.
 */

/** Above this many per-page overlay pages the job is refused rather than left to run past its budget. */
const PER_PAGE_OVERLAY_MAX = 2000;

/** The rule's thickness and colour are not options in the shipped surface; a hairline in the text colour reads right. */
const RULE_THICKNESS_PT = 0.5;

/** How far the rule sits from the band's baseline, as a share of the font size: clear of descenders, still attached. */
const RULE_GAP_RATIO = 0.45;

const MM_TO_PT = 72 / 25.4;

/** Variables the worker can resolve (`12-…` §2 minus the two that need a session). */
const KNOWN_VARIABLES = new Set(['page', 'total', 'pageXofY', 'date', 'datetime', 'time', 'filename', 'title']);

const VARIABLE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** One band, read from the schema rather than restated here: `header`, `footer` and the first-page override are one shape. */
type Band = NonNullable<HeaderFooterOptions['header']>;

/** A band together with where it sits and the anchors its zones use. */
interface BandEntry {
  position: 'header' | 'footer';
  band: Band;
  anchors: [OverlayAnchorKey, OverlayAnchorKey, OverlayAnchorKey];
  top: boolean;
}

export const headerFooter: Handler<HeaderFooterOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to decorate.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to decorate.' });
  }

  // Before the overlay is merged: the zones and rules are drawn into page content inside a signature's `/ByteRange`.
  const signature = await readSignatureRecord(document.path, runOpts);

  const stamped = resolveStampedPages(options.pages, pages, options.skipFirstPage);
  if (stamped.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: 'No page in this document matches that selection.',
    });
  }
  if (stamped.length > PER_PAGE_OVERLAY_MAX) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `Decorating ${stamped.length} pages in one job is above the limit of ${PER_PAGE_OVERLAY_MAX}. Split the document first.`,
    });
  }

  report({ progress: 15, phase: 'processing', message: 'Measuring pages.' });
  const boxes = await readPageBoxes(document.path, runOpts);
  const marginPt = options.marginMm * MM_TO_PT;

  // `{title}` is the document's metadata title with the file name as the fallback (`12-…` §2). Read once, not per
  // page: it is a property of the document, and an engine spawn per page would be the whole budget.
  const title = await documentTitle(document.path, document.name, runOpts);
  const filename = basename(document.name).replace(/\.[^.]+$/, '');
  const unknownVariables = new Set<string>();

  const date = new Date();
  const textFor =
    (pageNumber: number) =>
    (value: string): string =>
      value.replace(VARIABLE, (_match, key: string) => {
        if (!KNOWN_VARIABLES.has(key)) {
          unknownVariables.add(key);
          return `{${key}}`;
        }
        switch (key) {
          case 'page':
            return String(pageNumber);
          case 'total':
            return String(pages);
          case 'pageXofY':
            return `${pageNumber} of ${pages}`;
          case 'date':
            return date.toISOString().slice(0, 10);
          case 'datetime':
            return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
          case 'time':
            return date.toISOString().slice(11, 16);
          case 'filename':
            return filename;
          default:
            return title;
        }
      });

  const mainBands: BandEntry[] = [];
  if (options.header) {
    mainBands.push({
      position: 'header',
      band: options.header,
      anchors: ['top-left', 'top-center', 'top-right'],
      top: true,
    });
  }
  if (options.footer) {
    mainBands.push({
      position: 'footer',
      band: options.footer,
      anchors: ['bottom-left', 'bottom-center', 'bottom-right'],
      top: false,
    });
  }

  // Page one's bands (decision 6). `replace`, not `merge`: whichever bands the override leaves out are bands this
  // page does not carry. Nothing is drawn for a page that is not stamped, so `skipFirstPage` simply makes the
  // override unreachable — which the metrics report instead of leaving the caller to infer it.
  const alternate = options.differentFirstPage ?? null;
  const alternateApplies = alternate !== null && stamped.includes(1);
  const bandsFor = (pageNumber: number): BandEntry[] => {
    if (!alternateApplies || pageNumber !== 1) return mainBands;
    return mainBands
      .map((entry) => ({ ...entry, band: alternate[entry.position] }))
      .filter((entry): entry is BandEntry => entry.band !== undefined);
  };

  const font = resolvePostScriptFont('helvetica');
  if (!font) {
    throw new JobFailure('FONT_NOT_FOUND', {
      message: `This build cannot stamp with its own default font. Available: ${availablePostScriptFonts().join(', ')}.`,
    });
  }

  report({ progress: 45, phase: 'processing', message: `Building ${stamped.length} overlay page(s).` });
  const overlayPages: OverlayPage[] = stamped.map((pageNumber) => {
    const box = boxes[pageNumber - 1] ?? boxes[0]!;
    const text = textFor(pageNumber);
    const placements: OverlayPlacement[] = [];
    const rules: OverlayRule[] = [];

    for (const { band, anchors, top } of bandsFor(pageNumber)) {
      const color = hexToRgbTriplet(band.color);
      const zones: Array<[string | undefined, OverlayAnchorKey]> = [
        [band.left, anchors[0]],
        [band.center, anchors[1]],
        [band.right, anchors[2]],
      ];
      for (const [value, anchor] of zones) {
        if (!value) continue;
        placements.push({
          text: text(value),
          font,
          sizePt: band.fontSize,
          color,
          anchor,
          marginPt,
        });
      }
      if (band.rule) {
        // The rule sits on the *inner* side of its band: under a header's baseline, above a footer's. Both are
        // measured from the baseline the zone text uses, so the line and the words move together if either the
        // margin or the font size changes.
        const baseline = baselineFor(anchors[0], box.heightPt, band.fontSize, marginPt);
        const yPt = top
          ? baseline - RULE_GAP_RATIO * band.fontSize
          : baseline + band.fontSize * 1.35 + RULE_GAP_RATIO * band.fontSize;
        rules.push({
          yPt,
          fromPt: marginPt,
          toPt: box.widthPt - marginPt,
          color,
          thicknessPt: RULE_THICKNESS_PT,
        });
      }
    }

    return { widthPt: box.widthPt, heightPt: box.heightPt, placements, rules };
  });

  const overlayPath = join(workDir, 'header-footer-overlay.pdf');
  const textOverlay = await renderOverlayPdf(overlayPages, overlayPath, {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 120_000),
  });

  report({ progress: 75, phase: 'processing', message: 'Stamping the pages.' });
  const mergeMap = stamped.map((page, index) => ({ page, overlayPage: index + 1 }));
  // With a logo there are two passes, and the first one writes to `work/` rather than to the output: the second pass
  // reads the first one's result, and pointing a pikepdf merge at the file it is also reading is how a save ends up
  // racing its own input.
  const outputPath = join(outputDir, 'headered.pdf');
  const textMergedPath = options.logoFileId ? join(workDir, 'text-merged.pdf') : outputPath;
  const merged = await mergeOverlayPdf(document.path, overlayPath, textMergedPath, mergeMap, runOpts);

  let logo: { imageWidth: number; imageHeight: number; bytes: number } | null = null;
  if (options.logoFileId) {
    const attachment = files.find((file) => file.kind === 'attachment' && file.attachmentOption === 'logoFileId');
    if (!attachment) {
      throw new JobFailure('LOGO_REQUIRED', {
        message: 'The logo named by `logoFileId` was not part of this job.',
      });
    }
    const heightPt = options.logoHeightMm * MM_TO_PT;
    const logoOverlayPath = join(workDir, 'header-footer-logo.pdf');
    logo = await buildImageOverlayPdf(
      attachment.path,
      stamped.map((pageNumber) => {
        const box = boxes[pageNumber - 1] ?? boxes[0]!;
        // Vertically centred in the header band, so a tall logo and a short one both sit on the same line as the
        // header text rather than hanging from the page edge.
        const centreY = box.heightPt - marginPt - heightPt / 2;
        const centreX =
          options.logoPosition === 'left' ? marginPt + heightPt / 2 : box.widthPt - marginPt - heightPt / 2;
        return {
          widthPt: box.widthPt,
          heightPt: box.heightPt,
          imageHeightPt: heightPt,
          // Rotated images are not part of this tool's option surface; the watermark owns that.
          stamps: [{ x: centreX, y: centreY, rotationDeg: 0 }],
        };
      }),
      logoOverlayPath,
      { ...runOpts, timeoutMs: Math.min(runOpts.timeoutMs, 60_000) },
    );
    // Second pass: the bitmap cannot live in the font program, so it is merged after it (decision 3 above). The
    // opacity rides on this pass alone — the text bands are already in `textMergedPath`, and attenuating the whole
    // output to fade a logo is exactly the bug the two-pass split exists to avoid.
    await mergeOverlayPdf(textMergedPath, logoOverlayPath, outputPath, mergeMap, {
      ...runOpts,
      alpha: options.logoOpacity,
    });
  }

  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Decorating changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (unknownVariables.size > 0) {
    warnings.push({
      code: 'UNKNOWN_VARIABLE',
      detail: `Printed literally, because this build cannot resolve: ${[...unknownVariables].map((name) => `{${name}}`).join(', ')}.`,
    });
  }

  report({ progress: 95, phase: 'finalizing' });
  return {
    outputs: [{ name: 'headered.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      pagesStamped: stamped.length,
      pagesSkipped: outputPages - stamped.length,
      overlayPages: overlayPages.length,
      overlayBytes: textOverlay.bytes,
      overlaySeconds: textOverlay.seconds,
      mergeSeconds: merged.seconds,
      zones: overlayPages[0]?.placements.length ?? 0,
      rules: overlayPages[0]?.rules?.length ?? 0,
      marginMm: options.marginMm,
      skipFirstPage: options.skipFirstPage,
      differentFirstPage: alternateApplies,
      text: options.header?.center ?? options.footer?.center ?? null,
      hasHeader: Boolean(options.header),
      hasFooter: Boolean(options.footer),
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
      ...(logo
        ? {
            logo: {
              ...logo,
              position: options.logoPosition,
              heightMm: options.logoHeightMm,
              opacity: options.logoOpacity,
            },
          }
        : {}),
    },
    warnings,
    engine: { name: logo ? 'ghostscript+pikepdf' : 'ghostscript' },
  };
};

/** The anchors a band's three zones use. Kept as a subtype so the rule's baseline can be derived from it. */
type OverlayAnchorKey = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

/**
 * The baseline one zone draws on.
 *
 * Deliberately the same arithmetic as `placementGeometry` in the overlay module — the rule has to sit relative to the
 * text, and importing the module's own answer is the only way to keep them from drifting apart. The 0.8 cap height
 * for top anchors is that function's rule: a top margin positions the *text*, not its ascender line.
 */
function baselineFor(anchor: OverlayAnchorKey, pageHeightPt: number, sizePt: number, marginPt: number): number {
  return anchor.startsWith('bottom') ? marginPt : Math.max(marginPt, pageHeightPt - marginPt - sizePt * 0.8);
}

/** The document's metadata title, or null — `pdfinfo` is the cheapest reader of it and already in the image. */
async function documentTitle(path: string, fileName: string, opts: Parameters<typeof runPdfInfo>[1]): Promise<string> {
  const result = await runPdfInfo(['-enc', 'UTF-8', path], { ...opts, timeoutMs: Math.min(opts.timeoutMs, 20_000) });
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('Title:'));
  const value = line?.slice('Title:'.length).trim();
  return value && value.length > 0 ? value : basename(fileName).replace(/\.[^.]+$/, '');
}

/** Pages to decorate: the selection, minus the first page when asked, with the document refused if nothing is left. */
function resolveStampedPages(selection: string[] | undefined, pageCount: number, skipFirstPage: boolean): number[] {
  const requested =
    selection && selection.length > 0
      ? [...new Set(expandRanges(selection, pageCount).filter((page) => page <= pageCount))].sort((a, b) => a - b)
      : Array.from({ length: pageCount }, (_, index) => index + 1);
  return skipFirstPage ? requested.filter((page) => page !== 1) : requested;
}
