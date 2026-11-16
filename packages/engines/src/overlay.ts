import { stat, writeFile } from 'node:fs/promises';
import { config } from '@pdftools/config';
import { JobFailure } from '@pdftools/errors';
import { parseJsonLine, runPythonScript } from './python';
import { type RunOptions, runOrThrow } from './run';

/**
 * The page-decoration pipeline shared by `page-numbers`, `header-footer`, `watermark`, and `edit-pdf`
 * (`docs/11-WATERMARK.md` §4): build a small overlay PDF, then merge it onto the target pages.
 *
 * Two engines, one for each half, and the split is the whole idea: an overlay is *content drawn on a blank page*,
 * so it can be produced by a drawing engine and merged by a page-tree engine. Neither has to edit the target's
 * content streams, which is where PDF decoration implementations usually break documents.
 *
 * The documented recipe uses ReportLab through Python. That package is not in the worker images, and the overlay is
 * the one place where PostScript is genuinely the better tool: `stringwidth` measures the string being drawn, so
 * centring is exact for whatever font and size the user picked — no font metrics table to embed, and no approximate
 * character-width arithmetic that silently drifts. Ghostscript renders the PostScript to a real PDF whose text is
 * *text* (extractable, searchable, selectable), not a raster of text.
 *
 * Merging is pikepdf's `add_overlay`/`add_underlay`: it takes an explicit page→page map, so a document with mixed
 * page sizes gets an overlay sized for each target page rather than one stretched across all of them.
 */

/** Where a placement sits on the page. The six anchors are the ones the products expose. */
export type OverlayAnchor = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-center' | 'top-left' | 'top-right';

export interface OverlayPlacement {
  text: string;
  /** PostScript font name (`Helvetica`, `Times-Roman`, `Courier-Bold`…). Validated by the caller. */
  font: string;
  sizePt: number;
  /** 0–1 per channel, because that is what `setrgbcolor` takes. */
  color: [number, number, number];
  anchor: OverlayAnchor;
  marginPt: number;
  /**
   * Where the stamp's *visual centre* goes, in points from the page's bottom-left.
   *
   * Watermarks place by centre because that is the only point that stays put when the stamp is rotated: a corner
   * placement rotated 45° about its baseline drifts by half its own width. `page-numbers` leaves this unset and uses
   * the anchor rule below, whose baseline arithmetic is what a page number needs.
   */
  centerPt?: { x: number; y: number };
  /** Rotation about the stamp's centre, in degrees, positive counter-clockwise. */
  rotationDeg?: number;
  /**
   * Where the text's **baseline** starts, in points from the bottom-left — placed, not centred.
   *
   * The third placement mode, and the one an editor needs. `anchor` is page-relative (six fixed positions with a
   * margin), `centerPt` centres the stamp on a point (right for a watermark, wrong for a line of text: the caller
   * would have to measure the string to work out where its centre is, which is the measurement this module exists to
   * do). A text box the user dragged has a *start*, so that is what it gives. When both this and `centerPt` are set,
   * this wins — the more specific instruction.
   */
  baselinePt?: { x: number; y: number };
}

/**
 * A horizontal rule on an overlay page — the line a header or footer band draws under or above its text
 * (`docs/12-PAGE-NUMBERS-HEADERS-FOOTERS.md` §2, the `rule` option).
 *
 * It is part of the page rather than of a placement because it is not text: it needs no font, no measurement and no
 * anchor, just two points and a width. Keeping it separate is also what lets the rule survive a band whose zones are
 * all empty, which is a legitimate request ("a line under the header, no words in it").
 */
export interface OverlayRule {
  /** Where the line sits, in points from the page's bottom edge. */
  yPt: number;
  /** The line's span, in points from the page's left edge. */
  fromPt: number;
  toPt: number;
  color: [number, number, number];
  thicknessPt: number;
}

export interface OverlayPage {
  widthPt: number;
  heightPt: number;
  placements: OverlayPlacement[];
  /** Drawn after the placements, so a rule cannot be hidden by the glyphs it belongs to. */
  rules?: OverlayRule[];
  /** Drawn **before** the placements, so a rect cannot cover the text that belongs to it (`edit-pdf`). */
  vectors?: OverlayVector[];
}

/**
 * Everything on a page that is a path rather than a glyph: the shapes `edit-pdf` places.
 *
 * One type with a `kind` discriminator rather than five interfaces, because the difference between them is a handful
 * of path operators — and because the caller has to be able to put them in one list on one overlay page. A
 * `checkbox` is a `rect` plus a tick, an `arrow` is a `line` plus a head, and a `polyline` is the freehand path the
 * editor collects; treating them as separate concepts would put four copies of "set the colour, then stroke" in the
 * builder.
 *
 * The geometry is in PDF user space — points from the page's **bottom-left** — like every other measurement in this
 * module. A client whose canvas has its origin at the top-left (a browser does) flips `y` at the boundary, which is
 * one subtraction; the reverse would mean this module lying about the coordinate system it draws in.
 */
