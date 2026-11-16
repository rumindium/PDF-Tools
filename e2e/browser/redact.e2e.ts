import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages, firstPageMediaBox, searchableBytes } from '../lib/pdf-inspect';

/**
 * `redact`, drawn on the page in the browser (`0-CICD.md` §3.8).
 *
 * The fourth shape on the placement canvas, and the one whose failure is invisible in the output: a redaction that
 * misses its target still produces a valid PDF, still keeps its page count and its metadata, and still reports success —
 * the document simply goes on carrying what it was redacted for. So the box cannot be aimed at "somewhere on the page";
 * it has to be aimed at text whose position is **known**, which is why the fixture writes two tokens at coordinates this
 * file could not have measured off the page: `REDACT9X7` at (72, 660) and `KEEP9X7` at (72, 560), the same two the
 * placement stage sends to the jobs API (`scripts/ci/placement.ts`). One document, two readers: the stage posts the
 * rectangle the shape module builds, this case *drags* it through the studio's own pointer handling, and both read the
 * words back out of the bytes. A third run, `PAREN(9X7)` at (72, 460), is there for claim 4 rather than for the box: it
 * is the one string here whose characters have to be *escaped*, which is the other spelling a byte-shaped reader reads
 * instead of the text.
 *
 * Four claims:
 *
 *  1. **The rectangle the user draws is the value the option carries.** The drag is aimed with the fixture's own points
 *     — the band the stage uses, x 64–324 by y 652–692 — and read back as the row's four fields, which are the option's
 *     own numbers in the option's own convention (PDF points from the page's bottom-left, y up).
 *  2. **The box on the screen is the box the engine removes, and only it.** The downloaded file has lost `REDACT9X7`,
 *     still contains `KEEP9X7` eighty points below it, and still has its one page — an absence is what this tool sells,
 *     and an absence over the wrong words is exactly what a valid-looking document hides.
 *  3. **The reader can see a string that survived as a hex string.** A producer writes a text run as a `(…)` literal
 *     while it fits the font's encoding and as `<hex>` the moment it does not, so *these two claims are only worth what
 *     the reader's eye for the second spelling is worth*: a search that read only literals would report this page's own
 *     label — which carries an em dash and comes back as `<726564616374206669787475726520e2809420…>` — as gone, and
 *     would call a document that lost the label a document that lost nothing. Claim 3 is asserted on the *output*'s
 *     label, which is the one string here known to be written back in the form claim 2's absence check must not be
 *     blind to.
 *
 *  4. **The reader resolves a literal string's own escapes.** `PAREN(9X7)` is written `(PAREN\\(9X7\\))` — by the
 *     fixture's writer *and* by the redactor, which leaves such a run as it found it — so the token's *text* is in
 *     neither file's bytes. Same claim as 3, one spelling further out: text the document unambiguously still has,
 *     which a reader that reads the file instead of the text reports as gone. (Measured in `0-E2E-CHECKLIST.md` §63,
 *     which is also where the escape gap and the hex gap are the same finding seen twice.)
 *
 * Claims 3 and 4 are new, and both replace a compromise: this case was first written with an ASCII token as its
 * presence control *because* `searchableBytes` could read neither `<hex>` nor `\\(`, and the label assertion was dropped
 * rather than left failing (§62 for the hex half, §63 for the escape half).
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** One A4 page carrying the two tokens, written by `bun run fixtures`. */
const REDACT_TOKENS = join(FIXTURES, 'redact-tokens-a4.pdf');

/** The document's own page, read from the file: the aim below is arithmetic on the fixture, not on "A4". */
const FIXTURE = readFileSync(REDACT_TOKENS);
const PAGE = firstPageMediaBox(FIXTURE);
if (!PAGE) throw new Error('The redact fixture has no readable MediaBox.');

/**
 * The band over the first token, in the fixture's own points — the same rectangle `scripts/ci/placement.ts` posts.
 *
 * A *band* rather than a line, in both readers: 24 pt text drawn at y = 660 has its glyphs between roughly 660 and 684,
 * and the control token's top is 80 pt below the band's floor (560 + 24 against 652), so a box that landed on the wrong
 * token could not satisfy both halves of the reading below.
 */
const BOX = { x: 64, y: 652, width: 260, height: 40 };

/**
 * A dev stack's anonymous session evaluated as Pro. No tool is plan-gated, so the job would run without these — they
 * stay because the case then also covers the Pro limits path — and the token is the compose default, which the API
 * refuses outright when `NODE_ENV=production` (`e2e/browser/protect.e2e.ts` makes the same point at length).
 */
