import { type OptionsUiField, expandPageSpecs, isPageRangeToken } from '@pdftools/contracts/tools';
import { nextRange } from '../page-plan/plan';

/**
 * The arithmetic behind the page-selection rows — `extract-pages` and `delete-pages`
 * (`apps/web/src/features/tool-shell/page-rows.tsx`, `docs/02-SPLIT-AND-EXTRACT.md` §3.2).
 *
 * The value these two tools take is a flat `string[]`: a *selection*, not a set of outputs. So a row here is not a
 * file — it is **one decision**, and the rows are the list of decisions, which is the difference between this control
 * and `split`'s (`range-rows.tsx`, one row per output file). Two kinds of decision are worth a row of their own:
 *
 *  - a **page** — one box, because there is nothing to join it to;
 *  - a **range** — two boxes, with the hyphen drawn rather than typed, and an empty `To` meaning *one page* so the
 *    half-typed `4-` the grammar refuses is unrepresentable rather than merely rejected.
 *
 * The expansion is `expandPageSpecs`, imported from the contracts package rather than re-implemented: the form, the API
 * and the worker have to agree about what `1-3, 7` means, and the way that agreement breaks is a second parser.
 *
 * Nothing here renders, which is why it is a plain module with tests beside it: the sentence this control says about
 * its own value is the part a user acts on, and a sentence is exactly the thing that goes wrong silently.
 */

/** One decision: a page (`to` empty) or a range. `kind` is what the row draws, and it survives an empty box. */
export interface PageRow {
  id: number;
  kind: 'page' | 'range';
  from: string;
  to: string;
}

/** A fresh row of the given kind, carrying the pages nobody has named yet (or nothing, once nothing is left). */
export function rowOf(kind: PageRow['kind'], id: number, fill: { from: string; to: string } | null): PageRow {
  return { id, kind, from: fill?.from ?? '', to: kind === 'range' ? (fill?.to ?? '') : '' };
}

/**
 * One row as the grammar spells it: `1-5`, `7`, `4-z` — or `''` for a row that names nothing yet.
 *
 * An empty `To` is one page, never a trailing hyphen, and a range whose **first** box is empty names nothing at all
 * (the component says so out loud rather than guessing at page 1).
 */
export function specOf(row: PageRow): string {
  const from = row.from.trim();
  if (from === '') return '';
  if (row.kind === 'page') return from;
  const to = row.to.trim();
  return to === '' ? from : `${from}-${to}`;
}

/** The value the API receives: every row that names something, in the order it was written. */
export function specsOf(rows: readonly PageRow[]): string[] {
  return rows.map(specOf).filter((spec) => spec !== '');
}

/**
 * A set of pages as the grammar spells it, one spec per run: `[1,2,3,7,9,10,11]` → `['1-3', '7', '9-11']`.
 *
 * The inverse of `expandPageSpecs`, and it exists for the one interaction that produces a page list instead of reading
 * one: **clicking a page in the preview**. A click lands in the middle of a range (`1-5` minus page 3 is `1-2` and
 * `4-5`), so the rows cannot simply be edited in place — the set is what changes, and this is how it is written back
 * into the value the schema takes. A run of one page stays a page (`7`, never `7-7`), because that is what the boxes
 * show and what a person writes.
 */
