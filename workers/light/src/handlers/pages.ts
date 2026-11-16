import { join } from 'node:path';
import type { DeletePagesOptions, ExtractPagesOptions, ReorderPagesOptions } from '@pdftools/contracts/tools';
import { buildQpdfPagesArgs, decoratePageSelections, qpdfOrThrow, runQpdf } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, expandRanges } from '@pdftools/worker-shared';

/**
 * `extract-pages`, `delete-pages`, `reorder-pages` — `docs/03-ORGANIZE-ROTATE-CROP.md`.
 *
 * All three are the same operation with a different page list, so they share the argument builder here. Each one
 * expands its options into the explicit page list qpdf needs (`1-3,7,10-z`), which means the engine never has to
 * interpret a user's shorthand — the interpretation happens once, in code that has tests.
 *
 * The expansion itself lives in `@pdftools/worker-shared` (`page-ranges.ts`): the heavy pool's export tools need the
 * same rule, and a second copy of it is how two pools start disagreeing about what `1-3,7` means.
 *
 * `reorder-pages` deliberately does **not** restore the outline, and that is an open item rather than a decision:
 * see `docs/0-E2E-CHECKLIST.md`, pass 2 — the reordering tool belongs to the review of
 * `docs/03-ORGANIZE-ROTATE-CROP.md`, where what a renamed, reordered page should do to a bookmark chain is a
 * question about that doc. The two tools here are covered by `docs/02-SPLIT-AND-EXTRACT.md` §7 and are decorated.
 * Its input is also one file (`{ ...PDF }`), which is why the documented `insertPages` option is gone rather than
 * implemented: a second document cannot reach this handler (defect 138, `packages/contracts/src/tools/options.ts`).
 * And it decorates its output like the two selection tools do — a reordered report arrives with its bookmarks
 * remapped onto the new page numbers, where it used to arrive with none and no warning (defect 143).
 */

/**
 * The output's page list, and the warning when its bookmarks could not be lifted onto it.
 *
 * `extract-pages` and `delete-pages` are built with the same `qpdf --empty --pages` call as a split part, so they lose
 * the same two things: `/Outlines` is absent from the new catalog and `/Info` is empty. A user who keeps pages 4–20
 * of a report should not get an untitled document with no bookmarks, and the fix is the one the split handler uses.
 */
async function decorate(
  source: string,
  output: string,
  pages: number[],
  run: { cwd: string; timeoutMs: number; memoryMb: number; signal?: AbortSignal },
): Promise<{ entries: number; warnings: Array<{ code: string; detail?: string }> }> {
  const [result] = await decoratePageSelections([{ source, output, pages }], run);
  const warnings: Array<{ code: string; detail?: string }> = [];
  if (result?.error) {
    warnings.push({
      code: 'OUTPUT_NOT_DECORATED',
      detail: `The pages are correct, but the bookmarks and metadata could not be restored: ${result.error}`,
    });
  } else if (result?.metadataError) {
    warnings.push({
      code: 'METADATA_NOT_COPIED',
      detail: `The bookmarks were restored, but the document's metadata could not be: ${result.metadataError}`,
    });
  }
  return { entries: result?.outlineEntries ?? 0, warnings };
}

async function pageCount(path: string, cwd: string, timeoutMs: number): Promise<number> {
  const result = await runQpdf(['--show-npages', path], { cwd, timeoutMs: Math.min(timeoutMs, 30_000) });
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (result.code !== 0 || !Number.isFinite(value)) {
    throw new JobFailure('INVALID_FILE', { message: 'The PDF could not be read; its page count is unknown.' });
  }
  return value;
}

export const extractPages: Handler<ExtractPagesOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;
  report({ progress: 15, phase: 'processing' });

  const total = await pageCount(input, workDir, limits.timeoutSeconds * 1000);
  const requested = expandRanges(options.pages, total);

  // `mode: exclude` is expressed as "everything except these", which is where a per-page document becomes a
  // range list. Fail fast on an out-of-range page instead of silently returning an empty document.
  const outOfRange = requested.filter((page) => page > total);
  if (outOfRange.length > 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `This document has ${total} pages; page ${outOfRange[0]} does not exist.`,
    });
  }

  // The pages the output will hold, in the order it will hold them — which is what the decoration needs, not the
  // selector string: the two are the same list, and deduplicating and sorting it twice is how they could differ.
  let kept: number[];
  if (options.mode === 'include') {
    kept = dedupeAscending(requested);
  } else {
    kept = [];
    for (let page = 1; page <= total; page += 1) if (!requested.includes(page)) kept.push(page);
    if (kept.length === 0) {
      throw new JobFailure('VALIDATION_ERROR', { message: 'Removing those pages would leave an empty document.' });
    }
  }

  const outputPath = join(outputDir, 'extracted.pdf');
  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };
  await qpdfOrThrow(buildQpdfPagesArgs([{ path: input, range: kept.join(',') }], outputPath), runOpts);

  const outputPages = await pageCount(outputPath, workDir, limits.timeoutSeconds * 1000).catch(() => null);
  report({ progress: 90, phase: 'finalizing' });
  const restored = await decorate(input, outputPath, kept, runOpts);

  return {
    outputs: [{ name: 'extracted.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      inputPages: total,
      outputPages,
      mode: options.mode,
      outlineEntries: restored.entries,
    },
    warnings: restored.warnings,
    engine: { name: 'qpdf' },
  };
};

