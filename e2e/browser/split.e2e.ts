import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages, countZipEntries } from '../lib/pdf-inspect';

/**
 * The one multi-output tool, driven through the app the user loads (`0-CICD.md` §3.8).
 *
 * `upload.e2e.ts` proves the chain a single-output job walks. This file exists for the **multi-output** half of it, and
 * it now covers three defects that were, in the end, the same defect — *the screen did not speak the shape of its own
 * data*:
 *
 *  1. `split`'s `ranges` option — its *default* mode — was declared in the catalog as a flat `pages` control, so the
 *     form sent `["1-3", "4-8"]` to a schema that wants `[["1-3"], ["4-8"]]` and every submission typed into the
 *     browser was refused with `Expected array, received string` (`packages/contracts/src/tools/types.ts`,
 *     `range-groups`). Every other stage was green, because every other stage posts the nested shape itself.
 *  2. It then became a `<textarea>` with one line per output — the right data in the wrong control: adding an output
 *     was a newline, the second row could not be filled with what the first had left over, and the pages no output
 *     would get were invisible until the zip was opened. `features/tool-shell/range-rows.tsx` replaced it, and the
 *     preview beside it (`features/page-plan/`) draws the outputs rather than a list of filenames.
 *  3. A range was still spelled `1-5` in one box — the hyphen was syntax the user had to type, and `4-` was a state
 *     the form could reach and the API had to refuse. A range is two numbers, so it is **two boxes** now: empty `to`
 *     means one page, and the half-typed range is unrepresentable rather than merely rejected.
 *
 * And the screen the plan lives on is two columns **only once there is a document**: the options that decide which
 * pages go where are a question about a document that does not exist yet, so a page with nothing uploaded is the drop
 * target at full width. That is asserted here rather than assumed, because it is exactly the kind of order a later
 * change to the layout quietly reverses.
 *
 * So the assertions are about what the browser produces and what the file says:
 *
 *  - **the plan follows the boxes**, and it is checked on drawn pages (`.plan-page-no`, and a real `<img>` in the
 *    tile), not on a count: a preview that reported "3 pages" over three skeletons would pass everything else;
 *  - **a new row arrives with the pages nobody has claimed**, split across its own two boxes;
 *  - **an empty end is one page**, which is the whole reason the box exists;
 *  - **a range the grammar refuses is caught at the row**, and left out of the value, so the plan keeps the last plan
 *    that was valid;
 *  - and, unchanged and still the point of the whole file: two outputs for two rows, the names the server chose, a
 *    per-part link that serves the right pages, and an archive holding one entry per part.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** 12 pages, so `1-3` and the rest are 3 and 9 of them — two outputs whose sizes differ, which is what makes the
 *  page-count assertions say *which* part was served. */
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

/** One end of one range, addressed the way a screen reader names it. */
function rangeBox(page: Page, output: number, end: 'from' | 'to', segment?: number) {
  return page.getByLabel(`Ranges, output ${output} ${end}${segment ? ` (${segment})` : ''}`);
}

/** The plan's output groups, as the preview draws them. */
function planGroups(page: Page) {
  return page.locator('.plan-group');
}

