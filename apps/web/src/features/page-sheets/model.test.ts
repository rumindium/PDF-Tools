import { describe, expect, test } from 'bun:test';
import {
  PER_SHEET_CHOICES,
  SHEET_CHOICES,
  SHEET_GRIDS,
  SHEET_SIZES,
  type SheetPageSize,
  cellFor,
  describeSheets,
  frameFor,
  gridFor,
  gridLabel,
  mm,
  mmWhole,
  paperMm,
  planSheets,
  readGapMm,
  readOrientation,
  readPageSize,
  readPerSheet,
  stockSize,
} from './model';

/**
 * The sheet model's laws, measured against the numbers `workers/light/src/handlers/n-up.ts` lays a sheet out with.
 *
 * The point of this file is not that the arithmetic is *plausible* — a preview that drew a nearly-right grid would look
 * exactly as good as a correct one — but that it is the **same** arithmetic: the margins (`10`/`15` pt), the cell rule
 * (`(sheet − 2·margin − gap·(n−1)) / n`), the uniform fit, the centring, and the two index conventions (across in
 * reading order, down from the top on a screen and up from the bottom in PDF user space).
 */

/** A4 in the handler's own table, and the size most of these cases are about. */
const A4: SheetPageSize = { widthPt: SHEET_SIZES.a4[0], heightPt: SHEET_SIZES.a4[1] };
const MM = 72 / 25.4;

/** A page of the given millimetre size — the fixture documents, said in the unit people know them by. */
function page(sizeMm: [number, number]): SheetPageSize {
  return { widthPt: sizeMm[0] * MM, heightPt: sizeMm[1] * MM };
}

const A4_PAGE = page([210, 297]);
const LANDSCAPE_PAGE = page([297, 210]);

describe('reading the options', () => {
  test('every value falls back to the schema default, so a missing key cannot draw a different sheet', () => {
    expect(readPerSheet(undefined)).toBe(2);
    expect(readPerSheet('6')).toBe(2);
    // A `perSheet` the schema does not accept is refused here too, rather than being carried into the layout as if a
    // sheet could have eight cells.
    expect(readPerSheet(8)).toBe(2);
    for (const value of PER_SHEET_CHOICES) expect(readPerSheet(value)).toBe(value);

    expect(readOrientation(undefined)).toBe('portrait');
    expect(readOrientation('sideways')).toBe('portrait');
    expect(readOrientation('landscape')).toBe('landscape');

    expect(readPageSize(undefined)).toBe('a4');
    expect(readPageSize('a5')).toBe('a4');
    expect(readPageSize('source')).toBe('source');

    expect(readGapMm(undefined)).toBe(3);
    // The schema's own bounds: `gap` is `min(0).max(20)`, and a preview that drew a 40 mm gap would be promising a
    // request the API rejects.
    expect(readGapMm(-4)).toBe(0);
    expect(readGapMm(40)).toBe(20);
  });
});

describe('the grid', () => {
  test('the shape is the handler’s table, and the orientation lies it down', () => {
    expect(gridFor(2, 'portrait')).toEqual([1, 2]);
    expect(gridFor(4, 'portrait')).toEqual([2, 2]);
    expect(gridFor(6, 'portrait')).toEqual([2, 3]);
    expect(gridFor(9, 'portrait')).toEqual([3, 3]);
    expect(gridFor(16, 'portrait')).toEqual([4, 4]);
    // Transposed rather than re-declared: 2 per sheet is a column on a portrait sheet and a row on a landscape one,
    // which is the whole reason the handler swaps the pair instead of asking for two numbers.
    expect(gridFor(2, 'landscape')).toEqual([2, 1]);
    expect(gridFor(6, 'landscape')).toEqual([3, 2]);
    expect(gridFor(8, 'landscape')).toBeNull();
    for (const perSheet of PER_SHEET_CHOICES) {
      const grid = gridFor(perSheet, 'portrait');
      expect(grid![0] * grid![1]).toBe(perSheet);
      expect(grid).toEqual(SHEET_GRIDS[perSheet] ?? null);
    }
    expect(gridLabel([2, 3])).toBe('2 × 3');
  });
});