export interface OverlayVector {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow' | 'polyline' | 'checkbox';
  /** Bottom-left of the box for `rect`/`ellipse`/`checkbox`; the start point for `line`/`arrow`. */
  xPt: number;
  yPt: number;
  /** Box size. For `line`/`arrow` these are the *delta* to the end point, which is how a drag reports it. */
  widthPt: number;
  heightPt: number;
  stroke: [number, number, number] | null;
  fill: [number, number, number] | null;
  strokeWidthPt: number;
  /** `polyline` only: absolute points, the first being where the pen goes down. */
  points?: Array<{ x: number; y: number }>;
  /** `checkbox` only: whether the tick is drawn inside the box. */
  checked?: boolean;
}

/**
 * Escape a PostScript literal string.
 *
 * `(`, `)` and `\` are the three characters that end or corrupt a literal string, and the text here can come from a
 * user (a watermark reading `Invoice (draft) \ 2026`). A backslash-escaped form is the only safe spelling; anything
 * non-ASCII is passed through as bytes, which Ghostscript maps with the font's own encoding.
 */
export function escapePostScriptText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * The baseline and horizontal rule for one placement.
 *
 * The vertical half has to be computed here because PostScript only measures *width*; the horizontal half is left to
 * the program (`stringwidth`), which is what makes centring exact. `0.8 × size` is the cap height used for the top
 * anchors, so a top margin of 12 mm puts the *text* 12 mm down rather than its ascender line.
 */
export function placementGeometry(
  placement: Pick<OverlayPlacement, 'anchor' | 'sizePt' | 'marginPt'>,
  pageHeightPt: number,
): { rule: 'left' | 'center' | 'right'; baselinePt: number } {
  const baseline = placement.anchor.startsWith('bottom')
    ? placement.marginPt
    : Math.max(placement.marginPt, pageHeightPt - placement.marginPt - placement.sizePt * 0.8);
  return {
    rule: placement.anchor.endsWith('left') ? 'left' : placement.anchor.endsWith('right') ? 'right' : 'center',
    baselinePt: baseline,
  };
}

/**
 * A mark's own rectangle, in PDF user space, on the 1-based page it was asked for.
 *
 * Structural rather than a named import: `PageBox` lives in `signatures.ts`, which already imports this module, and a
 * type import back the other way would make the dependency a cycle.
 */
