/**
 * The sheet an `n-up` job produces (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.4, `0-UI-DESIGN.md` §6.5).
 *
 * `n-up`'s five options describe a **piece of paper**: how many pages go on it, which way round it is, which stock it
 * is, how far apart the pages sit and whether each cell is framed. Every one of those is a thing this screen can draw —
 * and until this module existed the screen drew none of them, so "6 per sheet, landscape, 12 mm gaps" was something a
 * person had to picture. That is the whole argument for the board in `./index.tsx`, and this file is its arithmetic.
 *
 * ## Why this is a mirror and not an approximation
 *
 * The layout is the worker's own, re-derived rather than guessed: `workers/light/src/handlers/n-up.ts` composes the
 * sheets in a Python pass whose numbers are in this module's tests. The margins (10 pt across, 15 pt down), the cell
 * arithmetic (`(sheet − 2·margin − gap·(n−1)) / n`), the uniform fit, the centring, the grid table and the sheet sizes
 * are **the same numbers**, so a preview cannot promise a sheet the engine will not produce. Row and column indices are
 * the part most likely to drift, so they are spelled out: a page's cell is `slot % columns` across and `slot // columns`
 * down, in reading order — and the sheet's own coordinates are top-down here because a screen is, which is why the
 * vertical margin is applied to the **top** and the row index counts downwards (the handler counts up from the bottom,
 * because PDF user space does).
 *
 * ## What the preview cannot show, and says
 *
 * A page's *displayed* rectangle is its `/MediaBox` with its `/Rotate` applied (the worker transforms the form's box
 * through its own `/Matrix`, which is why a rotated page lands right way up and this preview passes the same sizes). But
 * the board only ever measures a page when it is about to draw it (`pageSizePoints`), so a page that could not be
 * measured falls back to the first page's shape — and every such page is counted, so the sentence can say the layout
 * was drawn against an assumption instead of quietly drawing one.
 */

/** The grid a sheet is divided into at a given `perSheet`, **portrait**, as `[columns, rows]` — the handler's table. */
export const SHEET_GRIDS: Record<number, readonly [number, number]> = {
  2: [1, 2],
  4: [2, 2],
  6: [2, 3],
  9: [3, 3],
  16: [4, 4],
};

/** The `perSheet` values the schema accepts, in the order a person thinks about them. */
export const PER_SHEET_CHOICES: readonly number[] = [2, 4, 6, 9, 16];

/** The units the API accepts for a sheet. `source` follows the input's first page instead. */
export type SheetSizeKey = 'source' | 'a4' | 'a3' | 'letter' | 'legal';

/** Sheet sizes in points — the handler's own table, which is the ISO A3/A4 sizes and the two US stocks. */
export const SHEET_SIZES: Record<Exclude<SheetSizeKey, 'source'>, readonly [number, number]> = {
  a4: [595.276, 841.89],
  a3: [841.89, 1190.551],
  letter: [612, 792],
  legal: [612, 1008],
};

/** The paper names, for a label a person recognises: `A4`, not `595.276 × 841.89 pt`. */
export const SHEET_LABELS: Record<SheetSizeKey, string> = {
  source: 'the original page',
  a4: 'A4',
  a3: 'A3',
  letter: 'Letter',
  legal: 'Legal',
};

/**
 * The stocks offered, in the order they are offered: the input's own page first, then by size.
 *
 * A fixed list rather than `Object.keys(SHEET_SIZES)`: it drives a row of controls, and the order a person reads paper
 * sizes in is not the order a lookup table happens to be written in.
 */
export const SHEET_CHOICES: readonly SheetSizeKey[] = ['source', 'a4', 'a3', 'letter', 'legal'];

/**
 * The margins the worker leaves around a sheet, in points: `10` across and `15` down.
 *
 * Not a board constant — the handler's, and the same pair its header-footer overlay uses, so a printout of one lines up
 * with the other. They are why a cell is never quite `sheet ÷ n` and why the preview has to know them.
 */
export const SHEET_MARGIN_X_PT = 10;
export const SHEET_MARGIN_Y_PT = 15;

const MM_PER_PT = 25.4 / 72;

export type SheetOrientation = 'portrait' | 'landscape';

/** A page's size in points, as the document displays it — `/Rotate` already applied. */
export interface SheetPageSize {
  widthPt: number;
  heightPt: number;
}

/** A rectangle in points, measured from the sheet's **top-left** so a screen can use it directly. */
export interface SheetRect {
  leftPt: number;
  topPt: number;
  widthPt: number;
  heightPt: number;
}

