import { copyFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MergeOptions } from '@pdftools/contracts/tools';
import { buildQpdfPagesArgs, countPdfPages, decorateMergedDocument, qpdfOrThrow, runQpdf } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { placeForEngine } from '@pdftools/worker-shared';
import type { Handler, JobContext } from '@pdftools/worker-shared';

/**
 * `merge` — `docs/01-MERGE.md`.
 *
 * One `qpdf --empty --pages …` invocation with every input in the user's order, then the two things that command
 * provably drops, rebuilt with pikepdf (`packages/engines/src/outlines.ts`): the outline tree and the first input's
 * metadata. qpdf is still the engine that merges — it copies page objects without re-encoding content, so the pages
 * are lossless and the cost is flat — but `--empty` assembles a *new* document, and "new document" is why a merge of
 * three bookmarked reports used to arrive with no bookmarks, no title, and no metadata at all.
 *
 * Argument order is the product, and it is made visible: each input is staged under a numeric prefix
 * (`001__report.pdf`) by `placeForEngine`, from the user's order rather than from upload order, so the command that
 * ran and the list on screen can be read against each other.
 *
 * Three checks stand between the engine and the delivered file, and they are why this is the reference tool:
 *
 *  1. the assembled document has to survive `qpdf --check` — a reproduction of the one failure a page-count check
 *     cannot see (a page tree that is the right size and structurally broken);
 *  2. the **final** artifact's page count has to equal the sum of the inputs', read after the decoration step rather
 *     than before it, because decoration is what writes the file the user receives;
 *  3. every declared output is verified to exist and be non-empty, as for every tool.
 *
 * A failure carries the **position** of the file it is about — "file 2 of 3 (annex.pdf)" — never the staging path it
 * happens to live at. The path is server state, names nothing the user chose, and is exactly what a passthrough of
 * qpdf's stderr would leak.
 */

