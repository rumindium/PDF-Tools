import { describe, expect, test } from 'bun:test';
import {
  MAX_COPIES,
  addCopy,
  changedCount,
  clearCopies,
  copyCount,
  describeArrangement,
  dropTargetIndex,
  isDocumentOrder,
  moveSlot,
  neighbourIndex,
  optionsFromSlots,
  optionsPatch,
  outputCount,
  outputPages,
  removeCopy,
  slotsFromOptions,
  withReverse,
} from './model';

/**
 * The arrangement of a document's pages, and the options the worker reads it from
 * (`features/page-order/model.ts`, `docs/03-ORGANIZE-ROTATE-CROP.md` §2.1).
 *
 * Two properties are being defended here and both are silent failures in production:
 *
 *  - **No arrangement can lose a page.** `reorder-pages` moves pages; it never removes one. Every slot list is a
 *    permutation of the document, and a move or a copy cannot change that.
 *  - **The board's sequence is the worker's output.** The slot list is what is drawn and the options are what is sent,
 *    so a translation that disagrees produces a preview of a job nobody will get — which is the whole failure this
 *    tool's UI was rebuilt to prevent.
 */

function slots(spec: Array<[page: number, copies: number]>): ReturnType<typeof slotsFromOptions> {
  return spec.map(([page, copies]) => ({ page, copies }));
}

describe('the options a board state comes from', () => {
  test('nothing set is the document as it is', () => {
    expect(slotsFromOptions({}, 3)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
    // The page count is what makes a slot list possible at all: before the probe answers there is nothing to arrange,
    // and an empty board is the honest drawing of that.
    expect(slotsFromOptions({}, null)).toEqual([]);
    expect(slotsFromOptions({ order: [2, 1] }, 3)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
  });

  test('an explicit order is the arrangement', () => {
    expect(slotsFromOptions({ order: [3, 1, 2] }, 3)).toEqual(
      slots([
        [3, 0],
        [1, 0],
        [2, 0],
      ]),
    );
  });

  test('`reverse` is read, because the worker checks it first', () => {
    // The handler reads `reverse` before `order`, so a `reverse` the board ignored would draw one document while the
    // job wrote another.
    expect(slotsFromOptions({ reverse: true }, 4)).toEqual(
      slots([
        [4, 0],
        [3, 0],
        [2, 0],
        [1, 0],
      ]),
    );
    // Both set: the worker reverses, so the board reverses the arrangement it is showing.
    expect(slotsFromOptions({ order: [2, 1, 4, 3], reverse: true }, 4)).toEqual(
      slots([
        [3, 0],
        [4, 0],
        [1, 0],
        [2, 0],
      ]),
    );
  });

  test('copies are counted per page, and a multiset means the number of copies', () => {
    expect(slotsFromOptions({ duplicate: [3] }, 4)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 1],
        [4, 0],
      ]),
    );
    expect(slotsFromOptions({ duplicate: [3, 3] }, 4)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 2],
        [4, 0],
      ]),
    );
    expect(slotsFromOptions({ duplicate: [3, 1] }, 3)).toEqual(
      slots([
        [1, 1],
        [2, 0],
        [3, 1],
      ]),
    );
  });

  test('a page the document does not have is dropped, exactly as the worker drops it', () => {
    // The handler filters `duplicate` to the document's own pages, so a preview that kept page 9 would draw a page the
    // job will not write.
    expect(slotsFromOptions({ duplicate: [9] }, 4)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
    );
    expect(slotsFromOptions({ duplicate: [0, 9, 2] }, 4)).toEqual(
      slots([
        [1, 0],
        [2, 1],
        [3, 0],
        [4, 0],
      ]),
    );
  });

  test('an order that is not a permutation is not an order', () => {
    // Stored by an older build, or written by hand at the API: the job refuses it (`The new page order must use every
    // page exactly once`), so the board falls back to the document rather than drawing an arrangement that cannot run.
    expect(slotsFromOptions({ order: [1, 1, 3] }, 3)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
    expect(slotsFromOptions({ order: [1, 2] }, 3)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
    expect(slotsFromOptions({ order: [1, 2, 9] }, 3)).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
    expect(slotsFromOptions({ order: ['2', 1] }, 2)).toEqual(
      slots([
        [1, 0],
        [2, 0],
      ]),
    );
  });
});

