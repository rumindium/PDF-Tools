import { CROP_MIN_KEPT_RATIO, expandPageSpecs } from '@pdftools/contracts/tools';
import { specsFromPages } from '../tool-shell/page-rows-model';

/**
 * The crop box as the board holds it (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.1, `0-UI-DESIGN.md` §6.4).
 *
 * `crop`'s `box` option is four **insets from the edges** — not a rectangle — and the units are the user's choice:
 * millimetres, points, or a percentage of the page. So the value has three readings and the screen has to keep them
 * straight while a pointer is moving:
 *
 * ```text
 * { top: 20, right: 20, bottom: 20, left: 20 }  +  units: 'mm'   →  20 mm off every edge
 * { top: 5,  right: 10, bottom: 5,  left: 10 }  +  units: 'percent' → 5 % off the height, 10 % off the width
 * ```
 *
 * Everything here is pure and lives in one module for the reason `features/placement/geometry.ts` gives: this is the
 * part that can be *wrong* without looking wrong. A sign flipped, an axis swapped, a percentage applied to the wrong
 * dimension — every one of those still draws a box, still produces a value and still submits, and the job simply
 * returns a page with the wrong strip missing. Percent is the one that bites hardest, because a percentage *is* per
 * axis: "trim 10 % of the width and 10 % of the height" is the documented reading, and applying one number to both
 * axes silently misses on every landscape page.
 *
 * ## The internal state is a fraction of each axis
 *
 * Four fractions of the page, `0..1`, one per edge — the units are a *presentation* of them, and the two conversions
 * to and from (`fractionsFromInsets`, `insetsFromFractions`) are the only place a unit appears. That is what lets the
 * drag arithmetic be measured in nothing at all: the pointer arrives in CSS pixels, the component divides by the
 * measured page element (one division, at the edge of the system) and everything below this line is in fractions,
 * where the aspect ratio of the render cannot reach it.
 *
 * ## What the engine refuses, and why the board refuses it first
 *
 * `workers/light/src/handlers/crop.ts` skips any page whose kept rectangle is smaller than `CROP_MIN_KEPT_RATIO` of the
 * page (a plausibility guard written for auto-crop, and enforced for both modes by the shared writing script). A user
 * who drags a 4 % box therefore watches a job come back `pagesSkipped: 1` with the page untouched, which reads as the
 * tool ignoring them. So the ratio is imported from the contracts rather than restated here, the drag clamps to it, and
 * a *typed* value that crosses it is refused with the engine's own reason instead of being silently widened.
 */

/** Millimetres per inch. The point is defined as 1/72 inch, so this is the only constant mm needs. */
const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;

/** The units the API accepts for a crop box. */
export type CropUnits = 'mm' | 'pt' | 'percent';

/** The option value: insets from each edge, in `units`. */
export interface CropInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The same insets as fractions of each axis — the board's own state, and the only thing the drag handler works in.
 *
 * `top` is measured from the **visual** top of the page as drawn, which is what a person means by it, and the handler
 * agrees: `box.top` becomes `height - top` in PDF user space (`boxFromInsets`), so the two never meet and never need
 * converting in this module.
 */
