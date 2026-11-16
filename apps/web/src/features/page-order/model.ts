/**
 * The order of a document's pages, and the three options that describe it
 * (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.1, `docs/0-UI-DESIGN.md` §3.3).
 *
 * `reorder-pages` takes `order` (a permutation of `1..n`), `duplicate` (pages to repeat) and `reverse` (a convenience
 * for the full backwards permutation). Until this module existed the form asked for all three **as typed page numbers**
 * — "a permutation of the original page numbers, e.g. 3,1,2" — which is the worst input in the catalogue: a sentence
 * about a document the person is looking at, and one they can only get right by writing every number in the file
 * (defect 226). The pages are already on screen, so the arrangement is what is dragged, and this module is the
 * translation between that board and the three options.
 *
 * ## The state is a list of slots, not a page list
 *
 * A slot is one page of the source plus **how many copies of it follow it**:
 *
 * ```text
 * slots:  [ {page: 3, copies: 1}, {page: 1, copies: 0}, {page: 2, copies: 0} ]
 * output:   3, 3, 1, 2
 * value:  { order: [3,1,2], duplicate: [3] }
 * ```
 *
 * That shape is not a convenience — it is the only one that maps onto the worker. The handler builds the output by
 * walking the order and emitting each page once plus once per copy **immediately after it**, and it refuses an `order`
 * that does not use every page exactly once. So a copy has to be attached to its page rather than floating in the
 * sequence, and a page and its copies move together: there is no reachable state where a copy has been dragged away
 * from the page it copies, which is a state the API cannot express and would silently drop.
 *
 * Two consequences, both asserted by the tests next to this file:
 *
 *  - **Every page is present exactly once** (`slots` is a permutation), so no action in this module can lose a page.
 *    That is the invariant `reorder-pages` rests on: it changes where pages sit, never which pages exist.
 *  - **The board's sequence is the job's output**, page for page, copies included. The output the person arranges is
 *    the output the worker writes, which is the only reason a preview of this tool is worth drawing.
 *
 * ## `reverse` is a way of saying the same thing
 *
 * `reverse: true` is documented as "equivalent to a full permutation", and the handler checks it **first** — so when it
 * is on, the explicit order is ignored. This module never returns both: `reverse` is read as one more way to spell the
 * arrangement (`withReverse`), and moving a page produces an explicit order with the switch turned off, because that is
 * what the user just did by hand. One arrangement, one representation, so the board and the payload cannot disagree.
 */

/** The options this module reads. A subset, because it is one tool's surface. */
export interface OrderValues {
  order?: unknown;
  duplicate?: unknown;
  reverse?: unknown;
}

/** One page of the source document and the copies that follow it in the output. */
export interface PageSlot {
  /** 1-based page number in the **source** document. */
  page: number;
  /** Extra copies emitted after it — `0` for the page appearing once. */
  copies: number;
}

/**
 * How many copies one page may be given.
 *
 * A UI limit rather than a contract one: `duplicate` has no ceiling, and the number exists so the ⊕ cannot be held
 * down until the job's page budget is spent by accident. Nine extra copies of a page is already a strange thing to ask
 * for; the API's own `maxPages` is what refuses the ones that are too large to build.
 */
export const MAX_COPIES = 9;

function asNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 1);
}

/**
 * The slots for the current options, or the document's own order when nothing is set.
 *
 * `order` wins over the document's numbering (that is what it is for), `reverse` wins over both (that is what the
 * handler does), and a duplicate whose page is not in the document is dropped exactly as the worker drops it
 * (`options.duplicate.filter(page => page >= 1 && page <= total)`) — a preview that kept it would draw a page the job
 * will not write.
 */
export function slotsFromOptions(values: OrderValues, pageCount: number | null): PageSlot[] {
  const total = pageCount != null && pageCount > 0 ? pageCount : 0;
  if (total === 0) return [];

  const identity = Array.from({ length: total }, (_, index) => index + 1);
  // A stored order that is not a permutation of this document is not usable — the API would refuse it, and a board
  // built from it would draw pages that do not exist. The document's own order is what the form would have sent.
  const stored = asNumbers(values.order);
  const permutation =
    stored.length === total && new Set(stored).size === total && stored.every((page) => page <= total)
      ? stored
      : identity;
  const ordered = values.reverse === true ? [...permutation].reverse() : permutation;

  const copies = new Map<number, number>();
  for (const page of asNumbers(values.duplicate)) {
    if (page > total) continue;
    copies.set(page, (copies.get(page) ?? 0) + 1);
  }
  return ordered.map((page) => ({ page, copies: Math.min(copies.get(page) ?? 0, MAX_COPIES) }));
}

