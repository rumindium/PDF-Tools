import { describe, expect, test } from 'bun:test';
import {
  BASE14_ALIASES,
  BASE14_FACES,
  BASE14_FIRST_CODE,
  BASE14_LAST_CODE,
  advanceWidthPoints,
  advanceWidthUnits,
  base14Face,
} from './base14-metrics';

/**
 * The width table, tested in the two directions that matter: that it says what the engine says about the codes and faces a
 * browser's substitute disagrees about, and that it **refuses to speak** where it cannot.
 *
 * The numbers below are the engine's own — `stringwidth` in Ghostscript's fonts, extracted by
 * `scripts/ci/base14-metrics.ts` and held against this table digit by digit on every run of `bun run test:base14`. They
 * are written down here rather than read out of the module for the reason a second test exists at all: to be a reader
 * that says **222** where a browser's Helvetica substitute says 191, so that a regeneration that quietly changed its
 * mind about the apostrophe fails here as well as there.
 *
 * The glyph names in the comments came out of the engine too (`/Helvetica findfont dup /Encoding get 39 get` →
 * `/quoteright`), which is why the numbers are what they are: the code is not the character, it is the code, and this
 * program resolves it the way the overlay's own `show` does.
 *
 * The faces are the engine's own too: every font `POSTSCRIPT_FONTS` can hand the overlay, which is why Times and Courier
 * are measured here as well as Helvetica. A browser cannot answer for them the way this table does — it is asked for a
 * *family*, so a `Times-Italic` caption came out with upright Times New Roman's advances (defect 251).
 */

describe('the codes the two encodings disagree about', () => {
  test('an apostrophe is the engine’s quoteright, not the quotesingle a browser picks', () => {
    // Code 39 is `/quoteright` in the encoding Ghostscript's Helvetica arrives with: **222 units**, where a browser's
    // Helvetica substitute resolves U+0027 to `quotesingle` at **191**. That is 16 % of a caption's width, in the
    // direction that loses ink — the box comes out narrower than the words (defect 250, measured on the served canvas).
    expect(advanceWidthUnits('Helvetica', 39)).toBe(222);
    expect(advanceWidthUnits('Helvetica-Bold', 39)).toBe(278);
  });

  test('a backtick is code 96, which the engine advances 222 where a browser assumes 333', () => {
    // The other half of the same disagreement, and the bigger one: the engine's encoding maps code 96 to `/quoteleft`
    // and its Helvetica advances that glyph 222 units, while the browser resolves U+0060 to `grave` at 333. Neither code
    // is a character the two sides agree about, and neither is a case `measureText` can be asked about at all.
    expect(advanceWidthUnits('Helvetica', 96)).toBe(222);
  });

  test('the codes both sides do agree about stay where Adobe puts them', () => {
    // Sampled across the printable range, including the three an editor's arithmetic is most likely to be tested with:
    // the space (an advance with no ink), the digits (all one width, which is what a caption of numbers relies on) and
    // the widest letter of the alphabet.
    expect(advanceWidthUnits('Helvetica', 32)).toBe(278);
    expect(advanceWidthUnits('Helvetica', 34)).toBe(355);
    expect(advanceWidthUnits('Helvetica', 40)).toBe(333);
    expect(advanceWidthUnits('Helvetica', 41)).toBe(333);
    expect(advanceWidthUnits('Helvetica', 48)).toBe(556);
    expect(advanceWidthUnits('Helvetica', 57)).toBe(556);
    expect(advanceWidthUnits('Helvetica', 65)).toBe(667);
    expect(advanceWidthUnits('Helvetica', 87)).toBe(944);
    expect(advanceWidthUnits('Helvetica', 104)).toBe(556);
    expect(advanceWidthUnits('Helvetica', 105)).toBe(222);
  });
});

describe('a width in points', () => {
  test('is the sum of the codes times the size over a thousand', () => {
    // `h` is 556 and `i` is 222, so a 12 pt caption of two letters is 9.336 pt — and doubling the size doubles it, which
    // is the whole relationship between a font's advances and the number the editor draws with.
    expect(advanceWidthPoints('Helvetica', 'hi', 12)).toBeCloseTo(9.336, 6);
    expect(advanceWidthPoints('Helvetica', 'hi', 24)).toBeCloseTo(18.672, 6);
    // The empty string is zero points rather than an error: a mark with nothing in it is the caller's business, and the
    // canvas gives it the kind's default width.
    expect(advanceWidthPoints('Helvetica', '', 12)).toBe(0);
  });

  test('is the engine’s apostrophe, which is wider than the browser’s', () => {
    // 222 units a glyph where the substitute would say 191: a ten-apostrophe caption is 26.64 pt as the engine draws it
    // and 22.92 as the browser would measure it. The second assertion states the disagreement itself, so the day the two
    // sides agree this test does not quietly become true by accident.
    expect(advanceWidthPoints('Helvetica', "'", 12)).toBeCloseTo(2.664, 6);
    expect(advanceWidthPoints('Helvetica', "''''''''''", 12)).toBeCloseTo(26.64, 6);
    expect(advanceWidthPoints('Helvetica', "''''''''''", 12)).toBeGreaterThan(10 * (191 / 1000) * 12);
  });

  test('follows the face: a bold caption is not its own weight in regular widths', () => {
    // 611 + 278 for `Helvetica-Bold` against 556 + 222 for `Helvetica` — 10.668 pt against 9.336 at the same size. A box
    // measured in the wrong face is the defect this whole table exists to prevent, one step further in.
    expect(advanceWidthPoints('Helvetica-Bold', 'hi', 12)).toBeCloseTo(10.668, 6);
  });
});

