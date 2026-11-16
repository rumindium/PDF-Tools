import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { firstPageMediaBox, readAnnotationGeometry, searchableBytes } from '../lib/pdf-inspect';

/**
 * `annotate`, drawn on the page in the browser (`0-CICD.md` §3.8).
 *
 * The canvas's second shape, and the one whose product is a **dictionary** rather than paint: a highlight is a mark a
 * reader can select, move and delete, so it lives in `/Annots` as a `/Highlight` with a `/Rect` and a set of
 * `/QuadPoints` — which means no ink check can read it (a highlight renders at 219/255 in grayscale, above every
 * threshold the harness's ink checks use, as `scripts/ci/placement.ts` §5 records) and no byte search can either, once
 * the numbers are compared rather than the words. The claim is therefore *where the four numbers are*, read from the
 * dictionaries with the same pikepdf reader the placement stage uses.
 *
 * The drag is aimed at the fixture's own label — `pages-six-a4.pdf` writes `Page operations fixture — page 2 of 6` at
 * `72 (height - 96) Td` in `20 pt` on **page 2**, and this case picks page 2 in the studio's own page selector before
 * rendering it. Two things follow from aiming at that run rather than at empty paper: the mark's page is a fact the
 * case can check (a mark whose page number was dropped would land on page 1, where the same run is a different
 * sentence), and the words under the mark are known text whose survival is the second half of the claim.
 *
 * Four claims:
 *
 *  1. **The rectangle the user drags is the value the option carries.** Read back as the row's four fields — the
 *     option's own numbers in the option's own convention (PDF points from the page's bottom-left, y up).
 *  2. **The file carries the mark where the screen drew it.** `/Rect` is the drawn box on the page the canvas showed,
 *     it is a `Highlight` with at least one quad and `/F 4` set, and it is **not** the mark's vertical mirror — an
 *     unflipped conversion still produces a valid annotation, on the wrong half of the page.
 *  3. **The words the mark covers are still there.** `annotate` is the tool for marks a reader can move; the run under
 *     the box is asserted *after* the job, which is the difference between this tool and `redact` (`redact.e2e.ts`
 *     asserts the same pair the other way round: gone under the box, present outside it).
 *  4. **One page of six was marked, and the other five are untouched.** The mark's own page is read out of `/Annots`,
 *     so a canvas that quietly marked page 1 would fail on the page number rather than on a rectangle that happens to
 *     sit at the same coordinates.
 *
 * Claim 2 is also where the reader's reach is measured: `readAnnotationGeometry` runs pikepdf inside the
 * `worker-light` container, and it must be reachable **from the Playwright runner** — the stage's workers run under
 * Node even when the command was `bun run test:browser`, which is the same measured fact `pdfPageTexts` documents.
 * Where it is not, the case fails saying so instead of skipping the claim.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six A4 pages, each carrying its own label at the top — the fixture the canvas's other cases drive. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');

/** The document's own page, read from the file: the box below is arithmetic on the fixture, not on "A4". */
const FIXTURE = readFileSync(SIX_PAGES);
const PAGE = firstPageMediaBox(FIXTURE);
if (!PAGE) throw new Error('The annotate fixture has no readable MediaBox.');

/** The page the studio is asked for, on purpose not the first one: the mark's page number is one of the claims below. */
const MARKED_PAGE = 2;
/** The fixture's label run, spelled the way the writer draws it: `/F1 20 Tf` at `72 (height - 96) Td`. */
const LABEL_BASELINE = PAGE.height - 96;
/**
 * A band over that run: the glyphs of 20 pt Helvetica start at the baseline and rise about 14 pt, the descenders fall
 * about 4 pt below it, and the box is padded past both. It reaches x = 424, where the label ends near 408.
 */
const BOX = { x: 64, y: LABEL_BASELINE - 8, width: 360, height: 28 };
/** The words the box is drawn over — the fixture's own sentence for `MARKED_PAGE`. */
const COVERED = `Page operations fixture — page ${MARKED_PAGE} of 6`;