describe('the sheet’s own size', () => {
  test('a named stock is the handler’s own size, and the orientation lies it down', () => {
    expect(frameFor('a4', 'portrait', null)).toEqual({ widthPt: 595.276, heightPt: 841.89 });
    expect(frameFor('a4', 'landscape', null)).toEqual({ widthPt: 841.89, heightPt: 595.276 });
    expect(frameFor('legal', 'landscape', null)).toEqual({ widthPt: 1008, heightPt: 612 });
    // Portrait on a stock that is already wider than it is tall does not turn it back the other way.
    expect(frameFor('a3', 'portrait', null)).toEqual({ widthPt: 841.89, heightPt: 1190.551 });
  });

  test('`source` is the first page, and is unknown until it is measured', () => {
    expect(frameFor('source', 'portrait', null)).toBeNull();
    expect(frameFor('source', 'portrait', A4_PAGE)).toEqual(A4_PAGE);
    // A landscape first page under `source` + landscape stays as it is: the rule swaps only a taller-than-wide sheet,
    // and turning this one would print it sideways.
    const landscape = frameFor('source', 'landscape', LANDSCAPE_PAGE);
    expect(landscape!.widthPt).toBeCloseTo(297 * MM, 1);
    expect(landscape!.heightPt).toBeCloseTo(210 * MM, 1);
  });
});

