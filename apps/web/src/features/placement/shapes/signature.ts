import type { PlacementItem } from '../adapter';
import { type Box, MIN_BOX_POINTS } from '../geometry';

/**
 * The `signature` placement shape — `sign`'s `fields` array on the placement canvas.
 *
 * Three facts about this contract decide everything below, and all three are read out of the schema and the engine
 * (`options.ts`'s `SignaturePlacement`, `packages/engines/src/signature.ts`) rather than chosen here:
 *
 * 1. **The entry's numbers are in its own `units`, and the canvas works in points.** `SignaturePlacement` carries
 *    `units: 'pt' | 'mm' | 'percent'` and the engine converts with the page in hand. The canvas has the page's size
 *    too — it rendered it — but its arithmetic (`geometry.ts`) is in points, so the conversion has to happen at the
 *    boundary: `signatureBox` reads the entry in points, `moveSignature` writes it back in the entry's own units. A
 *    canvas that wrote points into a millimetre entry would put the signature 2.8× too far from the corner and the
 *    output would look like a rounding bug rather than a unit bug.
 * 2. **`percent` cannot be resolved here, and pretending otherwise is the one thing worth refusing.** It is a share of
 *    the page, and the shape's functions do not receive the page — `box(item)` is called by the canvas before anything
 *    is rendered, and a preview failure must not silently change what an entry means. So a percent entry is kept
 *    (dropping it would delete it the moment the user moved a different mark) and reports no box: the canvas skips it,
 *    the row says where it can be edited, and the JSON editor is one click away. That is the difference between a gap
 *    with a sign on it and a guess.
 * 3. **A signature is a real rectangle.** Unlike a note (a point) or a text element (sized by its font), this box is
 *    the size the image is drawn at — so it is dragged out, moved and resized, and its width and height are the two
 *    numbers a user is most likely to want.
 */

/** The one kind the catalog declares for `sign`. The toolbar has a single button, and it is this one. */
export const SIGNATURE_KIND = 'signature';

/**
 * What a placed signature starts as, in points.
 *
 * 180 × 60 pt is ~63 × 21 mm: the width of a signature line on a contract and about three lines tall, which is the
 * shape a handwritten signature actually occupies. The schema does not constrain the box beyond `positive()`, so this
 * is a usability default rather than a contract value — and it is small enough that a mis-drag is visible.
 */
export const SIGNATURE_DEFAULT_SIZE = { width: 180, height: 60 };

/**
 * The units this canvas can place in.
 *
 * `percent` is in the schema and deliberately absent here — see fact 2 above. Millimetres need no page size (the
 * conversion is a constant), which is exactly why the two that remain are the two that do not.
 */
export const SIGNATURE_CANVAS_UNITS = ['pt', 'mm'] as const;
export type SignatureCanvasUnit = (typeof SIGNATURE_CANVAS_UNITS)[number];

/** `SignaturePlacement`'s own default, and the only unit `createSignature` writes. */
export const SIGNATURE_DEFAULT_UNIT: SignatureCanvasUnit = 'pt';

/** Millimetres per point. Defined by the inch, not by the metre: 72 pt is an inch, and an inch is 25.4 mm. */
const MM_PER_POINT = 25.4 / 72;

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function isSignatureCanvasUnit(value: unknown): value is SignatureCanvasUnit {
  return typeof value === 'string' && (SIGNATURE_CANVAS_UNITS as readonly string[]).includes(value);
}

/** Points → the entry's own unit, rounded to a precision the unit deserves (`mm` to 0.01, ~0.03 pt). */
export function pointsToUnit(valuePt: number, unit: SignatureCanvasUnit): number {
  return unit === 'mm' ? round(valuePt * MM_PER_POINT, 2) : round(valuePt, 2);
}

/** The entry's unit → points, for the canvas. The inverse of `pointsToUnit`, and tested as such. */
export function unitToPoints(value: number, unit: SignatureCanvasUnit): number {
  return unit === 'mm' ? value / MM_PER_POINT : value;
}

/**
 * The option value → canvas marks.
 *
 * An entry with no usable numbers is dropped rather than coerced, the same rule `readAnnotations` follows: the schema
 * requires a positive width and height, so an entry that has none is input the API would refuse, and drawing a guess
 * would be worse than not drawing it. An entry in `percent` is *kept* — the schema accepts it and the engine honours
 * it — and simply reports no box.
 */
