import { describe, expect, test } from 'bun:test';
import {
  type Box,
  DEFAULT_SIZE_POINTS,
  type DisplayGeometry,
  MIN_BOX_POINTS,
  type PlacementElement,
  boundsOfPoints,
  boxFromDisplay,
  centredBox,
  clampBox,
  displayRectFromBox,
  elementBox,
  estimateTextWidth,
  newElement,
  normaliseDraggedBox,
  pageSizeFromPixels,
  pixelsPerPoint,
  placeElement,
  readElements,
  textBaselineDropEm,
  textFace,
  textWidthPoints,
} from './geometry';

/**
 * The geometry the placement canvas is built on, tested in the directions that are easy to get backwards.
 *
 * These assertions exist because the failure they cover is **silent**: a flipped `y` produces a valid job, a valid
 * output, and a mark in the wrong place. Nothing downstream can notice, so the arithmetic is pinned here instead.
 *
 * The page is A4 at 96 dpi — 595.28 × 841.89 pt, which renders to 794 × 1123 px — because those are the numbers the
 * canvas really sees and because 96 dpi makes the third conversion factor (px → pt) exactly 0.75.
 */

const DPI = 96;
const A4 = pageSizeFromPixels({ width: 794, height: 1123 }, DPI);
const GEOMETRY: DisplayGeometry = { scale: 1, dpi: DPI, page: A4 };

describe('page size from a rendered image', () => {
  test('an A4 page rendered at 96 dpi comes back as A4 in points', () => {
    expect(A4.widthPt).toBeCloseTo(595.5, 1);
    expect(A4.heightPt).toBeCloseTo(842.25, 1);
  });

  test('the same page rendered at 300 dpi is the same page', () => {
    const at300 = pageSizeFromPixels({ width: 2480, height: 3508 }, 300);
    expect(at300.widthPt).toBeCloseTo(595.2, 1);
    expect(at300.heightPt).toBeCloseTo(841.9, 1);
  });

  test('one CSS pixel at scale 1 and 96 dpi is three quarters of a point', () => {
    expect(pixelsPerPoint(GEOMETRY)).toBeCloseTo(4 / 3, 10);
    expect(boxFromDisplay({ left: 96, top: 0, width: 96, height: 0 }, GEOMETRY).width).toBeCloseTo(72, 6);
  });
});

describe('a drag on the page becomes a box in PDF user space', () => {
  test('the top of the display is the top of the page, not the bottom', () => {
    // The flip. A rect whose top edge sits on the image's top edge must come back at the page's *top*, which is
    // `heightPt` in a system whose origin is the bottom-left corner.
    const box = boxFromDisplay({ left: 0, top: 0, width: 96, height: 96 }, GEOMETRY);
    expect(box.y + box.height).toBeCloseTo(A4.heightPt, 6);
    expect(box.y).toBeCloseTo(A4.heightPt - 72, 6);
  });

  test('the bottom of the display is y = 0', () => {
    const box = boxFromDisplay({ left: 0, top: 1123 - 96, width: 96, height: 96 }, GEOMETRY);
    expect(box.y).toBeCloseTo(0, 6);
  });

  test('and the round trip returns the rect it started from', () => {
    const rect = { left: 120, top: 240, width: 180, height: 90 };
    const back = displayRectFromBox(boxFromDisplay(rect, GEOMETRY), GEOMETRY);
    expect(back.left).toBeCloseTo(rect.left, 6);
    expect(back.top).toBeCloseTo(rect.top, 6);
    expect(back.width).toBeCloseTo(rect.width, 6);
    expect(back.height).toBeCloseTo(rect.height, 6);
  });

  test('a zoomed canvas scales the drag, not the page', () => {
    // At scale 2 the same rect covers half the page width as seen by the user, so the box must be half the size.
    const zoomed: DisplayGeometry = { ...GEOMETRY, scale: 2 };
    const box = boxFromDisplay({ left: 0, top: 0, width: 192, height: 0 }, zoomed);
    expect(box.width).toBeCloseTo(72, 6);
    expect(zoomed.page).toBe(GEOMETRY.page);
  });
});