export interface MarkBox {
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

/**
 * Which marks extend past the edge of the page they were placed on.
 *
 * `docs/13-EDIT-AND-ANNOTATE.md` §3 promises `ELEMENT_OFF_PAGE` for a mark that only *partly* leaves its page — the
 * user's mark is real and merely larger than the paper — and the sentence belongs to a job that would otherwise report
 * success over a mark nobody can see. A page the document does not have is deliberately **not** this function's
 * business: every handler here refuses those earlier and by name, because "page 99" is a coordinate mistake rather
 * than a mark that hangs off an edge.
 *
 * The tolerance is the same `0.01 pt` `planSignaturePlacements` uses, for the same reason: a rectangle drawn exactly
 * on the page's own edge rounds in floating point and would otherwise be reported as off-page forever.
 */
export function marksOutsidePage(
  boxes: readonly { widthPt: number; heightPt: number }[],
  marks: readonly MarkBox[],
): number[] {
  const outside: number[] = [];
  marks.forEach((mark, index) => {
    const box = boxes[mark.page - 1];
    if (!box) return;
    if (
      mark.xPt < -OFF_PAGE_TOLERANCE_PT ||
      mark.yPt < -OFF_PAGE_TOLERANCE_PT ||
      mark.xPt + mark.widthPt > box.widthPt + OFF_PAGE_TOLERANCE_PT ||
      mark.yPt + mark.heightPt > box.heightPt + OFF_PAGE_TOLERANCE_PT
    ) {
      outside.push(index);
    }
  });
  return outside;
}

const OFF_PAGE_TOLERANCE_PT = 0.01;

/** One PostScript program producing one overlay page per entry. Pure, so the geometry is unit-testable. */
export function buildOverlayPostScript(pages: OverlayPage[]): string {
  if (pages.length === 0) throw new Error('buildOverlayPostScript needs at least one overlay page');
  const lines = ['%!PS-Adobe-3.0'];
  for (const page of pages) {
    lines.push(`<< /PageSize [${round(page.widthPt)} ${round(page.heightPt)}] >> setpagedevice`);
    for (const vector of page.vectors ?? []) lines.push(...buildVectorOps(vector));
    for (const placement of page.placements) {
      const [r, g, b] = placement.color;
      const font = `/${placement.font} findfont ${round(placement.sizePt)} scalefont setfont`;
      const start = placement.baselinePt;
      if (start) {
        // Placed text: one point, no measurement. A rotation turns about that point, which is where a text box's
        // corner is when the user rotates it — not about the centre of the string it happens to contain.
        const rotation = placement.rotationDeg ?? 0;
        lines.push('gsave');
        lines.push(`${round(start.x)} ${round(start.y)} translate`);
        if (rotation !== 0) lines.push(`${round(rotation)} rotate`);
        lines.push(font);
        lines.push(`${r} ${g} ${b} setrgbcolor`);
        lines.push(`/txt (${escapePostScriptText(placement.text)}) def`);
        lines.push('0 0 moveto txt show');
        lines.push('grestore');
        continue;
      }
      const center = placement.centerPt;
      if (center) {
        // Centre-placed stamps: the pivot is the stamp's middle, and the baseline sits half a cap height below it.
        // PostScript has no ascender metric to ask for, so `0.35 × size` stands in — the same approximation the
        // centred branch of the anchor rule uses, which keeps one rotated stamp and one unrotated stamp on the
        // same line agreeing about where "centre" is.
        const rotation = placement.rotationDeg ?? 0;
        if (rotation !== 0) {
          lines.push('gsave');
          lines.push(`${round(center.x)} ${round(center.y)} translate`);
          lines.push(`${round(rotation)} rotate`);
        }
        lines.push(font);
        lines.push(`${r} ${g} ${b} setrgbcolor`);
        lines.push(`/txt (${escapePostScriptText(placement.text)}) def`);
        lines.push('/tw txt stringwidth pop def');
        // `cx − tw/2`, not `(cx − tw)/2`: the latter centres only when the centre *is* the page width, which is true
        // of the anchor branch below (and is why the same expression is right there) but false for every stamp the
        // layout places. Getting it wrong pushed a long stamp half its width to the left, off the page — and the text
        // still extracted, just with its first characters clipped, so only reading the rendered page showed it.
        const x = rotation !== 0 ? 'tw -2 div' : `${round(center.x)} tw 2 div sub`;
        const y =
          rotation !== 0 ? `${round(-placement.sizePt * 0.35)}` : `${round(center.y - placement.sizePt * 0.35)}`;
        lines.push(`${x} ${y} moveto txt show`);
        if (rotation !== 0) lines.push('grestore');
        continue;
      }
      const { rule, baselinePt } = placementGeometry(placement, page.heightPt);
      lines.push(font);
      lines.push(`${r} ${g} ${b} setrgbcolor`);
      lines.push(`/txt (${escapePostScriptText(placement.text)}) def`);
      lines.push('/tw txt stringwidth pop def');
      const x =
        rule === 'left'
          ? `${round(placement.marginPt)}`
          : rule === 'right'
            ? `${round(page.widthPt - placement.marginPt)} tw sub`
            : `${round(page.widthPt)} tw sub 2 div`;
      lines.push(`${x} ${round(baselinePt)} moveto txt show`);
    }
    for (const rule of page.rules ?? []) {
      const [r, g, b] = rule.color;
      lines.push(`${round(rule.thicknessPt)} setlinewidth`);
      lines.push(`${r} ${g} ${b} setrgbcolor`);
      lines.push(`${round(rule.fromPt)} ${round(rule.yPt)} moveto`);
      lines.push(`${round(rule.toPt)} ${round(rule.yPt)} lineto stroke`);
    }
    lines.push('showpage');
  }
  return `${lines.join('\n')}\n`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A rectangle as a PostScript path.
 *
 * Four segments and a `closepath`, because PostScript has no rectangle operator. `rect` looks like one — it is a PDF
 * operator, and it is spelled the same way in half the code in this repository — and asking Ghostscript for it aborts
 * the job with `Error: /undefined in rect`, which is how the `edit-pdf` vector cases failed the first time they ran.
 * The unit tests assert this path rather than the operation name, since the name was the part that was wrong.
 */
function rectPath(x: number, y: number, width: number, height: number): string[] {
  return [
    `${round(x)} ${round(y)} moveto`,
    `${round(width)} 0 rlineto`,
    `0 ${round(height)} rlineto`,
    `${round(-width)} 0 rlineto`,
    'closepath',
  ];
}

/** How far a circle's control points sit from its edge, as a share of the radius — the standard 4-arc circle. */
const ELLIPSE_KAPPA = 0.5523;

/** An arrow head is this long, and this wide, unless the line it caps is shorter than that. */
const ARROW_HEAD_PT = 9;
const ARROW_SPREAD_DEG = 26;

/**
 * The PostScript for one vector, as complete save/restore-wrapped operations.
 *
 * Exported because the geometry is the part worth unit-testing: the operation names are Ghostscript's business, but
 * "where do the two ends of this arrow actually land" is arithmetic, and it is the arithmetic that is wrong when an
 * arrow points the wrong way.
 *
 * Three details are deliberate:
 *  - **Fill before stroke.** A shape with both a fill and a stroke that strokes first has its outline half covered by
 *    its own fill, which makes a 1 pt border look like 0.5 pt.
 *  - **A rectangle is four line segments, not the `rect` operator.** `x y w h rect` is a **PDF** operator: Ghostscript
 *    answers it with `Error: /undefined in rect` and the whole overlay job fails. PostScript has no rectangle
 *    primitive, so the path is built explicitly — and this is written down here because the first version assumed
 *    otherwise and no unit test could catch it (see `rectPath`).
 *  - **`curveto` rather than line segments.** A 4-bezier ellipse is what makes a circle smooth at print resolution
 *    instead of a 64-gon.
 *  - **Round caps and joins.** Freehand `draw` is a series of short segments, and butt caps turn a squiggle into a
 *    dashed line. It costs three operators and only applies to the paths that need it.
 */
export function buildVectorOps(vector: OverlayVector): string[] {
  const ops: string[] = [`% vector: ${vector.kind}`];
  const stroke = vector.stroke ?? null;
  const fill = vector.fill ?? null;
  const lineWidth = Math.max(0.1, vector.strokeWidthPt);

  const paint = (pathOps: string[]): string[] => {
    const out: string[] = [];
    if (fill) {
      const [r, g, b] = fill;
      out.push('gsave', `${r} ${g} ${b} setrgbcolor`, ...pathOps, 'fill', 'grestore');
    }
    if (stroke) {
      const [r, g, b] = stroke;
      out.push(
        'gsave',
        `${r} ${g} ${b} setrgbcolor`,
        `${round(lineWidth)} setlinewidth`,
        '1 setlinejoin',
        '1 setlinecap',
        ...pathOps,
        'stroke',
        'grestore',
      );
    }
    if (!fill && !stroke) {
      // Neither colour set: the vector would be invisible, which is never what the caller meant. Draw it in black
      // rather than silently producing nothing, and let the handler warn.
      out.push('gsave', '0 0 0 setrgbcolor', `${round(lineWidth)} setlinewidth`, ...pathOps, 'stroke', 'grestore');
    }
    return out;
  };

  const { xPt, yPt, widthPt, heightPt } = vector;
  switch (vector.kind) {
    case 'rect':
    case 'checkbox': {
      ops.push(...paint(rectPath(xPt, yPt, widthPt, heightPt)));
      if (vector.kind === 'checkbox' && vector.checked) {
        // A tick inside the box, inset by a fifth: the shape of the glyph depends on the aspect ratio, so it is
        // drawn as a two-segment polyline whose elbow sits low-left, the way a handwritten tick does.
        const insetX = widthPt * 0.22;
        const insetY = heightPt * 0.22;
        const x0 = xPt + insetX;
        const x1 = xPt + widthPt * 0.42;
        const x2 = xPt + widthPt - insetX;
        const y0 = yPt + insetY;
        const y1 = yPt + heightPt - insetY;
        const [r, g, b] = stroke ?? fill ?? [0, 0, 0];
        ops.push(
          'gsave',
          `${r} ${g} ${b} setrgbcolor`,
          `${round(Math.max(1, lineWidth * 1.6))} setlinewidth`,
          '1 setlinejoin',
          '1 setlinecap',
          `${round(x0)} ${round(y0)} moveto`,
          `${round(x1)} ${round(y0 + (y1 - y0) * 0.35)} lineto`,
          `${round(x2)} ${round(y1)} lineto`,
          'stroke',
          'grestore',
        );
      }
      break;
    }
    case 'ellipse': {
      const centerX = xPt + widthPt / 2;
      const centerY = yPt + heightPt / 2;
      const radiusX = widthPt / 2;
      const radiusY = heightPt / 2;
      const kx = radiusX * ELLIPSE_KAPPA;
      const ky = radiusY * ELLIPSE_KAPPA;
      ops.push(
        ...paint([
          `${round(centerX + radiusX)} ${round(centerY)} moveto`,
          `${round(centerX + radiusX)} ${round(centerY + ky)} ${round(centerX + kx)} ${round(centerY + radiusY)} ${round(centerX)} ${round(centerY + radiusY)} curveto`,
          `${round(centerX - kx)} ${round(centerY + radiusY)} ${round(centerX - radiusX)} ${round(centerY + ky)} ${round(centerX - radiusX)} ${round(centerY)} curveto`,
          `${round(centerX - radiusX)} ${round(centerY - ky)} ${round(centerX - kx)} ${round(centerY - radiusY)} ${round(centerX)} ${round(centerY - radiusY)} curveto`,
          `${round(centerX + kx)} ${round(centerY - radiusY)} ${round(centerX + radiusX)} ${round(centerY - ky)} ${round(centerX + radiusX)} ${round(centerY)} curveto`,
          'closepath',
        ]),
      );
      break;
    }
    case 'line':
    case 'arrow': {
      const endX = xPt + widthPt;
      const endY = yPt + heightPt;
      ops.push(...paint([`${round(xPt)} ${round(yPt)} moveto`, `${round(endX)} ${round(endY)} lineto`]));
      if (vector.kind === 'arrow') {
        const length = Math.hypot(widthPt, heightPt);
        if (length > 0.5) {
          // Two wings, drawn backwards from the tip at a fixed spread. Both polar and cartesian: the angle says which
          // way the line points, and the wings are the two directions `angle + π ± spread/2` away from it. The head is
          // capped at a share of the line so a very short arrow does not become all head.
          const headPt = Math.min(ARROW_HEAD_PT, length * 0.45);
          const back = Math.atan2(heightPt, widthPt) + Math.PI;
          const spread = (ARROW_SPREAD_DEG * Math.PI) / 180;
          const [r, g, b] = stroke ?? fill ?? [0, 0, 0];
          ops.push('gsave', `${r} ${g} ${b} setrgbcolor`, `${round(lineWidth)} setlinewidth`, '1 setlinecap');
          for (const side of [1, -1]) {
            const wingAngle = back + (side * spread) / 2;
            ops.push(
              `${round(endX)} ${round(endY)} moveto`,
              `${round(endX + Math.cos(wingAngle) * headPt)} ${round(endY + Math.sin(wingAngle) * headPt)} lineto stroke`,
            );
          }
          ops.push('grestore');
        }
      }
      break;
    }
    case 'polyline': {
      const points = vector.points ?? [];
      if (points.length >= 2) {
        const path = [`${round(points[0]!.x)} ${round(points[0]!.y)} moveto`];
        for (const point of points.slice(1)) path.push(`${round(point.x)} ${round(point.y)} lineto`);
        ops.push(...paint(path));
      }
      break;
    }
  }
  return ops;
}

/** Where a watermark sits, as the set of points its stamps are centred on (`docs/11-WATERMARK.md` §2). */
export type WatermarkPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'tile';

/** Corner stamps sit this far from the edge, as a share of the page — a watermark has no margin option. */
const WATERMARK_EDGE_INSET = 0.05;

/** Tile gaps default to the documented 35 % of the page, and a gap of zero is refused rather than looping forever. */
export const WATERMARK_TILE_DEFAULT_PERCENT = 35;

/**
 * The gap range (`11-WATERMARK.md` §2/§6), mirrored from the schema because the packages are not allowed to import each
 * other: the gap *is* a stamp count (`round(100 / gap)` per axis), so 1 % would be 10 000 placements on one page. The
 * schema refuses it by name; this clamp is what keeps a direct engine caller from building the program anyway.
 */
export const WATERMARK_TILE_MIN_PERCENT = 10;
export const WATERMARK_TILE_MAX_PERCENT = 90;

/**
 * The stamp centres for one page.
 *
 * Tiling derives the *number* of rows and columns from the gap the user asked for rather than laying out a fixed
 * grid and ignoring it: a 35 % gap should read as "roughly three stamps across", and the resulting centres are
 * then spread evenly so the pattern is symmetric instead of aligned to the top-left corner.
 *
 * A rotated corner stamp still centres on its anchor point, so a 45° diagonal at `bottom-left` rotates about the
 * point 5 % in from the corner. On a narrow page the tips can extend past the edge and are clipped by the target
 * page during the merge, which is the behaviour a watermark wants — refusing to draw it would be the surprise.
 */
export function watermarkStampPoints(
  position: WatermarkPosition,
  tile: { x?: number; y?: number } | undefined,
  widthPt: number,
  heightPt: number,
): Array<{ x: number; y: number }> {
  if (position !== 'tile') {
    const insetX = widthPt * WATERMARK_EDGE_INSET;
    const insetY = heightPt * WATERMARK_EDGE_INSET;
    switch (position) {
      case 'top-left':
        return [{ x: insetX, y: heightPt - insetY }];
      case 'top-right':
        return [{ x: widthPt - insetX, y: heightPt - insetY }];
      case 'bottom-left':
        return [{ x: insetX, y: insetY }];
      case 'bottom-right':
        return [{ x: widthPt - insetX, y: insetY }];
      default:
        return [{ x: widthPt / 2, y: heightPt / 2 }];
    }
  }

  const gapXPercent = saneGap(tile?.x);
  const gapYPercent = saneGap(tile?.y);
  const columns = Math.max(1, Math.round(100 / gapXPercent));
  const rows = Math.max(1, Math.round(100 / gapYPercent));
  const points: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push({
        x: (widthPt * (column + 0.5)) / columns,
        y: (heightPt * (row + 0.5)) / rows,
      });
    }
  }
  return points;
}

