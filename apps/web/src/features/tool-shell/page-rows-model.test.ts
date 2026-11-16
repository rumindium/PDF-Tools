import { describe, expect, test } from 'bun:test';
import {
  type PageRow,
  describeSelection,
  firstBadRow,
  namedPages,
  nextFill,
  removesPages,
  rowsFromValue,
  sameRows,
  selectionDirection,
  specOf,
  specsFromPages,
  specsOf,
  togglePageSelection,
} from './page-rows-model';

/**
 * The rows behind a page selection, and the sentence they add up to
 * (`features/tool-shell/page-rows.tsx`, `docs/02-SPLIT-AND-EXTRACT.md` §3.2).
 *
 * Two things are being asserted here, and the second is the one that fails silently in a design review:
 *
 *  - **the value** — what a row spells, what a stored value reopens, and what the fill for a new row is;
 *  - **the sentence** — the direction (`Keeps` / `Removes`), the arithmetic, the duplicate remark, and the two states
 *    the worker refuses. A control whose summary says "Keeps 12 of 12" on a removal is a wrong answer delivered
 *    confidently, and nothing but a test notices a wording that reversed when the field moved.
 */

function rows(...specs: Array<string | [string, string]>): PageRow[] {
  return specs.map((spec, index) =>
    typeof spec === 'string'
      ? { id: index + 1, kind: 'page' as const, from: spec, to: '' }
      : { id: index + 1, kind: 'range' as const, from: spec[0], to: spec[1] },
  );
}

describe('what a row spells', () => {
  test('a page is one box and a range is two, with the hyphen drawn', () => {
    expect(specOf({ id: 1, kind: 'page', from: '7', to: '' })).toBe('7');
    expect(specOf({ id: 1, kind: 'range', from: '1', to: '5' })).toBe('1-5');
    // Empty `To` means **one page** — the reason `1-` is not a state this control can produce.
    expect(specOf({ id: 1, kind: 'range', from: '4', to: '' })).toBe('4');
    // An empty row names nothing, and one of those must never reach the request body.
    expect(specOf({ id: 1, kind: 'page', from: '  ', to: '' })).toBe('');
    expect(specsOf(rows('2', ['5', '9'], ''))).toEqual(['2', '5-9']);
  });

  test('a stored value reopens as the rows it was written in', () => {
    const counter = { current: 0 };
    const reopened = rowsFromValue(['2', '5-9', '10-z'], counter);
    expect(reopened.map((row) => [row.kind, row.from, row.to])).toEqual([
      ['page', '2', ''],
      ['range', '5', '9'],
      ['range', '10', 'z'],
    ]);
    // A fresh form is one empty row rather than none: the tool needs a selection, and a form with nothing in it is
    // worse than a form that is waiting for a page number.
    expect(rowsFromValue(undefined, counter).map((row) => row.kind)).toEqual(['page']);
    expect(sameRows(rowsFromValue(['1-3'], counter), rows(['1', '3']))).toBe(true);
    expect(sameRows(rowsFromValue(['1-3'], counter), rows('1'))).toBe(false);

    // A row's **kind** is not part of its value, so re-reading the value must not undo it: `4` in one box and `4` in
    // the first of two are the same page, and comparing the kind took the second box away the moment it was opened.
    expect(sameRows(rows('4'), [{ id: 9, kind: 'range', from: '4', to: '' }])).toBe(true);
    expect(sameRows(rows('4'), [{ id: 9, kind: 'range', from: '4', to: '5' }])).toBe(false);
  });

  test('a row the grammar refuses is named, at its own row', () => {
    expect(firstBadRow(rows('1', 'abc'))).toEqual({ rowId: 2, message: '"abc" is not a page or a page range.' });
    // The state the boxes cannot forbid: the end of a range typed before its start.
    expect(firstBadRow(rows(['', '9']))).toEqual({ rowId: 1, message: 'This range needs a first page.' });
    expect(firstBadRow(rows('1', ['4', 'z'], 'odd'))).toBeNull();
  });
});

describe('what the next row arrives with', () => {
  test('the first pages nobody has named, as the boxes they go into', () => {
    // A range is offered as a range — the whole run — and a single-page gap as a page.
    expect(nextFill(rows('1', ['2', '5']), 12)).toEqual({ from: '6', to: '12' });
    // A gap of exactly one page is offered as a page, because `6-6` is a range nobody writes.
    expect(nextFill(rows(['1', '11']), 12)).toEqual({ from: '12', to: '' });
    // Every page named: there is nothing left to offer, and the component says so instead of adding an empty row.
    expect(nextFill(rows(['1', '12']), 12)).toBeNull();
    // Without the count the only honest fill is the grammar's own "to the end".
    expect(nextFill([], null)).toEqual({ from: '1', to: 'z' });
  });

  test('a spec that needs the document is counted only once it is known', () => {
    expect(namedPages(rows('1-z'), null)).toBeNull();
    expect(namedPages(rows('1-z'), 4)).toEqual([1, 2, 3, 4]);
    expect(namedPages(rows('2', '2', ['5', '6']), 8)).toEqual([2, 5, 6]);
  });
});