describe('clamping keeps a mark on the page', () => {
  test('a box hanging off the right edge is shifted back and keeps its size', () => {
    const box = clampBox({ x: A4.widthPt - 10, y: 100, width: 100, height: 20 }, A4);
    expect(box.x).toBeCloseTo(A4.widthPt - 100, 6);
    expect(box.width).toBe(100);
  });

  test('a box above the top edge comes back with its own height intact', () => {
    const box = clampBox({ x: 0, y: A4.heightPt + 50, width: 40, height: 40 }, A4);
    expect(box.y).toBeCloseTo(A4.heightPt - 40, 6);
    expect(box.height).toBe(40);
  });

  test('a box bigger than the page is not shrunk — it starts at the origin', () => {
    const box = clampBox({ x: -100, y: -100, width: 5000, height: 5000 }, A4);
    expect(box).toEqual({ x: 0, y: 0, width: 5000, height: 5000 });
  });

  test('a degenerate box is raised to the minimum rather than left as a speck', () => {
    const box = clampBox({ x: 10, y: 10, width: 0.2, height: -3 }, A4);
    expect(box.width).toBe(4);
    expect(box.height).toBe(4);
  });
});

describe('element boxes and what a drag does to each kind', () => {
  test('a text element is as wide as its own text, and the width follows the text', () => {
    const short = newElement('text', 1, { x: 10, y: 10, width: 90, height: 15 });
    const long = { ...short, text: 'a much longer sentence' };
    const box = elementBox({ ...short, text: 'hi' });
    expect(box?.x).toBe(10);
    expect(box?.y).toBe(10);
    //
    // **Measured by the engine, and without a `document`.** `h` and `i` are 556 and 222 units in Ghostscript's Helvetica,
    // so a 12 pt caption of two letters is 9.336 pt wide — an answer that needs no canvas, which is what "measured"
    // became for a base-14 face once the engine's own table arrived (`base14-metrics`). The estimate is still there, one
    // step further down: `0.5 × size × characters` is inside `WWWWWW` and far outside `iiiiii`, and both look like a bug
    // in the editor rather than in the paragraph (defect 246, which is why the canvas replaced it; defect 250 is why the
    // table replaced the canvas).
    //
    expect(box?.width).toBeCloseTo(textWidthPoints('hi', 12), 6);
    expect(textWidthPoints('hi', 12)).toBeCloseTo(9.336, 6);
    // A line box, not the em: ascent plus descent, so the outline encloses the glyphs rather than centring on them.
    expect(box?.height).toBeCloseTo(13.8, 6);
    expect(elementBox(long)?.width ?? 0).toBeGreaterThan(box?.width ?? 0);
  });

  test('a text element is measured in its own face, and its apostrophe is the engine’s', () => {
    const element = { ...newElement('text', 1, { x: 0, y: 0, width: 90, height: 15 }), text: 'hi' };
    expect(elementBox(element)?.width).toBeCloseTo(9.336, 6);
    // 611 + 278 for the bold face against 556 + 222 for the regular one: the face is part of the metrics, so a box
    // measured in the wrong one is the same defect as a box measured in the wrong size.
    expect(elementBox({ ...element, font: 'Helvetica-Bold' })?.width).toBeCloseTo(10.668, 6);
    //
    // And the two codes the encodings disagree about, as a **box** rather than as a table row: ten apostrophes are 26.64 pt
    // of ink as the engine draws them, where the browser's substitute would have measured 22.92 — 16 % short, in the
    // direction that puts the words outside the outline (defect 250).
    //
    const tenApostrophes = { ...element, text: "''''''''''" };
    expect(elementBox(tenApostrophes)?.width).toBeCloseTo(26.64, 6);
    expect(elementBox(tenApostrophes)?.width ?? 0).toBeGreaterThan(10 * (191 / 1000) * 12);
    // The backtick is the other half: 222 units of ink where a browser resolves U+0060 to `grave` at 333, so a box drawn
    // from the substitute would be **a third wider** than the page. Two of them rather than one, because one backtick is
    // 2.664 pt and `MIN_BOX_POINTS` is 4 — the clamp at the bottom of `textWidthPoints` is its own rule, and a claim
    // about a font's metrics should not be tangled up with it.
    expect(elementBox({ ...element, text: '``' })?.width).toBeCloseTo(5.328, 6);
  });

  test('a Times or a Courier element is the engine’s own width, in its own face', () => {
    const element = { ...newElement('text', 1, { x: 0, y: 0, width: 90, height: 15 }), text: 'aa' };
    //
    // One caption, four faces, four widths, all of them the engine's: 444 units for an `a` in Times roman, 500 in the
    // Times italic, 556 in Helvetica, 600 in Courier — 10.656, 12, 13.344 and 14.4 pt at size 12. None of them needs a
    // canvas, which is the property the table replaced the browser with (defect 251 for the two that have no browser
    // answer at all: a family name cannot ask for a slant or a weight).
    //
    expect(elementBox({ ...element, font: 'Times-Roman' })?.width).toBeCloseTo(10.656, 6);
    expect(elementBox({ ...element, font: 'Times-Italic' })?.width).toBeCloseTo(12, 6);
    expect(elementBox({ ...element, font: 'Courier' })?.width).toBeCloseTo(14.4, 6);
    //
    // And the assertion a browser cannot satisfy: the italic is **wider** than the roman for the same words. A box
    // measured through `Times New Roman, Times, serif` gets the regular face for both values, so the two boxes would be
    // equal — which is the defect, stated as the difference it erases.
    //
    const roman = elementBox({ ...element, font: 'Times-Roman' })!.width;
    const italic = elementBox({ ...element, font: 'Times-Italic' })!.width;
    expect(italic).toBeGreaterThan(roman);
    expect(italic / roman).toBeCloseTo(500 / 444, 6);
    //
    // The map's own alias, resolved rather than fallen back: `times` is Times-Roman to the node handler
    // (`resolvePostScriptFont`), so an element carrying that value has to be measured as Times-Roman, not sent to the
    // browser for a substitute's answer.
    //
    expect(elementBox({ ...element, font: 'times' })?.width).toBeCloseTo(roman, 6);
  });

  test('a face the engine draws but the table does not describe keeps the browser’s measurement', () => {
    const element = { ...newElement('text', 1, { x: 0, y: 0, width: 90, height: 15 }), text: 'hi' };
    //
    // `ZapfChancery-MediumItalic` is the face a typed signature is typeset in, and it is not base-14: Ghostscript draws it
    // from URW's chancery (embedded, a subset, measured in the heavy image), its widths are in no table here, and no
    // `font` option names it. A value like that has to fall back exactly as it did before the table existed — the fallback
    // is what a face outside the list gets, and it is why adding the Times and Courier families did not remove it.
    //
    expect(textFace({ ...element, font: 'ZapfChancery-MediumItalic' })).toBe('ZapfChancery-MediumItalic');
    expect(elementBox({ ...element, font: 'ZapfChancery-MediumItalic' })?.width).toBeCloseTo(
      estimateTextWidth('hi', 12),
      6,
    );
  });

  test('a face that is absent or blank falls back to the schema’s own default', () => {
    const element = newElement('text', 1, { x: 0, y: 0, width: 90, height: 15 });
    expect(textFace(element)).toBe('Helvetica');
    expect(textFace({ ...element, font: ' Helvetica-Bold ' })).toBe('Helvetica-Bold');
    expect(textFace({ ...element, font: '   ' })).toBe('Helvetica');
    expect(textFace({ ...element, font: 7 })).toBe('Helvetica');
    // And the whole path is the same one the contract's own default takes: a text element typed into the row is measured
    // with the face the schema gives it, without the caller having to remember which one that is.
    expect(elementBox({ ...element, text: 'hi' })?.width).toBeCloseTo(9.336, 6);
  });

  test('a text element with nothing typed yet arrives at its kind\u2019s width, not a four-point sliver', () => {
    const empty = newElement('text', 1, { x: 40, y: 60, width: 90, height: 15 });
    //
    // `measureText('')` is zero and the clamp is `MIN_BOX_POINTS`, and a mark drawn at four points is one nobody can find
    // \u2014 let alone click a second time to type into it (`beginEditing`). The second between clicking the page and typing
    // is a state the user is in on every visit, so it is drawn at the width the kind arrives with.
    //
    expect(estimateTextWidth('', 12)).toBe(MIN_BOX_POINTS);
    expect(elementBox(empty)?.width).toBe(DEFAULT_SIZE_POINTS.text.width);
  });

  test('the baseline drop falls back to 0.32 em where there is no font to measure', () => {
    // The number the preview *and* the inline editor are positioned by: a text box's bottom edge is the **baseline**
    // (`edit-pdf`'s `textPlacement`), so a line of that font hangs below it by half-leading plus descent. In a browser that
    // is measured \u2014 `(halfLeading + descent) / size`, which for the Helvetica substitutes browsers actually have is about
    // 0.23 em, and is not the `0.17em` the stylesheet used to hard-code \u2014 and here it is the documented fallback, which is
    // that same formula evaluated with the fallback metrics.
    expect(textBaselineDropEm()).toBeCloseTo(0.32, 6);
  });

  test('moving a text element moves its anchor and leaves its size alone', () => {
    const text: PlacementElement = { ...newElement('text', 1, { x: 10, y: 20, width: 90, height: 15 }), size: 18 };
    const moved = placeElement(text, { x: 100, y: 200, width: 400, height: 400 });
    expect(moved.x).toBe(100);
    expect(moved.y).toBe(200);
    // The size is a number the user set, not a consequence of the box they dragged.
    expect(moved.size).toBe(18);
    expect(moved.width).toBeUndefined();
  });

  test('resizing a shape writes all four numbers', () => {
    const shape = newElement('shape', 2, { x: 0, y: 0, width: 160, height: 80 });
    const resized = placeElement(shape, { x: 5, y: 6, width: 42, height: 24 });
    expect(resized).toMatchObject({ x: 5, y: 6, width: 42, height: 24 });
  });

  test('a checkbox keeps its size and moves as a point', () => {
    const checkbox = newElement('checkbox', 1, { x: 1, y: 2, width: 12, height: 12 });
    const moved = placeElement(checkbox, { x: 50, y: 60, width: 12, height: 12 });
    expect(moved).toMatchObject({ x: 50, y: 60, size: 12 });
  });

  test('a freehand stroke is translated by its bounding box, and its points move with it', () => {
    const draw: PlacementElement = {
      type: 'draw',
      page: 1,
      x: 0,
      y: 0,
      color: '#111111',
      strokeWidth: 2,
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 20 },
      ],
    };
    expect(elementBox(draw)).toEqual({ x: 10, y: 10, width: 20, height: 10 });
    const moved = placeElement(draw, { x: 100, y: 100, width: 20, height: 10 });
    expect(moved.points).toEqual([
      { x: 100, y: 100 },
      { x: 120, y: 110 },
    ]);
  });

  test('a stroke with no points has no box, so nothing is drawn that was not drawn', () => {
    expect(elementBox({ type: 'draw', page: 1, x: 0, y: 0, points: [] })).toBeNull();
    expect(boundsOfPoints([])).toBeNull();
  });
});

