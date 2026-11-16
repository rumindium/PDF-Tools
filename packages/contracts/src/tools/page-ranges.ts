/**
 * The page-selection grammar — `docs/02-SPLIT-AND-EXTRACT.md` §2.
 *
 * One grammar, in one place, because three layers spell it and they must not disagree: the API schema
 * (`./options.ts`, `PageRange`), the web form (`apps/web/src/features/tool-shell/options-panel.tsx`), and the
 * workers' expansion (`workers/shared/src/page-ranges.ts`).
 *
 * It used to live in two of those layers as a literal copy of one regex, and both copies knew a **subset** of what
 * this document has described since the plan was written: `4-z`, `even` and `odd` were refused at the door with
 * "Use a page or a range, e.g. 1-5 or 7" while §2, §3.1, §4 and §8 of the tool's own doc are written in them. The
 * third layer had a hand-written parser that recognised the same subset, so nothing in the build could notice —
 * the only thing that would have was a case written in the documented grammar.
 *
 * A spec is one of:
 *
 * ```text
 * "7"        a page
 * "1-5"      an inclusive range
 * "10-z"     from page 10 to the last page ("z" = last, so a range never needs to know the count)
 * "even"     every even page
 * "odd"      every odd page
 * ```
 *
 * A *selection* is an array of specs (`["2", "5-9", "12"]`), which is what every option in the registry takes. The
 * expansion is the product's, not the engine's: qpdf is handed an explicit page list (`1,2,3,7`) because
 * interpreting a user's shorthand inside the engine is how two tools end up disagreeing about what `1-3,7` means.
 */

/**
 * One page spec. Anchored, so `"1-2-3"` and `"1-"` are refused rather than half-read.
 *
 * `"1-"` matters: it *looks* like "from 1 to the end" and a lenient parser would silently read it as the single page
 * 1, which is a wrong answer delivered confidently. The documented spelling for that is `1-z`.
 */
export const PAGE_RANGE_PATTERN = /^(?:\d+(?:-\d+)?|\d+-z|even|odd)$/;

/** The largest number of pages one spec may cover, so `1-99999999` is refused instead of expanded. */
const MAX_PAGES_PER_SPEC = 5000;

/** Whether a user-typed spec is one this build understands. Shared with the form so a typo is caught before submit. */
export function isPageRangeToken(value: string): boolean {
  return PAGE_RANGE_PATTERN.test(value);
}

/**
 * A spec that is malformed, counts backwards, or names a page the document does not have.
 *
 * Its own type rather than a plain `Error` because the worker layer turns exactly this into a
 * `VALIDATION_ERROR` with the message the user reads, and has to let anything else (a bug) surface as itself.
 */
export class PageRangeError extends Error {}

/**
 * Expand specs into the explicit, 1-based page list an engine can take.
 *
 * `pageCount` is required by exactly the specs that cannot be resolved without it (`N-z`, `even`, `odd`) and ignored
 * by the rest, because a tool that has already counted its pages always has it and a tool measuring something else
 * should not have to fetch it to accept `1-3`.
 *
 * Ranges are **not** clamped here: `1-99` on a 20-page document expands to 99 pages and the caller decides. That is
 * deliberate and load-bearing — `split` refuses it with the real page count (`§2`: "a page beyond the document
 * length is rejected with the count in the message") while `watermark` and the exporters keep the pages that exist,
 * and both readings need the same expansion. A spec that resolves to *nothing* is different: `9-z` on a 5-page
 * document has no reasonable reading at all, so it is refused here with the count.
 */
export function expandPageSpecs(specs: readonly string[], pageCount?: number): number[] {
  const pages: number[] = [];

  for (const spec of specs) {
    if (typeof spec !== 'string' || !PAGE_RANGE_PATTERN.test(spec)) {
      throw new PageRangeError(`"${spec}" is not a page range. Use a page (7), a range (1-5), 10-z, even, or odd.`);
    }

    if (spec === 'even' || spec === 'odd') {
      const count = requirePageCount(spec, pageCount);
      for (let page = spec === 'even' ? 2 : 1; page <= count; page += 2) pages.push(page);
      continue;
    }

    const [startRaw, endRaw] = spec.split('-') as [string, string | undefined];
    const start = Number.parseInt(startRaw, 10);

    if (endRaw === 'z') {
      const count = requirePageCount(spec, pageCount);
      if (count < start) throw new PageRangeError(`This document has ${count} pages; page ${start} does not exist.`);
      for (let page = start; page <= count; page += 1) pages.push(page);
      continue;
    }

    const end = endRaw ? Number.parseInt(endRaw, 10) : start;

    if (start < 1 || end < 1) {
      throw new PageRangeError(`"${spec}" is not a page range; pages are numbered from 1.`);
    }
    if (end < start) {
      throw new PageRangeError(`"${spec}" counts backwards. Write the smaller page first, like ${end}-${start}.`);
    }
    if (end - start + 1 > MAX_PAGES_PER_SPEC) {
      throw new PageRangeError(`"${spec}" covers more pages than one job allows (${MAX_PAGES_PER_SPEC}).`);
    }
    for (let page = start; page <= end; page += 1) pages.push(page);
  }

  return pages;
}

function requirePageCount(spec: string, pageCount: number | undefined): number {
  if (pageCount == null || !Number.isFinite(pageCount)) {
    throw new PageRangeError(`"${spec}" needs the document's page count, which is not known yet.`);
  }
  return pageCount;
}
