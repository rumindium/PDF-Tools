import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages, firstPageMediaBox } from '../lib/pdf-inspect';

/**
 * `n-up`, laid out in the browser and read back out of the file's page boxes (`0-CICD.md` §3.8).
 *
 * This is the tool whose *options are a piece of paper*, so the browser is the only place two of its claims can be
 * measured at all: whether the screen really draws the sheet the five options describe (a handler test can only see the
 * output), and whether the three controls that decide the shape write the values the file comes back with.
 *
 * Five claims:
 *
 *  1. **The stage is the sheet, drawn from the document's own bytes.** Six pages at two per sheet is a page of paper with
 *     two page images on it, and the image in each cell is that page of *this* document — which is why the fixture's
 *     text is not the assertion and the cell count and the geometry are.
 *  2. **Every layout is captioned with the cell it would leave.** The caption is not decoration: it is the answer to "is
 *     this still readable", and it is measured against the handler's own arithmetic — `4-up` on A4 with a 3 mm gap leaves
 *     `100 × 142 mm` a page, and the screen says so before the run rather than after it.
 *  3. **The three shape controls are the options.** The stock, the orientation and the layout write `pageSize`,
 *     `orientation` and `perSheet`, and the picture follows all three: a landscape A4 head reads `297 × 210 mm`, and the
 *     grid table in the head is the one the paper was divided by.
 *  4. **The last sheet's empty slots are drawn, and the file agrees.** Four per sheet over six pages is two sheets, and
 *     the second one carries two pages and two empty slots — which is a fact about the output that neither the page count
 *     nor the text can show.
 *  5. **A pointer changes nothing — the click is the only control.** All three shape groups used to draw a preview of
 *     themselves while a pointer rested on one; what that produced was a sheet nobody had chosen under a sentence
 *     describing the run that had been (measured: a head reading `297 × 420 mm` over a summary reading
 *     `3 sheets of A4 portrait`). Resting on a stock, an orientation and a layout in turn now leaves the paper, the cell
 *     count, the head and the sentence exactly as the chosen shape draws them, and a click is what applies a shape.
 *  6. **The paper is the stock's own shape.** Every number inside the drawing is a percentage of the paper element, so a
 *     paper that is not the stock's aspect ratio puts every cell somewhere the drawing does not promise while the cell
 *     *count* stays right — and it is the reason both of the rule's size limits are **widths**: on an element with
 *     `aspect-ratio`, a `max-height` clamps the height and leaves the width alone, which would draw a landscape sheet
 *     squashed into a portrait one. Read off the paper's own box: the fixture's A4 ratio while it stands, its inverse
 *     once the orientation turns.
 *  7. **The grid divides the paper where the handler says.** A count of cells is a promise about the *output* only if the
 *     division behind it is the engine's — and that division is three numbers a screen can get wrong while looking right:
 *     the margin across, the margin down, and the cell rule `(sheet − 2·margin − gap·(n−1)) / n`. So every drawn cell's box
 *     is read as a fraction of the paper and compared with that arithmetic re-derived **here**, from the handler's own
 *     constants rather than from the module the board computes with — a reading that asked the board's own model would be
 *     a witness grading itself. In the arrival state (1 × 2 on A4) it reads the margin inset and the gap between the rows;
 *     on the landscape sheet (2 × 2 on A4 lying down) it reads that the first cell is inset by the margin *of the frame the
 *     options name*, not of the source page.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six A4 pages: two sheets at four per sheet, with two slots left over on the second — the case this file is about. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');

/**
 * The fixture's first page, in points, as **the sheet's own shape** is measured against it.
 *
 * The document's numbers rather than the name "A4": the fixture's pages are 595.276 × 841.89 pt, and the stock the case
 * chooses is the one the schema calls A4 — the same paper spelled twice, which is what makes it a reading rather than a
 * hard-coded 210/297.
 */
const PAGE = firstPageMediaBox(readFileSync(SIX_PAGES));
if (!PAGE) throw new Error('The sheet fixture has no readable MediaBox.');
const RATIO = PAGE.width / PAGE.height;

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

