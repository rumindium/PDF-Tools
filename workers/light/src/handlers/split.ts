import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import type { SplitOptions } from '@pdftools/contracts/tools';
import {
  type BookmarkNode,
  type PageSelection,
  buildQpdfPagesArgs,
  decoratePageSelections,
  qpdfOrThrow,
  readOutline,
  readPageSizes,
  runQpdf,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler, OutputDescriptor } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `split` — `docs/02-SPLIT-AND-EXTRACT.md`.
 *
 * Every output is produced by one `qpdf --pages` invocation over an explicit page list, so a split never re-encodes
 * content and a 1 000-page document splits in under a second. Part names are zero-padded (`part-01.pdf`) because the
 * behaviour people expect — lexicographic sorting in a file manager — otherwise puts `part-10.pdf` between
 * `part-01.pdf` and `part-02.pdf`.
 *
 * All four modes are planned the same way — as **explicit page lists, one list per output** — and then emitted by one
 * loop. That is what makes them comparable: whatever produced the plan, the parts are written by the same code, carry
 * the same names, and are covered by the same output verification. Two modes compute their plan from the document
 * rather than from the caller (`by-size` packs by measured page weight, `by-bookmarks` follows the outline), and both
 * are read through `@pdftools/engines` (`pdf-structure.ts`) rather than by a second parser here.
 *
 * `by-size` is the one mode whose *plan can be wrong*: page weight is estimated from content streams, while the file
 * the user receives also carries what qpdf re-writes around them. So a part is measured after it is written and
 * shrunk by one page until it fits — which turns "target size" from an intention into a property the job can be held
 * to, and the only case it cannot satisfy (one page heavier than the whole target) is reported as a warning instead of
 * being silently ignored.
 *
 * The parts are decorated after the loop, in one process: `qpdf --empty --pages` assembles a **new** document, so
 * every part comes back with no `/Outlines` and an empty `/Info` — the fact `merge` was fixed for (defect 117), in the
 * tool that hands the user the most files. `decoratePageSelections` lifts each part's own bookmarks onto its own page
 * numbers and carries the source's metadata, and `mergeOutputs` is decorated from the same source with the
 * concatenated page list rather than from the parts, so the merged file gets the original outline back rather than a
 * flattened or per-part-nested one.
 */

const MAX_OUTPUT_PARTS = config.limits.maxSplitParts;

