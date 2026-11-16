import { describe, expect, test } from 'bun:test';
import {
  type CropFractions,
  type CropFrame,
  afterDrag,
  clampFractions,
  croppedPages,
  describeCrop,
  equalInsets,
  evenInsets,
  fractionsFromInsets,
  insetsFromFractions,
  isCropped,
  isWholePage,
  keptArea,
  readInsets,
  toggleCroppedPage,
} from './model';

/**
 * The crop box's arithmetic (`features/page-crop/model.ts`, `docs/03-ORGANIZE-ROTATE-CROP.md` §2.1).
 *
 * Three properties are being defended, and each one fails *silently* in production — the job runs, the file downloads,
 * and the page is simply wrong:
 *
 *  - **A unit is per axis.** A percentage of the width and a percentage of the height are different lengths on every
 *    page that is not square, and applying one to both is the mistake this pair of functions exists to prevent.
 *  - **The two directions are inverses.** The panel writes a value and the overlay reads one back; a round trip that
 *    drifts turns a typed `20 mm` into `19.99` and then `19.98`, one keystroke at a time.
 *  - **The engine's floor is the board's floor.** A box under `CROP_MIN_KEPT_RATIO` of the page is skipped by the
 *    handler and reported as a warning, so a drag that reached it would be a crop the user watched themselves make and
 *    did not get (`clampFractions`).
 */

/** A4, in points: the fixture every crop case in this project uses. */
const A4: CropFrame = { widthPt: 595.28, heightPt: 841.89 };

function fractions(spec: Partial<CropFractions>): CropFractions {
  return { top: 0, right: 0, bottom: 0, left: 0, ...spec };
}

/**
 * Fractions compared by value, not by identity: every one of these is the sum or difference of binary fractions, so
 * `0.1 + 0.05` is `0.15000000000000002` and a `toEqual` would be testing IEEE 754 rather than the arithmetic above.
 */
function expectFractions(actual: CropFractions, expected: CropFractions): void {
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    expect(actual[edge]).toBeCloseTo(expected[edge], 9);
  }
}