describe('the sentence under the rows', () => {
  test('it speaks the direction the choice put the pages in', () => {
    // `2` plus `5-9` is six pages: the sentence states the arithmetic *and* the direction.
    const kept = describeSelection({ rows: rows('2', ['5', '9']), pageCount: 12, direction: 'keeps' });
    expect(kept.sentence).toBe('Keeps 6 of 12 pages.');
    expect(kept.tone).toBe('ok');

    // The same value on the tool whose option *is* the removal — the assertion that made this a function rather than
    // a template string.
    const removed = describeSelection({ rows: rows('2', ['5', '9']), pageCount: 12, direction: 'removes' });
    expect(removed.sentence).toBe('Removes 6 of 12 pages — 6 stay.');
  });

  test('an empty selection is the state the API refuses, said at the control', () => {
    expect(describeSelection({ rows: rows(''), pageCount: 12, direction: 'keeps' })).toEqual({
      sentence: 'Nothing selected yet — the job needs at least one page to keep.',
      tone: 'empty',
    });
    expect(describeSelection({ rows: [], pageCount: 12, direction: 'removes' }).sentence).toBe(
      'Nothing selected yet — the job needs at least one page to remove.',
    );
  });

  test('the two ends of the range are stated, including the one that leaves nothing', () => {
    expect(describeSelection({ rows: rows(['1', 'z']), pageCount: 6, direction: 'keeps' })).toEqual({
      sentence: 'Keeps all 6 pages — the output is the whole document.',
      tone: 'ok',
    });
    expect(describeSelection({ rows: rows(['1', 'z']), pageCount: 6, direction: 'removes' })).toEqual({
      sentence: 'Removes every page — the job refuses to leave an empty document.',
      tone: 'warn',
    });
  });

  test('a page the document does not have is not a page', () => {
    // `extract-pages` refuses this and `delete-pages` ignores it, so the count that matters is the pages that exist.
    expect(describeSelection({ rows: rows('99'), pageCount: 12, direction: 'keeps' })).toEqual({
      sentence: 'None of those pages are in this 12-page document.',
      tone: 'warn',
    });
    // A range that reaches past the end keeps the pages that exist, exactly as the worker does.
    expect(describeSelection({ rows: rows(['10', '99']), pageCount: 12, direction: 'keeps' }).sentence).toBe(
      'Keeps 3 of 12 pages.',
    );
  });

  test('a page named twice is said once', () => {
    // The value cannot carry it — duplicates are idempotent — so this sentence is the only place the user learns that
    // their second row changed nothing.
    expect(describeSelection({ rows: rows('2', '2', ['5', '9']), pageCount: 12, direction: 'keeps' }).sentence).toBe(
      'Keeps 6 of 12 pages. page 2 is named twice.',
    );
    expect(describeSelection({ rows: rows(['5', '9'], '5', '9'), pageCount: 12, direction: 'keeps' }).sentence).toBe(
      'Keeps 5 of 12 pages. page 5 and page 9 are named twice.',
    );
  });

  test('before the count, it counts what it can and says what it cannot', () => {
    expect(describeSelection({ rows: rows('2', ['5', '9']), pageCount: null, direction: 'keeps' }).sentence).toBe(
      'Keeps 6 pages.',
    );
    expect(describeSelection({ rows: rows('2', '1-z'), pageCount: null, direction: 'removes' }).sentence).toBe(
      'Removes 1 page so far; the rest arrives with the page count.',
    );
  });
});

/**
 * A page set written back as specs — the half of the preview click that is pure arithmetic.
 *
 * The click lands in the middle of a range, so the value cannot be edited where the user aimed; the set changes and
 * this is how it is spelled again. A run of one page has to stay a page (`7`, never `7-7`), because the boxes and the
 * sentence would otherwise name something a person did not write.
 */
