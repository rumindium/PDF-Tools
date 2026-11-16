import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages, pdfPageTexts } from '../lib/pdf-inspect';

/**
 * `reorder-pages`, arranged in the browser and read back out of the file (`0-CICD.md` §3.8).
 *
 * This tool had two golden cases and neither could fail for the wrong arrangement — `expectText` searched the whole
 * document at once (`1,2,3` and `3,2,1` are the same haystack) and `expectPages` counted pages, of which a reordered
 * document has exactly as many (defect 226). The harness grew `--expect-page-text` for that (`scripts/ci/golden.ts`),
 * which is the API's half. This file is the other half, and it is the one that can fail for the failure the *user*
 * would have hit: the form used to ask for the arrangement **as typed page numbers** — a permutation of a document
 * that is already on screen — and the board that replaced it has to write the arrangement it draws.
 *
 * Six things are claimed, and each of them is a way the board could be a picture rather than a control:
 *
 *  1. **The board is the options.** There is no second editor: the arrangement's three keys are declared `page-order`,
 *     and the options panel draws nothing for them (asserted as the absence of `.options-card`, which is the card the
 *     column would be).
 *  2. **Every way of arranging writes what the tiles show** — the arrow buttons, `Alt`+arrow with a tile focused, and a
 *     drag onto either half of another tile (the two halves being different arrangements, which is why the landing edge
 *     is drawn).
 *  3. **A copy is a copy of that page, where the page is.** The ⊕ counts the appearances of the page in the output, the
 *     header counts the output, and the toolbar offers to take them off again.
 *  4. **The file says what the tiles said.** The pages are read back with `pdftotext`, page by page, in the order the
 *     browser arranged them — copies included. A board whose payload reordered nothing passes everything above and fails
 *     here.
 *  5. **The cards are stacked, measured — not named.** One grid track, both cards its width, the arrangement below the
 *     document. This is the assertion that a stale bundle fails while the other four still pass (defect 236), which is
 *     why it reads rendered boxes instead of a class.
 *  6. **The head of a tile fits at the width the board draws it at.** A label and a counted stepper share 130 px of a
 *     148 px tile, and the label was the flex item that gave way: with `nowrap` it did not shrink, so its text ran past
 *     its own box and **under the stepper's buttons** — a control covering the label it belongs to (defect 240). The
 *     claim is read from the *text* rather than the box (`Range.getBoundingClientRect`), because an overflowing label
 *     is exactly the case a box comparison cannot see, and it is checked at the stage's own width and at a narrow one.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six pages, each of which prints `page N of 6`: the only fixture text that makes an arrangement readable from bytes. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');
const REPO_ROOT = process.cwd();

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

/** The source page under each output position, read off the tiles — what the board is showing, in order. */
function arranged(page: Page) {
  return page.locator('.order-tile .order-from strong');
}

/**
 * The first tile's head, as the pointer finds it: where the label's **text** ends and where the stepper begins.
 *
 * The two numbers come from different places on purpose. The label's box (`getBoundingClientRect`) is what the flex row
 * decided, and it is smaller than the words whenever the row ran out of width — which is the whole defect. A `Range`
 * over the label's contents reports the ink, so `text.right > stepper.left` is the one reading that means "the button
 * covers the label". `sameLine` is reported rather than asserted: a tile too narrow for both wraps the stepper onto its
 * own line, which is the arrangement working, not failing.
 */
function headGeometry(page: Page) {
  return page.evaluate(() => {
    const tile = document.querySelector<HTMLElement>('.order-tile');
    const from = tile?.querySelector<HTMLElement>('.order-from');
    const step = tile?.querySelector<HTMLElement>('.order-copy-step');
    if (!tile || !from || !step) return null;
    const range = document.createRange();
    range.selectNodeContents(from);
    const text = range.getBoundingClientRect();
    const stepper = step.getBoundingClientRect();
    return {
      tile: tile.offsetWidth,
      clipped: from.scrollWidth > from.clientWidth,
      sameLine: Math.abs(stepper.top - text.top) < 8,
      gap: Math.round(stepper.left - text.right),
    };
  });
}

/** The output positions the board draws (`1`, `2`, …) — the numbering the arrangement is *about*. */
function positions(page: Page) {
  return page.locator('.order-tile .order-pos');
}

