import { PageRangeError, expandPageSpecs } from '@pdftools/contracts/tools';

/**
 * The page plan: what the current options would do to the one document on screen
 * (`docs/0-UI-DESIGN.md` §3.2, `docs/02-SPLIT-AND-EXTRACT.md` §2).
 *
 * The tool page's preview used to be a picture of the *input*. For the thirteen tools whose options decide which pages
 * are used — split, extract, delete, rotate, crop, n-up, watermark, the exporters — that picture is the wrong one: the
 * thing a person wants to check before pressing Run is not "is this my document" but **"which pages are going where"**,
 * and until this module existed the only way to find out was to run the job and open the output.
 *
 * So the preview follows the options, and this is the arithmetic behind it:
 *
 *  - **`groups` are the outputs, one entry each.** For `split` that is literally one file per group: one per range
 *    row, or one per N pages, exactly as the worker plans them (`workers/light/src/handlers/split.ts`, `planGroups`) —
 *    the same grammar (`expandPageSpecs`, one implementation for all three layers), the same one-file-per-row reading.
 *  - **`remaining` is what no output contains.** A range list does not have to cover the whole document, so the pages
 *    it leaves out are worth naming: silently dropping them is how a person discovers the omission in the zip.
 *    `nextRange` is the same fact turned into an action — the spec that fills the first gap, which is what the
 *    "add a range" button writes.
 *  - **`note` is for the plans that cannot be finished here.** `by-size` packs by measured page weight and
 *    `by-bookmarks` follows the document's outline; both are decided inside the job, from the file, so the preview
 *    says so instead of inventing a split. That is a *note*, not an error: the options are valid, the plan is simply
 *    not knowable until the file is read.
 *  - **`error` is a spec this build refuses**, in the user's terms, and it is the reason the Run button can stay
 *    enabled: the API is still the authority, and this is a preview of what it will say.
 *
 * Nothing here renders. It is the plan the preview draws and the tests assert, which is why it is a plain function.
 */

export interface PlanGroup {
  /** The pages in this output, ascending and deduplicated, 1-based. */
  pages: number[];
  /** What to call it: the spec as the user wrote it, or how the pages were computed. */
  label: string;
}

export interface PagePlan {
  /** One entry per output file, in the order the outputs are produced. */
  groups: PlanGroup[];
  /** The pages of the document that no group contains, ascending. */
  remaining: number[];
  /** Pages the options *name* — drawn as the affected pages when the output is the whole document. */
  selected: number[];
  /**
   * Whether this plan **parts the document in two** — the pages the output keeps, and the pages it drops — and which
   * way the option's own value is spelled.
   *
   * `'keeps'` for `extract-pages` in `include` mode (the selection *is* the output), `'removes'` for the same tool in
   * `exclude` mode and for `delete-pages` (the selection is what the output leaves out), and `null` for every other
   * shape: a split's groups are outputs of their own, and a tool that keeps every page has nothing to drop.
   *
   * It exists so the preview can draw the two halves **and** let a page be moved between them with a click, without
   * re-deriving the direction from the option key — a second derivation is exactly how the form and the preview would
   * come to disagree about which way round the same `["2","5-9"]` is being read (`features/page-plan/index.tsx`).
   */
  selection: 'keeps' | 'removes' | null;
  /**
   * The two sides of the document, page by page, whenever `selection` says it has two sides and the page count is
   * known — `null` otherwise.
   *
   * Stated rather than left to the renderer, because the renderer would derive it by guessing: `kept` is not always
   * `groups[0].pages` and `removed` is not always `remaining` once the selection is empty, and the two tools that draw
   * these halves spell the same `["2","5-9"]` in opposite directions. Here the question "is page 4 in the output?" is
   * answered once, by the same arithmetic that produces the job's page list, and a click simply moves a page from one
   * array to the other.
   *
   * `kept` and `removed` always partition the document: together they are every page, once each.
   */
  halves: { kept: number[]; removed: number[] } | null;
  /** What the plan cannot say yet, in the user's terms, or `null` when it says everything. */
  note: string | null;
  /** A selection this build refuses, in the user's terms, or `null`. */
  error: string | null;
}

/**
 * Options this module reads. A subset of every tool's schema, because it reads across tools — and open-ended, because the
 * caller hands it the whole form: a key this module does not know about is not an error, it is an option it draws no
 * opinion about, and typing it as a closed record would make every new option a compile error here for no gain.
 */
export interface PlanValues {
  [key: string]: unknown;
  mode?: unknown;
  ranges?: unknown;
  everyNPages?: unknown;
  pages?: unknown;
  mergeOutputs?: unknown;
}