/**
 * A dev stack's anonymous session evaluated as Pro. No tool is plan-gated, so the job would run without these — they
 * stay because the case then also covers the Pro limits path — and the token is the compose default, which the API
 * refuses outright when `NODE_ENV=production` (`redact.e2e.ts` makes the same point).
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

test('the mark drawn on the page is the mark the file carries, and the words under it survive', async ({ page }) => {
  await page.goto('/tools/annotate');
  await chooseFile(page, SIX_PAGES);
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

  // Page 2, chosen in the studio before anything is rendered: the canvas renders one page per preview job, and the one
  // it shows is the one every number below is written against.
  await page.getByLabel('Page').selectOption(String(MARKED_PAGE));
  await page.getByRole('button', { name: new RegExp(`Render page ${MARKED_PAGE}`) }).click();
  const surface = page.locator('.placement-surface');
  await expect(surface).toBeVisible({ timeout: 90_000 });

  // The pointer aims with the file's numbers: the surface *is* the page, so a point's place on the screen is its place
  // in the document through the page's own size. `y` is turned over here because the screen's does not — the option's
  // convention (y up, from the bottom-left corner) is what the canvas converts to.
  const image = (await surface.boundingBox())!;
  const toScreen = (x: number, y: number) => ({
    x: image.x + (x / PAGE.width) * image.width,
    y: image.y + ((PAGE.height - y) / PAGE.height) * image.height,
  });

  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  const from = toScreen(BOX.x, BOX.y + BOX.height);
  const to = toScreen(BOX.x + BOX.width, BOX.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();

  // ── Claim 1: the drag is the value ────────────────────────────────────────
  await expect(page.locator('.placement-row')).toHaveCount(1);
  const value = async (field: string) => Number(await page.locator(`#annotation-0-${field}`).inputValue());
  expect(Math.abs((await value('x')) - BOX.x)).toBeLessThan(2.5);
  expect(Math.abs((await value('y')) - BOX.y)).toBeLessThan(2.5);
  expect(Math.abs((await value('width')) - BOX.width)).toBeLessThan(2.5);
  expect(Math.abs((await value('height')) - BOX.height)).toBeLessThan(2.5);

  // ── Claim 2: the file agrees with the screen ──────────────────────────────
  await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
  await page.getByRole('button', { name: /^Run / }).click();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).first().click();
  const bytes = readFileSync((await (await download).path())!);

  const marks = await readAnnotationGeometry(bytes, { repoRoot: process.cwd() });
  expect(
    marks,
    'no pikepdf container is reachable, so the mark cannot be read back — the claim would be skipped rather than measured',
  ).not.toBeNull();
  // Every mark in the document, before any filtering: a job that marked page 1 *as well* would satisfy a reading that
  // only looked at page 2, which is the claim this line exists for (the canvas was asked for page 2 and nothing else).
  expect(
    marks!.map((mark) => mark.page),
    'the document carries marks on pages the canvas was not showing',
  ).toEqual([MARKED_PAGE]);
  const onPage = marks!.filter((mark) => mark.page === MARKED_PAGE);
  expect(
    onPage.map((mark) => mark.subtype.toLowerCase()),
    'the mark is not on the page the canvas was showing, or it is not a Highlight',
  ).toEqual(['highlight']);

  const [llx, lly, urx, ury] = onPage[0]!.rect;
  const expected = {
    x0: BOX.x,
    y0: BOX.y,
    x1: BOX.x + BOX.width,
    y1: BOX.y + BOX.height,
  };
  const worst = Math.max(
    Math.abs(llx - expected.x0),
    Math.abs(lly - expected.y0),
    Math.abs(urx - expected.x1),
    Math.abs(ury - expected.y1),
  );
  expect(
    worst,
    `the mark is not where the drag put it: the file's /Rect is [${llx}, ${lly}, ${urx}, ${ury}] where the canvas asked for [${expected.x0}, ${expected.y0}, ${expected.x1}, ${expected.y1}]`,
  ).toBeLessThan(2);
  // The mirror: an unflipped conversion would put the rect's y0 here, still a valid annotation on the wrong half.
  const mirrored = PAGE.height - BOX.y - BOX.height;
  expect(
    Math.abs(lly - mirrored),
    `the vertical flip is inverted: the rect's y0 (${lly}) is the mirror of the requested y (${mirrored})`,
  ).toBeGreaterThan(1);
  expect(onPage[0]!.quadPoints, 'the mark carries no /QuadPoints, so a reader cannot align it to text').toBeGreaterThan(
    0,
  );
  expect(onPage[0]!.hasPrintFlag, 'the mark does not carry /F 4, so it would not print').toBe(true);

  // ── Claims 3 and 4: what the job left alone ───────────────────────────────
  // The run the box was drawn over, read out of the output with the harness's own reader — literals and the `<hex>`
  // spelling alike — and the label of the page the mark is *not* on, which is what makes the first reading specific to
  // page 2 rather than satisfied by any page of the document.
  const text = searchableBytes(bytes);
  expect(text, 'the words under the mark are gone, so this job removed text instead of annotating it').toContain(
    COVERED,
  );
  expect(text, 'the document lost the label of the page the mark is not on').toContain(
    'Page operations fixture — page 1 of 6',
  );
});