function saneGap(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return WATERMARK_TILE_DEFAULT_PERCENT;
  return Math.min(WATERMARK_TILE_MAX_PERCENT, Math.max(WATERMARK_TILE_MIN_PERCENT, value));
}

export interface ImageStampPage {
  widthPt: number;
  heightPt: number;
  /**
   * Stamps, each centred on `x`/`y`.
   *
   * A stamp may carry its **own box** (`widthPt`/`heightPt`), which wins over the page-level sizing rule below. That
   * is what an editor needs: `edit-pdf` places an image at a rectangle the user dragged, so two images on one page
   * legitimately have two different sizes, and a page-level `scalePercent` cannot express that. The watermark and the
   * header logo leave both unset and keep the "share of the page" / "8 mm tall" rules they were built on.
   */
  stamps: Array<{
    x: number;
    y: number;
    rotationDeg: number;
    widthPt?: number;
    heightPt?: number;
    /**
     * How an image reaches its explicit box.
     *
     * `stretch` (the default) fills the box exactly; `contain` keeps the bitmap's aspect ratio and centres it, which
     * is what `sign` needs — a drawn signature squeezed to a box the user dragged is a different signature, and the
     * distortion is invisible to every structural assertion.
     */
    fit?: 'stretch' | 'contain';
  }>;
  /** The image's width as a share of this page's width. Used when `imageHeightPt` is not set. */
  scalePercent?: number;
  /**
   * The image's height in points, with the width following from the image's own aspect ratio.
   *
   * A watermark is sized by width (`scalePercent`: "about half the page") and a logo in a header band is sized by
   * height ("8 mm tall"), and both have to work without the caller knowing the aspect ratio — which is why the
   * sizing lives next to the image the engine has already opened rather than in the caller.
   */
  imageHeightPt?: number;
}

