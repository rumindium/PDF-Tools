import type { EditElement } from '@pdftools/contracts/tools';
import { advanceWidthPoints, base14Face } from './base14-metrics';

/**
 * Placement geometry: the arithmetic between a drag on a rendered page and the coordinates the contract wants.
 *
 * Everything here is pure and lives in its own module for one reason: this is the part of the editor that can be
 * *wrong* without looking wrong. A flipped sign or an inverted axis still draws a box, still produces JSON, and still
 * submits — the job simply paints the mark on the opposite corner of the page. So the conversions are functions with
 * tests rather than expressions inline in a pointer handler, and the tests are about the directions a reader gets
 * wrong: PDF user space has its origin at the **bottom-left** and `y` grows **up**, while a rendered page image has
 * its origin at the top-left and `y` grows down, and every drag arrives in the second system.
 *
 * Three coordinate systems, named consistently throughout:
 *
 * - **points** — PDF user space, the units the contract takes (`0-POINTS.md`'s convention, the same one `redact`'s
 *   rects use). A `Box` is `x`/`y` of the **lower-left** corner plus width and height.
 * - **pixels** — the rendered page image's own pixels, `dpi` of them per inch.
 * - **display** — CSS pixels inside the page element on screen, which is the pixels multiplied by a scale factor.
 *
 * A `DisplayGeometry` carries the three constants that convert between them, so a caller passes one object around and
 * never re-derives `72 / dpi` in a handler.
 */

/** PDF user-space units per inch. `72` is not a preference: it is the definition of the unit. */
export const POINTS_PER_INCH = 72;

/**
 * The smallest box the editor will keep.
 *
 * Below this a box stops being a mark and becomes a hazard: a 1 pt rectangle is invisible in the output and
 * unclickable on screen, so a drag that lands there is treated as a click and replaced by the kind's default size.
 */
export const MIN_BOX_POINTS = 4;

export interface PageSize {
  widthPt: number;
  heightPt: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A rectangle in CSS pixels, relative to the rendered page element's own top-left corner. */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayGeometry {
  /** CSS pixels per rendered pixel. */
  scale: number;
  dpi: number;
  page: PageSize;
}

/**
 * One element as the editor holds it.
 *
 * Looser than `EditElement` on purpose, and the looseness is the honest part: the array arrives from the API catalog's
 * JSON editor, where a user may have typed `{"type":"text","page":1,"x":10,"y":10,"text":"hi"}` and let zod supply
 * `font`, `size`, `color` and `rotation` on the server. Rejecting that here would mean the visual editor *loses* data
 * the JSON editor accepted, so the editor keeps every field it was handed, edits only the ones it owns, and sends the
 * object back for the schema to complete.
 */
export type PlacementElement = {
  type: EditElement['type'];
  page: number;
  x: number;
  y: number;
} & Record<string, unknown>;

export type ElementKind = EditElement['type'];

const ELEMENT_KINDS: ElementKind[] = ['text', 'image', 'shape', 'draw', 'checkbox'];

/** Default size for a new element of each kind, in points — the schema's own defaults where it has them. */
export const DEFAULT_SIZE_POINTS: Record<ElementKind, { width: number; height: number }> = {
  // Wide enough to grab with a pointer even before anything is typed into it.
  text: { width: 90, height: 15 },
  image: { width: 160, height: 80 },
  shape: { width: 160, height: 80 },
  checkbox: { width: 12, height: 12 },
  // A freehand element has no box until it has points; this is only what a stray click gets.
  draw: { width: 40, height: 40 },
};

export function isElementKind(value: unknown): value is ElementKind {
  return typeof value === 'string' && (ELEMENT_KINDS as string[]).includes(value);
}

export function pointsPerPixel(dpi: number): number {
  return POINTS_PER_INCH / dpi;
}

/** CSS pixels per point — the single factor every conversion below is a rearrangement of. */
export function pixelsPerPoint(geometry: DisplayGeometry): number {
  return (geometry.scale * geometry.dpi) / POINTS_PER_INCH;
}

/** The page a rendered image depicts, recovered from the image's own pixel size and the dpi it was rendered at. */
export function pageSizeFromPixels(pixels: { width: number; height: number }, dpi: number): PageSize {
  const perPixel = pointsPerPixel(dpi);
  return { widthPt: pixels.width * perPixel, heightPt: pixels.height * perPixel };
}