test.describe('a split, as a browser walks it', () => {
  test('the drop target is the page until a document is in, and then the plan follows the boxes', async ({ page }) => {
    await page.goto('/tools/split');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/split/i);

    // Nothing uploaded: one column, and no options — the questions about pages that do not exist yet are not asked.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await expect(page.locator('.options-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible();

    await chooseFile(page, TWELVE_PAGES);
    // `Ready` is the badge the file card gets only after the API accepted the bytes and handed back an id.
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    // The document is in, so the second column exists — and with it the plan, which is the point of the screen.
    await expect(page.locator('.tool-split')).toHaveCount(1);
    await expect(page.locator('.options-card')).toHaveCount(1);
    await expect(planGroups(page)).toHaveCount(0);
    await expect(page.getByText('Add a range to make an output file.')).toBeVisible();

    await rangeBox(page, 1, 'from').fill('1');
    await rangeBox(page, 1, 'to').fill('3');

    // One output, with its three pages *drawn* — the numbers come from the plan and the `<img>` from pdf.js inside the
    // tile, so a preview that sketched the boxes and never rendered would fail here.
    await expect(planGroups(page)).toHaveCount(1);
    await expect(planGroups(page).first()).toContainText('1-3');
    //
    // …and it says it **once**. The header carries the label the user's boxes spell and, beside it, the pages that
    // label resolved to — but for a literal range those are the same text, so printing both read as two facts that
    // happened to agree (`resolvedPagesNote` in `features/page-plan/plan.ts`). The empty note is asserted rather than
    // the visible duplicate of the old build: a note that came back here would pass a looser check and fail this one.
    //
    await expect(planGroups(page).first().locator('.plan-group-head .tiny')).toHaveText('');
    await expect(planGroups(page).first().locator('.plan-page-no')).toHaveText(['1', '2', '3']);
    await expect(planGroups(page).first().locator('.plan-page').first().locator('img')).toBeVisible();
    await expect(page.getByText('9 pages in no output.')).toBeVisible();

    // "Add a range" continues the work rather than starting a blank pair: the row that appears holds what the first row
    // left, split across its own boxes, and the caret is in the first of them.
    await page.getByRole('button', { name: 'Add a range' }).click();
    await expect(rangeBox(page, 2, 'from')).toHaveValue('4');
    await expect(rangeBox(page, 2, 'to')).toHaveValue('12');
    await expect(rangeBox(page, 2, 'from')).toBeFocused();

    // The second output, and the sentence that says the document is fully covered — which is also why the add button
    // has stopped offering another row.
    await expect(planGroups(page)).toHaveCount(2);
    // The filled range is literal too — `4` and `12` — so its header is the label alone, for the same reason as above.
    await expect(planGroups(page).nth(1)).toContainText('4-12');
    await expect(planGroups(page).nth(1).locator('.plan-group-head .tiny')).toHaveText('');
    await expect(planGroups(page).nth(1).locator('.plan-page-no')).toHaveText([
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
    await expect(page.getByText('All 12 pages are in a file.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Every page is in a file' })).toBeDisabled();

    // The other half of the same rule: a spec that has to be **resolved** says both — what was asked for (`4-z`) and
    // what it turned out to be (`4–12`). Without this the previous two assertions would pass a header that never
    // showed a resolved range at all, which is the failure mode hiding a note always has.
    //
    await rangeBox(page, 2, 'to').fill('z');
    await expect(planGroups(page).nth(1)).toContainText('4-z');
    await expect(planGroups(page).nth(1).locator('.plan-group-head .tiny')).toHaveText('4–12');
    await expect(planGroups(page).nth(1).locator('.plan-page-no')).toHaveText([
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

    // The control's other knob, and the caret that was the dead part of it: a second range **inside** row 1 appears
    // without the row count changing, so a focus effect keyed on that count never fired — the box arrived and the caret
    // stayed in the one the user had finished with. It is asserted here because this control and the page-selection
    // rows carry the same code, and this is the only one of the two that can produce the state.
    await page.getByRole('button', { name: 'another range in this file' }).first().click();
    await expect(page.getByLabel('Ranges, output 1 from (2)')).toHaveValue('4');
    await expect(page.getByLabel('Ranges, output 1 from (2)')).toBeFocused();
    // And it goes away again without taking the row it lives in with it.
    await page.getByRole('button', { name: 'Remove range 2 from output 1' }).click();
    await expect(page.getByLabel('Ranges, output 1 from (2)')).toHaveCount(0);
  });

  test('two range rows become two parts, each downloadable', async ({ page }) => {
    await page.goto('/tools/split');
    await chooseFile(page, TWELVE_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    await rangeBox(page, 1, 'from').fill('1');
    await rangeBox(page, 1, 'to').fill('3');
    await page.getByRole('button', { name: 'Add a range' }).click();
    // The end is spelled with the grammar's last-page token rather than the number the add button filled in, so this
    // submission also covers `4-z` — which the schema refused outright before the `range-groups` control existed.
    await rangeBox(page, 2, 'to').fill('z');
    await expect(page.getByText('All 12 pages are in a file.')).toBeVisible();

    await page.getByRole('button', { name: /^Run / }).click();
    // The result panel only renders for a terminal, COMPLETED job, so this is the server's own status.
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    // Two parts, and the names are the server's: a client that invented `part-1.pdf` and one that padded it to
    // `part-01.pdf` would both pass a count, so the names are asserted rather than counted.
    await expect(page.getByText(/· 2 parts/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'part-01.pdf' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'part-02.pdf' })).toBeVisible();

    // The first part's own link, read from the bytes: 3 pages, which is what the first row asked for. A per-part link
    // that served the primary output would return twelve.
    const partDownload = page.waitForEvent('download');
    await page
      .getByRole('row', { name: /part-01\.pdf/ })
      .getByRole('link', { name: 'Download' })
      .click();
    const part = await partDownload;
    expect(countPdfPages(readFileSync((await part.path())!))).toBe(3);
    expect(part.suggestedFilename()).toBe('part-01.pdf');

    // And the archive: one entry per part, which is the promise the "Download all (.zip)" button makes.
    const archiveDownload = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download all (.zip)' }).click();
    const archive = await archiveDownload;
    const archiveBytes = readFileSync((await archive.path())!);
    expect(countZipEntries(archiveBytes)).toBe(2);
    expect(archive.suggestedFilename()).toMatch(/\.zip$/i);
  });

  test('an empty end is one page, and a range the grammar refuses never reaches the value', async ({ page }) => {
    await page.goto('/tools/split');
    await chooseFile(page, TWELVE_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    const from = rangeBox(page, 1, 'from');
    const to = rangeBox(page, 1, 'to');

    await from.fill('1');
    await to.fill('3');
    await expect(planGroups(page).first().locator('.plan-page-no')).toHaveText(['1', '2', '3']);

    // Clear the end: `1` alone is **page one**, not a range with a missing end. This is the assertion that the hyphen
    // is the control's punctuation rather than the user's — the state the old single box could not express.
    await to.fill('');
    await expect(planGroups(page)).toHaveCount(1);
    await expect(planGroups(page).first().locator('.plan-page-no')).toHaveText(['1']);
    await expect(page.getByText(/^1 of 12 pages in this file/)).toBeVisible();

    // A token the grammar does not know *is* a real mistake, and it is caught here: the row reports itself invalid,
    // the value is not forwarded, and the plan keeps drawing the last plan that was actually valid rather than a guess.
    await from.fill('abc');
    await expect(page.getByText(/"abc" is not a page or a page range\./)).toBeVisible();
    await expect(from).toHaveAttribute('aria-invalid', 'true');
    await expect(planGroups(page).first().locator('.plan-page-no')).toHaveText(['1']);

    // Fixed, extended to a second output, and run — which is the assertion that the invalid state was *recoverable*
    // rather than a box that has quietly stopped reporting its value at all.
    await from.fill('1');
    await expect(page.getByText(/"abc" is not a page or a page range\./)).toHaveCount(0);
    await expect(from).toHaveAttribute('aria-invalid', 'false');
    await page.getByRole('button', { name: 'Add a range' }).click();
    await expect(planGroups(page)).toHaveCount(2);

    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/· 2 parts/)).toBeVisible();
  });
});