export function specsFromPages(pages: readonly number[]): string[] {
  const sorted = [...new Set(pages)].filter((page) => Number.isFinite(page) && page >= 1).sort((a, b) => a - b);
  const specs: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  for (const page of sorted) {
    if (start == null) {
      start = page;
      previous = page;
      continue;
    }
    if (previous != null && page === previous + 1) {
      previous = page;
      continue;
    }
    specs.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  if (start != null && previous != null) specs.push(start === previous ? `${start}` : `${start}-${previous}`);
  return specs;
}

/**
 * Whether the pages a control collects are the ones the job **removes** (`OptionsUiField.removes`).
 *
 * Two tools, two ways of saying it: `delete-pages`' option *is* the removal (`true`), while `extract-pages`' direction
 * is a sibling field (`{ key: 'mode', when: ['exclude'] }`). It lives here rather than in the panel because two callers
 * now need the answer and they must not be able to disagree: the panel phrases the control's sentence with it, and the
 * tool page decides what a **click in the preview** means with it.
 */
export function removesPages(field: OptionsUiField, values: Record<string, unknown>): boolean {
  return selectionDirection(field, values) === 'removes';
}

/**
 * Which way round a `page-rows` selection runs: the pages it **keeps**, the pages it **removes**, the pages it
 * **acts on**, or the pages it **turns** (`OptionsUiField.removes`, `.applies`, `.turns`).
 *
 * Four tools, four answers, and the reason this is one function rather than four predicates: the panel phrases the
 * control's sentence with it, the preview decides what a click means with it, and a second reading of the same field is
 * how the form and the drawing would come to disagree about a value they both show.
 *
 * `applies` and `turns` are the same *arithmetic* — the selection is acted on and the rest of the document comes back
 * as it was — and two directions rather than one because the sentence is a different word: `Crops 3 of 6 pages` on a
 * screen whose product is an orientation is a sentence about the wrong tool (`types.ts`).
 */
export type SelectionDirection = 'keeps' | 'removes' | 'applies' | 'turns';

export function selectionDirection(field: OptionsUiField, values: Record<string, unknown>): SelectionDirection {
  if (field.applies === true) return 'applies';
  if (field.turns === true) return 'turns';
  const rule = field.removes;
  if (!rule) return 'keeps';
  if (rule === true) return 'removes';
  const current = values[rule.key];
  return rule.when.some((allowed) => String(allowed) === String(current)) ? 'removes' : 'keeps';
}

/**
 * The selection after one page is moved across — what a click on a preview page does.
 *
 * The click means **"this page changes sides"**, and the value that comes back is the option's new value. That is the
 * whole operation in both directions, and it is the same expression in both: a removal-selection (`delete-pages`,
 * `extract-pages` in `exclude`) is the **complement** of a keep-selection, and complement commutes with toggling a
 * member — so the set that changes is the set the value holds, whether the value names the pages that stay or the pages
 * that go. So there is one function and not two, and the direction is not an argument to it: which half of the preview
 * the click landed in already says which way the page moves, and `removesPages` is what tells the caller which half
 * that is.
 *
 * Returns `null` when there is nothing to change: no page count to resolve `1-z` and `even` against, or a page the
 * document does not have.
 */
export function togglePageSelection({
  value,
  page,
  pageCount,
}: {
  /** The option's current value (`string[]`), as the form holds it. */
  value: unknown;
  page: number;
  pageCount: number | null;
}): string[] | null {
  if (pageCount == null || page < 1 || page > pageCount) return null;
  const specs = Array.isArray(value)
    ? value.filter((spec): spec is string => typeof spec === 'string' && spec.trim() !== '')
    : [];
  const named = new Set<number>();
  for (const spec of specs) for (const resolved of pagesOf(spec, pageCount)) named.add(resolved);

  if (named.has(page)) named.delete(page);
  else named.add(page);
  return specsFromPages([...named]);
}

/** Each row's specs as the one-group-per-row shape `nextRange` works in (a selection has no grouping of its own). */
function groupsOf(rows: readonly PageRow[]): string[][] {
  return rows.map((row) => {
    const spec = specOf(row);
    return spec === '' ? [] : [spec];
  });
}

/**
 * The fill for a new row: the first pages nobody has named yet, as the two boxes it goes into.
 *
 * The same `nextRange` the split control uses, so a gap is offered as a range and a gap of one page as a page —
 * `Add page` takes the first unnamed page, `Add range` the whole run from there, and `null` once every page is named.
 */
export function nextFill(rows: readonly PageRow[], pageCount: number | null): { from: string; to: string } | null {
  const spec = nextRange(groupsOf(rows), pageCount);
  if (spec == null) return null;
  const dash = spec.indexOf('-');
  return dash <= 0 ? { from: spec, to: '' } : { from: spec.slice(0, dash), to: spec.slice(dash + 1) };
}

/** The pages a spec names, as far as they can be resolved: `[]` for one that needs the count, or names nothing. */
function pagesOf(spec: string, pageCount?: number): number[] {
  try {
    return expandPageSpecs([spec], pageCount);
  } catch {
    return [];
  }
}

/** Every page the rows name, ascending — or `null` while the document's own length is unknown. */
export function namedPages(rows: readonly PageRow[], pageCount: number | null): number[] | null {
  if (pageCount == null) return null;
  const pages = new Set<number>();
  for (const row of rows) {
    const spec = specOf(row);
    if (spec === '') continue;
    for (const page of pagesOf(spec, pageCount)) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

/**
 * The first spec the grammar refuses, with the row it is in.
 *
 * Two mistakes arrive as one answer because the control says them at the same row: a token the grammar does not know
 * (`abc`, `9-5`), and a range whose first box is empty while its second is not — the state the boxes cannot forbid, and
 * the one a person reaches by typing the end of a range first.
 */
export function firstBadRow(rows: readonly PageRow[]): { rowId: number; message: string } | null {
  for (const row of rows) {
    const from = row.from.trim();
    const to = row.to.trim();
    if (from === '' && to !== '') return { rowId: row.id, message: 'This range needs a first page.' };
    const spec = specOf(row);
    if (spec !== '' && !isPageRangeToken(spec)) {
      return { rowId: row.id, message: `"${spec}" is not a page or a page range.` };
    }
  }
  return null;
}

/** The rows a stored value implies, or the one empty row a fresh form starts with. */
export function rowsFromValue(value: unknown, counter: { current: number }): PageRow[] {
  const specs = Array.isArray(value)
    ? value.filter((spec): spec is string => typeof spec === 'string' && spec.trim() !== '')
    : [];
  const list = specs.length > 0 ? specs : [''];
  return list.map((spec) => {
    counter.current += 1;
    const dash = spec.indexOf('-');
    // A stored spec that is not a range is a **page**, which is what reopens the one box the user will change.
    const kind: PageRow['kind'] = dash > 0 ? 'range' : 'page';
    return {
      id: counter.current,
      kind,
      from: kind === 'range' ? spec.slice(0, dash) : spec,
      to: kind === 'range' ? spec.slice(dash + 1) : '',
    };
  });
}

/**
 * Whitespace-insensitive and order-sensitive — and **blind to a row's kind**, which is not part of the value.
 *
 * The kind is where the user is typing, not what they selected: `4` in one box and `4` in the first of two are the
 * same page, and the spec is what the request will carry either way. Comparing it was a real defect and not a
 * theoretical one — promoting a page to a range re-emits the same value, the mirror effect re-read the value, and the
 * second box the user had just opened was taken away again (`features/tool-shell/page-rows.tsx`).
 */
export function sameRows(left: readonly PageRow[], right: readonly PageRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    if (!other) return false;
    return specOf(row).replace(/\s/g, '') === specOf(other).replace(/\s/g, '');
  });
}

export interface SelectionSummary {
  /** One sentence, in the direction the pages are going. */
  sentence: string;
  /** `empty` (nothing named), `warn` (a selection the job will refuse, or one that selects nothing), `ok` otherwise. */
  tone: 'empty' | 'ok' | 'warn';
}

/**
 * An arrangement the rows control can only **read** — `rotate`'s map of page → angle
 * (`features/page-rotate/model.ts`, `docs/0-UI-DESIGN.md` §6.5).
 *
 * This control collects a **selection**: a set of pages that share one outcome, written as a flat `string[]`. A mixed
 * rotation is the other form of the same request (`perPage`), and the two cannot coexist — the map outranks the
 * selection in the worker, which ignores a selection beside it and reports `PAGES_IGNORED` rather than obeying it. So
 * while the map is live there is no value for the boxes to hold and **nothing a keystroke could mean**: a row that
 * accepted one would be a control that lies, and an empty set of boxes under a label that says "pages that turn" is a
 * control that has silently disappeared.
 *
 * The third answer is this one: the rows stay, and they *read* the arrangement — one row per run of pages the request
 * treats alike, the run in the grammar's own spelling (`1-3`, `5`) and the note in the tool's own words for what happens
 * to those pages. Nothing here is editable, and the sentence says what the list is and where the boxes went: the module
 * that owns the arrangement writes both (`page-rotate/model.ts`, `turnsReading`).
 */
export interface PageRowsReading {
  /** One row per run of pages the request treats alike, in page order — a run of one page is one row. */
  rows: ReadonlyArray<{ spec: string; note: string }>;
  /** What the list is, and why the boxes are not above it. */
  sentence: string;
}

/**
 * What the rows add up to, said once — and in the direction the tool's own field declares.
 *
 * The direction is the whole reason this is a function rather than a template string: the same `["2","5-9"]` is
 * `Keeps 4 of 12 pages.` on `extract-pages`, `Removes 4 of 12 pages — 8 stay.` on `delete-pages`, and `Crops 4 of 12
 * pages — the other 8 keep their own crop box.` on `crop`, and stating the wrong one of those is a wrong answer
 * delivered confidently.
 *
 * `applies` is the third reading and it differs in two places rather than one, which is why it is a direction and not a
 * flag on top of `removes`: the verb is `Crops`, and **an empty selection is not empty** — `crop` writes its box onto
 * every page when no page is named (the handler's `pages` is optional), so no rows is the whole document and the
 * sentence says so instead of asking for the page number the other two tools require.
 *
 * Three facts it adds that the preview beside it cannot: how many pages the selection actually names (the preview draws
 * outcomes, not arithmetic), **that a page was named twice** (which collapses silently in every other layer), and the
 * states the worker refuses — an empty output, a removal that would delete the whole document, and a selection that
 * names no page of this document at all.
 */
export function describeSelection({
  rows,
  pageCount,
  direction,
}: {
  rows: readonly PageRow[];
  pageCount: number | null;
  direction: SelectionDirection;
}): SelectionSummary {
  const specs = specsOf(rows);
  if (specs.length === 0) {
    return direction === 'applies'
      ? { sentence: 'Every page is cropped — name a page to trim only some.', tone: 'ok' }
      : direction === 'turns'
        ? {
            //
            // "Leaves every page as it is" rather than "turns every page": no rows means the rotation covers the whole
            // document, but whether this request turns anything at all is the **board's** question, and on a fresh form
            // it turns nothing (`features/page-rotate/model.ts`). A sentence here claiming a rotation would be the form
            // promising a job the screen is not yet drawing.
            //
            sentence: 'Nothing named yet — with no pages named the rotation covers every page.',
            tone: 'ok',
          }
        : {
            sentence: `Nothing selected yet — the job needs at least one page ${direction === 'removes' ? 'to remove' : 'to keep'}.`,
            tone: 'empty',
          };
  }

  const repeats = repeatedNames(specs);
  const suffix = repeats.length > 0 ? ` ${repeatClause(repeats)}` : '';
  const named = namedPages(rows, pageCount);

  if (named == null) {
    // Before the document is counted, only the specs written in numbers can be counted at all: `1-z` and `odd` are
    // waiting for the page count, and the sentence says so instead of quietly counting them as nothing.
    const counted = specs.reduce((total, spec) => total + pagesOf(spec).length, 0);
    const waiting = specs.some((spec) => pagesOf(spec).length === 0);
    const soFar = waiting ? ' so far; the rest arrives with the page count' : '';
    return { sentence: `${verb(direction)} ${counted} page${counted === 1 ? '' : 's'}${soFar}.${suffix}`, tone: 'ok' };
  }

  const total = pageCount ?? 0;
  // A page beyond the document is not a page of it. `extract-pages` refuses it and `delete-pages` ignores it
  // (`workers/light/src/handlers/pages.ts`), and the preview beside this control is where that difference is stated —
  // so the count here is what this selection can actually contain.
  const real = named.filter((page) => page >= 1 && page <= total);
  const count = real.length;

  if (count === 0) {
    return { sentence: `None of those pages are in this ${total}-page document.${suffix}`, tone: 'warn' };
  }
  if (direction === 'turns') {
    //
    // The same reading as `applies`, in this tool's word. The pages outside the selection are **not** untouched in the
    // sense of "the job ignores them": the rotation is written onto the selected pages and the rest of the document
    // comes back carrying the `/Rotate` it already had, which is the difference between a page this tool leaves alone
    // and a page nobody has ever rotated — the same distinction the crop handler makes with `PARTIAL_CROP`
    // (`workers/light/src/handlers/crop.ts`).
    //
    return count >= total
      ? { sentence: `Turns all ${total} pages — the whole document gets this angle.${suffix}`, tone: 'ok' }
      : {
          sentence: `Turns ${count} of ${total} pages — the other ${total - count} keep the rotation they already carry.${suffix}`,
          tone: 'ok',
        };
  }
  if (direction === 'applies') {
    return count >= total
      ? { sentence: `Crops all ${total} pages — the output has a crop box on every page.${suffix}`, tone: 'ok' }
      : {
          // The handler's own hedge, in the form: the pages outside the selection come back with the crop box they
          // already had, which is the difference between "untouched" and "uncropped".
          sentence: `Crops ${count} of ${total} pages — the other ${total - count} keep their own crop box.${suffix}`,
          tone: 'ok',
        };
  }
  if (direction === 'removes') {
    return count >= total
      ? { sentence: 'Removes every page — the job refuses to leave an empty document.', tone: 'warn' }
      : { sentence: `Removes ${count} of ${total} pages — ${total - count} stay.${suffix}`, tone: 'ok' };
  }
  return count >= total
    ? { sentence: `Keeps all ${total} pages — the output is the whole document.${suffix}`, tone: 'ok' }
    : { sentence: `Keeps ${count} of ${total} pages.${suffix}`, tone: 'ok' };
}

function verb(direction: SelectionDirection): string {
  return direction === 'removes'
    ? 'Removes'
    : direction === 'applies'
      ? 'Crops'
      : direction === 'turns'
        ? 'Turns'
        : 'Keeps';
}

/** The pages named more than once, ascending — a fact the value cannot carry, because duplicates are idempotent. */
function repeatedNames(specs: readonly string[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const spec of specs) {
    for (const page of pagesOf(spec)) {
      if (seen.has(page)) repeated.add(page);
      seen.add(page);
    }
  }
  return [...repeated].sort((left, right) => left - right);
}

function repeatClause(pages: readonly number[]): string {
  const named = pages.slice(0, 2).map((page) => `page ${page}`);
  const more = pages.length - named.length;
  const list = named.length === 1 ? named[0]! : `${named[0]} and ${named[1]}`;
  return `${list}${more > 0 ? ` and ${more} more` : ''} ${pages.length === 1 ? 'is' : 'are'} named twice.`;
}