/**
 * Build an overlay PDF whose pages contain an image stamp.
 *
 * The text path goes through Ghostscript because a font is the one thing only a typesetter can do. An image needs a
 * different tool: it is a bitmap that has to be placed with a matrix, so the overlay is assembled directly with
 * pikepdf — one `/XObject` stream plus a `cm`/`Do` per stamp. PNG alpha becomes a real `/SMask`, which is what
 * keeps a transparent logo from arriving as a white rectangle, and the stamps share one image stream so a tiled
 * overlay costs one copy of the pixels, not one per tile.
 *
 * `opacity` is *not* applied here. It is applied once to the finished overlay page as a constant fill alpha, so text
 * and image watermarks attenuate through the same mechanism and an image's own per-pixel alpha multiplies with it.
 *
 * The matrices are computed here, in Python, from the stamp centres the caller derived in TypeScript: keeping the
 * arithmetic next to the `cm` it feeds avoids a second, drifting copy of it.
 *
 * **Every stamp gets its own `q`/`Q`, and that is a correctness requirement rather than style.** One pair around a
 * run of `cm ... Do` sequences produces a file that reads as if it stamped N images and a renderer that paints one —
 * `pdftoppm` stops after the first `Do` in this shape, measured in the heavy image before and after the fix. The
 * tools this reaches are the ones that place a bitmap more than once on a page: a tiled image watermark, several
 * `edit-pdf` image elements, and more than one image signature on one page.
 *
 * An image's **aspect ratio is only knowable here**, because this is where the file is opened — which is why the
 * `contain` fit lives in the Python arithmetic rather than in a caller that would have to guess the ratio and could
 * only be wrong about it.
 *
 * `limits.downsampleAbovePx` is **opt-in and off by default**, which is deliberate rather than neutral. Refusing an
 * oversized bitmap (`sign`'s `VALIDATION_ERROR`) and silently shrinking one (`watermark`'s documented `IMAGE_LARGE`)
 * are both legitimate, they are different products, and a default here would decide the argument for every caller —
 * including the one whose published contract is the refusal. It also has to be applied *before* a caller's own
 * dimension check, since a bitmap that was quietly resized can no longer be refused for being too large; the two
 * callers therefore use it in opposite directions on purpose.
 */
