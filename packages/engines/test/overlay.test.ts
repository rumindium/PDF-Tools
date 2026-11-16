import { describe, expect, test } from 'bun:test';
import {
  WATERMARK_TILE_DEFAULT_PERCENT,
  WATERMARK_TILE_MIN_PERCENT,
  buildOverlayPostScript,
  buildVectorOps,
  escapePostScriptText,
  hexToRgbTriplet,
  placementGeometry,
  resolvePostScriptFont,
  watermarkStampPoints,
} from '../src/index';

/**
 * The overlay program is the one artefact in this codebase that is *generated code*: it is PostScript, it is built by
 * string concatenation, and a mistake in it is reported by Ghostscript as a syntax error somewhere in a 40-line
 * program. These tests pin the parts that are decisions — escaping, the geometry, one `showpage` per page — rather
 * than the exact bytes.
 */

const A4 = { widthPt: 595, heightPt: 842 };

function program(text: string, anchor: Parameters<typeof placementGeometry>[0]['anchor'] = 'bottom-center') {
  return buildOverlayPostScript([
    {
      ...A4,
      placements: [{ text, font: 'Helvetica', sizePt: 10, color: [0.2, 0.2, 0.2], anchor, marginPt: 34.02 }],
    },
  ]);
}

describe('escapePostScriptText', () => {
  test('escapes the three characters that end or corrupt a literal string', () => {
    expect(escapePostScriptText('Invoice (draft)')).toBe('Invoice \\(draft\\)');
    expect(escapePostScriptText('C:\\docs')).toBe('C:\\\\docs');
    expect(escapePostScriptText('a\\(b)')).toBe('a\\\\\\(b\\)');
  });

  test('leaves ordinary text alone, including non-ASCII', () => {
    expect(escapePostScriptText('Page 1 of 6')).toBe('Page 1 of 6');
    expect(escapePostScriptText('Halaman 1 dari 6 — arsip')).toBe('Halaman 1 dari 6 — arsip');
  });
});

describe('placementGeometry', () => {
  test('bottom anchors sit one margin above the page origin', () => {
    expect(placementGeometry({ anchor: 'bottom-center', sizePt: 10, marginPt: 34 }, A4.heightPt)).toEqual({
      rule: 'center',
      baselinePt: 34,
    });
    expect(placementGeometry({ anchor: 'bottom-left', sizePt: 10, marginPt: 34 }, A4.heightPt).rule).toBe('left');
    expect(placementGeometry({ anchor: 'bottom-right', sizePt: 10, marginPt: 34 }, A4.heightPt).rule).toBe('right');
  });

  test('top anchors leave room for the glyphs, not just the margin', () => {
    // The baseline sits a cap height below the top margin, so the *text* respects the margin.
    const { baselinePt } = placementGeometry({ anchor: 'top-center', sizePt: 20, marginPt: 34 }, A4.heightPt);
    expect(baselinePt).toBeCloseTo(A4.heightPt - 34 - 16, 5);
    expect(baselinePt).toBeLessThan(A4.heightPt - 34);
  });

  test('a margin taller than the page cannot push the text off the top edge', () => {
    const { baselinePt } = placementGeometry({ anchor: 'top-center', sizePt: 12, marginPt: 500 }, 200);
    expect(baselinePt).toBe(500); // clamped by Math.max, never negative or above the page
  });
});