/** A layout card by the pages it puts on a sheet — the only stable name the five diagrams have. */
function layout(page: Page, perSheet: number) {
  return page.locator(`[data-per-sheet="${perSheet}"]`);
}

/** A stock chip by the value it writes. */
function paper(page: Page, stock: string) {
  return page.locator(`[data-stock="${stock}"]`);
}

/**
 * The handler's arithmetic, re-derived here — the margins across and down, the gap, the cell rule.
 *
 * Written out rather than imported on purpose: the board computes the same layout with `./model.ts`, and a reading that
 * asked that module what it thinks would be asking a witness to grade its own answer. These four numbers come from
 * `workers/light`'s `n-up` pass (whose sheet margins are shared with its header-footer overlay) and are the same four
 * `model.test.ts` pins.
 */
const MARGIN_X_PT = 10;
const MARGIN_Y_PT = 15;
/** Millimetres per point — 72 to the inch, which is how a millimetre option reaches a point-based engine. */
const MM_PER_PT = 25.4 / 72;
/** A4, the stock this case leaves selected, and the paper the fixture's own pages are (595.276 × 841.89 pt). */
const A4 = { widthPt: 595.276, heightPt: 841.89 };
/** The gap the form arrives with: the catalog's default, in millimetres. */
const DEFAULT_GAP_MM = 3;
/** What a falsification verdict quotes for this claim. */
const SHEET_GRID_MESSAGE = 'the drawn grid is the handler’s division of the sheet';

interface CellFraction {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The cells a frame, a grid and a gap leave, as fractions **of the paper** — what each inline percentage promises.
 *
 * The gap counts *between* cells (`gap·(n−1)`), which is the part of the rule that is easiest to get wrong by counting it
 * per cell instead, so it is spelled out here the way the handler spells it.
 */
function expectedCells(
  frame: { widthPt: number; heightPt: number },
  columns: number,
  rows: number,
  gapMm: number,
): CellFraction[] {
  const gapPt = gapMm / MM_PER_PT;
  const widthPt = (frame.widthPt - 2 * MARGIN_X_PT - gapPt * (columns - 1)) / columns;
  const heightPt = (frame.heightPt - 2 * MARGIN_Y_PT - gapPt * (rows - 1)) / rows;
  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      left: (MARGIN_X_PT + column * (widthPt + gapPt)) / frame.widthPt,
      top: (MARGIN_Y_PT + row * (heightPt + gapPt)) / frame.heightPt,
      width: widthPt / frame.widthPt,
      height: heightPt / frame.heightPt,
    };
  });
}

/**
 * The cells **as drawn**, each as a fraction of the paper it is on.
 *
 * Measured against the paper's own box rather than the stage's: the stage letterboxes, and the promise the component
 * makes is a percentage of `.sheet-paper`. DOM order is reading order — the board maps its slots in the order the handler
 * fills them.
 */
function drawnCells(page: Page): Promise<CellFraction[] | null> {
  return page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('.sheet-paper');
    if (!sheet) return null;
    const frame = sheet.getBoundingClientRect();
    return [...sheet.querySelectorAll<HTMLElement>('.sheet-slot')].map((slot) => {
      const box = slot.getBoundingClientRect();
      return {
        left: (box.left - frame.left) / frame.width,
        top: (box.top - frame.top) / frame.height,
        width: box.width / frame.width,
        height: box.height / frame.height,
      };
    });
  });
}