test.describe('an arrangement, as a browser makes it', () => {
  test('the tiles are the form, every gesture writes them, and the downloaded file agrees', async ({ page }) => {
    await page.goto('/tools/reorder-pages');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/organize/i);

    // Nothing is uploaded: one card, the drop target at full width, and no board — the pages of a document that does not
    // exist yet cannot be arranged.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await expect(page.locator('.order-card')).toHaveCount(0);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    // The document is in, so the board is.
    await expect(page.locator('.tool-split-board')).toHaveCount(1);
    await expect(page.locator('.order-card')).toBeVisible();

    // **The two cards are stacked, and this is measured rather than assumed.** This tool's product is a row of tiles, so
    // the document is one band on top and the arrangement gets the entire width under it; a board that put them side by
    // side would wrap the row at two thirds of the page, which is the one thing this screen may not do. The claim is
    // geometric on purpose — it is exactly the claim a *stale bundle* falsifies while every other test in this file
    // still passes (defect 236: the stacked CSS was served and a tab on the old stylesheet drew the old columns), so
    // the assertion is about rendered boxes and the served stylesheet's single track, not about a class name.
    // The numbers are **layout** boxes (`offsetWidth`/`offsetTop`) rather than rendered ones (`getBoundingClientRect`), and
    // that is not a shortcut: the order card arrives with an entry animation, and a rect read mid-animation is a scaled
    // box — the first run of this assertion measured the card 1.95 px narrower than its own column and would have failed
    // at random for a reason that has nothing to do with the layout (defect 237). Layout boxes are what the grid decided,
    // they are integers both sides, and a transform cannot move them.
    const stacked = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('.tool-split-board');
      const first = board?.firstElementChild as HTMLElement | null;
      const second = board?.lastElementChild as HTMLElement | null;
      if (!board || !first || !second) return null;
      const columns = getComputedStyle(board).gridTemplateColumns.split(' ').filter(Boolean);
      return {
        columns: columns.length,
        // The column is `clientWidth` (no border, no scrollbar) and the cards are its width exactly — "full width" is an
        // equality here, not a percentage with a tolerance to hide behind.
        firstWidth: first.offsetWidth - board.clientWidth,
        secondWidth: second.offsetWidth - board.clientWidth,
        // Below, not beside: the second card starts where the first one ends.
        below: second.offsetTop >= first.offsetTop + first.offsetHeight,
      };
    });
    expect(stacked, 'the two cards are stacked rather than side by side').toEqual({
      columns: 1,
      firstWidth: 0,
      secondWidth: 0,
      below: true,
    });

    //
    // **The head of a tile fits, at the width this board draws tiles at.** Six pages in one row of a stacked board is a
    // 148 px tile, and its head has 130 px for a `page 1` label and the counted stepper — 38 px and 76 px of text and
    // control with 6 px between them. The label is the flex item that gave way, and with `nowrap` giving way does not
    // shrink it: its words ran past its own box and **under the stepper**, so the ⊕ and the ⊖ sat on top of the label
    // they belong to (defect 240). Two readings, and neither is about a class name: the label is not clipped, and where
    // the label's *text* ends is left of where the stepper begins — while they share a line. A tile too narrow for both
    // wraps the stepper onto its own line instead, which is why the same two readings are taken at 1000 px as well.
    //
    const wide = await headGeometry(page);
    expect(wide).not.toBeNull();
    expect(wide!.clipped).toBe(false);
    if (wide!.sameLine) expect(wide!.gap).toBeGreaterThan(0);

    await page.setViewportSize({ width: 1000, height: 900 });
    const narrow = await headGeometry(page);
    expect(narrow).not.toBeNull();
    expect(narrow!.clipped).toBe(false);
    if (narrow!.sameLine) expect(narrow!.gap).toBeGreaterThan(0);
    // Back to the stage's own width before anything else is measured or dragged: a viewport left narrow would move every
    // pointer target this case has yet to use (the lesson of defect 238).
    await page.setViewportSize({ width: 1440, height: 900 });
    // …and there is no second way to say the same thing. This is the assertion the old build failed: the options column
    // used to hold `order` and `duplicate` as text boxes, one of them asking for a permutation of the file.
    await expect(page.locator('.options-card')).toHaveCount(0);

    await expect(positions(page)).toHaveText(['1', '2', '3', '4', '5', '6']);
    await expect(arranged(page)).toHaveText(['1', '2', '3', '4', '5', '6']);
    await expect(page.locator('.order-card .card-head')).toContainText('6 pages · 6 out');
    await expect(page.locator('.order-summary')).toContainText('already have');

    // **Reverse** is a button and not a switch: it writes the same arrangement a person would produce by dragging every
    // page, which is why the summary counts pages rather than naming an option.
    await page.getByRole('button', { name: 'Reverse' }).click();
    await expect(arranged(page)).toHaveText(['6', '5', '4', '3', '2', '1']);
    await expect(positions(page)).toHaveText(['1', '2', '3', '4', '5', '6']);
    await expect(page.locator('.order-summary')).toHaveText('6 pages in new places → 6 pages out.');

    // …and back, in one click, without touching the pages.
    await page.getByRole('button', { name: 'Reset order' }).click();
    await expect(arranged(page)).toHaveText(['1', '2', '3', '4', '5', '6']);
    await expect(page.locator('.order-summary')).toContainText('already have');
    await expect(page.getByRole('button', { name: 'Reset order' })).toBeDisabled();

    // The arrow on a tile moves **that page** one position: `page 5` ends up last, and the caret follows it there rather
    // than staying on the tile it used to be — which is what makes a second keypress continue the same move.
    await page.getByRole('button', { name: 'Move page 5 later in the output' }).click();
    await expect(arranged(page)).toHaveText(['1', '2', '3', '4', '6', '5']);
    await expect(page.getByRole('button', { name: /Page 5 of 6, position 6 of 6/ })).toBeFocused();

    // The keyboard model, on the caret the move just left: `Alt`+arrow is the whole of it, and the ends say nothing
    // instead of wrapping a page from the front to the back.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(arranged(page)).toHaveText(['1', '2', '3', '4', '5', '6']);
    await expect(page.getByRole('button', { name: /Page 5 of 6, position 5 of 6/ })).toBeFocused();

    // **A copy belongs to its page.** One ⊕ on page 3: the tile says the page is in the output twice, the header counts
    // the extra page, and the toolbar grows the one button that can take it off.
    await page.getByRole('button', { name: 'One more copy of page 3, right after it' }).click();
    await expect(page.locator('.order-copies')).toHaveText(['×2']);
    await expect(page.locator('.order-copy-count')).toHaveText(['1', '1', '2', '1', '1', '1']);
    await expect(page.locator('.order-card .card-head')).toContainText('6 pages · 7 out');
    await expect(page.locator('.order-summary')).toHaveText('1 extra copy → 7 pages out.');
    await expect(page.getByRole('button', { name: 'Remove 1 copy' })).toBeVisible();
    // The page itself has not moved, so the *positions* are untouched: a copy is a page added, not a page rearranged.
    await expect(arranged(page)).toHaveText(['1', '2', '3', '4', '5', '6']);

    // **The drop is two-sided, and it says which side.** Page 1 dragged over the left half of page 4 lands *before* it,
    // over the right half *after* it — the two arrangements differ, so the edge that is drawn is the answer to a real
    // question. Measured here as the CSS state a person sees, because a landing that could not be told apart from the
    // other one makes the drop a guess.
    const halves = await page.evaluate(async () => {
      const tiles = [...document.querySelectorAll('.order-tile')] as HTMLElement[];
      const settle = async (done: () => boolean) => {
        for (let tries = 0; tries < 100; tries += 1) {
          if (done()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };
      const data = new DataTransfer();
      tiles[0]!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      //
      // Wait for the **state**, not for a frame. The tile being dragged is React state, so a `dragover` dispatched in the
      // same task runs against the handler that still believes no drag is in progress and draws nothing. An arbitrary
      // delay would make this pass for the wrong reason on a fast machine and flake on a slow one; polling the attribute
      // the handler sets is the fact itself — and if it never appears, the assertion below fails rather than skipping.
      //
      const registered = await settle(() => tiles[0]!.dataset.dragging === 'true');
      /**
       * Hover one half of the third tile and read the state **after it settles** — the attribute is set by a React render,
       * so a read taken in the same task as the event sees the previous state and a read taken after `settle` sees the
       * answer. The shadow is read with it, because the CSS is what a person actually sees.
       */
      const read = async (fraction: number, side: 'before' | 'after') => {
        const box = tiles[3]!.getBoundingClientRect();
        tiles[3]!.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            dataTransfer: data,
            clientX: box.left + box.width * fraction,
            clientY: box.top + 40,
          }),
        );
        const seen = await settle(() => tiles[3]!.dataset.over === side);
        // The edge is a `box-shadow`, and a shadow **transitions** into place: the attribute lands several frames before
        // the edge is the width it is drawn at, so waiting for the attribute alone reads `0.38px`. Waited for by its own
        // value, which is also what makes this an assertion about the drawing rather than about the state behind it.
        const inset = side === 'before' ? '3px 0px 0px 0px inset' : '-3px 0px 0px 0px inset';
        const drawn = await settle(() => getComputedStyle(tiles[3]!).boxShadow.includes(inset));
        return { over: tiles[3]!.dataset.over, shadow: getComputedStyle(tiles[3]!).boxShadow, seen: seen && drawn };
      };
      const left = await read(0.2, 'before');
      const right = await read(0.8, 'after');
      const leftSeen = left.seen;
      const rightSeen = right.seen;
      const leftShadow = left.shadow;
      const rightShadow = right.shadow;
      tiles[0]!.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      await settle(() => tiles[0]!.dataset.dragging !== 'true');
      return { registered, left, leftSeen, leftShadow, right, rightSeen, rightShadow };
    });
    expect(halves.registered).toBe(true);
    expect(halves.leftSeen).toBe(true);
    expect(halves.left.over).toBe('before');
    expect(halves.leftShadow).toContain('3px 0px 0px 0px inset');
    expect(halves.rightSeen).toBe(true);
    expect(halves.right.over).toBe('after');
    expect(halves.rightShadow).toContain('-3px 0px 0px 0px inset');

    //
    // **The drop itself**: page 1 onto the right half of page 4, so it lands *after* it — one page moved, and it is the
    // page that moved rather than the two swapping (`moveSlot` is a splice).
    //
    // The three events are dispatched rather than driven through `dragTo`/`mouse`, and the reason is worth stating: the
    // browser's own drag initiation is not this app's code, and in this environment the pointer-driven APIs do not start
    // a native HTML5 drag at all — measured, `dragTo` and a hand-rolled `mouse.down/move/up` both left the board
    // untouched and the case green-on-nothing. What *is* this app's code is the handler chain: `dragstart` registers the
    // source, `dragover` decides which half of the target is under the pointer and draws the edge, `drop` computes the
    // landing index. Those are exactly the three events dispatched here, through the same element, with the same
    // `DataTransfer` — so the arithmetic under test is the arithmetic a person's drag runs.
    //
    const dropped = await page.evaluate(async (targetIndex: number) => {
      const tiles = [...document.querySelectorAll('.order-tile')] as HTMLElement[];
      const settle = async (done: () => boolean) => {
        for (let tries = 0; tries < 100; tries += 1) {
          if (done()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };
      const data = new DataTransfer();
      tiles[0]!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      await settle(() => tiles[0]!.dataset.dragging === 'true');
      const box = tiles[targetIndex]!.getBoundingClientRect();
      const at = { clientX: box.left + box.width * 0.8, clientY: box.top + 40 };
      tiles[targetIndex]!.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: data, ...at }));
      tiles[targetIndex]!.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data, ...at }));
      await settle(() => tiles[0]!.dataset.dragging !== 'true');
      return [...document.querySelectorAll('.order-tile .order-from strong')].map((node) => node.textContent);
    }, 3);
    expect(dropped).toEqual(['2', '3', '4', '1', '5', '6']);
    await expect(arranged(page)).toHaveText(['2', '3', '4', '1', '5', '6']);
    await expect(page.locator('.order-summary')).toHaveText('4 pages in new places · 1 extra copy → 7 pages out.');

    // **Run it, and read the order out of the file.** `2,3,4,1,5,6` with one copy of page 3 is `2,3,3,4,1,5,6`: seven
    // pages, in that order, asserted one page at a time because the page boundary is the fact under test.
    await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/· 7 pages/).first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    const bytes = readFileSync((await file.path())!);
    expect(countPdfPages(bytes)).toBe(7);
    const pages = await pdfPageTexts(bytes, { repoRoot: REPO_ROOT });
    expect(pages).not.toBeNull();
    for (const [index, sourcePage] of [2, 3, 3, 4, 1, 5, 6].entries()) {
      expect(pages![index]).toContain(`page ${sourcePage} of 6`);
    }
  });
});
