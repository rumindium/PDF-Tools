import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

/**
 * The placement canvas, driven the way a user drives it (`0-CICD.md` §3.8).
 *
 * `edit-pdf` is the one tool whose product is *where* things are on a page, and the canvas is the only part of this app
 * that draws a document and turns a pointer into coordinates. Every defect it has had lived in that translation, and no
 * other stage can see any of them: the golden suite builds requests by hand, and `test:placement` imports the geometry
 * module out of the source. So what is asserted here is the *screen*, measured:
 *
 *  1. **The words are typed on the page.** Two clicks on a mark — one to select it, one to open it — put a real text
 *     field over the words it is replacing, drawn at the element's own size and pushed down onto its baseline, and what it
 *     commits is the same value the row's `Text` field shows. That is the whole point of a placement editor: a caption is
 *     written where it will be read.
 *  2. **The row the caret is in does not move.** The row's head is the text the user typed (`elementSummary`), and a flex
 *     item whose content grows grows with it — past about thirty characters the `Remove` button beside it wrapped to a
 *     second line and carried every field below down with it (measured on the served page while typing a 43-character
 *     caption: the head went from 116px to 251px, and the field the caret was in jumped 33px). The assertion is that
 *     geometry rather than the stylesheet that fixes it, because that geometry is what the user felt.
 *  3. **The canvas zooms.** `−`/`+` scale the drawing rather than the card, the reading is the rendered scale, and `Fit`
 *     comes back to the canvas's own width.
 *  4. **Full screen keeps the shell.** The navigation goes off-canvas and the header's handle appears at a desktop width,
 *     the stage is pinned *under* that header rather than over it, the handle still opens the drawer over the canvas, and
 *     Escape leaves the mode. And **in that mode the toolbar stops being a row above the drawing**: it becomes an overlay
 *     that slides out of the top of the stage, so the drawing starts at the stage's own inset and takes the height the bar
 *     was using — measured, the wrap's top moves from 163 to 90 px and its height from 707 to 780, exactly the bar's 63 px
 *     plus the column's 10 px gap — and it comes back when the pointer reaches the stage's top strip, or when a control
 *     inside it takes focus. Three readings, each the failure of a different one: a bar that merely faded would still be
 *     holding the canvas short, so the wrap's top is read against the stage's inset and its bottom against the stage's own
 *     bottom inset; a reveal that ended with the bar behind the canvas would end in a button nobody can press, so the exit
 *     is read as the *topmost* element at its own centre; and a bar that hid while holding the keyboard would be a set of
 *     buttons a keyboard user cannot see, so a bare `focus()` has to bring it back. `Escape` leaves it **one step at a
 *     time**: a selected mark is the closer thing to the hand, so letting go of it is the first press and the mode the
 *     second — which is why the canvas owns that key rather than the mode holding its own (a mode that listened for itself
 *     answered one key twice).
 *  5. **The box is measured in the engine's own Helvetica advances.** `edit-pdf` draws text with Ghostscript, and the
 *     editor now measures with a table of exactly that engine's `stringwidth` (`apps/web/src/features/placement/
 *     base14-metrics.ts`, generated from Ghostscript by `bun run test:base14`). The claim is the disagreement itself:
 *     three twenty-character captions whose widths in that table are all 4440 units — one of apostrophes, one of
 *     backticks, one of `i` — have to come out the same width, and a box measured by the browser's substitute would be
 *     1910 units in the first case and 3330 in the second (defect 250).
 *  6. **Every face the row offers is measured by the engine, not by a family's substitute.** The table carries the three
 *     text families, and the faces whose *style* a CSS family name cannot ask for are the ones a browser gets wrong:
 *     `Times-Italic` was measured with upright Times New Roman, so a caption came out 444 units an `a` where the page
 *     draws 500 (defect 251). Four captions whose engine widths are known to the unit — the roman and the italic, the
 *     bold and the regular, Times's own apostrophe, and Courier's monospace — are typed into the same element and read
 *     off the mark, through the row's face control, as ratios between them.
 *  7. **The toolbox arrives with the first rendered page.** Before a page is rendered the screen is a preparation panel —
 *     the file, a page to pick, and the two ways to render it — with no tool rail, no element list and no drawing, because
 *     a coordinate is not a thing anyone can check before there is a page to read it against. Asserted as absence, which
 *     is what the user sees.
 *  8. **The rail names and explains every tool, and `Render all` is one job per page.** Six icon buttons (the catalogue's
 *     five kinds, plus the canvas's own `Select`), each with the name as its accessible name and the sentence that says
 *     what a click does in a tooltip that appears on hover — and a bulk render that creates exactly one preview job per
 *     page, so moving between the pages afterwards creates none.
 *  9. **The studio's card holds its content off its own border.** A frame with `padding: 0` — the studio's, so that its bar
 *     can meet the card's edge — puts the inset on every region inside it, and the reading is the *layout*: each region's
 *     own first child, measured against the card's inner edge, in the preparation state and in the studio. The defect it
 *     locks down is the one the served page showed first: the head, the field's foot and the whole preparation panel
 *     flush against the border (measured then, x = 285 of a card starting at 284).
 *  10. **Undo takes back a gesture, and redo puts the same one back.** The history is of *gestures*, not of value
 *     changes: a drag made of six pointer moves is one entry, and the drag itself has to *follow the pointer* — 96 px
 *     across and 72 px up of a diagonal 120 px travel, made on a mark placed at the foot of the page — because a start
 *     measured against the mark rather than against the surface re-anchors the mark by its own offset on the first
 *     move, and the larger that offset the further the box is thrown: the low mark is the case that lands against the
 *     page's own edge and is held there by `clampBox` (defect 254, which the user reported as the text box being
 *     hurled to the edge of the page). The diagonal also pins the axis flip, the second place a drag can be wrong: a
 *     hand moving *up* the screen has to move the mark *up* the page. A burst of typing in a row's field is one entry
 *     *typed* key by key (`fill` is a single input event and cannot see a burst rule), and `Clear all` — the one
 *     control that can throw away a session's work — is one press from being taken back. Both stacks are read through
 *     the bar's own two buttons, disabled when empty, and the keyboard does the same thing the buttons do.
 *  11. **`Backspace`/`Delete` removes the mark that is selected, and never a letter being typed.** A mark is a real
 *     `<button>`, so a click selects it and focuses it, and the keystroke arrives on the canvas; the removal is one
 *     entry (`Clear all`'s own rule, one key along), and the two places a caret can be while a mark is selected — the
 *     row's `Text` field and the page's own field — keep it, because a field that writes per keystroke is exactly where
 *     one keypress meaning two things costs the user work.
 *  12. **A press inside a typing burst is its own entry.** The burst rule merges keystrokes; it must not swallow the
 *     button or key pressed a moment later, because the entry the next undo finds would then be the one from *before*
 *     the burst and the mark would come back without the words just typed (defect 256). Read as that value, with the
 *     removal made a few milliseconds after the last keystroke so the window really is open — and read against the drag
 *     claim, where an open pointer gesture still owns its change.
 *  13. **The canvas has a clipboard, and `Escape` is how a selection lets go.** Copy, cut, paste and duplicate are text
 *     editing inside a caret and mark editing outside it, so the guard is read with the clipboard **full**: with the
 *     caret in the row's field, `Ctrl/⌘ + V` has to paste nothing, and a build without the guard pastes a mark. A pasted
 *     mark lands a fixed *screen* distance down-right of its original, arrives selected, and the whole paste is one
 *     entry — as are cut and duplicate, which is the reading that one `Ctrl/⌘ + Z` takes back the action rather than a
 *     step of it. And `Escape` lets go of a mark without touching it, which is the first step of the same unwinding the
 *     mode's own exit is the end of (claim 4 reads that end).
 *  14. **The banner is the tool *described*, and it leaves once a document is in the session.** A placement canvas is the
 *     one screen here that is a *page*, and the hero is 205 px tall at 1440 × 900 — 300 px at 390 wide — sitting above a
 *     1429 px document in a 900 px viewport: every one of those pixels is the page below the fold (measured, once it is
 *     gone the drawing's own top moves 468 → 243, and the card's 317 → 92). Read as a comparison rather than as two
 *     measurements of different things: the hero's box is taken while the page is empty and its **foot is the line** the
 *     card and then the drawing have to come above, because an element that is present and *behind* the thing taking the
 *     room passes any visibility check and proves nothing. It is unmounted rather than hidden, and the state that gets it
 *     back is the empty one — a reload has no document in it — which is what keeps this from being "the banner was
 *     deleted for these tools".
 *  15. **The run's facts outlive the banner.** The hero's `ⓘ` carried the output, the pool's limits, the plan's ceilings and
 *     the retention window — and the plan ceiling and the retention window are what a run is prepared *against*, so
 *     unmounting the hero took them off the screen at the moment they applied. They are drawn at the foot of the studio's
 *     inspector now, from the same component (`features/tool-shell/run-facts.tsx`), and read twice over: the four terms
 *     plus the plan's own name (the live session's, not a literal), and the **geometry** — the panel opens *upward* out of
 *     a trigger at the bottom of a column that has its own scroll, where a panel below the trigger is the scroll
 *     container's own overflow. So the assertion is the box, not the DOM: the panel lying inside the inspector's own box
 *     and inside the viewport, which is what "the reader can read it where it is drawn" means. The second home also
 *     exposed a defect in the panel itself (257): its anchor is the trigger's own edge, and at 390 wide a trigger 105 px
 *     from the left — the hero's — put the panel **199 px off the screen** (267 px in the inspector's foot), so the panel
 *     is now clamped to the window with the 16 px margin its `max-width` already reserved, and that clamp is read at the
 *     same width in the same test.
 *  16. **In full screen the run's facts ride the bar.** The mode hides the inspector and the foot the facts live in with
 *     it, so the bar — the row that slides back in when the pointer reaches the stage's top edge — carries the same four
 *     facts from the same component (`features/tool-shell/run-facts.tsx`), and the foot's node is **dropped** rather than
 *     left in a hidden subtree, so exactly one `ⓘ` is mounted in each mode. Read where it opens: the panel lies **below**
 *     a trigger riding the top of a stage that clips its own overflow, which is the stage's own box, not the cut-off edge
 *     above the trigger. And `Escape` closes the panel **and stops there** — the disclosure is the innermost thing on the
 *     screen, so the mark that is selected behind it is still selected afterwards, which is what keeps one key from
 *     answering twice in the mode whose Escape unwinds a selection first and the mode second (claim 4). The third home is
 *     also the third geometry the clamp is read in (defect 258): **leading**-edge anchored at 390 wide, where the panel is
 *     pulled against the right of the window — the opposite direction from the hero's trigger, and the one that exposed the
 *     clamp measuring the panel's own opening animation (a rect 4 % narrow while `pd-pop` is still at its start). The panel
 *     is deliberately left **open** across that resize rather than reopened inside it, which is claim 17's reading as much
 *     as this one's.
 *  17. **The clamp is re-derived when the window changes, and on both axes, so a panel is never drawn through the foot of
 *     the window.** `InfoTip` measured its panel once, when the panel opened, and only across the window's width — which
 *     left two holes. A window that changed under an open panel kept a correction (or the absence of one) computed for the
 *     window it was opened in: at 1440 the bar's trigger has a thousand pixels of room to its right and is never
 *     corrected, so a panel carried down to 390 is the trigger's own box at 182 px — its right edge at 522, which is
 *     148 px past the margin the clamp exists to keep, and no second open to fix it. And a panel anchored `below` a
 *     trigger with less than its own height of window beneath it opened *under* the fold, where no scroll reaches it.
 *
 *     So the panel is measured against the window's box on both axes every time, and `side` is the caller's preference for
 *     only as long as it fits — which is not a tie-break but a real preference: the hero's `ⓘ` at 390 × 500 has room above
 *     it and not below, so the panel drawn **below** it in an 844-tall window is drawn **above** it in a 500-tall one, read
 *     on a panel that is not reopened between the two (the claim 15 leg's extension). A trigger with no room either way —
 *     the bar's, in a 300 px window, is 19 px past the margin below it and 111 px past it above for a 176 px panel — is
 *     the case the clamp answered by **shortening** the panel rather than moving it: measured, it is placed below its
 *     trigger at `127 → 284` of 300, inside the margin the clamp promises, on `max-height: 157px` with the facts behind a
 *     scroll (claim 20). The window's own 16 px margin is where the correction is measured from, and it goes back to the
 *     panel's own 176 px in a 900 px window, because the correction is derived per window rather than remembered.
 *  18. **A panel is never half-drawn: it is placed inside the box that clips it, not only inside the window.** The banner
 *     carries two blurred blobs drawn outside its own box on purpose, so it clips them — and the `ⓘ` panel hangs **below**
 *     its trigger, which for a trigger at the foot of the banner means outside the banner. Measured before this pass, the
 *     panel was 340 × 176 at `574, 278` inside a clip box ending at 296: the reader saw an 18 px strip, and four of the five
 *     points inside the panel's own middle answered the prepare card behind it (**defect 259**). No claim had caught it,
 *     because `toBeVisible()` asks about the *element* and a clipped panel has a box, a size and a DOM place: the reading has
 *     to be a hit test at the panel's own coordinates, which is what this claim is. The fix is two half-changes, and each is
 *     read: the banner's crop moves to a box that holds nothing but the blobs (so the panel can hang where it was designed
 *     to — below its trigger, at its 8 px gap — and the banner's scroll box is exactly its box again), and `InfoTip`
 *     measures its **region** rather than the window: the window less its 16 px margin, cut down by every ancestor that
 *     clips, with one rule the browser follows and a naive walk does not — an ancestor with `position: fixed` is not clipped
 *     by the boxes above it. The full screen stage is that case: the studio card drawn under it still carries
 *     `overflow: hidden` and is 1380 × 134 there, so a walk that kept going would report a 1378 × 132 region for a panel
 *     the browser draws 340 × 176 across it (measured; the region is 1408 × 820 with the rule).
 *     The intersection is what the inspector's column needs at 900 × 900: it is 193 px tall there and the panel's own anchor
 *     puts it 28 px **above** the column (499 against 527), so the panel is placed at 326 — its head against the column's
 *     inner edge instead of 28 px of it hidden by the box that clips — on `max-height: 148px`, because what the column has
 *     room for under that edge is 148 px and not the 176 the panel would like (claim 20).
 *  19. **The disclosure goes with its trigger when the geometry under it moves.** A panel is anchored in the DOM, so it
 *     follows its trigger when anything scrolls — what goes stale is the **correction** the clamp wrote, and at the open
 *     that correction is what keeps the panel inside the box that clips it. Measured in the studio inspector's own column
 *     (a 340 × 648 box holding 1823 px of content): the panel is placed inside at the open, and scrolling that column
 *     150 px puts its foot 30 px through the box — four of five points inside it answering the panel, with the trigger
 *     itself 38 px below the box already — and 300 px takes the trigger out of the box altogether while the panel is still
 *     drawn (**defect 261**). The clamp therefore runs again whenever anything scrolls, the window resizes, or any
 *     ancestor's box changes size, and a re-derivation first asks whether the trigger is still on the screen: a panel slid
 *     to the edge of a region whose trigger the reader has scrolled away from is a panel explaining nothing, so it closes.
 *  20. **A panel is shortened before it is drawn over the trigger that opened it.** A disclosure that covers its own
 *     trigger is one the pointer can no longer close, and that is what the clamp used to do when neither side had room
 *     for the panel: the slide into the region's own margin put the bar's panel at `108 → 284` of a 300 px window against
 *     a trigger at `89 → 119`, and in the inspector's column at 900 × 900 it covered its own trigger's top 17 px. So the
 *     height is what gives way — the panel is drawn on the side it was asked for, at the height that side has room for,
 *     with its facts scrollable inside it (`overflow-y: auto`) — and the reading is the trigger's own box rather than the
 *     panel's: `panel.top ≥ trigger.bottom` (or the head above `trigger.top` when it opens upward). The floor is the
 *     panel's own first fact: measured at 1440 × 900, its chrome above that fact is 45 px (border, 14 px padding, a 20 px
 *     heading and the 10 px gap under it) and the fact's row is 25 px with the list's own gap, so 72 px is the shortest a
 *     panel says anything in. Below that the clamp gives up and slides the panel as it always did, over its trigger —
 *     measured, a window shorter than **215 px** for the bar's one, where the panel is 22 → 198 with the trigger at
 *     89 → 119. The same rule is what makes no cap necessary anywhere else: 320 px of window is enough for the bar's 176 px
 *     panel on its own side, and a 900 px one takes the panel back to its own height, so both halves are read.
 *  21. **The JSON view costs neither the render nor the session — and takes nothing from the keyboard.** The canvas owns
 *     state that is not a view: the previews (each one a real `pdf-to-images` job) and the history of the session's own
 *     gestures. The field keeps both frames mounted and hides one, so reading the value as text and coming back is free:
 *     no job is created, the drawn mark is still there, the navigation the canvas had hidden comes back while the
 *     drawing is away, and one `Ctrl/⌘ + Z` aimed at the textarea does not travel into the hidden canvas and take the
 *     mark with it. A build that unmounted the canvas answers the return with the preparation panel and a `Render
 *     page 1` button, and a hidden canvas with no `active` gate answers the textarea's undo on the page behind it.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** Three blank A4 pages: the canvas needs a document to draw, and nothing here reads what is on the page. */