test.describe('a sheet of pages, as a browser makes it', () => {
  test('the sheet is drawn, its options are the drawing, and the file comes back as the paper it showed', async ({
    page,
  }) => {
    await page.goto('/tools/n-up');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/sheet|pages per sheet/i);

    // Nothing uploaded: one card and no sheet, because a document that does not exist has no pages to lay out.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await expect(page.locator('.sheet-card')).toHaveCount(0);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await expect(page.locator('.tool-split-sheets')).toHaveCount(1);
    // The sheet's own size is known once the first page is measured, which is what the drawing waits for.
    await expect(page.locator('.sheet-paper')).toHaveCount(1);

    //
    // **The default is drawn, not implied.** Two per sheet, A4, portrait, a 3 mm gap: one column of two A4 pages with
    // 203 × 142 mm cells — the handler's margins (10 pt across, 15 pt down) and gap arithmetic, quoted on the card.
    //
    await expect(page.locator('.sheet-slot')).toHaveCount(2);
    await expect(page.locator('.sheet-page')).toHaveCount(2);

    // **And the cells are *there*, not merely two of them.** The drawing puts each cell where the handler's division of
    // the paper leaves it, so both cells are read as fractions of the paper and compared with that division re-derived
    // in this file: the margin across, the margin down, and the gap counted *between* cells. Getting this wrong while the
    // count stays right is the shape of the whole board's risk — a preview that promises a sheet the engine will not make
    // — which is why the reading is the geometry and not the caption below (the caption says the same numbers in words,
    // and it is read next: a caption and a drawing can only disagree if this one is already right).
    const arrival = await drawnCells(page);
    if (!arrival) throw new Error('The sheet is not laid out.');
    const twoUp = expectedCells(A4, 1, 2, DEFAULT_GAP_MM);
    expect(arrival, SHEET_GRID_MESSAGE).toHaveLength(twoUp.length);
    arrival.forEach((cell, index) => {
      const want = twoUp[index]!;
      expect(cell.left, SHEET_GRID_MESSAGE).toBeCloseTo(want.left, 3);
      expect(cell.top, SHEET_GRID_MESSAGE).toBeCloseTo(want.top, 3);
      expect(cell.width, SHEET_GRID_MESSAGE).toBeCloseTo(want.width, 3);
      expect(cell.height, SHEET_GRID_MESSAGE).toBeCloseTo(want.height, 3);
    });

    await expect(layout(page, 2).locator('.sheet-choice-note')).toHaveText('203×142');
    // Every layout is captioned, including the ones not chosen — four per sheet is 100 × 142 mm a page, sixteen is
    // 48 × 69 (48.487 mm, rounded **once**: the tenth-then-whole pair this case first read printed 49). A caption read
    // off the *current* layout would be the same number five times.
    await expect(layout(page, 4).locator('.sheet-choice-note')).toHaveText('100×142');
    await expect(layout(page, 16).locator('.sheet-choice-note')).toHaveText('48×69');
    // The stock row is five papers, and the active one is the schema's default — A4, quoted in millimetres.
    await expect(page.locator('[data-testid="sheet-papers"] label')).toHaveCount(5);
    await expect(paper(page, 'a4')).toHaveAttribute('data-active', 'true');
    await expect(paper(page, 'a4').locator('.sheet-choice-note')).toHaveText('210 × 297 mm');

    // **The paper is the stock's own shape.** Read from the paper's own box rather than from anything drawn inside it,
    // because the stage's letterboxing is invisible to every number on the screen by design — what is being checked is
    // that the element carrying the grid is the paper the options named. A paper whose height collapsed would report a
    // ratio of `Infinity`, so the height is asserted first and the sentence is the claim's either way.
    const standing = await page.locator('.sheet-paper').boundingBox();
    if (!standing) throw new Error('The sheet is not laid out.');
    expect(standing.height, 'the sheet is drawn at the ratio of the stock it names').toBeGreaterThan(0);
    expect(standing.width / standing.height, 'the sheet is drawn at the ratio of the stock it names').toBeCloseTo(
      RATIO,
      2,
    );

    //
    // **The layout is a control.** Four per sheet redraws the sheet as four cells, the head names the grid the handler
    // will divide the paper by, and the strip grows because six pages no longer fit on one sheet.
    //
    await layout(page, 4).click();
    await expect(page.locator('.sheet-slot')).toHaveCount(4);
    await expect(page.locator('.sheet-page')).toHaveCount(4);
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('2 × 2 grid');
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('pages 1–4');
    await expect(page.locator('.sheet-strip .sheet-chip')).toHaveCount(2);

    // **The empty slots are drawn.** Sheet two carries two pages and two empty cells, and the sentence says which sheet
    // they are on — the difference between a four-cell sheet with two pages and a two-cell sheet, which is the shape of
    // the output rather than of the drawing.
    await page.locator('.sheet-strip .sheet-chip').nth(1).click();
    await expect(page.locator('.sheet-slot')).toHaveCount(4);
    await expect(page.locator('.sheet-slot[data-empty="true"]')).toHaveCount(2);
    await expect(page.locator('.sheet-page')).toHaveCount(2);
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('pages 5–6');
    await expect(page.locator('.sheet-summary')).toContainText('2 slots on sheet 2 stay empty');
    await page.getByRole('button', { name: 'Show the previous sheet' }).click();
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('pages 1–4');

    //
    //
    // **Claim 5: a pointer changes nothing — the click is the only control.**
    //
    // Every shape card used to draw a preview of itself the moment a pointer rested on it: the stock row and the layout
    // row probed (the orientation was exempted in defect 241) and the sheet was redrawn as a shape nobody had chosen
    // while the sentence under it went on describing the run that had been chosen. The probe is gone, so what is read
    // here is the drawing's own numbers — the paper, the cell count, the layout in the head and the sentence — after a
    // pointer has rested on each of the three groups in turn, plus the attribute the stylesheet used to ring the probed
    // paper with.
    //
    const chosenSummary = (await page.locator('.sheet-summary').textContent())!;
    // The stock: five chips in a row, so crossing one to reach another is an ordinary movement.
    await paper(page, 'a3').hover();
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('210 × 297 mm');
    await expect(page.locator('.sheet-slot')).toHaveCount(4);
    // The orientation: two pills side by side, the pair that started this rule.
    await page.locator('[data-orientation-choice="landscape"]').hover();
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('210 × 297 mm');
    await expect(page.locator('.sheet-slot')).toHaveCount(4);
    // The layout: the group whose preview was the one worth having (16 cells), and the one that lost it for the same
    // reason — the sheet is what the sentence under it is about, and the two may not disagree.
    await layout(page, 16).hover();
    await expect(page.locator('.sheet-slot')).toHaveCount(4);
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('2 × 2 grid');
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('pages 1–4');
    // Nothing moved on any of the three: the sentence, the chosen radios, and no probed paper to mark out.
    await expect(page.locator('.sheet-summary')).toHaveText(chosenSummary);
    await expect(paper(page, 'a4')).toHaveAttribute('data-active', 'true');
    await expect(layout(page, 4)).toHaveAttribute('data-active', 'true');
    expect(await page.locator('.sheet-paper').getAttribute('data-probe')).toBeNull();

    // **The stock and the orientation are controls too.** Landscape lies the paper down and the head quotes the size the
    // file will have; A3 makes the same layout bigger, and the captions move with it — which is the whole reason the
    // captions are on the cards rather than on the chosen one.
    //
    // Clicked as a card, not as the radio inside it: the input is 1 px and `pointer-events: none` by design (the card is
    // the hit target, the input is what the keyboard reaches), so `check()` is a click at a point the label covers.
    await page.locator('[data-orientation-choice="landscape"]').click();
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('297 × 210 mm');
    await expect(layout(page, 4).locator('.sheet-choice-note')).toHaveText('143×98');
    // …and the paper lies down with it: the same box, the same ratio the other way up. A rule that kept the portrait
    // shape here would put the four cells of a landscape sheet in the positions of a portrait one — the head and the
    // captions would still read `297 × 210 mm` and `143×98`.
    const lying = await page.locator('.sheet-paper').boundingBox();
    if (!lying) throw new Error('The sheet is not laid out.');
    expect(lying.width / lying.height, 'the sheet keeps its ratio when the orientation turns').toBeCloseTo(
      1 / RATIO,
      2,
    );
    // …and the grid is re-divided on the frame the options name: A4 lying down is 841.89 × 595.276 pt, so the first cell's
    // inset is a different fraction of a different paper than the portrait reading above. A board that divided the *source
    // page's* frame — the same numbers here, but only because this fixture is A4 — would keep the cell count, the captions
    // and the paper's shape while putting every cell somewhere the engine will not.
    const reDivided = await drawnCells(page);
    if (!reDivided) throw new Error('The sheet is not laid out.');
    const fourUp = expectedCells({ widthPt: A4.heightPt, heightPt: A4.widthPt }, 2, 2, DEFAULT_GAP_MM);
    expect(reDivided[0]!.left, SHEET_GRID_MESSAGE).toBeCloseTo(fourUp[0]!.left, 3);
    expect(reDivided[0]!.top, SHEET_GRID_MESSAGE).toBeCloseTo(fourUp[0]!.top, 3);
    await paper(page, 'a3').click();
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('420 × 297 mm');
    await expect(layout(page, 4).locator('.sheet-choice-note')).toHaveText('205×142');
    // The gap is a control beside the layouts, and it takes room away from every one of them at once — here on A3, where
    // 12 mm of gap leaves 200 × 137 mm a cell instead of 205 × 142.
    await page.getByRole('button', { name: 'Gap 12 mm' }).click();
    await expect(layout(page, 4).locator('.sheet-choice-note')).toHaveText('200×137');

    // Back to the paper the run is asserted on: A4 landscape, four per sheet, three of them — the shape of the file.
    await paper(page, 'a4').click();
    await page.getByRole('button', { name: 'Gap 3 mm' }).click();
    await expect(page.locator('.sheet-summary')).toContainText('6 pages → 2 sheets of A4 landscape');
    await expect(page.locator('.sheet-summary')).toContainText('4 per sheet in a 2 × 2 grid');
    // Clicking a page in a cell is still the lightbox: the drawing is a preview of the document, not only of the sheet.
    await page.locator('.sheet-page').first().click();
    await expect(page.locator('.lightbox, [role="dialog"]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet-page').first()).toBeVisible();

    //
    // **And the click is what draws it.** Sixteen per sheet is the layout where the caption (48 × 69 mm) is the whole
    // argument, and the drawing follows the click rather than the pointer: sixteen cells appear, the head names the grid
    // the handler will divide the paper by, the sentence moves with it — and the strip goes away, because six pages at
    // sixteen per sheet are one sheet and there is nothing left to navigate.
    //
    await layout(page, 16).click();
    await expect(page.locator('.sheet-slot')).toHaveCount(16);
    await expect(page.locator('.sheet-page')).toHaveCount(6);
    await expect(page.locator('.sheet-card .card-head .tiny.faint')).toContainText('4 × 4 grid');
    await expect(page.locator('.sheet-summary')).toContainText('1 sheet of A4 landscape');
    await expect(page.locator('.sheet-summary')).toContainText('16 per sheet in a 4 × 4 grid');
    await expect(page.locator('.sheet-strip .sheet-chip')).toHaveCount(0);

    // Back to the shape the run is asserted on — four per sheet and two sheets — which the click restores whole.
    await layout(page, 4).click();
    await expect(page.locator('.sheet-slot')).toHaveCount(4);
    await expect(page.locator('.sheet-summary')).toContainText('6 pages → 2 sheets of A4 landscape');
    await expect(page.locator('.sheet-strip .sheet-chip')).toHaveCount(2);

    await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    const bytes = readFileSync((await file.path())!);

    // Six pages into four per sheet is **two** sheets, and that is the assertion the drawing was making: the sheet count
    // is the product, and a form that offered a dropdown instead of a picture would have nothing to check it against.
    expect(countPdfPages(bytes)).toBe(2);
    // …and the sheet is the paper the screen drew: A4 landscape, to the point. The handler bakes the rotation into the
    // placement, so the box is the paper's own size and not the source page's.
    const box = firstPageMediaBox(bytes);
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(841.89, 1);
    expect(box!.height).toBeCloseTo(595.276, 1);
  });
});
