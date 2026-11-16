import { describe, expect, test } from 'bun:test';
import { fitScale, pageStrip, peekPagePreview, previewKind } from './render';

/**
 * The maths and the classification behind the board's thumbnails and the lightbox.
 *
 * The rendering itself is measured in the browser (Playwright, `e2e/browser/`); what is asserted here is the part that
 * decides *what* a preview would be, because that part runs everywhere and gets the answers nobody notices until a
 * tile is blank.
 */

describe('previewKind', () => {
  test('reads a PDF from its media type, its extension, or both disagreeing', () => {
    expect(previewKind({ name: 'a.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(previewKind({ name: 'A.PDF', type: '' })).toBe('pdf');
    // An empty or generic media type is common from a drag out of some file managers; the name still knows.
    expect(previewKind({ name: 'scan.pdf', type: 'application/octet-stream' })).toBe('pdf');
    // …and a wrong one never loses to a right one: the type is the browser's claim, the extension the backup.
    expect(previewKind({ name: 'report.pdf', type: 'text/plain' })).toBe('pdf');
  });

  test('reads an image from either signal, including the formats the picker does not label', () => {
    expect(previewKind({ name: 'x.png', type: 'image/png' })).toBe('image');
    expect(previewKind({ name: 'x.HEIC', type: '' })).toBe('image');
    expect(previewKind({ name: 'x.tif', type: 'application/octet-stream' })).toBe('image');
    expect(previewKind({ name: 'x', type: 'image/webp' })).toBe('image');
  });

  test('an office document is neither, and never quietly guessed at', () => {
    expect(
      previewKind({
        name: 'plan.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe('other');
    expect(previewKind({ name: 'sheet.xlsx', type: '' })).toBe('other');
    // A file with no extension at all is not a page.
    expect(previewKind({ name: 'page', type: '' })).toBe('other');
  });
});

describe('fitScale', () => {
  test('fits a landscape and a portrait page into the same box', () => {
    // Letter at 200×260: the width is the binding constraint on one and the height on the other, and it is the
    // *smaller* of the two ratios that fits in both directions.
    expect(fitScale(612, 792, 200, 260)).toBeCloseTo(0.3268, 4);
    expect(fitScale(792, 612, 200, 260)).toBeCloseTo(0.2525, 4);
  });

  test('never enlarges past the cap', () => {
    // A 200×260 page in a 2000×2000 box would be a 7.7× blur; the cap keeps it at the page's own resolution.
    expect(fitScale(200, 260, 2000, 2000, 3)).toBe(3);
    // …and a cap above the fitted scale is not a target: a small page in a huge box still fits rather than filling.
    expect(fitScale(20, 26, 2000, 2000, 8)).toBe(8);
    expect(fitScale(200, 260, 2000, 2000, 8)).toBeCloseTo(7.6923, 4);
  });

  test('a page with no usable box falls back to 1 instead of NaN', () => {
    // Reached through a broken `/MediaBox`, which the API's probe tolerates because qpdf repairs it. `NaN` here would
    // reach `canvas.width` and throw inside pdf.js, turning one malformed input into a dead board.
    expect(fitScale(0, 792, 200, 260)).toBe(1);
    expect(fitScale(612, 0, 200, 260)).toBe(1);
    expect(fitScale(Number.NaN, 792, 200, 260)).toBe(1);
    expect(fitScale(612, 792, 0, 0)).toBe(1);
    expect(fitScale(-612, 792, 200, 260)).toBe(1);
  });

  test('a huge page still gets a floor, because a canvas below it is not painted', () => {
    expect(fitScale(50_000, 50_000, 200, 260)).toBe(0.05);
  });
});

describe('pageStrip', () => {
  test('offers the first pages in order and counts the rest', () => {
    expect(pageStrip(9)).toEqual({ pages: [1, 2, 3, 4], more: 5 });
    expect(pageStrip(2)).toEqual({ pages: [1, 2], more: 0 });
    expect(pageStrip(1)).toEqual({ pages: [1], more: 0 });
  });

  test('a count the API could not take still leaves the way in', () => {
    // An office document before conversion, or a probe that failed: there is no number, and the tile must still open.
    expect(pageStrip(null)).toEqual({ pages: [1], more: 0 });
    expect(pageStrip(undefined)).toEqual({ pages: [1], more: 0 });
    expect(pageStrip(0)).toEqual({ pages: [1], more: 0 });
  });
});

describe('peekPagePreview', () => {
  /*
   * This is the question the page stepper asks before it decides whether to render a loader, so the one thing it must
   * never do is answer "yes" about a page that is not on screen. A wrong `null` costs a spinner over a page that was
   * already drawn (the state this feature exists to remove); a wrong hit would show the *wrong page* with no loading
   * state at all, which is the worse of the two by a wide margin.
   */
  const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' });
  const box = { width: 260, height: 340 };

  test('answers nothing for a page nothing has drawn yet', () => {
    expect(peekPagePreview({ file, page: 1, box })).toBeNull();
  });

  test('a page and a box are both part of the question', () => {
    // Nothing was ever rendered for this file at this box, so every one of these is a miss — including page 1, which
    // *is* drawn elsewhere on the page at a different size.
    expect(peekPagePreview({ file, page: 1, box })).toBeNull();
    expect(peekPagePreview({ file, page: 2, box })).toBeNull();
    expect(peekPagePreview({ file, page: 1, box: { width: 900, height: 1150 } })).toBeNull();
    // A different document is a different cache entirely, even at the same page and size.
    const other = new File([new Uint8Array([4])], 'b.pdf', { type: 'application/pdf' });
    expect(peekPagePreview({ file: other, page: 1, box })).toBeNull();
  });
});