const BLANK_A4 = join(FIXTURES, 'pdf-to-images-blank-a4.pdf');

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

/**
 * The canvas with a page on it.
 *
 * The first preview is a **real job** (`pdf-to-images`, one page, 96 dpi) and the surface only has a size once the image
 * has loaded, which is why the assertion is on the surface being visible rather than on the button having been pressed:
 * a canvas that is still rendering is not a canvas, and everything below needs one.
 */
async function openCanvas(page: Page): Promise<void> {
  await page.goto('/tools/edit-pdf');
  await chooseFile(page, BLANK_A4);
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: /Render page 1/ }).click();
  await expect(page.locator('.placement-surface')).toBeVisible({ timeout: 90_000 });
}

/**
 * How many of five points **inside** an open panel's own box answer the panel itself.
 *
 * The reading for "the disclosure is not half-drawn", and it has to be asked of the document rather than of the
 * element: a panel cut in half by an ancestor's `overflow` still has a box, still has a size, is not `display: none` —
 * so `toBeVisible()` passes on a panel whose reader can see an 18 px strip of it (defect 259, measured). What it does
 * not have is anything of *itself* at its own coordinates. Five points rather than one, because the clipping can be an
 * edge: the middle for a lengthwise cut, the two ends, and the two sides. Each is 6 % of the panel's own size inside its
 * border, so neither rounding nor the 1 px hairline decides it.
 */
async function panelHitTests(page: Page, panel: string): Promise<{ hits: number; detail: string }> {
  return page.evaluate((selector) => {
    const node = document.querySelector<HTMLElement>(selector)!;
    const box = node.getBoundingClientRect();
    const points: Array<[number, number]> = [
      [0.5, 0.06],
      [0.5, 0.5],
      [0.5, 0.94],
      [0.06, 0.5],
      [0.94, 0.5],
    ];
    const lines = points.map(([fx, fy]) => {
      const x = box.left + box.width * fx;
      const y = box.top + box.height * fy;
      const hit = document.elementFromPoint(x, y);
      const inside = Boolean(hit?.closest(selector));
      const name = hit
        ? `${hit.tagName.toLowerCase()}.${(typeof hit.className === 'string' ? hit.className : '').split(/\s+/)[0]}`
        : 'nothing';
      return `${inside ? 'panel' : 'NOT the panel'}: ${name} at ${Math.round(x)},${Math.round(y)}`;
    });
    return { hits: lines.filter((line) => line.startsWith('panel')).length, detail: lines.join(' · ') };
  }, panel);
}

/**
 * How far a region's own content sits inside the studio card's border, in display pixels.
 *
 * Two boxes rather than one declaration: the question is not "what is `padding` set to" but "is the content against the
 * border", and the second one is what a reader sees. The card's border width is subtracted because a 1 px hairline of the
 * card is not part of the room the content has.
 */
async function contentInset(
  page: Page,
  region: string,
  content: string,
): Promise<{ left: number; top: number } | null> {
  return page.evaluate(
    ([regionSelector, contentSelector]) => {
      const card = document.querySelector<HTMLElement>('.studio-card');
      const frame = document.querySelector<HTMLElement>(regionSelector!);
      const node = document.querySelector<HTMLElement>(contentSelector!);
      if (!card || !frame || !node) return null;
      const cardBox = card.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      const nodeBox = node.getBoundingClientRect();
      return {
        left: nodeBox.left - (cardBox.left + Number.parseFloat(getComputedStyle(card).borderLeftWidth)),
        top: nodeBox.top - (frameBox.top + Number.parseFloat(getComputedStyle(frame).borderTopWidth)),
      };
    },
    [region, content],
  );
}

