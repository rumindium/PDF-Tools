import { PageRangeError, expandPageSpecs } from '@pdftools/contracts/tools';
import { type PageRowsReading, specsFromPages } from '../tool-shell/page-rows-model';

/**
 * Which way each page of a document comes out of `rotate` (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.2).
 *
 * The tool's options are three keys about one fact — `angle` (how much), `pages` (which ones) and `perPage` (each page's
 * own) — and until this module existed the form asked for the third of them as a **JSON box**: `{ "1": 90, "4": 270 }`,
 * typed by hand, on a page that draws the pages it is describing (`0-UI-DESIGN.md` §3.3). The first two were a dropdown
 * and a range box. So the arrangement of a document's rotations was the one thing the screen could not show, and the
 * arithmetic that matters — a rotation is **additive modulo 360** on whatever `/Rotate` the page already carries (§2.2)
 * — was invisible.
 *
 * ## The state is one angle per page
 *
 * Turn — degrees: 0, 90, 180 or 270, one per page, index 0 being page 1:
 *
 * ```text
 * turns:  [90, 90, 180, 0]      // pages 1 and 2 turn a quarter, page 3 half a turn, page 4 stays as it is
 * ```
 *
 * `0` is a real value and it has exactly one source: a page the user **left out of the selection**. It cannot be reached
 * by turning a page, because the tool has no zero angle — `angle`'s three values are the whole vocabulary and the worker
 * adds `+90`, `+180` or `+270` to the page (`workers/light/src/handlers/rotate.ts`). A page whose turns reach 360 that
 * way is the same page; the third click puts it back at 90 rather than pretending a quarter turn can be undone by
 * turning it a fourth time. Which means **the one state this module cannot express is "nothing turns"**, and it says so
 * rather than writing a request that means something else (`rotatePatch` returns `null`) — the API's own default for an
 * empty request is a 90° turn of every page, so a payload that described an upright document would come back rotated.
 *
 * ## A fresh document turns nothing
 *
 * That state is where a form **starts**. A file arriving is not a request: the option's schema default is 90, and a
 * board that drew the schema's default drew every page a quarter turn before the user had asked for anything — the one
 * rotation on the screen that nobody chose, on the one tool whose product *is* the orientation. So the empty option
 * object is drawn as it is: every page upright, the sentence saying no page turns yet, and the job refused until a
 * turn is made (`describeRotate`'s `blocked`, and the Run button's half of it in `routes/tools.$toolId.tsx`). The two
 * directions of a fresh screen are the tile's own `⟲`/`⟳` and the three buttons.
 *
 * ## What is written back
 *
 * Two forms, and the difference is visible in the payload rather than in the output:
 *
 *  - **A uniform angle over exactly the pages that turn** is the documented `angle` + `pages` pair — the option a person
 *    reading the request would have written, and the reason the selection is still worth having: `{ angle: 270, pages:
 *    ['2-4'] }` rather than three lines of a map. The set is written **even when it is the whole document**
 *    (`{ angle: 90, pages: ['1-6'] }`), because it is the value the rows control shows: leaving it out would mean
 *    "every page" and would blank the boxes at the moment the user named the last one.
 *  - **Anything mixed** is `perPage`, which is the exact form: a page absent from the map is untouched, which is what a
 *    `0` means here. `perPage` wins over `angle`/`pages` in the worker (§2.2), so the selection is deliberately not
 *    written beside it — a payload carrying both would be asking for one of them to be ignored.
 */

/** Degrees a page can be turned. `0` means "left as it is" and comes only from the selection. */
export type Turn = 0 | 90 | 180 | 270;

/** The three angles the API accepts, in the order the buttons are drawn. */
export const TURNS: readonly [Turn, Turn, Turn] = [90, 180, 270];

/** The options this module reads. A subset, because it is one tool's surface. */
export interface RotateValues {
  angle?: unknown;
  pages?: unknown;
  perPage?: unknown;
}

function asAngle(value: unknown): Turn | null {
  return value === 90 || value === 180 || value === 270 ? value : null;
}

function asSpecs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The pages the document's own `angle` applies to, as pages this document actually has.
 *
 * An **empty selection is every page** (`null`), which is the API's reading of the absent option
 * (`docs/02-SPLIT-AND-EXTRACT.md` §2) and the reason a fresh form does not need one. A selection this build cannot
 * expand at all — `9-z` on a five-page document, or a token the grammar does not know — is also `null` rather than a
 * guess, because the grammar refuses it outright and the API would too.
 *
 * A page **beyond** the document is the third case and the interesting one: the grammar does *not* clamp (`1-99` expands
 * to 99 pages on a 20-page document "and the caller decides" — `page-ranges.ts`), and 99 of them do not exist, so there
 * is no tile to draw and no page to turn. They are dropped here, so the board draws the pages that do exist, and the
 * request keeps the user's own wording for the worker to answer — `qpdf` reports the page that is not there, which is a
 * better failure than a preview inventing a page.
 */