/** One cell of a sheet: the slot, and the page drawn inside it. */
export interface SheetSlot {
  /** The page placed here, or `null` for a slot on the last sheet that has no page left to hold. */
  page: number | null;
  /** The cell's own box — what `border` frames. */
  cell: SheetRect;
  /** The page as drawn: fitted inside the cell by one uniform scale and centred. `null` when the slot is empty. */
  draw: SheetRect | null;
}

/** One output sheet, and what landed on it. */
export interface Sheet {
  /** One-based sheet number, as a person counts them. */
  index: number;
  slots: SheetSlot[];
}

export interface SheetPlan {
  /** The sheet's size in points, after the orientation has been applied. */
  frame: SheetPageSize;
  /** `[columns, rows]` as drawn — the portrait grid, transposed on a landscape sheet. */
  grid: readonly [number, number];
  perSheet: number;
  /** How many sheets the run produces. */
  sheets: number;
  /** How many pages are placed. `sheets × perSheet − placed` slots are left empty, which the board draws as gaps. */
  placed: number;
  /** The cell size in points — the same for every cell, and the number that says whether a page is legible. */
  cell: { widthPt: number; heightPt: number };
  layout: Sheet[];
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readPerSheet(value: unknown): number {
  const perSheet = numberOf(value, 2);
  return SHEET_GRIDS[perSheet] ? perSheet : 2;
}

export function readOrientation(value: unknown): SheetOrientation {
  return value === 'landscape' ? 'landscape' : 'portrait';
}

export function readPageSize(value: unknown): SheetSizeKey {
  return typeof value === 'string' && (value === 'source' || value in SHEET_SIZES) ? (value as SheetSizeKey) : 'a4';
}

/** The gap, in millimetres, held to the schema's own bounds so a preview cannot draw a sheet the API refuses. */
export function readGapMm(value: unknown): number {
  return Math.min(20, Math.max(0, numberOf(value, 3)));
}

/**
 * The grid as drawn at this orientation.
 *
 * `perSheet` names a *shape* and the orientation decides which way the shape lies: 2 per sheet is a column of one on a
 * portrait sheet and a row of two on a landscape one, which is the whole reason the handler swaps the pair rather than
 * asking for two different numbers.
 */
export function gridFor(perSheet: number, orientation: SheetOrientation): readonly [number, number] | null {
  const grid = SHEET_GRIDS[perSheet];
  if (!grid) return null;
  return orientation === 'landscape' ? [grid[1], grid[0]] : grid;
}

/**
 * The sheet's own size.
 *
 * `source` is the input's first page — measured, and reported as a warning by the job because every sheet then takes
 * *that* page's size and a mixed-size document comes out uniform. The orientation only swaps a sheet that is taller
 * than it is wide, which is why a source page that is already landscape is not rotated onto its side again.
 */
export function frameFor(
  pageSize: SheetSizeKey,
  orientation: SheetOrientation,
  source: SheetPageSize | null,
): SheetPageSize | null {
  // The table stays a pair of numbers, the way the handler's is, so the two are comparable line by line; the frame is
  // the named shape a screen wants.
  const stock = pageSize === 'source' ? null : SHEET_SIZES[pageSize];
  const size = pageSize === 'source' ? source : stock ? { widthPt: stock[0], heightPt: stock[1] } : null;
  if (!size || size.widthPt <= 0 || size.heightPt <= 0) return null;
  const { widthPt, heightPt } = size;
  return orientation === 'landscape' && heightPt > widthPt
    ? { widthPt: heightPt, heightPt: widthPt }
    : { widthPt, heightPt };
}

/**
 * A stock's own size, **before** any orientation — what a paper chip draws its shape from and quotes in millimetres.
 *
 * `null` for `source`, which is not a stock: it is whatever the input's first page measures, so only the caller holding
 * the measurement can answer it (`frameFor`). The distinction is load-bearing for the picker: a `source` chip cannot
 * draw a paper shape until the document is being read, and draws the measured ratio as soon as it is.
 */
export function stockSize(key: SheetSizeKey): SheetPageSize | null {
  if (key === 'source') return null;
  const stock = SHEET_SIZES[key];
  return { widthPt: stock[0], heightPt: stock[1] };
}

/**
 * The cell a sheet's margins, gaps and grid leave — the one number the drawing cannot show.
 *
 * Split out of `planSheets` because the picker needs it *for a layout that is not the current one*: each `perSheet`
 * diagram is captioned with the cell size it would produce, at the stock, orientation and gap that are on screen right
 * now. That caption is the whole reason this is a function instead of three lines inside the plan: "16 per sheet" and
 * "38 × 26 mm a page" are the same option, and only one of them is an answer.
 *
 * `null` when the margins and gaps leave no room for a cell, which is the case the handler refuses with
 * `VALIDATION_ERROR`.
 */
export function cellFor(
  frame: SheetPageSize,
  perSheet: number,
  orientation: SheetOrientation,
  gapMm: number,
): SheetRect | null {
  const grid = gridFor(perSheet, orientation);
  if (!grid) return null;
  const [columns, rows] = grid;
  const gapPt = readGapMm(gapMm) / MM_PER_PT;
  const widthPt = (frame.widthPt - 2 * SHEET_MARGIN_X_PT - gapPt * (columns - 1)) / columns;
  const heightPt = (frame.heightPt - 2 * SHEET_MARGIN_Y_PT - gapPt * (rows - 1)) / rows;
  if (widthPt <= 0 || heightPt <= 0) return null;
  // The origin is the margin, because the first cell is inset by it and `planSheets` places every later cell by adding
  // the cell and the gap — so the two callers would otherwise each re-derive where the grid begins.
  return { leftPt: SHEET_MARGIN_X_PT, topPt: SHEET_MARGIN_Y_PT, widthPt, heightPt };
}

/**
 * The sheets a run produces, drawn cell by cell.
 *
 * `pages` is the input in order, each with the size it displays at; a page whose size is unknown is passed as `null`
 * and takes `fallback` (the first measured page), which is what keeps an unmeasurable page from quietly deleting itself
 * from the preview. Returns `null` when the sheet itself cannot be known (no `source` size yet) or when the margins and
 * gaps leave no room for a cell — the one case the handler refuses with `VALIDATION_ERROR`, said here before the job
 * rather than after it.
 *
 * `border` is deliberately **not** a parameter: framing a cell draws a line and moves nothing, so it is the one option
 * of this tool that is genuinely a presentation of the same layout rather than a fact about it.
 */
export function planSheets({
  pages,
  fallback,
  perSheet,
  pageSize,
  orientation,
  gapMm,
}: {
  pages: Array<SheetPageSize | null>;
  fallback: SheetPageSize | null;
  perSheet: number;
  pageSize: SheetSizeKey;
  orientation: SheetOrientation;
  gapMm: number;
}): SheetPlan | null {
  const frame = frameFor(pageSize, orientation, fallback);
  const grid = gridFor(perSheet, orientation);
  const cell = frame ? cellFor(frame, perSheet, orientation, gapMm) : null;
  if (!frame || !grid || !cell) return null;

  const [columns] = grid;
  const gapPt = readGapMm(gapMm) / MM_PER_PT;
  const cellWidthPt = cell.widthPt;
  const cellHeightPt = cell.heightPt;

  const sheetCount = Math.max(1, Math.ceil(pages.length / perSheet));
  const layout: Sheet[] = [];
  for (let index = 0; index < sheetCount; index += 1) {
    const slots: SheetSlot[] = [];
    for (let slot = 0; slot < perSheet; slot += 1) {
      const pageNumber = index * perSheet + slot + 1;
      const column = slot % columns;
      const row = Math.floor(slot / columns);
      const cell: SheetRect = {
        leftPt: SHEET_MARGIN_X_PT + column * (cellWidthPt + gapPt),
        topPt: SHEET_MARGIN_Y_PT + row * (cellHeightPt + gapPt),
        widthPt: cellWidthPt,
        heightPt: cellHeightPt,
      };
      const measured = pages[pageNumber - 1] ?? null;
      const size = pageNumber <= pages.length ? (measured ?? fallback) : null;
      if (!size) {
        slots.push({ page: null, cell, draw: null });
        continue;
      }
      // One uniform scale, so the aspect ratio survives: the page is fitted to the cell, never stretched to it.
      const scale = Math.min(cellWidthPt / size.widthPt, cellHeightPt / size.heightPt);
      const widthPt = size.widthPt * scale;
      const heightPt = size.heightPt * scale;
      slots.push({
        page: pageNumber,
        cell,
        draw: {
          leftPt: cell.leftPt + (cellWidthPt - widthPt) / 2,
          topPt: cell.topPt + (cellHeightPt - heightPt) / 2,
          widthPt,
          heightPt,
        },
      });
    }
    layout.push({ index: index + 1, slots });
  }

  return {
    frame,
    grid,
    perSheet,
    sheets: sheetCount,
    placed: pages.length,
    cell: { widthPt: cellWidthPt, heightPt: cellHeightPt },
    layout,
  };
}

/** Points as millimetres, rounded to a tenth — the unit a person reads paper in. */
export function mm(points: number): number {
  return Math.round(points * MM_PER_PT * 10) / 10;
}

/**
 * Points as **whole** millimetres, which is what a caption can afford: five layouts on one row have no space for a
 * decimal, and a tenth of a millimetre is not a difference anybody chooses a layout on.
 *
 * Rounded **once**, and that is the whole reason this exists rather than `Math.round(mm(x))`: rounding to a tenth and
 * then to a whole number is two roundings, and 48.487 mm — the cell a 16-up A4 sheet leaves with a 3 mm gap — came out
 * as `49` on the card while the number it describes is `48`. A caption that is a millimetre wrong is a caption nobody
 * can check, which is the one thing a caption may not be.
 */
export function mmWhole(points: number): number {
  return Math.round(points * MM_PER_PT);
}

/** `210 × 297 mm`, the way a paper size is written. */
export function paperMm(size: SheetPageSize): string {
  return `${Math.round(mm(size.widthPt))} × ${Math.round(mm(size.heightPt))} mm`;
}

/** How a grid is written: `2 × 3`, columns first, matching how the sheet is described. */
export function gridLabel(grid: readonly [number, number]): string {
  return `${grid[0]} × ${grid[1]}`;
}

export interface SheetVerdict {
  sentence: string;
  tone: 'changed' | 'blocked' | 'note';
}

/**
 * What the sheet will be, in words — the one line under the drawing.
 *
 * The interesting half is the aside: `source` sizes every sheet to the **first** page, which is exactly the case where a
 * mixed-size input silently comes out uniform (the job raises `SHEET_SIZE_FROM_FIRST_PAGE` for it), so the sentence
 * says so while the user is still choosing rather than after the file comes back. `pages` that could not be measured
 * are counted the same way: the layout was drawn against the first page's shape, and pretending otherwise would be a
 * preview whose numbers are right and whose geometry is not.
 */
export function describeSheets(
  plan: SheetPlan | null,
  {
    pageCount,
    pageSize,
    orientation,
    gapMm,
    border,
    unmeasured,
    planMaxPages,
  }: {
    pageCount: number | null;
    pageSize: SheetSizeKey;
    orientation: SheetOrientation;
    gapMm: number;
    border: boolean;
    unmeasured: number;
    planMaxPages: number | null;
  },
): SheetVerdict {
  if (!plan) {
    return pageSize === 'source'
      ? { sentence: 'Waiting for the first page before the sheet can be sized.', tone: 'note' }
      : { sentence: 'This gap leaves no room for a cell on this sheet — bring it down.', tone: 'blocked' };
  }

  const name =
    pageSize === 'source'
      ? `the first page’s own size (${paperMm(plan.frame)})`
      : `${SHEET_LABELS[pageSize]} ${orientation}`;
  const pages = pageCount ?? plan.placed;
  const sheetWord = plan.sheets === 1 ? 'sheet' : 'sheets';
  const facts = [
    // Which *sheet* it is, first, because `perSheet` and `gap` are questions about a piece of paper and `source` makes
    // that paper the input's own page — the fact that is easiest to get wrong and hardest to see afterwards.
    `${pages} page${pages === 1 ? '' : 's'} → ${plan.sheets} ${sheetWord} of ${name}`,
    `${plan.perSheet} per sheet in a ${gridLabel(plan.grid)} grid`,
    `each cell ${mm(plan.cell.widthPt)} × ${mm(plan.cell.heightPt)} mm`,
  ];
  if (gapMm > 0) facts.push(`${gapMm} mm apart`);
  if (border) facts.push('each page framed');

  const asides: string[] = [];
  if (pageSize === 'source' && plan.sheets > 1) {
    asides.push(
      'Every sheet takes the first page of the input as its size, so a document with mixed page sizes comes out uniform.',
    );
  }
  if (unmeasured > 0) {
    asides.push(
      `${unmeasured} page${unmeasured === 1 ? '' : 's'} could not be measured, so the layout was drawn at the first page’s shape.`,
    );
  }
  if (planMaxPages != null && plan.sheets > planMaxPages) {
    return {
      sentence: `${facts.join(', ')}. Fair use allows ${planMaxPages} output page${planMaxPages === 1 ? '' : 's'}, so this run will be refused — use more pages per sheet.`,
      // Tone is `blocked` and not `note`: this is a request the API will refuse, not a caveat about the drawing.
      tone: 'blocked',
    };
  }
  return {
    sentence: `${facts.join(', ')}.${asides.length > 0 ? ` ${asides.join(' ')}` : ''}`,
    tone: asides.length > 0 ? 'note' : 'changed',
  };
}