describe('a page set as specs', () => {
  test('runs of consecutive pages become ranges, and a lone page stays a page', () => {
    expect(specsFromPages([1, 2, 3])).toEqual(['1-3']);
    expect(specsFromPages([7])).toEqual(['7']);
    expect(specsFromPages([1, 2, 3, 7, 9, 10, 11])).toEqual(['1-3', '7', '9-11']);
    // Out of order and duplicated input is the same set — the API is a set too, so the order a click produced it in
    // must not reach the request body.
    expect(specsFromPages([5, 2, 2, 1])).toEqual(['1-2', '5']);
    expect(specsFromPages([])).toEqual([]);
  });

  test('it round-trips through the grammar it was written for', () => {
    const pages = [1, 2, 3, 7, 9, 10, 11, 12];
    const specs = specsFromPages(pages);
    const back: number[] = [];
    for (const spec of specs) {
      const dash = spec.indexOf('-');
      if (dash < 0) back.push(Number(spec));
      else
        for (let page = Number(spec.slice(0, dash)); page <= Number(spec.slice(dash + 1)); page += 1) back.push(page);
    }
    expect(back).toEqual(pages);
  });
});

/**
 * What a click on a preview page does.
 *
 * The operation is one thing: the page changes sides, so the set the value holds toggles. The tests below assert that
 * (including the click that lands **inside** a range, which is why the value cannot be edited where the user aimed),
 * and then assert the half that a naive "remove this page" implementation would get wrong — in a removal-selection the
 * click that lands on an unselected page takes it *out* of the removal, because the removal is not the output.
 *
 * The two directions are deliberately **not** a parameter here. A removal-selection is the complement of a keep one,
 * and complement commutes with toggling a member, so the same click yields the same value in both spaces and the
 * difference is entirely in what the value means — which `removesPages` answers and `describeSelection` says in words.
 * A function that took the direction as an argument would be a second copy of this arithmetic waiting to disagree with
 * the first.
 */
describe('a click on a preview page', () => {
  test('a page inside a range splits it, because the set is what changed', () => {
    // Keep `1-5`, click page 3: the value becomes two runs. Nothing here can be done by editing a row in place —
    // that is the reason this operation exists on the set rather than on the spec.
    expect(togglePageSelection({ value: ['1-5'], page: 3, pageCount: 12 })).toEqual(['1-2', '4-5']);
    // A page that was already out goes back in, and adjacent runs merge into the range a person would have written.
    expect(togglePageSelection({ value: ['1-5'], page: 6, pageCount: 12 })).toEqual(['1-6']);
  });

  test('a page nobody has named yet is toggled on, and a named one off', () => {
    // A removal-selection holds what the job takes OUT. Clicking page 4 there means "keep it after all", so the
    // removal loses a page — an implementation that read the click as "remove this" would add it instead.
    expect(togglePageSelection({ value: [], page: 4, pageCount: 12 })).toEqual(['4']);
    expect(togglePageSelection({ value: ['4'], page: 4, pageCount: 12 })).toEqual([]);
    // The mirror of the keep case: `2-5` removed, page 3 brought back, so the removal keeps 2, 4 and 5.
    expect(togglePageSelection({ value: ['2-5'], page: 3, pageCount: 12 })).toEqual(['2', '4-5']);
  });

  test('a stored value with duplicates or disorder is normalised on the way out', () => {
    // The API takes a set, so a click must not be the thing that finally lets `['5','5','1-2']` reach it.
    expect(togglePageSelection({ value: ['5', '1-2', '5'], page: 7, pageCount: 12 })).toEqual(['1-2', '5', '7']);
  });

  test('an unresolvable selection is left alone rather than guessed at', () => {
    // `1-z` and `even` only mean something against a count — and with no count there is no selection to update.
    expect(togglePageSelection({ value: ['1-z'], page: 3, pageCount: null })).toBeNull();
    expect(togglePageSelection({ value: ['even'], page: 3, pageCount: null })).toBeNull();
    // A page the document does not have is not a page.
    expect(togglePageSelection({ value: ['1-3'], page: 9, pageCount: 8 })).toBeNull();
    expect(togglePageSelection({ value: ['1-3'], page: 0, pageCount: 8 })).toBeNull();
    // A range that does need the count, with the count present, resolves — so its pages count as named.
    expect(togglePageSelection({ value: ['1-z'], page: 3, pageCount: 4 })).toEqual(['1-2', '4']);
  });
});

/**
 * Which tools tick pages *on* the removal list — the one question the panel and the preview must answer identically.
 *
 * `delete-pages` says it with the option itself (`removes: true`); `extract-pages` with a sibling direction field that
 * is read at click time. A literal `true` that got read as "check the mode field" would break one tool, and a mode rule
 * read as a literal would break the other, so both spellings are asserted.
 */