test.describe('editing a document on its own page', () => {
  test('the text is typed where it lands, the row does not move, the canvas zooms and takes the screen, and the box is the engine’s own width', async ({
    page,
  }) => {
    await openCanvas(page);
    const surface = page.locator('.placement-surface');

    // ── A mark, placed by a click ────────────────────────────────────────────
    // `Text` is the first kind the catalogue declares, and a click on the page places one at the kind's own default size
    // (`normaliseDraggedBox`: a gesture shorter than the minimum is a click, not a drawing).
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await surface.click({ position: { x: 120, y: 150 } });

    const mark = page.locator('.placement-mark-text').first();
    await expect(mark).toHaveCount(1);
    const row = page.locator('.placement-row').first();
    await expect(row).toHaveCount(1);
    // A mark with nothing typed in it is the kind's own default width (`DEFAULT_SIZE_POINTS.text`, 90 pt), which is the
    // number the claim below measures the typed one against.
    const emptyWidth = (await mark.boundingBox())!.width;

    // ── Claim 1: the second click opens the page's own text field ────────────
    // The first click selected the mark (the drag that placed it did that), so this one is a click on a mark that was
    // already selected and did not travel — which is the gesture, and the reason it is measured as a gesture rather than
    // announced by a mode.
    await mark.click();
    const editor = page.locator('.placement-text-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();

    // It is drawn *as the element is*: the same left edge, the same line height — so its font size is the mark's own box
    // height divided by the line-height both of them use — and pushed down onto the baseline, which is the anchor an
    // `edit-pdf` text element has (`textPlacement`). A field drawn at the theme's size, or a pixel above the baseline,
    // is a preview of a page nobody is looking at.
    const markBox = (await mark.boundingBox())!;
    const editorBox = (await editor.boundingBox())!;
    expect(Math.abs(editorBox.x - markBox.x)).toBeLessThan(2);
    expect(Math.abs(editorBox.height - markBox.height)).toBeLessThan(1.5);
    expect(editorBox.y).toBeGreaterThan(markBox.y);
    expect(editorBox.y).toBeLessThan(markBox.y + markBox.height);
    const fontSize = await editor.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(fontSize).toBeCloseTo(markBox.height / 1.15, 0);

    // Typed, then committed with Enter — and the row's own field is the same value, because it is the same value.
    await editor.fill('Quarterly report, north region');
    await editor.press('Enter');
    await expect(page.locator('.placement-text-editor')).toHaveCount(0);
    await expect(page.locator('#element-0-text')).toHaveValue('Quarterly report, north region');
    //
    // And the mark is now as wide as its words (`textWidthPoints`): the box is measured from the same string the preview
    // draws, which is what stopped a caption's own text hanging outside the dashed outline it had been given. A ratio
    // rather than a width, because both ends of the comparison are on the same zoom.
    //
    expect((await mark.boundingBox())!.width).toBeGreaterThan(emptyWidth * 1.4);

    // ── Claim 2: typing a caption does not move the row's own fields ─────────
    //
    // The head is the text the user typed (`elementSummary`, forty characters and an ellipsis), and a flex item whose
    // content grows grows with it: past about thirty characters the `Remove` button beside the head ran out of room,
    // wrapped to a second line, and carried every field below it down by a line's height. Measured on the served page
    // while typing a 43-character caption into the `Text` field: the head went from 116px to 251px, and the field the
    // caret was in jumped 33px.
    //
    // **The window is narrowed first, and that is not decoration.** The row is as wide as the card it is in, and a claim
    // asserted at a width with room to spare passes for the wrong reason — this one did, until the viewport was set here,
    // with the fix removed and the case still green. So the assertion is made in the column the defect was measured in,
    // and the reading is the *layout* rather than the stylesheet: `offsetHeight`/`offsetTop` rather than rects, because
    // the row lives inside a scrolling viewport and where that happens to be scrolled to is not the claim.
    //
    await page.setViewportSize({ width: 380, height: 820 });
    await expect(row).toBeVisible();
    const rowGeometry = () =>
      page.evaluate(() => {
        const head = document.querySelector<HTMLElement>('.placement-row-head');
        const fields = document.querySelector<HTMLElement>('.placement-fields');
        if (!head || !fields) return null;
        return { headHeight: head.offsetHeight, fieldsTop: fields.offsetTop };
      });
    const before = await rowGeometry();
    expect(before).not.toBeNull();
    await page
      .locator('#element-0-text')
      .fill('A caption long enough that the row head has to wrap twice over, and then some more words');
    const after = await rowGeometry();
    // The head stays one line and the fields below it do not move: the name is ellipsised instead (`placement-row-title`).
    expect(after).toEqual(before);
    // And the name **is** cut off rather than wrapped, which is the mechanism the geometry above is a consequence of.
    const title = await page
      .locator('.placement-row-title')
      .evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(title.scroll).toBeGreaterThan(title.client);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeGreaterThan(500);

    // ── Claim 3: the zoom controls scale the drawing ─────────────────────────
    const fitWidth = (await surface.boundingBox())!.width;
    const reading = page.locator('.placement-zoom-label');
    await expect(reading).toHaveText(/^\d+ %$/);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeGreaterThan(fitWidth * 1.2);
    // The reading is the rendered scale, so it grew with the page.
    const zoomedPercent = Number.parseInt((await reading.textContent())!.trim(), 10);
    expect(zoomedPercent).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Fit' }).click();
    // Back to the canvas's own width. Not `toEqual`: the scrollbar a zoomed page needs is a gutter the fit scale is
    // measured without, so fit is the same drawing a pixel or two narrower rather than the identical number.
    await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeLessThan(fitWidth * 1.02);

    //
    // ── Claim 4: full screen keeps the shell and takes the rest ──────────────
    //
    // **The navigation is already out of the way before the mode is entered**, and that is the behaviour itself: a
    // rendered page means an editing session, and a 264px column of links to *other* tools is the one thing on the screen
    // that is not part of it. The header's handle is where it went, and it is the same control at every width — the
    // drawer the narrow layout already had, keyed on the shell's own `data-drawer` rather than on a second mechanism.
    //
    const side = page.locator('.shell-side');
    const handle = page.locator('.nav-toggle');
    await expect(side).toBeHidden();
    await expect(handle).toBeVisible();
    // …and it still works: the drawer opens *over* the canvas and closes on the click-away.
    await handle.click();
    await expect(side).toBeVisible();
    await page.locator('.shell-overlay').click();
    await expect(side).toBeHidden();

    await page.getByRole('button', { name: 'Full screen' }).click();
    const stage = page.locator('.placement-fullscreen');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveCSS('position', 'fixed');
    // Pinned under the header, not over it: the breadcrumb, the account and the handle are the chrome the mode keeps.
    const stageBox = (await stage.boundingBox())!;
    const barBox = (await page.locator('.shell-topbar').boundingBox())!;
    expect(Math.round(stageBox.y)).toBe(Math.round(barBox.y + barBox.height));
    // The navigation stays off-canvas, and the header's handle stays visible — full screen adds the stage to a drawer the
    // editing session had already asked for rather than being a second, differently-shaped way of hiding the same column.
    await expect(side).toBeHidden();
    await expect(handle).toBeVisible();
    // …and the drawer opens *over* the fixed stage (the drawer's 39 against the stage's 18), so the navigation is
    // reachable mid-edit without the page underneath it moving.
    await handle.click();
    await expect(side).toBeVisible();
    await expect(stage).toBeVisible();
    await page.locator('.shell-overlay').click();
    await expect(side).toBeHidden();

    //
    // ── Claim 4b: in full screen the bar gets out of the way of the drawing, and one reach brings it back ──
    //
    // The bar is the one row in this mode that is not the drawing, and full screen is the mode whose whole subject *is*
    // the drawing — so it stops being a row above the canvas and becomes an overlay that slides out of the top of the
    // stage. Three readings, and each is a way the mode could be quietly wrong instead: **(a)** with the pointer on the
    // page, the bar is out of the stage's own box **and** the wrap has started at the stage's inset — 73 px above where
    // a bar in flow would have left it (its 63 px plus the column's 10 px gap) — while the drawing reaches the stage's
    // own bottom inset, which is the height it gained; a bar that merely faded out would still be holding the canvas
    // short; **(b)** the pointer at the stage's top edge brings it back, and the button that comes back is the **topmost**
    // thing at its own centre, so the reveal ends in something that can be pressed rather than in a bar the canvas covers;
    // **(c)** focusing a control in it brings it back as well, and that is the reading that keeps `Tab` from landing on a
    // button nobody can see — the bar is translated rather than unmounted, so it keeps its tab order.
    //
    const line = () =>
      page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('.placement-studio')!;
        const strip = document.querySelector<HTMLElement>('.studio-bar')!;
        const wrap = document.querySelector<HTMLElement>('.placement-wrap')!;
        const stageBox = stage.getBoundingClientRect();
        const stripBox = strip.getBoundingClientRect();
        const wrapBox = wrap.getBoundingClientRect();
        return {
          stageTop: Math.round(stageBox.top),
          stageBottom: Math.round(stageBox.bottom),
          barTop: Math.round(stripBox.top),
          barBottom: Math.round(stripBox.bottom),
          wrapTop: Math.round(wrapBox.top),
          wrapBottom: Math.round(wrapBox.bottom),
          wrapHeight: Math.round(wrapBox.height),
        };
      });

    // (a) The pointer on the page, which is where a hand is while editing.
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    const away = await line();
    expect(away.barBottom).toBeLessThanOrEqual(away.stageTop);
    // …and the drawing is where the bar was: the stage's own 12 px inset plus `studio-body`'s 14, not 73 px more.
    expect(away.wrapTop).toBeLessThanOrEqual(away.stageTop + 30);
    // …to the stage's own bottom inset, so the height the bar was using is the canvas's.
    expect(away.wrapBottom).toBeGreaterThanOrEqual(away.stageBottom - 32);

    // (b) The reach that brings it back: the pointer at the stage's top edge.
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + 4);
    await expect.poll(async () => (await line()).barTop).toBeGreaterThanOrEqual(away.stageTop);
    const reach = await page.evaluate(() => {
      const exit = [...document.querySelectorAll<HTMLElement>('.studio-bar button')].find((button) =>
        (button.textContent ?? '').includes('Exit full screen'),
      );
      if (!exit) return null;
      const box = exit.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
        topmost: hit === exit || (hit != null && exit.contains(hit)),
      };
    });
    expect(reach).not.toBeNull();
    expect(reach?.onScreen).toBe(true);
    expect(reach?.topmost).toBe(true);

    // (c) The keyboard's own path: a control in the bar taking focus brings the bar back with it.
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await expect.poll(async () => (await line()).barBottom).toBeLessThanOrEqual(away.stageTop);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.studio-bar button[aria-label="Undo"]')?.focus();
    });
    await expect.poll(async () => (await line()).barBottom).toBeGreaterThan(away.stageTop);

    //
    // ── Claim 16: the run's facts ride the bar while the mode is the page ────────────────────────────────────────
    //
    // Claim 15's four facts live at the foot of the inspector, and the mode this reading is taken in hides the inspector
    // — so the plan's ceiling and the retention window went off the screen exactly in the state they are read against:
    // the drawing filling the window, one keystroke from the exit. The bar is the one part of the studio full screen
    // keeps, and the one it slides back in when the pointer reaches the stage's top edge (claim 4b above left it out, at
    // the keyboard's own reveal), so the same component is drawn in it — and the foot's node is *dropped* rather than kept
    // in a hidden subtree, which is the count below: one `ⓘ` mounted at a time, never two.
    //
    const barFacts = page.locator('.studio-bar .infotip-trigger');
    await expect(barFacts).toHaveCount(1);
    await expect(page.locator('.placement-hint .infotip-trigger')).toHaveCount(0);
    await barFacts.click();
    const barPanel = page.locator('.studio-bar .infotip-panel');
    await expect(barPanel).toBeVisible();
    // The same four terms and the session's own plan name — the same list as the foot's, from the same component.
    for (const term of ['Output', 'Job limits', 'Your plan', 'Retention']) {
      await expect(barPanel).toContainText(term);
    }
    await expect(barPanel).toContainText('Pro');
    // The geometry, and it is the direction that matters: the bar rides the top of the stage and the stage clips its own
    // overflow (`overflow: hidden`), so a panel opened the way the inspector's foot opens — **above** its trigger — would
    // be the stage's cut-off edge. Inside the stage's own box is the reading that the panel is on the screen at all — and
    // it is read once the panel has stopped moving, because it opens with a scale animation and a rect taken during that
    // is 4 % narrow (defect 258; the width poll below is what settles it).
    const stageRect = (await stage.boundingBox())!;
    await expect.poll(async () => (await barPanel.boundingBox())!.width).toBeGreaterThan(338);
    const barPanelBox = (await barPanel.boundingBox())!;
    expect(barPanelBox.y).toBeGreaterThanOrEqual(stageRect.y);
    expect(barPanelBox.y + barPanelBox.height).toBeLessThanOrEqual(stageRect.y + stageRect.height);
    expect(barPanelBox.x).toBeGreaterThanOrEqual(stageRect.x);
    expect(barPanelBox.x + barPanelBox.width).toBeLessThanOrEqual(stageRect.x + stageRect.width);
    expect(barPanelBox.y + barPanelBox.height).toBeLessThanOrEqual(900);
    // …and not half-drawn either (claim 18): every point inside the panel answers the panel, which is the reading the
    // stage's own clip makes possible — a fixed stage is not cut by the card behind it, so a panel across that card's edge
    // is drawn whole. (A walk that collected that clip would report a 1378 × 132 region for this panel, which cannot hold a
    // 176 px one; the placement survives that on the fallback to the window, measured, and the region is still the wrong
    // answer — see claim 18's header.)
    const barHits = await panelHitTests(page, '.studio-bar .infotip-panel');
    expect(barHits.hits, barHits.detail).toBe(5);
    // …and the card it is drawn over is the ancestor that keeps clipping. The stylesheet used to spell that as a rule
    // (`.placement-fullscreen .studio-card { overflow: visible }`), which could never match — the mode's class is on the
    // stage *inside* the card — and was removed rather than rewritten, because the stage being `position: fixed` already
    // means the boxes above it cannot clip it: measured, giving the card `overflow: visible` by hand leaves this panel at
    // the same pixel with these same five hits, and the card has nothing outside the stage left to crop. This reading is
    // what keeps the deletion honest: put the card inside the stage and it goes red, which is the moment to take the
    // reasoning again rather than the moment to restore the line.
    expect(await page.locator('.studio-card').evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');
    // `Escape` closes the panel and **stops there**. The canvas binds that key on `window` to let go of the selected mark
    // and then to leave the mode, so a disclosure that merely answered the key would have dropped the mark behind it — one
    // key answering twice, the exact shape the mode's own unwinding was written to avoid (claim 4). The count is the
    // reading, and the mark below is still selected for the Escape that follows it.
    await page.keyboard.press('Escape');
    await expect(barPanel).toHaveCount(0);
    await expect(page.locator('.placement-mark[aria-pressed="true"]')).toHaveCount(1);

    //
    // …and at a phone's width the panel keeps the clamp's own 16 px margin, which is the reading this third home adds to
    // claim 15's: the hero's trigger is anchored by its **trailing** edge and the bar's by its **leading** one, so the two
    // pull the panel in opposite directions — and the bar's is the one that ends up against the *right* of the window. But
    // the panel is reopened here and then **left open across the resize**, because that is the half of the clamp this
    // geometry is the strongest reading of: at 1440 the bar's trigger has 1099 px of room to its right and is never
    // corrected, so a panel that comes out inside 390 is one that was measured against a window it had never been placed
    // in — the correction cannot be the one from the open, because there was no correction.
    //
    await barFacts.click();
    await expect(barPanel).toBeVisible();
    await expect.poll(async () => (await barPanel.boundingBox())!.width).toBeGreaterThan(338);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => Math.round((await stage.boundingBox())!.width)).toBe(390);
    const phoneStage = (await stage.boundingBox())!;
    await page.mouse.move(phoneStage.x + phoneStage.width / 2, phoneStage.y + 4);
    await expect
      .poll(async () => (await page.locator('.studio-bar').boundingBox())!.y)
      .toBeGreaterThanOrEqual(phoneStage.y);
    await expect.poll(async () => Math.round((await barPanel.boundingBox())!.x)).toBeGreaterThanOrEqual(16);
    const phoneBarBox = (await barPanel.boundingBox())!;
    expect(phoneBarBox.x + phoneBarBox.width).toBeLessThanOrEqual(390 - 16);
    expect(phoneBarBox.y).toBeGreaterThanOrEqual(phoneStage.y);

    //
    // ── Claim 17: the window's **height**, where the caller's own direction has no room either way ────────────────
    //
    // 844 px of window is room for anything; 300 is not. The bar's trigger sits at 89 in every window (it rides the
    // stage's top edge, whose own head does not move with the window's foot), and a 176 px panel fits under it only while
    // the window is 319 px tall or more: at 300 the `below` anchor's foot is 19 px past the clamp's margin and the `above`
    // anchor's head is 111 px past it, so neither fits at its own height. What happens then is claim 20's subject and this
    // leg's second half: the panel is **shortened** to the room the side it was asked for has (157 px) and drawn there,
    // which is `127 → 284` — the same corner of the window the old slide reached, without covering the trigger. The reading
    // is against the live `clientHeight` rather than a constant, so it is the window the assertion is about and not a number
    // this file remembered.
    const shortTrigger = (await barFacts.boundingBox())!;
    const naturalHeight = (await barPanel.boundingBox())!.height;
    await page.setViewportSize({ width: 1440, height: 300 });
    const shortStage = (await stage.boundingBox())!;
    await expect
      .poll(async () => Math.round((await page.locator('.studio-bar').boundingBox())!.y))
      .toBeGreaterThanOrEqual(shortStage.y);
    const fold = await page.evaluate(() => document.documentElement.clientHeight);
    expect(fold).toBe(300);
    await expect
      .poll(
        async () => {
          const b = (await barPanel.boundingBox())!;
          return Math.round(b.y + b.height);
        },
        { message: 'the panel stays inside the window it was measured for' },
      )
      .toBeLessThanOrEqual(fold - 16);
    const shortBarBox = (await barPanel.boundingBox())!;
    expect(shortBarBox.y).toBeGreaterThanOrEqual(16);
    expect(shortBarBox.x).toBeGreaterThanOrEqual(16);
    expect(shortBarBox.x + shortBarBox.width).toBeLessThanOrEqual(1440 - 16);

    //
    // ── Claim 20: a panel is shortened before it is drawn over the trigger that opened it ────────────────────────
    //
    // The window above is the case, and the panel in it is the answer: the clamp used to slide a panel with no room on
    // either side into the region's own margin, and the box it landed in was the trigger's own — measured at 1440 × 300, a
    // 176 px panel at `108 → 284` with its trigger at `89 → 119`, so the control that closes the disclosure was under it.
    // What gives way instead is the height: the panel stays on the side it was asked for, capped to what that side has room
    // for, and its facts scroll inside it (`overflow-y: auto`). Three readings, and the invariant is the trigger's box
    // rather than the panel's: a panel that does not cover its trigger can be closed with the pointer that opened it.
    //
    // (a) The 300 px window, where the cap is the whole point of the change.
    const cappedPanel = page.locator('.studio-bar .infotip-panel');
    const cappedBox = (await cappedPanel.boundingBox())!;
    expect(cappedBox.height, 'a panel with no room on either side is shortened').toBeLessThan(naturalHeight);
    expect(cappedBox.y).toBeGreaterThanOrEqual(shortTrigger.y + shortTrigger.height);
    expect(cappedBox.y + cappedBox.height).toBeLessThanOrEqual(fold - 16);
    const capReach = await cappedPanel.evaluate((node) => {
      node.scrollTop = 999;
      return { scrolled: Math.round(node.scrollTop), hidden: node.scrollHeight - node.clientHeight };
    });
    expect(capReach.hidden).toBeGreaterThan(0);
    expect(capReach.scrolled, 'the facts behind the cap are reachable').toBe(capReach.hidden);
    //
    // (b) The other side of the boundary, and the number is the measurement rather than a preference: 215 px of window is
    // the last height at which the bar's own side still has the 72 px a panel needs to say anything (its 45 px of chrome
    // above the first fact and that fact's 25 px row), and at 214 the clamp gives up and slides it — `22 → 198`, over the
    // trigger. A window this short is the one place the panel is drawn on top of its own control, and the claim says so
    // rather than implying a promise the clamp cannot keep.
    await page.setViewportSize({ width: 1440, height: 214 });
    await expect.poll(async () => Math.round((await barPanel.boundingBox())!.y)).toBeLessThan(shortTrigger.y);
    const slidBox = (await barPanel.boundingBox())!;
    expect(slidBox.y + slidBox.height).toBeGreaterThan(shortTrigger.y);
    expect(slidBox.y).toBeLessThan(shortTrigger.y + shortTrigger.height);
    // Back to the stage's own window, because the mode is still open and the claims after this one are read at 1440 — and
    // the panel goes back under its trigger, at the y its own stylesheet gives it and at its own height, which is the
    // correction — both halves of it — being derived from the window each time rather than remembered.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => Math.round((await barPanel.boundingBox())!.y)).toBe(Math.round(shortTrigger.y) + 38);
    await expect.poll(async () => Math.round((await barPanel.boundingBox())!.height)).toBe(Math.round(naturalHeight));
    expect(await barPanel.evaluate((node) => node.style.maxHeight)).toBe('');
    await page.keyboard.press('Escape');
    await expect(barPanel).toHaveCount(0);
    await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeGreaterThan(500);

    // Escape is the way out every full-screen mode has, and it is the one exit that does not depend on the bar being
    // asked for: the button above is the exit *stated*, and this is the one that is always at hand. But it is **one step
    // of the canvas's own unwinding rather than a key the mode owns**, and a selected mark is the closer thing to the
    // hand: with one selected, the first Escape lets go of it and the stage is still there, and the second leaves the
    // mode. The mode used to hold a listener of its own, which closed the stage *and* let go of the mark — one key
    // answering twice, and the wrong answer first for anyone who only meant to step back from a mark.
    await expect(page.locator('.placement-mark[aria-pressed="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(stage).toBeVisible();
    await expect(page.locator('.placement-mark[aria-pressed="true"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(stage).toHaveCount(0);
    // Still a drawer, because the canvas is still open on a rendered page: leaving full screen is not leaving the editor.
    await expect(side).toBeHidden();
    await expect(handle).toBeVisible();
    // And the page is still the same document, edited: leaving the mode is not leaving the work.
    await expect(page.locator('#element-0-text')).toHaveValue(
      'A caption long enough that the row head has to wrap twice over, and then some more words',
    );

    // ── Claim 5: the dashed box is the engine's own advance widths ───────────
    //
    // The box around a caption is a promise about ink — the outline is where the page will put the words — and the page
    // is drawn by Ghostscript, so the only widths that can keep that promise are Ghostscript's own. Two of the codes in
    // the table below are where a browser's Helvetica substitute stops agreeing with it, read out of the engine with
    // `/Helvetica findfont dup /Encoding get 39 get` and `stringwidth`:
    //
    //   · code 39 (`'`) is `/quoteright`, **222 units**, where a browser resolves U+0027 to `quotesingle` at 191;
    //   · code 96 (`` ` ``) is `/quoteleft`, **222**, where a browser resolves U+0060 to `grave` at 333;
    //   · `i` is 222 in both, so it is the control rather than the claim.
    //
    // Three captions of twenty characters, then, are all 4440 units of ink: their boxes have to agree with each other to
    // a fraction of a pixel, and a box measured by the substitute would be 16 % short for the apostrophes and a third
    // long for the backticks. **Nothing here is compared against a constant of this test's own** — no points-per-pixel,
    // no dpi, no zoom — which is what makes it a claim about the metrics rather than about the arithmetic of the canvas:
    // the three boxes can only agree if the number 222 came from the engine.
    //
    const markWidth = async (text: string) => {
      await page.locator('#element-0-text').fill(text);
      return (await mark.boundingBox())!.width;
    };
    const apostrophes = await markWidth("''''''''''''''''''''");
    const backticks = await markWidth('`'.repeat(20));
    const narrow = await markWidth('i'.repeat(20));
    expect(Math.abs(apostrophes - narrow)).toBeLessThan(0.5);
    expect(Math.abs(backticks - narrow)).toBeLessThan(0.5);
    //
    // The control, so that the three above are not equal by some accident of a box that ignores its string: `W` is 944
    // units against 222, so it has to come out 4.252× as wide — an engine number as well, and one the right box can only
    // reach by measuring.
    //
    const wide = await markWidth('W'.repeat(20));
    expect(wide / narrow).toBeCloseTo(944 / 222, 2);

    //
    // The field the caret is in is measured from the same numbers — the row's head selects the mark, and one click on a
    // selected mark opens the editor over the words (`beginEditing`). Its width is the mark's plus the field's own 14 px
    // of gutter, so twenty apostrophes have to come out exactly as wide as twenty `i`s: the box and the thing the user
    // types into are one measurement, not two that happen to agree today.
    //
    await page.locator('.placement-row-head').first().click();
    await mark.click();
    const field = page.locator('.placement-text-editor');
    await expect(field).toBeVisible();
    const fieldWidth = async (text: string) => {
      await field.fill(text);
      return (await field.boundingBox())!.width;
    };
    const fieldApostrophes = await fieldWidth("''''''''''''''''''''");
    const fieldNarrow = await fieldWidth('i'.repeat(20));
    expect(Math.abs(fieldApostrophes - fieldNarrow)).toBeLessThan(0.5);
    expect(Math.abs(fieldNarrow - 14 - narrow)).toBeLessThan(0.5);
    // Escape abandons the draft, which is the other half of the field being a field (`cancelEditing`).
    await field.press('Escape');
    await expect(field).toHaveCount(0);

    // ── Claim 6: the box follows the face, and every face is the engine’s ────
    //
    // e5 asked about the two codes a browser’s Helvetica substitute disagrees about, in one face. This asks the other
    // half of the same defect: the **families the table carries** and the faces whose style no CSS family name can
    // request. `cssFamilyFor` can only name a family — `Times New Roman, Times, serif` for anything beginning with
    // `times` — and a browser resolves that to the upright regular face, so before this table had those rows a
    // `times-italic` caption was measured 444 units an `a` where Ghostscript draws 500 (defect 251, 12.6 % of the
    // caption outside its own outline).
    //
    // The row’s own control is what changes the face, so this is the user’s path and not a JSON edit: `faceChoices`
    // offers `BASE14_FACES`, which is derived from `POSTSCRIPT_FONTS` — the map the node handler resolves an element’s
    // font through — so every value it can write is one the engine will draw. Every reading is taken before the first
    // assertion, and every number below is a ratio of two boxes on the same zoom, which is what keeps this a claim about
    // metrics rather than about the canvas’s arithmetic.
    //
    const faces = page.locator('#element-0-face');
    await expect(faces).toHaveValue('Helvetica');
    //
    // …and it offers exactly the faces the overlay can draw: a value the handler would refuse with `FONT_NOT_FOUND` is
    // not a choice this control may give, and the eight below are `POSTSCRIPT_FONTS`’ own values — which is where the
    // table’s list comes from in the first place.
    //
    expect(await faces.locator('option').evaluateAll((options) => options.map((o) => o.getAttribute('value')))).toEqual(
      [
        'Helvetica',
        'Helvetica-Bold',
        'Helvetica-Oblique',
        'Times-Roman',
        'Times-Bold',
        'Times-Italic',
        'Courier',
        'Courier-Bold',
      ],
    );
    const faceWidth = async (face: string, text: string) => {
      await faces.selectOption(face);
      await page.locator('#element-0-text').fill(text);
      return (await mark.boundingBox())!.width;
    };
    const twentyA = 'a'.repeat(20);
    const roman = await faceWidth('Times-Roman', twentyA);
    const italic = await faceWidth('Times-Italic', twentyA);
    const twentyW = 'W'.repeat(20);
    const romanW = await faceWidth('Times-Roman', twentyW);
    const boldW = await faceWidth('Times-Bold', twentyW);
    const twentyQuotes = "''''''''''''''''''''";
    const helveticaQuotes = await faceWidth('Helvetica', twentyQuotes);
    const timesQuotes = await faceWidth('Times-Roman', twentyQuotes);
    const twentyI = 'i'.repeat(20);
    const timesI = await faceWidth('Times-Roman', twentyI);
    const helveticaI = await faceWidth('Helvetica', twentyI);
    const courierI = await faceWidth('Courier', twentyI);
    const courierW = await faceWidth('Courier', twentyW);
    //
    // 444 against 500 units of an `a`: the italic is 12.6 % wider, and *equal* widths are what a box measured through
    // the family substitute gives for the two values — the defect, stated as the difference it erased.
    //
    expect(italic / roman).toBeCloseTo(500 / 444, 3);
    //
    // The bold face is the other style a family name cannot name: `W` is 1000 units against the roman’s 944, so the bold
    // box has to be 5.9 % wider — and the substitute would answer 944 for both.
    //
    expect(boldW / romanW).toBeCloseTo(1000 / 944, 3);
    //
    // Times’s apostrophe is code 39, the engine’s `/quoteright` at **333** where Chrome resolves U+0027 to a Times New
    // Roman `quotesingle` at **180.2** — the same code class as defect 250, in a family whose substitute is otherwise
    // metric-compatible. Against `i` (278) the ratio is 1,198, where the substitute answers 0,649: a caption hanging
    // 46 % of its own width outside the box drawn around it.
    //
    expect(timesQuotes / timesI).toBeCloseTo(333 / 278, 3);
    // …and the same text is *wider* in Times than in Helvetica, where the substitute would make it narrower: 333 against
    // 222 units a glyph, the exact opposite of the browser’s 180 against 222.
    expect(timesQuotes).toBeGreaterThan(helveticaQuotes);
    //
    // Courier is monospaced — every glyph 600 units, in both of its faces — so `i` and `W` are the same width in it, and
    // 600/222 of the same text in Helvetica. Neither number is one a substitute could produce by accident: Courier New
    // is metric-compatible here, and the claim is that the *engine* said 600 rather than that the browser agreed.
    //
    expect(Math.abs(courierW - courierI)).toBeLessThan(0.5);
    expect(courierI / helveticaI).toBeCloseTo(600 / 222, 3);
  });

  test('the toolbox arrives with the first rendered page, and the rail explains itself', async ({ page }) => {
    //
    // How many preview jobs the page created. The bulk render's claim is *one job per page, and none afterwards*, which
    // is a fact about the requests rather than about the picture: a page that was rendered ahead of time and a page that
    // silently renders when it is opened look identical on screen, and only one of them is what "Render all" promised.
    //
    let jobs = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/v1/jobs')) jobs += 1;
    });

    await page.goto('/tools/edit-pdf');

    //
    // ── Claim 14: the banner is the tool described, and it leaves when there is a tool being used ────────────────
    //
    // The first half is measured where the user meets it: `.tool-hero` is on screen **and topmost at its own centre**
    // while the page has no document, read through `elementFromPoint` rather than by presence — an element that is there
    // but behind the thing taking the room would pass `toBeVisible` and prove nothing (full screen is exactly that case:
    // present, 205 px, and covered). The box is kept because the rest of the claim is a comparison with it.
    const hero = page.locator('.tool-hero');
    await expect(hero).toBeVisible();
    const heroBox = (await hero.boundingBox())!;
    expect(heroBox.height).toBeGreaterThan(150);
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.tool-hero') != null,
        [heroBox.x + heroBox.width / 2, heroBox.y + heroBox.height / 2],
      ),
    ).toBe(true);

    await chooseFile(page, BLANK_A4);
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);

    // The session is open, so the banner is **unmounted** — not hidden, so it is out of the tab order and out of the
    // accessibility tree — and the card's top steps **over the foot of the box it used to occupy**. One number from each
    // state on the same page at the same viewport is the whole reading: 205 px of hero above a document taller than the
    // window is 205 px of the page below the fold, which is what "the banner is still there" means from the chair.
    await expect(hero).toHaveCount(0);
    const cardTop = await page.locator('.studio-card').evaluate((node) => node.getBoundingClientRect().top);
    expect(cardTop).toBeLessThan(heroBox.y + heroBox.height);

    // ── Claim 7: before the first render there is no toolbox, no list and no drawing ─────────────
    // Asserted as absence, because absence is what the user sees: a rail of tools over an empty box asks the reader to
    // choose how to write a caption before they have seen the page it goes on.
    await expect(page.locator('.studio-prepare')).toBeVisible();
    await expect(page.locator('.studio-rail')).toHaveCount(0);
    await expect(page.locator('.placement-row')).toHaveCount(0);
    await expect(page.locator('.placement-surface')).toHaveCount(0);
    // The file is named and the upload is stated as finished — the state a render needs, and the reason the button below
    // is honest rather than hopeful.
    await expect(page.locator('.studio-prepare-file')).toContainText('pdf-to-images-blank-a4.pdf');
    await expect(page.locator('.studio-prepare-file')).toContainText('3 pages');
    // …and the only actions on the screen are the two ways to render it.
    await expect(page.getByRole('button', { name: 'Render page 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Render all 3 pages' })).toBeVisible();

    //
    // ── Claim 9: the card's frame insets the content it draws ────────────────
    //
    // The card's own padding is zero *on purpose* — the studio bar has to meet its edge — so the inset is the business of
    // the regions inside it. That is exactly what the first version of this frame got wrong, so the reading is the layout:
    // a region's own first child against the card's inner border, in both states.
    //
    for (const [region, content] of [
      ['.studio-head', '.card-head-icon'],
      ['.studio-prepare', '.studio-prepare-file'],
      ['.placement-foot', '.placement-foot .tiny'],
    ] as const) {
      const inset = await contentInset(page, region, content);
      expect(inset, `${region} → ${content}`).not.toBeNull();
      expect(inset!.left, `${region} → ${content} (left)`).toBeGreaterThanOrEqual(12);
      expect(inset!.top, `${region} → ${content} (top)`).toBeGreaterThanOrEqual(8);
    }

    // ── Claim 8: `Render all` is one job per page, and the rail explains every tool ──────────────
    await page.getByRole('button', { name: 'Render all 3 pages' }).click();
    await expect(page.locator('.placement-surface')).toBeVisible({ timeout: 120_000 });

    // …and the same relation in the drawn state, which is the one the report was about: the **page** begins above the line
    // the banner's foot was on (measured 243 < 311), so the room really did go to the drawing rather than to a gap.
    await expect(hero).toHaveCount(0);
    const surfaceTop = await page.locator('.placement-surface').evaluate((node) => node.getBoundingClientRect().top);
    expect(surfaceTop).toBeLessThan(heroBox.y + heroBox.height);

    //
    // ── Claim 15: the run's facts outlive the banner, at the foot of the inspector ────────────────────────────────
    //
    // The banner's `ⓘ` was the only home of these four facts, and it is unmounted by the state this reading is taken in.
    // The trigger that took over is asserted to be *in the inspector* rather than in the hero, so a build that simply
    // kept a second copy in the (absent) banner would not pass.
    // The `ⓘ` is in the inspector's foot — beside the keyboard hint — and the hero it used to be inside is not on the page
    // at all, so a build that merely kept the banner's copy would not pass this.
    const factsTrigger = page.locator('.studio-inspector .placement-hint .infotip-trigger');
    await expect(factsTrigger).toHaveCount(1);
    await expect(page.locator('.tool-hero .infotip-trigger')).toHaveCount(0);
    await factsTrigger.scrollIntoViewIfNeeded();
    await factsTrigger.click();
    const factPanel = page.locator('.studio-inspector .infotip-panel');
    await expect(factPanel).toBeVisible();
    // The four terms, by name — the same list the hero carried, and `Pro` is the live session's own plan name, which is
    // the half a copy of the strings would get right by accident only if the plan really were the dev header's.
    for (const term of ['Output', 'Job limits', 'Your plan', 'Retention']) {
      await expect(factPanel).toContainText(term);
    }
    await expect(factPanel).toContainText('Pro');
    // …and the geometry, which is the half the DOM cannot answer: the panel is drawn **above** its trigger, so it lies
    // inside the column it belongs to and inside the window, rather than in the scroll container's overflow below.
    const inspectorBox = (await page.locator('.studio-inspector').boundingBox())!;
    const panelBox = (await factPanel.boundingBox())!;
    expect(panelBox.y).toBeGreaterThanOrEqual(inspectorBox.y);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(inspectorBox.y + inspectorBox.height);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(900);
    // Closed again before the rest of the screen is read: the panel is drawn over the settings it belongs to, and a
    // `Escape` that closed it is also the reading that it is a disclosure rather than a fixture.
    await page.keyboard.press('Escape');
    await expect(factPanel).toHaveCount(0);

    //
    // ── Claim 18, in the column that clips: the panel is placed where it is *drawn* ───────────────────────────────
    //
    // This is the one home where the panel is cut by an ancestor rather than by the window: the inspector is a scroll
    // container (`overflow: auto`), so everything outside its own box is invisible no matter what the window has room for.
    // At 900 × 900 the column is 826 × 193 — wide enough for the panel and 191 px of usable height for a 176 px one — and
    // the panel's own anchor puts it **28 px above the column's top** (499 against 527). Read with the panel left open
    // across the resize, so this is also the placement the `resize` listener derives: measured, the panel is at 326, its
    // head against the column's inner edge instead of 28 px of it hidden by the box that clips — on `max-height: 148px`,
    // because the room under that inner edge is 148 px, which is claim 20's half of the same placement. Every point inside
    // it answers the panel, which is the same fact in the reader's terms — without the intersection the panel is 499..675
    // with its first row outside the column it belongs to.    // The panel is opened *after* the resize, not carried across it: the clamp measures the geometry that exists when it
    // runs, and the column moves a long way when the studio becomes one column — 826 × 193 below the canvas at this width,
    // where at 1440 it is a 308 px sidebar. What is read is where the clamp puts it, against the box that clips it.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.locator('.studio-inspector').scrollIntoViewIfNeeded();
    const narrowColumn = (await page.locator('.studio-inspector').boundingBox())!;
    await factsTrigger.click();
    await expect(factPanel).toBeVisible();
    await expect.poll(async () => (await factPanel.boundingBox())!.width).toBeGreaterThan(338);
    const narrowBox = (await factPanel.boundingBox())!;
    // The sentence is the assertion's own name, and it is here for `falsify`'s sake: a served-asset claim's evidence is
    // the message the case failed with, and "Expected: 530 / Received: 499" would make the verdict a number nobody can
    // read. Every reading this stage mutates carries one; the pattern is `expect(value, 'what is owed')`.
    expect(narrowBox.y, 'the panel is placed inside the column that clips it').toBeGreaterThanOrEqual(
      Math.round(narrowColumn.y),
    );
    expect(narrowBox.y + narrowBox.height).toBeLessThanOrEqual(Math.round(narrowColumn.y + narrowColumn.height));
    const columnHits = await panelHitTests(page, '.studio-inspector .infotip-panel');
    expect(columnHits.hits, columnHits.detail).toBe(5);
    // …and the claim-20 half of the same placement, read in the home where the old slide covered its own trigger: the
    // column has room for 148 px under its own edge and not for 176, so the panel gives way in height (and its facts
    // scroll) rather than lying over the button that opened it. Measured before this pass: a panel at `326 → 502` with its
    // trigger at `482 → 512`, the top 17 px of the trigger under the panel.
    const footTriggerBox = (await factsTrigger.boundingBox())!;
    expect(narrowBox.y + narrowBox.height).toBeLessThanOrEqual(Math.round(footTriggerBox.y));
    expect(await factPanel.evaluate((node) => node.style.maxHeight)).not.toBe('');
    const footReach = await factPanel.evaluate((node) => {
      node.scrollTop = 999;
      return { scrolled: Math.round(node.scrollTop), hidden: node.scrollHeight - node.clientHeight };
    });
    expect(footReach.hidden).toBeGreaterThan(0);
    expect(footReach.scrolled).toBe(footReach.hidden);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await expect(factPanel).toHaveCount(0);

    //
    // ── Claim 19: the disclosure goes with its trigger when the geometry under it moves ────────────────────────
    //
    // The clamp is a measurement of a moment, and it is the box the reader scrolls that clips the panel: the panel is
    // anchored in the DOM and rides with the trigger, so it is the **correction** that goes stale. Measured in this column
    // (340 × 648 of visible box holding 1823 px of content, three marks), the panel is placed at `595 → 771` inside the
    // box, and scrolling the column 150 px up puts it at `745 → 921` — its foot 30 px through the box, four of the five
    // points inside it answering the panel, while the trigger itself is 38 px below the box; another 150 px takes the
    // trigger out of the box altogether with the panel still "open" (**defect 261**).
    //
    // Two mechanisms, both read below. The clamp runs again whenever anything scrolls or any ancestor's box changes size
    // (`ResizeObserver` over the trigger and its whole chain, because the box that clips the panel is exactly the thing
    // being scrolled) — and a re-derivation first asks whether the trigger is still on the screen at all, because a panel
    // slid to the edge of a region whose trigger has left the reader's view is a panel explaining something nobody can
    // see. The second mechanism needs a gesture that changes the layout **without** closing the panel first: a click
    // outside is a click-away, so the duplicate is a keystroke, and it grows the inspector's box (measured 814 → 1034 px)
    // with the trigger 220 px further down inside it.
    //
    // Both of those can be answered by **either** mechanism, and that is worth knowing rather than papering over.
    // Growing the column while the page is scrolled past it also makes the browser emit a `scroll` of the document —
    // scroll anchoring re-placing content it had already measured, with `scrollY` still 1262 — which the captured
    // listener catches. And the column leg is answerable by both for a different reason: the studio re-lays itself out
    // around that moment (measured `.studio-body` at 34 px when the scroll was about to be made and 676 px a second
    // later), so an ancestor's box moves whatever the scroll listener does. Neither overlap can be split from inside this
    // test, so both were split on the served bundle instead: with the scroll listener deleted and the observer left in
    // place, a page that only duplicates a mark by keyboard still closes the panel (3/3 runs), and with **both** deleted
    // it stays open (3/3, `Expected: 0 / Received: 1`) — that pair is the observer's own reading. The scroll listener's
    // is the page leg below: deleting that listener fails *this* file at the page leg and at neither close above it.
    //
    // Three marks first, and the column needed them: with an empty element list the inspector is 308 px tall and its
    // content fits inside it, so there is nothing to scroll and nothing to measure. Three rows (one of them carrying its
    // own options) make it 648 px of box holding 1823 px of content, which is the geometry the defect was found in.
    //
    const canvas = page.locator('.placement-surface');
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const canvasBox = (await canvas.boundingBox())!;
    for (const y of [0.2, 0.4, 0.6]) {
      await canvas.click({ position: { x: Math.round(canvasBox.width * 0.4), y: Math.round(canvasBox.height * y) } });
    }
    await expect(page.locator('.placement-mark-text')).toHaveCount(3);
    await page.getByRole('button', { name: 'Select', exact: true }).click();

    const sidebar = page.locator('.studio-inspector');
    await sidebar.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.scrollIntoView({ block: 'end' });
    });
    const sidebarTrigger = page.locator('.studio-inspector .placement-hint .infotip-trigger');
    const sidebarPanel = page.locator('.studio-inspector .infotip-panel');
    await sidebarTrigger.click();
    await expect.poll(async () => (await sidebarPanel.boundingBox())!.width).toBeGreaterThan(338);
    const openedInColumn = (await sidebarPanel.boundingBox())!;
    const sidebarBox = (await sidebar.boundingBox())!;
    expect(openedInColumn.y).toBeGreaterThanOrEqual(sidebarBox.y);
    expect(openedInColumn.y + openedInColumn.height).toBeLessThanOrEqual(sidebarBox.y + sidebarBox.height);
    const openedHits = await panelHitTests(page, '.studio-inspector .infotip-panel');
    expect(openedHits.hits, openedHits.detail).toBe(5);
    // The column, scrolled under it the way a wheel does: the foot of the trigger leaves the box, so the disclosure
    // leaves with it rather than staying drawn as a strip nobody can attribute to anything.
    // The column, scrolled the way a wheel scrolls it — and the scroll it means to make is asserted rather than assumed:
    // what has to be true before the close can be read is that the trigger's **whole box** has left the box that clips
    // it (measured: 200 px of column takes the trigger's top from `779` to `979` against a box that ends at `891`), so a
    // gesture that scrolled nothing would fail here rather than pass as a panel that stayed open.
    await sidebar.evaluate((node) => {
      node.scrollTop -= 200;
    });
    await expect
      .poll(async () => (await sidebarTrigger.boundingBox())!.y)
      .toBeGreaterThan(sidebarBox.y + sidebarBox.height);
    await expect(sidebarPanel).toHaveCount(0);

    // The other trigger for the same rule, and the one that is not a scroll at all: at 900 wide the studio is one column,
    // a mark duplicated by keyboard grows the column's box, and the trigger travels down inside it — still on the screen,
    // so the panel is placed again rather than closed, until the second duplicate takes the trigger past the window's
    // foot (measured: its top at 922 of a 900 px window) and there is nothing left for the panel to belong to.
    await page.setViewportSize({ width: 900, height: 900 });
    await sidebar.evaluate((node) => {
      node.scrollIntoView({ block: 'end' });
    });
    await sidebarTrigger.click();
    await expect.poll(async () => (await sidebarPanel.boundingBox())!.width).toBeGreaterThan(338);
    const beforeGrow = (await sidebar.boundingBox())!;
    await page.keyboard.press('Control+d');
    await expect.poll(async () => (await sidebar.boundingBox())!.height).toBeGreaterThan(beforeGrow.height);
    await expect(sidebarPanel).toHaveCount(1);
    const grownHits = await panelHitTests(page, '.studio-inspector .infotip-panel');
    expect(grownHits.hits, grownHits.detail).toBe(5);
    await page.keyboard.press('Control+d');
    await expect(sidebarPanel).toHaveCount(0);

    // And the page itself, which is the same question one box out: reopened at the document's end, a wheel up of 400 px
    // still leaves the trigger on the screen (the panel rides with it, inside the window), and 600 px does not.
    await sidebarTrigger.scrollIntoViewIfNeeded();
    await sidebarTrigger.click();
    await expect.poll(async () => (await sidebarPanel.boundingBox())!.width).toBeGreaterThan(338);
    const documentBefore = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, -400));
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeLessThan(documentBefore);
    await expect(sidebarPanel).toHaveCount(1);
    const ridden = (await sidebarPanel.boundingBox())!;
    expect(ridden.y).toBeGreaterThanOrEqual(16);
    expect(ridden.y + ridden.height).toBeLessThanOrEqual(900);
    await page.evaluate(() => window.scrollBy(0, -200));
    await expect.poll(async () => (await sidebarTrigger.boundingBox())!.y).toBeGreaterThan(900);
    await expect(sidebarPanel, 'the disclosure goes with its trigger when the page scrolls past it').toHaveCount(0);

    // …and the studio is put back the way the rest of this screen is read: at a desktop width, with nothing left open.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.infotip-panel')).toHaveCount(0);

    const rail = page.locator('.studio-rail');
    await expect(rail).toBeVisible();
    // The catalogue's five kinds, in its order, plus the canvas's own `Select` — which is the resting tool and the reason
    // a stray click on the page no longer leaves a mark behind.
    expect(
      await rail.getByRole('button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
    ).toEqual(['Select', 'Text', 'Shape', 'Checkbox', 'Image', 'Freehand']);

    // The tooltip is drawn rather than described (`title` does not appear for a button that is focused but not hovered),
    // and it carries the sentence as well as the name: "Text" alone does not say what a click will do.
    const textTool = rail.getByRole('button', { name: 'Text', exact: true });
    const tip = textTool.locator('.studio-tip');
    await expect(tip).toBeHidden();
    await textTool.hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator('.studio-tip-name')).toHaveText('Text');
    await expect(tip.locator('.studio-tip-hint')).toContainText('Click the page to write a caption');

    // …and the same reading in the studio, where the regions are different ones: the bar, the rail and the foot.
    for (const [region, content] of [
      ['.studio-head', '.card-head-icon'],
      ['.studio-bar', '.studio-bar-doc'],
      ['.studio-body', '.studio-rail'],
      ['.placement-foot', '.placement-foot .tiny'],
    ] as const) {
      const inset = await contentInset(page, region, content);
      expect(inset, `${region} → ${content}`).not.toBeNull();
      expect(inset!.left, `${region} → ${content} (left)`).toBeGreaterThanOrEqual(12);
      expect(inset!.top, `${region} → ${content} (top)`).toBeGreaterThanOrEqual(8);
    }

    // The tool is armed by the press, and the drawing says so before anything is placed: `Select` is pressed to begin
    // with, and arming `Text` is a state on the button rather than a mode the user has to remember.
    await expect(rail.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await textTool.click();
    await expect(textTool).toHaveAttribute('aria-pressed', 'true');
    await expect(rail.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Every page was rendered by that one press. Moving between them is therefore a *read* — the bar's own page controls
    // — and the count of created jobs says so: three for three pages, and not one more for the two visits. The run's own
    // reading has to be gone first: it lives under the bar once the studio is open (the preparation panel it was started
    // from is unmounted by the first page landing), and its absence is what "the run finished" means.
    await expect(page.locator('.studio-bulk')).toHaveCount(0, { timeout: 120_000 });
    expect(jobs).toBe(3);
    const bar = page.locator('.studio-bar');
    await expect(bar).toContainText('page 1 of 3');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(bar).toContainText('page 2 of 3');
    await expect(page.locator('.placement-surface')).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(bar).toContainText('page 3 of 3');
    await expect(page.locator('.placement-surface')).toBeVisible();
    // …and a fourth page does not exist, so the control is off rather than a click that does nothing.
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(jobs).toBe(3);

    // The banner is not gone from the tool, it is gone from the **session**: a reload has no document in it, and the
    // state that explains the tool is the state that gets it back. Without this the claim would also pass on a build that
    // simply stopped drawing a banner for these three tools, which is not the change anyone asked for.
    await page.goto('/tools/edit-pdf');
    await expect(hero).toBeVisible();

    //
    // ── Claim 18: the disclosure is never half-drawn ──────────────────────────────────────────────────────────────
    //
    // The `ⓘ` panel hangs **below** its trigger, this trigger is at the foot of the banner, and the panel is therefore
    // drawn outside the banner's own box — which the banner did not allow. `.hero` carries `overflow: hidden` to crop the
    // two blurred blobs it draws behind its corners, and an ancestor that clips does not stop at the element that called
    // it out. Measured at 1440 × 900 before the fix, the panel was 340 × 176 at `574, 278` inside a clip box that ends at
    // 296: the reader saw an 18 px strip of it, and four of the five points inside its own middle answered the prepare
    // card behind it (defect 259). No claim had seen it, because `toBeVisible()` is a question about the *element* and a
    // clipped panel has a box, a size, and a place in the DOM.
    // And the crop did not go with it. The two blobs moved into a box of their own — `.hero-glow`, inset to the banner and
    // clipping — so the banner has nothing else that reaches outside its own box, and its scroll box is exactly its box,
    // where a 320 and a 300 px blob used to make it 99 px taller. Read with the panel shut: the panel is a child of this
    // element now, and an open one is *meant* to hang past its foot.
    const bannerCrop = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>('.tool-hero')!;
      const glow = document.querySelector<HTMLElement>('.tool-hero .hero-glow')!;
      const style = getComputedStyle(banner);
      const box = banner.getBoundingClientRect();
      const inner = {
        left: box.left + Number.parseFloat(style.borderLeftWidth),
        top: box.top + Number.parseFloat(style.borderTopWidth),
        right: box.right - Number.parseFloat(style.borderRightWidth),
        bottom: box.bottom - Number.parseFloat(style.borderBottomWidth),
      };
      const glowBox = glow.getBoundingClientRect();
      return {
        scrollHeight: banner.scrollHeight,
        clientHeight: banner.clientHeight,
        glowIsTheBanner: [
          glowBox.left - inner.left,
          glowBox.top - inner.top,
          glowBox.right - inner.right,
          glowBox.bottom - inner.bottom,
        ].every((edge) => Math.abs(edge) < 1),
      };
    });
    expect(bannerCrop.scrollHeight).toBe(bannerCrop.clientHeight);
    expect(bannerCrop.glowIsTheBanner).toBe(true);

    const bannerTrigger = page.locator('.tool-hero .infotip-trigger');
    await bannerTrigger.click();
    const bannerPanel = page.locator('.tool-hero .infotip-panel');
    await expect(bannerPanel).toBeVisible();
    await expect.poll(async () => (await bannerPanel.boundingBox())!.width).toBeGreaterThan(338);
    const bannerTriggerBox = (await bannerTrigger.boundingBox())!;
    const bannerPanelBox = (await bannerPanel.boundingBox())!;
    // Below its trigger, at the 8 px its stylesheet draws — a direction that only exists if the banner stopped clipping,
    // since its clip box ended 2 px above this trigger's own foot.
    expect(Math.round(bannerPanelBox.y)).toBe(Math.round(bannerTriggerBox.y + bannerTriggerBox.height + 8));
    const bannerHits = await panelHitTests(page, '.tool-hero .infotip-panel');
    expect(bannerHits.hits, bannerHits.detail).toBe(5);
    await page.keyboard.press('Escape');
    await expect(bannerPanel).toHaveCount(0);

    //
    // ── Claim 15, at a phone's width: the panel is clamped to the window ──────────────────────────────────────────
    //
    // A `ⓘ` is anchored to its trigger, and the trigger's position is the caller's business: in the hero's meta row on
    // this screen, at the left edge of a column in the studio. Measured at 390 wide with the panel anchored by its
    // trailing edge, the hero's trigger put the panel at **−199** and the inspector's foot at **−267** — most of the
    // panel off the left of the screen (defect 257). The clamp belongs to `InfoTip` for that reason, and this is its
    // reading, taken on the page the reload above has already left in place: no render is needed to reach a hero.
    await page.setViewportSize({ width: 390, height: 844 });
    const phoneTrigger = page.locator('.tool-hero .infotip-trigger');
    await phoneTrigger.scrollIntoViewIfNeeded();
    await phoneTrigger.click();
    const phonePanel = page.locator('.infotip-panel');
    await expect(phonePanel).toBeVisible();
    const phoneBox = (await phonePanel.boundingBox())!;
    expect(phoneBox.x).toBeGreaterThanOrEqual(16);
    expect(phoneBox.x + phoneBox.width).toBeLessThanOrEqual(390 - 16);

    //
    // ── Claim 17: …and the window's height is the same question asked of the other axis ─────────────────────────
    //
    // The panel is the one opened above and is **not** reopened here: the window under it changed, which is the whole
    // gesture, and a panel the reader has already opened is the one that must not fall through the fold. The hero's `ⓘ`
    // sits at 333, so an 844-tall window leaves 481 px beneath it — more than the 200 a 176 px panel, the 8 px gap and the
    // clamp's own 16 need — and a 500-tall one leaves 137, which is less; there are 333 px above it, which is enough. So
    // the panel is drawn **below** the trigger in the first window and **above** it in the second, and the assertion is
    // that direction rather than the two numbers — the
    // panel's foot is above the trigger's top, 325 against 333: a clamp that only slid a `below` panel back into the window
    // covers its own trigger instead (308 → 484), and one that never measured the axis leaves it where the stylesheet put
    // it — 371 → 547, 47 px through the foot of a 500 px window.
    const heroTriggerBox = (await phoneTrigger.boundingBox())!;
    await page.setViewportSize({ width: 390, height: 500 });
    await expect
      .poll(async () => {
        const b = (await phonePanel.boundingBox())!;
        return Math.round(b.y + b.height);
      })
      .toBeLessThanOrEqual(Math.round(heroTriggerBox.y));
    const shortBox = (await phonePanel.boundingBox())!;
    expect(shortBox.x).toBeGreaterThanOrEqual(16);
    expect(shortBox.x + shortBox.width).toBeLessThanOrEqual(390 - 16);
    expect(shortBox.y).toBeGreaterThanOrEqual(16);
    expect(shortBox.y + shortBox.height).toBeLessThanOrEqual(500 - 16);
    // And the tall window back again puts it back under the trigger, at the 8 px gap its own stylesheet draws it with —
    // which is what "measured against the window it is in now" means as opposed to a correction that was learned once and
    // kept. Read as the gap rather than as a remembered y, because the panel's own opening animation settles a few pixels
    // from where it paints (defect 258), and against the trigger's box rather than a literal.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => Math.round((await phonePanel.boundingBox())!.y))
      .toBe(Math.round(heroTriggerBox.y + heroTriggerBox.height + 8));
  });

  test('undo takes the last gesture back, and redo puts the same one back', async ({ page }) => {
    await openCanvas(page);
    const surface = page.locator('.placement-surface');
    const undoButton = page.getByRole('button', { name: 'Undo' });
    const redoButton = page.getByRole('button', { name: 'Redo' });

    // ── Claim 10: the history is of gestures, and it starts empty ────────────
    // An empty canvas has nothing to take back, and the control says so rather than being a button that does nothing.
    await expect(undoButton).toBeDisabled();
    await expect(redoButton).toBeDisabled();

    // One click on the page places one mark, so that is one gesture — and the whole mark goes away, not part of it.
    // It goes in at the **foot of the page**, and that is part of the reading below rather than a taste in corners: the
    // further down the sheet a mark sits, the larger its own offset is, and the offset is exactly what a drag that
    // re-anchors itself throws the mark by.
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const pageSize = await surface.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    await surface.click({
      position: { x: Math.round(pageSize.width * 0.35), y: Math.round(pageSize.height * 0.8) },
    });
    const mark = page.locator('.placement-mark-text').first();
    await expect(mark).toHaveCount(1);
    await expect(undoButton).toBeEnabled();

    await undoButton.click();
    await expect(page.locator('.placement-mark-text')).toHaveCount(0);
    await expect(page.locator('.placement-row')).toHaveCount(0);
    await expect(redoButton).toBeEnabled();
    await redoButton.click();
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);

    //
    // **A drag is one entry however many pointer moves it is made of — and it follows the pointer in both axes.**
    // Six moves of 20 px each along a diagonal: 16 px across and 12 px up every time, which is 96 px right and 72 px up
    // once they are added up. One undo has to put the box back at the foot of the page where it started; a history that
    // recorded every move would leave it 16 px along, which is the difference between an editor and a slider that keeps
    // sliding.
    //
    // **The vertical leg is the defect's own address.** A drag start measured against the *mark* rather than against
    // the surface puts the start in mark-local pixels while every move stays surface-local, so the first move re-anchors
    // the mark by its own offset (defect 254) — and that offset is a distance down the sheet, so the lower the mark the
    // further it is thrown. On a mark at the foot of the page it is hundreds of pixels: the mark overshoots the hand on
    // both axes and lands against the page's own bottom edge, where `clampBox` holds it. That is the shape the defect
    // was reported in, and it is why the reading is the box's **distance from every edge of the sheet** as well as its
    // travel: a position a hundred pixels out is a wrong number, an edge is where the mark stops being a thing on the
    // page at all.
    //
    // The mark is at the foot of a sheet taller than its own viewport, and the two clicks above are on the bar at the
    // top of the card: bringing *those* into view scrolled the document back to the top and left the mark below the
    // fold — where a press lands on the document and the drag silently does nothing at all (measured: the box did not
    // move a pixel). `page.mouse` is raw input and scrolls nothing, so the foot of the page is brought into view first,
    // which is what the hand does too — and the assertion right after it is there so a mark that is off screen fails
    // as "this mark is not on screen" rather than as a drag that mysteriously travels zero pixels.
    //
    await mark.scrollIntoViewIfNeeded();
    const start = (await mark.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(start.y).toBeGreaterThanOrEqual(0);
    expect(start.y + start.height).toBeLessThanOrEqual(viewport.height);
    const sheet = (await surface.boundingBox())!;
    // It is where it was put: at the foot of the sheet, with the page's bottom edge inside a drag's reach of it.
    expect(start.y - sheet.y).toBeGreaterThan(sheet.height * 0.7);
    expect(sheet.y + sheet.height - (start.y + start.height)).toBeGreaterThan(88);
    const centre = { x: Math.round(start.x + start.width / 2), y: Math.round(start.y + start.height / 2) };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(centre.x + step * 16, centre.y - step * 12);
    }
    await page.mouse.up();
    await expect.poll(async () => (await mark.boundingBox())!.x).toBeGreaterThan(start.x + 60);
    const dragged = (await mark.boundingBox())!;
    //
    // Not thrown to the page's edge, which is the half of the claim that is the user's own sentence: the margin the box
    // keeps from each of the sheet's four edges. A drag that overshot pins it at zero on the edge it overshot towards.
    //
    const edges = [
      dragged.x - sheet.x,
      dragged.y - sheet.y,
      sheet.x + sheet.width - (dragged.x + dragged.width),
      sheet.y + sheet.height - (dragged.y + dragged.height),
    ];
    expect(Math.min(...edges), 'distance from the nearest edge of the page').toBeGreaterThan(16);
    //
    // …and it got there by the hand's own numbers: 96 px across and 72 px up, never more. A drag that re-anchors itself
    // on the first move travels by the mark's own offset instead — hundreds of pixels on both axes from here — and the
    // undo reading below would then be pinned against a gesture nobody made.
    //
    expect(Math.abs(dragged.x - start.x - 96)).toBeLessThan(3);
    expect(Math.abs(dragged.y - start.y + 72)).toBeLessThan(3);
    // One undo, and both axes come back: the entry holds the page as it was rather than a delta that has to be replayed.
    const gapTo = async (target: { x: number; y: number }) => {
      const box = (await mark.boundingBox())!;
      return Math.hypot(box.x - target.x, box.y - target.y);
    };
    await page.keyboard.press('Control+z');
    await expect.poll(() => gapTo(start)).toBeLessThan(1.5);
    // …and redo puts that same drag back rather than replaying a different one.
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => gapTo(dragged)).toBeLessThan(1.5);

    //
    // **A burst of typing is one entry.** The row's `Text` field writes the value per keystroke, so an editor without a
    // burst rule steps back one letter at a time; the assertion is that one Ctrl+Z after a caption is the caption gone.
    // The caption is *typed* rather than `fill`-ed on purpose: `fill` is a single input event, which cannot tell a
    // history that merges a burst from one that takes an entry per keystroke — the claim has to be exercised the way it
    // is stated, or the mutation that removes the burst rule leaves it green.
    //
    await page.locator('#element-0-text').click();
    await page.locator('#element-0-text').pressSequentially('Undo me', { delay: 30 });
    await expect(page.locator('#element-0-text')).toHaveValue('Undo me');
    await page.keyboard.press('Control+z');
    await expect(page.locator('#element-0-text')).toHaveValue('');
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('#element-0-text')).toHaveValue('Undo me');

    //
    // ── And the whole canvas comes back from `Clear all` ────────────────────
    // This is the gesture the defect was reported against: the one control on the screen that can throw a session's work
    // away. What is asserted is the *value*, not the count — the caption comes back with the mark, because the entry
    // holds the array rather than an operation that would have to be undone.
    //
    const xBeforeClear = await page.locator('#element-0-x').inputValue();
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.locator('.placement-mark-text')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);
    await expect(page.locator('#element-0-text')).toHaveValue('Undo me');
    await expect(page.locator('#element-0-x')).toHaveValue(xBeforeClear);

    //
    // ── Claim 11: `Backspace`/`Delete` removes the selected mark, and never a letter being typed ─────
    //
    // The gesture is a click and a key: a mark is a real `<button>`, so clicking one selects it *and* focuses it, which
    // is why the keystroke reaches the canvas at all — asserted, because it is the mechanism and not a detail of the
    // browser (a canvas that only heard keys while its own surface was focused would never hear this one).
    //
    // The reading is the *pair* of behaviours, because either one alone is a defect: a shortcut that cannot delete is
    // not a feature, and a shortcut that deletes from inside a caret is a way to lose work with one keypress. The text
    // field of the row is where the second one would bite — it writes per keystroke — and the page's own field is the
    // other place a caret lives while a mark is selected.
    //
    await mark.click();
    await expect(mark).toBeFocused();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.placement-mark-text')).toHaveCount(0);
    await expect(page.locator('.placement-row')).toHaveCount(0);
    // …and it is one entry, the value rather than the count: the mark comes back with its caption.
    await page.keyboard.press('Control+z');
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);
    await expect(page.locator('#element-0-text')).toHaveValue('Undo me');

    // The guard, and the order matters: the mark is **selected** (the click left it that way) before the caret goes into
    // the field, so a shortcut without the guard would delete it here rather than merely being unable to.
    await mark.click();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    const caption = page.locator('#element-0-text');
    await caption.click();
    await caption.press('Backspace');
    await expect(caption).toHaveValue('Undo m');
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);

    // The page's own field is the other caret, and the same key is a caret there too even though the field is laid over
    // the mark: **one** Backspace empties the draft and the mark is still on the page. One is the number to expect
    // because the field selects its text when it opens (so that a reader can type over it), and a Backspace with the
    // whole draft selected clears it — a keypress that had reached the canvas would have taken the mark instead, which
    // is the reading above it. Escape abandons the draft, so the row's words are the ones the case can assert.
    await mark.click();
    const onPage = page.locator('.placement-text-editor');
    await expect(onPage).toBeVisible();
    await expect(onPage).toHaveValue('Undo m');
    await onPage.press('Backspace');
    await expect(onPage).toHaveValue('');
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);
    await onPage.press('Escape');
    await expect(page.locator('.placement-text-editor')).toHaveCount(0);
    await expect(caption).toHaveValue('Undo m');

    // …and `Delete` is the same shortcut from anywhere, with the same single entry behind it: the mark is still selected
    // after the Escape (closing a field is not deselecting), and nobody's caret is in anything — so the key reaches the
    // canvas from the document, which is the other way a keyboard user gets here.
    await page.keyboard.press('Delete');
    await expect(page.locator('.placement-mark-text')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);
    await expect(page.locator('#element-0-text')).toHaveValue('Undo m');

    //
    // ── Claim 12: a removal pressed **inside a typing burst** is still its own entry ────────────────────
    //
    // The burst rule merges keystrokes 800 ms apart, and the first version of it merged *everything*: a button or a key
    // pressed in that window found a gesture already open and took no entry at all, so the entry the next undo found was
    // the one from before the burst — and the mark came back **without the words typed a moment ago** (defect 256). The
    // reading is that value, and it is deliberately taken with no pointer in between: the caption is typed, the mark is
    // focused (a keyboard reader's own path — `Tab`/`focus`, not a click, so nothing closes the burst), and `Delete`
    // lands about 30 ms after the last keystroke, with the whole 800 ms window still open.
    //
    // `Clear all`, `Remove` and `Add` take the same path (`recordOnce`), which is why one leg is enough — and the drag
    // claim above is the other half of the same rule: a pointer gesture that is open still owns its change, so six
    // pointer moves remain one entry.
    //
    await caption.click();
    await caption.pressSequentially(' in a hurry', { delay: 5 });
    await expect(caption).toHaveValue('Undo m in a hurry');
    await mark.focus();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Delete');
    await expect(page.locator('.placement-mark-text')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.placement-mark-text')).toHaveCount(1);
    await expect(caption).toHaveValue('Undo m in a hurry');

    //
    // ── Claim 13: the canvas has a clipboard, and `Escape` is how a selection lets go ─────────────────────
    //
    // Five gestures that share one guard, and the guard is as much of the claim as the gestures are: **a keystroke that
    // is being typed is not a command.** The reading is taken last, with the caret in the row's field while the
    // clipboard is **not** empty — so a build missing the guard does not merely fail to paste, it *pastes a mark*, which
    // is the difference between a shortcut and a way to add a rectangle while typing a caption.
    //
    // The rest are each one decision the gestures make, and each is a way they could be wrong instead: a paste lands a
    // **fixed screen distance** down-right of its original (12 px, converted through the same `pixelsPerPoint` the drag
    // uses, so it is the same gesture at fit and at 400 % — a share of the page would be invisible in one case and a
    // leap in the other) and arrives **selected**, so the next key acts on what the user just made; the paste is **one
    // entry**, because the action is the paste and not the two writes it is made of; and cut really copies rather than
    // merely deleting, which only the paste that follows it can say.
    //
    await mark.click();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    const original = (await mark.boundingBox())!;
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    const marks = page.locator('.placement-mark-text');
    await expect(marks).toHaveCount(2);
    // The copy is the selection, and it landed a step away rather than on top of what it was copied from.
    await expect(marks.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(marks.nth(0)).toHaveAttribute('aria-pressed', 'false');
    const pasted = (await marks.nth(1).boundingBox())!;
    expect(Math.round(pasted.x - original.x)).toBe(12);
    expect(Math.round(pasted.y - original.y)).toBe(12);
    // …and it carries the words, which is the whole point of copying a caption rather than a rectangle.
    await expect(page.locator('#element-1-text')).toHaveValue('Undo m in a hurry');
    // One entry: one undo takes the whole paste back and leaves the original exactly as it was.
    await page.keyboard.press('Control+z');
    await expect(marks).toHaveCount(1);
    await expect(page.locator('#element-0-text')).toHaveValue('Undo m in a hurry');

    // Duplicate is that gesture in one press.
    await mark.click();
    await page.keyboard.press('Control+d');
    await expect(marks).toHaveCount(2);
    await page.keyboard.press('Control+z');
    await expect(marks).toHaveCount(1);

    // Cut takes the mark **and keeps it**: one entry, and the paste that follows is what says it copied rather than
    // merely deleted — a cut implemented as a removal passes the first two readings and fails this one.
    await mark.click();
    await page.keyboard.press('Control+x');
    await expect(marks).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(marks).toHaveCount(1);
    await expect(page.locator('#element-0-text')).toHaveValue('Undo m in a hurry');
    await page.keyboard.press('Control+v');
    await expect(marks).toHaveCount(2);

    // `Escape` lets go of the selection and touches nothing else: with a mark selected, the count is what proves it.
    await marks.nth(0).click();
    await expect(marks.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(marks).toHaveCount(2);
    await expect(page.locator('.placement-mark-text[aria-pressed="true"]')).toHaveCount(0);

    // The guard, with the clipboard **full** (the cut leg above filled it): the caret in the row's field makes
    // `Ctrl/⌘ + V` text, so the count is the reading — a build without the guard shows a third mark here.
    await caption.click();
    await caption.press('Control+v');
    await expect(marks).toHaveCount(2);
  });

  test('the JSON view costs neither the render nor the session, and takes nothing from the keyboard', async ({
    page,
  }) => {
    await openCanvas(page);
    const surface = page.locator('.placement-surface');

    // A mark, so the session has work in it and the undo stack has an entry. One click places one, which is one gesture.
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await surface.click({ position: { x: 120, y: 150 } });
    const marks = page.locator('.placement-mark-text');
    await expect(marks).toHaveCount(1);

    //
    // From here **no job may be created**: the page on screen is a render of its own (a `pdf-to-images` job), and the
    // claim is that reading the value as text and coming back does not spend a second one. The counter is attached
    // after `openCanvas`'s own render, so it counts exactly the round trip below.
    //
    let jobPosts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/jobs') jobPosts += 1;
    });

    // ── The value, as the text it is ─────────────────────────────────────────
    const json = page.locator('.studio-json textarea');
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    await expect(json).toBeVisible();
    expect(await json.inputValue(), 'the JSON view is not showing the element that is on the page').toContain('"page"');

    // The hidden canvas must not answer the keyboard: this `Ctrl/⌘ + Z` is the textarea's own, and a build without the
    // `active` gate takes the mark away behind the JSON — read below, where the mark is counted again.
    await json.click();
    await page.keyboard.press('Control+z');

    // …and it holds no shell state either: the navigation the canvas hid is back while the drawing is away.
    await expect(page.locator('.shell')).toHaveAttribute('data-drawer', 'false');

    // ── Back, and nothing was spent ──────────────────────────────────────────
    await page.getByRole('button', { name: 'Back to the canvas' }).click();
    await expect(surface).toBeVisible();
    await expect(marks).toHaveCount(1);
    expect(jobPosts, 'the JSON view spent a render getting back').toBe(0);
    await expect(page.locator('.shell')).toHaveAttribute('data-drawer', 'true');

    //
    // **The session came with it.** The history is read as the action it holds: one undo takes back the mark that was
    // placed before the JSON view — which is the entry a remounted canvas would have lost, leaving this assertion with
    // two marks on the page and nothing to take back.
    //
    await page.keyboard.press('Control+z');
    await expect(marks).toHaveCount(0);
    await page.keyboard.press('Control+Shift+z');
    await expect(marks).toHaveCount(1);
  });
});