export const merge: Handler<MergeOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  if (files.length < 2) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'Merging needs at least two files.' });
  }

  // The user's order wins when `order` names file ids; otherwise the upload order is the source of truth.
  const ordered: JobContext['files'] = options.order?.length
    ? [...files].sort((a, b) => {
        const ai = options.order!.indexOf(a.id);
        const bi = options.order!.indexOf(b.id);
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
      })
    : [...files];

  report({ progress: 12, phase: 'processing', message: `Merging ${ordered.length} documents.` });

  const placeDir = join(workDir, 'input');
  const placed = await Promise.all(ordered.map((file, index) => placeForEngine(file, index, placeDir)));
  const assembledPath = join(workDir, 'merged.assembled.pdf');
  const outputPath = join(outputDir, 'merged.pdf');

  const mode = options.bookmarks ?? 'keep';
  const warnings: Array<{ code: string; detail?: string }> = [];
  const metrics: Record<string, unknown> = { inputs: ordered.length };

  // The argument list comes from `buildQpdfPagesArgs`, which exists because three handlers built it by hand and all
  // three repeated `--pages` per input — rejected by qpdf as `unrecognized argument --pages`. The rule lives in one
  // function now, with a test, instead of in a comment at each call site.
  try {
    const result = await qpdfOrThrow(
      buildQpdfPagesArgs(
        placed.map((path) => ({ path })),
        assembledPath,
      ),
      {
        cwd: workDir,
        timeoutMs: limits.timeoutSeconds * 1000,
        memoryMb: limits.memoryMb,
        ...(signal ? { signal } : {}),
      },
    );
    metrics.qpdfMs = result.durationMs;
  } catch (error) {
    throw asInputFailure(error, ordered, workDir);
  }

  report({ progress: 45, phase: 'processing', message: 'Merged; rebuilding bookmarks and metadata.' });

  // 1. The assembled file is checked *before* anything is built on top of it: an error here is qpdf's, and saying so
  // with the half-finished artifact in hand is worth more than discovering it after decoration.
  const assembledCheck = await checkStructure(assembledPath, workDir, limits);
  if (assembledCheck.warning) {
    warnings.push({
      code: 'INPUT_REBUILT',
      detail: 'An input document needed structural repair to be merged; its content is intact.',
    });
  }

  // 2. Bookmarks and the first input's metadata. A failure here is a warning, not a failed job: the pages are
  // already correct, and refusing a correct merge because its bookmarks could not be rebuilt would trade a small
  // loss for a total one. The undecorated file is copied across in that case rather than leaving no output at all.
  const decorated = await decorateMergedDocument(
    {
      input: assembledPath,
      output: outputPath,
      sources: placed.map((path, index) => ({ path, name: basename(ordered[index]!.name) })),
      mode,
    },
    {
      cwd: workDir,
      timeoutMs: Math.min(limits.timeoutSeconds * 1000, 120_000),
      memoryMb: limits.memoryMb,
      ...(signal ? { signal } : {}),
    },
  );

  if (decorated.error) {
    await copyFile(assembledPath, outputPath);
    warnings.push({
      code: 'BOOKMARKS_APPROXIMATED',
      detail: `Bookmarks and metadata could not be rebuilt: ${decorated.error}`,
    });
  } else if (decorated.unresolved > 0) {
    warnings.push({
      code: 'BOOKMARKS_PARTIAL',
      detail: `${decorated.unresolved} bookmark destination(s) could not be mapped into the merged document and were dropped.`,
    });
  }
  // The two halves fail independently, and the metadata half is the one whose failure is invisible in a page count:
  // a merge that kept its bookmarks and lost its title looks finished.
  if (decorated.metadataError) {
    warnings.push({
      code: 'METADATA_NOT_CARRIED',
      detail: `The first input's metadata could not be copied onto the merged document: ${decorated.metadataError}`,
    });
  }

  metrics.bookmarks = mode;
  metrics.outlineEntries = decorated.outlineEntries;
  metrics.sourcesWithOutline = decorated.sourcesWithOutline;
  metrics.metadataCopied = decorated.metadataCopied;
  if (decorated.unresolved > 0) metrics.unresolvedBookmarkDestinations = decorated.unresolved;

  report({ progress: 78, phase: 'processing', message: 'Checking the result.' });

  // 3. The delivered file, not the intermediate one.
  await checkStructure(outputPath, workDir, limits);

  const knownInputPages = ordered.every((file) => file.pages != null);
  const expectedPages = knownInputPages ? ordered.reduce((total, file) => total + (file.pages ?? 0), 0) : null;
  const pages = await countPdfPages(outputPath, {
    cwd: workDir,
    timeoutMs: Math.min(limits.timeoutSeconds * 1000, 30_000),
    memoryMb: limits.memoryMb,
  });

  // `countPdfPages` answers 0 for a document it cannot read. Zero pages is not a merge result, so it fails here
  // rather than in an equality check whose message would name the wrong cause.
  if (pages === 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The merged document could not be opened to count its pages, so it was not kept.',
      stderrTail: 'qpdf --show-npages read no page count',
    });
  }

  metrics.outputPages = pages;
  if (expectedPages != null) metrics.inputPages = expectedPages;

  if (expectedPages != null && pages !== expectedPages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `The merged document has ${pages} pages where its ${ordered.length} inputs have ${expectedPages}.`,
      stderrTail: `expected ${expectedPages}, wrote ${pages}`,
    });
  }
  // The **plan's** ceiling (`planMaxPages`), which is what this message has always been about: `limits.maxPages` is the
  // tool's own cap from the catalog and is `0` for every tool in the registry, so the comparison this sentence describes
  // could not fire (defect 154). The job's inputs are measured before a handler runs (`runtime.ts` step 5), so this
  // second look is about the document this handler assembled rather than about the files it was given.
  if (limits.planMaxPages > 0 && pages > limits.planMaxPages) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `The merged document has ${pages} pages, above this plan's limit of ${limits.planMaxPages}.`,
    });
  }

  report({ progress: 92, phase: 'finalizing' });
  await rm(assembledPath, { force: true });

  return {
    // The name carries the user's intent, not the engine's: `--empty` writes a fresh document, so there is no input
    // name to inherit and a generic `merged.pdf` is the honest choice.
    outputs: [{ name: 'merged.pdf', mime: 'application/pdf', primary: true, pages: [1, pages] }],
    metrics,
    warnings,
    engine: { name: 'qpdf' },
  };
};

/**
 * `qpdf --check`, and whether its report mentions a repair.
 *
 * qpdf exits 0 on a file it had to reconstruct and says so in the report, which is worth surfacing rather than
 * swallowing: the exact case is an input whose own xref was broken and which qpdf rebuilt on the way in.
 */