describe('reading the option', () => {
  test('a missing box is no trim at all, and a negative one is read as none', () => {
    expect(readInsets(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(readInsets({ top: -5, left: 'x' })).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(readInsets({ top: 20, right: 5, bottom: 20, left: 5 })).toEqual({ top: 20, right: 5, bottom: 20, left: 5 });
  });

  test('a whole page is the state the API refuses', () => {
    expect(isWholePage(fractions({}))).toBe(true);
    expect(isWholePage(fractions({ top: 0.001 }))).toBe(false);
  });
});

describe('units', () => {
  test('millimetres and points are absolute, and percent is per axis', () => {
    // 20 mm on A4 is 56.69 pt; the same 20 mm is a different *share* of the width than of the height.
    const mm = fractionsFromInsets({ top: 20, right: 20, bottom: 20, left: 20 }, 'mm', A4);
    expect(mm.left).toBeCloseTo(56.6929 / A4.widthPt, 5);
    expect(mm.top).toBeCloseTo(56.6929 / A4.heightPt, 5);
    expect(mm.left).not.toBeCloseTo(mm.top, 4);

    // The point is that a percentage is a share of *its* axis: 10 % of the width is 59.5 pt, 10 % of the height is
    // 84.2 pt. A conversion that used one extent for both would pass every test above and fail this one.
    const percent = fractionsFromInsets({ top: 10, right: 10, bottom: 10, left: 10 }, 'percent', A4);
    expect(percent).toEqual({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
    const back = insetsFromFractions(percent, 'percent', A4);
    expect(back).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });

    const points = fractionsFromInsets({ top: 72, right: 72, bottom: 0, left: 0 }, 'pt', A4);
    expect(points.top).toBeCloseTo(72 / A4.heightPt, 6);
  });

  test('the round trip is stable, so typing 20 mm does not drift to 19.99', () => {
    for (const units of ['mm', 'pt', 'percent'] as const) {
      const typed = { top: 20, right: 12.5, bottom: 7, left: 0 };
      const once = insetsFromFractions(fractionsFromInsets(typed, units, A4), units, A4);
      expect(once).toEqual(typed);
      // Twice, because a form that wrote its own value back on every render is how drift gets in.
      expect(insetsFromFractions(fractionsFromInsets(once, units, A4), units, A4)).toEqual(typed);
    }
  });

  test('a landscape page keeps its own sense of which axis is which', () => {
    const landscape: CropFrame = { widthPt: 841.89, heightPt: 595.28 };
    const insets = fractionsFromInsets({ top: 10, right: 10, bottom: 10, left: 10 }, 'percent', landscape);
    expect(insets.right).toBe(0.1);
    expect(insets.bottom).toBe(0.1);
    const kept = insetsFromFractions(insets, 'percent', landscape);
    expect(kept).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
  });
});

describe('dragging', () => {
  test('an edge moves that edge and nothing else', () => {
    const start = fractions({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
    // Pull the left edge inwards by 5 % of the page.
    expectFractions(afterDrag(start, 'left', 0.05, 0), fractions({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.15 }));
    expectFractions(afterDrag(start, 'top', 0, 0.05), fractions({ top: 0.15, right: 0.1, bottom: 0.1, left: 0.1 }));
    // And the other way: dragging the left edge *left* trims less.
    expectFractions(afterDrag(start, 'left', -0.05, 0), fractions({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.05 }));
  });

  test('a corner moves both of the edges it is made of', () => {
    const start = fractions({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
    expectFractions(
      afterDrag(start, 'top-left', 0.02, 0.03),
      fractions({ top: 0.13, right: 0.1, bottom: 0.1, left: 0.12 }),
    );
    expectFractions(
      afterDrag(start, 'bottom-right', -0.02, -0.03),
      fractions({ top: 0.1, right: 0.12, bottom: 0.13, left: 0.1 }),
    );
  });

  test('dragging the body moves the box without resizing it', () => {
    const start = fractions({ top: 0.3, right: 0.3, bottom: 0.3, left: 0.3 });
    // Right and up: the left inset grows by the drag, the right one *shrinks* by it — which is what "the box moved"
    // means in a value that is four distances from the edges.
    const moved = afterDrag(start, 'box', 0.05, -0.08);
    expectFractions(moved, fractions({ top: 0.22, right: 0.25, bottom: 0.38, left: 0.35 }));
    // The rectangle is the same size wherever it travels: this is the assertion a resize dressed up as a move fails.
    expect(moved.left + moved.right).toBeCloseTo(start.left + start.right, 6);
    expect(moved.top + moved.bottom).toBeCloseTo(start.top + start.bottom, 6);
  });

  test('a box cannot be dragged off the page', () => {
    const start = fractions({ top: 0.1, right: 0.6, bottom: 0.1, left: 0.2 });
    // Pushed right far further than the right inset allows: it stops where its right edge meets the page.
    const right = afterDrag(start, 'box', 5, 0);
    expect(right.right).toBeCloseTo(0, 6);
    expect(right.left + right.right).toBeCloseTo(start.left + start.right, 6);
    const left = afterDrag(start, 'box', -5, 0);
    expect(left.left).toBeCloseTo(0, 6);
    // Out of the top: the top inset is the limit in that direction.
    const up = afterDrag(start, 'box', 0, -5);
    expect(up.top).toBeCloseTo(0, 6);
  });

  test('an edge cannot be dragged past the opposite one', () => {
    const start = fractions({ top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 });
    const pushed = afterDrag(start, 'top', 0, 5);
    // The floor is the engine's ratio, not the opposite edge — see the next describe for why it is that ratio.
    expect(keptArea(pushed)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(pushed.top).toBeGreaterThan(0.3);
    const reversed = afterDrag(start, 'left', 5, 0);
    expect(keptArea(reversed)).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });
});

describe('the floor the engine enforces', () => {
  test('a drag stops at the share of the page the handler would skip', () => {
    // `CROP_MIN_KEPT_RATIO` is 0.1: a page kept below it is skipped by the writing pass and comes back untouched. So
    // the box the user drags is never smaller than what the job would actually do.
    const tiny = clampFractions(fractions({ top: 0.48, right: 0.48, bottom: 0.48, left: 0.48 }));
    expect(keptArea(tiny)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    // The proportions survive the clamp: an uneven trim stays uneven rather than being squared off.
    expect(tiny.top).toBeCloseTo(tiny.bottom, 6);
    expect(tiny.left).toBeCloseTo(tiny.right, 6);
  });

  test('a box flattened against one axis still gets above the ratio', () => {
    //
    // The case the first version of the clamp got wrong, and the tests caught: with the width already at the page's
    // edge it cannot grow, so the height has to take the whole requirement. Scaling both by one factor left this box
    // at 3.5 % — a crop the handler skips, drawn as if it were fine.
    //
    const flat = clampFractions(fractions({ top: 0.495, bottom: 0.495 }));
    expect(keptArea(flat)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(flat.left + flat.right).toBeCloseTo(0, 9);
    expect(flat.top).toBeLessThan(0.495);

    // And the same on the other axis, so neither is special.
    const narrow = clampFractions(fractions({ left: 0.495, right: 0.495 }));
    expect(keptArea(narrow)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(narrow.top + narrow.bottom).toBeCloseTo(0, 9);
  });

  test('nothing is clamped when there is nothing to clamp', () => {
    const fine = fractions({ top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 });
    expect(clampFractions(fine)).toEqual(fine);
    expect(clampFractions(fractions({}))).toEqual(fractions({}));
  });
});

describe('the sentence', () => {
  test('an untrimmed page is legal but pointless, and says so without blocking the run', () => {
    // The request itself is accepted — `box` is present, so the handler's "`auto` or a `box`" rule is satisfied — and
    // the job would return the document it went in with. That is a job nobody wants, not an error, so the tone is
    // `none` rather than `blocked`: a board that showed "cannot be sent" here would be refusing to send a legal request.
    const whole = describeCrop(fractions({}), 'mm', A4);
    expect(whole.tone).toBe('none');
    expect(whole.sentence).toContain('nothing would change');
  });

  test('a box under the guard names the engine’s rule rather than the user’s arithmetic', () => {
    const small = describeCrop(fractions({ top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 }), 'mm', A4);
    expect(small.tone).toBe('blocked');
    expect(small.sentence).toContain('10 %');
  });

  test('a millimetre crop quotes the kept size, which is the fact being checked', () => {
    const even = describeCrop(fractionsFromInsets({ top: 20, right: 20, bottom: 20, left: 20 }, 'mm', A4), 'mm', A4);
    expect(even.tone).toBe('changed');
    // 20 mm off every edge of A4 keeps 170 × 257 mm, and the page it is 170 mm of is 210 × 297 mm.
    expect(even.sentence).toBe('Keeps 170 × 257 mm of a 210 × 297 mm page — 20 mm off every edge.');
  });

  test('an asymmetric crop lists the edges it trims', () => {
    const uneven = describeCrop(fractionsFromInsets({ top: 10, right: 0, bottom: 0, left: 5 }, 'mm', A4), 'mm', A4);
    expect(uneven.sentence).toContain('10 mm off the top');
    expect(uneven.sentence).toContain('5 mm off the left');
    expect(uneven.sentence).not.toContain('right');
  });

  test('a percentage crop is described as shares, not as lengths', () => {
    const shares = describeCrop(
      fractionsFromInsets({ top: 5, right: 10, bottom: 5, left: 10 }, 'percent', A4),
      'percent',
      A4,
    );
    expect(shares.sentence).toContain('Keeps 80 % of the width and 90 % of the height');
    expect(shares.tone).toBe('changed');
  });

  test('a pair that shares one trim is said once, which is where percent reads worst ungrouped', () => {
    // 20 mm off every edge is 9.53 % of A4's width and 6.73 % of its height, so the two axes part company and the
    // ungrouped reading was four clauses of two different numbers — "9.53 % off the left, 9.53 % off the right,
    // 6.73 % off the top, 6.73 % off the bottom". Two clauses say the same request.
    const even = describeCrop(
      fractionsFromInsets({ top: 20, right: 20, bottom: 20, left: 20 }, 'mm', A4),
      'percent',
      A4,
    );
    // The kept share and the trim are rounded differently on purpose — a share of a page is quoted to one decimal, the
    // inset the user set to two — so 9.52 % of the width is "9.5 % off both sides".
    expect(even.sentence).toBe(
      'Keeps 81 % of the width and 86.5 % of the height — trimming 9.5 % off both sides, 6.7 % off the top and bottom.',
    );
    // A pair that does not match stays two clauses, and the axes keep their own order: sides, then top and bottom.
    const uneven = describeCrop(
      fractionsFromInsets({ top: 10, right: 5, bottom: 0, left: 20 }, 'mm', A4),
      'percent',
      A4,
    );
    expect(uneven.sentence).toContain('— trimming 9.5 % off the left, 2.4 % off the right, 3.4 % off the top.');
  });
});

describe('the “same on every edge” box', () => {
  test('it reads the shared value in the units, not as fractions', () => {
    // 20 mm off every edge is four *different* fractions of the page — a larger share of the width than of the height
    // — and comparing the fractions would call the most ordinary crop in the product "mixed".
    const insets = { top: 20, right: 20, bottom: 20, left: 20 };
    expect(equalInsets(insets)).toBe(20);
    const asFractions = fractionsFromInsets(insets, 'mm', A4);
    expect(asFractions.left).not.toBeCloseTo(asFractions.top, 4);

    // Mixed edges have no single value: the box shows nothing rather than a wrong number.
    expect(equalInsets({ top: 20, right: 5, bottom: 20, left: 5 })).toBeNull();
  });

  test('typing one value writes all four, and the whole-page state comes back', () => {
    expect(evenInsets(12)).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
    expect(evenInsets(-3)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    // And zero is the whole page: a legal request that would do nothing, which the sentence states rather than
    // blocking — the arrival state is the catalog's default box, so this only happens when someone types four zeros.
    expect(fractionsFromInsets(evenInsets(0), 'mm', A4)).toEqual(fractions({}));
  });
});

/**
 * The pages the box is written onto — `crop.pages`, the one option here whose **empty** value is not empty.
 *
 * The handler reads `options.pages` as optional and crops every page when it is absent, so the three states that matter
 * are: absent (every page), named (some pages), and named-not-in-this-document (nothing, which the form says). Every one
 * of those readings is asserted below, because the board draws all three of them and a board that confused "absent" with
 * "none" would show a document with no cropped pages while the job cropped the whole thing.
 */
describe('the pages a crop is written onto', () => {
  test('an absent selection is every page, and a named one is a set', () => {
    expect(croppedPages(undefined, 6)).toBeNull();
    expect(croppedPages([], 6)).toBeNull();
    expect(croppedPages(['2'], 6)).toEqual([2]);
    // The grammar, expanded by the contracts package rather than by a second parser here.
    expect(croppedPages(['1-3', '6'], 6)).toEqual([1, 2, 3, 6]);
    expect(croppedPages(['9-5'], 6)).toEqual([]);
    // Before the document is counted a selection cannot be resolved, and `null` (every page) is not the answer either:
    // it is the state the board draws nothing for, which is why the strip is only drawn once the count is known.
    expect(croppedPages(['1-3'], null)).toBeNull();
  });

  test('membership follows the value, and "every page" is a member of itself', () => {
    expect(isCropped(undefined, 4, 6)).toBe(true);
    expect(isCropped(['1-3'], 2, 6)).toBe(true);
    expect(isCropped(['1-3'], 4, 6)).toBe(false);
  });

  test('a toggle writes the set the click produced, and splits a range it lands inside', () => {
    // Off a range's middle: the set changed, so the spelling follows it.
    expect(toggleCroppedPage({ value: ['1-5'], page: 3, pageCount: 6 })).toEqual(['1-2', '4-5']);
    // On, from a selection that does not name it.
    expect(toggleCroppedPage({ value: ['1-2'], page: 5, pageCount: 6 })).toEqual(['1-2', '5']);
    // The first click on a document nobody has selected: the empty value means *every* page, so taking one page out is
    // the complement — and that is the reading a naive toggle (which would answer `['3']`) gets backwards.
    expect(toggleCroppedPage({ value: undefined, page: 3, pageCount: 6 })).toEqual(['1-2', '4-6']);
    // …and putting it back is the whole document again, which has one spelling: no value at all.
    expect(toggleCroppedPage({ value: ['1-2', '4-6'], page: 3, pageCount: 6 })).toBeUndefined();
  });

  test('it refuses to write the two states that cannot mean what the click says', () => {
    // A page the document does not have, and a document whose length is unknown: the tile is not drawn for either, and
    // the model refuses rather than guessing.
    expect(toggleCroppedPage({ value: undefined, page: 7, pageCount: 6 })).toBeNull();
    expect(toggleCroppedPage({ value: undefined, page: 0, pageCount: 6 })).toBeNull();
    expect(toggleCroppedPage({ value: undefined, page: 2, pageCount: null })).toBeNull();
    // **The one-page document.** Taking its only page out of the selection would leave an empty value, and an empty
    // value *is* every page — so the button would crop the page it was asked to spare. `null` is "no write", which the
    // board renders as a disabled toggle (`count === 1`), and the assertion is here because the disabled state is a
    // rendering of this fact rather than a rule of its own.
    expect(toggleCroppedPage({ value: ['1'], page: 1, pageCount: 1 })).toBeNull();
    expect(toggleCroppedPage({ value: undefined, page: 1, pageCount: 1 })).toBeNull();
  });
});