export function selectionFromOptions(values: RotateValues, pageCount: number | null): number[] | null {
  const total = pageCount != null && pageCount > 0 ? pageCount : 0;
  if (total === 0) return null;
  const specs = asSpecs(values.pages);
  if (specs.length === 0) return null;
  try {
    const pages = [...new Set(expandPageSpecs(specs, total))]
      .filter((page) => page >= 1 && page <= total)
      .sort((a, b) => a - b);
    return pages.length > 0 ? pages : null;
  } catch (cause) {
    if (cause instanceof PageRangeError) return null;
    throw cause;
  }
}

/** Each page's own angle, as the option says it — pages the document does not have are dropped, as the preview does. */
function perPageAngles(value: unknown, total: number): Map<number, Turn> {
  const angles = new Map<number, Turn>();
  if (value == null || typeof value !== 'object') return angles;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const page = Number.parseInt(key, 10);
    const angle = asAngle(raw);
    if (!Number.isInteger(page) || page < 1 || page > total || angle == null) continue;
    angles.set(page, angle);
  }
  return angles;
}

/**
 * The turns the options describe, one per page.
 *
 * `perPage` wins when it is present, because that is what the worker does with it — it takes precedence over `angle` and
 * ignores the selection, and a preview that read it the other way round would draw a document the job does not write.
 * **The empty option object is the one exception**, and it is the form's starting point rather than a reading of the
 * schema: a request that names nothing is *not* an upright document — the schema's `angle` default turns every page a
 * quarter — so `turnsFromOptions` draws it as nothing turning, which the board refuses to send rather than drawing the
 * default it would get (`docs/0-UI-DESIGN.md` §6.5). Everything else keeps the schema's semantics: an `angle` with no
 * `pages` is every page, and a `pages` with no `angle` is those pages at the default 90.
 */
export function turnsFromOptions(values: RotateValues, pageCount: number | null): Turn[] {
  const total = pageCount != null && pageCount > 0 ? pageCount : 0;
  if (total === 0) return [];

  //
  // The **key**, not the usable entries: the worker chooses the per-page branch on `Object.keys(perPage).length > 0`, so a
  // map whose every entry names a page this document does not have still means "per page" — and drawing the default 90
  // for the whole document would be a preview of a job that is not going to run.
  //
  const perPage = perPageAngles(values.perPage, total);
  if (values.perPage != null && typeof values.perPage === 'object' && Object.keys(values.perPage).length > 0) {
    return Array.from({ length: total }, (_, index) => perPage.get(index + 1) ?? 0);
  }

  //
  // Nothing named at all: the form as it opens on a document that has just arrived. It is drawn upright and **not** as
  // the schema's default, because a default drawn is a rotation the user never asked for, and the screen would be
  // showing a job nobody has described yet (`the state a fresh document is in`, above). A request with nothing named in
  // it cannot be sent — `rotatePatch` refuses it and the Run button waits — so the only thing this drawing can be wrong
  // about is a request that is never made.
  //
  if (asAngle(values.angle) == null && asSpecs(values.pages).length === 0) {
    return Array.from({ length: total }, () => 0 as Turn);
  }

  const base = asAngle(values.angle) ?? 90;
  const selection = selectionFromOptions(values, total);
  return Array.from({ length: total }, (_, index) => (selection === null || selection.includes(index + 1) ? base : 0));
}

/** One page's turn, or `0` for a page the document does not have. */
export function turnOf(turns: readonly Turn[], page: number): Turn {
  return turns[page - 1] ?? 0;
}

/**
 * The next turn in one direction, out of the three the tool has.
 *
 * A **three**-cycle, not a four-cycle: `90 → 180 → 270 → 90`. A fourth quarter turn of a page is the page as it was, and
 * the API cannot say that — `angle` has no zero and `+360` is the same as saying nothing — so a cycle that passed
 * through "upright" would offer a state the board could not send. Turning a page back to where it started is the job's
 * *reset*, which is the toolbar's (every page back to the default angle).
 */
export function cycleTurn(turn: Turn, direction: 1 | -1): Turn {
  const index = TURNS.indexOf(turn);
  // A page at `0` (outside the selection) enters the cycle at the first angle, which is the direction's own end.
  if (index < 0) return direction === 1 ? TURNS[0] : TURNS[TURNS.length - 1]!;
  const next = (index + direction + TURNS.length) % TURNS.length;
  return TURNS[next]!;
}