export function readSignatures(value: unknown): PlacementItem[] {
  if (!Array.isArray(value)) return [];
  const items: PlacementItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue;
    const candidate = entry as Record<string, unknown>;
    const page = Math.max(1, Math.trunc(numberOf(candidate.page, 1)));
    if (candidate.units === 'percent') {
      items.push({ kind: SIGNATURE_KIND, page, entry: { ...candidate, page } });
      continue;
    }
    if (
      typeof candidate.x !== 'number' ||
      typeof candidate.y !== 'number' ||
      !(typeof candidate.w === 'number' && candidate.w > 0) ||
      !(typeof candidate.h === 'number' && candidate.h > 0)
    ) {
      continue;
    }
    items.push({ kind: SIGNATURE_KIND, page, entry: { ...candidate, page } });
  }
  return items;
}

/** The rectangle the canvas draws, in points — or `null` for an entry this shape cannot resolve (fact 2). */
export function signatureBox(item: PlacementItem): Box | null {
  const entry = item.entry;
  if (entry.units === 'percent') return null;
  const unit: SignatureCanvasUnit = isSignatureCanvasUnit(entry.units) ? entry.units : SIGNATURE_DEFAULT_UNIT;
  if (typeof entry.x !== 'number' || typeof entry.y !== 'number') return null;
  const width = numberOf(entry.w, SIGNATURE_DEFAULT_SIZE.width);
  const height = numberOf(entry.h, SIGNATURE_DEFAULT_SIZE.height);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: unitToPoints(numberOf(entry.x, 0), unit),
    y: unitToPoints(numberOf(entry.y, 0), unit),
    width: Math.max(MIN_BOX_POINTS, unitToPoints(width, unit)),
    height: Math.max(MIN_BOX_POINTS, unitToPoints(height, unit)),
  };
}

/**
 * Move or resize a placed signature.
 *
 * The box arrives in points and leaves in the entry's own unit, which is the conversion this whole module exists for.
 * `units` is written here as well as honoured: an entry that had none (`SignaturePlacement` defaults it, so this is
 * the JSON-editor case) gets the unit the canvas is placing in, so what the user sees in the row and what the engine
 * receives cannot disagree.
 */
export function moveSignature(item: PlacementItem, box: Box): PlacementItem {
  const entry = item.entry;
  if (entry.units === 'percent') return item;
  const unit: SignatureCanvasUnit = isSignatureCanvasUnit(entry.units) ? entry.units : SIGNATURE_DEFAULT_UNIT;
  return {
    ...item,
    page: Math.max(1, Math.round(item.page)),
    entry: {
      ...entry,
      page: Math.max(1, Math.round(item.page)),
      x: pointsToUnit(box.x, unit),
      y: pointsToUnit(box.y, unit),
      w: pointsToUnit(Math.max(MIN_BOX_POINTS, box.width), unit),
      h: pointsToUnit(Math.max(MIN_BOX_POINTS, box.height), unit),
      units: unit,
    },
  };
}

/**
 * A new place to sign.
 *
 * `units: 'pt'` is written explicitly rather than left to the schema's default, because the row shows the unit and the
 * canvas converts by it: a value the user can see and the engine defaults to differently is a disagreement waiting for
 * the first edit.
 */
export function createSignature(page: number, box: Box): PlacementItem {
  return {
    kind: SIGNATURE_KIND,
    page,
    entry: {
      page,
      x: round(box.x, 2),
      y: round(box.y, 2),
      w: round(Math.max(MIN_BOX_POINTS, box.width), 2),
      h: round(Math.max(MIN_BOX_POINTS, box.height), 2),
      units: SIGNATURE_DEFAULT_UNIT,
    },
  };
}

/** What the list calls one placement — the numbers in the unit the entry is written in, because those are the ones
 * that get sent. */
export function signatureSummary(item: PlacementItem): string {
  const entry = item.entry;
  const unit: SignatureCanvasUnit = isSignatureCanvasUnit(entry.units) ? entry.units : SIGNATURE_DEFAULT_UNIT;
  if (entry.units === 'percent') {
    return `page ${item.page} · a share of the page (edited as JSON)`;
  }
  const width = numberOf(entry.w, 0);
  const height = numberOf(entry.h, 0);
  const x = numberOf(entry.x, 0);
  const y = numberOf(entry.y, 0);
  return `page ${item.page} · ${round(width, 2)} × ${round(height, 2)} ${unit} at ${round(x, 2)}, ${round(y, 2)}`;
}

/** A signature is only ever dragged out as a box — there is no point-anchored kind in this contract. */
export function signatureGeometry(): 'box' {
  return 'box';
}

export function signatureDefaultSize(): { width: number; height: number } {
  return SIGNATURE_DEFAULT_SIZE;
}