const EMPTY: PagePlan = {
  groups: [],
  remaining: [],
  selected: [],
  selection: null,
  halves: null,
  note: null,
  error: null,
};

/**
 * How a tool's options map onto outputs.
 *
 * Spelled out rather than inferred, because the same option key means three different things across the catalogue and
 * a preview that guessed would be confidently wrong: `pages` on `rotate` names the pages to turn (**the output is
 * still every page**), on `extract-pages` it names the pages to keep (**the output is those pages**), and on
 * `delete-pages` the pages to remove (**the output is the rest**).
 */
type PlanShape =
  /** One output per option group (`split`'s range rows, or every N pages). */
  | 'per-group'
  /** The output is the selection; everything else is left behind. */
  | 'selection'
  /** The output is the complement of the selection. */
  | 'inverted'
  /** The output is the whole document; the selection says which pages the options act on. */
  | 'whole';

const SHAPES: Record<string, PlanShape> = {
  split: 'per-group',
  'extract-pages': 'selection',
  'delete-pages': 'inverted',
  'reorder-pages': 'whole',
};

function shapeFor(toolId: string): PlanShape {
  return SHAPES[toolId] ?? 'whole';
}

/**
 * The tools whose worker **refuses** a page beyond the document's length, as opposed to keeping the pages that exist.
 *
 * Two readings of the same grammar, and the document draws the line itself (`02-SPLIT-AND-EXTRACT.md` §2): `split`
 * refuses `1-99` on a twelve-page file with the real count, while the tools that stamp pages simply act on the pages
 * that are there. `extract-pages` is on the refusing side — its check runs **before** it looks at `mode`, so a keep and
 * a removal are refused alike — and `delete-pages` is not, because subtracting a page that does not exist subtracts
 * nothing (`workers/light/src/handlers/pages.ts`).
 *
 * Named per tool rather than derived from the shape on purpose: the shape says what the output is, and this says what
 * the worker does with a mistake, and the two are independent — `extract-pages`'s shape is `selection` in one mode and
 * inverted output in the other, and it refuses in both.
 */
const REFUSES_OUT_OF_RANGE = new Set(['extract-pages']);

/** The option key a page-selecting tool uses, in the order they are tried. */
function selectionKey(values: PlanValues): 'ranges' | 'pages' | null {
  if (Array.isArray(values.ranges)) return 'ranges';
  if (Array.isArray(values.pages)) return 'pages';
  // An empty selection is the normal state of a fresh form: "every page" is what the API does with it, and the
  // preview has to show the same thing rather than nothing.
  return null;
}

function asSpecs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map((e) => e.trim());
}

function asGroups(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => asSpecs(row)).filter((row) => row.length > 0);
}

/** Ascending, deduplicated — what an output's page list actually is. */
function normalize(pages: number[]): number[] {
  return [...new Set(pages)].sort((left, right) => left - right);
}

/**
 * A range of pages as compactly as it can be written: `1–5`, `3`, `1–3, 7, 9–11`.
 *
 * The same shape the composition strip uses for one input's span, because the two are read next to each other: a group
 * header that said `1,2,3,4,5` beside a strip that said `1–5` would look like two different facts.
 */
export function describePages(pages: readonly number[]): string {
  if (pages.length === 0) return '—';
  const parts: string[] = [];
  let start = pages[0]!;
  let previous = start;
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = page;
    previous = page;
  }
  parts.push(start === previous ? `${start}` : `${start}–${previous}`);
  return parts.join(', ');
}

/**
 * What a group's header says *besides* its label: the pages the label resolved to, or nothing when it resolves to
 * itself.
 *
 * A group carries both on purpose — the label is what the user asked for (`4-z`), and the page list is what that turned
 * out to be (`4–12`), which is the one thing a preview can say that the form cannot. But for a literal range the two are
 * the same text, so `1-3` was printed twice on one line (`Output · 1-3 · 1–3`), and a header that repeats itself reads as
 * two facts that happen to agree rather than as one — the reader has to check whether they differ. Hidden when the
 * *text* agrees and not when the numbers do, because the label is prose: `Pack by weight` resolves to `1–12` and must
 * still show it, and `1-3, 7` is printed by the label exactly as the page list prints it.
 *
 * The comparison owns the punctuation the two come from: `describePages` writes an en dash and joins with `, `, while a
 * raw spec joins with `,` and is typed with a hyphen. Normalising both is what keeps this from hiding a note that is
 * subtly different, or from showing one that is not.
 */
export function resolvedPagesNote(label: string, pages: readonly number[]): string | null {
  if (pages.length === 0) return null;
  const note = describePages(pages);
  return sameText(label, note) ? null : note;
}

