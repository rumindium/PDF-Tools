import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SignOptions } from '@pdftools/contracts/tools';
import {
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_IMAGE_MAX_PX,
  availableSignatureFonts,
  buildImageOverlayPdf,
  countPdfPages,
  mergeOverlayPdf,
  planSignaturePlacements,
  readPageBoxes,
  readSignatureRecord,
  readSignedText,
  renderOverlayPdf,
  resolveSignedAt,
  signatureFont,
  signatureImageOverlay,
  signatureInvalidatedWarning,
  signatureLines,
  signatureMetaOverlay,
  signatureTextOverlay,
  writeSignatureMetadata,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `sign` — `docs/14-SIGN-AND-FORMS.md`, heavy pool.
 *
 * This tool puts **ink** on the page and an honest record in the metadata. It does not create a digital signature,
 * and the three things that keep that from being a footnote are all in this handler:
 *
 *  1. **Every success carries `NOT_A_DIGITAL_SIGNATURE`.** The API response says it, not only the docs — a user who
 *     believes they have a cryptographically signed contract has been misled by omission.
 *  2. **The output is read back and what *this job* added is verified rather than intended.** A `/Sig` object, a
 *     `/ByteRange` or a `/Perms` entry that was not in the input fails the job, because a signature dictionary without
 *     a certificate produces documents some validators call "signature broken" — worse than an ink mark, and
 *     indistinguishable from the real thing on the page. The comparison is against the input and not against zero:
 *     measured in pass 9, the absolute form of this check made a document with an empty signature placeholder — the
 *     shape a contract to be signed actually has — impossible to sign at all (defect 165).
 *  3. **What was written is confirmed with a second engine.** The metadata is read back with pikepdf and the typed
 *     name with poppler's `pdftotext`; a name that merged but cannot be extracted is reported
 *     (`SIGNATURE_TEXT_NOT_FOUND`).
 *
 * Two builder kinds, and a job can use both: text is typeset by Ghostscript (only a typesetter can measure a face and
 * centre a string), a bitmap is assembled by pikepdf (placing one is matrix work). An image signature with the date
 * on is therefore **two overlays merged in sequence** — the image first, then the date line under it — rather than
 * either builder being asked to do the other's job.
 */

/** The document is whatever is not an attachment: the API resolves `imageFileId` into an `attachment` entry. */
export const signHandler: Handler<SignOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to sign.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to sign.' });
  }

  report({ progress: 15, phase: 'processing', message: 'Measuring the pages.' });
  const boxes = await readPageBoxes(document.path, runOpts);
  const plan = planSignaturePlacements(options.fields, boxes);

  // What the input already carried, read before a byte is written. Two facts come out of this read and both were
  // missing from the first version (defect 165, measured in pass 9): the invariant below has to be about what *this
  // tool* added rather than about the file's absolute vocabulary — otherwise a document with an empty signature
  // placeholder, which is what a contract to be signed looks like, could never be signed at all — and an input that
  // already carries a real signature is a signature this job's ink invalidates.
  const inputSignature = await readSignatureRecord(document.path, runOpts);

  const signedAt = resolveSignedAt(options.date, new Date());
  const lines = signatureLines({
    signature: options.signature ?? '',
    signerName: options.signerName,
    location: options.location,
    showSignerName: options.showSignerName,
    showDateStamp: options.showDateStamp,
    signedAt,
  });

  // The pages that get ink, ascending. The overlay builders group the same way, which is what makes
  // `overlayPage = index + 1` a fact rather than a coincidence; `signatures.ts` documents the coupling.
  const signedPages = [...new Set(plan.map((placement) => placement.page))].sort((a, b) => a - b);
  const mergeMap = signedPages.map((page, index) => ({ page, overlayPage: index + 1 }));
  const mergeOpts = { ...runOpts, timeoutMs: Math.min(runOpts.timeoutMs, 120_000) };

  let currentPath = document.path;
  let overlayBytes = 0;
  let overlaySeconds = 0;
  let mergeSeconds = 0;
  let imageSize: { imageWidth: number; imageHeight: number } | undefined;
  let font: string | null = null;

  if (options.kind === 'typed') {
    if (!options.signature) {
      throw new JobFailure('SIGNATURE_REQUIRED', {
        message: "kind: 'typed' needs `signature`: the name to render in the signature box.",
      });
    }
    font = signatureFont(options.font);
    if (!font) {
      throw new JobFailure('FONT_NOT_FOUND', {
        message: `"${options.font}" is not a signature face this build has. Available: ${availableSignatureFonts().join(', ')}.`,
      });
    }

    report({ progress: 35, phase: 'processing', message: 'Setting the signature in type.' });
    const overlayPath = join(workDir, 'signature-text.pdf');
    const overlay = await renderOverlayPdf(
      signatureTextOverlay(plan, lines, font, undefined, options.borderColor),
      overlayPath,
      mergeOpts,
    );
    overlayBytes += overlay.bytes;
    overlaySeconds += overlay.seconds;

    report({ progress: 55, phase: 'processing', message: 'Stamping the pages.' });
    const merged = await mergeOverlayPdf(
      document.path,
      overlayPath,
      join(workDir, 'signed-with-text.pdf'),
      mergeMap,
      mergeOpts,
    );
    mergeSeconds += merged.seconds;
    currentPath = join(workDir, 'signed-with-text.pdf');
  } else {
    const attachment = files.find((file) => file.kind === 'attachment' && file.attachmentOption === 'imageFileId');
    if (!attachment) {
      throw new JobFailure('IMAGE_REQUIRED', {
        message: `kind: '${options.kind}' needs the signature image named by \`imageFileId\` to be part of the job.`,
      });
    }

    // §6's size cap, checked before the image is placed rather than after: the file is about to be embedded in the
    // document, and a refusal here writes no output at all.
    const imageBytes = (await stat(attachment.path).catch(() => null))?.size ?? 0;
    if (imageBytes > SIGNATURE_IMAGE_MAX_BYTES) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `The signature image is ${(imageBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${SIGNATURE_IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
      });
    }

    report({ progress: 35, phase: 'processing', message: 'Placing the signature image.' });
    const overlayPath = join(workDir, 'signature-image.pdf');
    const built = await buildImageOverlayPdf(attachment.path, signatureImageOverlay(plan), overlayPath, mergeOpts);
    if (built.imageWidth > SIGNATURE_IMAGE_MAX_PX || built.imageHeight > SIGNATURE_IMAGE_MAX_PX) {
      // The pixel cap can only be read where the image is opened, which is what the builder just did.
      throw new JobFailure('VALIDATION_ERROR', {
        message: `The signature image is ${built.imageWidth}×${built.imageHeight} px; the limit is ${SIGNATURE_IMAGE_MAX_PX} px on either axis.`,
      });
    }
    overlayBytes += built.bytes;
    overlaySeconds += built.seconds;
    imageSize = { imageWidth: built.imageWidth, imageHeight: built.imageHeight };

    report({ progress: 50, phase: 'processing', message: 'Stamping the pages.' });
    const merged = await mergeOverlayPdf(
      document.path,
      overlayPath,
      join(workDir, 'signed-with-image.pdf'),
      mergeMap,
      mergeOpts,
    );
    mergeSeconds += merged.seconds;
    currentPath = join(workDir, 'signed-with-image.pdf');

    // The date and the signer name are text, and text never comes out of the bitmap builder — so a second overlay,
    // merged onto the first, in that order: the date has to land *next to* the signature, not under it.
    if (lines.meta) {
      font = signatureFont(options.font) ?? 'Helvetica';
      const metaOverlayPath = join(workDir, 'signature-meta.pdf');
      const metaOverlay = await renderOverlayPdf(
        signatureMetaOverlay(plan, lines, font, undefined, options.borderColor),
        metaOverlayPath,
        mergeOpts,
      );
      overlayBytes += metaOverlay.bytes;
      overlaySeconds += metaOverlay.seconds;

      const metaMerged = await mergeOverlayPdf(
        currentPath,
        metaOverlayPath,
        join(workDir, 'signed-with-meta.pdf'),
        mergeMap,
        mergeOpts,
      );
      mergeSeconds += metaMerged.seconds;
      currentPath = join(workDir, 'signed-with-meta.pdf');
    }
  }

  const subject = options.signerEmail
    ? `Signed by ${options.signerName ?? options.signature ?? 'a signer'} (${options.signerEmail})`
    : `Signed by ${options.signerName ?? options.signature ?? 'a signer'}`;
  const keywords = [
    `reason=${options.reason}`,
    `location=${options.location ?? 'unspecified'}`,
    `signed_at=${signedAt.toISOString()}`,
  ].join('; ');

  report({ progress: 75, phase: 'processing', message: 'Recording who signed, when and why.' });
  const outputPath = join(outputDir, 'signed.pdf');
  const metadata = await writeSignatureMetadata(currentPath, outputPath, { subject, keywords }, runOpts);

  report({ progress: 90, phase: 'finalizing', message: 'Reading the signed document back.' });
  const record = await readSignatureRecord(outputPath, runOpts);

  // The invariant this tool is built on, stated as a *difference* rather than as an absolute: if this job made the
  // output carry more signature vocabulary than the input had, it did something it does not advertise and cannot back
  // up with a certificate, so no output is better than that output. An absolute check would refuse every document
  // that arrived with a signature field or a signature on it — measured: the form fixture's empty placeholder failed
  // this job before the comparison existed, and signing a contract that already carries a signature is the ordinary
  // case, not a mistake.
  const addedObjects = record.signatureObjects - inputSignature.signatureObjects;
  const addedValues = record.signatureValues - inputSignature.signatureValues;
  const addedByteRange = record.byteRange && !inputSignature.byteRange;
  const addedPerms = record.perms && !inputSignature.perms;
  if (addedObjects > 0 || addedValues > 0 || addedByteRange || addedPerms) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Signing added ${addedObjects} signature object(s) and ${addedValues} signature value(s) to a document that had ${inputSignature.signatureObjects} and ${inputSignature.signatureValues} (byte range: ${inputSignature.byteRange} → ${record.byteRange}, perms: ${inputSignature.perms} → ${record.perms}); this tool writes an ink signature and never a signature dictionary.`,
    });
  }
  if (record.pages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Signing changed the page count: ${pages} in, ${record.pages} out.`,
    });
  }
  if (record.subject !== subject || record.keywords !== keywords) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The signature metadata did not read back the way it was written.',
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [
    {
      code: 'NOT_A_DIGITAL_SIGNATURE',
      detail:
        'This is a visible signature drawn onto the page with the signer, reason and time in the document metadata. It is not a cryptographic signature and cannot be verified against a certificate.',
    },
  ];
  // The other half of the same read: ink on a page changes the bytes an existing signature's `/ByteRange` covers, so a
  // document that arrived signed has a signature this job broke. The sentence is the shared one every tool that
  // rewrites a document uses, which is what keeps the list of such tools honest.
  const invalidatedSignature = signatureInvalidatedWarning(inputSignature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  const offPage = plan.filter((placement) => placement.offPage);
  if (offPage.length > 0) {
    warnings.push({
      code: 'SIGNATURE_OFF_PAGE',
      detail: `${offPage.length} placement(s) extend past the edge of their page and are clipped: page ${offPage
        .map((placement) => placement.page)
        .join(', ')}.`,
    });
  }

  let textMissing: string[] = [];
  if (options.kind === 'typed' && options.signature) {
    const wanted = [options.signature, ...(lines.meta ? [lines.meta] : [])];
    const read = await readSignedText(outputPath, wanted, runOpts);
    textMissing = read.missing;
    if (textMissing.length > 0) {
      warnings.push({
        code: 'SIGNATURE_TEXT_NOT_FOUND',
        detail: `poppler does not read these back from the signed page: ${textMissing
          .map((value) => JSON.stringify(value))
          .join(', ')}. The ink may still be visible; check the page before sending it on.`,
      });
    }
  }

  report({ progress: 97, phase: 'finalizing' });
  return {
    outputs: [{ name: 'signed.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: record.pages,
      pagesSigned: signedPages.length,
      placements: plan.length,
      kind: options.kind,
      ...(options.kind === 'typed'
        ? { font, fontFamily: options.font, signatureLength: (options.signature ?? '').length }
        : { ...(imageSize ?? {}) }),
      signerName: options.signerName ?? null,
      reason: options.reason,
      signedAt: signedAt.toISOString(),
      dateStamped: lines.meta !== null,
      border: options.borderColor ?? null,
      overlayBytes,
      overlaySeconds,
      mergeSeconds,
      metadataSeconds: metadata.seconds,
      // Read back from the file rather than assumed: the tool's honesty claim, in the same response as the output.
      // The counts are this job's *addition* — zero is the honest result — and the input's own numbers travel beside
      // them, so "nothing was added" cannot be confused with "the document had nothing".
      signatureObjects: addedObjects + addedValues,
      signatureValues: addedValues,
      inputSignatureObjects: inputSignature.signatureObjects,
      inputSignatureValues: inputSignature.signatureValues,
      inputUnsignedSignatureFields: inputSignature.unsignedSignatureFields,
      byteRange: record.byteRange,
      perms: record.perms,
      digitalSignature: false,
      textMissing: textMissing.length,
    },
    warnings,
    engine: { name: 'ghostscript+pikepdf' },
  };
};
