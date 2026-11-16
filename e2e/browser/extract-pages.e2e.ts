import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages } from '../lib/pdf-inspect';

/**
 * The page **selection**, driven through the app the user loads (`0-CICD.md` §3.8).
 *
 * `split.e2e.ts` covers one row per *output file*, and `delete-pages.e2e.ts` covers removing a page by clicking it in
 * the preview. This file covers the other reading of the same grammar — one selection, whose pages are either the
 * document or what the document keeps — and the three questions that reading makes possible, none of which any other
 * stage asks:
 *
 *  1. **The choice comes first, and it changes what everything below it means.** `extract-pages` asks "kept or
 *     removed" before it asks which pages, so the assertion is on the *order* of the two controls as much as on their
 *     values: the same `2` is one page to keep in one position and one page to drop in the other, and a screen that
 *     asked the page first would be asking a question whose answer changes meaning.
 *  2. **A selection is not a file per row.** Three rows are three decisions — a page, a second page, a range — and the
 *     output is one document. Nothing about a split's grouping applies, and the summary line is what states it.
 *  3. **A page this document does not have is refused with the count, before Run.** The plan used to draw
 *     `Output · 99` over a rectangle where page 99 would have been, and the mistake only arrived as a failed job.
 *
 * What the browser produces is checked against the file the server returns: the last case downloads the output and
 * counts its page objects, because a label that disagrees with the bytes is the failure mode this whole suite exists
 * for.
 *
 * **The preview is two halves here** — kept and removed — even though this tool is the *keeping* one. That is the
 * point rather than a coincidence: the halves are drawn from the plan's own `halves` field, which is the output on one
 * side and its complement on the other, so the same screen serves a tool that names what stays and one that names what
 * goes (`page-plan/plan.ts`). The assertions below are therefore on **sides**, never on a single `Output` section, and
 * the side a page is on is what the direction choice moves it between.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** 12 pages, so a four-page removal is 8 pages left and the count says which of the two readings ran. */
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

/** One box of one row, addressed the way a screen reader names it (`page-rows.tsx`). */
function rowBox(page: Page, row: number, end: 'from' | 'to') {
  return page.getByLabel(`Pages, row ${row} ${end}`);
}

/**
 * The direction choice, as the two cards it is drawn as rather than a dropdown.
 *
 * The **card** is what is clicked, because the card is what a user clicks: the radio inside it is visually hidden and
 * the `<label>` is the hit target, so `check()` on the input is a click intercepted by the thing it is wrapped in.
 */
function direction(page: Page, label: 'Pages to keep' | 'Pages to remove') {
  return page.locator('.segmented-card').filter({ hasText: label });
}

/** One side of the plan, as the preview draws it (`page-plan/index.tsx`). */
function half(page: Page, side: 'kept' | 'removed') {
  return page.locator(`.plan-half[data-side="${side}"]`);
}