describe('where the table will not speak', () => {
  test('a code outside the set it describes is null, not zero', () => {
    // `null` is the difference between "the engine draws this zero units wide" — a real answer, for a code the encoding
    // leaves unmapped — and "this table has no idea", which is the caller's signal to measure another way.
    expect(advanceWidthUnits('Helvetica', BASE14_FIRST_CODE - 1)).toBeNull();
    expect(advanceWidthUnits('Helvetica', BASE14_LAST_CODE + 1)).toBeNull();
  });

  test('a character outside the encoding is measured as the codes the page will really draw', () => {
    // The engine reads **bytes**, so an emoji is four codes and 1112 units of the glyphs those codes name — the caption
    // will be painted as four wrong glyphs, and a box 13.344 pt wide is the honest box around that ink. Refusing to
    // measure it would not make the page nicer; it would only make the editor disagree with its own output.
    expect(advanceWidthPoints('Helvetica', '😀', 12)).toBeCloseTo(13.344, 6);
    // A newline is the other end of the range, and this table really has no answer: byte 10 is below the printable set,
    // so the caller measures another way rather than pretending the break is a glyph with a width of zero.
    expect(advanceWidthPoints('Helvetica', 'a\nb', 12)).toBeNull();
    expect(advanceWidthPoints('Helvetica', '\t', 12)).toBeNull();
  });

  test('a face the table does not describe is null, so the caller keeps its own measurement', () => {
    //
    // The table carries the fonts a `font` option can name, and that set is the engine's own map — so the interesting
    // cases here are the fonts *outside* it. `Helvetica-BoldOblique` is the one worth writing down: Ghostscript has it and
    // the table used to carry its row, but `resolvePostScriptFont` has no key for it, so no element can ever be drawn in
    // it and a row nothing can reach is a row nothing can be wrong about. `Symbol` is the other direction — a base-14
    // font the overlay is never offered — and the chancery face is a font this product *does* draw (a typed signature)
    // that is not base-14 at all, so there is no base-14 width for it to be measured with.
    //
    expect(base14Face('Helvetica-BoldOblique')).toBeNull();
    expect(base14Face('Symbol')).toBeNull();
    expect(base14Face('ZapfChancery-MediumItalic')).toBeNull();
  });

  test('the option value `times` is Times-Roman, and it is the only alias', () => {
    // `POSTSCRIPT_FONTS` spells one font twice, and an element's JSON may hold either spelling. The alias is generated
    // from that map and re-derived by `bun run test:base14`, so a second alias added to the map cannot quietly go
    // unmeasured: the parity check names the value that is missing.
    expect(BASE14_ALIASES.times).toBe('Times-Roman');
    expect(base14Face('times')).toBe('Times-Roman');
    expect(base14Face(' TIMES ')).toBe('Times-Roman');
    // …and the other spelling of the same font reaches the same row without being an alias at all.
    expect(base14Face('times-roman')).toBe('Times-Roman');
    expect(BASE14_ALIASES.helvetica).toBeUndefined();
    expect(BASE14_ALIASES.courier).toBeUndefined();
  });
});