/** The same angle on every page the selection names — what the three toolbar buttons do. */
export function setTurns(turns: readonly Turn[], angle: Turn, pages: number[] | null): Turn[] {
  return turns.map((turn, index) => (pages === null || pages.includes(index + 1) ? angle : turn));
}

/** Every page at one angle — a uniform request as the tiles draw it, and the arrangement the tests build documents from. */
export function uniformTurns(pageCount: number, angle: Turn = 90): Turn[] {
  return Array.from({ length: pageCount }, () => angle);
}

/** The pages that turn at all, ascending — what the board counts and the sentence names. */
export function rotatedPages(turns: readonly Turn[]): number[] {
  return turns.flatMap((turn, index) => (turn === 0 ? [] : [index + 1]));
}

/** The angles in play, smallest first — one angle is the uniform case, more than one is a mixed document. */
export function distinctTurns(turns: readonly Turn[]): Turn[] {
  return [...new Set(turns.filter((turn): turn is 90 | 180 | 270 => turn !== 0))].sort((a, b) => a - b);
}

/**
 * The angle a page joins when it is switched back on: the one the document is mostly turning.
 *
 * A page switched off has no angle of its own left to come back to — `0` means "the request does not mention this page",
 * and nothing in the options remembers what an untouched page looked like a moment ago. So the honest answer is the
 * document's own habit: the single angle in play if there is one, otherwise the most common, and the tool's default when
 * nothing turns at all. Ties go to the smaller angle, so the answer does not depend on the order the pages were clicked.
 */
export function prevailingTurn(turns: readonly Turn[], fallback: Turn = 90): Turn {
  const counts = new Map<Turn, number>();
  for (const turn of turns) if (turn !== 0) counts.set(turn, (counts.get(turn) ?? 0) + 1);
  let best: Turn | null = null;
  let bestCount = 0;
  // Ascending, and only a strictly larger count wins: a tie goes to the smaller angle whichever order the pages came in.
  for (const angle of [...counts.keys()].sort((a, b) => a - b)) {
    const count = counts.get(angle)!;
    if (count > bestCount) {
      best = angle;
      bestCount = count;
    }
  }
  return best ?? fallback;
}

/**
 * One page's own switch, flipped — what a click on its number does.
 *
 * The switch is **"does this page turn at all"**, and the two states are the two things the tile already draws: a page
 * that turns carries an angle, and a page switched off is *left as it is*. Off is the arithmetic's own `0` ("not named
 * by the request"), and on is the document's prevailing angle, because that is the only answer the options can give
 * (`prevailingTurn`).
 *
 * This is the same operation as the toolbar's, aimed at one page, which is why it goes through `setTurns`: the result is
 * an arrangement and is written the way every other arrangement is, by `rotatePatch`. Nothing here writes an option key.
 */
export function toggleTurn(turns: readonly Turn[], page: number, fallback: Turn = 90): Turn[] {
  const current = turnOf(turns, page);
  return setTurns(turns, current === 0 ? prevailingTurn(turns, fallback) : 0, [page]);
}

/**
 * Whether a page's switch can be flipped at all.
 *
 * One page has to turn: the tool has no upright request, so switching the **last** turning page off is the one move that
 * produces nothing a job can send, and a control that accepts a click and does nothing is worse than one that says why
 * (`§the refusal` in `describeRotate`). Which page is the last one is a question about the document, not about the tile.
 */
export function canToggleTurn(turns: readonly Turn[], page: number): boolean {
  const current = turnOf(turns, page);
  if (current === 0) return true;
  return rotatedPages(turns).length > 1;
}

/** How one angle is said, in the words the option's own choices use (`90° clockwise`). */
export function describeTurn(turn: Turn): string {
  if (turn === 0) return 'left as it is';
  if (turn === 90) return '90° clockwise';
  if (turn === 180) return '180°';
  return '90° counter-clockwise';
}

/** How one angle is drawn on a tile: short enough to sit in a badge beside the page number. */
export function turnBadge(turn: Turn): string {
  return turn === 0 ? 'as is' : `${turn}°`;
}