/**
 * Whitespace-free and dash-free, so `1-3, 7` and `1–3, 7` are the same text and `1-4` and `1–3` are not.
 *
 * Whitespace is **removed** rather than folded to a dash: the two sides differ in spacing because one is a typed spec and
 * one is prose (`describePages` joins with `, `), and turning a space into a hyphen would also make `1 2` and `1-2`
 * agree — which is the one kind of difference this must not swallow.
 */
function sameText(left: string, right: string): boolean {
  const fold = (value: string) => value.replace(/\s+/g, '').replace(/[\u2010-\u2015\u2212-]+/g, '-');
  return fold(left) === fold(right);
}

/**
 * The pages an `every-n` plan produces, one group per part.
 *
 * Walks the document the same way the worker does (`start += size`, last part clipped) so the preview's last part is
 * short exactly when the job's is.
 */
function everyN(size: number, pageCount: number): PlanGroup[] {
  const groups: PlanGroup[] = [];
  for (let start = 1; start <= pageCount; start += size) {
    const end = Math.min(start + size - 1, pageCount);
    const pages: number[] = [];
    for (let page = start; page <= end; page += 1) pages.push(page);
    groups.push({ pages, label: `${start}–${end}` });
  }
  return groups;
}

function expand(specs: string[], pageCount: number | null): number[] {
  try {
    return expandPageSpecs(specs, pageCount ?? undefined);
  } catch (cause) {
    // Exactly one failure is expected here and it is not an error the user made: a spec that needs the document's
    // length (`1-z`, `even`, `odd`) before the probe has answered. A malformed spec is *not* swallowed — it is
    // re-thrown for `pagePlan`, where it becomes the visible error beside the field.
    if (pageCount == null && cause instanceof PageRangeError && cause.message.includes('page count')) return [];
    throw cause;
  }
}

/**
 * The plan for the current options.
 *
 * `pageCount` is the number the API probed at upload, or `null` while that is still in flight. Everything that can be
 * answered without it is answered anyway, so the preview fills in as the user types rather than waiting on a round trip.
 */
export function pagePlan({
  toolId,
  values,
  pageCount,
}: {
  toolId: string;
  values: PlanValues;
  pageCount: number | null;
}): PagePlan {
  const shape = shapeFor(toolId);
  const total = pageCount != null && pageCount > 0 ? pageCount : null;
  const allPages = total == null ? [] : Array.from({ length: total }, (_, index) => index + 1);

  try {
    if (shape === 'per-group') return splitPlan(values, total, allPages);
    return singleOutputPlan(toolId, shape, values, total, allPages);
  } catch (cause) {
    if (cause instanceof PageRangeError) {
      return { ...EMPTY, error: cause.message, note: total == null ? unknownCountNote(toolId, values) : null };
    }
    throw cause;
  }
}

function unknownCountNote(toolId: string, values: PlanValues): string | null {
  if (toolId === 'split' && values.mode === 'ranges') {
    return 'Waiting for the page count before this plan can be drawn — the ranges as written are still what will be sent.';
  }
  return 'Waiting for the page count before the pages can be drawn.';
}

