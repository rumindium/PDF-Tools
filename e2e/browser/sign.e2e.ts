import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { firstPageMediaBox, searchableBytes } from '../lib/pdf-inspect';
import { inkShare, parseRegion, renderPageGray } from '../lib/render';

/**
 * `sign`, driven from the studio (`0-CICD.md` §3.8).
 *
 * The third shape on the placement canvas, and the one whose failure is invisible twice over: a signature that lands in
 * the wrong place still produces a signed document, and a signature **drawn on the pad** that never reaches the job
 * produces one too — with an empty page where the ink should be, and a completed job saying so. Neither is a structural
 * fact. `scripts/ci/placement.ts` reads the millimetre/pt twin by rendering the page, and that is the only kind of
 * reading that can decide it, which is why these cases render too: the before/after pair around the drawn box, with the
 * **mirror** of it asserted empty — the vertical flip is the one error that puts a valid signature on the wrong half.
 *
 * Two paths, because `sign` has two ways to make an image and only one of them is typed:
 *
 *   1. **What the user types is what signs, and it inks the drawn box.** The name goes in the panel, the box is dragged
 *      on the canvas, and the output is read twice: the render says where the ink is, and the document's own `/Subject`
 *      says who signed it — an engine that placed the box correctly and recorded the wrong name would pass either
 *      reading alone.
 *   2. **The pad's strokes are the image the option names.** `kind: 'drawn'` is the path that had no control at all
 *      until the pad existed (`0-UI-DESIGN.md` §6.2): the canvas exports what was drawn, the export is uploaded through
 *      `POST /files`, and the option carries the returned id — the job then pulls that file in as an attachment. Three
 *      links, and the case holds all three: the button refuses a tap, the upload answers with an `image/png`, and the
 *      job body names that id as `imageFileId`. The render then says the picture landed in the box the canvas drew.
 *
 * The date line is turned off in both cases, exactly as the placement stage turns it off: `showDateStamp` defaults on,
 * and the date is **text of its own inside the box**, which would make every dark pixel counted below ambiguous between
 * the signature and its caption.
 *
 * The fixture is plain text and no form — a document with an *empty signature field* is refused by the honesty rule
 * (`sign-placeholder-not-a-signature`), which is a different case's subject.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six A4 pages; `sign` writes a visible signature into the page, so any page would do — page 1 is what the canvas opens. */
const SIX_PAGES = join(FIXTURES, 'pages-six-a4.pdf');

/** The document's own page, read from the file: the box below is arithmetic on the fixture, not on "A4". */
const FIXTURE = readFileSync(SIX_PAGES);
const PAGE = firstPageMediaBox(FIXTURE);
if (!PAGE) throw new Error('The sign fixture has no readable MediaBox.');
/**
 * The same numbers for the helpers below, which are function declarations: TypeScript keeps a `const`'s narrowing only
 * for closures written after the check, and a module-level `function` is hoisted past it. (`annotate.e2e.ts` needs no
 * alias because its conversion lives inside the test.)
 */
const PAGE_SIZE: { width: number; height: number } = PAGE;

/**
 * A band in the middle of the page, below the fixture's label and its two rules: the signature is the only thing drawn
 * there, so a render difference inside it is this job's ink and nothing else's.
 */
const BOX = { x: 64, y: 552, width: 260, height: 60 };
/** What `placement.ts` counts as a mark in a grayscale render — not tuned per shape, and not lowered here. */
const MIN_DARK_PIXELS = 40;

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

/**
 * Render a page and open the canvas on it.
 *
 * Two facts about this studio are in these two lines: the toolbox and the options panel **only open once a page has
 * been rendered** (the drawing is the coordinate system every number is written against), and the render is a real
 * `pdf-to-images` job of its own, so it can queue behind other work.
 */
async function openCanvas(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Render page 1/ }).click();
  await expect(page.locator('.placement-surface')).toBeVisible({ timeout: 90_000 });
}