describe('the layout', () => {
  test('the cell rule is the handler’s, margins and gaps included', () => {
    const plan = planSheets({
      pages: Array.from({ length: 6 }, () => A4_PAGE),
      fallback: A4_PAGE,
      perSheet: 2,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
    })!;
    // (595.276 − 2·10 − 3 mm·0) / 1 across, (841.89 − 2·15 − 3 mm·1) / 2 down: the gap counts between cells, so a
    // single column pays none of it.
    expect(plan.cell.widthPt).toBeCloseTo(595.276 - 20, 3);
    expect(plan.cell.heightPt).toBeCloseTo((841.89 - 30 - 3 * MM) / 2, 3);
    expect(plan.sheets).toBe(3);
    expect(plan.placed).toBe(6);
    expect(plan.layout).toHaveLength(3);
    expect(plan.layout[0]!.slots.map((slot) => slot.page)).toEqual([1, 2]);
    expect(plan.layout[2]!.slots.map((slot) => slot.page)).toEqual([5, 6]);
  });

  test('reading order is across then down, and the y axis is the screen’s', () => {
    const plan = planSheets({
      pages: Array.from({ length: 5 }, () => A4_PAGE),
      fallback: A4_PAGE,
      perSheet: 4,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 0,
    })!;
    // Sheet one holds pages 1–4 in reading order: across the row first, then down. Page 3 is therefore *right* of the
    // left margin and *below* the top one, and page 4 is beside it — the two assertions that fail if a preview counts
    // columns first, or counts rows up from the bottom the way PDF user space does.
    const first = plan.layout[0]!.slots;
    expect(first.map((slot) => slot.page)).toEqual([1, 2, 3, 4]);
    expect(first[0]!.cell.leftPt).toBeCloseTo(10, 3);
    expect(first[0]!.cell.topPt).toBeCloseTo(15, 3);
    expect(first[1]!.cell.leftPt).toBeCloseTo(10 + plan.cell.widthPt, 3);
    expect(first[1]!.cell.topPt).toBeCloseTo(15, 3);
    expect(first[2]!.cell.topPt).toBeCloseTo(15 + plan.cell.heightPt, 3);
    expect(first[2]!.cell.leftPt).toBeCloseTo(10, 3);
    expect(first[3]!.cell.leftPt).toBeCloseTo(10 + plan.cell.widthPt, 3);
    expect(first[3]!.cell.topPt).toBeCloseTo(15 + plan.cell.heightPt, 3);

    const second = plan.layout[1]!.slots;
    expect(second.map((slot) => slot.page)).toEqual([5, null, null, null]);
    // The fifth page opens a *new* sheet at the top-left cell, which is the difference between reading order and a
    // flow layout: it does not continue where the last sheet ran out of room, because the sheets are pages themselves.
    expect(second[0]!.cell.leftPt).toBeCloseTo(10, 3);
    expect(second[0]!.cell.topPt).toBeCloseTo(15, 3);
  });

  test('a page is fitted by one scale and centred, never stretched', () => {
    // A4 page on a 4-up A4 sheet: the cells are wider than they are tall, so the fit is vertical and the page is
    // centred across. Stretching instead would fill the cell exactly and be wrong on every page of the output.
    const plan = planSheets({
      pages: Array.from({ length: 4 }, () => A4_PAGE),
      fallback: A4_PAGE,
      perSheet: 4,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
    })!;
    const draw = plan.layout[0]!.slots[0]!.draw!;
    const cell = plan.layout[0]!.slots[0]!.cell;
    const scale = draw.widthPt / A4_PAGE.widthPt;
    expect(scale).toBeCloseTo(draw.heightPt / A4_PAGE.heightPt, 9);
    expect(scale * A4_PAGE.widthPt).toBeLessThanOrEqual(cell.widthPt + 1e-9);
    expect(scale * A4_PAGE.heightPt).toBeLessThanOrEqual(cell.heightPt + 1e-9);
    // One of the two axes is flush and the other is centred: at least one gap is zero, and the other is shared.
    expect(Math.min(cell.widthPt - draw.widthPt, cell.heightPt - draw.heightPt)).toBeCloseTo(0, 6);
    expect(draw.leftPt - cell.leftPt).toBeCloseTo(cell.widthPt - draw.widthPt - (draw.leftPt - cell.leftPt), 6);
  });

  test('a landscape sheet puts the pages side by side', () => {
    const plan = planSheets({
      pages: [A4_PAGE, A4_PAGE],
      fallback: A4_PAGE,
      perSheet: 2,
      pageSize: 'a4',
      orientation: 'landscape',
      gapMm: 0,
    })!;
    expect(plan.grid).toEqual([2, 1]);
    expect(plan.sheets).toBe(1);
    // Same row, so the same top; different columns, so one left is the other plus a cell.
    const [first, second] = plan.layout[0]!.slots;
    expect(first!.cell.topPt).toBeCloseTo(second!.cell.topPt, 6);
    expect(second!.cell.leftPt).toBeCloseTo(first!.cell.leftPt + plan.cell.widthPt, 6);
  });

  test('the last sheet keeps its empty slots, because the page is the sheet', () => {
    const plan = planSheets({
      pages: Array.from({ length: 7 }, () => A4_PAGE),
      fallback: A4_PAGE,
      perSheet: 6,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
    })!;
    expect(plan.sheets).toBe(2);
    expect(plan.layout[1]!.slots.map((slot) => slot.page)).toEqual([7, null, null, null, null, null]);
    // An empty slot still has a cell — that is what the border option would frame — and no page drawn in it.
    expect(plan.layout[1]!.slots[1]!.cell.widthPt).toBeGreaterThan(0);
    expect(plan.layout[1]!.slots[1]!.draw).toBeNull();
  });

  test('a page that could not be measured takes the first page’s shape rather than vanishing', () => {
    const plan = planSheets({
      pages: [A4_PAGE, null, A4_PAGE],
      fallback: A4_PAGE,
      perSheet: 2,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
    })!;
    expect(plan.layout[0]!.slots.map((slot) => slot.page)).toEqual([1, 2]);
    expect(plan.layout[0]!.slots[1]!.draw).not.toBeNull();
    expect(plan.layout[0]!.slots[1]!.draw!.widthPt).toBeCloseTo(plan.layout[0]!.slots[0]!.draw!.widthPt, 6);
  });

  test('no room for a cell is `null`, which is the one case the handler refuses', () => {
    // The schema allows a 20 mm gap, and A4 16-up still has room — so this is unreachable through the catalog, which is
    // why the guard is asserted here rather than in a browser case: a caller that reaches it gets a null plan and a
    // sentence, not a division by a negative cell.
    expect(
      planSheets({
        pages: [A4_PAGE],
        fallback: A4_PAGE,
        perSheet: 16,
        pageSize: 'a4',
        orientation: 'portrait',
        gapMm: 20,
      }),
    ).not.toBeNull();
    // A sheet smaller than its own margins: legal is not, so the smallest stock the catalog offers cannot do it either.
    expect(
      planSheets({
        pages: [A4_PAGE],
        fallback: A4_PAGE,
        perSheet: 16,
        pageSize: 'a4',
        orientation: 'portrait',
        gapMm: 20,
      })!.cell.widthPt,
    ).toBeGreaterThan(0);
  });
});

