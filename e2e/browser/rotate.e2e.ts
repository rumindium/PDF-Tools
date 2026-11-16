import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countPdfPages, readPageGeometry } from '../lib/pdf-inspect';

/**
 * `rotate`, turned in the browser and read back out of the file's page dictionaries (`0-CICD.md` §3.8).
 *
 * This tool's product is a **page attribute** — `/Rotate` — which changes no page count, no text and no page size, so
 * every check that is not about the page dictionary is blind to it. That is why `expectPageRotate` exists in the golden
 * harness (`scripts/ci/golden.ts`), and why this file reads the output with `readPageGeometry` rather than counting
 * pages: a `rotate` job that writes nothing passes an upload, a completion, a download and a page count.
 *
 * The browser half is about the *form*, which is where this tool's two defects of that kind have lived: `perPage` — the
 * map of page → angle — was a **JSON box**, and every page was drawn a quarter turn the moment a file arrived, because
 * the option's schema default was the form's starting drawing.
 *
 * Ten claims:
 *
 *  1. **A document that has just arrived turns nothing.** Every tile is drawn as the page came in, the sentence says
 *     nothing turns yet, and Run is disabled — the schema's `angle` default is 90° and is deliberately *not* drawn
 *     (`packages/contracts/src/tools/catalog.ts`), because a default drawn is a rotation nobody asked for.
 *  2. **The page image is upright, not merely labelled upright.** The transform on the picture is `none` for a page the
 *     request leaves alone and a quarter-turn matrix for one it turns — a board that only relabelled its badges would
 *     pass every other assertion in this file.
 *  3. **The pages that turn are rows, not typed text**: one box for a page, two for a range with the hyphen drawn, and
 *     several rows for several ranges — and naming pages turns exactly those pages, at the angle the API's own default
 *     would use, which is what makes the boxes a control rather than a note to the side.
 *  4. **The rows show the same value the board draws.** Turn the whole document with one button, switch a page off, and
 *     the boxes follow the drawing (`2-6`), because they are one value with two controls rather than two claims.
 *  5. **A mixed document's rows do not disappear — they read the arrangement.** A `perPage` map is not a selection, so
 *     there is no value for the boxes to hold and nothing a keystroke could mean; the field stays where it was, keeps
 *     its label, and lists one row per run of pages that turn one way with the angle in the tiles' own words — and the
 *     boxes come back by themselves the moment one angle covers the document again.
 *  6. **A click on a tile turns that page, and only that page**, in the three angles the tool has; the third click
 *     returns to 90 rather than to a state the API cannot express.
 *  7. **The page number is that page's switch.** A click takes a page out of the turn and a second click puts it back at
 *     the document's angle — "turn everything except page 1" in one click, which is the shape of the request a form
 *     cannot express without the user doing the arithmetic.
 *  8. **The file agrees, page by page.** One page turned by hand inside an otherwise uniform document is a *mixed*
 *     rotation, which is `perPage` — and `readPageGeometry` is what says so, because nothing else can.
 *  9. **A page that turns carries an `as is` button of its own**, and the angle is a caption on a line of its own under the
 *     two quarter turns. The page number is that switch too, and it stays — but a page number on a plate looks like a
 *     label, and a switch only a reader who has been told about it can find is not a control.
 * 10. **`Reset all` means *as is*.** It used to write a quarter turn of every page — the schema's default applied to the
 *     whole document, from the one control whose name promises to undo an arrangement — and it now writes the option
 *     object the form opens with: every page as it came in, the sentence saying what turns it, and Run waiting.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Six pages, none of which carries a `/Rotate` of its own: every angle in the output comes from this request. */
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

/** The tiles, in page order — the state the board is showing. */
function drawnTurns(page: Page) {
  return page.locator('.rotate-shot');
}

/** Each tile's own angle, as the board draws it: `0` is a page the request leaves alone. */
async function angles(page: Page): Promise<string[]> {
  return drawnTurns(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.turn ?? ''));
}

/**
 * The picture inside one tile — the element the turn itself is drawn on.
 *
 * Asserted with `toHaveCSS`, which retries, rather than by reading `getComputedStyle` once: the turn is a `transform`
 * with a 0.22 s transition, and a value read a millisecond after the click is a frame of that animation rather than the
 * angle (the same class of mistake as defect 237, one property over).
 */
function shot(page: Page, index: number) {
  return page.locator('.rotate-shot .page-shot').nth(index);
}