export const split: Handler<SplitOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;

  const run = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  report({ progress: 10, phase: 'processing' });

  const totalPages = await pageCount(input, workDir, limits.timeoutSeconds * 1000);
  const plan = await planGroups(options, totalPages, input, run);

  if (plan.groups.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'Provide at least one page group to split by.' });
  }
  if (plan.groups.length > MAX_OUTPUT_PARTS) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `That would produce ${plan.groups.length} files; one job can produce at most ${MAX_OUTPUT_PARTS}.`,
    });
  }

  const outputs: OutputDescriptor[] = [];
  const partPaths: string[] = [];
  const warnings: Array<{ code: string; detail?: string }> = [...plan.warnings];
  const metrics: Record<string, unknown> = { inputPages: totalPages, mode: options.mode, parts: plan.groups.length };

  // A queue rather than a `for … of`, because `by-size` may hand a page back to the next part while it is being
  // emitted: shrinking part N is exactly growing part N+1, and doing it in place keeps the plan and the files in step
  // without a second pass over the document.
  const queue = plan.groups.map((pages) => [...pages]);
  for (let index = 0; index < queue.length; index += 1) {
    const pages = queue[index]!;
    const name = `part-${String(index + 1).padStart(2, '0')}.pdf`;
    const target = join(outputDir, name);

    report({
      progress: 15 + Math.round((index / queue.length) * 70),
      phase: 'processing',
      message: `Writing part ${index + 1} of ${queue.length}.`,
    });

    if (plan.targetBytes == null) {
      await emit(input, pages, target, run);
    } else {
      let bytes = await emit(input, pages, target, run);
      while (bytes > plan.targetBytes && pages.length > 1) {
        const moved = pages.pop()!;
        const next = queue[index + 1];
        if (next) next.unshift(moved);
        else queue.push([moved]);
        report({
          progress: 15 + Math.round((index / queue.length) * 70),
          phase: 'processing',
          message: `Part ${index + 1} was over target; moved page ${moved} into the next part.`,
        });
        bytes = await emit(input, pages, target, run);
      }
      if (bytes > plan.targetBytes) {
        warnings.push({
          code: 'PART_ABOVE_TARGET_SIZE',
          detail: `Part ${index + 1} is a single ${formatMb(bytes)}, above the ${formatMb(plan.targetBytes)} target — one page cannot be split.`,
        });
      }
    }

    partPaths.push(target);
    outputs.push({ name, mime: 'application/pdf', pages });
  }

  // `mergeOutputs` is the "split, then hand me one document" case — useful when the split was a re-pagination. The
  // parts are deliberately dropped from the result: the caller asked for one file, and `parts.zip` would be a second,
  // half-useful copy of the same bytes.
  //
  // Assembled from the *source* with the concatenated page list, not from the parts: re-cutting what was just cut is
  // the same pages by a longer route, and it is also the only way the merged file can be given the document's own
  // outline, since the parts' outlines are per-part views of it. (The repeated-`--pages` mistake this branch hid until
  // defect 118 was fixed when `buildQpdfPagesArgs` became the single place that knows the argument shape.)
  const mergeOutputs = options.mergeOutputs && partPaths.length > 1;
  const mergedPath = mergeOutputs ? join(outputDir, 'split.pdf') : null;
  const concatenated = outputs.flatMap((output) => output.pages ?? []);
  if (mergedPath) {
    await qpdfOrThrow(buildQpdfPagesArgs([{ path: input, range: concatenated.join(',') }], mergedPath), run);
    report({ progress: 90, phase: 'finalizing' });
  }

  // One interpreter for every file this job produced. `error` is a warning rather than a failure on purpose: a part
  // whose pages are right and whose bookmarks are missing is a usable file, and refusing the whole job would trade a
  // small loss for a total one.
  const selections: PageSelection[] = outputs.map((output, index) => ({
    source: input,
    output: partPaths[index]!,
    pages: output.pages ?? [],
  }));
  if (mergedPath) selections.push({ source: input, output: mergedPath, pages: concatenated });

  const decorated = await decoratePageSelections(selections, run);
  let outlineEntries = 0;
  let metadataCopied = 0;
  for (const [index, result] of decorated.entries()) {
    const label = mergedPath && index === decorated.length - 1 ? 'split.pdf' : `part ${index + 1}`;
    outlineEntries += result.outlineEntries;
    if (result.metadataCopied) metadataCopied += 1;
    if (result.error) {
      warnings.push({
        code: 'OUTPUT_NOT_DECORATED',
        detail: `${label} was split correctly, but its bookmarks and metadata could not be restored: ${result.error}`,
      });
    } else if (result.metadataError) {
      warnings.push({
        code: 'METADATA_NOT_COPIED',
        detail: `${label} carries its bookmarks, but the source's metadata could not be copied: ${result.metadataError}`,
      });
    }
  }

  const withDecoration = { ...metrics, outlineEntries, partsWithMetadata: metadataCopied };
  report({ progress: 95, phase: 'finalizing' });

  if (mergedPath) {
    return {
      outputs: [{ name: 'split.pdf', mime: 'application/pdf', primary: true }],
      metrics: { ...withDecoration, outputs: 1, mergeOutputs: true },
      warnings,
      engine: { name: 'qpdf' },
    };
  }

  // With one part there is nothing to choose between; marking it primary keeps `GET /download` deterministic.
  outputs[0]!.primary = true;
  report({ progress: 92, phase: 'finalizing' });

  return { outputs, metrics: withDecoration, warnings, engine: { name: 'qpdf' } };
};

/** One output file, from an explicit page list. The single place that runs the engine for this tool. */
async function emit(
  input: string,
  pages: number[],
  target: string,
  run: { cwd: string; timeoutMs: number; memoryMb: number; signal?: AbortSignal },
): Promise<number> {
  await qpdfOrThrow(buildQpdfPagesArgs([{ path: input, range: pages.join(',') }], target), run);
  const info = await stat(target).catch(() => null);
  return info?.size ?? 0;
}

interface Plan {
  /** One 1-based page list per output file, in output order. */
  groups: number[][];
  /** Set only for `by-size`: the byte ceiling each emitted part has to satisfy. */
  targetBytes?: number;
  warnings: Array<{ code: string; detail?: string }>;
}

