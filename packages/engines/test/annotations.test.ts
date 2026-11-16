import { describe, expect, test } from 'bun:test';
import {
  ANNOTATION_PRINT_FLAG,
  ANNOTATION_SUBTYPES,
  FLATTEN_ALPHA,
  type MarkupMark,
  type NoteMark,
  pdfDate,
  quadPointsFor,
} from '../src/annotations';

/**
 * The annotation engine's decisions, at the level they can be tested without a container.
 *
 * Three of these are pure functions whose mistakes are *invisible in every end-to-end check the harness can make*,
 * which is why they are pinned here rather than in a golden case:
 *
 *  - **The order of `/QuadPoints`.** A reader uses it to know which way the quad faces. Written in the wrong order the
 *    mark lands on the wrong half of the line, rotated or inverted — and the file still contains a correct-looking
 *    quad, so a count passes. The engine writes upper-left, upper-right, lower-left, lower-right, and a golden case
 *    cannot see the sequence (poppler renders both orders happily, one of them wrong).
 *  - **The print flag.** `/F 4` is the annotation equivalent of "this exists on paper". The end-to-end check can assert
 *    the flag is present in an output that arrived without annotations, and the constant itself is asserted here.
 *  - **The date format.** A malformed PDF date string is accepted by most readers and ignored by them, so a
 *    timestamp that is silently invalid is a defect no output check would surface.
 */

describe('quadPointsFor', () => {
  test('writes the four corners upper-left, upper-right, lower-left, lower-right', () => {
    // A rectangle that cannot be confused with a square, so a transposed pair is visible in the numbers.
    const points = quadPointsFor({ xPt: 72, yPt: 100, widthPt: 200, heightPt: 19 });
    expect(points).toEqual([
      72,
      119, // upper left
      272,
      119, // upper right
      72,
      100, // lower left
      272,
      100, // lower right
    ]);
  });

  test('orders the corners by position, not by proximity to the origin', () => {
    // The first pair is the *top* edge — y counts up from the page's bottom, so `y + height` is larger than `y`.
    const [firstX, firstY, , secondY, , thirdY] = quadPointsFor({ xPt: 0, yPt: 0, widthPt: 10, heightPt: 20 });
    expect(firstX).toBe(0);
    expect(firstY).toBe(20);
    expect(secondY).toBe(20);
    expect(thirdY).toBe(0);
  });
});

describe('pdfDate', () => {
  test('writes a UTC PDF date string with an explicit offset', () => {
    // `Z` rather than `+00'00'` is a PDF 2.0 spelling older readers ignore, so the offset is written the long way.
    const date = new Date(Date.UTC(2026, 8, 17, 4, 5, 6));
    expect(pdfDate(date)).toBe("D:20260917040506+00'00'");
  });

  test('pads every field, so a January date is not read as an ambiguous number', () => {
    expect(pdfDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("D:20260102030405+00'00'");
  });
});

describe('annotation constants', () => {
  test('every subtype is a PDF name a reader recognises', () => {
    expect(ANNOTATION_SUBTYPES).toEqual({
      highlight: '/Highlight',
      underline: '/Underline',
      strike: '/StrikeOut',
      note: '/Text',
    });
  });

  test('the print flag is bit 3, not a boolean', () => {
    // The value is the whole point: an annotation whose `/F` omits it is invisible on paper. `4` is what the format
    // defines, and `1` (invisible) or `0` would pass a truthiness check while producing an unprintable mark.
    expect(ANNOTATION_PRINT_FLAG).toBe(4);
  });

  test('flattening draws a translucent fill', () => {
    // Strictly between 0 and 1: 1 would hide the text the highlight is meant to point at, and 0 would draw nothing.
    expect(FLATTEN_ALPHA).toBeGreaterThan(0);
    expect(FLATTEN_ALPHA).toBeLessThan(1);
  });
});

describe('mark shapes', () => {
  test('a markup mark carries its own colour and a note carries its own author', () => {
    // The two branches of the union, as the engine's payload builder reads them: a markup rectangle in points, and a
    // note whose author travels with it (the contract gives `note` an author and markup none).
    const markup: MarkupMark = {
      kind: 'strike',
      rect: { xPt: 72, yPt: 400, widthPt: 200, heightPt: 19 },
      color: [0, 0, 0],
    };
    const note: NoteMark = {
      kind: 'note',
      xPt: 460,
      yPt: 600,
      text: 'Check the tolerance on this line.',
      author: 'boni.paratama@rumindium.com',
      iconSizePt: 20,
    };
    expect(markup.rect.heightPt).toBe(19);
    expect(note.iconSizePt).toBeGreaterThan(0);
  });
});
