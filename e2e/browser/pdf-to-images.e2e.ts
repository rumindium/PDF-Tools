import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readImageHeader } from '../lib/image-inspect';

/**
 * `pdf-to-images` through the app the user loads — the second tool driven end to end in a browser.
 *
 * The golden suite asserts this tool's options at the API, and that is where the *arithmetic* belongs. What a golden
 * case cannot see is the form: it posts the request itself, so a control that emits the wrong shape, a select that
 * offers a value the schema refuses, or a toggle that does nothing at all is invisible to every one of them. `split`
 * had exactly that class of defect — its default mode was unreachable from the browser because the control sent a flat
 * array to a nested schema — and it was found by a browser case, not by any of the 88 suites.
 *
 * Two cases, and both of them end in the delivered bytes rather than in the page's own report:
 *
 *  1. a page selection through the `Pages` field at 300 dpi in grayscale, where the assertion is the image's own
 *     header — dimensions and channel count — because a form that quietly stopped forwarding an option produces a
 *     perfectly good image of the wrong thing;
 *  2. a one-page export, which is the shape the `zipSingle` option used to describe and never did (defect 128): the
 *     panel must offer the image itself and no archive link, and the form must no longer carry the toggle whose hint
 *     said the opposite.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six A4 pages, so `2-3` is two of them and `3` alone is one — the two selections the cases need. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: import('@playwright/test').Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

test.describe('a page export, as a browser walks it', () => {
  test('a page selection and a colour mode, from the form to the delivered image', async ({ page }) => {
    await page.goto('/tools/pdf-to-images');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/images/i);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    // The selection is typed into the tool's own `Pages` control — the same shared grammar `split`'s ranges field
    // validates, through the other control type, so this covers the path a range submission takes from a text field.
    // Format first, and explicitly: the form opens on JPG (the catalog's default), so a case that left it alone would
    // be asserting `page-001.jpg` while reading like a PNG case. Every select here is addressed the way the user
    // reaches it.
    await page.getByLabel('Format').selectOption('png');
    // `getByLabel('Pages')` is ambiguous on this page — the upload row's remove button carries
    // `aria-label="Remove <file>"` — so the field is addressed by role and name, which is also the question the
    // assertion should be asking: *the textbox* the label "Pages" belongs to.
    await page.getByRole('textbox', { name: 'Pages' }).fill('2-3');
    await page.getByLabel('Resolution').selectOption('300');
    await page.getByLabel('Colour').selectOption('grayscale');

    await page.getByRole('button', { name: /^Run / }).click();
    // The result panel renders only for a terminal, COMPLETED job, so this is the server's own status.
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    // Two parts, named by the server: a client that invented `page-1.png` and one that padded it to `page-001.png`
    // would both pass a count, so the names are asserted rather than counted.
    await expect(page.getByText(/· 2 parts/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'page-001.png' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'page-002.png' })).toBeVisible();

    // And the delivered file itself, read from its own header: 300 dpi on A4 is 2480×3509 px, and `grayscale` is one
    // channel. Neither of those is visible anywhere in the page — the panel reports names and byte counts, which is
    // exactly how an option that stopped being applied stayed invisible.
    const partDownload = page.waitForEvent('download');
    await page
      .getByRole('row', { name: /page-001\.png/ })
      .getByRole('link', { name: 'Download' })
      .click();
    const part = await partDownload;
    const header = readImageHeader(readFileSync((await part.path())!));
    expect(header?.width).toBe(2480);
    expect(header?.height).toBe(3509);
    expect(header?.channels).toBe(1);
    expect(part.suggestedFilename()).toBe('page-001.png');

    // The archive the "Download all (.zip)" button promises: one entry per part.
    await page.getByRole('link', { name: 'Download all (.zip)' }).click();
  });

  test('a one-page export offers the image itself and no archive, and the form has no zip toggle', async ({ page }) => {
    await page.goto('/tools/pdf-to-images');

    // The removal, asserted. The form is generated from the registry, so a key that came back would come back
    // silently — and the hint it carried said "A one-page PDF comes back as a ZIP unless this is on" while the
    // product did the opposite in both positions (defect 128, pass 3).
    await expect(page.getByText('Send a lone page as the image itself')).toHaveCount(0);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Pages' }).fill('3');

    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    // One output, so there is no archive to download and the panel must not offer one: a "Download all (.zip)" link
    // here would have to serve the image or a ZIP holding a single file, and one of those is a lie.
    await expect(page.getByRole('link', { name: 'Download all (.zip)' })).toHaveCount(0);

    const primaryDownload = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const primary = await primaryDownload;
    const header = readImageHeader(readFileSync((await primary.path())!));
    // Nothing here was chosen: the case walks the form exactly as it opens, so the container is the catalog's own
    // default (JPG) and the resolution is the declared default (150 dpi — this assertion is what refuted "72", the
    // first entry in the list, when it was written). Asserting the *defaults* is the half of the contract no
    // explicit-option case can reach: a form that opened on something else would still pass every case above.
    expect(header?.format).toBe('jpeg');
    expect(header?.width).toBe(1240);
    expect(header?.height).toBe(1755);
    expect(primary.suggestedFilename()).toBe('page-001.jpg');
  });
});