/**
 * The option surface the turns mean, or `null` when they mean nothing this tool can do.
 *
 * The two documented forms, in the order they are tried: pages that share one angle are `{ angle, pages }` — §2.2's own
 * vocabulary, and the form a person would have written by hand — and only a genuinely mixed document is `perPage`, which
 * lists the pages that turn and leaves the rest alone.
 *
 * **`pages` is the pages that turn, not the user's selection, and that is what keeps the screen's two controls one
 * control.** The board draws the turns and the panel shows `pages`; if the payload carried a selection the drawing did
 * not agree with, the box would name pages that visibly do not turn. So the written set is derived from the turns — the
 * same set the tiles are drawn from — and there is no second source of truth to disagree with (`{ angle: 90, pages:
 * ['2-6'] }` after page 1 is switched off).
 *
 * **The form it did not choose is cleared, and that is not tidiness.** `perPage` outranks `angle`/`pages` in the worker
 * (§2.2), so the two forms cannot coexist: with a `perPage` of `{ "3": 180 }` left behind, a later `{ angle: 90 }` —
 * pressing `↻ 90° clockwise` on a document that had been arranged page by page — is written *and ignored*, and the screen
 * goes on drawing the 180° the form still holds. Same in the other direction: an `angle` beside a `perPage` names a
 * selection the request is not going to honour. `undefined` is the clearance, and it is the value this module already
 * reads as absent (`turnsFromOptions`), so what the option object says is exactly which one of the two forms is live.
 *
 * `null` is the one refusal, and it is not defensive: `turns` of all zeros means "no page turns", and the API's smallest
 * request is one 90° turn — an empty request is *not* it, it is the schema's default applied to every page, so writing
 * something would rotate a document the preview draws upright. The board says so in the worker's own terms instead.
 */
export function rotatePatch(turns: readonly Turn[]): Record<string, unknown> | null {
  const rotated = rotatedPages(turns);
  if (rotated.length === 0) return null;

  const angles = distinctTurns(turns);
  const uniform = angles.length === 1 ? angles[0]! : null;
  if (uniform != null) {
    //
    // The angle and the pages it covers, **always both**. An absent `pages` reads as "every page" to the API, so leaving
    // it out when every page turns would be a shorter request that means the same thing — and it would also empty the
    // rows control, which shows this value: naming the last page of a document would delete the boxes just named and
    // leave the user with nothing to look at. `['1-6']` is one run, not six tokens (`specsFromPages`).
    //
    return { angle: uniform, pages: specsFromPages(rotated), perPage: undefined };
  }

  const perPage: Record<string, number> = {};
  for (const page of rotated) perPage[String(page)] = turns[page - 1]!;
  return { angle: undefined, pages: undefined, perPage };
}

/**
 * The request that asks for **nothing turned** — what `Reset all` writes, and the only form that means "every page as it
 * is".
 *
 * The tool cannot *send* it: `rotatePatch` refuses the all-zero arrangement, because an empty request is the schema's
 * default, which turns every page a quarter. That is a reason for the board to refuse a **job**, not for the button to be
 * unable to say what it means — so this is the option object the form *opens* with, and writing it puts the board back
 * exactly where a document that has just arrived puts it: every page as it came in, the sentence saying what turns it, and
 * Run waiting for a turn that is worth sending.
 *
 * It used to be `uniformTurns(n, 90)`, and the defect was the name rather than the arithmetic: `Reset all` returned the
 * document to *a quarter turn of every page*, which is an arrangement nobody asked for arriving from the one control whose
 * name promises the opposite.
 *
 * All three keys are written **explicitly as `undefined`** rather than left out, because this is applied by merging
 * (`{ ...current, ...patch }`, `routes/tools.$toolId.tsx`): a key left out would keep the last arrangement's value, and a
 * stale `perPage` outranks the cleared `angle` in the worker, so the reset would visibly do nothing.
 */
export function clearedRotation(): Record<string, unknown> {
  return { angle: undefined, pages: undefined, perPage: undefined };
}

/**
 * The arrangement as the rows control **reads** it while the map is live — one row per run of pages that turn one way.
 *
 * In a mixed document `rotatePatch` deliberately clears `pages`, because the two forms cannot coexist: the map outranks
 * the selection in the worker, which ignores a selection written beside it and reports `PAGES_IGNORED`. So there is no
 * selection for the boxes to hold — and until this existed the control emptied itself mid-session, under a sentence about
 * the wrong document ("with no pages named the rotation covers every page") and beside rows that would have accepted a
 * keystroke nothing reads. The third answer is the one the board owes a reader: keep the rows, and have them say what
 * the request actually is.
 *
 * The reading is the arrangement's own arithmetic run the other way. **A run is consecutive pages that turn the same
 * way** — a page left as it is ends the run, because the map omits it, and so does a change of angle — and each row is
 * spelled the way the grammar spells a set of pages (`specsFromPages`: `1-2`, never `1-2` twice) with the angle in the
 * words the buttons and the tiles already use (`describeTurn`). The sentence says what the list is, why the boxes are
 * not above it, and what brings them back.
 */