export const deletePages: Handler<DeletePagesOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;
  report({ progress: 15, phase: 'processing' });

  const total = await pageCount(input, workDir, limits.timeoutSeconds * 1000);
  const remove = new Set(expandRanges(options.pages, total));

  const keep: number[] = [];
  for (let page = 1; page <= total; page += 1) if (!remove.has(page)) keep.push(page);
  if (keep.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'Removing those pages would leave an empty document.' });
  }

  const outputPath = join(outputDir, 'trimmed.pdf');
  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };
  await qpdfOrThrow(buildQpdfPagesArgs([{ path: input, range: keep.join(',') }], outputPath), runOpts);
  report({ progress: 90, phase: 'finalizing' });
  const restored = await decorate(input, outputPath, keep, runOpts);

  return {
    outputs: [{ name: 'trimmed.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      inputPages: total,
      removed: total - keep.length,
      outputPages: keep.length,
      outlineEntries: restored.entries,
    },
    warnings: restored.warnings,
    engine: { name: 'qpdf' },
  };
};

/** The unique pages in ascending order — the order `qpdf --pages` writes them, so the label matches the file. */
function dedupeAscending(pages: number[]): number[] {
  return [...new Set(pages)].sort((a, b) => a - b);
}

export const reorderPages: Handler<ReorderPagesOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;
  report({ progress: 15, phase: 'processing' });

  const total = await pageCount(input, workDir, limits.timeoutSeconds * 1000);

  let order: number[];
  if (options.reverse) {
    order = [];
    for (let page = total; page >= 1; page -= 1) order.push(page);
  } else if (options.order?.length) {
    if (options.order.length !== total) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `Provide all ${total} page numbers in the new order, or none.`,
      });
    }
    const seen = new Set<number>();
    for (const page of options.order) {
      if (page < 1 || page > total || seen.has(page)) {
        throw new JobFailure('VALIDATION_ERROR', {
          message: 'The new page order must use every page exactly once.',
        });
      }
      seen.add(page);
    }
    order = options.order;
  } else {
    order = Array.from({ length: total }, (_, i) => i + 1);
  }

  //
  // A duplicate is placed **immediately after the page it copies**, which is what `03-ORGANIZE-ROTATE-CROP.md` §2.1 has
  // always promised ("page numbers to repeat immediately after themselves") and what this handler did not do: it
  // appended them, so `duplicate: [3]` on a six-page file came back `1,2,3,4,5,6,3` — measured with qpdf and
  // `pdftotext` before this changed. A copy at the end of the document is not a duplicate of anything the user can see;
  // it reads as the page having moved to the back, which is why "duplicate page 3" is the option's own label.
  //
  // `duplicate` is a **multiset**: its values are copies, so `[3,3]` asks for two of page 3 and both follow it. The
  // list is applied over the output order rather than over the source numbering, so `{ order: [3,1,2], duplicate: [3] }`
  // is `3,3,1,2` — the copy follows its page *where that page ended up*, which is the reading that keeps the two
  // options composing instead of contradicting.
  //
  const duplicated = options.duplicate?.filter((page) => page >= 1 && page <= total) ?? [];
  const copies = new Map<number, number>();
  for (const page of duplicated) copies.set(page, (copies.get(page) ?? 0) + 1);
  const pageList = order.flatMap((page) => Array.from({ length: 1 + (copies.get(page) ?? 0) }, () => page));

  const outputPath = join(outputDir, 'reordered.pdf');
  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  await qpdfOrThrow(buildQpdfPagesArgs([{ path: input, range: pageList.join(',') }], outputPath), runOpts);

  // The same two losses `extract-pages` and `delete-pages` decorate for, because it is the same command: `--empty`
  // builds a **fresh** document, so the output arrives with no `/Outlines` and an empty `/Info` (measured —
  // `qpdf --json --json-key=outlines` on the output prints `"outlines": []`). Reordering a report is exactly the
  // moment a reader looks in the bookmarks sidebar, and until pass 5 this handler decorated nothing and said nothing,
  // while its two siblings — built from the identical call — lifted the outline and warned when they could not.
  const decorated = await decorate(input, outputPath, pageList, runOpts);
  report({ progress: 90, phase: 'finalizing' });

  return {
    outputs: [{ name: 'reordered.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      inputPages: total,
      outputPages: pageList.length,
      duplicated: duplicated.length,
      outlineEntries: decorated.entries,
    },
    warnings: decorated.warnings,
    engine: { name: 'qpdf' },
  };
};