export async function buildImageOverlayPdf(
  imagePath: string,
  pages: ImageStampPage[],
  overlayPath: string,
  opts: Omit<RunOptions, 'engine'>,
  limits: { downsampleAbovePx?: number } = {},
): Promise<{
  bytes: number;
  imageWidth: number;
  imageHeight: number;
  /** The dimensions the file actually carried, before any downsampling — the caller's cap reads these. */
  sourceWidth: number;
  sourceHeight: number;
  downsampled: boolean;
  seconds: number;
}> {
  const result = await runPythonScript(
    `import json, math, sys, zlib
import pikepdf
from PIL import Image

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
source = Image.open(payload['image'])
rgba = source.convert('RGBA')
image_w, image_h = rgba.size
source_w, source_h = image_w, image_h

# An image watermark is placed as a share of the page, so a 12 000 px logo is 12 000 px of pixels compressed into
# about 200 pt: the resolution is unreachable on paper and the memory is spent anyway. The cap is the caller's
# ('limits.downsampleAbovePx'), and the flag it returns is what makes the warning about it checkable.
cap = payload.get('downsampleAbovePx')
downsampled = False
if cap and max(image_w, image_h) > cap:
    factor = cap / float(max(image_w, image_h))
    rgba = rgba.resize((max(1, int(round(image_w * factor))), max(1, int(round(image_h * factor)))), Image.LANCZOS)
    image_w, image_h = rgba.size
    downsampled = True
rgb = rgba.convert('RGB').tobytes()
alpha = rgba.getchannel('A').tobytes()

with pikepdf.Pdf.new() as pdf:
    image = pikepdf.Stream(pdf, zlib.compress(rgb))
    image.Type = pikepdf.Name('/XObject')
    image.Subtype = pikepdf.Name('/Image')
    image.Width = image_w
    image.Height = image_h
    image.ColorSpace = pikepdf.Name('/DeviceRGB')
    image.BitsPerComponent = 8
    image.Filter = pikepdf.Name('/FlateDecode')
    if rgba.getchannel('A').getextrema()[0] < 255:
        mask = pikepdf.Stream(pdf, zlib.compress(alpha))
        mask.Type = pikepdf.Name('/XObject')
        mask.Subtype = pikepdf.Name('/Image')
        mask.Width = image_w
        mask.Height = image_h
        mask.ColorSpace = pikepdf.Name('/DeviceGray')
        mask.BitsPerComponent = 8
        mask.Filter = pikepdf.Name('/FlateDecode')
        image.SMask = mask

    for spec in payload['pages']:
        page = pdf.add_blank_page(page_size=(spec['widthPt'], spec['heightPt']))
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
        # One q/Q **per stamp**, never one pair around the whole run. A single pair with several
        # 'cm ... Do' sequences inside it looks right in the file and renders only the *first* image:
        # measured, pdftoppm paints one stamp and drops the rest, so a tiled image watermark comes out as one
        # watermark and two signatures on a page come out as one signature (defect 110). Each image draw
        # therefore gets a graphics state of its own, which is also the standard idiom: an image operator may
        # leave the CTM where it likes and the next stamp must not depend on where the previous one put it.
        parts = []
        for stamp in spec['stamps']:
            if stamp.get('widthPt') and stamp.get('heightPt'):
                # An explicit box wins: the caller measured it (an editor rectangle), so the image is sized to that
                # box rather than by its aspect ratio. The stamp's 'fit' says how it gets there: 'stretch' (the
                # default, what an editor rectangle means) or 'contain' (largest size that fits, aspect kept -- a
                # drawn signature's ink, which must not be distorted to fill a box someone dragged).
                if stamp.get('fit') == 'contain':
                    scale = min(stamp['widthPt'] / image_w, stamp['heightPt'] / image_h)
                    width = image_w * scale
                    height = image_h * scale
                else:
                    width = stamp['widthPt']
                    height = stamp['heightPt']
            elif spec.get('imageHeightPt'):
                height = spec['imageHeightPt']
                width = height * image_w / image_h
            else:
                width = spec['scalePercent'] / 100.0 * spec['widthPt']
                height = width * image_h / image_w
            angle = math.radians(stamp['rotationDeg'])
            a = width * math.cos(angle)
            b = width * math.sin(angle)
            c = -height * math.sin(angle)
            d = height * math.cos(angle)
            e = stamp['x'] - (a + c) / 2.0
            f = stamp['y'] - (b + d) / 2.0
            parts.append('q')
            parts.append(f'{a:.4f} {b:.4f} {c:.4f} {d:.4f} {e:.4f} {f:.4f} cm')
            parts.append('/Im0 Do')
            parts.append('Q')
        page.contents_add(pikepdf.Stream(pdf, ('\\n'.join(parts) + '\\n').encode('ascii')))
    pdf.save(payload['output'])
print(json.dumps({'imageWidth': image_w, 'imageHeight': image_h, 'sourceWidth': source_w, 'sourceHeight': source_h, 'downsampled': downsampled}))`,
    {
      image: imagePath,
      pages,
      output: overlayPath,
      ...(limits.downsampleAbovePx ? { downsampleAbovePx: limits.downsampleAbovePx } : {}),
    },
    opts,
  );
  const parsed = parseJsonLine<{
    imageWidth: number;
    imageHeight: number;
    sourceWidth: number;
    sourceHeight: number;
    downsampled: boolean;
  }>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The watermark image could not be placed.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  const size = (await stat(overlayPath).catch(() => null))?.size ?? 0;
  if (size === 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The watermark overlay could not be built.',
    });
  }
  return { bytes: size, ...parsed, seconds: Math.round(result.durationMs / 100) / 10 };
}

