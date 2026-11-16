import { describe, expect, test } from 'bun:test';
import type { PlacementItem } from '../adapter';
import { MIN_BOX_POINTS } from '../geometry';
import {
  SIGNATURE_CANVAS_UNITS,
  SIGNATURE_DEFAULT_SIZE,
  SIGNATURE_DEFAULT_UNIT,
  createSignature,
  moveSignature,
  pointsToUnit,
  readSignatures,
  signatureBox,
  signatureGeometry,
  signatureSummary,
  unitToPoints,
} from './signature';

/**
 * The `signature` shape, tested where it differs from the other two shapes.
 *
 * The arithmetic is not the interesting part — the canvas's `geometry.ts` owns that, and `annotations.test.ts` pins it.
 * What is only true here is that **the entry's numbers are in its own `units`**, millimetres included, and that a
 * `percent` entry is refused a box instead of being resolved against a page this module does not have. Those two are
 * what a wrong implementation gets wrong in a way that still produces a valid job and a valid PDF: a signature at the
 * right size, 2.83× too far from the corner, or a percentage quietly read as points by a preview that guessed a page.
 */

describe('reading the option value', () => {
  test('a placement becomes one canvas mark, carried through whole', () => {
    const items = readSignatures([{ page: 2, x: 100, y: 400, w: 220, h: 70, units: 'pt', borderColor: '#9aa0a6' }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('signature');
    expect(items[0]?.page).toBe(2);
    // A field the schema accepted must survive the canvas, or moving the mark would delete it.
    expect(items[0]?.entry.borderColor).toBe('#9aa0a6');
  });

  test('an entry with no usable box is dropped rather than guessed at', () => {
    // `SignaturePlacement` requires a positive width and height, so these are payloads the API would refuse. Drawing a
    // default box instead would put a signature on a page where nobody asked for one.
    expect(readSignatures([{ page: 1, x: 10, y: 10, w: 0, h: 60 }])).toEqual([]);
    expect(readSignatures([{ page: 1, x: 10, y: 10, w: 60, h: -1 }])).toEqual([]);
    expect(readSignatures([{ page: 1, w: 60, h: 60 }])).toEqual([]);
    expect(readSignatures('[]')).toEqual([]);
    expect(readSignatures(undefined)).toEqual([]);
  });

  test('a percent entry is kept, because dropping it would delete it on the next drag', () => {
    const items = readSignatures([{ page: 1, x: 10, y: 10, w: 20, h: 5, units: 'percent' }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.entry.units).toBe('percent');
  });
});

describe('the box the canvas draws', () => {
  test('points pass through unchanged', () => {
    const items = readSignatures([{ page: 1, x: 100, y: 400, w: 220, h: 70, units: 'pt' }]);
    expect(signatureBox(items[0]!)).toEqual({ x: 100, y: 400, width: 220, height: 70 });
  });

  test('millimetres are converted, not read as points', () => {
    // 100 mm is 283.46 pt. An implementation that skipped the conversion would draw the mark at 100 pt — on the page,
    // the right size, in the wrong place, which is the failure this assertion exists for.
    const items = readSignatures([{ page: 1, x: 100, y: 50, w: 50, h: 20, units: 'mm' }]);
    const box = signatureBox(items[0]!);
    expect(box?.x).toBeCloseTo(283.46, 2);
    expect(box?.y).toBeCloseTo(141.73, 2);
    expect(box?.width).toBeCloseTo(141.73, 2);
  });

  test('a percent entry reports no box, because this module has no page to resolve it against', () => {
    const items = readSignatures([{ page: 1, x: 40, y: 60, w: 20, h: 10, units: 'percent' }]);
    expect(signatureBox(items[0]!)).toBeNull();
  });

  test('a missing unit is the schema default, not a third behaviour', () => {
    const items = readSignatures([{ page: 1, x: 10, y: 20, w: 30, h: 40 }]);
    expect(signatureBox(items[0]!)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});

describe('moving a placement', () => {
  test('a pt entry is written in points', () => {
    const items = readSignatures([{ page: 1, x: 10, y: 20, w: 30, h: 40, units: 'pt' }]);
    const moved = moveSignature(items[0]!, { x: 60, y: 287.25, width: 200, height: 50 });
    expect(moved.entry).toMatchObject({ page: 1, x: 60, y: 287.25, w: 200, h: 50, units: 'pt' });
  });

  test('an mm entry is written in millimetres — the conversion happens on the way out, not on the way in', () => {
    const items = readSignatures([{ page: 1, x: 28.35, y: 141.73, w: 70.87, h: 14.17, units: 'mm' }]);
    const moved = moveSignature(items[0]!, { x: 141.73, y: 283.46, width: 70.87, height: 14.17 });
    // Exactly 50 mm right and 50 mm up: a module that wrote points would have written 141.73 where 50 belongs, and the
    // mark would then be 4× further right on the next render while the row still said "mm".
    expect(moved.entry.units).toBe('mm');
    expect(moved.entry.x).toBeCloseTo(50, 2);
    expect(moved.entry.y).toBeCloseTo(100, 2);
    expect(moved.entry.w).toBeCloseTo(25, 2);
  });

  test('an entry with no unit gains the canvas default, so the row and the engine cannot disagree', () => {
    const item: PlacementItem = { kind: 'signature', page: 1, entry: { page: 1, x: 10, y: 20, w: 30, h: 40 } };
    const moved = moveSignature(item, { x: 10, y: 20, width: 30, height: 40 });
    expect(moved.entry.units).toBe(SIGNATURE_DEFAULT_UNIT);
  });

  test('a percent entry is not written at all — a drag must not convert it into points behind the user', () => {
    const items = readSignatures([{ page: 1, x: 40, y: 60, w: 20, h: 10, units: 'percent' }]);
    const moved = moveSignature(items[0]!, { x: 100, y: 100, width: 100, height: 50 });
    expect(moved).toBe(items[0]!);
  });

  test('a box smaller than the minimum is raised, not written as a sub-pixel mark', () => {
    const item = createSignature(1, { x: 10, y: 20, width: 1, height: 1 });
    const moved = moveSignature(item, { x: 10, y: 20, width: 0.5, height: 0.5 });
    expect(moved.entry.w as number).toBeGreaterThanOrEqual(MIN_BOX_POINTS);
    expect(moved.entry.h as number).toBeGreaterThanOrEqual(MIN_BOX_POINTS);
  });
});

describe('creating a placement', () => {
  test('a new signature is points by default, written explicitly', () => {
    const created = createSignature(2, { x: 72, y: 300, width: 180, height: 60 });
    expect(created).toEqual({
      kind: 'signature',
      page: 2,
      entry: { page: 2, x: 72, y: 300, w: 180, h: 60, units: 'pt' },
    });
  });

  test('it is a rectangle, not a point — the box is the size the image is drawn at', () => {
    expect(signatureGeometry()).toBe('box');
    expect(SIGNATURE_DEFAULT_SIZE.width).toBeGreaterThan(SIGNATURE_DEFAULT_SIZE.height);
  });
});

describe('the unit conversions', () => {
  test('the two directions are each other\u2019s inverse', () => {
    for (const unit of SIGNATURE_CANVAS_UNITS) {
      for (const points of [1, 72, 283.46, 595.28]) {
        expect(unitToPoints(pointsToUnit(points, unit), unit)).toBeCloseTo(points, 1);
      }
    }
  });

  test('72 pt is 25.4 mm — the definition, not a rounded constant', () => {
    expect(pointsToUnit(72, 'mm')).toBeCloseTo(25.4, 2);
    expect(unitToPoints(25.4, 'mm')).toBeCloseTo(72, 2);
  });
});

describe('what the list calls one placement', () => {
  test('it reports the numbers in the unit that will be sent', () => {
    const items = readSignatures([{ page: 3, x: 50, y: 100, w: 70.87, h: 21.17, units: 'mm' }]);
    const summary = signatureSummary(items[0]!);
    expect(summary).toContain('page 3');
    expect(summary).toContain('70.87 × 21.17 mm');
  });

  test('a percent entry says why it cannot be edited by dragging', () => {
    const items = readSignatures([{ page: 1, x: 40, y: 60, w: 20, h: 10, units: 'percent' }]);
    expect(signatureSummary(items[0]!)).toContain('share of the page');
  });
});

describe('the page it is on', () => {
  test('the canvas data and the mark agree on the page, and a fractional page is rounded once', () => {
    const item = createSignature(2.4, { x: 0, y: 0, width: 180, height: 60 });
    expect(item.page).toBe(2.4);
    const moved = moveSignature(item, { x: 0, y: 0, width: 180, height: 60 });
    expect(moved.page).toBe(2);
    expect(moved.entry.page).toBe(2);
  });

  test('a page below 1 is raised rather than sent as 0', () => {
    const item: PlacementItem = {
      kind: 'signature',
      page: 0,
      entry: { page: 0, units: 'pt', x: 1, y: 1, w: 10, h: 10 },
    };
    expect(moveSignature(item, { x: 0, y: 0, width: 10, height: 10 }).page).toBe(1);
  });
});