/**
 * A drag on the page → the box the contract wants.
 *
 * The `y` is where the axis flips: display space measures the top edge downward from the top of the page, PDF user
 * space measures the bottom edge upward from the bottom. Subtracting the box's *height* as well as its top is the step
 * that is easy to omit — omitting it puts the mark one box-height too high, which on a small mark is nearly invisible.
 */
export function boxFromDisplay(rect: DisplayRect, geometry: DisplayGeometry): Box {
  const perPoint = pixelsPerPoint(geometry);
  const width = rect.width / perPoint;
  const height = rect.height / perPoint;
  return {
    x: rect.left / perPoint,
    y: geometry.page.heightPt - rect.top / perPoint - height,
    width,
    height,
  };
}

/** The inverse, for drawing a stored box: the same flip, read the other way. */
export function displayRectFromBox(box: Box, geometry: DisplayGeometry): DisplayRect {
  const perPoint = pixelsPerPoint(geometry);
  return {
    left: box.x * perPoint,
    top: (geometry.page.heightPt - box.y - box.height) * perPoint,
    width: box.width * perPoint,
    height: box.height * perPoint,
  };
}

/**
 * Keep a box on the page, preserving its size where the page allows it.
 *
 * A mark placed hanging off the edge is not an error the API reports — the engines simply draw nothing where there is
 * no page — so the clamp is what stops a drag beyond the margin from producing a job whose output does not contain the
 * change the user watched themselves make. It shifts rather than crops: a box bigger than the page keeps its size and
 * starts at the origin, because shrinking it would silently change what was asked for.
 */
export function clampBox(box: Box, page: PageSize): Box {
  const width = Math.max(MIN_BOX_POINTS, box.width);
  const height = Math.max(MIN_BOX_POINTS, box.height);
  return {
    x: Math.min(Math.max(0, box.x), Math.max(0, page.widthPt - width)),
    y: Math.min(Math.max(0, box.y), Math.max(0, page.heightPt - height)),
    width,
    height,
  };
}

/**
 * How wide a string of text will be when there is nothing better to measure with: `0.5 × size` per character.
 *
 * **The last of three measurements** (`textWidthPoints`), and the one that needs nothing at all — no font table, no
 * `document`. Helvetica's average advance is a little over half an em for mixed case, so this lands within about a tenth
 * of the real width for the lengths people type into this field; a box that is 10 % short is a smaller problem than a
 * measurement that cannot be made at all.
 */
export function estimateTextWidth(text: string, size: number): number {
  return Math.max(MIN_BOX_POINTS, text.length * size * 0.5);
}

/**
 * The CSS family every text **preview** draws in, and the family the browser is asked for when the engine's own table
 * cannot speak for a face.
 *
 * `edit-pdf`'s schema default is the base-14 `Helvetica`, which a browser has no file for; naming the two substitutes
 * every platform has plus the generic family is what makes the fallback deterministic rather than whatever the
 * user-agent picks. A face the table covers is not measured here at all any more — its box comes from the engine's own
 * advances (`textWidthPoints`) — so this family is what the glyphs are *shown* in, not what they are measured with.
 */
export const TEXT_FONT_FAMILY = 'Helvetica, Arial, sans-serif';

/** The face `edit-pdf`'s schema defaults a text element to, and the one `textWidthPoints` assumes when told nothing. */
export const DEFAULT_TEXT_FACE = 'Helvetica';

/**
 * The face a text element names, or the schema's default where it names none.
 *
 * One reader for the three places that need the same answer — the box, the row and the inline editor — because they
 * have to agree about it for the same reason they have to agree about the size: a box measured in one face around
 * glyphs drawn in another is a preview of a document nobody has.
 *
 * What comes back is the value the element carries, not a canonical face: `times` and `Times-Roman` are the same font
 * to the engine (`POSTSCRIPT_FONTS` resolves both), and deciding that is the table's business (`base14Face`), not this
 * reader's.
 */
export function textFace(element: PlacementElement): string {
  const face = typeof element.font === 'string' ? element.font.trim() : '';
  return face === '' ? DEFAULT_TEXT_FACE : face;
}

/**
 * The browser family something outside the table is measured and previewed in.
 *
 * Every face a `font` option can name is in the table now, so this is no longer the path a Times or a Courier element
 * takes — which is what it was for while those families were measured by the browser (defect 251). What still reaches
 * it is a value the engine would not draw at all: `Symbol`, `ZapfDingbats`, the chancery face a signature is typeset
 * in, and — since the row's own control offers nothing else — a name someone typed into the JSON, which the node
 * handler refuses with `FONT_NOT_FOUND` and which therefore has no engine answer to give. A named substitute is still
 * the honest preview for those: `Georgia` measured with the Helvetica family would be a second invention on top of the
 * first.
 */
