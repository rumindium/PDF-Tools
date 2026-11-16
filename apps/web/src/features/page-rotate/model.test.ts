import { describe, expect, test } from 'bun:test';
import {
  type Turn,
  canToggleTurn,
  clearedRotation,
  cycleTurn,
  describeRotate,
  describeTurn,
  distinctTurns,
  prevailingTurn,
  rotateIdle,
  rotatePatch,
  rotatedPages,
  selectionFromOptions,
  setTurns,
  toggleTurn,
  turnBadge,
  turnOf,
  turnsFromOptions,
  turnsReading,
  uniformTurns,
} from './model';

/**
 * Which way each page of a document comes out (`features/page-rotate/model.ts`, `docs/03-ORGANIZE-ROTATE-CROP.md` §2.2).
 *
 * Two properties are being defended, and both fail silently in production:
 *
 *  - **The board and the payload mean the same document.** The turns are what is drawn and the patch is what is sent;
 *    a translation that disagrees produces a preview of a job nobody gets, which is what the JSON box it replaced made
 *    impossible to notice.
 *  - **The one unexpressible state is refused rather than approximated.** "No page turns" is not an empty request — the
 *    schema's default turns every page 90 — so a model that wrote *something* for it would rotate a document it had
 *    just drawn upright. That state is where a form **starts**, and the two halves of it are tested here: the drawing
 *    (upright, because nothing was asked for) and the refusal the Run button is wired to (`rotateIdle`).
 */

function turns(spec: number[]): Turn[] {
  return spec as Turn[];
}