/**
 * The three options a board state means, as the payload wants them.
 *
 * `order` is **always** written, and that is deliberate: the board always knows the arrangement, and an explicit
 * permutation of the document is a true statement about what the job is asked to produce. It also keeps the run
 * available — the schema's `refine` requires one of the three options, so a board that wrote nothing while showing an
 * untouched document would end in `VALIDATION_ERROR: Provide a page order, a set of pages to duplicate, or reverse`
 * for a user who had simply not moved anything yet.
 *
 * `duplicate` is written as one entry per copy **in slot order**, which is the order the worker emits them in, and is
 * omitted entirely when there are none (an empty array is a value the schema accepts and the job would report as
 * `duplicated: 0`, but a payload that describes no work is better left out).
 *
 * `reverse` is never returned: the board writes the order it shows, and the tool page clears the switch when the
 * arrangement is edited by hand (`withReverse` below is the one place the switch is written).
 */
export function optionsFromSlots(slots: readonly PageSlot[]): { order: number[]; duplicate?: number[] } {
  const duplicate: number[] = [];
  for (const slot of slots) {
    for (let copy = 0; copy < slot.copies; copy += 1) duplicate.push(slot.page);
  }
  return {
    order: slots.map((slot) => slot.page),
    ...(duplicate.length > 0 ? { duplicate } : {}),
  };
}

/**
 * The same three options, **keyed the way the tool declares them** — the value the form is set to, not the value the
 * reader gets.
 *
 * The difference matters for exactly one key. `order` and `duplicate` come straight from `optionsFromSlots`, but a
 * `reverse` this board did not write stays in the form where it was, and `slotsFromOptions` reads `reverse` **first** —
 * because the worker does. So a board that reversed by hand while the old `reverse: true` sat in the form would show one
 * arrangement, send another, and be right about neither: the value is written back, the switch is turned off, and the
 * board's own `Reverse` is the only thing that sets it (`optionsFromSlots` never returns it).
 *
 * `duplicate === undefined` is written as `undefined` rather than deleted, because that is what the form holds for an
 * option nobody has set: the payload builder drops it, and the schema's `optional()` is what that means.
 */
export function optionsPatch(slots: readonly PageSlot[], keys: readonly string[]): Record<string, unknown> {
  const { order, duplicate } = optionsFromSlots(slots);
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === 'order') patch[key] = order;
    else if (key === 'duplicate') patch[key] = duplicate;
    // Everything else a `page-order` control declares is a switch about the arrangement (`reverse`, the only one the
    // schema has) — and a switch the board speaks for is off the moment the board is edited.
    else patch[key] = false;
  }
  return patch;
}

/** The output page sequence, copies included — what the job will write, and what the board draws. */
export function outputPages(slots: readonly PageSlot[]): number[] {
  const pages: number[] = [];
  for (const slot of slots) {
    for (let index = 0; index <= slot.copies; index += 1) pages.push(slot.page);
  }
  return pages;
}

/** How many pages the output has — the document's pages plus every copy (`2 of 12 pages → 13 out`). */
export function outputCount(slots: readonly PageSlot[]): number {
  return slots.length + copyCount(slots);
}

/**
 * How many pages no longer sit where the document had them.
 *
 * The one number that says whether the arrangement has been touched at all, and it is **not** `order !== [1..n]`
 * spelled differently: a page that moved forward by three and a page that moved back by three are both one page moved,
 * and a board that counted positions would report `12` for a document that was simply reversed. Counting pages is what
 * makes `3 pages in new places` a sentence about the document rather than about the list.
 */
export function changedCount(slots: readonly PageSlot[]): number {
  return slots.reduce((total, slot, index) => (slot.page === index + 1 ? total : total + 1), 0);
}

/**
 * Where a tile dropped on another lands, given which half of the target it was released over.
 *
 * `before`/`after` is the difference the drop indicator draws (`order-tile[data-over]`), and it cannot be folded into
 * `moveSlot`: the caller passes an index into the **current** list, and removing the dragged tile first shifts every
 * later position down by one. Getting that off by one is the classic drag-and-drop bug — a page that lands one slot
 * short of where it was dropped — and it is invisible in a document whose pages look alike, so it is arithmetic here
 * with tests beside it rather than an adjustment in a handler.
 *
 * `null` means "nothing to do": a drop back onto the tile's own place, or an index from a stale render. The caller
 * then draws nothing, which is the honest result of a drag that changed nothing.
 */
export function dropTargetIndex(from: number, over: number, side: 'before' | 'after', count: number): number | null {
  if (from < 0 || from >= count || over < 0 || over >= count) return null;
  const boundary = side === 'after' ? over + 1 : over;
  const to = from < boundary ? boundary - 1 : boundary;
  return to === from ? null : to;
}

