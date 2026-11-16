import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages, cropBoxCount, firstPageCropBox, firstPageMediaBox } from '../lib/pdf-inspect';

/**
 * `crop`, drawn on the page in the browser and read back out of the file's `/CropBox` (`0-CICD.md` §3.8).
 *
 * The box is the one option in this product whose failure is **invisible**: the crop is written to `/CropBox` only, so a
 * page cropped 3 mm too far is a page, and a crop that wrote nothing is a page too. Nothing but the box in the output
 * tells those apart, which is why this file reads `firstPageCropBox` *and* `firstPageMediaBox` — the second is the
 * assertion that the crop was non-destructive, and a handler that rewrote the page would pass the first.
 *
 * The browser half is about the form, which was the last JSON box in the product: four edge insets typed as
 * `{ "top": 20, "right": 20, "bottom": 20, "left": 20 }`. Four claims:
 *
 *  1. **The arrival state is a drawn, runnable crop.** The catalog ships a default box, because the handler refuses a
 *     request with neither `auto` nor `box` — a board opening on "nothing trimmed" would be offering a Run button that
 *     produces an error. So the page comes up with the default already on it, and the sentence quotes the kept size in
 *     the unit the user is working in.
 *  2. **Dragging the page writes the option.** A pointer drag on an edge moves the value as well as the picture, and the
 *     four numbers are the *same value* as the rectangle — one geometry, two renderings.
 *  3. **A unit switch converts rather than re-reads.** The numbers are a length, so "20 mm" must not become "20 %" —
 *     that would multiply the trim by five behind the user's back.
 *  4. **The file agrees with the screen.** A 20 mm even trim of this page is that page less 40 mm on each axis, and the
 *     output's crop box is the arithmetic of the sentence above it.
 *  5. **Which pages the box lands on is decided on the pages, and it is the same value the rows hold.** The board is
 *     stacked so the drawing gets the whole width, every page is a tile under it, and a click on a tile's number takes
 *     that page out of the crop — which must show up in the advanced rows *and* in the file: the pages outside the
 *     selection keep their own crop box, so the output has one explicit `/CropBox` per cropped page and no more.
 *
 * Every number below is computed from the fixture's **own** page size rather than from "A4": the fixture's pages are
 * 595 × 842 pt, which is 209.9 × 297.04 mm — a millimetre off the paper everyone calls by that name, and exactly the kind
 * of difference a hard-coded 210 would hide.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six pages, none of which carries a crop box of its own. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');

const PT_PER_MM = 72 / 25.4;

/** The board's own rounding, for a length: two decimals. */
const round2 = (value: number) => Math.round(value * 100) / 100;
/** …and for a share: one, because a percentage of a page is not a measurement. */
const round1 = (value: number) => Math.round(value * 10) / 10;
/** Points as millimetres, the way the sentence converts them. */
const mm = (points: number) => round2(points * (25.4 / 72));

/** The fixture's first page, read from the file — the size everything else in this case is arithmetic against. */
const FIXTURE = readFileSync(SIX_PAGES);
const PAGE = firstPageMediaBox(FIXTURE);
if (!PAGE) throw new Error('The crop fixture has no readable MediaBox.');
const WIDTH = PAGE.width;
const HEIGHT = PAGE.height;

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

/** The drawn rectangle as a fraction of the page it is on — the overlay read back out of the layout. */
async function drawnFrame(page: Page): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const surface = await page.locator('.crop-page').boundingBox();
  const box = await page.locator('.crop-box').boundingBox();
  if (!surface || !box) throw new Error('The crop box or the page it is drawn on is not laid out.');
  return {
    left: (box.x - surface.x) / surface.width,
    top: (box.y - surface.y) / surface.height,
    right: (surface.x + surface.width - (box.x + box.width)) / surface.width,
    bottom: (surface.y + surface.height - (box.y + box.height)) / surface.height,
  };
}

/** What the four inset boxes say, in page order: top, right, bottom, left. */
async function insets(page: Page): Promise<string[]> {
  return page
    .locator('.crop-inputs input')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
}