describe('buildOverlayPostScript', () => {
  test('emits one page program per overlay page, each with its own size', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [
          { text: '3', font: 'Courier', sizePt: 12, color: [0, 0, 0], anchor: 'bottom-center', marginPt: 10 },
        ],
      },
      {
        widthPt: 612,
        heightPt: 792,
        placements: [{ text: '4', font: 'Courier', sizePt: 12, color: [0, 0, 0], anchor: 'top-right', marginPt: 10 }],
      },
    ]);
    expect(ps.startsWith('%!PS-Adobe-3.0')).toBe(true);
    expect(ps.match(/setpagedevice/g)).toHaveLength(2);
    expect(ps.match(/showpage/g)).toHaveLength(2);
    expect(ps).toContain('/PageSize [595 842]');
    expect(ps).toContain('/PageSize [612 792]');
  });

  test('centring is delegated to the interpreter, which is the whole reason for PostScript', () => {
    const ps = program('Page 1 of 6');
    expect(ps).toContain('(Page 1 of 6) def');
    expect(ps).toContain('stringwidth pop');
    expect(ps).toContain('595 tw sub 2 div 34.02 moveto txt show');
  });

  test('the right rule subtracts the margin instead of centring', () => {
    expect(program('x', 'bottom-right')).toContain('560.98 tw sub 34.02 moveto txt show');
  });

  test('sets the font and colour it was given, per placement', () => {
    const ps = program('x');
    expect(ps).toContain('/Helvetica findfont 10 scalefont setfont');
    expect(ps).toContain('0.2 0.2 0.2 setrgbcolor');
  });

  test('refuses to build an empty program', () => {
    expect(() => buildOverlayPostScript([])).toThrow();
  });

  test('a centre-placed stamp is drawn as a middle, not from its corner', () => {
    // Watermarks place by centre (`watermarkStampPoints`), and a rotated stamp must pivot there too — otherwise a
    // 45° stamp drifts by half its own width, which is the "watermark half off the page" complaint.
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [
          {
            text: 'CONFIDENTIAL',
            font: 'Helvetica',
            sizePt: 48,
            color: [0.6, 0.6, 0.65],
            anchor: 'bottom-center',
            marginPt: 0,
            centerPt: { x: 297.5, y: 421 },
            rotationDeg: -45,
          },
        ],
      },
    ]);
    expect(ps).toContain('gsave');
    expect(ps).toContain('297.5 421 translate');
    expect(ps).toContain('-45 rotate');
    expect(ps).toContain('tw -2 div -16.8 moveto txt show');
    expect(ps).toContain('grestore');
  });

  test('an unrotated centre stamp needs no transform at all', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [
          {
            text: 'DRAFT',
            font: 'Times-Roman',
            sizePt: 20,
            color: [1, 0, 0],
            anchor: 'bottom-center',
            marginPt: 0,
            centerPt: { x: 100, y: 200 },
          },
        ],
      },
    ]);
    expect(ps).not.toContain('gsave');
    // The stamp's middle lands on x=100 whatever its width: `x - width/2`. Written as `(x - width)/2` it centres
    // only for a stamp that fills the page, and pushes anything wider than the page's left half off the edge.
    expect(ps).toContain('100 tw 2 div sub 193 moveto txt show');
  });

  test('a centre stamp wider than the page is still centred, not left-aligned off the edge', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [
          {
            text: 'CONFIDENTIAL {page} of {total}',
            font: 'Helvetica',
            sizePt: 48,
            color: [0.6, 0.6, 0.65],
            anchor: 'bottom-center',
            marginPt: 0,
            centerPt: { x: A4.widthPt / 2, y: A4.heightPt / 2 },
          },
        ],
      },
    ]);
    expect(ps).toContain('297.5 tw 2 div sub 404.2 moveto txt show');
  });
});

describe('overlay rules', () => {
  test('a rule is a stroked line with its own width and colour', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [
          {
            text: 'Invoice 2026-09-16',
            font: 'Helvetica',
            sizePt: 9,
            color: [0.2, 0.2, 0.2],
            anchor: 'top-left',
            marginPt: 34.02,
          },
        ],
        rules: [{ yPt: 796, fromPt: 34.02, toPt: 560.98, color: [0.6, 0.6, 0.6], thicknessPt: 0.5 }],
      },
    ]);
    expect(ps).toContain('0.5 setlinewidth');
    expect(ps).toContain('0.6 0.6 0.6 setrgbcolor');
    expect(ps).toContain('34.02 796 moveto');
    expect(ps).toContain('560.98 796 lineto stroke');
  });

  test('the rule is stroked after the placements, so the glyphs cannot sit on top of it', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [{ text: 'x', font: 'Helvetica', sizePt: 9, color: [0, 0, 0], anchor: 'top-left', marginPt: 34 }],
        rules: [{ yPt: 800, fromPt: 34, toPt: 561, color: [0, 0, 0], thicknessPt: 0.5 }],
      },
    ]);
    expect(ps.indexOf('txt show')).toBeLessThan(ps.indexOf('lineto stroke'));
    expect(ps.indexOf('lineto stroke')).toBeLessThan(ps.indexOf('showpage'));
  });

  test('a page with no rules emits no stroking commands at all', () => {
    const ps = program('Page 1 of 6');
    expect(ps).not.toContain('setlinewidth');
    expect(ps).not.toContain('stroke');
  });
});