/** One of the rotation's rows of boxes, by the label the field gave it. */
function rowBox(page: Page, row: number, end: 'from' | 'to') {
  return page.getByLabel(`Pages that turn, row ${row} ${end}`);
}

test.describe('a rotation, as a browser makes it', () => {
  test('a page turned on its own comes back turned, and the file says which page', async ({ page }) => {
    await page.goto('/tools/rotate');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/rotate/i);

    // Nothing uploaded: one card and no board, because the pages of a document that does not exist cannot be turned.
    await expect(page.locator('.tool-single')).toHaveCount(1);
    await expect(page.locator('.rotate-card')).toHaveCount(0);

    await chooseFile(page, SIX_PAGES);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
    await expect(page.locator('.tool-split-board')).toHaveCount(1);

    //
    // **The two cards are stacked, and this is measured rather than assumed.** The rotation's product is a row of six
    // tiles — one row of a full-width band, two of a column — so the document is one band on top and the rotation gets
    // the whole width under it. The claim is geometric on purpose: it is exactly the claim a *stale bundle* falsifies
    // while every other assertion here still passes (defect 236, `reorder-pages.e2e.ts`), so what is read is the served
    // stylesheet's single track and the rendered layout boxes, never a class name. Layout boxes (`offsetWidth`/
    // `offsetTop`) rather than `getBoundingClientRect`, for the reason that file gives: the card arrives with an entry
    // animation and a rect read mid-animation is a scaled box (defect 237).
    //
    const stacked = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('.tool-split-board');
      const first = board?.firstElementChild as HTMLElement | null;
      const second = board?.lastElementChild as HTMLElement | null;
      if (!board || !first || !second) return null;
      const columns = getComputedStyle(board).gridTemplateColumns.split(' ').filter(Boolean);
      return {
        columns: columns.length,
        firstWidth: first.offsetWidth - board.clientWidth,
        secondWidth: second.offsetWidth - board.clientWidth,
        below: second.offsetTop >= first.offsetTop + first.offsetHeight,
      };
    });
    expect(stacked).toEqual({ columns: 1, firstWidth: 0, secondWidth: 0, below: true });
    // And the consequence, which is the reason for stacking rather than a bonus: **six pages are one row**. In the split
    // layout this board used to have, a row of six tiles had a third of the page to live in and wrapped — and the one
    // question this screen asks (which way does *this* page come out) is answered by reading the row.
    const rows = await page
      .locator('.rotate-cell')
      .evaluateAll((nodes) => new Set(nodes.map((node) => (node as HTMLElement).offsetTop)).size);
    expect(rows).toBe(1);

    //
    // **Claim 1: a document that has just arrived turns nothing.** Six pages, every one of them upright, no angle
    // badge claiming a turn, and the sentence saying what to do about it — while Run refuses, because this tool cannot
    // express "no rotation": an empty request is the schema's default, which turns every page a quarter. The head of
    // the card counts the same drawing (six tiles, none of them turning).
    //
    await expect(drawnTurns(page)).toHaveCount(6);
    expect(await angles(page)).toEqual(['0', '0', '0', '0', '0', '0']);
    await expect(page.locator('.rotate-angle')).toHaveText(['as is', 'as is', 'as is', 'as is', 'as is', 'as is']);
    await expect(page.locator('.rotate-summary')).toHaveText(
      'Nothing turns yet: use ⟲ or ⟳ on a page, or turn them all with a rotation button below. This tool always turns at least one page — a rotation is 90°, 180° or 270° — so there is no way to ask for an upright document here.',
    );
    await expect(page.locator('.rotate-card .card-head .tiny.faint')).toHaveText('6 pages · 0 of 6 turn');
    await expect(
      page.getByText('Turn at least one page — with ⟲ or ⟳ on a tile, or with a rotation button'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Run / })).toBeDisabled();
    // Claim 2, page 1: the picture is *not* turned. `none` is the whole assertion — a board that drew the schema's
    // default would have page 1 here at `matrix(0, 0.75, -0.75, 0, 0, 0)`, which is what the rotation it replaced did.
    await expect(shot(page, 0)).toHaveCSS('transform', 'none');

    //
    // **Claim 9, first half: the angle is a caption on a line of its own.** The tile's controls are `⟲`, `⟳` and, for a page
    // that turns, `as is` — one row of them — and the caption naming the angle sits *under* that row. It used to share their
    // row, after the buttons, where a 150px tile wrapped it under them anyway; on purpose it happens with room to spare,
    // which is the difference a reader can rely on.
    //
    // "One row" is read as **vertical overlap**, not as equal `offsetTop`s: the `as is` button is 34px tall beside 28px
    // icon buttons (it has a word in it), so a flex row that stretches its items puts its top three pixels higher while
    // both sit on the same line. The stricter reading would have called that a wrap — and it would never have been
    // falsified, because the first half of this claim runs on a document where nothing turns yet, so there is no third
    // control to disagree with (the second half below is where that state exists).
    //
    const tileTop = () =>
      page
        .locator('.rotate-tile')
        .first()
        .evaluate((node) => {
          const controls = Array.from(node.querySelectorAll<HTMLElement>('.rotate-tile-body .row > *'));
          const state = node.querySelector<HTMLElement>('.rotate-tile-state');
          if (!state || controls.length === 0) return null;
          const overlaps = (a: HTMLElement, b: HTMLElement) =>
            b.offsetTop < a.offsetTop + a.offsetHeight && a.offsetTop < b.offsetTop + b.offsetHeight;
          const bottom = Math.max(...controls.map((control) => control.offsetTop + control.offsetHeight));
          return {
            controls: controls.length,
            oneRow: controls.every((control) => overlaps(controls[0]!, control)),
            captionBelow: state.offsetTop >= bottom,
          };
        });
    expect(await tileTop()).toEqual({ controls: 2, oneRow: true, captionBelow: true });
    // And it says the angle in the words the buttons use, rather than a bare number: this is the sentence a person checks
    // after a turn, and on a page nothing turns it is the tool's own phrase for that state.
    await expect(page.locator('.rotate-tile-state').first()).toHaveText('left as it is');

    //
    // **Claim 3: the pages that turn are rows.** A page is one box, so the second box and the hyphen do not exist until
    // the row is widened; and naming a page turns it, at the 90° the API's own `angle` default would use.
    //
    await expect(rowBox(page, 1, 'to')).toHaveCount(0);
    await expect(rowBox(page, 1, 'from')).toBeVisible();
    await rowBox(page, 1, 'from').fill('2');
    await expect(page.locator('.rotate-summary')).toHaveText('1 of 6 pages turn 90° clockwise — 5 left as they are.');
    await expect(
      page.getByText('Turns 1 of 6 pages — the other 5 keep the rotation they already carry.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Pages that turn, make row 1 a range' }).click();
    await expect(rowBox(page, 1, 'to')).toBeVisible();
    await rowBox(page, 1, 'to').fill('4');
    expect(await angles(page)).toEqual(['0', '90', '90', '90', '0', '0']);
    await expect(page.locator('.rotate-angle')).toHaveText(['as is', '90°', '90°', '90°', 'as is', 'as is']);
    await expect(page.locator('.rotate-summary')).toHaveText('3 of 6 pages turn 90° clockwise — 3 left as they are.');
    await expect(
      page.getByText('Turns 3 of 6 pages — the other 3 keep the rotation they already carry.'),
    ).toBeVisible();
    // The turn is drawn on the pages that turn and only on them: page 2 is a quarter turn clockwise, page 1 is still
    // upright, and the matrix is the one the stylesheet writes (a rotated frame scaled to fit the tile it now lives in).
    await expect(shot(page, 1)).toHaveCSS('transform', 'matrix(0, 0.75, -0.75, 0, 0, 0)');
    await expect(shot(page, 0)).toHaveCSS('transform', 'none');
    // The buttons are named for what they reach, and what they reach is the selection: with `2-4` in the boxes, the half
    // turn is `Turn pages 2, 3, 4 180°` and not "every page" — the accessible name is the sentence the labels above it
    // say out loud (`Turn pages 2, 3, 4.`). And now that something turns, Run is available.
    await expect(page.getByRole('button', { name: 'Turn pages 2, 3, 4 90° clockwise' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn pages 2, 3, 4 180°' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn pages 2, 3, 4 90° counter-clockwise' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();

    // **Several ranges in one selection**, which is the reading the boxes were chosen for: the new row arrives with the
    // first page nobody has named (`1`), and `Add range` takes the run from there (5–6) — so the selection is `2-4`,
    // `1` and `5-6` at once, and it covers the document.
    await page.getByRole('button', { name: 'Add page' }).click();
    await expect(rowBox(page, 2, 'from')).toHaveValue('1');
    await page.getByRole('button', { name: 'Add range' }).click();
    await expect(rowBox(page, 3, 'from')).toHaveValue('5');
    await expect(rowBox(page, 3, 'to')).toHaveValue('6');
    expect(await angles(page)).toEqual(['90', '90', '90', '90', '90', '90']);
    await expect(page.locator('.rotate-summary')).toHaveText('Every page turns 90° clockwise.');
    await expect(page.getByText('Turns all 6 pages — the whole document gets this angle.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add page' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add range' })).toBeDisabled();

    //
    // **Claim 6: a click on a tile turns that page, and only that page.** One anticlockwise quarter turn takes page 3
    // from 90 to 270 — the three angles the tool has, and 270 is never printed as "270": the sentence uses the option's
    // own words, so a person reading it does not have to work out which way a quarter turn of three quarters goes.
    //
    await page.getByRole('button', { name: 'Turn page 3 a quarter turn anticlockwise' }).click();
    await expect(drawnTurns(page).nth(2)).toHaveAttribute('data-turn', '270');
    expect(await angles(page)).toEqual(['90', '90', '270', '90', '90', '90']);
    await expect(page.locator('.rotate-summary')).toHaveText(
      'Mixed rotation: 5 90° clockwise, 1 90° counter-clockwise.',
    );
    await expect(shot(page, 2)).toHaveCSS('transform', 'matrix(0, -0.75, 0.75, 0, 0, 0)');
    //
    // **Claim 5: a mixed document's rows do not disappear — they read the arrangement.**
    //
    // A mixed document is a **map of page → angle**, and a map is not a selection: `pages` names the pages that share
    // one angle, so `rotatePatch` clears it (`features/page-rotate/model.ts`) and writing it beside the map was refused
    // by the worker (`PAGES_IGNORED`). The state that left on screen was one empty row of boxes under the field's own
    // label "Pages that turn", a sentence about a document nobody had asked for ("with no pages named the rotation
    // covers every page") and two `Add` buttons that would have written a value nothing reads. Now the field keeps its
    // place and its label and **reads** the arrangement instead: one row per run of pages that turn one way — `1-2` at
    // 90°, the page the user turned on its own, `4-6` at 90° — with the runs spelled the way the value spells them and
    // the angles in the words the tiles use. Nothing is typed and nothing is clicked here, which is why there are no
    // boxes, no remove buttons and no `Add` buttons at all rather than disabled ones.
    //
    await expect(page.locator('.page-row[data-reading="true"]')).toHaveCount(3);
    await expect(page.locator('.page-row-run')).toHaveText(['1-2', '3', '4-6']);
    await expect(page.locator('.page-row-note')).toHaveText([
      '90° clockwise',
      '90° counter-clockwise',
      '90° clockwise',
    ]);
    await expect(page.getByText('Pages that turn')).toBeVisible();
    await expect(page.locator('.rotate-target .page-rows-summary')).toHaveText(
      'Read from the arrangement, not typed into it: these pages turn one way each, so this request is a map of page → angle rather than one set of pages. Turn every page one way with a rotation button below and the boxes come back.',
    );
    await expect(rowBox(page, 1, 'from')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add page' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add range' })).toHaveCount(0);
    await expect(page.getByText('Nothing named yet — with no pages named the rotation covers every page.')).toHaveCount(
      0,
    );

    //
    // **Claim 4: the boxes and the drawing are one value with two controls.** Turning the whole document with one
    // button writes `angle` + every page, and the boxes reopen as the run that value spells (`1-6`); switching page 1
    // off writes the same value minus page 1, and the boxes reopen as `2-6`. It is also the way out of the state above:
    // one angle over the document is a selection, so the reading is gone and the boxes are back without a click aimed at
    // them.
    //
    await page.getByRole('button', { name: 'Turn every page 90° clockwise' }).click();
    await expect(page.locator('.rotate-summary')).toHaveText('Every page turns 90° clockwise.');
    await expect(page.locator('.page-row[data-reading="true"]')).toHaveCount(0);
    await expect(rowBox(page, 1, 'from')).toHaveValue('1');
    await expect(rowBox(page, 1, 'to')).toHaveValue('6');
    await expect(page.getByText('Turns all 6 pages — the whole document gets this angle.')).toBeVisible();

    // Claim 7: the page number is that page's switch. Page 1 off: it is *left as it is* — the option's own zero, written
    // as an omission — and the tiles that still turn keep the angle they had, which is what makes this one click rather
    // than six.
    await page.getByRole('button', { name: 'Leave page 1 as it is' }).click();
    await expect(drawnTurns(page).first()).toHaveAttribute('data-turn', '0');
    await expect(page.locator('.rotate-angle').first()).toHaveText('as is');
    await expect(page.locator('.rotate-summary')).toHaveText('5 of 6 pages turn 90° clockwise — 1 left as it is.');
    await expect(rowBox(page, 1, 'from')).toHaveValue('2');
    await expect(rowBox(page, 1, 'to')).toHaveValue('6');
    // And back on: the page joins the angle the rest of the document is using, so the round trip is the identity.
    await page.getByRole('button', { name: 'Turn page 1 with the rest of the document' }).click();
    await expect(drawnTurns(page).first()).toHaveAttribute('data-turn', '90');
    await expect(page.locator('.rotate-summary')).toHaveText('Every page turns 90° clockwise.');
    await expect(rowBox(page, 1, 'from')).toHaveValue('1');
    await expect(rowBox(page, 1, 'to')).toHaveValue('6');

    //
    // **Claim 9, second half: a page that turns carries an `as is` button.** Every tile turns here, so every tile has one;
    // the one place it does not exist is a page the request already leaves alone, which is the state it produces.
    //
    await expect(page.getByRole('button', { name: /^As is, page \d$/ })).toHaveCount(6);
    // Three controls now, still one row, with the caption under all three of them — the layout claim made in the state it
    // is about.
    expect(await tileTop()).toEqual({ controls: 3, oneRow: true, captionBelow: true });
    await page.getByRole('button', { name: 'As is, page 2' }).click();
    await expect(drawnTurns(page).nth(1)).toHaveAttribute('data-turn', '0');
    await expect(page.locator('.rotate-angle').nth(1)).toHaveText('as is');
    await expect(page.locator('.rotate-summary')).toHaveText('5 of 6 pages turn 90° clockwise — 1 left as it is.');
    // The button goes with the turn it exists for, and the plate carries the way back — the same two controls as before,
    // in the state they are for.
    await expect(page.getByRole('button', { name: 'As is, page 2' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Turn page 2 with the rest of the document' }).click();
    await expect(page.locator('.rotate-summary')).toHaveText('Every page turns 90° clockwise.');

    // Now leave it mixed on purpose — page 5 turned twice, so 180° — and run it. `perPage` is the only form that can say
    // this, and it is what the browser case exists to prove: the JSON box it replaced is gone, and the map is written by
    // the board.
    await page.getByRole('button', { name: 'Turn page 5 a quarter turn clockwise' }).click();
    await expect(page.locator('.rotate-summary')).toHaveText('Mixed rotation: 5 90° clockwise, 1 180°.');

    await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
    await page.getByRole('button', { name: /^Run / }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    const bytes = readFileSync((await file.path())!);
    // Six pages before and after, which is why the page count is not the assertion: `/Rotate` is.
    expect(countPdfPages(bytes)).toBe(6);

    // Claim 8: the file agrees, page by page.
    const geometry = await readPageGeometry(bytes, { repoRoot: REPO_ROOT });
    expect(geometry).not.toBeNull();
    const byPage = new Map(geometry!.map((entry) => [entry.page, entry.rotate]));
    for (const page of [1, 2, 3, 4, 6]) expect(byPage.get(page)).toBe(90);
    expect(byPage.get(5)).toBe(180);

    //
    // **Claim 10: `Reset all` puts every page back to *as is*.** The board goes back to the state a document arrives in —
    // the same drawing, the same sentence and the same disabled Run as the top of this case — rather than to a quarter turn
    // of every page, which is what the schema's default would have made of it. The button is disabled once there is nothing
    // left to clear.
    //
    await page.getByRole('button', { name: 'Reset every page to as it is' }).click();
    expect(await angles(page)).toEqual(['0', '0', '0', '0', '0', '0']);
    await expect(page.locator('.rotate-angle')).toHaveText(['as is', 'as is', 'as is', 'as is', 'as is', 'as is']);
    await expect(page.locator('.rotate-summary')).toHaveText(
      'Nothing turns yet: use ⟲ or ⟳ on a page, or turn them all with a rotation button below. This tool always turns at least one page — a rotation is 90°, 180° or 270° — so there is no way to ask for an upright document here.',
    );
    await expect(page.getByRole('button', { name: /^Run / })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^As is, page \d$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reset every page to as it is' })).toBeDisabled();
  });
});