test.use({ extraHTTPHeaders: { 'x-dev-plan': 'pro', 'x-dev-plan-token': 'dev-plan-token' } });

/** Choose a file the way a user does: click the dropzone, then answer the file dialog. */
async function chooseFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Drop (files|a file) here|or click to browse/ })
    .first()
    .click();
  await (await chooser).setFiles(file);
}

test('the box drawn on the page is the box the engine removes, and only that', async ({ page }) => {
  await page.goto('/tools/redact');
  await chooseFile(page, REDACT_TOKENS);
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

  // The studio opens on a **rendered** page: `pdf-to-images` is the canvas's coordinate system, and the rail — the tool
  // that turns a drag into a rectangle — is not offered before there is a page to read a coordinate against.
  await page.getByRole('button', { name: /Render page 1/ }).click();
  const surface = page.locator('.placement-surface');
  await expect(surface).toBeVisible({ timeout: 90_000 });

  // The pointer aims with the file's numbers: the surface *is* the page, so a point's place on the screen is its place
  // in the document through the page's own size. `y` is turned over here because the screen's does not — the option's
  // convention (y up, from the bottom-left corner) is what the canvas converts to, and that conversion is the half of
  // this case the row below reads.
  const image = (await surface.boundingBox())!;
  const toScreen = (x: number, y: number) => ({
    x: image.x + (x / PAGE.width) * image.width,
    y: image.y + ((PAGE.height - y) / PAGE.height) * image.height,
  });

  await page.getByRole('button', { name: 'Redaction box', exact: true }).click();
  const from = toScreen(BOX.x, BOX.y + BOX.height);
  const to = toScreen(BOX.x + BOX.width, BOX.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();

  // ── Claim 1: the drag is the value ────────────────────────────────────────
  // Read as the row's own four fields rather than as its sentence: points a fraction off the fixture's band are still
  // the box the pointer drew, and the tolerance is under a millimetre on A4, where the sentence's own rounding to whole
  // points would have made the same claim weaker.
  await expect(page.locator('.placement-row')).toHaveCount(1);
  const value = async (field: string) => Number(await page.locator(`#redaction-0-${field}`).inputValue());
  expect(Math.abs((await value('x')) - BOX.x)).toBeLessThan(2.5);
  expect(Math.abs((await value('y')) - BOX.y)).toBeLessThan(2.5);
  expect(Math.abs((await value('width')) - BOX.width)).toBeLessThan(2.5);
  expect(Math.abs((await value('height')) - BOX.height)).toBeLessThan(2.5);

  // ── Claim 2: the file agrees with the screen, and only where the box is ───
  await expect(page.getByRole('button', { name: /^Run Redact/ })).toBeEnabled();
  await page.getByRole('button', { name: /^Run / }).click();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).first().click();
  const bytes = readFileSync((await (await download).path())!);

  expect(countPdfPages(bytes), 'the redaction rewrote the page rather than the words on it').toBe(1);
  const text = searchableBytes(bytes);
  expect(text, 'the token under the drawn box is still in the output').not.toContain('REDACT9X7');
  expect(
    text,
    'the control token outside the box is gone too, so the box the canvas drew is not the box the engine removed',
  ).toContain('KEEP9X7');

  // ── Claim 3: the reader reads the spelling the redactor writes ────────────
  // The page's own label, drawn at the top of the page — well outside the band the box covers, so it survives. It is
  // the document's presence control in the strict sense: text that *must* still be there, in the one form the engine
  // writes a non-ASCII run back as. A reader that could not decode `<hex>` reported this file as having lost the label
  // it plainly still carries.
  expect(
    text,
    'the page label survived the redaction but the reader cannot see it, so the absence asserted above is unreadable evidence',
  ).toContain('redact fixture — page 1 of 1');

  // ── Claim 4: the reader resolves a literal's escapes too ─────────────────
  // The third run, far below the box, whose brackets the writer escaped. Neither the fixture's bytes nor the output's
  // contain the token's *text*, so this is claim 3 with the other reason a byte-shaped reader misses a string that is
  // still there — and it is the claim that makes `\\(`, `\\)` and an octal escape readable at all.
  expect(
    text,
    'a text run whose bracket the writer escaped is invisible to the reader, so it cannot tell a removed string from one it cannot decode',
  ).toContain('PAREN(9X7)');
});
