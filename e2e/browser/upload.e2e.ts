import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { countPdfPages, searchableBytes } from '../lib/pdf-inspect';

/**
 * The upload flow, driven through the app the user loads (`0-CICD.md` §3.8).
 *
 * This is the first case in the repository that touches the interface at all, and the gap it closes had been in
 * `0-IMPLEMENTATION-STATUS.md` §6 for passes: *no test drives the UI*. What that left unproven was not the API — the
 * golden suite posts jobs and reads bytes on four pools — but the chain a user actually walks: choose files in a
 * browser, watch them staged, press run, watch progress arrive, download what the job produced. Every link in that
 * chain is a place a regression can land while every existing stage stays green, because a stage that posts to
 * `POST /jobs` itself skips all of them.
 *
 * Two cases, and they are the two halves of what the uploader's own header claims:
 *
 *   1. **A file chosen in the browser becomes a merged document.** Two fixtures with known page counts and known
 *      labels go in through the dropzone; the bytes that come back out are read by *this* harness's PDF reader
 *      (`countPdfPages`, `searchableBytes`) rather than by the app's own reporting — because a UI that says "5 pages"
 *      while serving a truncated file would pass every assertion made from the page it is drawn on. *  2. **The name is believed at upload and opened at the job.** A text file *renamed* to `.pdf` is chosen against a
 *      picker that advertises PDFs (Playwright bypasses the file dialog's filter, which is exactly what a user with a
 *      renamed file does), the upload is accepted — the client's own type check reads the name and the declared
 *      `application/pdf` — and the refusal arrives when the job is created, naming the type the API **detected** from
 *      the bytes (`text/plain`) and the types it accepts. The card said `Ready` for both files: a client that treated
 *      its own accept list as the rule would have shown a green form and a broken job.
 *
 * What these cases deliberately do not do: assert styling, click through every option, or check the SSE stream's
 * transport. Those are worth having; none of them is what "the upload flow works in a browser" means, and a first
 * browser case that asserts everything asserts nothing that can be read when it fails.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** 2 pages, label `Merge fixture A`. */
const TWO_PAGES = join(FIXTURES, 'merge-two-a4.pdf');
/** 3 pages, label `Merge fixture B`. */
const THREE_PAGES = join(FIXTURES, 'merge-three-a4.pdf');
/** Not a PDF: the file the merge tool must refuse, and the reason the second case exists. */
const NOT_A_PDF = join(FIXTURES, 'office-to-pdf-report.txt');

/**
 * The same text, named as a PDF — the file a user produces by renaming one.
 *
 * Made rather than committed, because it is not a fixture: it is the *same* bytes with a lying name, which is the only
 * shape in which the tool's refusal can be reached from the form at all. The uploader refuses a file whose name and
 * type are not in the tool's accept list (`features/uploader/drop.ts`, `typeRejection`), so a `.txt` never leaves the
 * browser — and that refusal is right for the ordinary case while leaving the interesting one untestable, because the
 * API's answer is about the **bytes**, not the name.
 */
function renamedAsPdf(): string {
  const target = join(mkdtempSync(join(tmpdir(), 'pdftools-upload-')), 'report.pdf');
  copyFileSync(NOT_A_PDF, target);
  return target;
}

/**
 * Choose files the way a user does: click the dropzone, then answer the file dialog.
 *
 * Not `setInputFiles` on the hidden input, which would work and would skip the one step worth testing — that the
 * dropzone's button really opens a chooser wired to that input. The input is `display: none`, so a test that sets it
 * directly passes even if the button has stopped opening it.
 */
async function chooseFiles(page: import('@playwright/test').Page, files: string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(files);
}

test.describe('the upload flow, as a browser walks it', () => {
  test('two PDFs chosen in the UI come back as one merged document', async ({ page }) => {
    await page.goto('/tools/merge');

    // The page is the catalog's: title, accept list and file ceiling all come from the registry, so a blank form here
    // means the catalog did not arrive, not that the test is early.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/merge/i);

    await chooseFiles(page, [TWO_PAGES, THREE_PAGES]);

    // `Ready` is the badge the file row gets only after the API accepted the bytes and handed back an id — a row that
    // is still uploading, or rejected, says `%` or shows an error instead.
    //
    // **One** `Ready`, on the card rather than on each tile. The badge states the state of the *request* — the API
    // accepted the bytes it was handed — and a copy per file said the same thing once per tile, competing with the
    // page it sat on. The tile's own plate still carries `Uploading %`, `Failed` and the encrypted marker, which are
    // per-file facts; "every input is ready" is not (`routes/tools.$toolId.tsx`).
    //
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await expect(page.getByText(/^Files \(2/)).toBeVisible();

    const run = page.getByRole('button', { name: /^Run / });
    await expect(run).toBeEnabled();
    await run.click();

    // The result panel appears only when the job row is terminal *and* COMPLETED, so this is the job's own status and
    // not the harness's clock.
    // `first()` because the word appears twice once the job is done — once as the progress panel's status and once as
    // the result card's badge. Two badges is the correct page; an ambiguous locator here is the test's problem.
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    // The server's count, rendered — and said **once**. This used to be `getByText(/5 pages/)`, which the page now
    // matches six times (the input summary, the run row, the job metrics, the result, and the comparison), so the
    // assertion could not say which fact it had checked. The comparison under the result names both sides and only
    // they exist: five pages went in and five came out, and the download below is read again from its own bytes.
    await expect(page.getByText('5 pages in, 5 out.')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download', exact: true }).click();
    const saved = await download;
    const path = await saved.path();
    expect(path).toBeTruthy();

    const bytes = readFileSync(path!);
    // Independent of the page that reported "5 pages": pages counted from the document itself, and both input labels
    // found in the file's bytes *or* its inflated streams. The page count alone would pass for a merge that dropped
    // one input and duplicated the other.
    expect(countPdfPages(bytes)).toBe(5);
    const searchable = searchableBytes(bytes);
    expect(searchable).toContain('Merge fixture A');
    expect(searchable).toContain('Merge fixture B');
    // The output name is the server's, and it is what the download carries.
    expect(saved.suggestedFilename()).toMatch(/\.pdf$/i);
  });

  test('a file the tool cannot read is refused by the server, not by the picker', async ({ page }) => {
    await page.goto('/tools/merge');

    //
    // A PDF and a text file **named** as one. The picker's `accept` list and the uploader's own type check both read
    // the name and the declared type, so this pair is what a user has when they have renamed the wrong file — and the
    // server is the only layer that opens the bytes. (Choosing the `.txt` by its own name cannot reach the claim at
    // all: the form refuses it before a request is made, which is the correct behaviour and a different fact.)
    //
    await chooseFiles(page, [TWO_PAGES, renamedAsPdf()]);

    // Both upload, and the badge's count is the assertion: it is one per request now, and it appears only once both
    // files have been accepted — the renamed one included. The upload is where the *name* is believed.
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    await page.getByRole('button', { name: /^Run / }).click();

    // The refusal names the type the API **detected** — `text/plain`, not the `application/pdf` the file was called —
    // and the types it accepts, in the alert the runner shows for a rejected submission.
    const failure = page.getByText('UNSUPPORTED FILE TYPE');
    await expect(failure).toBeVisible();
    await expect(page.getByText(/does not accept text\/plain/)).toBeVisible();

    // And nothing was produced, which is the difference between a refusal and a warning: a failed submission has no
    // download link at all.
    await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
  });
});
