import type { PlacementItem } from '../adapter';
import { type Box, MIN_BOX_POINTS } from '../geometry';

/**
 * The `annotations` placement shape — `annotate`'s markup and notes, drawn on the same canvas as `edit-pdf`'s elements.
 *
 * Three facts about this contract decide everything below, and all three are read out of the schema and the engine
 * rather than chosen here (`options.ts`'s `AnnotationElement`, `packages/engines/src/annotations.ts`):
 *
 * 1. **Markup carries a *list* of rectangles per entry.** A highlight drawn over a paragraph is one annotation with one
 *    rectangle per line, because a `/QuadPoints` array is a set of quads and a reader treats them as one mark. The
 *    canvas keeps that: one canvas mark is one entry, its box is the union of its rectangles, moving it translates them
 *    all and resizing scales them all about that union. Splitting a paragraph highlight into five annotations would
 *    look the same on screen and behave differently in a reader's comment list, which is exactly the kind of
 *    "equivalent" the rest of this codebase refuses.
 * 2. **A note is a point, not a rectangle.** The contract gives it `x`/`y` and the engine anchors a 20 pt icon box at
 *    its lower-left; its text lives in `/Contents` and shows up in a popup. So it gets a fixed box on screen (which is
 *    its hit area) and no resize handle — there is no second dimension to drag.
 * 3. **The colour is optional in the canvas and required by the contract only through its default.** A mark whose
 *    colour the user never touches keeps `AnnotationElement`'s own default rather than this file's copy of it, so the
 *    swatches below are *display* values (marked as such) and `color` is written only when it is chosen.
 */

/** The kinds the catalog declares for `annotate`, in the order the toolbar offers them. */
export const ANNOTATION_KINDS = ['highlight', 'underline', 'strike', 'note'] as const;

/**
 * Display colours, **a copy of the contract's defaults** (`options.ts`: `#ffe066`, `#1a73e8`, `#d93025`).
 *
 * A copy on purpose, like the harness's subtype table: the alternative is importing the schema into a browser bundle
 * to read three strings, and a copy that could disagree is visible in the diff that changes one of them. It is used
 * for the mark's own swatch on the canvas — never written to the option value, because a mark nobody recoloured should
 * carry the schema's default and not this file's idea of it.
 */
export const MARKUP_DISPLAY_COLOURS: Record<string, string> = {
  highlight: '#ffe066',
  underline: '#1a73e8',
  strike: '#d93025',
};

/** Kinds placed by a click: a note's icon box is fixed, so there is nothing to drag out. */
const POINT_KINDS = new Set(['note']);

/**
 * The box a new mark gets when the user clicks instead of dragging, in points.
 *
 * Markup defaults to a line-height band across a plausible sentence — what a drag over text produces — because a
 * square highlight is almost never what someone wants. A note's 20 pt is the engine's own `NOTE_ICON_PT`.
 */
const DEFAULT_SIZE: Record<string, { width: number; height: number }> = {
  highlight: { width: 200, height: 14 },
  underline: { width: 200, height: 4 },
  strike: { width: 200, height: 4 },
  note: { width: 20, height: 20 },
};

/** The engine's icon side, in points. */
const NOTE_ICON_PT = 20;

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function rectsOf(entry: Record<string, unknown>): AnnotationRect[] {
  const raw = entry.rects;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((rect): rect is Record<string, unknown> => typeof rect === 'object' && rect != null)
    .map((rect) => ({
      x: numberOf(rect.x, 0),
      y: numberOf(rect.y, 0),
      width: Math.max(MIN_BOX_POINTS, numberOf(rect.width, MIN_BOX_POINTS)),
      height: Math.max(MIN_BOX_POINTS, numberOf(rect.height, MIN_BOX_POINTS)),
    }));
}

/** Whether this entry is a shape the canvas can draw. Anything else is left to the JSON editor rather than guessed at. */
export function isAnnotationKind(value: unknown): value is string {
  return typeof value === 'string' && (ANNOTATION_KINDS as readonly string[]).includes(value);
}

/**
 * The option value → canvas marks.
 *
 * An entry the canvas cannot draw is dropped rather than coerced — the schema requires at least one rectangle per
 * markup kind, so an entry with none is input the API would refuse, and drawing it as a guess would be worse than not
 * drawing it.
 */