describe('the options a board state means', () => {
  test('the order is the arrangement, and copies become `duplicate`', () => {
    expect(
      optionsFromSlots(
        slots([
          [3, 1],
          [1, 0],
          [2, 0],
        ]),
      ),
    ).toEqual({ order: [3, 1, 2], duplicate: [3] });
    expect(optionsFromSlots(slots([[1, 2]]))).toEqual({ order: [1], duplicate: [1, 1] });
  });

  test('no copies means no `duplicate` key at all', () => {
    // Not an empty array: a payload describing no work is better left out, and the API's own `refine` reads `order`.
    expect(
      optionsFromSlots(
        slots([
          [1, 0],
          [2, 0],
        ]),
      ),
    ).toEqual({ order: [1, 2] });
  });

  test('`reverse` is never written, because the arrangement already says it', () => {
    // One representation: the board writes what it shows. The switch is written only where a user presses it
    // (`withReverse` below), so the two can never disagree about which of them the job will follow.
    expect(
      'reverse' in
        optionsFromSlots(
          withReverse(
            slots([
              [1, 0],
              [2, 0],
            ]),
          ),
        ),
    ).toBe(false);
  });

  test('the round trip is the identity for every arrangement the board can reach', () => {
    const cases = [
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
      slots([
        [3, 2],
        [1, 0],
        [2, 1],
      ]),
    ];
    for (const value of cases) {
      const { order, duplicate } = optionsFromSlots(value);
      expect(slotsFromOptions({ order, duplicate }, value.length)).toEqual(value);
    }
  });

  test('the output sequence is the page, then its copies', () => {
    expect(
      outputPages(
        slots([
          [3, 2],
          [1, 0],
        ]),
      ),
    ).toEqual([3, 3, 3, 1]);
    expect(
      copyCount(
        slots([
          [3, 2],
          [1, 0],
        ]),
      ),
    ).toBe(2);
    expect(
      outputCount(
        slots([
          [3, 2],
          [1, 0],
        ]),
      ),
    ).toBe(4);
  });

  test('the patch is keyed the way the tool declares its options', () => {
    // The three keys of the one tool that has this control, written in one call so the form can never hold an
    // arrangement the board is not showing.
    expect(
      optionsPatch(
        slots([
          [3, 1],
          [1, 0],
          [2, 0],
        ]),
        ['order', 'duplicate', 'reverse'],
      ),
    ).toEqual({
      order: [3, 1, 2],
      duplicate: [3],
      reverse: false,
    });
    // No copies: `duplicate` is written as `undefined`, which the payload builder drops and the schema reads as absent.
    expect(
      optionsPatch(
        slots([
          [1, 0],
          [2, 0],
        ]),
        ['order', 'duplicate', 'reverse'],
      ),
    ).toEqual({
      order: [1, 2],
      duplicate: undefined,
      reverse: false,
    });
  });

  test('a hand-made arrangement turns the reverse switch off', () => {
    // The failure this prevents is a double reverse: `slotsFromOptions` reads `reverse` first, because the worker does,
    // so a board that wrote its order while `reverse: true` stayed in the form would be redrawn backwards while the
    // payload said otherwise. The switch is `false` in every patch, and `withReverse` is the one thing that sets it.
    const reversed = withReverse(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
    expect(optionsPatch(reversed, ['order', 'duplicate', 'reverse']).reverse).toBe(false);
    expect(slotsFromOptions({ ...optionsPatch(reversed, ['order', 'reverse']) }, 3)).toEqual(reversed);
  });
});

describe('moving a page', () => {
  test('a move splices, so one gesture moves one page', () => {
    // A swap would be a different operation: dragging page 1 to the end would also drag page 6 to the front, which is
    // two changes from one gesture.
    expect(
      moveSlot(
        slots([
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
        0,
        2,
      ),
    ).toEqual(
      slots([
        [2, 0],
        [3, 0],
        [1, 0],
      ]),
    );
    expect(
      moveSlot(
        slots([
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
        2,
        0,
      ),
    ).toEqual(
      slots([
        [3, 0],
        [1, 0],
        [2, 0],
      ]),
    );
  });

  test('a page carries its copies', () => {
    // A copy is not a page of its own: the worker emits it immediately after the page it copies, so losing that link
    // would produce a value the API cannot express.
    expect(
      moveSlot(
        slots([
          [1, 0],
          [2, 2],
          [3, 0],
        ]),
        1,
        2,
      ),
    ).toEqual(
      slots([
        [1, 0],
        [3, 0],
        [2, 2],
      ]),
    );
  });

  test('a stale index changes nothing and does not throw', () => {
    // These indices come from pointer and keyboard handlers: a drop after a re-render is ordinary, and it must draw
    // nothing rather than break the page.
    const before = slots([
      [1, 0],
      [2, 0],
    ]);
    expect(moveSlot(before, 0, 0)).toEqual(before);
    expect(moveSlot(before, 0, 5)).toEqual(before);
    expect(moveSlot(before, -1, 1)).toEqual(before);
    expect(moveSlot(before, 9, 0)).toEqual(before);
  });

  test('a move cannot lose or duplicate a page', () => {
    const before = slots([
      [4, 1],
      [2, 0],
      [3, 2],
      [1, 0],
    ]);
    for (let from = 0; from < before.length; from += 1) {
      for (let to = 0; to < before.length; to += 1) {
        const after = moveSlot(before, from, to);
        expect(after.map((slot) => slot.page).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
        expect(copyCount(after)).toBe(copyCount(before));
      }
    }
  });
});

describe('the patch a board state becomes', () => {
  test('`order`, `duplicate` and the switch, in one value', () => {
    expect(
      optionsPatch(
        slots([
          [2, 1],
          [1, 0],
        ]),
        ['order', 'duplicate'],
      ),
    ).toEqual({
      order: [2, 1],
      duplicate: [2],
    });
    expect(
      optionsPatch(
        slots([
          [2, 0],
          [1, 0],
        ]),
        ['order'],
      ),
    ).toEqual({ order: [2, 1] });
    expect(optionsPatch(slots([[1, 0]]), ['order', 'duplicate', 'reverse'])).toEqual({
      order: [1],
      duplicate: undefined,
      reverse: false,
    });
  });
});

describe('copies', () => {
  test('a copy is added to its own page only', () => {
    expect(
      addCopy(
        slots([
          [1, 0],
          [2, 0],
        ]),
        2,
      ),
    ).toEqual(
      slots([
        [1, 0],
        [2, 1],
      ]),
    );
    expect(addCopy(slots([[1, 0]]), 9)).toEqual(slots([[1, 0]]));
  });

  test('the ceiling is a UI limit and it holds', () => {
    const full = slots([[1, MAX_COPIES]]);
    expect(addCopy(full, 1)).toEqual(full);
    // The translation still agrees with itself at the ceiling, which is what makes it safe to clamp rather than refuse.
    expect(optionsFromSlots(addCopy(full, 1)).duplicate).toHaveLength(MAX_COPIES);
  });

  test('removing one copy, and removing every copy', () => {
    expect(
      removeCopy(
        slots([
          [1, 2],
          [2, 1],
        ]),
        1,
      ),
    ).toEqual(
      slots([
        [1, 1],
        [2, 1],
      ]),
    );
    // Never below zero: the `−` is hidden at zero, and a model that could go negative would send `duplicate` entries
    // that mean nothing.
    expect(removeCopy(slots([[1, 0]]), 1)).toEqual(slots([[1, 0]]));
    expect(
      clearCopies(
        slots([
          [1, 2],
          [2, 0],
          [3, 1],
        ]),
      ),
    ).toEqual(
      slots([
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    );
  });
});

describe('the facts the board states', () => {
  test('the document order is recognised, and a copy makes it not that', () => {
    expect(
      isDocumentOrder(
        slots([
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
      ),
    ).toBe(true);
    expect(
      isDocumentOrder(
        slots([
          [2, 0],
          [1, 0],
          [3, 0],
        ]),
      ),
    ).toBe(false);
    // A page where it already was, with a copy: still an arrangement to run, because the output is not the document.
    expect(
      isDocumentOrder(
        slots([
          [1, 1],
          [2, 0],
        ]),
      ),
    ).toBe(false);
  });

  test('reverse is its own inverse, which is what makes the switch a switch', () => {
    const value = slots([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    expect(withReverse(withReverse(value))).toEqual(value);
    expect(withReverse(value)).toEqual(
      slots([
        [3, 0],
        [2, 1],
        [1, 0],
      ]),
    );
  });

  test('a move by one position is the whole keyboard model, and the ends say so', () => {
    expect(neighbourIndex(1, -1, 4)).toBe(0);
    expect(neighbourIndex(1, 1, 4)).toBe(2);
    // The ends return `null` rather than wrapping: a page that jumped from the front to the back on one keypress is
    // the opposite of "as far as it goes".
    expect(neighbourIndex(0, -1, 4)).toBeNull();
    expect(neighbourIndex(3, 1, 4)).toBeNull();
  });

  test('how many pages are not where the document had them', () => {
    expect(
      changedCount(
        slots([
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
      ),
    ).toBe(0);
    // Reversed is *three* pages in new places, not twelve positions out of place — the count is about pages.
    expect(
      changedCount(
        slots([
          [3, 0],
          [2, 0],
          [1, 0],
        ]),
      ),
    ).toBe(2);
    expect(
      changedCount(
        slots([
          [2, 0],
          [1, 0],
          [4, 0],
          [3, 0],
        ]),
      ),
    ).toBe(4);
  });

  test('the sentence counts what changed, and says nothing changed when it did not', () => {
    expect(
      describeArrangement(
        slots([
          [1, 0],
          [2, 0],
        ]),
      ),
    ).toContain('already have');
    expect(
      describeArrangement(
        slots([
          [3, 0],
          [2, 0],
          [1, 0],
        ]),
      ),
    ).toBe('2 pages in new places → 3 pages out.');
    expect(
      describeArrangement(
        slots([
          [2, 0],
          [1, 0],
        ]),
      ),
    ).toBe('2 pages in new places → 2 pages out.');
    // A copy of a page that has not moved is still a change to the output, and the sentence has to say so — that is the
    // state where the board and the document agree and the file still comes out different.
    expect(
      describeArrangement(
        slots([
          [1, 1],
          [2, 0],
        ]),
      ),
    ).toBe('1 extra copy → 3 pages out.');
    expect(
      describeArrangement(
        slots([
          [2, 1],
          [1, 0],
        ]),
      ),
    ).toBe('2 pages in new places · 1 extra copy → 3 pages out.');
    expect(
      describeArrangement(
        slots([
          [1, 2],
          [2, 0],
        ]),
      ),
    ).toBe('2 extra copies → 4 pages out.');
  });
});

describe('dropping a tile on another', () => {
  test('an insertion is not the index the tile was released over', () => {
    // Dragging page 5 onto the **right** half of position 1 is *after* it, and the removal happens first — so the
    // landing index is 1, not 2. This is the off-by-one that a document of look-alike pages hides.
    expect(dropTargetIndex(4, 0, 'after', 6)).toBe(1);
    expect(dropTargetIndex(4, 0, 'before', 6)).toBe(0);
  });

  test('dragging forwards lands on the boundary as drawn', () => {
    // Index 0 removed first, so the tile that was index 3 is at 2 by the time the insertion happens.
    expect(dropTargetIndex(0, 3, 'before', 6)).toBe(2);
    expect(dropTargetIndex(0, 3, 'after', 6)).toBe(3);
  });

  test('a drop that changes nothing is not a move', () => {
    // Both halves of its own tile, which is what a drag that ends where it started looks like.
    expect(dropTargetIndex(2, 2, 'before', 6)).toBeNull();
    expect(dropTargetIndex(2, 2, 'after', 6)).toBeNull();
    // Onto the tile immediately to the left, right half: also its own place.
    expect(dropTargetIndex(2, 1, 'after', 6)).toBeNull();
  });

  test('a stale index changes nothing', () => {
    expect(dropTargetIndex(9, 0, 'before', 6)).toBeNull();
    expect(dropTargetIndex(0, 9, 'before', 6)).toBeNull();
    expect(dropTargetIndex(0, 0, 'before', 0)).toBeNull();
  });

  test('the landing index always moves the page it was given, and loses none', () => {
    const before = slots([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    for (let from = 0; from < before.length; from += 1) {
      for (let over = 0; over < before.length; over += 1) {
        for (const side of ['before', 'after'] as const) {
          const to = dropTargetIndex(from, over, side, before.length);
          if (to == null) continue;
          const after = moveSlot(before, from, to);
          expect(after.map((slot) => slot.page).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
          expect(after[to]?.page).toBe(before[from]?.page);
        }
      }
    }
  });
});