function ghostscriptPath(): string {
  return config.engines.ghostscript ?? 'gs';
}

/**
 * Render the overlay program to a PDF.
 *
 * `-dSAFER` is deliberately **not** passed: it restricts Ghostscript's file access to a whitelist, and the overlay
 * legitimately writes a file chosen by the caller. Confinement comes from the engine runner instead — allow-listed
 * environment, a working directory inside the job, and no shell.
 */
export async function renderOverlayPdf(
  pages: OverlayPage[],
  overlayPath: string,
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ bytes: number; seconds: number }> {
  const programPath = `${overlayPath}.ps`;
  await writeFile(programPath, buildOverlayPostScript(pages), 'utf8');

  const result = await runOrThrow(
    ghostscriptPath(),
    ['-q', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', `-sOutputFile=${overlayPath}`, programPath],
    { ...opts, engine: 'ghostscript' },
  );

  const size = (await stat(overlayPath).catch(() => null))?.size ?? 0;
  if (size === 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'ghostscript',
      message: 'The overlay could not be built.',
      stderrTail: result.stderr,
    });
  }
  return { bytes: size, seconds: Math.round(result.durationMs / 100) / 10 };
}

/** Media box of every page, in points — the overlay has to match the page it is merged onto. */
export async function readPageBoxes(
  inputPath: string,
  opts: Omit<RunOptions, 'engine'>,
): Promise<Array<{ widthPt: number; heightPt: number }>> {
  const result = await runPythonScript(
    `import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
with pikepdf.Pdf.open(payload['input']) as pdf:
    boxes = []
    for page in pdf.pages:
        box = page.mediabox
        boxes.append({'widthPt': round(float(box[2]) - float(box[0]), 2), 'heightPt': round(float(box[3]) - float(box[1]), 2)})
print(json.dumps({'boxes': boxes}))`,
    { input: inputPath },
    opts,
  );
  const parsed = parseJsonLine<{ boxes: Array<{ widthPt: number; heightPt: number }> }>(result.stdout);
  if (!parsed?.boxes?.length) {
    throw new JobFailure('ENCRYPTED_INPUT', {
      engine: 'python',
      message: 'The document could not be read; it may be encrypted.',
    });
  }
  return parsed.boxes;
}