export function readAnnotations(value: unknown): PlacementItem[] {
  if (!Array.isArray(value)) return [];
  const items: PlacementItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue;
    const candidate = entry as Record<string, unknown>;
    if (!isAnnotationKind(candidate.type)) continue;
    const page = Math.max(1, Math.trunc(numberOf(candidate.page, 1)));
    if (candidate.type === 'note') {
      if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') continue;
      items.push({ kind: 'note', page, entry: { ...candidate, page, x: candidate.x, y: candidate.y } });
      continue;
    }
    const rects = rectsOf(candidate);
    if (rects.length === 0) continue;
    items.push({ kind: candidate.type, page, entry: { ...candidate, page, rects } });
  }
  return items;
}

/**
 * The rectangle the canvas draws for a mark: the union of a markup entry's rectangles, or a note's icon box.
 *
 * The union rather than the first rectangle, because the box is what the user grabs: a three-line highlight whose
 * handle sat on one line would make the other two unreachable.
 */
export function annotationBox(item: PlacementItem): Box | null {
  if (item.kind === 'note') {
    const x = numberOf(item.entry.x, 0);
    const y = numberOf(item.entry.y, 0);
    return { x, y, width: NOTE_ICON_PT, height: NOTE_ICON_PT };
  }
  const rects = rectsOf(item.entry);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const top = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: left,
    y: bottom,
    width: Math.max(MIN_BOX_POINTS, right - left),
    height: Math.max(MIN_BOX_POINTS, top - bottom),
  };
}

/**
 * Move or resize a mark.
 *
 * A single-rectangle mark — the common case, and every mark the canvas creates — is written exactly: the box's four
 * numbers go into the rectangle. A multi-rectangle mark is moved as a **unit**: translate when the size did not change,
 * and scale each rectangle about the union's lower-left corner when it did, which keeps the mark's internal spacing and
 * its alignment with the text it covers instead of collapsing it into one box.
 */
export function moveAnnotation(item: PlacementItem, box: Box): PlacementItem {
  if (item.kind === 'note') {
    return { ...item, entry: { ...item.entry, x: box.x, y: box.y } };
  }
  const rects = rectsOf(item.entry);
  const current = annotationBox(item);
  if (rects.length === 0 || !current) return item;
  const scaleX = current.width === 0 ? 1 : box.width / current.width;
  const scaleY = current.height === 0 ? 1 : box.height / current.height;
  const next = rects.map((rect) => ({
    x: box.x + (rect.x - current.x) * scaleX,
    y: box.y + (rect.y - current.y) * scaleY,
    width: Math.max(MIN_BOX_POINTS, rect.width * scaleX),
    height: Math.max(MIN_BOX_POINTS, rect.height * scaleY),
  }));
  return { ...item, entry: { ...item.entry, rects: next } };
}

/**
 * A new mark of `kind`.
 *
 * No `color` is written: an untouched mark keeps the schema's own default, and the display swatch above is only what
 * the canvas paints. A note is created with empty text — the schema requires the field, not a non-empty one — and the
 * row says so rather than silently submitting a note with nothing in it.
 */
export function createAnnotation(kind: string, page: number, box: Box): PlacementItem {
  if (kind === 'note') {
    return { kind, page, entry: { type: 'note', page, x: box.x, y: box.y, text: '' } };
  }
  return {
    kind,
    page,
    entry: { type: kind, page, rects: [{ x: box.x, y: box.y, width: box.width, height: box.height }] },
  };
}

/** What the list calls a mark: the kind, what it covers, and — for a note — what it says. */
export function annotationSummary(item: PlacementItem): string {
  if (item.kind === 'note') {
    const text = typeof item.entry.text === 'string' ? item.entry.text.trim() : '';
    if (text === '') return 'Empty note';
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  const rects = rectsOf(item.entry);
  const box = annotationBox(item);
  const coverage = box
    ? `${Math.round(box.width)} × ${Math.round(box.height)} pt at ${Math.round(box.x)}, ${Math.round(box.y)}`
    : 'no rectangle';
  return rects.length > 1 ? `${coverage} · ${rects.length} rectangles` : coverage;
}

/** The colour the canvas paints a mark in: the user's, or the kind's display default. */
export function displayColour(item: PlacementItem): string {
  const chosen = item.entry.color;
  if (typeof chosen === 'string' && /^#[0-9a-fA-F]{6}$/.test(chosen)) return chosen;
  return MARKUP_DISPLAY_COLOURS[item.kind] ?? '#ffe066';
}

export function annotationGeometry(kind: string): 'box' | 'point' {
  return POINT_KINDS.has(kind) ? 'point' : 'box';
}

export function annotationDefaultSize(kind: string): { width: number; height: number } {
  return DEFAULT_SIZE[kind] ?? { width: 200, height: 14 };
}