export function turnsReading(turns: readonly Turn[]): PageRowsReading {
  const runs: { pages: number[]; angle: Turn }[] = [];
  turns.forEach((turn, index) => {
    if (turn === 0) return;
    const page = index + 1;
    const last = runs[runs.length - 1];
    if (last && last.angle === turn && last.pages[last.pages.length - 1] === page - 1) last.pages.push(page);
    else runs.push({ pages: [page], angle: turn });
  });

  const untouched = turns.length - rotatedPages(turns).length;
  //
  // The clause about the pages that are *not* listed is the map's own semantics, said out loud: `perPage` names the pages
  // that turn and says nothing about the rest, which come back carrying the `/Rotate` they already had — the distinction
  // `describeSelection` makes for this direction (`features/tool-shell/page-rows-model.ts`).
  //
  const untouchedClause =
    untouched === 0
      ? ''
      : untouched === 1
        ? ' — the page not listed keeps the rotation it already carries'
        : ` — the ${untouched} pages not listed keep the rotation they already carry`;

  return {
    rows: runs.map((run) => ({ spec: specsFromPages(run.pages)[0]!, note: describeTurn(run.angle) })),
    sentence: `Read from the arrangement, not typed into it: these pages turn one way each, so this request is a map of page → angle rather than one set of pages${untouchedClause}. Turn every page one way with a rotation button below and the boxes come back.`,
  };
}

/**
 * Whether the board has nothing a job could be asked for yet — the state **the Run button waits out**.
 *
 * It is `rotatePatch` of the drawing and nothing else, which is the point: the footer's warning and the button's
 * `disabled` are the same question asked once (`routes/tools.$toolId.tsx`), so a screen that says "cannot be sent as it
 * stands" cannot offer to send it. A form with a document and nothing turned is where every visit to this tool starts.
 */
export function rotateIdle(values: RotateValues, pageCount: number | null): boolean {
  return rotatePatch(turnsFromOptions(values, pageCount)) == null;
}

/**
 * The sentence under the board: what the document will come out as, in one line.
 *
 * It is the *angles*, not the options: `4 pages turn 90° clockwise, page 3 turns 180°` is a sentence about the document
 * on screen, and `angle: 90, pages: 1-4` is a sentence about a request. The refusal has its own sentence, in the words
 * the worker would use — a preview that drew an upright document and sent a 90° turn is the one failure this whole
 * screen exists to prevent.
 */
export function describeRotate(turns: readonly Turn[]): { sentence: string; tone: 'none' | 'changed' | 'blocked' } {
  if (turns.length === 0)
    return { sentence: 'Waiting for the page count before the pages can be drawn.', tone: 'none' };
  const rotated = rotatedPages(turns);
  if (rotated.length === 0) {
    return {
      //
      // The one refusal, and the sentence is written as what to **do** rather than as what is missing: this is the state
      // a document arrives in, so it is the first thing a user reads on this screen, and "no way to ask for an upright
      // document" on its own explains a rule without offering a move. The rule still has to be there, in the worker's
      // own vocabulary — it is why the board cannot simply send an empty request and be done.
      //
      sentence:
        'Nothing turns yet: use ⟲ or ⟳ on a page, or turn them all with a rotation button below. This tool always turns at least one page — a rotation is 90°, 180° or 270° — so there is no way to ask for an upright document here.',
      tone: 'blocked',
    };
  }

  const angles = distinctTurns(turns);
  const untouched = turns.length - rotated.length;
  if (angles.length === 1) {
    const angle = angles[0]!;
    const all = rotated.length === turns.length;
    const subject = all ? 'Every page' : `${rotated.length} of ${turns.length} pages`;
    const passes = all ? 'turns' : 'turn';
    return {
      sentence: `${subject} ${passes} ${describeTurn(angle)}${
        untouched > 0 ? ` — ${untouched} left as ${untouched === 1 ? 'it is' : 'they are'}` : ''
      }.`,
      tone: 'changed',
    };
  }

  const counts = new Map<Turn, number>();
  for (const page of rotated) counts.set(turns[page - 1]!, (counts.get(turns[page - 1]!) ?? 0) + 1);
  const parts = [...counts.entries()].map(([angle, count]) => `${count} ${describeTurn(angle)}`);
  return {
    sentence: `Mixed rotation: ${parts.join(', ')}${untouched > 0 ? `, ${untouched} left as they are` : ''}.`,
    tone: 'changed',
  };
}
