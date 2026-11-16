import type { PlacementItem } from '../adapter';
import { type Box, MIN_BOX_POINTS } from '../geometry';

/**
 * The `redactions` placement shape — `redact`'s boxes, drawn on the same canvas as `edit-pdf`'s elements,
 * `annotate`'s marks and `sign`'s fields.
 *
 * Three facts about this contract decide everything below, and all three are read out of the schema
 * (`packages/contracts/src/tools/options.ts`) rather than chosen here:
 *
 * 1. **The rectangle is spelled `w`/`h`.** Every other placement contract in this build uses `width`/`height`
 *    (`EditElement`, `AnnotationElement`, `SignaturePlacement`); `RedactRect` is the one that does not. The canvas
 *    works in `Box`, which is `x`/`y`/`width`/`height`, so the translation lives here — in the one module that knows
 *    which contract it is writing.
 * 2. **A region is a *page group*, not a rectangle.** One entry carries a `page`, up to 20 rectangles and an optional
 *    per-page `fill` that overrides the job-wide one. The canvas keeps that shape: one canvas mark is one region, a new
 *    box is a region with one rectangle, and a region that arrived from JSON with several rectangles moves as a unit —
 *    the union is what the user grabs, exactly as `annotations.ts` treats a multi-line highlight.
 * 3. **The per-page `fill` is optional and has no schema default.** Unset means the job-wide `fill` applies, so the
 *    row's swatch is a *display* value and the canvas writes nothing to the entry until the user overrides it.
 */

/** The kinds the catalog declares for `redact`, in the order the toolbar offers them. One: a box. */
export const REDACTION_KINDS = ['box'] as const;

export const REDACTION_KIND = 'box';

/**
 * The bar the canvas paints for a box whose region carries no `fill` of its own.
 *
 * A display value, exactly like `MARKUP_DISPLAY_COLOURS`: it is the job-wide `fill`'s default (`#000000`) so the
 * preview matches what a job with no `fill` option would paint, and it is never written to the entry — an untouched
 * region keeps the job-wide option in force.
 */
export const REDACTION_DISPLAY_FILL = '#000000';

/** One rectangle, as `RedactRect` spells it. */
export interface RedactRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A region's rectangles, read defensively and clamped.
 *
 * `w`/`h` are positive in the schema, and a rectangle too small to hit anything is not a placement the canvas can
 * offer a handle for: the clamp is the same `MIN_BOX_POINTS` every other shape uses, so the drag angles agree.
 */
function rectsOf(entry: Record<string, unknown>): RedactRect[] {
  const raw = entry.rects;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((rect): rect is Record<string, unknown> => typeof rect === 'object' && rect != null)
    .map((rect) => ({
      x: numberOf(rect.x, 0),
      y: numberOf(rect.y, 0),
      w: Math.max(MIN_BOX_POINTS, numberOf(rect.w, MIN_BOX_POINTS)),
      h: Math.max(MIN_BOX_POINTS, numberOf(rect.h, MIN_BOX_POINTS)),
    }));
}

/**
 * The option value → canvas marks.
 *
 * A region with no rectangles is dropped rather than coerced: the schema requires at least one, so drawing a default
 * box for it would place a redaction nobody asked for — which is the one guess this tool must never make.
 */
export function readRedactions(value: unknown): PlacementItem[] {
  if (!Array.isArray(value)) return [];
  const items: PlacementItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue;
    const candidate = entry as Record<string, unknown>;
    const rects = rectsOf(candidate);
    if (rects.length === 0) continue;
    const page = Math.max(1, Math.trunc(numberOf(candidate.page, 1)));
    items.push({ kind: REDACTION_KIND, page, entry: { ...candidate, page, rects } });
  }
  return items;
}

/**
 * The rectangle the canvas draws for a region: the union of its rectangles.
 *
 * The union rather than the first rectangle, for the reason `annotations.ts` gives: the box is what the user grabs,
 * and a handle sitting on one of four rectangles would make the other three unreachable.
 */
export function redactionBox(item: PlacementItem): Box | null {
  const rects = rectsOf(item.entry);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {
    x: left,
    y: bottom,
    width: Math.max(MIN_BOX_POINTS, right - left),
    height: Math.max(MIN_BOX_POINTS, top - bottom),
  };
}

/**
 * Move or resize a region.
 *
 * A single-rectangle region — every region the canvas creates — is written exactly: the box's four numbers become the
 * rectangle's `x`/`y`/`w`/`h`. A multi-rectangle region is moved as a **unit**: translate when the size did not
 * change, and scale each rectangle about the union's lower-left corner when it did, so the region's internal spacing
 * is kept instead of collapsing into one box.
 */
export function moveRedaction(item: PlacementItem, box: Box): PlacementItem {
  const rects = rectsOf(item.entry);
  const current = redactionBox(item);
  if (rects.length === 0 || !current) return item;
  const scaleX = current.width === 0 ? 1 : box.width / current.width;
  const scaleY = current.height === 0 ? 1 : box.height / current.height;
  const next = rects.map((rect) => ({
    x: box.x + (rect.x - current.x) * scaleX,
    y: box.y + (rect.y - current.y) * scaleY,
    w: Math.max(MIN_BOX_POINTS, rect.w * scaleX),
    h: Math.max(MIN_BOX_POINTS, rect.h * scaleY),
  }));
  return { ...item, entry: { ...item.entry, rects: next } };
}

/**
 * A new region of `kind`, as one rectangle.
 *
 * No `fill` is written: an untouched region keeps the job-wide `fill` in force, and the schema's optional field is
 * the one that says so.
 */
export function createRedaction(page: number, box: Box): PlacementItem {
  return {
    kind: REDACTION_KIND,
    page,
    entry: { page, rects: [{ x: box.x, y: box.y, w: box.width, h: box.height }] },
  };
}

/** What the list calls a region: what it covers, how many rectangles it groups, and any fill of its own. */
export function redactionSummary(item: PlacementItem): string {
  const rects = rectsOf(item.entry);
  const box = redactionBox(item);
  const coverage = box
    ? `${Math.round(box.width)} × ${Math.round(box.height)} pt at ${Math.round(box.x)}, ${Math.round(box.y)}`
    : 'no rectangle';
  const fill = typeof item.entry.fill === 'string' ? ` · fill ${item.entry.fill}` : '';
  return rects.length > 1 ? `${coverage} · ${rects.length} rectangles${fill}` : `${coverage}${fill}`;
}

/** The colour the canvas paints a region in: the region's own `fill`, or the job-wide default it inherits. */
export function displayFill(item: PlacementItem): string {
  const chosen = item.entry.fill;
  if (typeof chosen === 'string' && /^#[0-9a-fA-F]{6}$/.test(chosen)) return chosen;
  return REDACTION_DISPLAY_FILL;
}

/** One kind, and it is a rectangle: a drag places *and* sizes it. */
export function redactionGeometry(): 'box' {
  return 'box';
}

/**
 * What a click (rather than a drag) produces: a line-height bar across a plausible run of text.
 *
 * The useful default for this tool is the shape a redaction actually takes — a line of an account number or a name —
 * and a square would be resized on every placement.
 */
export function redactionDefaultSize(): { width: number; height: number } {
  return { width: 240, height: 18 };
}
