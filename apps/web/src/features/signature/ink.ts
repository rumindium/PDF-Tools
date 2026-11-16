/**
 * The signature pad's arithmetic, with no React and no canvas in it.
 *
 * A drawing surface has one job that can be wrong without looking wrong: turning what someone drew into the image that
 * gets placed on the page. Two decisions live here, and both are decisions a reader should be able to see rather than
 * infer from a pointer handler:
 *
 * 1. **The export is cropped to the ink.** A 520 × 200 pad exported whole would put a signature in a 520 × 200 pt box
 *    with most of it empty, because `sign` scales the image to the box it is given — so an untrimmed export would make
 *    every signature small and off-centre inside `fields`. Cropping to the ink's own rectangle plus a small padding
 *    makes "the box I dragged" and "the signature I drew" the same rectangle, which is what a user assumes.
 * 2. **The export keeps its aspect ratio, and the caller is told what it is.** The cropped pixels are turned into an
 *    image of the ink's size at a fixed scale; the resulting width/height are returned so the pad can offer a placement
 *    box of the same shape instead of squashing the ink into whatever the default box happened to be.
 *
 * Everything is measured in the pad's own CSS pixels. The pad scales for the device pixel ratio when it paints, and
 * that factor belongs to the renderer, not to the geometry: a stroke recorded at 2× and cropped at 1× would produce a
 * signature with a hard edge half a pixel in.
 */

export interface InkPoint {
  x: number;
  y: number;
}

/** One continuous line of ink — pointer-down to pointer-up. */
export type Stroke = InkPoint[];

export interface InkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle in the pad's own pixels: what gets copied out of the drawing surface. */
export interface TrimRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest export worth producing, in pad pixels.
 *
 * A tap is not a signature: one dot of ink at 2 px would export a 2 × 2 image and `sign` would scale it into the
 * placement box as a smudge. Below this the pad keeps the box but refuses to call it a signature — the caller decides
 * what to say about that, and the check is here rather than in the component so it is testable.
 */
export const MIN_INK_SIDE = 6;

/** Padding added around the ink, in pad pixels, so a stroke's width and any smoothing are not clipped. */
export const INK_PADDING = 6;

/** Non-finite or missing coordinates are dropped rather than coerced: a `NaN` in a bounding box spreads to every
 * number computed from it, and the failure then appears as an empty or full-page export rather than as a bad point. */
function usable(point: InkPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** The rectangle containing every stroke, or `null` when nothing usable was drawn. */
export function inkBounds(strokes: Stroke[]): InkBounds | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let seen = 0;
  for (const stroke of strokes) {
    for (const point of stroke) {
      if (!usable(point)) continue;
      seen += 1;
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }
  if (seen === 0) return null;
  return { left, top, right, bottom };
}

/**
 * The rectangle to copy out of the pad, clipped to the pad itself.
 *
 * Clipping matters because a pointer can leave the surface while drawing — the pad keeps receiving points through
 * pointer capture — so the ink's bounds can extend past the canvas. Copying a rectangle that starts outside it would
 * silently shift the image (`drawImage` accepts out-of-bounds source rectangles and paints the intersection at the
 * destination offset), which shows up as a signature offset by exactly the amount the user drew past the edge.
 */
export function trimRect(
  bounds: InkBounds,
  canvas: { width: number; height: number },
  padding = INK_PADDING,
): TrimRect {
  const left = Math.max(0, bounds.left - padding);
  const top = Math.max(0, bounds.top - padding);
  const right = Math.min(canvas.width, bounds.right + padding);
  const bottom = Math.min(canvas.height, bounds.bottom + padding);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Whether there is enough ink to be a signature rather than a tap. */
export function hasSignatureInk(bounds: InkBounds | null): boolean {
  if (!bounds) return false;
  return bounds.right - bounds.left >= MIN_INK_SIDE && bounds.bottom - bounds.top >= MIN_INK_SIDE;
}

/**
 * The scale an export is rasterised at, relative to the pad's CSS pixels.
 *
 * 3× is ~220 dpi at the pad's usual size, which is where a thin stroke stops showing the stair-steps a JPEG-free PNG
 * would otherwise keep forever in the signed document. The pad paints at the device pixel ratio; this is a second,
 * independent factor, because a 1× screen still deserves a signature that does not look pixelated when printed.
 */
export const EXPORT_SCALE = 3;

/** The exported image's pixel size, and the last guard against a zero-sized canvas (which throws on `drawImage`). */
export function exportSize(rect: TrimRect, scale = EXPORT_SCALE): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

/**
 * The widest aspect ratio a suggested box may have, relative to its height.
 *
 * A signature is a wide, flat mark — 6:1 is about a long flourish on a contract line — and the cap exists because the
 * alternative is not a big number but a nonsense one: someone who signs with a single horizontal stroke without lifting
 * the pen has, say, 300 × 6 px of ink, and an unclamped suggestion would be 3 000 pt wide on a 595 pt page. The user's
 * own drag decides the real box; this is a *suggestion*, and a suggestion wider than the paper is worse than a modest
 * one.
 */
export const MAX_INK_ASPECT = 6;

/**
 * The placement box a freshly drawn signature deserves, in points.
 *
 * The ink's aspect ratio is kept and the height is fixed at the contract's own default: a signature drawn wide and flat
 * (which is what handwriting is) then lands on the page at the height the tool suggests and the width its own shape
 * implies, instead of being stretched into a 180 × 60 box whose ratio has nothing to do with what was drawn. The ratio
 * is capped (`MAX_INK_ASPECT`), and the height is floored at one pixel of ink so a flat stroke cannot divide by zero
 * into an infinite width.
 */
export function placementForInk(
  rect: TrimRect,
  defaultSize: { width: number; height: number },
): { width: number; height: number } {
  const aspect = Math.min(MAX_INK_ASPECT, rect.width / Math.max(1, rect.height));
  return { width: Math.round(defaultSize.height * aspect), height: defaultSize.height };
}

/** An SVG path through a stroke's points, for the pad's own preview of what has been drawn. */
export function strokePath(stroke: Stroke): string {
  const points = stroke.filter(usable);
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [only] = points as [InkPoint];
    // A dot: a zero-length line with a round cap is a circle in SVG, which is what a tap should look like.
    return `M ${only.x} ${only.y} l 0.01 0`;
  }
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}