export interface OverlayMergeTarget {
  /** 1-based page number in the source document. */
  page: number;
  /** 1-based page in the overlay document. */
  overlayPage: number;
}

/**
 * Merge the overlay onto the target pages.
 *
 * `add_underlay` instead of `add_overlay` for background decoration: both are pikepdf's own operations, so "draw
 * beneath the content" is a different call rather than a different content-stream rewrite.
 */
export async function mergeOverlayPdf(
  inputPath: string,
  overlayPath: string,
  outputPath: string,
  map: OverlayMergeTarget[],
  opts: Omit<RunOptions, 'engine'> & { underContent?: boolean; alpha?: number },
): Promise<{ applied: number; pages: number; seconds: number }> {
  const alpha = opts.alpha ?? 1;
  const result = await runPythonScript(
    `import json, sys
import pikepdf
from pikepdf import Rectangle

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
with pikepdf.Pdf.open(payload['input']) as source, pikepdf.Pdf.open(payload['overlay']) as overlay:
    if len(overlay.pages) < len(payload['map']):
        raise SystemExit('overlay has fewer pages than the merge map needs')
    if payload['alpha'] < 1:
        # Constant transparency at the PDF level rather than at the drawing level: an ExtGState fill alpha wraps
        # the overlay's own content, so it attenuates whatever that content is — text drawn by Ghostscript or an
        # image with an SMask — through one mechanism the viewer and every printer already understand.
        for index in range(len(overlay.pages)):
            page = overlay.pages[index]
            resources = pikepdf.Dictionary(page.get('/Resources', pikepdf.Dictionary()))
            states = pikepdf.Dictionary(resources.get('/ExtGState', pikepdf.Dictionary()))
            states['/GSwm'] = pikepdf.Dictionary(
                Type=pikepdf.Name('/ExtGState'), ca=payload['alpha'], CA=payload['alpha']
            )
            resources['/ExtGState'] = states
            page.Resources = resources
            page.contents_add(pikepdf.Stream(overlay, b'q /GSwm gs\\n'), prepend=True)
            page.contents_add(pikepdf.Stream(overlay, b'\\nQ'), prepend=False)
    for entry in payload['map']:
        page = source.pages[entry['page'] - 1]
        box = page.mediabox
        rect = Rectangle(float(box[0]), float(box[1]), float(box[2]), float(box[3]))
        decorate = page.add_underlay if payload['underContent'] else page.add_overlay
        decorate(overlay.pages[entry['overlayPage'] - 1], rect)
    pages = len(source.pages)
    source.save(payload['output'])
print(json.dumps({'applied': len(payload['map']), 'pages': pages}))`,
    {
      input: inputPath,
      overlay: overlayPath,
      output: outputPath,
      map,
      underContent: Boolean(opts.underContent),
      alpha,
    },
    opts,
  );
  const parsed = parseJsonLine<{ applied: number; pages: number }>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The overlay could not be merged.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return { ...parsed, seconds: Math.round(result.durationMs / 100) / 10 };
}