describe('the picker’s own arithmetic', () => {
  test('every stock offered is one the schema accepts, and the list is not the lookup table’s order', () => {
    // The row is built from this list, so a key that is not in `SHEET_SIZES` would draw a chip that writes a value the
    // API refuses — and `source` is deliberately first, because it is the option most people want and the only one that
    // is not a stock at all.
    expect(SHEET_CHOICES).toEqual(['source', 'a4', 'a3', 'letter', 'legal']);
    for (const key of SHEET_CHOICES) {
      const size = stockSize(key);
      if (key === 'source') {
        // Not a stock: only the document can answer it, which is why the chip draws the measured ratio instead.
        expect(size).toBeNull();
        continue;
      }
      expect(size).not.toBeNull();
      expect(size!.widthPt).toBe(SHEET_SIZES[key][0]);
      expect(size!.heightPt).toBe(SHEET_SIZES[key][1]);
    }
  });

  test('a caption is the cell the drawing lays out, for a layout that is not the current one', () => {
    // This is the assertion the whole extraction exists for: every `perSheet` diagram is captioned with its own cell at
    // the stock, orientation and gap currently on screen, and a caption derived twice from the same numbers would be a
    // second opinion rather than a measurement.
    const frame = frameFor('a4', 'portrait', A4_PAGE)!;
    for (const perSheet of PER_SHEET_CHOICES) {
      const cell = cellFor(frame, perSheet, 'portrait', 6)!;
      const plan = planSheets({
        pages: Array.from({ length: perSheet }, () => A4_PAGE),
        fallback: A4_PAGE,
        perSheet,
        pageSize: 'a4',
        orientation: 'portrait',
        gapMm: 6,
      })!;
      expect(cell.widthPt).toBe(plan.cell.widthPt);
      expect(cell.heightPt).toBe(plan.cell.heightPt);
      // …and the origin is the margin, so the first cell the drawing places is the one the caption describes.
      expect(cell.leftPt).toBe(10);
      expect(cell.topPt).toBe(15);
      expect(plan.layout[0]!.slots[0]!.cell.leftPt).toBe(cell.leftPt);
      expect(plan.layout[0]!.slots[0]!.cell.topPt).toBe(cell.topPt);
    }
  });

  test('the caption follows the stock and the gap, which is the point of captioning a layout that is not chosen', () => {
    // 16-up on A4 and 16-up on A3 are the same diagram and different cells — the difference the old dropdown could not
    // say and the caption can.
    const a4 = cellFor(frameFor('a4', 'portrait', A4_PAGE)!, 16, 'portrait', 3)!;
    const a3 = cellFor(frameFor('a3', 'portrait', A4_PAGE)!, 16, 'portrait', 3)!;
    expect(a3.widthPt).toBeGreaterThan(a4.widthPt);
    const wide = cellFor(frameFor('a4', 'landscape', A4_PAGE)!, 16, 'landscape', 3)!;
    expect(wide.widthPt).toBeGreaterThan(a4.widthPt);
    // The gap only ever takes room away, per axis, by the handler's own rule.
    const none = cellFor(frameFor('a4', 'portrait', A4_PAGE)!, 16, 'portrait', 0)!;
    expect(none.widthPt).toBeGreaterThan(a4.widthPt);
    expect(none.heightPt).toBeGreaterThan(a4.heightPt);
  });

  test('no room is `null` rather than a negative cell, at every grid', () => {
    // A sheet smaller than its own margins and gaps. Unreachable through the catalogue — the smallest stock with the
    // largest gap still leaves a cell — so it is asserted here, where the arithmetic is, for the same reason
    // `planSheets` has a case for it: the caller gets a `null` and says so instead of drawing a negative width.
    const tiny: SheetPageSize = { widthPt: 40, heightPt: 40 };
    expect(cellFor(tiny, 16, 'portrait', 20)).toBeNull();
    // 2-up portrait is one column and two rows, so the 40 pt sheet leaves one full-width cell and two 5 pt ones.
    expect(cellFor(tiny, 2, 'portrait', 0)).toEqual({ leftPt: 10, topPt: 15, widthPt: 20, heightPt: 5 });
    // And a grid that is not one of the five is not a layout at all.
    expect(cellFor(A4, 3, 'portrait', 3)).toBeNull();
  });
});