describe('watermarkStampPoints', () => {
  test('centre and the four corners are one point each, inset from the edge', () => {
    const page = { widthPt: 600, heightPt: 800 };
    expect(watermarkStampPoints('center', undefined, page.widthPt, page.heightPt)).toEqual([{ x: 300, y: 400 }]);
    expect(watermarkStampPoints('top-left', undefined, page.widthPt, page.heightPt)).toEqual([{ x: 30, y: 760 }]);
    expect(watermarkStampPoints('bottom-right', undefined, page.widthPt, page.heightPt)).toEqual([{ x: 570, y: 40 }]);
  });

  test('tiling derives the grid from the gap, then spreads it evenly', () => {
    // A 50 % gap reads as "two across", and the centres land in the middle of each half rather than on the edge.
    const points = watermarkStampPoints('tile', { x: 50, y: 25 }, 600, 800);
    expect(points).toHaveLength(8); // 2 columns × 4 rows
    expect(points[0]).toEqual({ x: 150, y: 100 });
    expect(points[3]).toEqual({ x: 450, y: 300 }); // last cell of the first two rows
    expect(points[7]).toEqual({ x: 450, y: 700 });
  });

  test('a zero or missing gap falls back instead of producing an unbounded grid', () => {
    const fallback = watermarkStampPoints('tile', { x: 0, y: 0 }, 600, 800);
    // 35 % of the page is the documented default: `round(100 / 35)` is three, so three columns and three rows.
    const perAxis = Math.round(100 / WATERMARK_TILE_DEFAULT_PERCENT);
    expect(perAxis).toBe(3);
    expect(fallback).toHaveLength(perAxis * perAxis);
  });

  test('a gap outside the published range is clamped to it, because the gap is a stamp count', () => {
    // The schema refuses these first (`tile.x` is 10–90), so this is the second line of defence for a direct caller —
    // and the number it protects is why the range exists at all: `round(100 / 1)` is a hundred stamps per axis, ten
    // thousand placements on one page, inside a program Ghostscript has to typeset in one go.
    const tight = watermarkStampPoints('tile', { x: 1, y: 1 }, 600, 800);
    const perAxis = Math.round(100 / WATERMARK_TILE_MIN_PERCENT);
    expect(tight).toHaveLength(perAxis * perAxis);
    expect(tight).toHaveLength(100);

    const loose = watermarkStampPoints('tile', { x: 1000, y: 1000 }, 600, 800);
    expect(loose).toHaveLength(1); // `round(100 / 90)` is one stamp, centred
    expect(loose[0]).toEqual({ x: 300, y: 400 });
  });
});