describe('reading the option value', () => {
  test('an unknown kind is dropped rather than coerced', () => {
    const read = readElements([
      { type: 'text', page: 1, x: 1, y: 2, text: 'keep' },
      { type: 'watermark', page: 1, x: 1, y: 2 },
      'nonsense',
      null,
    ]);
    expect(read).toHaveLength(1);
    expect(read[0]?.text).toBe('keep');
  });

  test('every field the JSON editor accepted survives the trip', () => {
    // The guarantee that makes the canvas an editor rather than a filter: zod fills defaults on the server, so an
    // element that arrives without `font` must go back without one instead of being normalised here.
    const read = readElements([{ type: 'text', page: 3, x: 4, y: 5, text: 'hi', custom: 'kept' }]);
    expect(read[0]).toEqual({ type: 'text', page: 3, x: 4, y: 5, text: 'hi', custom: 'kept' });
  });

  test('a missing page or position lands on the page rather than nowhere', () => {
    const read = readElements([{ type: 'checkbox', page: -2, checked: true }]);
    expect(read[0]).toMatchObject({ page: 1, x: 0, y: 0 });
  });

  test('a value that is not an array, or an empty one, is no elements', () => {
    expect(readElements(undefined)).toEqual([]);
    expect(readElements('[]')).toEqual([]);
    expect(readElements([])).toEqual([]);
  });
});

