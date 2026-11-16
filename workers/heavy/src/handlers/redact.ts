import { join } from 'node:path';
import type { RedactOptions } from '@pdftools/contracts/tools';
import {
  applyRedactions,
  collectRedactedText,
  countPdfPages,
  planRedactionRegions,
  readPageBoxes,
  readRegionText,
  readSignatureRecord,
  removableTokens,
  searchableBytes,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `redact` — `docs/13-EDIT-AND-ANNOTATE.md`, heavy pool.
 *
 * The tool that removes content rather than covering it, and the only one in this build that **refuses to finish
 * without a verification pass**. The shape of this handler follows from that:
 *
 *  1. **What cannot be undone is detected first, before a byte is rewritten.** A signature dictionary in the input
 *     means any content change invalidates it, and the user is owed that sentence up front rather than in a result
 *     they have already sent on (`ELECTRONIC_SIGNATURE_INVALIDATED`).
 *  2. **Refusals happen before the engine starts.** A rectangle on a page that does not exist, one that lies entirely
 *     off the page, or more than 200 of them are coordinate mistakes, and the alternative to refusing is a job that
 *     reports success and erased nothing. A rectangle that only *partly* leaves the page is clipped and reported
 *     (`ELEMENT_OFF_PAGE`), because the user's mark is real and merely larger than the paper.
 *  3. **The absence is proved, not intended.** Two independent read-backs run on the file that was written: poppler's
 *     `pdftotext` limited to each rectangle, and a raw-and-inflated byte search for the tokens that occurred *only*
 *     inside the marked areas. That byte search also reads the file's `<hex>` strings, which is how a run the engine
 *     could not spell in the font's encoding is still searched rather than skipped. A rectangle whose text reads back
 *     identical to what was under it, or a token that is still findable anywhere in the file, fails the job with
 *     `CONVERSION_FAILED` — better to refuse than to hand back a document that looks safe and is not.
 *  4. **`removeContent: false` is a real branch, not a flag that is ignored.** The same engine path runs with the
 *     removals switched off, the box is painted either way (measured), and the job carries
 *     `REDACTION_NOT_REMOVED` plus a verification block that reports `textExtractable: true` — so visual-only masking
 *     can never be mistaken for a redaction.
 */
export const redactHandler: Handler<RedactOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to redact.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to redact.' });
  }

  // Before anything is rewritten. A signature is invalidated by *any* content change, and the point of reporting it
  // here rather than afterwards is that a user who still has the original can decide not to run this at all.
  report({ progress: 8, phase: 'processing', message: 'Checking what this would invalidate.' });
  const signature = await readSignatureRecord(document.path, runOpts);

  const boxes = await readPageBoxes(document.path, runOpts);
  const plan = planRedactionRegions(options.regions, boxes, options.fill);
  const heightOf = (page: number): number => boxes[page - 1]?.heightPt ?? 0;

  report({
    progress: 25,
    phase: 'processing',
    message: `Reading the text under ${plan.rectangles.length} marked area(s).`,
  });
  const before = await collectRedactedText(document.path, plan.rectangles, heightOf, runOpts);
  const tokens = removableTokens(
    before.document,
    before.regions.map((region) => region.text),
  );
  const regionText = new Map(before.regions.map((region) => [region.index, region.text]));
  const regionsWithText = before.regions.filter((region) => region.text.length > 0).length;

  report({ progress: 45, phase: 'processing', message: 'Removing the marked content.' });
  const outputPath = join(outputDir, 'redacted.pdf');
  const metrics = await applyRedactions(
    document.path,
    outputPath,
    plan.rectangles,
    heightOf,
    {
      removeContent: options.removeContent,
      removeMetadata: options.removeMetadata,
      removeAttachments: options.removeAttachments,
      scrubAnnotations: options.scrubAnnotations,
    },
    runOpts,
  );

  if (metrics.pages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Redacting changed the page count: ${pages} in, ${metrics.pages} out.`,
    });
  }

  report({ progress: 75, phase: 'finalizing', message: 'Reading the output back to prove it is gone.' });
  const poppler = await readRegionText(outputPath, plan.rectangles, heightOf, runOpts);
  const bytes = await searchableBytes(outputPath);
  const engineText = metrics.regionTextRemaining.map((region) => region.text).join('\n');
  const popplerText = poppler.map((region) => region.text).join('\n');

  // A removable token may not be findable anywhere: not in the text poppler reads, not in the text the writer's own
  // read-back reports, and not in the file's bytes or its inflated streams. Each haystack catches a different
  // failure — a text layer that was never rewritten, a rewrite that left an orphaned object.
  //
  // One exception, and it is the difference between a check and a false accusation: a job that was told to keep the
  // metadata, or the attachments, *asked* for the secret to stay in the file. The byte search covers those stores
  // too, so a token that was in a store the caller kept is excused from it — never from the page text, which is
  // removed unconditionally.
  const keptInBytes = (token: string): boolean =>
    (!options.removeMetadata && (before.metadata.docInfo.includes(token) || before.metadata.xmp.includes(token))) ||
    (!options.removeAttachments && before.metadata.attachments.includes(token));
  const leaks = tokens.filter(
    (token) =>
      engineText.includes(token) ||
      popplerText.includes(token) ||
      // `hex` as well as `raw` and `inflated`: a run written back as `<…>` is the same value in a different spelling,
      // and this tool's product is an absence — the one check that must not be able to miss it.
      (!keptInBytes(token) &&
        (bytes.raw.includes(token) || bytes.inflated.includes(token) || bytes.hex.includes(token))),
  );
  // The second signal, and the one that does not depend on the token filter at all: a rectangle whose text reads
  // back *identical* to what was under it was not touched. Measured on a job whose removal silently did nothing,
  // where the region came back character for character.
  const unchanged = poppler
    .filter((region) => {
      const wanted = regionText.get(region.index) ?? '';
      return wanted.length > 0 && region.text === wanted;
    })
    .map((region) => region.index);
  const textExtractable = leaks.length > 0 || unchanged.length > 0;

  const verification = {
    textExtractable: options.removeContent ? textExtractable : true,
    checkedRegionOnly: true,
    method:
      'pdftotext limited to each redacted rectangle, plus a raw, inflated and hex-decoded byte search for tokens that occurred only inside those rectangles',
    regionsChecked: plan.rectangles.length,
    regionsWithText,
    tokensChecked: tokens.length,
    rectsUnchanged: unchanged.length,
    rectsStillReadable: metrics.rectsStillReadable,
    textRemoved: tokens.length - leaks.length,
  };

  if (options.removeContent) {
    if (unchanged.length > 0) {
      const first = plan.rectangles.find((rectangle) => rectangle.index === unchanged[0]);
      throw new JobFailure('CONVERSION_FAILED', {
        message: `The content under ${unchanged.length} of ${plan.rectangles.length} marked area(s) is still in the output: rectangle ${unchanged[0]} on page ${first?.page} reads back exactly what was under it. Nothing was removed there, so the job is refused rather than returned.`,
      });
    }
    if (leaks.length > 0) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: `The removed content can still be found in the output: ${leaks
          .slice(0, 5)
          .map((token) => JSON.stringify(token))
          .join(
            ', ',
          )}${leaks.length > 5 ? `, and ${leaks.length - 5} more` : ''}. Either the text is still extractable or an object that held it survived the rewrite.`,
      });
    }
  }

  // The two metadata claims, each gated on *its own* option and deliberately outside the `removeContent` branch: a
  // job that only masks the page can still strip what described it. The first draft of this handler checked both
  // unconditionally, which made `removeAttachments: false` fail the job it was supposed to permit.
  if (options.removeMetadata && metrics.metadataSurvived.length > 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `The job asked for the metadata to be removed and the output still carries ${metrics.metadataSurvived.join(', ')}.`,
    });
  }
  if (options.removeAttachments && metrics.attachmentsRemaining > 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `The job asked for the attachments to be removed and ${metrics.attachmentsRemaining} are still embedded in the output.`,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];

  // Detected at the start of the job and reported with its result. `13-EDIT-AND-ANNOTATE.md` §4 asks for this before
  // the job runs; this build has no submit-time preflight endpoint, so the earliest honest place is here — before the
  // rewrite, but with the output the user must decide about. `§8` of that document records the difference.
  // The sentence itself is shared with the other four tools that rewrite a document (`signatureInvalidatedWarning`),
  // because a signature is invalidated by *any* content change and five handlers each phrasing that differently is
  // five chances to describe the same damage as two different things.
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }

  if (!options.removeContent) {
    warnings.push({
      code: 'REDACTION_NOT_REMOVED',
      detail:
        `\`removeContent: false\` paints the marked areas without removing what is under them. The text is still extractable, selectable and searchable — this is a visual mask, not a redaction. ${verification.textExtractable ? 'The verification block reports it as extractable.' : ''}`.trim(),
    });
  }

  if (metrics.annotationsRemoved > 0) {
    warnings.push({
      code: 'ANNOTATION_REMOVED',
      detail: options.scrubAnnotations
        ? `${metrics.annotationsRemoved} annotation(s) sat inside a redacted area and were deleted: a note or a highlight over removed content still shows it, and it is not covered by the box.`
        : `${metrics.annotationsRemoved} annotation(s) went with the content they sat on. \`scrubAnnotations: false\` was set, so the scrub step did not run and this is the rewrite's own doing — measured: it does not touch a highlight or a note, so with this option off the annotation stays in the file.`,
    });
  }

  // A marked page with no text layer at all. The pixels were painted over, but the rectangle is a *drawn* box rather
  // than an erasure, and a scan's original resolution is still underneath it — the user is owed that sentence.
  const imageOnlyPages = plan.pages.filter((page) => (before.pages[page - 1] ?? '').length === 0);
  if (imageOnlyPages.length > 0) {
    warnings.push({
      code: 'IMAGE_ONLY_PAGE',
      detail: `Page ${imageOnlyPages.join(', ')} ha(s) no text layer, so there was nothing extractable to remove; the marked areas are painted over instead. The pixels under them are still in the page image.`,
    });
  }

  if (plan.offPage > 0) {
    warnings.push({
      code: 'ELEMENT_OFF_PAGE',
      detail: `${plan.offPage} rectangle(s) extend past the edge of their page and were clipped to it: the part outside the page holds no content.`,
    });
  }

  report({ progress: 97, phase: 'finalizing' });
  return {
    outputs: [{ name: 'redacted.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: metrics.pages,
      pagesTouched: metrics.pagesTouched,
      regions: metrics.regions,
      regionsWithText,
      textRemoved: verification.textRemoved,
      imagesRemoved: metrics.imagesRemoved,
      graphicsRemoved: metrics.graphicsRemoved,
      annotationsRemoved: metrics.annotationsRemoved,
      attachmentsRemoved: metrics.attachmentsRemoved,
      fill: options.fill,
      removeContent: options.removeContent,
      removeMetadata: options.removeMetadata,
      removeAttachments: options.removeAttachments,
      scrubAnnotations: options.scrubAnnotations,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
      bytes: metrics.bytes,
      // The doc's response shape carries this beside the metrics; in this build it is where every other measured
      // number lives, and `13-EDIT-AND-ANNOTATE.md` §8 records that it did not become a top-level field.
      verification,
    },
    warnings,
    engine: { name: 'pymupdf+poppler' },
  };
};