test.describe('a page selection, as a browser walks it', () => {
  test('the choice comes first, and the rows beneath it follow the boxes', async ({ page }) => {
    await page.goto('/tools/extract-pages');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/extract/i);

    // Nothing uploaded: one column, no options — the questions about pages that do not exist yet are not asked.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await expect(page.locator('.options-card')).toHaveCount(0);

    await chooseFile(page, TWELVE_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await expect(page.locator('.tool-split')).toHaveCount(1);

    // **The order.** The choice is drawn above the pages it interprets, and both of its alternatives are visible — a
    // dropdown would hide the one that is not chosen, which for this choice is the alternative that re-reads the form.
    const choice = page.locator('.segmented-card');
    await expect(choice).toHaveCount(2);
    await expect(choice.nth(0)).toContainText('Pages to keep');
    await expect(choice.nth(1)).toContainText('Pages to remove');
    await expect(choice.nth(0)).toHaveAttribute('data-active', 'true');
    const boxes = await page.locator('.page-row-boxes').first().boundingBox();
    const segmented = await page.locator('.segmented').boundingBox();
    expect(segmented!.y).toBeLessThan(boxes?.y ?? Number.NEGATIVE_INFINITY);

    // A fresh selection is one empty row and a sentence that says what is missing — not a silently empty form.
    await expect(page.locator('.page-row')).toHaveCount(1);
    await expect(page.getByText('Nothing selected yet — the job needs at least one page to keep.')).toBeVisible();

    // A page is one box, so the second box and the hyphen do not exist until the row is a range.
    await expect(rowBox(page, 1, 'to')).toHaveCount(0);
    await rowBox(page, 1, 'from').fill('2');
    await expect(page.getByText('Keeps 1 of 12 pages.')).toBeVisible();
    // One page kept, eleven dropped — and both counts are stated where the pages are, not only beside the boxes.
    await expect(half(page, 'kept').locator('.plan-page-no')).toHaveText(['2']);
    await expect(half(page, 'removed').locator('.plan-page-no')).toHaveCount(11);
    await expect(page.getByText('Kept 1 · Removed 11')).toBeVisible();

    // **The rows continue the work they can see.** The new row arrives with the first page nobody named (`1`), which is
    // what makes the second click a continuation rather than a blank box, and the caret is in it.
    await page.getByRole('button', { name: 'Add page' }).click();
    await expect(rowBox(page, 2, 'from')).toHaveValue('1');
    await expect(rowBox(page, 2, 'from')).toBeFocused();

    // …and `Add range` takes the run from there: pages 3–12, in two boxes, with the join drawn.
    await page.getByRole('button', { name: 'Add range' }).click();
    await expect(rowBox(page, 3, 'from')).toHaveValue('3');
    await expect(rowBox(page, 3, 'to')).toHaveValue('12');
    await expect(page.getByText('Keeps all 12 pages — the output is the whole document.')).toBeVisible();
    // Every page named, so there is nothing left to add and both buttons say so by going quiet.
    await expect(page.getByRole('button', { name: 'Add page' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add range' })).toBeDisabled();

    // A page named twice is said once: the value cannot carry it (duplicates are idempotent), so this sentence is the
    // only place the user learns that their third row changed nothing. Page 1 stops being named here, so the count
    // moves as well — two facts, one sentence.
    await rowBox(page, 2, 'from').fill('2');
    await expect(page.getByText('Keeps 11 of 12 pages. page 2 is named twice.')).toBeVisible();
    await rowBox(page, 2, 'from').fill('1');
    await expect(page.getByText('Keeps all 12 pages — the output is the whole document.')).toBeVisible();

    // A page this document does not have is *not* a page of it. The plan refuses it in the worker's own words, with the
    // count the user cannot see, and draws no output rather than a rectangle where page 99 would have been.
    await rowBox(page, 1, 'from').fill('99');
    await expect(page.getByText('This selection needs attention')).toBeVisible();
    await expect(page.getByText('This document has 12 pages; page 99 does not exist.')).toBeVisible();
    // No halves either: a plan that cannot run is not a plan to look at, and two empty columns would be a drawing of
    // the refusal's subject rather than of the refusal.
    await expect(page.locator('.plan-half')).toHaveCount(0);

    // A token the grammar does not know is a different mistake, reported at its own row: the value is not forwarded, so
    // the plan keeps drawing the last plan that was actually valid.
    await rowBox(page, 1, 'from').fill('abc');
    await expect(page.getByText('"abc" is not a page or a page range.')).toBeVisible();
    await expect(rowBox(page, 1, 'from')).toHaveAttribute('aria-invalid', 'true');
    await rowBox(page, 1, 'from').fill('1-2');
    await expect(page.getByText('"abc" is not a page or a page range.')).toHaveCount(0);
    // Recovered, and the plan is the plan of all three rows: `1-2`, page `1` from before, and `3-12` — the whole
    // document kept, which the removed half now states rather than drawing nothing.
    await expect(half(page, 'kept').locator('.plan-page-no')).toHaveCount(12);
    await expect(half(page, 'removed')).toContainText('None — every page stays in the output.');
    await expect(page.getByText('Kept 12 · Removed 0')).toBeVisible();
  });

  test('removing reads the same value the other way round, and the file proves it', async ({ page }) => {
    await page.goto('/tools/extract-pages');
    await chooseFile(page, TWELVE_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    // The choice re-reads the *meaning* of the control below it, so its own sentence follows: the same empty form is
    // now waiting to remove something.
    await direction(page, 'Pages to remove').click();
    await expect(page.getByRole('radio', { name: 'Pages to remove' })).toBeChecked();
    await expect(page.locator('.segmented-card').nth(1)).toHaveAttribute('data-active', 'true');
    await expect(page.getByText('Nothing selected yet — the job needs at least one page to remove.')).toBeVisible();

    // A page row has one box, and an empty `To` on a range means **one page** — the state the old single text box could
    // reach as `4-` and the API had to refuse. Here the row is filled as a page first, so the count is one page.
    await rowBox(page, 1, 'from').fill('2');
    await expect(page.getByText('Removes 1 of 12 pages — 11 stay.')).toBeVisible();

    // …and it becomes a range **in place**: the second box arrives in the same row, focused, with the hyphen drawn
    // between them. Deleting the row and adding a range would be the same value through two more clicks.
    await page.getByRole('button', { name: 'Pages, make row 1 a range' }).click();
    await expect(rowBox(page, 1, 'to')).toBeFocused();
    await rowBox(page, 1, 'to').fill('5');
    await expect(page.getByText('Removes 4 of 12 pages — 8 stay.')).toBeVisible();
    // The plan beside it now draws the *complement*: pages 1 and 6–12 on the kept side, and the four named pages on
    // the removed side — the same value, drawn from both ends, which is what the two halves are for.
    await expect(half(page, 'kept').locator('.plan-page-no')).toHaveText(['1', '6', '7', '8', '9', '10', '11', '12']);
    await expect(half(page, 'removed').locator('.plan-page-no')).toHaveText(['2', '3', '4', '5']);
    await expect(page.getByText('Kept 8 · Removed 4')).toBeVisible();

    // …and the one removal the worker refuses is refused **before** Run, in its own words: an empty PDF is never a
    // useful output, so a selection that takes every page is a mistake rather than a job that fails. The preview used
    // to draw one output with no pages in it and label that empty list `pages unknown` — a sentence about a page count
    // that has not arrived, which is a different thing and, here, not true.
    await rowBox(page, 1, 'from').fill('1');
    await rowBox(page, 1, 'to').fill('z');
    await expect(page.getByText('Removing those pages would leave an empty document.')).toBeVisible();
    await expect(page.locator('.plan-half')).toHaveCount(0);
    // Back to the four-page removal, and the assertion that the warning was about the selection rather than sticky.
    await rowBox(page, 1, 'from').fill('2');
    await rowBox(page, 1, 'to').fill('5');
    await expect(page.getByText('Removing those pages would leave an empty document.')).toHaveCount(0);

    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    // The panel's own sentence, and `.first()` because the run's page count is stated in more than one place (the
    // result summary and the compare row) — the assertion is about the number, not about which of them printed it.
    await expect(page.getByText(/· 8 pages/).first()).toBeVisible();

    // The bytes, not the label: eight page objects in the file the server handed back.
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    expect(countPdfPages(readFileSync((await file.path())!))).toBe(8);
    expect(file.suggestedFilename()).toBe('extracted.pdf');
  });
});