async function checkStructure(
  path: string,
  workDir: string,
  limits: { timeoutSeconds: number; memoryMb: number },
): Promise<{ warning: boolean }> {
  const check = await runQpdf(['--check', path], {
    cwd: workDir,
    timeoutMs: Math.min(limits.timeoutSeconds * 1000, 60_000),
    memoryMb: limits.memoryMb,
  });
  const report = `${check.stdout}\n${check.stderr}`;
  if (check.code !== 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The merged document did not pass a structural check, so it was not kept.',
      stderrTail: report.trim().slice(0, 600),
    });
  }
  return { warning: /WARNING|damaged|reconstructed/i.test(report) };
}

/**
 * Turn a qpdf failure into something that names the file the user chose.
 *
 * qpdf reports the path it was handed, and both staged names carry the position: `001__annex.pdf` for an input that
 * reached the engine, `<uuid>.pdf` for one that never did (a failure during placement). Both are matched, in that
 * order, so the answer is the user's file position and not whichever string happened to come first.
 */
function asInputFailure(error: unknown, ordered: Array<{ name: string; path: string }>, workDir: string): JobFailure {
  const stderr = error instanceof JobFailure ? (error.stderrTail ?? '') : '';
  const evidence = `${stderr}\n${error instanceof Error ? error.message : ''}`;
  const index = locateInput(evidence, ordered);
  // The staged name is stripped from the sentence and kept in the tail (see `redactPaths`): "file 2 of 2
  // (merge-damaged.pdf): file is damaged" reads as a message, while `<work>/input/002__merge-damaged.pdf` reads as
  // somebody's disk. The position is already in the sentence, so nothing the user needs is lost by removing it.
  const reason = stripEnginePrefix(
    redactPaths(firstLine(stderr), workDir, { stripStaged: true }) ?? '',
    index == null ? null : ordered[index]!.name,
  );

  return new JobFailure('CONVERSION_FAILED', {
    ...(error instanceof JobFailure ? { engine: error.engine, exitCode: error.exitCode } : {}),
    message:
      index == null
        ? `The merge failed: ${reason || 'the engine did not accept the document list'}`
        : `The merge failed on file ${index + 1} of ${ordered.length} (${basename(ordered[index]!.name)}): ${
            reason || 'the document could not be read'
          }`,
    stderrTail: redactPaths(stderr || (error instanceof Error ? error.message : ''), workDir),
  });
}

/**
 * Drop qpdf's `WARNING: <file>: ` preamble, leaving the sentence that follows it.
 *
 * The file is already named by the position prefix the caller writes — `file 2 of 2 (merge-damaged.pdf)` — so keeping
 * the engine's copy of it produces `(merge-damaged.pdf): merge-damaged.pdf: file is damaged`, which reads as a bug in
 * the message rather than as a damaged file.
 */
function stripEnginePrefix(text: string, name: string | null): string {
  let out = text.replace(/^\s*WARNING:\s*/i, '');
  if (name) out = out.replace(new RegExp(`^\\s*${escapeRegExp(basename(name))}:\\s*`), '');
  return out.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which input the engine's message is about, by looking for the names that carry a position.
 *
 * `null` when the message names no input, which is the honest answer for a failure about the output or about the
 * command itself — inventing a position there would send the user to the wrong file.
 */
function locateInput(evidence: string, ordered: Array<{ name: string; path: string }>): number | null {
  for (const [index, file] of ordered.entries()) {
    const staged = `${String(index + 1).padStart(3, '0')}__`;
    if (evidence.includes(staged) || evidence.includes(basename(file.path))) return index;
  }
  return null;
}

/** The first line of an engine report is the sentence; the rest is the object dump that follows it. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

/**
 * Every absolute path in an engine message, replaced — the shape of the server's disk is not the user's business.
 *
 * `stripStaged` removes the `input/002__` prefix as well, which turns the path back into the name the user chose. It is
 * off for the tail and on for the sentence: the tail is what an operator reads when reconstructing what ran, and the
 * engine's own view of the staging directory is the most useful thing in it.
 */
function redactPaths(text: string, workDir: string, opts: { stripStaged?: boolean } = {}): string {
  const redacted = text
    .replaceAll(workDir, '<work>')
    .replaceAll(/\/var\/lib\/pdf-tools\/[^\s"':]+/g, '<staging>')
    .replaceAll(/\/tmp\/[^\s"':]+/g, '<tmp>');
  if (!opts.stripStaged) return redacted.slice(0, 600);
  return redacted.replaceAll(/(?:<work>\/|<staging>\/|<tmp>\/)?input\/\d+__/g, '').slice(0, 600);
}