function cssFamilyFor(face: string): string {
  const name = face.trim().toLowerCase();
  if (name.startsWith('times')) return 'Times New Roman, Times, serif';
  if (name.startsWith('courier')) return 'Courier New, Courier, monospace';
  return TEXT_FONT_FAMILY;
}

/**
 * The engine's own width for a string in a face the table knows, or `null` when the table cannot speak for it.
 *
 * `null` is not "zero": it is a face this table does not describe, or a character above the encoding — an emoji is
 * four bytes and none of them is a code these fonts map — and either way the caller measures another way rather than
 * drawing a box from numbers nobody supplied. For an `edit-pdf` element that means the value is one the **engine**
 * would refuse, so there is no width of the page's own to be had and the browser's is the best available.
 */
function measureExact(face: string, text: string, size: number): number | null {
  const base14 = base14Face(face);
  return base14 == null ? null : advanceWidthPoints(base14, text, size);
}

/**
 * The line height a text mark is drawn with, in em — the number in `.placement-text`, in the engine's own line box, and
 * in the arithmetic that places the baseline.
 */
export const TEXT_LINE_HEIGHT_EM = 1.15;

/** The one offscreen context this module measures with — `null` outside a browser, which is the fallback path. */
let measurer: CanvasRenderingContext2D | null | undefined;
const measuredWidths = new Map<string, number>();
/** Keys are strings the user typed, so the cache is cleared rather than grown: a long editing session is thousands. */
const MEASURED_WIDTH_CACHE = 512;

function measuringContext(): CanvasRenderingContext2D | null {
  if (measurer === undefined) {
    measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return measurer;
}

/**
 * How wide a string of text is, in points, **as the engine will draw it**.
 *
 * Three measurements, in order of authority — and the order is the whole history of this function:
 *
 *  1. **The engine's own table** (`base14-metrics`). `edit-pdf` draws text with Ghostscript, so the width of a caption
 *     on the page is `stringwidth` in the font Ghostscript resolved: a fact rather than an approximation, and the table
 *     holds a copy of it that `bun run test:base14` checks digit by digit against the engine itself. Every face a
 *     `font` option can name is in it, so this is the answer for a Helvetica caption, a Times one and a Courier one
 *     alike — and it is summed here byte by byte with no canvas involved, which also makes the exact answer available
 *     where there is no `document` at all.
 *  2. **The browser's `canvas`**, for a face or a character the table cannot speak for — which, now that every face a
 *     `font` option can name is in the table, means a value the engine would refuse and a byte outside its encoding.
 *     Metric-compatible for the characters people type, and someone else's font everywhere else, which is how two
 *     rounds of defects were found here: a caption made of apostrophes came out 16 % narrower than the page draws it
 *     (defect 250: the box said 191 units a glyph, `quotesingle`, where the engine draws 222, `quoteright`), and a
 *     `Times-Italic` caption came out 12.6 % narrow because a *family* name cannot ask for a style (defect 251).
 *  3. **The estimate**, when there is neither a table entry nor a `document` to measure with.
 *
 * The estimate was all of it once, and `canvas` replaced it because `WWWWWW` and `iiiiii` are the same length and three
 * times apart in width (defect 246: a caption's own text hung outside the dashed box it had been given). The table
 * replaces `canvas` for the same reason one level down: the box is the promise that the outline is where the ink will
 * be, and a browser's substitute font cannot make that promise about a document another program will draw.
 */
export function textWidthPoints(text: string, size: number, face = DEFAULT_TEXT_FACE): number {
  const key = `${face}|${size}|${text}`;
  const cached = measuredWidths.get(key);
  if (cached != null) return cached;

  const exact = measureExact(face, text, size);
  let width: number;
  if (exact != null) {
    width = exact;
  } else {
    const context = measuringContext();
    if (context) {
      context.font = `${size}px ${cssFamilyFor(face)}`;
      width = context.measureText(text).width;
    } else {
      width = estimateTextWidth(text, size);
    }
  }
  const points = Math.max(MIN_BOX_POINTS, width);
  if (measuredWidths.size >= MEASURED_WIDTH_CACHE) measuredWidths.clear();
  measuredWidths.set(key, points);
  return points;
}

/** A line box for a font size: ascent plus descent for the Helvetica family, i.e. ~1.15 em. */
export function estimateTextHeight(size: number): number {
  return size * TEXT_LINE_HEIGHT_EM;
}

/** The measured drop, kept after the first call: the font's metrics do not change while the app is running. */
let baselineDropEm: number | null = null;

/**
 * How far below a text mark's own box a line of that font has to hang for its **baseline to sit on the box's bottom
 * edge** — the number `.placement-text` used to approximate as `0.17em`.
 *
 * The box of a text element is not a picture frame: `x`/`y` is the *baseline start* (the engine's own `textPlacement`),
 * so the outline runs from the baseline up by the line height and the glyphs sit on its bottom edge. A span with
 * `line-height: 1.15` and `bottom: -dem` puts its baseline `(half-leading + descent) - d·em` above the box's bottom, so
 * `d` is what makes that difference zero — and both terms are the font's own metrics, which is why they are read from a
 * `canvas` here rather than written down as a constant that is right for one platform's Helvetica substitute and wrong
 * for the next one's.
 *
 * The fallback (`0.32`) is for a caller with no `document` — the module's unit tests — and it is the value a metric-
 * compatible Helvetica substitute produces in Chrome: half-leading `(1.15 - (0.905 + 0.212)) / 2 = 0.0165`, plus the
 * descent `0.212`. It is a fallback and not a default: any browser measures its own font and overwrites it.
 */
export function textBaselineDropEm(family = TEXT_FONT_FAMILY): number {
  if (baselineDropEm != null) return baselineDropEm;
  baselineDropEm = 0.32;
  const context = measuringContext();
  if (context) {
    const probe = 100;
    context.font = `${probe}px ${family}`;
    const metrics = context.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    if (Number.isFinite(ascent) && Number.isFinite(descent)) {
      const halfLeading = (TEXT_LINE_HEIGHT_EM * probe - (ascent + descent)) / 2;
      baselineDropEm = (halfLeading + descent) / probe;
    }
  }
  return baselineDropEm;
}

/** The bounding box of a freehand stroke, which is what makes it selectable and movable. */
export function boundsOfPoints(points: Point[]): Box | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(MIN_BOX_POINTS, maxX - minX),
    height: Math.max(MIN_BOX_POINTS, maxY - minY),
  };
}

