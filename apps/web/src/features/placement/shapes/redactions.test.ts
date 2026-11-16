import { describe, expect, test } from 'bun:test';
import {
  createRedaction,
  displayFill,
  moveRedaction,
  readRedactions,
  redactionBox,
  redactionGeometry,
  redactionSummary,
} from './redactions';

/**
 * The `redactions` shape, tested where it differs from the other three.
 *
 * The arithmetic is `geometry.ts`'s and is shared; what belongs to this contract is the rectangle spelling (`w`/`h`,
 * which no other shape uses), the region that groups rectangles under one page and one optional fill, and the rule that
 * a region with nothing to remove is dropped rather than guessed at.
 */

const region = (rects: Array<Record<string, number>>, extra: Record<string, unknown> = {}) => ({
  page: 2,
  rects,
  ...extra,
});

describe('reading the option value', () => {
  test('a region becomes one canvas mark, keeping every rectangle', () => {
    const items = readRedactions([region([{ x: 10, y: 20, w: 100, h: 12 }], { fill: '#ff0000' })]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('box');
    expect(items[0]?.page).toBe(2);
    expect(items[0]?.entry.fill).toBe('#ff0000');
    expect((items[0]?.entry.rects as unknown[]).length).toBe(1);
  });

  test('a region with no rectangles is dropped rather than given a default box', () => {
    expect(readRedactions([region([])])).toEqual([]);
    expect(readRedactions([{ page: 1, rects: 'nope' }])).toEqual([]);
    expect(readRedactions([null, 7, 'x'])).toEqual([]);
    expect(readRedactions(undefined)).toEqual([]);
  });

  test('the rectangles keep the contract spelling, not the canvas’s', () => {
    const items = readRedactions([region([{ x: 10, y: 20, w: 100, h: 12 }])]);
    const rects = items[0]?.entry.rects as Array<Record<string, number>>;
    expect(rects[0]).toEqual({ x: 10, y: 20, w: 100, h: 12 });
    expect(rects[0]?.width).toBeUndefined();
  });
});

describe('the box the canvas draws', () => {
  test('a multi-rectangle region is the union of its rectangles, not its first one', () => {
    const items = readRedactions([
      region([
        { x: 30, y: 700, w: 200, h: 12 },
        { x: 30, y: 684, w: 180, h: 12 },
      ]),
    ]);
    expect(redactionBox(items[0]!)).toEqual({ x: 30, y: 684, width: 200, height: 28 });
  });
});

describe('moving a region', () => {
  test('a single-rectangle region is written exactly', () => {
    const items = readRedactions([region([{ x: 30, y: 700, w: 200, h: 12 }])]);
    const moved = moveRedaction(items[0]!, { x: 60, y: 287.25, width: 200, height: 12 });
    expect(moved.entry.rects).toEqual([{ x: 60, y: 287.25, w: 200, h: 12 }]);
  });

  test('a multi-rectangle region moves as a unit, keeping the gap between its rectangles', () => {
    const items = readRedactions([
      region([
        { x: 30, y: 700, w: 200, h: 12 },
        { x: 30, y: 684, w: 180, h: 12 },
      ]),
    ]);
    const moved = moveRedaction(items[0]!, { x: 130, y: 674, width: 200, height: 28 });
    const rects = moved.entry.rects as Array<Record<string, number>>;
    expect(rects[0]).toEqual({ x: 130, y: 690, w: 200, h: 12 });
    expect(rects[1]).toEqual({ x: 130, y: 674, w: 180, h: 12 });
  });

  test('resizing a region scales its rectangles about the union box', () => {
    const items = readRedactions([
      region([
        { x: 30, y: 700, w: 200, h: 12 },
        { x: 30, y: 684, w: 180, h: 12 },
      ]),
    ]);
    const target = { x: 30, y: 684, width: 400, height: 56 };
    const scaled = moveRedaction(items[0]!, target);
    const rects = scaled.entry.rects as Array<Record<string, number>>;
    expect(rects[0]?.w).toBe(400);
    expect(rects[1]?.w).toBe(360);
    expect(redactionBox(scaled)).toEqual(target);
  });
});

describe('creating a region', () => {
  test('a new box is one rectangle and no fill of its own', () => {
    const created = createRedaction(3, { x: 60, y: 287.25, width: 240, height: 18 });
    expect(created.entry).toEqual({ page: 3, rects: [{ x: 60, y: 287.25, w: 240, h: 18 }] });
    // The job-wide `fill` stays the only fill in force until the user overrides it.
    expect(created.entry.fill).toBeUndefined();
    expect(displayFill(created)).toBe('#000000');
  });

  test('a region that was recoloured reports its own colour', () => {
    const items = readRedactions([region([{ x: 1, y: 2, w: 3, h: 4 }], { fill: '#123456' })]);
    expect(displayFill(items[0]!)).toBe('#123456');
  });

  test('the summary names the box, the rectangle count and any fill', () => {
    const single = createRedaction(1, { x: 60, y: 287.25, width: 240, height: 18 });
    expect(redactionSummary(single)).toBe('240 × 18 pt at 60, 287');
    const grouped = readRedactions([
      region(
        [
          { x: 30, y: 700, w: 200, h: 12 },
          { x: 30, y: 684, w: 180, h: 12 },
        ],
        { fill: '#123456' },
      ),
    ]);
    expect(redactionSummary(grouped[0]!)).toBe('200 × 28 pt at 30, 684 · 2 rectangles · fill #123456');
  });
});

describe('how a box is placed', () => {
  test('a box is dragged out, never clicked into existence at a point', () => {
    expect(redactionGeometry()).toBe('box');
  });
});