export interface CropFractions {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** What the board knows about the page it is drawing. */
export interface CropFrame {
  /** The page's own size in PDF points, as the renderer laid it out (so a rotated page is already the right way up). */
  widthPt: number;
  heightPt: number;
}

/** Which part of the box a gesture is holding. `'box'` is the whole rectangle, which moves rather than resizes. */
export type CropHandle =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'box';

export const CROP_HANDLES: readonly CropHandle[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'top',
  'right',
  'bottom',
  'left',
];

const EDGES: Array<keyof CropFractions> = ['top', 'right', 'bottom', 'left'];

/** How one edge is said, in a sentence. */
const EDGE_LABEL: Record<keyof CropFractions, string> = {
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  left: 'left',
};

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function emptyInsets(): CropInsets {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

export function wholePage(): CropFractions {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/** The option value as insets, with anything unusable read as zero — the same convention the schema's defaults have. */
export function readInsets(value: unknown): CropInsets {
  if (typeof value !== 'object' || value == null) return emptyInsets();
  const record = value as Record<string, unknown>;
  return {
    top: Math.max(0, numberOf(record.top)),
    right: Math.max(0, numberOf(record.right)),
    bottom: Math.max(0, numberOf(record.bottom)),
    left: Math.max(0, numberOf(record.left)),
  };
}

/** Points per unit on one axis. Percent is per axis by definition, which is why this takes the extent it applies to. */
function pointsPerUnit(units: CropUnits, extentPt: number): number {
  if (units === 'pt') return 1;
  if (units === 'mm') return POINTS_PER_INCH / MM_PER_INCH;
  return extentPt / 100;
}

/** The insets as fractions of the page. The only place a unit is read. */
export function fractionsFromInsets(insets: CropInsets, units: CropUnits, frame: CropFrame): CropFractions {
  const width = frame.widthPt > 0 ? frame.widthPt : 1;
  const height = frame.heightPt > 0 ? frame.heightPt : 1;
  return {
    top: (insets.top * pointsPerUnit(units, height)) / height,
    right: (insets.right * pointsPerUnit(units, width)) / width,
    bottom: (insets.bottom * pointsPerUnit(units, height)) / height,
    left: (insets.left * pointsPerUnit(units, width)) / width,
  };
}

/** The inverse, for writing the option. Rounded to what the API and a person both want to read. */
export function insetsFromFractions(fractions: CropFractions, units: CropUnits, frame: CropFrame): CropInsets {
  const width = frame.widthPt > 0 ? frame.widthPt : 1;
  const height = frame.heightPt > 0 ? frame.heightPt : 1;
  const perUnit = (extentPt: number) => 1 / pointsPerUnit(units, extentPt);
  const read = (fraction: number, extentPt: number) => {
    const value = fraction * extentPt * perUnit(extentPt);
    // Two decimals: the API takes any number, and the panel is a thing people read. A drag produces long tails of
    // binary fractions, and `20.000000000000004` mm is not a crop box anybody typed.
    return Math.round(Math.max(0, value) * 100) / 100;
  };
  return {
    top: read(fractions.top, height),
    right: read(fractions.right, width),
    bottom: read(fractions.bottom, height),
    left: read(fractions.left, width),
  };
}

/**
 * The kept area as a fraction of the page.
 *
 * The one number the engine's guard is about, and the one the sentence quotes: `width × height` of what survives.
 */
export function keptArea(fractions: CropFractions): number {
  const width = 1 - fractions.left - fractions.right;
  const height = 1 - fractions.top - fractions.bottom;
  return width <= 0 || height <= 0 ? 0 : width * height;
}

/**
 * Whether every edge is zero — a box that covers the page it is measured on.
 *
 * The request is still legal (`box` is present), which is why the sentence about it explains rather than refuses: see
 * `describeCrop`. It is reachable only by typing four zeros, because the catalog ships a default box.
 */
export function isWholePage(fractions: CropFractions): boolean {
  return EDGES.every((edge) => fractions[edge] === 0);
}

/**
 * The one number all four edges share, or `null` when they differ — what the "same on every edge" box shows.
 *
 * Compared **in the chosen units and not as fractions**, which is a distinction with a bite: 20 mm is the same length
 * on every edge, and four different fractions of a page (20 mm is a larger share of the width than of the height), so a
 * comparison in fraction space reports "mixed" for the most ordinary crop there is. Found by the sentence's own test.
 */
export function equalInsets(insets: CropInsets): number | null {
  const values = EDGES.map((edge) => insets[edge]);
  const first = values[0]!;
  return values.every((value) => Math.abs(value - first) < 1e-9) ? Math.round(first * 100) / 100 : null;
}

/** The four insets at one value — what typing into the "same on every edge" box writes. */
export function evenInsets(value: number): CropInsets {
  const clean = Math.max(0, value);
  return { top: clean, right: clean, bottom: clean, left: clean };
}

/**
 * Keep the box a box: no edge past the opposite one, and never a kept area the engine would refuse.
 *
 * The ratio floor is the engine's own guard (`CROP_MIN_KEPT_RATIO`), and it bites in the direction a drag goes: pulling
 * an edge inward past it stops the edge rather than submitting a page the handler will skip. It is a clamp and not a
 * refusal because a drag is a continuous gesture — the user is still moving the pointer, and the last position that
 * still means something is the right answer.
 */
export function clampFractions(fractions: CropFractions): CropFractions {
  const clamped = { ...fractions };
  for (const edge of EDGES) clamped[edge] = Math.min(Math.max(0, clamped[edge]), 1);

  // Keep at least a sliver on each axis first, so the ratio test below has a rectangle to talk about.
  const MIN_SLIVER = 0.01;
  if (clamped.left + clamped.right > 1 - MIN_SLIVER) {
    const total = clamped.left + clamped.right;
    const room = 1 - MIN_SLIVER;
    clamped.left = (clamped.left / total) * room;
    clamped.right = (clamped.right / total) * room;
  }
  if (clamped.top + clamped.bottom > 1 - MIN_SLIVER) {
    const total = clamped.top + clamped.bottom;
    const room = 1 - MIN_SLIVER;
    clamped.top = (clamped.top / total) * room;
    clamped.bottom = (clamped.bottom / total) * room;
  }

  //
  // Then the engine's guard, and the way it gives way is chosen rather than convenient: the kept rectangle grows
  // about its **centre**, so both axes scale by the same factor and the proportions of the trim survive. Shrinking
  // only the axis the pointer is on would satisfy the ratio too, and would silently turn a 20 %/5 % trim into an even
  // one.
  //
  // Two steps, not one, and the second was a defect the tests found: an axis that is already at the page's edge cannot
  // grow any further, so on a very flat box the proportional step lands *under* the ratio (`0.8 × 0.01` page keeps
  // 3.5 % with the width capped at 1) and the box would go on being a crop the handler skips. So whichever axis is not
  // already full takes the whole requirement — the box gives way until the area is legal, whichever wall it meets.
  //
  if (keptArea(clamped) < CROP_MIN_KEPT_RATIO) {
    const keptWidth = 1 - clamped.left - clamped.right;
    const keptHeight = 1 - clamped.top - clamped.bottom;
    const scale = Math.sqrt(CROP_MIN_KEPT_RATIO / Math.max(keptWidth * keptHeight, 1e-9));
    let width = Math.min(1, keptWidth * scale);
    let height = Math.min(1, keptHeight * scale);
    if (width * height < CROP_MIN_KEPT_RATIO) {
      if (width >= 1) height = Math.min(1, CROP_MIN_KEPT_RATIO / width);
      else width = Math.min(1, CROP_MIN_KEPT_RATIO / height);
    }
    const centred = (kept: number) => Math.min(Math.max(0, (1 - kept) / 2), 1);
    clamped.left = centred(width);
    clamped.right = clamped.left;
    clamped.top = centred(height);
    clamped.bottom = clamped.top;
  }
  return clamped;
}

/**
 * The box after one gesture step.
 *
 * `dx`/`dy` are **fractions of the page**, already divided by the measured element in the component — the pointer's
 * units stop here, which is what keeps this function free of a render size. Moving takes the whole box and stops it at
 * the page's edges; resizing moves the edges the handle owns and lets `clampFractions` refuse the rest.
 */
export function afterDrag(fractions: CropFractions, handle: CropHandle, dx: number, dy: number): CropFractions {
  if (handle === 'box') {
    // A box can only be *moved* into what it already keeps: the two insets of an axis shift by equal and opposite
    // amounts, so the rectangle travels without changing size and never leaves the page. Dragging it right by more
    // than the right inset would push its left edge off the page — so that is where it stops.
    const shiftX = Math.max(-fractions.left, Math.min(dx, fractions.right));
    const shiftY = Math.max(-fractions.top, Math.min(dy, fractions.bottom));
    return clampFractions({
      top: fractions.top + shiftY,
      bottom: fractions.bottom - shiftY,
      left: fractions.left + shiftX,
      right: fractions.right - shiftX,
    });
  }

  const next = { ...fractions };
  if (handle === 'top' || handle === 'top-left' || handle === 'top-right') next.top += dy;
  if (handle === 'bottom' || handle === 'bottom-left' || handle === 'bottom-right') next.bottom -= dy;
  if (handle === 'left' || handle === 'top-left' || handle === 'bottom-left') next.left += dx;
  if (handle === 'right' || handle === 'top-right' || handle === 'bottom-right') next.right -= dx;
  return clampFractions(next);
}

/** How much one arrow-key press moves a number box, per unit: a percentage reads better coarser than a millimetre. */
export function inputStep(units: CropUnits): number {
  return units === 'percent' ? 0.5 : units === 'mm' ? 1 : 2;
}

function say(value: number, units: CropUnits): string {
  const rounded = units === 'percent' ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100;
  return `${rounded} ${units === 'percent' ? '%' : units}`;
}

/** Two numbers sharing a unit, written once — `170 × 257 mm`, not `170 mm × 257 mm`. */
function pair(a: number, b: number, units: CropUnits): string {
  const rounded = (value: number) =>
    units === 'percent' ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100;
  return `${rounded(a)} × ${rounded(b)} ${units === 'percent' ? '%' : units}`;
}

/** Points as millimetres — only used to quote a page size in the unit the user is working in. */
function ptToUnits(points: number, units: CropUnits): number {
  return units === 'mm' ? points * (MM_PER_INCH / POINTS_PER_INCH) : points;
}

/**
 * The trimmed edges as clauses, with a pair that shares one value said once.
 *
 * `20 mm off both sides, 20 mm off the top and bottom` is the same request as four clauses and is a sentence a person
 * can check; four is a list they have to add up. Percent is where this reads worst ungrouped — a 20 mm trim is 9.53 % of
 * the width and 6.73 % of the height, so four clauses of two different numbers is the *ordinary* case there.
 *
 * Sides before top and bottom, matching the order the kept size is quoted in.
 */
function describeEdges(insets: CropInsets, units: CropUnits): string[] {
  const clauses: string[] = [];
  if (insets.left === insets.right && insets.left > 0) {
    clauses.push(`${say(insets.left, units)} off both sides`);
  } else {
    if (insets.left > 0) clauses.push(`${say(insets.left, units)} off the ${EDGE_LABEL.left}`);
    if (insets.right > 0) clauses.push(`${say(insets.right, units)} off the ${EDGE_LABEL.right}`);
  }
  if (insets.top === insets.bottom && insets.top > 0) {
    clauses.push(`${say(insets.top, units)} off the top and bottom`);
  } else {
    if (insets.top > 0) clauses.push(`${say(insets.top, units)} off the ${EDGE_LABEL.top}`);
    if (insets.bottom > 0) clauses.push(`${say(insets.bottom, units)} off the ${EDGE_LABEL.bottom}`);
  }
  return clauses;
}

/**
 * The sentence under the board: what the crop does, in the units the user chose.
 *
 * It quotes the *kept size* as well as the trim, because that is the fact a person is checking — "20 mm off every edge"
 * and "170 × 257 mm of a 210 × 297 mm page" are the same request and only the second one is what the page will look
 * like. The two refusals have sentences of their own, in the engine's own terms:
 *
 *  - **A whole-page box changes nothing.** The request is legal (`box` is present, so the handler's "`auto` or a `box`"
 *    rule is satisfied) and the job would come back with the document it went in with, which is a queue entry, a quota
 *    unit and a row in the user's history spent on a no-op. So the sentence says that outright rather than describing a
 *    crop that is not one. The state used to be the arrival state, back when the board could clear the key outright —
 *    that is now unreachable by clearing (the catalog ships a default box) and only happens if all four insets are
 *    typed as `0`.
 *  - **A box under the guard ratio** is skipped per page by the writing pass, so the output is the input plus a
 *    warning. Saying which one it is beats letting the user find out from `pagesSkipped`.
 */
/**
 * The pages a crop is written onto, or `null` for **every page**.
 *
 * `null` is not "unknown": `crop`'s `pages` is optional and an absent value means the whole document, which the handler
 * does explicitly (`options.pages ? … : every page`). The empty spelling has to survive to the model for that reason — a
 * board that answered `[]` for it would be saying "no pages are cropped" about a request that crops all of them, which is
 * the one wrong reading of this option that looks perfectly reasonable on screen.
 */
export function croppedPages(value: unknown, pageCount: number | null): number[] | null {
  const specs = Array.isArray(value)
    ? value.filter((spec): spec is string => typeof spec === 'string' && spec.trim() !== '')
    : [];
  if (specs.length === 0) return null;
  if (pageCount == null) return null;
  const pages = new Set<number>();
  for (const spec of specs) {
    try {
      for (const page of expandPageSpecs([spec], pageCount)) {
        if (page >= 1 && page <= pageCount) pages.add(page);
      }
    } catch {
      // A token the grammar refuses resolves to nothing here rather than throwing: the rows control is what reports it,
      // at the row it was typed in, and this function's job is to say which pages the value names.
    }
  }
  return [...pages].sort((left, right) => left - right);
}

/** Whether page `page` gets the box written onto it, given the option's current value. */
export function isCropped(value: unknown, page: number, pageCount: number | null): boolean {
  const named = croppedPages(value, pageCount);
  return named == null ? true : named.includes(page);
}

/**
 * The value after one page is taken out of (or put back into) the crop selection — what a click on a page tile does.
 *
 * Three outcomes, and each of them is a fact about this option rather than a preference:
 *
 *  - **`undefined`** once the set covers the whole document: "every page" has one spelling (the absent value), and
 *    writing a selection that names all of them would give the same request two forms to drift apart from.
 *  - **`null`** when the toggle cannot be expressed: a page outside the document, a document whose length is not known
 *    yet, and — the interesting one — **the last cropped page of a one-page document**. Taking that page out would
 *    leave an empty selection, and an empty selection *is* every page, so the button would silently do the opposite of
 *    what it says. Refusing to write is the honest answer, and the board disables the toggle there.
 *  - the new specs otherwise, through `specsFromPages` so a click in the middle of a range splits it (`1-5` minus page 3
 *    is `1-2` and `4-5`): the *set* changed, and the spelling follows it.
 */
export function toggleCroppedPage({
  value,
  page,
  pageCount,
}: {
  value: unknown;
  page: number;
  pageCount: number | null;
}): string[] | undefined | null {
  if (pageCount == null || page < 1 || page > pageCount) return null;
  const named = croppedPages(value, pageCount) ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  const next = new Set(named);
  if (next.has(page)) next.delete(page);
  else next.add(page);
  if (next.size === 0) return null;
  if (next.size === pageCount) return undefined;
  return specsFromPages([...next]);
}

export function describeCrop(
  fractions: CropFractions,
  units: CropUnits,
  frame: CropFrame,
): { sentence: string; tone: 'none' | 'changed' | 'blocked' } {
  const width = frame.widthPt > 0 ? frame.widthPt : 0;
  const height = frame.heightPt > 0 ? frame.heightPt : 0;
  if (width === 0 || height === 0) {
    return { sentence: 'Waiting for the page size before the crop can be drawn.', tone: 'none' };
  }

  const insets = insetsFromFractions(fractions, units, frame);
  const keptWidthPt = width * (1 - fractions.left - fractions.right);
  const keptHeightPt = height * (1 - fractions.top - fractions.bottom);

  if (isWholePage(fractions)) {
    return {
      sentence: 'This box is the whole page, so nothing would change — pull an edge in, or pick an even trim below.',
      tone: 'none',
    };
  }

  const size =
    units === 'percent'
      ? // Percent is per axis, so the sentence has to be: one share of the width and another of the height.
        `Keeps ${say(100 - insets.left - insets.right, 'percent')} of the width and ${say(
          100 - insets.top - insets.bottom,
          'percent',
        )} of the height`
      : `Keeps ${pair(ptToUnits(keptWidthPt, units), ptToUnits(keptHeightPt, units), units)} of a ${pair(
          ptToUnits(width, units),
          ptToUnits(height, units),
          units,
        )} page`;

  if (keptArea(fractions) < CROP_MIN_KEPT_RATIO) {
    return {
      sentence: `${size}, which this engine refuses: a crop that keeps less than ${Math.round(
        CROP_MIN_KEPT_RATIO * 100,
      )} % of the page is skipped and the page comes back untouched.`,
      tone: 'blocked',
    };
  }

  const common = equalInsets(insets);
  const everyEdge = common != null && common > 0;
  return {
    sentence: `${size} — ${
      everyEdge ? `${say(common, units)} off every edge` : `trimming ${describeEdges(insets, units).join(', ')}`
    }.`,
    tone: 'changed',
  };
}