export function translatePoints(points: Point[], dx: number, dy: number): Point[] {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

function pointsOf(element: PlacementElement): Point[] {
  const raw = element.points;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (point): point is Point =>
      typeof point === 'object' &&
      point != null &&
      typeof (point as Point).x === 'number' &&
      typeof (point as Point).y === 'number',
  );
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The rectangle the canvas draws and drags for an element.
 *
 * `null` for a freehand element with no points yet: there is nothing to draw, and inventing a box would be a mark the
 * user never made.
 *
 * The anchor each kind is really drawn from, read out of the handler rather than assumed (`edit-pdf.ts`): a text
 * element's `x`/`y` is its **baseline start**, so its outline runs from the baseline up by the line height — the bottom
 * edge of a text mark is not the bottom of its glyphs. A shape, checkbox or image is a rectangle whose `x`/`y` is the
 * **lower-left corner**, and a freehand stroke is just its points, which is why its box is derived. Getting this
 * backwards moves every mark by its own height, which at a 12 pt font is 2 mm and at a 48 pt one is a centimetre.
 */
export function elementBox(element: PlacementElement): Box | null {
  switch (element.type) {
    case 'text': {
      const size = numberOf(element.size, 12);
      const text = typeof element.text === 'string' ? element.text : '';
      return {
        x: element.x,
        y: element.y,
        //
        // Measured with the element's **own face** (`textFace`), not with whatever the browser would substitute for
        // it: this rectangle is the editor's hit target, the drag's handle and the dashed box the user watches their
        // own words land in (`textWidthPoints`), and a face is part of a font's metrics rather than decoration on them.
        //
        // Measured when it has words, the kind's default width when it does not: `measureText('')` is 0, and the
        // clamped 4 pt sliver is a mark nobody can find, let alone click — so a text element that has just been placed,
        // which is the state a user is in for the second between clicking the page and typing, is drawn at the width a
        // mark of this kind arrives with.
        //
        width: text === '' ? DEFAULT_SIZE_POINTS.text.width : textWidthPoints(text, size, textFace(element)),
        height: estimateTextHeight(size),
      };
    }
    case 'image':
    case 'shape': {
      return {
        x: element.x,
        y: element.y,
        width: Math.max(MIN_BOX_POINTS, numberOf(element.width, DEFAULT_SIZE_POINTS[element.type].width)),
        height: Math.max(MIN_BOX_POINTS, numberOf(element.height, DEFAULT_SIZE_POINTS[element.type].height)),
      };
    }
    case 'checkbox': {
      const size = numberOf(element.size, 12);
      return { x: element.x, y: element.y, width: size, height: size };
    }
    case 'draw':
      return boundsOfPoints(pointsOf(element));
    default:
      return null;
  }
}

/**
 * Move or resize an element, per what its kind can actually express.
 *
 * The kinds diverge here, and pretending otherwise would be the bug: `text` and `checkbox` are anchored at a point and
 * sized by a number (`size`), so a drag moves the anchor and leaves the size alone; `image` and `shape` are rectangles,
 * so a drag sets all four; `draw` is a point list, so a drag translates it and its box is an artefact of those points
 * rather than something to write back.
 */
export function placeElement(element: PlacementElement, box: Box): PlacementElement {
  switch (element.type) {
    case 'text':
    case 'checkbox':
      return { ...element, x: box.x, y: box.y };
    case 'image':
    case 'shape':
      return { ...element, x: box.x, y: box.y, width: box.width, height: box.height };
    case 'draw': {
      const bounds = boundsOfPoints(pointsOf(element));
      if (!bounds) return element;
      const translated = translatePoints(pointsOf(element), box.x - bounds.x, box.y - bounds.y);
      return { ...element, points: translated };
    }
    default:
      return element;
  }
}

/** A new element of `kind`, anchored at the box the user drew (or the default size when they just clicked). */
export function newElement(kind: ElementKind, page: number, box: Box): PlacementElement {
  const common = { type: kind, page, x: box.x, y: box.y };
  switch (kind) {
    case 'text':
      return { ...common, text: '', font: 'Helvetica', size: 12, color: '#111111', rotation: 0 };
    case 'image':
      return { ...common, width: box.width, height: box.height, fileId: '' };
    case 'shape':
      return {
        ...common,
        shape: 'rect',
        width: box.width,
        height: box.height,
        stroke: '#1a73e8',
        fill: null,
        strokeWidth: 1,
      };
    case 'checkbox':
      return { ...common, size: 12, checked: true, color: '#111111' };
    case 'draw':
      return { ...common, color: '#111111', strokeWidth: 2, points: [{ x: box.x, y: box.y }] };
  }
}

/** What to call an element in the list: the thing the user typed, or its kind and shape. */
export function elementSummary(element: PlacementElement): string {
  if (element.type === 'text') {
    const text = typeof element.text === 'string' ? element.text.trim() : '';
    return text === '' ? 'Empty text' : text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  if (element.type === 'shape') return typeof element.shape === 'string' ? element.shape : 'shape';
  if (element.type === 'image')
    return typeof element.fileId === 'string' && element.fileId !== '' ? 'image' : 'No image yet';
  if (element.type === 'draw') return `freehand · ${pointsOf(element).length} points`;
  return 'checkbox';
}

/**
 * Read the option value into elements the editor can work with.
 *
 * Anything that is not a known kind is dropped rather than coerced: an element the engine would refuse is not something
 * to draw on the canvas and then submit. Positions default to the page's origin so a partially typed object is still
 * placeable instead of unreachable.
 */
export function readElements(value: unknown): PlacementElement[] {
  if (!Array.isArray(value)) return [];
  const elements: PlacementElement[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue;
    const candidate = entry as Record<string, unknown>;
    if (!isElementKind(candidate.type)) continue;
    elements.push({
      ...candidate,
      type: candidate.type,
      page: Math.max(1, Math.trunc(numberOf(candidate.page, 1))),
      x: numberOf(candidate.x, 0),
      y: numberOf(candidate.y, 0),
    } as PlacementElement);
  }
  return elements;
}

/**
 * Where a new mark lands when the user clicks: a box of the shape's default size, centred on the click.
 *
 * The size comes from the caller rather than from a kind table here, because what a click-sized mark should be is the
 * *shape's* business: a text element and a highlight do not agree on one, and the adapter that knows the contract is
 * where that decision belongs (`shapes/*.tsx`).
 */
export function centredBox(size: { width: number; height: number }, at: Point): Box {
  return { x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height };
}

/** A drag shorter than the minimum is a click: the user is placing a mark, not drawing one. */
export function normaliseDraggedBox(size: { width: number; height: number }, box: Box, origin: Point): Box {
  if (box.width < MIN_BOX_POINTS || box.height < MIN_BOX_POINTS) return centredBox(size, origin);
  return box;
}