describe('the turns the options describe', () => {
  test('a document that has just arrived turns nothing', () => {
    //
    // The schema's `angle` default is 90 and this form deliberately does **not** draw it: a default drawn is a rotation
    // nobody asked for, on the one screen whose whole product is the orientation. The catalogue says the same thing from
    // the other side by giving `angle` no `default` (`packages/contracts/src/tools/catalog.ts`), so `{}` here is
    // literally the state the form opens in — and it is refused rather than sent (`rotateIdle`, below), because an
    // empty request is not an upright document: it is the schema's default applied to every page.
    //
    expect(turnsFromOptions({}, 4)).toEqual(turns([0, 0, 0, 0]));
    // Before the page count arrives there is nothing to draw, and an empty board is the honest drawing of that.
    expect(turnsFromOptions({}, null)).toEqual([]);
    expect(turnsFromOptions({}, 0)).toEqual([]);
  });

  test('once something is named, the schema’s own reading is kept', () => {
    // An `angle` with no pages is every page.
    expect(turnsFromOptions({ angle: 180 }, 3)).toEqual(turns([180, 180, 180]));
    // And the pair's other half: `angle` defaults to 90, so naming pages with no angle is a quarter turn of **them** —
    // which is what the rows control in the panel writes, and what the worker would do with the same value. Drawing
    // that upright would be a preview of a job nobody gets; the empty request above is the one thing that is refused.
    expect(turnsFromOptions({ pages: ['2-4'] }, 4)).toEqual(turns([0, 90, 90, 90]));
  });

  test('a selection is the pages that turn, and the rest are untouched', () => {
    expect(turnsFromOptions({ angle: 270, pages: ['2'] }, 4)).toEqual(turns([0, 270, 0, 0]));
    expect(turnsFromOptions({ angle: 180, pages: ['1-2', '4'] }, 4)).toEqual(turns([180, 180, 0, 180]));
    // An empty selection is every page — the API's reading of the absent option, not "none of them".
    expect(turnsFromOptions({ angle: 90, pages: [] }, 2)).toEqual(turns([90, 90]));
  });

  test('`perPage` wins, because that is what the worker does with it', () => {
    // §2.2: `perPage` takes precedence over `angle`/`pages`, and the ignored selection is reported as `PAGES_IGNORED`.
    // Reading it the other way round would draw page 1 turning 90 when the job leaves it alone.
    expect(turnsFromOptions({ perPage: { 2: 180, 5: 270 }, pages: ['1'] }, 6)).toEqual(turns([0, 180, 0, 0, 270, 0]));
    expect(turnsFromOptions({ angle: 90, perPage: { 3: 90 } }, 3)).toEqual(turns([0, 0, 90]));
  });

  test('a page the document does not have has no tile, and a value the schema cannot accept is ignored', () => {
    // The map still means "per page" — that is what the worker decides on, by the presence of keys — but page 9 of a
    // three-page document cannot be drawn, and a 45° angle is not one of the three the schema takes.
    expect(turnsFromOptions({ perPage: { 9: 90 } }, 3)).toEqual(turns([0, 0, 0]));
    expect(turnsFromOptions({ perPage: { 2: 45 } }, 3)).toEqual(turns([0, 0, 0]));
    expect(turnsFromOptions({ perPage: { abc: 90 } }, 3)).toEqual(turns([0, 0, 0]));
  });

  test('a selection is the pages that exist, and a spec the grammar refuses is every page', () => {
    // A page beyond the document is dropped rather than drawn: the grammar does not clamp (`1-99` expands to 99 on a
    // twenty-page file and "the caller decides"), the grid has no tile for page 9 of six, and the request keeps the
    // user's own wording for `qpdf` to answer.
    expect(selectionFromOptions({ pages: ['9'] }, 6)).toBeNull();
    expect(selectionFromOptions({ pages: ['2-9'] }, 6)).toEqual([2, 3, 4, 5, 6]);
    expect(selectionFromOptions({ pages: ['nonsense'] }, 6)).toBeNull();
    expect(selectionFromOptions({ pages: ['9-z'] }, 6)).toBeNull();
    expect(selectionFromOptions({ pages: ['2-3'] }, 6)).toEqual([2, 3]);
    expect(selectionFromOptions({ pages: ['1-z'] }, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    // A bare `z` is not a spec the grammar knows (`page-ranges.ts`: `N-z` needs its `N`), so it is refused like any other
    // unknown token rather than read as "every page".
    expect(selectionFromOptions({ pages: ['z'] }, 6)).toBeNull();
    expect(selectionFromOptions({}, 6)).toBeNull();
  });
});

describe('turning one page', () => {
  test('the cycle is the three angles the tool has, in both directions', () => {
    expect(cycleTurn(90, 1)).toBe(180);
    expect(cycleTurn(180, 1)).toBe(270);
    // The fourth quarter turn is the page as it was, which this tool cannot ask for: the cycle closes on 90.
    expect(cycleTurn(270, 1)).toBe(90);
    expect(cycleTurn(90, -1)).toBe(270);
    expect(cycleTurn(270, -1)).toBe(180);
  });

  test('a page outside the selection joins the cycle at its own end', () => {
    // `0` is "no turn" for a page the selection left out; the first click has to move it somewhere.
    expect(cycleTurn(0, 1)).toBe(90);
    expect(cycleTurn(0, -1)).toBe(270);
  });

  test('turning a page changes that page and nothing else', () => {
    const before = turns([90, 90, 90, 90]);
    const after = setTurns(before, 180, [3]);
    expect(after).toEqual(turns([90, 90, 180, 90]));
    expect(setTurns(before, 270, null)).toEqual(turns([270, 270, 270, 270]));
    expect(turnOf(after, 3)).toBe(180);
    expect(turnOf(after, 9)).toBe(0);
  });

  test('the facts the board states', () => {
    expect(uniformTurns(3)).toEqual(turns([90, 90, 90]));
    expect(rotatedPages(turns([0, 90, 0, 270]))).toEqual([2, 4]);
    expect(distinctTurns(turns([90, 180, 90, 0]))).toEqual([90, 180]);
    expect(turnBadge(0)).toBe('as is');
    expect(turnBadge(270)).toBe('270°');
    expect(describeTurn(270)).toBe('90° counter-clockwise');
  });
});

describe('the request the turns mean', () => {
  //
  // `toStrictEqual` throughout, and the cleared keys are the assertion: `toEqual` ignores properties that are
  // `undefined`, which is precisely the difference between "this patch leaves `perPage` behind" and "this patch is the
  // whole option surface". The comment above each expectation says which form is live.
  //
  test('every page at one angle is the `angle` option plus the pages it covers', () => {
    //
    // The set is written even when it is the whole document, and that is a change of mind rather than an oversight: an
    // absent `pages` means the same thing to the API ("every page"), so leaving it out was the shorter request — but it
    // is also the value the panel's rows control renders, and a value of "nothing named" would delete the boxes at the
    // moment the user named the last page of the document. The written set is the pages that turn, in both cases.
    //
    expect(rotatePatch(turns([90, 90, 90]))).toStrictEqual({ angle: 90, pages: ['1-3'], perPage: undefined });
    expect(rotatePatch(uniformTurns(4, 270))).toStrictEqual({
      angle: 270,
      pages: ['1-4'],
      perPage: undefined,
    });
  });

  test('a uniform angle on the pages that turn is `angle` + `pages`', () => {
    // The documented pair, and the form a person would have written by hand: the same output as three lines of a map, in
    // the vocabulary the document and the API use.
    expect(rotatePatch(turns([0, 270, 270, 0]))).toStrictEqual({
      angle: 270,
      pages: ['2-3'],
      perPage: undefined,
    });
    expect(rotatePatch(turns([90, 0, 0]))).toStrictEqual({ angle: 90, pages: ['1'], perPage: undefined });
    // Contiguous pages come back as a range, not as a list of one-number ranges.
    expect(rotatePatch(turns([0, 90, 90, 90, 0, 0]))).toStrictEqual({
      angle: 90,
      pages: ['2-4'],
      perPage: undefined,
    });
  });

  test('the written set is the pages that turn, never a selection that disagrees with them', () => {
    //
    // The panel's box and the board's tiles are one value with two controls, so the payload follows the **drawing**: the
    // set is derived from the turns and never taken from the caller. A patch that carried a selection the tiles did not
    // agree with would name pages that visibly do not turn — the state a click on a tile outside the selection used to
    // leave behind, where the payload turned a page the preview drew upright.
    //
    expect(rotatePatch(turns([0, 90, 0, 0]))).toStrictEqual({ angle: 90, pages: ['2'], perPage: undefined });
    expect(rotatePatch(turns([0, 90, 90, 0]))).toStrictEqual({ angle: 90, pages: ['2-3'], perPage: undefined });
  });

  test('anything mixed is `perPage`, and only the pages that turn are in it', () => {
    // A page absent from the map is untouched, which is what a `0` means on the board — so a mixed document needs no
    // entry for the pages it leaves alone. `angle` and `pages` are cleared, because the worker ignores them the moment
    // `perPage` is there (§2.2) and a box shown beside it would be naming a value the request does not use.
    expect(rotatePatch(turns([90, 90, 180, 0]))).toStrictEqual({
      angle: undefined,
      pages: undefined,
      perPage: { 1: 90, 2: 90, 3: 180 },
    });
    expect(rotatePatch(turns([270, 90, 0]))).toStrictEqual({
      angle: undefined,
      pages: undefined,
      perPage: { 1: 270, 2: 90 },
    });
  });

  test('a write supersedes the form it replaces', () => {
    //
    // The defect this test exists for, found in the browser (row 3 turned to 180°, then two anticlockwise clicks, and the
    // page stayed at 180). The board merges each patch into the option object, so a patch that is only the keys it uses
    // leaves the other form standing — and `perPage` outranks `angle`, so `↻ 90° clockwise` on a document arranged page by
    // page would be written and ignored for as long as the stale map existed.
    //
    // The merge is the app's own (`{ ...current, ...patch }`, `tools.$toolId.tsx`), reproduced here because the property
    // belongs to the patch and not to the caller.
    //
    const values: Record<string, unknown> = {};
    Object.assign(values, rotatePatch(turns([90, 90, 180])));
    expect(values.perPage).toStrictEqual({ 1: 90, 2: 90, 3: 180 });

    // The whole document back to one angle, the way `Reset all` writes it: only `angle` survives, and the board reads
    // back the state it just drew rather than the map the old form left behind.
    Object.assign(values, rotatePatch(uniformTurns(3, 90)));
    expect(values).toStrictEqual({ angle: 90, pages: ['1-3'], perPage: undefined });
    expect(turnsFromOptions(values, 3)).toEqual(turns([90, 90, 90]));

    // And the other way: a map that a later pair must not survive underneath.
    expect(values.perPage).toBeUndefined();
  });

  test('`Reset all` writes the absence of a request, which is the only form that means "as is"', () => {
    //
    // The reset button used to mean "every page a quarter turn clockwise" — the schema's default applied to the whole
    // document — so the one control whose name promises to undo an arrangement was itself an arrangement nobody asked for.
    // What it writes now is the option object the form *opens* with, and the board draws that exactly as a document that
    // has just arrived: every page as it came in, the sentence saying what turns it, and Run waiting.
    //
    // The merge is the app's own (`{ ...current, ...patch }`, `tools.$toolId.tsx`) and every value is `undefined` on its
    // own key rather than missing, which is what makes the merge a *clearance*: a key left out would keep the last
    // arrangement's value, and a stale `perPage` outranks the cleared `angle` in the worker.
    //
    const values: Record<string, unknown> = { angle: 180, pages: ['2-3'], perPage: { 2: 90 } };
    Object.assign(values, clearedRotation());
    expect(values).toStrictEqual({ angle: undefined, pages: undefined, perPage: undefined });
    expect(turnsFromOptions(values, 3)).toEqual(turns([0, 0, 0]));
    // And the two consequences on screen: nothing can be sent, and the board says why rather than drawing a default.
    expect(rotatePatch(turnsFromOptions(values, 3))).toBeNull();
    expect(rotateIdle(values, 3)).toBe(true);
    expect(describeRotate(turnsFromOptions(values, 3)).tone).toBe('blocked');
  });

  test('nothing turning is refused rather than approximated', () => {
    // The one unexpressible state. An empty request is *not* "no rotation" — it is the schema's default, which turns
    // every page 90 — so writing anything here would rotate a document drawn upright.
    expect(rotatePatch(turns([0, 0, 0]))).toBeNull();
    expect(rotatePatch([])).toBeNull();
  });

  test('the state the Run button waits out is the state the board refuses', () => {
    //
    // One predicate, two places: the footer warning is `describeRotate(...).tone === 'blocked'` and the button's
    // `disabled` is this, and both are `rotatePatch` of the same drawing. A fresh form is where every visit starts, so
    // the pair is checked in both directions rather than only where it is interesting — «refused, and the button knows»,
    // then «named, and it does not».
    //
    expect(rotateIdle({}, 6)).toBe(true);
    expect(rotateIdle({ perPage: {} }, 6)).toBe(true);
    expect(rotateIdle({}, null)).toBe(true);
    expect(rotateIdle({ pages: ['2-4'] }, 6)).toBe(false);
    expect(rotateIdle({ angle: 90 }, 6)).toBe(false);
    // And the board that has just drawn the first turn is not idle any more: the same values the click wrote.
    expect(rotateIdle(rotatePatch(turns([90, 0, 0]))!, 3)).toBe(false);
  });

  test('the round trip is the identity for every state the board can reach', () => {
    const cases: Turn[][] = [
      turns([90, 90, 90]),
      turns([0, 270, 0]),
      turns([90, 180, 0, 270]),
      turns([0, 0, 90]),
      turns([270, 0, 270, 90, 0]),
    ];
    for (const state of cases) {
      const patch = rotatePatch(state);
      expect(patch).not.toBeNull();
      // Written and read back: the request describes the document on screen, both forms.
      expect(turnsFromOptions(patch!, state.length)).toEqual(state);
    }
  });
});

describe('a page’s own switch', () => {
  test('off is "left as it is", which is the arithmetic’s own zero', () => {
    expect(toggleTurn(turns([90, 90, 90]), 2)).toEqual(turns([90, 0, 90]));
    // The sentence follows, because the drawing and the sentence are both read off the same state.
    expect(describeRotate(toggleTurn(turns([90, 90, 90]), 2)).sentence).toBe(
      '2 of 3 pages turn 90° clockwise — 1 left as it is.',
    );
  });

  test('back on is the angle the document is already using', () => {
    // The round trip a person expects from a switch: off and on again is where it started.
    expect(toggleTurn(toggleTurn(turns([90, 90, 90]), 2), 2)).toEqual(turns([90, 90, 90]));
    // A mixed document joins its most common angle, and a tie goes to the smaller one whatever order the pages were
    // clicked in — an answer that depended on click order would be a bug nobody could reproduce.
    expect(prevailingTurn(turns([0, 90, 90, 180]))).toBe(90);
    expect(prevailingTurn(turns([0, 180, 270]))).toBe(180);
    expect(prevailingTurn(turns([270, 270, 90]))).toBe(270);
    expect(prevailingTurn(turns([270, 180, 180, 270]))).toBe(180);
    // Nothing turning at all: the tool's default, which is the angle a fresh form shows.
    expect(prevailingTurn(turns([0, 0]))).toBe(90);
    expect(toggleTurn(turns([0, 0, 0]), 1)).toEqual(turns([90, 0, 0]));
  });

  test('the last turning page cannot be switched off, and says so', () => {
    // The one move that produces nothing a job can send: the API's smallest request is a single 90° turn.
    expect(canToggleTurn(turns([0, 90, 0]), 2)).toBe(false);
    expect(canToggleTurn(turns([90, 90, 0]), 1)).toBe(true);
    // A page that is already off can always come back, because that direction cannot empty the request.
    expect(canToggleTurn(turns([0, 90, 0]), 1)).toBe(true);
  });

  test('switching pages off writes a request that means what the board draws', () => {
    // The real sequence the screen performs, merge and all: click page 1, then 2, then 4, so only page 3 turns. Each
    // click goes through the arrangement, so nothing here writes an option key by hand.
    const values: Record<string, unknown> = {};
    let state = turns([90, 90, 90, 90]);
    for (const page of [1, 2, 4]) {
      state = toggleTurn(state, page);
      Object.assign(values, rotatePatch(state)!);
    }
    expect(state).toEqual(turns([0, 0, 90, 0]));
    // Three pages left as they are and one turning at one angle: still the documented pair, and `pages` is `3` — the same
    // value the panel's box shows, which is the point of deriving it from the turns instead of taking a selection.
    expect(values).toStrictEqual({ angle: 90, pages: ['3'], perPage: undefined });
    // The board reads its own write back: the drawing does not change under the click that made it.
    expect(turnsFromOptions(values, 4)).toEqual(state);
  });
});

/**
 * The state the boxes cannot hold: a mixed arrangement is a `perPage` map, so `pages` is cleared and the rows control
 * has no selection to collect (`turnsReading`, `docs/0-UI-DESIGN.md` §6.5).
 *
 * What is defended here is that the **reading and the map agree**: one row per run of pages that turn one way, spelled
 * the way the grammar spells a set, in the words the tiles use — because the alternative that was on screen was an empty
 * set of boxes with a sentence about a document nobody had asked for. The falsification is the run boundaries: a page
 * left out, or a change of angle, has to end the row it would otherwise be joined to.
 */
describe('the arrangement the rows read while the map is live', () => {
  test('one row per run of pages that turn the same way', () => {
    // The screen's own sequence: every page at 90 with page 3 turned the other way. Three runs, and the middle one is
    // the page the user turned — which is the whole reason the rows are worth keeping in this state.
    const reading = turnsReading(turns([90, 90, 270, 90, 90, 90]));
    expect(reading.rows).toEqual([
      { spec: '1-2', note: '90° clockwise' },
      { spec: '3', note: '90° counter-clockwise' },
      { spec: '4-6', note: '90° clockwise' },
    ]);
    expect(reading.sentence).toBe(
      'Read from the arrangement, not typed into it: these pages turn one way each, so this request is a map of ' +
        'page → angle rather than one set of pages. Turn every page one way with a rotation button below and the boxes ' +
        'come back.',
    );
    // The run is the grammar's spelling of a set — never `1-2` twice and never `4-4`.
    expect(reading.rows.map((row) => row.spec)).toEqual(['1-2', '3', '4-6']);
  });

  test('a page left out ends the run, because the map omits it', () => {
    // Pages 1 and 3 turn the same way and are **not** one row: the map has an entry per page, and page 2 is not in it.
    const reading = turnsReading(turns([90, 0, 90, 180]));
    expect(reading.rows).toEqual([
      { spec: '1', note: '90° clockwise' },
      { spec: '3', note: '90° clockwise' },
      { spec: '4', note: '180°' },
    ]);
    // And what the map does to the page it does not name is said out loud, in the direction's own vocabulary.
    expect(reading.sentence).toContain('the page not listed keeps the rotation it already carries');
    expect(turnsReading(turns([90, 90, 0, 0])).sentence).toContain(
      'the 2 pages not listed keep the rotation they already carry',
    );
  });

  test('the runs are read off the drawing, so two readers cannot disagree', () => {
    // The reading is the turns array walked once, and the map `rotatePatch` writes is the same pages one entry at a
    // time — so on a mixed document the rows and the request cannot be describing different page sets. The uniform
    // states are in here too, because `turnsReading` is a reading of the arrangement and not of the form it took.
    for (const state of [turns([0, 90, 0]), turns([270, 270]), turns([90, 180, 270]), turns([0, 0, 90, 90, 180])]) {
      const reading = turnsReading(state);
      const pages = reading.rows.flatMap((row) => {
        const [from, to] = row.spec.split('-');
        const start = Number(from);
        const end = Number(to ?? from);
        return Array.from({ length: end - start + 1 }, (_, index) => start + index);
      });
      expect(pages).toEqual(rotatedPages(state));
      const map = rotatePatch(state)?.perPage as Record<string, number> | undefined;
      if (map != null)
        expect(
          Object.keys(map)
            .map(Number)
            .sort((a, b) => a - b),
        ).toEqual(pages);
    }
  });
});

describe('the sentence under the board', () => {
  test('one angle, and how many pages it covers', () => {
    expect(describeRotate(turns([90, 90, 90])).sentence).toBe('Every page turns 90° clockwise.');
    expect(describeRotate(turns([0, 270, 0])).sentence).toBe(
      '1 of 3 pages turn 90° counter-clockwise — 2 left as they are.',
    );
    expect(describeRotate(turns([180, 0])).sentence).toBe('1 of 2 pages turn 180° — 1 left as it is.');
  });

  test('a mixed document counts each angle', () => {
    expect(describeRotate(turns([90, 90, 180])).sentence).toBe('Mixed rotation: 2 90° clockwise, 1 180°.');
    expect(describeRotate(turns([90, 0, 270])).tone).toBe('changed');
  });

  test('the refusal names the tool’s own vocabulary', () => {
    const refused = describeRotate(turns([0, 0]));
    expect(refused.tone).toBe('blocked');
    expect(refused.sentence).toContain('90°, 180° or 270°');
    expect(describeRotate([]).tone).toBe('none');
  });
});