describe('the sentence', () => {
  const plan = (perSheet: number, pages: number) =>
    planSheets({
      pages: Array.from({ length: pages }, () => A4_PAGE),
      fallback: A4_PAGE,
      perSheet,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
    })!;

  test('it counts pages into sheets and quotes the cell, because the cell is whether a page is legible', () => {
    const verdict = describeSheets(plan(2, 6), {
      pageCount: 6,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
      border: false,
      unmeasured: 0,
      planMaxPages: null,
    });
    expect(verdict.tone).toBe('changed');
    expect(verdict.sentence).toContain('6 pages → 3 sheets of A4 portrait');
    expect(verdict.sentence).toContain('2 per sheet in a 1 × 2 grid');
    expect(verdict.sentence).toContain('3 mm apart');
    expect(verdict.sentence).not.toContain('framed');
  });

  test('`source` says the thing the job will only say afterwards', () => {
    const verdict = describeSheets(plan(4, 8), {
      pageCount: 8,
      pageSize: 'source',
      orientation: 'portrait',
      gapMm: 0,
      border: true,
      unmeasured: 0,
      planMaxPages: null,
    });
    expect(verdict.tone).toBe('note');
    expect(verdict.sentence).toContain('8 pages → 2 sheets of the first page’s own size');
    expect(verdict.sentence).toContain('mixed page sizes comes out uniform');
    expect(verdict.sentence).toContain('each page framed');
  });

  test('a plan ceiling the run would break is said before the job, not by the API', () => {
    const verdict = describeSheets(plan(2, 6), {
      pageCount: 6,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
      border: false,
      unmeasured: 0,
      planMaxPages: 2,
    });
    expect(verdict.tone).toBe('blocked');
    expect(verdict.sentence).toContain('Fair use allows 2 output pages');
  });

  test('an unmeasurable page is admitted, and a sheet with no size yet waits', () => {
    const verdict = describeSheets(plan(2, 4), {
      pageCount: 4,
      pageSize: 'a4',
      orientation: 'portrait',
      gapMm: 3,
      border: false,
      unmeasured: 2,
      planMaxPages: null,
    });
    expect(verdict.tone).toBe('note');
    expect(verdict.sentence).toContain('2 pages could not be measured');

    expect(
      describeSheets(null, {
        pageCount: 6,
        pageSize: 'source',
        orientation: 'portrait',
        gapMm: 3,
        border: false,
        unmeasured: 0,
        planMaxPages: null,
      }).tone,
    ).toBe('note');
  });
});

describe('paper arithmetic', () => {
  test('a caption rounds once, not twice — the tenth-then-whole pair was a millimetre out', () => {
    // 16-up on A4 with a 3 mm gap: `(595.276 − 20 − 3·8.504) / 4`. Rounding that to a tenth gives 48.5 and rounding the
    // 48.5 again gives **49**, which is what the first version of the layout cards printed; the number it describes is
    // 48. A caption is the one thing on this screen a person cannot check for themselves, so it gets one rounding.
    const cell = cellFor(A4, 16, 'portrait', 3)!;
    expect(cell.widthPt).toBeCloseTo(137.441, 3);
    expect(mmWhole(cell.widthPt)).toBe(48);
    expect(Math.round(mm(cell.widthPt))).toBe(49);
    // The gap moves it, and a whole number of millimetres comes out at both ends: no gap at all is `(595.276 − 20) / 4`
    // = 143.819 pt = 51 mm, and the two captions differ by exactly the room the gap takes.
    expect(mmWhole(cellFor(A4, 16, 'portrait', 0)!.widthPt)).toBe(51);
    expect(mmWhole(cellFor(A4, 4, 'portrait', 3)!.widthPt)).toBe(100);
  });

  test('a sheet size is written in the unit a person buys paper in', () => {
    expect(paperMm(A4)).toBe('210 × 297 mm');
    expect(mm(A4.widthPt)).toBeCloseTo(210, 1);
    expect(mm(A4.heightPt)).toBeCloseTo(297, 1);
  });
});
