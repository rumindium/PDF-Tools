import { describe, expect, test } from 'bun:test';
import {
  annotationBox,
  annotationGeometry,
  annotationSummary,
  createAnnotation,
  displayColour,
  moveAnnotation,
  readAnnotations,
} from './annotations';

/**
 * The `annotations` shape, tested where it differs from `edit-pdf`'s elements.
 *
 * The interesting cases are not the arithmetic — that is `geometry.ts`'s, and it is shared — but the three things this
 * contract does differently: a mark carries a *list* of rectangles, a note is a point rather than a box, and a mark with
 * no colour keeps the schema's default instead of one this module invents.
 */

const highlight = (rects: Array<{ x: number; y: number; width: number; height: number }>) => ({
  type: 'highlight',
  page: 2,
  rects,
  color: '#ffe066',
});

describe('reading the option value', () => {
  test('a markup mark becomes one canvas mark, keeping every rectangle', () => {
    const items = readAnnotations([highlight([{ x: 10, y: 20, width: 100, height: 12 }])]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('highlight');
    expect(items[0]?.page).toBe(2);
    // The entry is carried through whole, so a field the schema accepted is not lost by the canvas.
    expect(items[0]?.entry.color).toBe('#ffe066');
    expect((items[0]?.entry.rects as unknown[]).length).toBe(1);
  });

  test('a note is read from its point, not from rectangles', () => {
    const items = readAnnotations([{ type: 'note', page: 1, x: 30, y: 40, text: 'check this' }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('note');
    expect(annotationBox(items[0]!)).toEqual({ x: 30, y: 40, width: 20, height: 20 });
  });

  test('an entry the canvas cannot draw is dropped rather than guessed at', () => {
    // No rectangles: the schema requires at least one, so this is input the API would refuse. Drawing it as a default
    // box would place a mark nobody asked for.
    expect(readAnnotations([{ type: 'underline', page: 1, rects: [] }])).toEqual([]);
    expect(readAnnotations([{ type: 'sticky', page: 1, rects: [] }])).toEqual([]);
    expect(readAnnotations([{ type: 'note', page: 1, text: 'no point' }])).toEqual([]);
    expect(readAnnotations('[]')).toEqual([]);
    expect(readAnnotations(undefined)).toEqual([]);
  });
});

describe('the box the canvas draws', () => {
  test('a multi-rectangle mark is the union of its rectangles, not its first one', () => {
    const items = readAnnotations([
      highlight([
        { x: 30, y: 700, width: 200, height: 12 },
        { x: 30, y: 684, width: 180, height: 12 },
      ]),
    ]);
    expect(annotationBox(items[0]!)).toEqual({ x: 30, y: 684, width: 200, height: 28 });
  });
});

describe('moving a mark', () => {
  test('a single-rectangle mark is written exactly', () => {
    const items = readAnnotations([highlight([{ x: 30, y: 700, width: 200, height: 12 }])]);
    const moved = moveAnnotation(items[0]!, { x: 60, y: 287.25, width: 200, height: 12 });
    expect(moved.entry.rects).toEqual([{ x: 60, y: 287.25, width: 200, height: 12 }]);
  });

  test('a multi-rectangle mark moves as a unit, keeping the gap between its rectangles', () => {
    const items = readAnnotations([
      highlight([
        { x: 30, y: 700, width: 200, height: 12 },
        { x: 30, y: 684, width: 180, height: 12 },
      ]),
    ]);
    const moved = moveAnnotation(items[0]!, { x: 130, y: 674, width: 200, height: 28 });
    const rects = moved.entry.rects as Array<Record<string, number>>;
    // Translated by (+100, −10) with the size unchanged: the second line is still 16 pt below the first, and still
    // left-aligned with it. Scaling it here would have collapsed the mark onto one line instead of moving it.
    expect(rects[0]).toEqual({ x: 130, y: 690, width: 200, height: 12 });
    expect(rects[1]).toEqual({ x: 130, y: 674, width: 180, height: 12 });
  });

  test('resizing a mark scales its rectangles about the union box', () => {
    const items = readAnnotations([
      highlight([
        { x: 30, y: 700, width: 200, height: 12 },
        { x: 30, y: 684, width: 180, height: 12 },
      ]),
    ]);
    const target = { x: 30, y: 684, width: 400, height: 56 };
    const scaled = moveAnnotation(items[0]!, target);
    const rects = scaled.entry.rects as Array<{ x: number; y: number; width: number; height: number }>;
    expect(rects[0]?.width).toBe(400);
    // Doubling the union doubles both lines, and the mark still fills exactly the box that was dragged.
    expect(rects[1]?.width).toBe(360);
    expect(annotationBox(scaled)).toEqual(target);
  });

  test('a note is moved by its point', () => {
    const items = readAnnotations([{ type: 'note', page: 1, x: 30, y: 40, text: 'hi' }]);
    const moved = moveAnnotation(items[0]!, { x: 100, y: 200, width: 20, height: 20 });
    expect(moved.entry).toMatchObject({ x: 100, y: 200 });
    expect(moved.entry.rects).toBeUndefined();
  });
});

describe('creating a mark', () => {
  test('markup is created with one rectangle and no colour of its own', () => {
    const created = createAnnotation('strike', 3, { x: 60, y: 287.25, width: 200, height: 4 });
    expect(created.entry).toEqual({
      type: 'strike',
      page: 3,
      rects: [{ x: 60, y: 287.25, width: 200, height: 4 }],
    });
    // The colour is the schema's to supply; writing this module's copy would make the canvas the second source of truth.
    expect(created.entry.color).toBeUndefined();
    expect(displayColour(created)).toBe('#d93025');
  });

  test('a note is created with the text field the schema requires, empty and flagged in the list', () => {
    const created = createAnnotation('note', 1, { x: 100, y: 200, width: 20, height: 20 });
    expect(created.entry).toEqual({ type: 'note', page: 1, x: 100, y: 200, text: '' });
    expect(annotationSummary(created)).toBe('Empty note');
  });
});

describe('how a mark is placed', () => {
  test('markup is dragged out, a note is clicked', () => {
    expect(annotationGeometry('highlight')).toBe('box');
    expect(annotationGeometry('underline')).toBe('box');
    expect(annotationGeometry('strike')).toBe('box');
    expect(annotationGeometry('note')).toBe('point');
  });

  test('a mark that was recoloured reports its own colour', () => {
    const items = readAnnotations([{ ...highlight([{ x: 1, y: 2, width: 3, height: 4 }]), color: '#123456' }]);
    expect(displayColour(items[0]!)).toBe('#123456');
  });
});
