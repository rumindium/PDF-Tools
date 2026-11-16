import { join } from 'node:path';
import type { RemoveMetadataOptions } from '@pdftools/contracts/tools';
import {
  countPdfPages,
  pythonOrThrow,
  readSignatureRecord,
  runPdfInfo,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `remove-metadata` — `docs/05-OPTIMIZE-COMPRESS.md`.
 *
 * A PDF carries its identity in three separate places, and a tool that removes "the metadata" by deleting one of
 * them is worse than useless: it reports success and still ships the author's name.
 *
 *   1. the `/Info` dictionary — Title, Author, Subject, Keywords, Creator, plus the `/Producer` every writer adds;
 *   2. an XMP `/Metadata` stream — a second copy, written by a different producer, and the one that survives
 *      `/Info` deletion in most documents;
 *   3. embedded files — `/Names /EmbeddedFiles` on the catalog, and per-page `/FileAttachment` annotations, which
 *      are where a "print to PDF" of an email quietly keeps the original `.eml`.
 *
 * All three are removed unless `keep` names them. qpdf's CLI cannot touch any of them (it has no notion of an
 * `/Info` entry), so this runs through pikepdf, which edits the object graph directly — the same bridge the overlay
 * module uses, with values passed as JSON on argv rather than concatenated into a command line.
 *
 * One deliberate ordering detail: the XMP stream is removed *after* pikepdf's own metadata handling is told not to
 * rewrite it, because `pikepdf.save()` syncs `/Info` and XMP by default — a sync after deletion would put back
 * exactly what was removed.
 */

/** Keys pikepdf/qpdf write on save regardless of the input; nothing a user can see, but they are not metadata. */
const PRODUCER_KEYS = new Set(['Producer']);

export const removeMetadata: Handler<RemoveMetadataOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to clean.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  const keep = new Set(options.keep);
  if (options.keep.length === 3) {
    // Worth refusing rather than running: "remove everything, but keep everything" is a contradiction, and a job
    // that silently does nothing looks like success in every report.
    throw new JobFailure('VALIDATION_ERROR', {
      message: '`keep` lists every metadata store, which would leave the document unchanged. Remove an entry.',
    });
  }

  // Before the rewrite. A signature's `/ByteRange` covers the whole file, `/Info` included, so stripping the metadata
  // from a signed contract invalidates the signature — and a job that reported success without saying so is how a
  // user ends up sending it on believing the signature still stands.
  const signature = await readSignatureRecord(document.path, runOpts);

  report({ progress: 30, phase: 'processing', message: 'Removing document metadata.' });

  const outputPath = join(outputDir, 'cleaned.pdf');
  const result = await pythonOrThrow(
    CLEAN_SCRIPT,
    {
      input: document.path,
      output: outputPath,
      keep: [...keep],
    },
    runOpts,
  );

  let report_: Record<string, number> = {};
  try {
    report_ = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, number>;
  } catch {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The cleaning pass did not report what it removed.',
      stderrTail: result.stdout,
    });
  }

  report({ progress: 80, phase: 'processing', message: 'Re-reading the result.' });
  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Removing metadata changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  // Independent confirmation, from a different engine than the one that wrote the file: `pdfinfo` reads `/Info`
  // and the XMP packet through poppler's own parser, so a field that survived in a form pikepdf did not notice is
  // still caught. Only run when `/Info` was *meant* to go — asking for it to be kept and then warning that it is
  // still there would report success and alarm in the same job.
  const remaining = keep.has('docinfo') ? [] : await remainingInfoKeys(outputPath, runOpts);

  report({ progress: 95, phase: 'finalizing' });
  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (remaining.length > 0) {
    warnings.push({
      code: 'METADATA_PARTIALLY_REMOVED',
      detail: `These /Info keys survived the rewrite: ${remaining.join(', ')}`,
    });
  }

  return {
    outputs: [{ name: 'cleaned.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      docinfoRemoved: report_.docinfoRemoved ?? 0,
      xmpRemoved: report_.xmpRemoved ?? 0,
      attachmentsRemoved: report_.attachmentsRemoved ?? 0,
      kept: [...keep],
      remainingInfoKeys: remaining,
      // The vocabulary, and how much of it is a signature rather than an empty placeholder — the pair the warning is
      // gated on, so a caller who sees the warning reported can see what it was gated on.
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: 'pikepdf' },
  };
};

/** `pdfinfo` was already used by the header-footer handler; here it is the second opinion on `/Info`. */
async function remainingInfoKeys(path: string, opts: Parameters<typeof runPdfInfo>[1]): Promise<string[]> {
  const result = await runPdfInfo(['-enc', 'UTF-8', path], { ...opts, timeoutMs: Math.min(opts.timeoutMs, 20_000) });
  return result.stdout
    .split('\n')
    .map((line) => line.slice(0, line.indexOf(':')))
    .filter((key) => /^(Title|Author|Subject|Keywords|Creator|Producer)$/.test(key))
    .filter((key) => !PRODUCER_KEYS.has(key));
}

/**
 * The cleaning pass, as one Python program.
 *
 * `pikepdf.save()` is asked for `object_stream_mode='generate'` so the saved file is compact, and the attachment
 * walk covers both the name tree and the per-page annotations — a `/FileAttachment` on page 3 is invisible to the
 * name tree and is exactly where a leaked source file hides.
 */
const CLEAN_SCRIPT = `
import json, sys, pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
keep = set(payload['keep'])
pdf = pikepdf.open(payload['input'])

removed = {'docinfoRemoved': 0, 'xmpRemoved': 0, 'attachmentsRemoved': 0}

# Deleting the trailer's /Info reference removes the whole dictionary in one step. Calling docinfo.clear() looks
# like the natural spelling and is not: on this pikepdf the accessor is an Object, and clear() raises
# "cannot clear object of type dictionary". Removing the reference leaves keys() empty instead.
if 'docinfo' not in keep:
    removed['docinfoRemoved'] = len(pdf.docinfo)
    if '/Info' in pdf.trailer:
        del pdf.trailer.Info

if 'xmp' not in keep:
    for candidate in [pdf.Root] + [page.obj for page in pdf.pages]:
        if '/Metadata' in candidate:
            del candidate.Metadata
            removed['xmpRemoved'] += 1

if 'attachments' not in keep:
    names = pdf.Root.get('/Names')
    if names is not None and '/EmbeddedFiles' in names:
        del names.EmbeddedFiles
        removed['attachmentsRemoved'] += 1
    for page in pdf.pages:
        annots = page.obj.get('/Annots')
        if annots is None:
            continue
        keepers = []
        for annot in annots:
            if annot.get('/Subtype') == '/FileAttachment':
                removed['attachmentsRemoved'] += 1
            else:
                keepers.append(annot)
        page.obj.Annots = pikepdf.Array(keepers)

# open_metadata() is deliberately not used: it rewrites both stores on save, which would undo the deletions above.
pdf.save(payload['output'], object_stream_mode=pikepdf.ObjectStreamMode.generate, compress_streams=True)
print(json.dumps(removed))
`;