function splitPlan(values: PlanValues, total: number | null, allPages: number[]): PagePlan {
  const mode = typeof values.mode === 'string' ? values.mode : 'ranges';

  if (mode === 'every-n') {
    const size =
      typeof values.everyNPages === 'number' && values.everyNPages >= 1 ? Math.floor(values.everyNPages) : 10;
    if (total == null) return { ...EMPTY, note: unknownCountNote('split', values) };
    const groups = everyN(size, total);
    return {
      groups,
      remaining: [],
      selected: [],
      selection: null,
      halves: null,
      // "At most", because the last part is the remainder: eight pages by three is `3, 3, 2`, and a note that reads
      // "3 files of 3 pages each" is a sentence the preview can see is false while it is writing it.
      note: groups.length > 1 ? `${groups.length} files, none larger than ${size} pages.` : null,
      error: null,
    };
  }

  if (mode === 'by-size') {
    return {
      groups: [{ pages: allPages, label: 'Pack by weight' }],
      remaining: [],
      selected: [],
      selection: null,
      halves: null,
      note: 'Parts are packed from each page’s measured weight, so the number of files is decided during the job.',
      error: null,
    };
  }

  if (mode === 'by-bookmarks') {
    return {
      groups: [{ pages: allPages, label: 'Follow the outline' }],
      remaining: [],
      selected: [],
      selection: null,
      halves: null,
      note: 'One file per bookmark at the level you chose, decided from the document’s own outline during the job.',
      error: null,
    };
  }

  // `ranges`: one output per row, which is exactly what the worker does with the same value.
  const rows = asGroups(values.ranges);
  if (rows.length === 0) {
    return {
      groups: [],
      remaining: allPages,
      selected: [],
      selection: null,
      halves: null,
      note: 'Add a range to make an output file.',
      error: null,
    };
  }

  const groups = rows.map((row) => ({ pages: normalize(expand(row, total)), label: row.join(', ') }));
  const covered = new Set(groups.flatMap((group) => group.pages));
  const remaining = allPages.filter((page) => !covered.has(page));

  if (values.mergeOutputs === true) {
    // `mergeOutputs` reassembles the parts into one file, in row order, so the plan's outputs stop being files. The
    // preview says that once instead of drawing N groups that will not exist.
    const merged = normalize(groups.flatMap((group) => group.pages));
    return {
      groups: [{ pages: merged, label: 'Merged back into one file' }],
      remaining,
      selected: [],
      selection: null,
      halves: null,
      note: 'The parts are merged back into a single file, in the order of the rows.',
      error: null,
    };
  }

  if (total != null && groups.some((group) => group.pages.length === 0)) {
    return { ...EMPTY, groups, remaining, error: 'One of the ranges selects no page of this document.' };
  }

  return {
    groups,
    remaining,
    selected: [],
    selection: null,
    halves: null,
    note:
      total == null
        ? unknownCountNote('split', values)
        : remaining.length === 0
          ? null
          : `${remaining.length} page${remaining.length === 1 ? '' : 's'} in no output.`,
    error: null,
  };
}

function singleOutputPlan(
  toolId: string,
  shape: PlanShape,
  values: PlanValues,
  total: number | null,
  allPages: number[],
): PagePlan {
  const key = selectionKey(values);
  const specs = key ? asSpecs(values[key]) : [];
  const named = specs.length > 0 ? normalize(expand(specs, total)) : [];
  const hasSelection = named.length > 0;
  //
  // The two ways this option is read, in one place: a tool that keeps every page (`rotate`) has nothing to drop, and a
  // tool whose option *is* its output (`extract-pages`) is read by its own `mode`. The preview draws the two halves of
  // the document from this, and a click moves a page between them — so it is stated once, here, rather than derived
  // again by the renderer.
  //
  // `extract-pages` reads its selection as "keep these" or "drop these", and the same key means both.
  const inverted = shape === 'inverted' || (shape === 'selection' && values.mode === 'exclude');
  const selection: PagePlan['selection'] = shape === 'whole' ? null : inverted ? 'removes' : 'keeps';

  //
  // The mistake a preview is uniquely able to catch: a page this document does not have. It is not a drawing problem —
  // the tile for page 99 of a twelve-page file would be a rectangle with a glyph in it, and the plan beside it would
  // read `Output · 99` — it is the *job* refusing, and the sentence is the worker's own wording so the preview and the
  // refusal cannot describe the same mistake two ways. Nothing is drawn with it: a plan that cannot run is not a plan
  // to look at, and the alert under the file is where the count is stated (the message carries it).
  //
  if (total != null && REFUSES_OUT_OF_RANGE.has(toolId)) {
    const beyond = named.find((page) => page > total);
    if (beyond != null) {
      return { ...EMPTY, error: `This document has ${total} pages; page ${beyond} does not exist.` };
    }
  }
  if (total == null) {
    // Before the count: what the user named explicitly is already drawable, and everything that is defined by the
    // document's length is not. For a tool whose output is *the rest* (`delete-pages`) there is nothing to draw at all,
    // and saying so is better than drawing the pages that were just asked to be removed.
    const outputs = shape === 'whole' || shape === 'selection' ? named : [];
    return {
      groups: outputs.length > 0 ? [{ pages: outputs, label: specs.join(', ') }] : [],
      remaining: [],
      selected: named,
      selection,
      // No halves before the count: which pages a removal leaves behind is the count's answer, and drawing the two
      // sides from a guess is the one thing this preview exists to prevent.
      halves: null,
      note: 'The rest of the plan appears once the page count is known.',
      error: null,
    };
  }

  const outputs = inverted
    ? allPages.filter((page) => !named.includes(page))
    : shape === 'selection'
      ? named
      : allPages;

  //
  // A removal that would take every page: `extract-pages` in `exclude` mode and `delete-pages` both refuse it, in these
  // words, and both refuse it for the same reason — an empty PDF is never a useful output
  // (`workers/light/src/handlers/pages.ts`; `02-SPLIT-AND-EXTRACT.md` §3.2). Without this the plan drew one output with
  // **no pages in it**, and the preview labelled that empty list `pages unknown` — a sentence that means "the count
  // has not arrived", which is a different thing and, here, not true.
  //
  if (inverted && total != null && named.length > 0 && outputs.length === 0) {
    return { ...EMPTY, error: 'Removing those pages would leave an empty document.' };
  }

  const kept = new Set(outputs);
  const remaining = allPages.filter((page) => !kept.has(page));
  // For a tool that keeps every page, "what is left out" and "what is untouched" are different sets: nothing is left
  // out of a rotate, and the pages the selection does not name are still in the output — they are simply not turned.
  const untouched = allPages.length - named.length;

  return {
    groups: [
      {
        pages: outputs,
        // The label is about the *option*, not about the arithmetic: it is what the user typed, and the count beside
        // it is what it adds up to.
        label: hasSelection ? specs.join(', ') : 'Every page',
      },
    ],
    remaining,
    selected: hasSelection ? named : allPages,
    selection,
    // The two sides, only where the tool has two: a rotate keeps every page, so its "removed" half would be an empty
    // section claiming a decision nobody made. Drawn from `outputs` rather than from the selection, so `kept` means the
    // same thing for both directions — the pages that will be in the file.
    halves: selection == null ? null : { kept: outputs, removed: remaining },
    note:
      hasSelection && shape === 'whole'
        ? `The other ${untouched} page${untouched === 1 ? '' : 's'} stay as they are.`
        : null,
    error: null,
  };
}