/** Turn the mode plus its arguments into the plan — explicit page lists, and the ceiling that applies to them. */
async function planGroups(
  options: SplitOptions,
  totalPages: number,
  input: string,
  run: { cwd: string; timeoutMs: number; memoryMb: number; signal?: AbortSignal },
): Promise<Plan> {
  if (options.mode === 'ranges') {
    const ranges = options.ranges ?? [];
    if (ranges.length === 0) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: 'List the page ranges to split into — one group per output file.',
      });
    }
    const groups = ranges.map((group) => {
      const pages = expandRanges(group, totalPages);
      assertWithinDocument(pages, totalPages);
      return dedupe(pages);
    });
    if (groups.some((group) => group.length === 0)) {
      throw new JobFailure('VALIDATION_ERROR', { message: 'One of the ranges is empty.' });
    }
    return { groups, warnings: [] };
  }

  if (options.mode === 'every-n') {
    const size = options.everyNPages;
    if (!size || size < 1) {
      throw new JobFailure('VALIDATION_ERROR', { message: 'Choose how many pages each part should contain.' });
    }
    const groups: number[][] = [];
    for (let start = 1; start <= totalPages; start += size) {
      const end = Math.min(start + size - 1, totalPages);
      const pages: number[] = [];
      for (let page = start; page <= end; page += 1) pages.push(page);
      groups.push(pages);
    }
    return { groups, warnings: [] };
  }

  if (options.mode === 'by-size') {
    const targetBytes = Math.round((options.bySizeMb ?? 0) * 1024 * 1024);
    if (!targetBytes) {
      throw new JobFailure('VALIDATION_ERROR', { message: 'Choose a target size in MB.' });
    }
    const sizes = await readPageSizes(input, run);
    if (sizes.length !== totalPages) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: 'The pages of this document could not be measured consistently with its page count.',
        stderrTail: `measured ${sizes.length}, counted ${totalPages}`,
      });
    }
    return { groups: packBySize(sizes, targetBytes), targetBytes, warnings: [] };
  }

  // by-bookmarks
  const depth = options.byBookmarks === 'all' ? Number.POSITIVE_INFINITY : options.byBookmarks === 'level2' ? 2 : 1;
  const outline = await readOutline(input, run);
  if (outline.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: 'This document has no bookmarks to split by. Choose page ranges or every N pages instead.',
    });
  }
  const { groups, warnings } = groupsFromOutline(outline, depth, totalPages);
  if (groups.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: 'None of this document’s bookmarks has a page destination, so there is nothing to split by.',
    });
  }
  return { groups, warnings };
}

/**
 * Greedy packing, in page order, that never splits a page.
 *
 * A page heavier than the whole target becomes a part of its own: the alternative is to drop it or to emit a part
 * twice the size the user asked for, and both are worse than a part that is honestly over target (the handler reports
 * that as a warning once it has measured the file).
 */
function packBySize(sizes: number[], targetBytes: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let currentBytes = 0;

  for (const [index, size] of sizes.entries()) {
    const page = index + 1;
    if (current.length > 0 && currentBytes + size > targetBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(page);
    currentBytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * One part per bookmark, each running to the page before the next one starts.
 *
 * Two decisions the plan makes explicit, because both change what the user receives:
 *
 *  - **Pages before the first bookmark are their own part.** A document whose first chapter starts on page 3 has a
 *    cover and a contents page that belong to no bookmark; dropping them would make "split by bookmarks" lose pages.
 *    The invariant the suite checks is therefore *parts partition the document* — no page missing, none duplicated —
 *    rather than "one part per bookmark";
 *  - **entries that share a page with the next one produce no part**, because their range is empty. A nested fixture
 *    where "Chapter 1" and "Section 1.1" both start on page 2 has one span there, not two.
 */
function groupsFromOutline(
  outline: BookmarkNode[],
  depth: number,
  totalPages: number,
): { groups: number[][]; warnings: Array<{ code: string; detail?: string }> } {
  const entries: Array<{ title: string; page: number }> = [];
  const walk = (nodes: BookmarkNode[], level: number) => {
    for (const node of nodes) {
      if (level <= depth && node.page != null) entries.push({ title: node.title, page: node.page });
      walk(node.children, level + 1);
    }
  };
  walk(outline, 1);

  // Document order, and a destination may repeat; the first entry at a page owns the span that starts there.
  entries.sort((a, b) => a.page - b.page);

  const groups: number[][] = [];
  const warnings: Array<{ code: string; detail?: string }> = [];
  const first = entries[0]?.page ?? 1;
  if (first > 1) {
    groups.push(range(1, first - 1));
    warnings.push({
      code: 'PART_BEFORE_FIRST_BOOKMARK',
      detail: `Pages 1–${first - 1} come before the first bookmark and were made their own part, so no page is lost.`,
    });
  }

  for (const [index, entry] of entries.entries()) {
    const next = entries[index + 1]?.page;
    const end = next == null ? totalPages : next - 1;
    if (entry.page > end) continue;
    groups.push(range(entry.page, end));
  }
  return { groups, warnings };
}

function range(from: number, to: number): number[] {
  const pages: number[] = [];
  for (let page = from; page <= to; page += 1) pages.push(page);
  return pages;
}

function dedupe(pages: number[]): number[] {
  return [...new Set(pages)];
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function assertWithinDocument(pages: number[], totalPages: number): void {
  const beyond = pages.filter((page) => page > totalPages);
  if (beyond.length > 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `This document has ${totalPages} pages; page ${beyond[0]} does not exist.`,
    });
  }
}

async function pageCount(path: string, cwd: string, timeoutMs: number): Promise<number> {
  const result = await runQpdf(['--show-npages', path], { cwd, timeoutMs: Math.min(timeoutMs, 30_000) });
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (result.code !== 0 || !Number.isFinite(value)) {
    throw new JobFailure('INVALID_FILE', { message: 'The PDF could not be read.' });
  }
  return value;
}
