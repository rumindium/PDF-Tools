import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages } from '../lib/pdf-inspect';

/**
 * The page **selection**, driven the other way: by clicking the pages themselves (`0-CICD.md` §3.8).
 *
 * `extract-pages.e2e.ts` walks the same grammar through the form. This file exists for the one thing a form cannot do:
 * the preview is a **control**, and a click on a page moves it between the kept half and the removed half. That makes
 * this the only case in the suite where the browser's own gesture — a click on a picture of a page — is the input the
 * job runs on, so the assertions are about the *value* the click produced (the rows control beside it) and about the
 * bytes that value produced (the downloaded file's page count), not about the pixels.
 *
 * The three claims:
 *
 *  1. **A click moves a page, and it is the only thing it does.** The tile is a button whose accessible name says what
 *     will happen ("Remove page 5 from the output"), and the magnifier that opens the page larger is a *separate*
 *     labelled button — a second action on a tile whose number is the only other clue.
 *  2. **The click writes the same value the boxes write.** The rows control redraws from it, so a run of pages the user
 *     clicked arrives as a range (`3-4`), not as pages — the spelling a person would have typed.
 *  3. **The halves are the document, partitioned.** Clicking a page back in the removed half keeps it, so both
 *     directions of the click are exercised before the job runs, and the file it downloads is the count that proves it.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** 12 pages: a three-page removal is 9 pages left, and a two-page removal is 10 — the count says which click landed. */
const TWELVE_PAGES = join(FIXTURES, 'split-twelve-a4.pdf');

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

function half(page: Page, side: 'kept' | 'removed') {
  return page.locator(`.plan-half[data-side="${side}"]`);
}

/**
 * One box of one row, addressed the way a screen reader names it (`page-rows.tsx`).
 *
 * The label is the catalogue's own — `Pages to remove` for this tool, `Pages` for `extract-pages`, where a sibling
 * choice supplies the meaning — and each box carries it plus its position, so a screen reader hears "Pages to remove,
 * row 2 from".
 */
function rowBox(page: Page, row: number, end: 'from' | 'to') {
  return page.getByLabel(`Pages to remove, row ${row} ${end}`);
}

test.describe('a page removed by clicking it', () => {
  test('a click moves a page across, writes the value the boxes would have, and the file proves it', async ({
    page,
  }) => {
    await page.goto('/tools/delete-pages');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/remove/i);

    // Nothing to remove yet: every page is on the kept side, the removed side is drawn and empty, and it says the fact
    // rather than being absent — an absent section would leave a first click pointing at nothing.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await chooseFile(page, TWELVE_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await expect(page.locator('.tool-split')).toHaveCount(1);
    await expect(half(page, 'kept').locator('.plan-page-no')).toHaveText([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
    ]);
    await expect(half(page, 'removed').locator('.plan-page')).toHaveCount(0);
    await expect(half(page, 'removed')).toContainText('None — every page stays in the output.');
    await expect(page.getByText('Kept 12 · Removed 0')).toBeVisible();

    // Each of the two actions on a tile is labelled, and they are different actions: the tile says which way the page
    // will move, and the magnifier says it will only look.
    await expect(page.getByRole('button', { name: 'Remove page 3 from the output' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Look at page 3 closer' })).toBeAttached();

    // **The click.** Page 3 moves to the other half, both counts move with it, and the page is drawn on its new side.
    await page.getByRole('button', { name: 'Remove page 3 from the output' }).click();
    await expect(half(page, 'kept').locator('.plan-page-no')).toHaveText([
      '1',
      '2',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
    ]);
    await expect(half(page, 'removed').locator('.plan-page-no')).toHaveText(['3']);
    await expect(page.getByText('Kept 11 · Removed 1')).toBeVisible();

    // …and the boxes below it redraw from the same value, which is the whole reason the click writes the option rather
    // than a preview-only list: the two controls cannot come to hold different plans.
    await expect(rowBox(page, 1, 'from')).toHaveValue('3');
    await expect(page.getByText('Removes 1 of 12 pages — 11 stay.')).toBeVisible();

    // A second click, adjacent to the first: the page number stays a page and does not become a range of one.
    await page.getByRole('button', { name: 'Remove page 4 from the output' }).click();
    await expect(rowBox(page, 1, 'from')).toHaveValue('3');
    await expect(rowBox(page, 1, 'to')).toHaveValue('4');
    // A page inside the range, clicked out of it: the set splits and the value is respelled **as two runs** — the
    // spelling a person would have typed, which is the point of writing back through the grammar.
    await page.getByRole('button', { name: 'Keep page 3 in the output' }).click();
    await expect(rowBox(page, 1, 'from')).toHaveValue('4');
    await expect(rowBox(page, 1, 'to')).toHaveCount(0);

    // The other direction, at the other boundary: a page nobody has named is put back on the removed side by a click,
    // and the click that lands beside it merges into the same run.
    await page.getByRole('button', { name: 'Remove page 9 from the output' }).click();
    await page.getByRole('button', { name: 'Remove page 8 from the output' }).click();
    await expect(half(page, 'removed').locator('.plan-page-no')).toHaveText(['4', '8', '9']);
    await expect(page.getByText('Kept 9 · Removed 3')).toBeVisible();
    await expect(page.getByText('Removes 3 of 12 pages — 9 stay.')).toBeVisible();
    // Two rows, because `4` and `8-9` are two runs: the value the click wrote is what the boxes show.
    await expect(page.locator('.page-row')).toHaveCount(2);
    await expect(rowBox(page, 2, 'from')).toHaveValue('8');
    await expect(rowBox(page, 2, 'to')).toHaveValue('9');

    // The form still drives the preview in the other direction — the integration is both ways, not a one-way copy.
    await rowBox(page, 2, 'to').fill('10');
    await expect(half(page, 'removed').locator('.plan-page-no')).toHaveText(['4', '8', '9', '10']);
    await expect(half(page, 'kept')).not.toContainText('10');
    await rowBox(page, 2, 'to').fill('9');

    // The magnifier is still a magnifier: it opens the page rather than moving it, and the value is untouched. This is
    // the assertion that keeps the second action from being lost to the first — a tile whose every click removes a page
    // is a preview nobody can inspect.
    await page.getByRole('button', { name: 'Look at page 1 closer' }).click();
    await expect(page.locator('.lightbox-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox-panel')).toHaveCount(0);
    await expect(half(page, 'removed').locator('.plan-page-no')).toHaveText(['4', '8', '9']);

    // Run it, and the file is the count the two halves promised.
    await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/· 9 pages/).first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    expect(countPdfPages(readFileSync((await file.path())!))).toBe(9);
    expect(file.suggestedFilename()).toBe('trimmed.pdf');
  });
});