/**
 * The spec that fills the first gap in a range list — what "add a range" writes.
 *
 * Explicitly the **first run of pages in no row**, so the button is a continuation of the work rather than a blank
 * field: after `1-5` it offers `6-12`, after `1-5` and `7-8` it offers `6` and then `9-z`, and once every page is
 * covered it returns `null` and the button says so instead of adding an empty row.
 *
 * `N-z` when the page count is unknown, which is the grammar's own "to the end" and the only honest spelling before the
 * document has been counted — writing `6-12` from a guess would be a wrong answer delivered confidently.
 */
export function nextRange(groups: readonly string[][], pageCount: number | null): string | null {
  const covered = resolvedPages(groups, pageCount);

  if (pageCount != null) {
    for (let page = 1; page <= pageCount; page += 1) {
      if (covered.has(page)) continue;
      // Walk the run out, so a gap of several pages is offered as one range rather than one page at a time — and a gap
      // of exactly one page is offered as a page, because `6-6` is a range nobody writes.
      let end = page;
      while (end + 1 <= pageCount && !covered.has(end + 1)) end += 1;
      return end > page ? `${page}-${end}` : `${page}`;
    }
    // Every page of the document is already in a row.
    return null;
  }

  // Without the count, only the pages named by explicit specs are known, and anything after them runs to the end — the
  // one spelling that stays right whatever the document turns out to be.
  const highest = covered.size > 0 ? Math.max(...covered) : 0;
  for (let page = 1; page <= highest + 1; page += 1) {
    if (!covered.has(page)) return `${page}-z`;
  }
  return `${highest + 1}-z`;
}

/**
 * The pages a set of rows names, as far as they can be resolved right now.
 *
 * A spec that needs the document's length (`1-z`, `even`, `odd`) is **skipped** while it is unknown, and so is one this
 * build refuses. Both are deliberate: the alternative — treating an unresolvable spec as covering nothing, or as
 * covering everything — makes the "which pages are left" arithmetic wrong in one direction or the other, so this
 * answers only what it actually knows and the caller's `pageCount` state is what decides the rest.
 */
function resolvedPages(rows: readonly string[][], pageCount: number | null): Set<number> {
  const pages = new Set<number>();
  for (const row of rows) {
    const specs = row.filter((spec) => spec.trim() !== '');
    if (specs.length === 0) continue;
    try {
      for (const page of expandPageSpecs(specs, pageCount ?? undefined)) pages.add(page);
    } catch {
      // A spec this build cannot resolve contributes nothing — see the note above.
    }
  }
  return pages;
}

/** How many pages of a document a set of valid rows already covers, for the "all pages covered" state. */
export function coveredCount(groups: readonly string[][], pageCount: number | null): number {
  if (pageCount == null) return 0;
  const covered = resolvedPages(groups, pageCount);
  let count = 0;
  for (let page = 1; page <= pageCount; page += 1) if (covered.has(page)) count += 1;
  return count;
}

/** Whether every page of the document is named by at least one row — the "nothing left to add" state. */
export function fullyCovered(groups: readonly string[][], pageCount: number | null): boolean {
  return pageCount != null && pageCount > 0 && coveredCount(groups, pageCount) >= pageCount;
}
