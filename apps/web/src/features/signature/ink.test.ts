import { describe, expect, test } from 'bun:test';
import {
  EXPORT_SCALE,
  INK_PADDING,
  MAX_INK_ASPECT,
  MIN_INK_SIDE,
  type Stroke,
  exportSize,
  hasSignatureInk,
  inkBounds,
  placementForInk,
  strokePath,
  trimRect,
} from './ink';

/**
 * The pad's arithmetic, tested without a browser.
 *
 * Every one of these is a decision that is invisible in a screenshot and consequential in the signed document: how much
 * of the pad is exported (an untrimmed export puts a small signature in a big empty box), what counts as a signature
 * (a tap is not one), and whether ink a pointer drew past the edge shifts the whole image. The canvas is where the
 * pixels come from; this is where the rectangle does.
 */

const PAD = { width: 520, height: 200 };
const line = (points: Array<[number, number]>): Stroke => points.map(([x, y]) => ({ x, y }));

describe('where the ink is', () => {
  test('the bounds contain every stroke, not the last one', () => {
    const bounds = inkBounds([
      line([
        [10, 20],
        [30, 20],
      ]),
      line([
        [5, 60],
        [100, 15],
      ]),
    ]);
    expect(bounds).toEqual({ left: 5, top: 15, right: 100, bottom: 60 });
  });

  test('nothing usable drawn is null, not an empty rectangle at the origin', () => {
    expect(inkBounds([])).toBeNull();
    expect(inkBounds([[]])).toBeNull();
    // A `NaN` would otherwise spread into every number computed from the bounds and show up as a full-page export.
    expect(
      inkBounds([
        line([
          [Number.NaN, 10],
          [Number.POSITIVE_INFINITY, 20],
        ]),
      ]),
    ).toBeNull();
  });

  test('a single tap still has bounds — it is the caller that decides it is not a signature', () => {
    expect(inkBounds([line([[40, 40]])])).toEqual({ left: 40, top: 40, right: 40, bottom: 40 });
  });
});

describe('what gets exported', () => {
  test('the rectangle is cropped to the ink plus padding', () => {
    const rect = trimRect({ left: 100, top: 50, right: 300, bottom: 150 }, PAD);
    expect(rect).toEqual({
      x: 100 - INK_PADDING,
      y: 50 - INK_PADDING,
      width: 200 + INK_PADDING * 2,
      height: 100 + INK_PADDING * 2,
    });
  });

  test('ink drawn past the pad is clipped, so the image does not shift', () => {
    // Pointer capture keeps delivering points after the pointer leaves the surface, so this is the normal case for a
    // stroke that runs off the edge. Copying a rectangle that starts outside the canvas moves the whole export.
    const rect = trimRect({ left: -40, top: -10, right: 600, bottom: 260 }, PAD);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(PAD.width);
    expect(rect.height).toBe(PAD.height);
  });

  test('a rectangle is never degenerate, whatever it was measured from', () => {
    const rect = trimRect({ left: 500, top: 190, right: 500, bottom: 190 }, PAD);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  test('the export is rasterised up, so a printed signature has no stair-steps', () => {
    const size = exportSize({ x: 0, y: 0, width: 200, height: 100 });
    expect(size).toEqual({ width: 200 * EXPORT_SCALE, height: 100 * EXPORT_SCALE });
  });

  test('a sub-pixel rectangle still produces an image canvas, which is what drawImage requires', () => {
    expect(exportSize({ x: 0, y: 0, width: 0.2, height: 0.2 })).toEqual({ width: 1, height: 1 });
  });
});

describe('what counts as a signature', () => {
  test('a tap is not one', () => {
    expect(hasSignatureInk(inkBounds([line([[40, 40]])]))).toBe(false);
  });

  test('a short stroke is not one either — a smudge scaled into the box is not a signature', () => {
    const bounds = inkBounds([
      line([
        [40, 40],
        [40 + MIN_INK_SIDE - 1, 40 + MIN_INK_SIDE - 1],
      ]),
    ]);
    expect(hasSignatureInk(bounds)).toBe(false);
  });

  test('a stroke that spans both axes is one', () => {
    const bounds = inkBounds([
      line([
        [40, 40],
        [140, 90],
      ]),
    ]);
    expect(hasSignatureInk(bounds)).toBe(true);
  });

  test('nothing drawn is not a signature', () => {
    expect(hasSignatureInk(null)).toBe(false);
  });

  test('a dot with no canvas is not a signature', () => {
    const bounds = inkBounds([line([[10, 10]])]);
    expect(bounds).not.toBeNull();
    expect(hasSignatureInk(bounds)).toBe(false);
  });
});

describe('the box the ink deserves', () => {
  test('the ink\u2019s aspect ratio is kept, at the contract\u2019s own height', () => {
    const box = placementForInk({ x: 0, y: 0, width: 200, height: 50 }, { width: 180, height: 60 });
    expect(box.height).toBe(60);
    // 4:1 ink, so 240 pt wide — not the 180 pt the default would have stretched it into.
    expect(box.width).toBe(240);
  });

  test('a tall drawing is not stretched to be wide', () => {
    const box = placementForInk({ x: 0, y: 0, width: 50, height: 100 }, { width: 180, height: 60 });
    expect(box).toEqual({ width: 30, height: 60 });
  });

  test('one long horizontal stroke does not suggest a box wider than the paper', () => {
    // 300 × 6 px of ink is a real thing to draw (a single stroke, no lift), and 50:1 would suggest a 3 000 pt box on a
    // 595 pt page. The cap is what keeps the suggestion useful rather than comical.
    const box = placementForInk({ x: 0, y: 0, width: 300, height: 6 }, { width: 180, height: 60 });
    expect(box.width).toBe(60 * MAX_INK_ASPECT);
  });

  test('a rectangle with no height cannot produce an infinite width', () => {
    const box = placementForInk({ x: 0, y: 0, width: 200, height: 0 }, { width: 180, height: 60 });
    expect(Number.isFinite(box.width)).toBe(true);
    expect(box.width).toBe(60 * MAX_INK_ASPECT);
  });
});

describe('the stroke as a path', () => {
  test('a stroke is a move followed by lines', () => {
    expect(
      strokePath(
        line([
          [1, 2],
          [3, 4],
          [5, 6],
        ]),
      ),
    ).toBe('M 1 2 L 3 4 L 5 6');
  });

  test('a single point becomes a zero-length line with a round cap, which is a dot', () => {
    expect(strokePath(line([[7, 8]]))).toBe('M 7 8 l 0.01 0');
  });

  test('an unusable point is dropped rather than written into the path', () => {
    expect(
      strokePath([
        { x: Number.NaN, y: 1 },
        { x: 3, y: 4 },
      ]),
    ).toBe('M 3 4 l 0.01 0');
  });
});