/** Drag the band on the rendered page, aiming with the file's own numbers. */
async function dragBox(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  const image = (await page.locator('.placement-surface').boundingBox())!;
  // The surface *is* the page, so a point's place on the screen is its place in the document through the page's own
  // size. `y` is turned over here because the screen's does not — the option's convention (y up, from the bottom-left).
  const toScreen = (x: number, y: number) => ({
    x: image.x + (x / PAGE_SIZE.width) * image.width,
    y: image.y + ((PAGE_SIZE.height - y) / PAGE_SIZE.height) * image.height,
  });
  const from = toScreen(box.x, box.y + box.height);
  const to = toScreen(box.x + box.width, box.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** Run the job and read the downloaded bytes, the way the other browser cases do. */
async function runAndDownload(page: Page): Promise<Buffer> {
  await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
  await page.getByRole('button', { name: /^Run / }).click();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).first().click();
  return readFileSync((await (await download).path())!);
}

/** How many dark pixels this job added inside the box, and at its vertical mirror. */
async function inkOf(before: Buffer, after: Buffer, box: typeof BOX): Promise<{ inside: number; mirror: number }> {
  const rendered = { before: await renderPageGray(before, 1), after: await renderPageGray(after, 1) };
  expect(
    rendered.before && rendered.after,
    'no renderer is reachable, so the placement cannot be measured — the claim would be skipped rather than read',
  ).not.toBeNull();
  const region = (y: number) => parseRegion(`1,${box.x},${y},${box.width},${box.height}`)!;
  const delta = (y: number) => inkShare(rendered.after!, region(y)).dark - inkShare(rendered.before!, region(y)).dark;
  return { inside: delta(box.y), mirror: delta(PAGE_SIZE.height - box.y - box.height) };
}

test('the name typed in the panel is what signs, and it inks the box the canvas drew', async ({ page }) => {
  await page.goto('/tools/sign');
  await chooseFile(page, SIX_PAGES);
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
  await openCanvas(page);

  await page.locator('#option-signature').fill('Ada Lovelace');
  await page.getByLabel('Print the date').uncheck();
  await page.getByRole('button', { name: 'Signature', exact: true }).click();
  await dragBox(page, BOX);

  // The drag is the value, read as the row's own four fields before the job is asked to agree with them.
  const value = async (field: string) => Number(await page.locator(`#signature-0-${field}`).inputValue());
  await expect(page.locator('.placement-row')).toHaveCount(1);
  expect(Math.abs((await value('x')) - BOX.x)).toBeLessThan(2.5);
  expect(Math.abs((await value('y')) - BOX.y)).toBeLessThan(2.5);
  expect(Math.abs((await value('width')) - BOX.width)).toBeLessThan(2.5);
  expect(Math.abs((await value('height')) - BOX.height)).toBeLessThan(2.5);

  const bytes = await runAndDownload(page);

  // ── The render: the ink is inside the drawn box and not at its mirror ──────
  const ink = await inkOf(FIXTURE, bytes, BOX);
  expect(
    ink.inside,
    `the signature is not in the box the canvas wrote for it: ${ink.inside} new dark pixel(s) in ${JSON.stringify(BOX)}`,
  ).toBeGreaterThanOrEqual(MIN_DARK_PIXELS);
  expect(
    ink.mirror,
    `the vertical flip is inverted: ${ink.mirror} new dark pixel(s) at the mirror of the box, ${JSON.stringify({ y: PAGE_SIZE.height - BOX.y - BOX.height })}`,
  ).toBeLessThan(2);

  // ── The document's own record: the typed name is what it says signed it ────
  const text = searchableBytes(bytes);
  expect(text, 'the typed name did not reach the document, so what signed it is not what the user typed').toContain(
    'Signed by Ada Lovelace',
  );
  expect(text, 'the signed document lost the words it went in with').toContain('Page operations fixture — page 1 of 6');
});

test('the strokes drawn on the pad are the image the job places', async ({ page }) => {
  await page.goto('/tools/sign');
  await chooseFile(page, SIX_PAGES);
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
  await openCanvas(page);

  await page.selectOption('#option-kind', 'drawn');
  await page.getByLabel('Print the date').uncheck();
  const pad = page.locator('canvas[aria-label="Signature drawing area"]');
  await expect(pad).toBeVisible();
  const use = page.getByRole('button', { name: /Use this signature/ });

  // ── A tap is not a signature ───────────────────────────────────────────────
  // The control's own rule (`hasSignatureInk` refuses 4 px of ink), asserted here because it is the button that obeys it.
  expect(await use.isDisabled(), 'the pad offers to upload a blank canvas as a signature').toBe(true);

  const area = (await pad.boundingBox())!;
  await page.mouse.move(area.x + 40, area.y + 120);
  await page.mouse.down();
  await page.mouse.move(area.x + 260, area.y + 60, { steps: 20 });
  await page.mouse.move(area.x + 460, area.y + 130, { steps: 20 });
  await page.mouse.up();
  await expect(use).toBeEnabled();

  // ── The export becomes an uploaded file, and the option names it ───────────
  const upload = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/v1/files'),
  );
  await use.click();
  const uploaded = (await (await upload).json()) as { id: string; name: string; detectedType: string };
  expect(uploaded.detectedType, 'the pad exported something other than a PNG, which the option does not accept').toBe(
    'image/png',
  );
  expect(uploaded.name).toBe('signature-drawn.png');

  await page.getByRole('button', { name: 'Signature', exact: true }).click();
  await dragBox(page, BOX);

  const posted = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/v1/jobs'),
  );
  await page.getByRole('button', { name: /^Run / }).click();
  const body = (await posted).postDataJSON() as { options: { kind?: string; imageFileId?: string } };
  expect(body.options.kind, 'the job did not ask for the drawn kind, so the image is not what it is placing').toBe(
    'drawn',
  );
  expect(
    body.options.imageFileId,
    'the option names an image other than the one the pad just uploaded, so the ink on the pad is not what the job gets',
  ).toBe(uploaded.id);
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).first().click();
  const bytes = readFileSync((await (await download).path())!);

  const ink = await inkOf(FIXTURE, bytes, BOX);
  expect(
    ink.inside,
    `the drawing is not in the box the canvas wrote for it: ${ink.inside} new dark pixel(s) in ${JSON.stringify(BOX)}`,
  ).toBeGreaterThanOrEqual(MIN_DARK_PIXELS);
  expect(
    ink.mirror,
    `the vertical flip is inverted: ${ink.mirror} new dark pixel(s) at the mirror of the box`,
  ).toBeLessThan(2);
});