describe('which control removes pages', () => {
  test('a literal rule needs no other field', () => {
    expect(removesPages({ key: 'pages', control: 'page-rows', label: 'Pages to remove', removes: true }, {})).toBe(
      true,
    );
    expect(removesPages({ key: 'pages', control: 'page-rows', label: 'Pages to keep' }, {})).toBe(false);
  });

  //
  // The third direction, and the one that must **not** be read as a removal: `crop` writes its box onto the pages the
  // rows name, so a click in its preview is not a page changing sides. `applies` is checked before `removes` in
  // `selectionDirection`, which is what makes a field that somehow carries both read as the tool it belongs to.
  test('a crop selection is neither kept nor removed, and an empty one is every page', () => {
    const field = { key: 'pages', control: 'page-rows' as const, label: 'Pages to crop', applies: true as const };
    expect(selectionDirection(field, {})).toBe('applies');
    expect(removesPages(field, {})).toBe(false);
    expect(describeSelection({ rows: rows(''), pageCount: 12, direction: 'applies' })).toEqual({
      sentence: 'Every page is cropped — name a page to trim only some.',
      tone: 'ok',
    });
    expect(describeSelection({ rows: rows('2', ['5', '6']), pageCount: 12, direction: 'applies' })).toEqual({
      sentence: 'Crops 3 of 12 pages — the other 9 keep their own crop box.',
      tone: 'ok',
    });
    // Naming every page is a sentence about the document rather than a warning: a crop of every page is the whole
    // page count and nothing is refused.
    expect(describeSelection({ rows: rows(['1', 'z']), pageCount: 6, direction: 'applies' }).sentence).toBe(
      'Crops all 6 pages — the output has a crop box on every page.',
    );
    // The arithmetic before the document is counted says `Crops`, not `Keeps` — the verb is part of the direction.
    expect(describeSelection({ rows: rows('2', '1-z'), pageCount: null, direction: 'applies' }).sentence).toBe(
      'Crops 1 page so far; the rest arrives with the page count.',
    );
  });

  //
  // The fourth direction, and it is the same arithmetic as `applies` with one difference: **the word**. `Crops` is what
  // happened here before `turns` existed (the sentence is chosen by direction, and `rotate`'s rows were reading the
  // crop's), and a control that says "Crops 3 of 6 pages" on a screen about orientation is a sentence about the wrong
  // tool. An empty selection is every page for the same reason it is for `applies` — the handler rotates with no page
  // selector at all — but the sentence claims no rotation, because whether anything turns is the board's question.
  //
  test('a rotation selection turns its pages, and an empty one is the whole document', () => {
    const field = { key: 'pages', control: 'page-rows' as const, label: 'Pages that turn', turns: true as const };
    expect(selectionDirection(field, {})).toBe('turns');
    expect(removesPages(field, {})).toBe(false);
    expect(describeSelection({ rows: rows(''), pageCount: 6, direction: 'turns' })).toEqual({
      sentence: 'Nothing named yet — with no pages named the rotation covers every page.',
      tone: 'ok',
    });
    expect(describeSelection({ rows: rows(['2', '4']), pageCount: 6, direction: 'turns' })).toEqual({
      sentence: 'Turns 3 of 6 pages — the other 3 keep the rotation they already carry.',
      tone: 'ok',
    });
    // Several rows are several ranges, and the count is the pages they name — the multi-range reading the control was
    // chosen for (`packages/contracts/src/tools/catalog.ts`).
    expect(describeSelection({ rows: rows(['2', '3'], ['5', '6']), pageCount: 6, direction: 'turns' }).sentence).toBe(
      'Turns 4 of 6 pages — the other 2 keep the rotation they already carry.',
    );
    expect(describeSelection({ rows: rows(['1', 'z']), pageCount: 6, direction: 'turns' }).sentence).toBe(
      'Turns all 6 pages — the whole document gets this angle.',
    );
    // The arithmetic before the document is counted says `Turns`, not `Keeps` — the verb is part of the direction.
    expect(describeSelection({ rows: rows('2', '1-z'), pageCount: null, direction: 'turns' }).sentence).toBe(
      'Turns 1 page so far; the rest arrives with the page count.',
    );
    // A page this document does not have is the shared refusal, not a direction's own sentence.
    expect(describeSelection({ rows: rows('9'), pageCount: 6, direction: 'turns' }).sentence).toBe(
      'None of those pages are in this 6-page document.',
    );
  });

  test('a mode rule is read against the value in front of it', () => {
    const field = {
      key: 'pages',
      control: 'page-rows' as const,
      label: 'Pages',
      removes: { key: 'mode', when: ['exclude'] },
    };
    expect(removesPages(field, { mode: 'exclude' })).toBe(true);
    expect(removesPages(field, { mode: 'include' })).toBe(false);
    // Before a choice is made the direction is not yet "remove", so a click keeps — the safer of the two, because the
    // control's own default is the choice card and a click cannot happen before it is answered.
    expect(removesPages(field, {})).toBe(false);
  });
});