describe('hexToRgbTriplet', () => {
  test('converts the documented defaults to the 0–1 channels setrgbcolor takes', () => {
    expect(hexToRgbTriplet('#333333')).toEqual([0.2, 0.2, 0.2]);
    expect(hexToRgbTriplet('#FFFFFF')).toEqual([1, 1, 1]);
    expect(hexToRgbTriplet('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgbTriplet('#9aa0a6')).toEqual([0.6039, 0.6275, 0.651]);
  });
});

/**
 * The vector half of the overlay program, added for `edit-pdf`.
 *
 * The operation names are Ghostscript's business; what is asserted here is the geometry and the ordering, because
 * those are the parts that are wrong when a shape lands somewhere else, and because a mistake in them shows up as a
 * rendering difference rather than as an error. `buildVectorOps` is a pure function, so this is where "where does the
 * arrow head actually point" can be answered without a container.
 */
describe('overlay vectors', () => {
  const rect: Parameters<typeof buildVectorOps>[0] = {
    kind: 'rect',
    xPt: 100,
    yPt: 200,
    widthPt: 120,
    heightPt: 40,
    stroke: [0, 0, 1],
    fill: [1, 1, 0],
    strokeWidthPt: 2,
  };

  test('a rectangle is four line segments, not the `rect` operator, filled before it is stroked', () => {
    // The operator name is the part that was wrong the first time: `rect` is a *PDF* operator, and Ghostscript
    // aborts the whole overlay with `Error: /undefined in rect`. Asserted as the actual path, because a test that
    // asserted `rect` was present would have gone on passing while every vector job failed in the container.
    const ops = buildVectorOps(rect).join('\n');
    // Comments excluded: `% vector: rect` is the marker the builder emits, not an operator.
    expect(ops.split('\n').filter((line) => !line.startsWith('%') && line.endsWith(' rect'))).toEqual([]);
    expect(ops).toContain(
      ['100 200 moveto', '120 0 rlineto', '0 40 rlineto', '-120 0 rlineto', 'closepath'].join('\n'),
    );
    expect(ops).toContain('1 1 0 setrgbcolor');
    expect(ops).toContain('0 0 1 setrgbcolor');
    expect(ops).toContain('2 setlinewidth');
    // Fill first: stroking first leaves half the outline under the fill, which is how a 2 pt border reads as 1 pt.
    expect(ops.indexOf('fill')).toBeLessThan(ops.indexOf('stroke'));
  });

  test('a vector with neither colour is drawn black instead of vanishing', () => {
    const ops = buildVectorOps({ ...rect, stroke: null, fill: null }).join('\n');
    expect(ops).toContain('0 0 0 setrgbcolor');
    expect(ops).toContain('stroke');
  });

  test('an ellipse is four beziers around the box centre, not a polygon', () => {
    const ops = buildVectorOps({ ...rect, kind: 'ellipse', fill: null });
    expect(ops.filter((line) => line.includes('curveto'))).toHaveLength(4);
    // Starts at the rightmost point of the box and closes the path: x 100..220, y 200..240 means a centre of
    // (160, 220) and a radius of 60 × 20.
    expect(ops.join('\n')).toContain('220 220 moveto');
    expect(ops.join('\n')).toContain('closepath');
    expect(ops.join('\n')).not.toContain('lineto');
  });

  test('a filled and stroked path is built twice, because `fill` consumes it', () => {
    // The PostScript idiom, asserted so the duplication does not read as an accident: `fill` and `stroke` both clear
    // the current path, so a shape with both has to walk its own geometry again rather than reuse it.
    const ops = buildVectorOps({ ...rect, kind: 'ellipse' });
    expect(ops.filter((line) => line.includes('curveto'))).toHaveLength(8);
    expect(ops.indexOf('fill')).toBeLessThan(ops.indexOf('stroke'));
  });

  test('a line runs from x,y to x+width,y+height', () => {
    const ops = buildVectorOps({ ...rect, kind: 'line', fill: null }).join('\n');
    expect(ops).toContain('100 200 moveto');
    expect(ops).toContain('220 240 lineto');
  });

  test('an arrow keeps its head at the far end, mirrored about the line', () => {
    // A 45° arrow from (100,200) to (200,300): the two wings must both be *behind* the tip, which is what fails when
    // the head is computed by adding the spread to the line's own angle instead of to its reverse — that error points
    // the head forward, through the tip, which reads as a V opening the wrong way.
    const ops = buildVectorOps({ ...rect, kind: 'arrow', fill: null, widthPt: 100, heightPt: 100 }).join('\n');
    expect(ops).toContain('100 200 moveto');
    expect(ops).toContain('200 300 lineto');

    const wings = ops
      .split('\n')
      .filter((line) => line.endsWith('lineto stroke'))
      .map((line) => line.split(' ').slice(0, 2).map(Number) as [number, number]);
    expect(wings).toHaveLength(2);
    for (const [x, y] of wings) {
      expect(x).toBeLessThan(200);
      expect(y).toBeLessThan(300);
    }
    // Wings of equal length, mirrored about the 45° direction: the two offsets are each other's transposed pair.
    const [first, second] = wings as [number, number][];
    const offset1 = [first[0] - 200, first[1] - 300];
    const offset2 = [second[0] - 200, second[1] - 300];
    expect(Math.hypot(...(offset1 as [number, number]))).toBeCloseTo(Math.hypot(...(offset2 as [number, number])), 1);
    expect(Math.abs(offset1[0]! - offset2[1]!)).toBeLessThan(0.02);
    expect(Math.abs(offset1[1]! - offset2[0]!)).toBeLessThan(0.02);
  });

  test('a checkbox draws its box and, when checked, a tick inside it', () => {
    const unchecked = buildVectorOps({ ...rect, kind: 'checkbox', fill: null, checked: false }).join('\n');
    const checked = buildVectorOps({ ...rect, kind: 'checkbox', fill: null, checked: true }).join('\n');
    expect(unchecked).toContain('100 200 moveto');
    expect(unchecked).toContain('closepath');
    // The box is four segments, so a checked box holds the box's four plus the tick's one pen-down and two
    // segments, all seven points inside the box (x 100..220, y 200..240).
    const seg = (source: string) =>
      source.split('\n').filter((line) => line.includes('moveto') || line.includes('lineto'));
    expect(seg(unchecked)).toHaveLength(4);
    expect(seg(checked)).toHaveLength(7);
    const tick = seg(checked).slice(4);
    for (const point of tick) {
      const [x, y] = point.split(' ').slice(0, 2).map(Number) as [number, number];
      expect(x).toBeGreaterThan(100);
      expect(x).toBeLessThan(220);
      expect(y).toBeGreaterThan(200);
      expect(y).toBeLessThan(240);
    }
  });

  test('a freehand mark is one path with round joins', () => {
    const ops = buildVectorOps({
      ...rect,
      kind: 'polyline',
      fill: null,
      strokeWidthPt: 3,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 30 },
        { x: 40, y: 25 },
      ],
    }).join('\n');
    expect(ops).toContain('10 10 moveto');
    expect(ops).toContain('20 30 lineto');
    expect(ops).toContain('40 25 lineto');
    expect(ops).toContain('1 setlinejoin');
    expect(ops).toContain('3 setlinewidth');
    // One stroke call for the whole path — a stroked segment per point would show every joint at 3 pt.
    expect(ops.split('stroke')).toHaveLength(2);
  });

  test('vectors are drawn before the placements, so text sits on top of a highlight', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        vectors: [{ ...rect, fill: [1, 1, 0], stroke: null }],
        placements: [
          {
            text: 'Paid',
            font: 'Helvetica',
            sizePt: 12,
            color: [0, 0, 0],
            anchor: 'bottom-left',
            marginPt: 0,
            baselinePt: { x: 110, y: 210 },
          },
        ],
      },
    ]);
    expect(ps.indexOf('closepath')).toBeLessThan(ps.indexOf('txt show'));
  });

  test('a placed text box starts at its baseline point and rotates about it', () => {
    const ps = buildOverlayPostScript([
      {
        ...A4,
        placements: [
          {
            text: 'APPROVED',
            font: 'Helvetica-Bold',
            sizePt: 14,
            color: [0, 0.5, 0],
            anchor: 'bottom-left',
            marginPt: 0,
            baselinePt: { x: 72, y: 700 },
          },
        ],
      },
    ]);
    expect(ps).toContain('72 700 translate');
    expect(ps).toContain('0 0 moveto txt show');
    // No centring arithmetic: a placed run is not measured, which is the whole difference from `centerPt`.
    expect(ps).not.toContain('stringwidth');
  });
});

describe('resolvePostScriptFont', () => {
  test('accepts the documented families, case-insensitively', () => {
    expect(resolvePostScriptFont('Helvetica')).toBe('Helvetica');
    expect(resolvePostScriptFont(' TIMES-BOLD ')).toBe('Times-Bold');
    expect(resolvePostScriptFont('courier')).toBe('Courier');
  });

  test('returns null rather than letting Ghostscript substitute a font', () => {
    expect(resolvePostScriptFont('Comic Sans')).toBeNull();
  });
});