/**
 * The defect this pins (104): the canvas used to draw a resize handle on *every* mark, including the kinds whose size is
 * not the box — a text element is sized by its font, a checkbox by its `size`, a stroke by its points. Dragging that
 * handle handed `placeElement` the box drawn from the corner, and for those kinds the only thing it can write is the
 * anchor, so the mark **jumped to the pointer** instead of resizing. The canvas now asks the shape how a kind is placed
 * and offers the handle only for a real box; this assertion is what stops `placeElement`'s contract from being
 * "corrected" into a resize that teleports instead.
 */
describe('a mark whose size is not its box', () => {
  test('a text mark dragged by its corner moves to the corner rather than resizing', () => {
    const text = newElement('text', 1, { x: 40, y: 700, width: 90, height: 15 });
    const dragged = placeElement(text, { x: 130, y: 685, width: 4, height: 4 });
    expect(dragged.type).toBe('text');
    expect(dragged).toMatchObject({ x: 130, y: 685 });
    // The font size is untouched: that is the whole reason the handle is not offered for this kind.
    expect((dragged as { size?: unknown }).size).toBe((text as { size?: unknown }).size);
  });

  test('a checkbox and a stroke behave the same way, and a rectangle does not', () => {
    const checkbox = newElement('checkbox', 1, { x: 10, y: 10, width: 12, height: 12 });
    expect(placeElement(checkbox, { x: 200, y: 300, width: 12, height: 12 })).toMatchObject({ x: 200, y: 300 });
    const shape = newElement('shape', 1, { x: 10, y: 10, width: 100, height: 20 });
    expect(placeElement(shape, { x: 200, y: 300, width: 80, height: 40 })).toMatchObject({
      x: 200,
      y: 300,
      width: 80,
      height: 40,
    });
  });
});

describe('a click is not a drag', () => {
  test('a short drag becomes the shape’s default box, centred where the pointer was', () => {
    const size = DEFAULT_SIZE_POINTS.shape;
    const box = normaliseDraggedBox(size, { x: 10, y: 10, width: 1, height: 1 }, { x: 50, y: 50 });
    expect(box).toEqual(centredBox(size, { x: 50, y: 50 }));
    expect(box.width).toBe(160);
  });

  test('a real drag keeps the box the user drew', () => {
    const drawn: Box = { x: 10, y: 10, width: 80, height: 30 };
    expect(normaliseDraggedBox(DEFAULT_SIZE_POINTS.shape, drawn, { x: 50, y: 50 })).toEqual(drawn);
  });
});