test.describe('a crop, as a browser makes it', () => {
  test('a box drawn on the page comes back as the page’s crop box', async ({ page }) => {
    await page.goto('/tools/crop');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/crop/i);

    // Nothing uploaded: one card and no board. The box is drawn on a page, and there is no page yet.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await expect(page.locator('.crop-card')).toHaveCount(0);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await expect(page.locator('.tool-split-crop')).toHaveCount(1);

    //
    // **Arrival is a real crop.** 10 mm off every edge, quoted as the kept size and the page it is kept from — the
    // default is in the catalog because the handler has no meaning for an absent box.
    //
    const kept = (insetMm: number) => ({
      width: mm(WIDTH - 2 * insetMm * PT_PER_MM),
      height: mm(HEIGHT - 2 * insetMm * PT_PER_MM),
    });
    await expect(page.locator('.crop-summary')).toHaveText(
      `Keeps ${kept(10).width} × ${kept(10).height} mm of a ${mm(WIDTH)} × ${mm(HEIGHT)} mm page — 10 mm off every edge.`,
    );
    await expect(page.locator('.crop-summary')).toHaveAttribute('data-tone', 'changed');
    expect(await insets(page)).toEqual(['10', '10', '10', '10']);
    await expect(page.locator('.crop-measure')).toContainText('% of the page kept');

    // The overlay is *where the value says*, and not a decorative rectangle: 10 mm is a different fraction of the width
    // than of the height, and the drawn frame shows both — the difference between the two is the whole reason the
    // arithmetic is in fractions of each axis rather than one number.
    const drawn = await drawnFrame(page);
    expect(drawn.left).toBeCloseTo((10 * PT_PER_MM) / WIDTH, 3);
    expect(drawn.top).toBeCloseTo((10 * PT_PER_MM) / HEIGHT, 3);
    expect(drawn.left).toBeCloseTo(drawn.right, 3);
    expect(drawn.top).toBeCloseTo(drawn.bottom, 3);

    // The page is drawn at the document's own shape: an A4 page in a box that is not 1 : √2 would put the overlay's
    // percentages in the wrong place, and this ratio comes from the file rather than from the fixture's name.
    const surface = (await page.locator('.crop-page').boundingBox())!;
    expect(surface.width / surface.height).toBeCloseTo(WIDTH / HEIGHT, 2);

    //
    // **A drag on the page writes the option.** The left edge is pulled a quarter of the way in; the fraction is the
    // assertion because the pointer is a real one, and the millimetres that land in the input are the *same value* seen
    // through the unit — a quarter of the page's width.
    //
    //
    // The pointer reaches for a point on the handle that is **on screen**, and that is a cost of stacking the board
    // rather than a detail of this case: the handle is the height of the box (540 px here), the document card now sits
    // above the drawing, and the page's height ceiling is 68 vh — so the middle of the left edge is 38 px below the fold
    // and `elementFromPoint` there is the document, not the handle (defect 238: the three assertions below failed with
    // the box unmoved, which is exactly what a drag that never started looks like). The case scrolls the way a user does
    // — and the coordinates are viewport coordinates, so the page is measured *after* the scroll.
    //
    const handleLocator = page.locator('.crop-handle-left');
    await handleLocator.scrollIntoViewIfNeeded();
    const handle = (await handleLocator.boundingBox())!;
    const pageAfterScroll = (await page.locator('.crop-page').boundingBox())!;
    const target = pageAfterScroll.x + pageAfterScroll.width * 0.25;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(target, handle.y + handle.height / 2, { steps: 12 });
    await page.mouse.up();

    const afterDrag = await drawnFrame(page);
    expect(afterDrag.left).toBeCloseTo(0.25, 2);
    // Nothing else moved: an edge drag owns one edge, and a handle that also nudged the top or the bottom would be
    // resizing a page the user did not ask to resize.
    expect(afterDrag.top).toBeCloseTo(drawn.top, 3);
    expect(afterDrag.bottom).toBeCloseTo(drawn.bottom, 3);
    expect(afterDrag.right).toBeCloseTo(drawn.right, 3);

    const dragged = await insets(page);
    expect(Number(dragged[3])).toBeCloseTo(0.25 * mm(WIDTH), 0);
    expect(dragged.slice(0, 3)).toEqual(['10', '10', '10']);
    // The readout on the box is the kept share, so the drag and the number on the rectangle are one fact.
    await expect(page.locator('.crop-measure')).not.toContainText('100% of the page kept');

    // And back: the four boxes are the keyboard's way to the same value, and Reset is the tool's own starting box.
    await page.getByRole('button', { name: 'Reset' }).click();
    expect(await insets(page)).toEqual(['10', '10', '10', '10']);
    await expect(page.locator('.crop-summary')).toHaveText(
      `Keeps ${kept(10).width} × ${kept(10).height} mm of a ${mm(WIDTH)} × ${mm(HEIGHT)} mm page — 10 mm off every edge.`,
    );

    //
    // **The quick trims are one click**, because the first thing a new user needs is not to know what an inset is.
    //
    await page.getByRole('button', { name: '20 mm' }).click();
    await expect(page.locator('.crop-summary')).toHaveText(
      `Keeps ${kept(20).width} × ${kept(20).height} mm of a ${mm(WIDTH)} × ${mm(HEIGHT)} mm page — 20 mm off every edge.`,
    );
    expect(await insets(page)).toEqual(['20', '20', '20', '20']);

    //
    // **Switching units converts.** 20 mm is 56.69 pt, and 9.53 % of the width against 6.73 % of the height — percent is
    // per axis, so one trim is two shares. Re-reading the numbers instead would turn 20 mm into 20 % and crop the page
    // to a fifth of itself, which is the defect this claim exists to catch.
    //
    // The option's *value* is the rounded conversion — the box is written to two decimals — so the sentence is computed
    // from 56.69 pt and not from the exact 56.6929, which is the difference between 481.62 and 481.61.
    const trimPt = round2(20 * PT_PER_MM);
    await page.locator('#option-units').selectOption('pt');
    await expect(page.locator('.crop-summary')).toHaveText(
      `Keeps ${round2(WIDTH - 2 * trimPt)} × ${round2(HEIGHT - 2 * trimPt)} pt of a ${WIDTH} × ${HEIGHT} pt page — ${trimPt} pt off every edge.`,
    );

    await page.locator('#option-units').selectOption('percent');
    const shareWidth = round2((trimPt / WIDTH) * 100);
    const shareHeight = round2((trimPt / HEIGHT) * 100);
    // A share is not a length, so the two axes part company — and the sentence names them as shares of the two, which is
    // the only way a percentage of a page can be said at all. The share is quoted to one decimal and the four boxes
    // carry two, which is why the two readings of one trim are not spelled the same way.
    await expect(page.locator('.crop-summary')).toHaveText(
      `Keeps ${round1(100 - 2 * shareWidth)} % of the width and ${round1(100 - 2 * shareHeight)} % of the height — trimming ${round1(shareWidth)} % off both sides, ${round1(shareHeight)} % off the top and bottom.`,
    );
    const percent = await insets(page);
    expect(Number(percent[0])).toBeCloseTo(shareHeight, 1);
    expect(Number(percent[3])).toBeCloseTo(shareWidth, 1);

    // Back to the unit the job will be read in, and to the even trim this case is about.
    await page.locator('#option-units').selectOption('mm');
    await page.getByRole('button', { name: '20 mm' }).click();
    await expect(page.locator('.crop-summary')).toHaveText(
      `Keeps ${kept(20).width} × ${kept(20).height} mm of a ${mm(WIDTH)} × ${mm(HEIGHT)} mm page — 20 mm off every edge.`,
    );

    //
    // **The two cards are stacked.** This board is a box being dragged on a page, so the drawing is the wide thing and
    // the options column was the smaller half of the screen; the measurement is the same three readings the order board
    // asserts, and it is read as layout boxes rather than as a class (an entry animation is not part of the claim).
    //
    const stacked = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('.tool-split-crop');
      const first = board?.firstElementChild as HTMLElement | null;
      const second = board?.lastElementChild as HTMLElement | null;
      if (!board || !first || !second) return null;
      return {
        columns: getComputedStyle(board).gridTemplateColumns.split(' ').filter(Boolean).length,
        firstWidth: first.offsetWidth - board.clientWidth,
        secondWidth: second.offsetWidth - board.clientWidth,
        below: second.offsetTop >= first.offsetTop + first.offsetHeight,
      };
    });
    expect(stacked).toEqual({ columns: 1, firstWidth: 0, secondWidth: 0, below: true });

    //
    // **The selection is decided on the pages.** Nothing has been selected, and that is *every page* rather than none:
    // the option is absent, the head says so, and every tile is pressed — the reading a board that rendered an empty
    // value as "no pages" would get exactly backwards while the job cropped all six.
    //
    const tiles = page.locator('.crop-strip-tile');
    await expect(tiles).toHaveCount(6);
    await expect(page.locator('.crop-scope')).toContainText('Every page');
    await expect(page.locator('.crop-strip-toggle[aria-pressed="true"]')).toHaveCount(6);

    // Taking one page out: the head counts what is left, the tile says it is out, and — the claim that matters — the
    // **advanced rows hold the same value**, spelled the way a set of pages is spelled (`1`, `3-6`).
    await page.getByText('Advanced options').click();
    await page.getByRole('button', { name: 'Leave page 2 out of the crop' }).click();
    await expect(page.locator('.crop-scope')).toContainText('5 of 6 pages');
    // The **identity** of the page, not the count: removing page 1 instead of page 2 leaves `5 of 6 pages` standing (the
    // sentence above passes), and what breaks is which tile left the set — which is why the reading is the tile's own
    // attribute and the rows' spelling rather than the summary. The message is the claim's, and it is what a falsification
    // verdict quotes.
    await expect(tiles.nth(1), 'the tile that was clicked is the page that leaves the crop').toHaveAttribute(
      'data-cropped',
      'false',
    );
    await expect(page.getByRole('button', { name: 'Crop page 2 as well' })).toHaveAttribute('aria-pressed', 'false');
    const rowSpecs = await page
      .locator('.page-row')
      .evaluateAll((rows) =>
        rows.map((row) =>
          [...row.querySelectorAll('input')].map((input) => (input as HTMLInputElement).value).join('-'),
        ),
      );
    expect(rowSpecs, 'the advanced rows hold the set the tile just wrote').toEqual(['1', '3-6']);

    // …and the page on screen says it is not in the selection, with the one click that puts it back. Page 2 is the page
    // whose tile was just switched off, and it is where the box was already being drawn.
    await page.getByRole('button', { name: 'Draw the box on page 2' }).click();
    await expect(page.locator('[data-testid="crop-page-outside"]')).toContainText('Page 2 keeps its own crop box');
    await page.getByRole('button', { name: 'Crop page 2 too' }).click();
    await expect(page.locator('.crop-scope')).toContainText('Every page');
    // Back to every page is the *absent* value, not a selection that happens to name all six: one spelling for one
    // request, which is why the rows emptied rather than listing `1-6`.
    await expect(page.locator('.page-row input')).toHaveCount(1);
    await expect(page.locator('.page-row input').first()).toHaveValue('');

    // And out again, because that selection is what the job below is run with.
    await page.getByRole('button', { name: 'Leave page 2 out of the crop' }).click();
    await expect(page.locator('.crop-scope')).toContainText('5 of 6 pages');

    await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const bytes = readFileSync((await (await download).path())!);
    // Six pages before and after: the crop is a page attribute, so the count is not the assertion — the boxes are.
    expect(countPdfPages(bytes)).toBe(6);

    const cropBox = firstPageCropBox(bytes);
    expect(cropBox).not.toBeNull();
    expect(cropBox!.width).toBeCloseTo(WIDTH - 2 * 20 * PT_PER_MM, 1);
    expect(cropBox!.height).toBeCloseTo(HEIGHT - 2 * 20 * PT_PER_MM, 1);

    // **Five boxes for five pages.** Page 2 was taken out of the selection before the run, so it keeps whatever crop box
    // it arrived with — which for this fixture is none at all — while the other five carry one of their own. A count is
    // the assertion rather than the handler's `pagesCropped`, because that number is the report this case is checking;
    // and it is the only reading that can fail for "the selection was ignored and every page got the box", which every
    // other assertion in this file passes.
    expect(cropBoxCount(bytes)).toBe(5);

    // And the page itself is untouched: the crop is non-destructive, so the MediaBox is what it was. A handler that
    // rewrote the page instead would still satisfy the check above.
    const mediaBox = firstPageMediaBox(bytes);
    expect(mediaBox!.width).toBeCloseTo(WIDTH, 1);
    expect(mediaBox!.height).toBeCloseTo(HEIGHT, 1);
  });
});
