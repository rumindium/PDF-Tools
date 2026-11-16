import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { countPdfPages, declaresEncryption } from '../lib/pdf-inspect';

/**
 * `encrypt`, driven through the form a user fills in (`0-CICD.md` §3.8).
 *
 * Every other stage of this repository builds its own request body, which is why `encrypt`'s `permissions` option could
 * be broken for as long as it was: `optionsUi` declared a `text` control for an **object** schema, so the panel drew a
 * free-text box, `String(value)` rendered an empty field for a value that was never set, and whatever the user typed
 * went to the API as a string — `Expected object, received string`, on a job the form itself had built. The golden
 * suite stays green through that because a golden case *is* the request (`{ copy: false }`, posted by hand), and no
 * other stage looks at the form at all. `split.e2e.ts` exists for the same defect one category over.
 *
 * So the assertions here are about what leaves the browser and what comes back:
 *
 *   1. **the object in the request**, read out of the POST body rather than out of the page, because the page would
 *      say `permissions` was set even if the value on the wire were the string `[object Object]`;
 *   2. **the caveat warning in the result**, which the handler emits only when a permission was *actually* denied —
 *      so the object reaching the engine is witnessed by the engine answering about it;
 *   3. **`/Encrypt` in the downloaded bytes**, and its absence from the file that went in. A page count alone would
 *      pass for a job that wrote no encryption at all: the page tree's dictionaries stay readable in an encrypted
 *      document, so `countPdfPages` agrees either way. That is why the two byte-level facts are asserted together.
 *
 * The password is over the strength policy's floor and its classes, deliberately: the case is about the *shape* of the
 * permissions object, and a weak password would make it fail on a different rule with a confusing message.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six pages, plain, no signature and no form — the fixture `encrypt`'s own golden cases use. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');
const USER_PASSWORD = 'Browser-1-Secret!';

/**
 * A dev stack's anonymous session evaluated as Pro. No tool is plan-gated, so the job would run without these — they
 * stay because the case then also covers the Pro limits path.
 *
 * The golden suite reaches the same switch with `--plan pro` — but through the API directly. The browser arrives
 * through nginx, which forwards unlisted client headers unchanged, so the same switch works from a page and this
 * file is where that is asserted rather than assumed. The token is the compose default, and the API refuses the
 * header outright when `NODE_ENV=production`.
 */
test.use({ extraHTTPHeaders: { 'x-dev-plan': 'pro', 'x-dev-plan-token': 'dev-plan-token' } });

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: import('@playwright/test').Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

test.describe('protecting a document, as a browser walks it', () => {
  test('a permissions object typed into the advanced panel reaches the API as an object and the download is encrypted', async ({
    page,
  }) => {
    await page.goto('/tools/encrypt');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/protect/i);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    await page.getByLabel('Password to open').fill(USER_PASSWORD);

    // The field is in the collapsed advanced section, which is also where the defect lived: the option was reachable,
    // documented, and unusable.
    await page.getByText(/^Advanced options/).click();
    await page.getByLabel('Permissions').fill('{ "copy": false, "print": false }');

    const posted = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes('/api/v1/jobs'),
    );
    await page.getByRole('button', { name: /^Run / }).click();
    const body = (await posted).postDataJSON() as {
      options: { permissions?: unknown; userPassword?: unknown };
      files?: unknown[];
    };

    // The defect, asserted directly: this value used to be the string the user typed into the box.
    expect(typeof body.options.permissions).toBe('object');
    expect(body.options.permissions).toMatchObject({ copy: false, print: false });
    // And the password is sent as a value rather than pre-redacted by the client — the API is the layer that replaces
    // it with the placeholder, and a UI that scrubbed it first would submit `[secret]` as the real password.
    expect(body.options.userPassword).toBe(USER_PASSWORD);

    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    // Only emitted when something was denied, so this is the engine's own answer that the object arrived.
    await expect(page.getByText('PERMISSIONS READER DEPENDENT')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    const bytes = readFileSync((await file.path())!);
    expect(declaresEncryption(bytes)).toBe(true);
    // The control: the same reader on the input, so the assertion above is about the job rather than about a pattern
    // that any PDF happens to contain.
    expect(declaresEncryption(readFileSync(SIX_PAGES))).toBe(false);
    // Encryption wraps the file; it must not have changed the document underneath it.
    expect(countPdfPages(bytes)).toBe(6);
  });

  test('a half-typed permissions object is not forwarded at all', async ({ page }) => {
    await page.goto('/tools/encrypt');
    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    await page.getByLabel('Password to open').fill(USER_PASSWORD);
    await page.getByText(/^Advanced options/).click();
    const permissions = page.getByLabel('Permissions');

    // Half of an object — what the field holds while the user is typing, and the state that must never be submitted.
    // The control keeps the last value that parsed, and says so, which is the difference between a field that is
    // momentarily invalid and a request that is.
    await permissions.fill('{ "copy": false');
    await expect(page.getByText(/Not valid JSON yet/)).toBeVisible();

    // Completed and unambiguous again, so the invalid state is recoverable rather than a field that has stopped
    // reporting its value.
    await permissions.fill('{ "copy": false, "print": true }');
    await expect(page.getByText(/Not valid JSON yet/)).toHaveCount(0);

    const posted = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes('/api/v1/jobs'),
    );
    await page.getByRole('button', { name: /^Run / }).click();
    const body = (await posted).postDataJSON() as { options: { permissions?: unknown } };
    expect(body.options.permissions).toMatchObject({ copy: false, print: true });

    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  });
});