/**
 * One sentence describing the arrangement, for the line under the board.
 *
 * It is the board's own arithmetic rather than a restatement of the options: `3 pages in new places` is a fact about
 * the document in front of the reader and `order: [3,1,2,...]` is not, and the option's own hint is already on screen
 * beside the tiles. `→ 13 pages out` is the second half of that sentence, because a copy changes the length of the
 * output and nothing else on the page says by how much.
 */
export function describeArrangement(slots: readonly PageSlot[]): string {
  if (slots.length === 0) return 'Waiting for the document’s page count before the pages can be arranged.';
  const copies = copyCount(slots);
  const moved = changedCount(slots);
  if (moved === 0 && copies === 0) {
    return 'These are the pages in the order they already have — move one to change the output.';
  }
  const parts: string[] = [];
  // Always plural or absent: a page off its own place takes another page's place, which displaces that one in turn, so a
  // permutation cannot have exactly one element out of position. The count is never 1 and the sentence says `pages`.
  if (moved > 0) parts.push(`${moved} pages in new places`);
  if (copies > 0) parts.push(`${copies} extra cop${copies === 1 ? 'y' : 'ies'}`);
  return `${parts.join(' · ')} → ${outputCount(slots)} pages out.`;
}

/**
 * Move the page at `from` to position `to`, **moving its copies with it**.
 *
 * A splice, not a swap: dragging a page is putting it somewhere, and a board that swapped two pages would move two
 * pages for one gesture. Out-of-range indices return the slots unchanged rather than throwing, because the callers are
 * pointer and keyboard handlers and an index that has gone stale between the two should draw nothing rather than break
 * the page.
 */
export function moveSlot(slots: readonly PageSlot[], from: number, to: number): PageSlot[] {
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return [...slots];
  const next = [...slots];
  const [moved] = next.splice(from, 1);
  if (!moved) return [...slots];
  next.splice(to, 0, moved);
  return next;
}

/** One more copy of a page, up to `MAX_COPIES` — the ⊕ on a tile. */
export function addCopy(slots: readonly PageSlot[], page: number): PageSlot[] {
  return slots.map((slot) =>
    slot.page === page && slot.copies < MAX_COPIES ? { ...slot, copies: slot.copies + 1 } : slot,
  );
}

/** One copy fewer — the `−`, hidden entirely at zero so the row of controls does not offer a no-op. */
export function removeCopy(slots: readonly PageSlot[], page: number): PageSlot[] {
  return slots.map((slot) => (slot.page === page && slot.copies > 0 ? { ...slot, copies: slot.copies - 1 } : slot));
}

/** Every copy off, back to one of each page — the `Reset` beside the ⧉ counts. */
export function clearCopies(slots: readonly PageSlot[]): PageSlot[] {
  return slots.map((slot) => (slot.copies === 0 ? slot : { ...slot, copies: 0 }));
}

/**
 * The arrangement a `reverse` switch means, applied to the slots in front of it.
 *
 * The board's own reverse affordance calls this, and so does the switch in the options panel (through the tool page):
 * the slots are read back from the options with `reverse` applied, so both controls write the same thing and the board
 * can never be showing one arrangement while the value holds another.
 */
export function withReverse(slots: readonly PageSlot[]): PageSlot[] {
  return [...slots].reverse();
}

/**
 * Whether the slots are the document as it already is — the state a "nothing to do" hint is drawn for.
 *
 * Not a refusal: an untouched board is a valid request (see `optionsFromSlots`), and the UI says `These are the pages
 * in the order they already have.` rather than disabling the run, because "do not change it" is a request the user is
 * allowed to make.
 */
export function isDocumentOrder(slots: readonly PageSlot[]): boolean {
  return slots.every((slot, index) => slot.page === index + 1 && slot.copies === 0);
}

/** How many copies the arrangement adds — the fact the board's header states beside the page counts. */
export function copyCount(slots: readonly PageSlot[]): number {
  return slots.reduce((total, slot) => total + slot.copies, 0);
}

/**
 * The page a keyboard move should land on, given where the caret is and which way it is going.
 *
 * A move by one position is the whole keyboard model — every page is reachable by repeating it, and the alternative
 * (jump to the ends) makes the middle of a long document unreachable. The ends return `null` so the caller can leave
 * the arrangement alone and say nothing, rather than wrapping a page from the front to the back on a keypress the user
 * meant as "as far as it goes".
 */
export function neighbourIndex(index: number, direction: -1 | 1, count: number): number | null {
  const next = index + direction;
  return next < 0 || next >= count ? null : next;
}