describe('the families a browser can only substitute for', () => {
  test('Times is the engine’s own face, code by code', () => {
    // Read out of Ghostscript's `Times-Roman`, and sampled where it differs from its own substitute: a quarter-em space
    // where Helvetica has 278, and the apostrophe at code 39 — the engine's `/quoteright` at **333**, where Chrome
    // resolves U+0027 to a Times New Roman `quotesingle` and measures **180.2**, so a caption of them hangs 46 % of its
    // own width outside the box drawn around it. That is the same code class as defect 250, in a family whose substitute
    // is otherwise metric-compatible: `a` 444, `i` 278, `W` 944, all three the engine's own.
    expect(advanceWidthUnits('Times-Roman', 32)).toBe(250);
    expect(advanceWidthUnits('Times-Roman', 39)).toBe(333);
    expect(advanceWidthUnits('Times-Roman', 65)).toBe(722);
    expect(advanceWidthUnits('Times-Roman', 87)).toBe(944);
    expect(advanceWidthUnits('Times-Roman', 97)).toBe(444);
    expect(advanceWidthUnits('Times-Roman', 105)).toBe(278);
  });

  test('a Times italic is not its roman, and a Times bold is not either', () => {
    // The half of defect 251 no browser can answer: `Times New Roman, Times, serif` is a **family**, and a `measureText`
    // call in it gets the regular face, so an italic caption's box was measured with 444 units for an `a` the page draws
    // at 500. The difference is real design rather than a slant — measured on the whole row below, it is 56 of the 224
    // codes for the italic and 60 for the bold, so neither row may be an alias of the roman.
    expect(advanceWidthUnits('Times-Italic', 97)).toBe(500);
    expect(advanceWidthUnits('Times-Italic', 87)).toBe(833);
    expect(advanceWidthUnits('Times-Bold', 97)).toBe(500);
    expect(advanceWidthUnits('Times-Bold', 87)).toBe(1000);
    let differences = 0;
    for (let code = BASE14_FIRST_CODE; code <= BASE14_LAST_CODE; code += 1) {
      if (advanceWidthUnits('Times-Italic', code) !== advanceWidthUnits('Times-Roman', code)) differences += 1;
    }
    expect(differences).toBe(56);
  });

  test('Courier advances 600 units for every glyph, in both of its faces', () => {
    // Monospaced, so the row is 224 identical numbers — and the generator *checks* that rather than assuming it, which is
    // why the expectation here is the whole range instead of a sample. `i` and `W` are the two codes that show the family
    // on screen: twenty of each are the same width in Courier, and 222 against 944 in Helvetica.
    for (let code = BASE14_FIRST_CODE; code <= BASE14_LAST_CODE; code += 1) {
      expect(advanceWidthUnits('Courier', code)).toBe(600);
      expect(advanceWidthUnits('Courier-Bold', code)).toBe(600);
    }
  });

  test('a caption in another family is the other family’s width, not Helvetica’s', () => {
    //
    // Four faces, four advances of an `a`, and four widths for one 12 pt caption: 444 in roman Times, 500 in the italic,
    // 556 in Helvetica, 600 in Courier — 10.656, 12, 13.344 and 14.4 pt. The numbers are the engine's, which is the whole
    // claim: a browser asked for `Times New Roman, Times, serif` gets whatever it substituted at the weight and slant of
    // the *regular* face, so three of these four are widths it cannot produce for a `font` value at all.
    //
    expect(advanceWidthPoints('Times-Roman', 'aa', 12)).toBeCloseTo(10.656, 6);
    expect(advanceWidthPoints('Times-Italic', 'aa', 12)).toBeCloseTo(12, 6);
    expect(advanceWidthPoints('Helvetica', 'aa', 12)).toBeCloseTo(13.344, 6);
    expect(advanceWidthPoints('Courier', 'aa', 12)).toBeCloseTo(14.4, 6);
    expect(advanceWidthPoints('Courier-Bold', 'aa', 12)).toBeCloseTo(14.4, 6);
  });
});

describe('the face names and the rows', () => {
  test('a face is found by the name the option carries, however it is spaced or cased', () => {
    expect(base14Face('helvetica')).toBe('Helvetica');
    expect(base14Face('  Helvetica-Oblique ')).toBe('Helvetica-Oblique');
    expect(base14Face('HELVETICA-BOLD')).toBe('Helvetica-Bold');
    // A CSS family list is not a face name, and must not be mistaken for one: `Helvetica, Arial, sans-serif` is what the
    // *browser* is asked for, and a caller that hands it here gets `null` and the fallback rather than a silent match.
    expect(base14Face('Helvetica, Arial, sans-serif')).toBeNull();
    expect(base14Face('')).toBeNull();
  });

  test('every face covers every code in the range', () => {
    // A row one digit short is a table that measures a long caption wrongly from some character onward, and the offset
    // arithmetic in `advanceWidthUnits` would read into the next row rather than fail. So the range is asserted whole.
    for (const face of BASE14_FACES) {
      expect(advanceWidthUnits(face, BASE14_FIRST_CODE)).toBeNumber();
      expect(advanceWidthUnits(face, BASE14_LAST_CODE)).toBeNumber();
      for (let code = BASE14_FIRST_CODE; code <= BASE14_LAST_CODE; code += 1) {
        expect(advanceWidthUnits(face, code)).toBeNumber();
      }
    }
  });

  test('an oblique is the upright font’s own widths, in the family where that is true', () => {
    // PostScript draws an oblique from the upright metrics, so a table that recorded two different rows would be a table
    // of two different fonts. The generator checks this where it extracts (`scripts/ci/base14-metrics.ts`) and it is
    // checked here where it is read, because the check that matters is on the artifact that ships. Helvetica only, and
    // deliberately: Times's italic is a face of its own (`Times-Italic` above), so "oblique means upright" is a fact about
    // one family rather than a rule a future addition may lean on.
    for (let code = BASE14_FIRST_CODE; code <= BASE14_LAST_CODE; code += 1) {
      expect(advanceWidthUnits('Helvetica-Oblique', code)).toBe(advanceWidthUnits('Helvetica', code));
    }
    expect(BASE14_FACES).toContain('Helvetica-Oblique');
  });
});
