/**
 * The base-14 widths, per character code, in Adobe's own units per em.
 *
 * **Generated, never edited by hand.** `bun run test:base14 --write` asks Ghostscript for `stringwidth` in the font
 * setup the overlay draws with (`scripts/ci/base14-metrics.ts`), and `bun run test:base14` fails on one digit that
 * no longer matches what the engine says. A full em is 1000, which is what PostScript measures in, so a width in
 * points is `units / 1000 × size`.
 *
 * The file exists because the **engine** owns the answer and a browser cannot ask it. `canvas.measureText` measures
 * whatever font the browser substituted, and for the families that have a substitute it is metric-compatible for the
 * characters people type and someone else’s font everywhere else — including the codes the encodings disagree about
 * (defect 250: Helvetica’s apostrophe is `/quoteright` at 222 where a browser resolves U+0027 to `quotesingle` at
 * 191) and every face whose *style* a family name does not carry (defect 251: a `Times-Italic` box was measured with
 * upright Times New Roman, so twenty `a` came out 444 units a glyph where the page draws 500).
 *
 * **Every face a `font` option can name is in here, and the list is the engine’s own.** It is derived from
 * `POSTSCRIPT_FONTS` (`packages/engines/src/fonts.ts`) — the map the node handler resolves an element’s font through
 * before the overlay ever names it — so the table cannot fall behind the map that decides what Ghostscript draws, and
 * `bun run test:base14` fails the day a font is added to one and not the other.
 *
 * Two facts about these faces belong in the file rather than in a comment somewhere else, and both are measured by the
 * generator: every Courier glyph advances **600 units** in every Courier face (the family is monospaced, so those rows
 * are 224 identical numbers kept anyway — “measured constant” and “assumed constant” are different things), and the
 * Times faces are **not** each other’s metrics: `Times-Italic` and `Times-Bold` differ from `Times-Roman` on 56 and 60
 * of the 224 codes, where `Helvetica-Oblique` agrees with `Helvetica` on all of them.
 *
 * A face is spelled the way a `font` option spells it: the schema’s own default is `Helvetica`, the map’s keys are the
 * same names one case down, and the lookup below is case-insensitive for exactly that reason. `BASE14_ALIASES` carries
 * the map’s one real alias — `times`, which is `Times-Roman`.
 */

/** The faces this table covers, spelled the way a `font` option names them. */
export const BASE14_FACES = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Courier',
  'Courier-Bold',
] as const;

/** A face whose widths are known exactly. */
export type Base14Face = (typeof BASE14_FACES)[number];

/**
 * Option values that are not a face’s own name.
 *
 * `POSTSCRIPT_FONTS` spells `Times-Roman` twice, and an element’s JSON may hold either spelling: a box measured in
 * `times` is a box measured in Times-Roman, and saying so here is what stops that value from going to the browser for
 * an answer the engine already has. Generated, like the rest of the file: an alias added to the map and not here is a
 * failure of `bun run test:base14`.
 */
export const BASE14_ALIASES: Readonly<Record<string, Base14Face>> = {
  times: 'Times-Roman',
};

/** The first and last character code the table describes. */
export const BASE14_FIRST_CODE = 32;
export const BASE14_LAST_CODE = 255;

/**
 * One width in units per em per code, index 0 being `BASE14_FIRST_CODE`.
 *
 * A flat array rather than a map of codes: it is read on every keystroke of the page’s own text field, and this is
 * the shape that reads with one subtraction and no lookups that can miss.
 */
const WIDTHS: Record<Base14Face, readonly number[]> = {
  Helvetica: [
    278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 222, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278,
    278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 333, 556, 556, 278, 556, 556, 556, 556, 191,
    333, 556, 333, 333, 500, 500, 278, 556, 556, 556, 278, 278, 537, 350, 222, 333, 333, 556, 1000, 1000, 278, 611, 278,
    333, 333, 333, 333, 333, 333, 333, 333, 278, 333, 333, 278, 333, 333, 333, 1000, 278, 278, 278, 278, 278, 278, 278,
    278, 278, 278, 278, 278, 278, 278, 278, 278, 1000, 278, 370, 278, 278, 278, 278, 556, 778, 1000, 365, 278, 278, 278,
    278, 278, 889, 278, 278, 278, 278, 278, 278, 222, 611, 944, 611, 278, 278, 278, 278,
  ],
  'Helvetica-Bold': [
    278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 278, 556, 611, 556, 611,
    556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
    280, 389, 584, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278,
    278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 333, 556, 556, 278, 556, 556, 556, 556, 238,
    500, 556, 333, 333, 611, 611, 278, 556, 556, 556, 278, 278, 556, 350, 278, 500, 500, 556, 1000, 1000, 278, 611, 278,
    333, 333, 333, 333, 333, 333, 333, 333, 278, 333, 333, 278, 333, 333, 333, 1000, 278, 278, 278, 278, 278, 278, 278,
    278, 278, 278, 278, 278, 278, 278, 278, 278, 1000, 278, 370, 278, 278, 278, 278, 611, 778, 1000, 365, 278, 278, 278,
    278, 278, 889, 278, 278, 278, 278, 278, 278, 278, 611, 944, 611, 278, 278, 278, 278,
  ],
  'Helvetica-Oblique': [
    278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 222, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278,
    278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 333, 556, 556, 278, 556, 556, 556, 556, 191,
    333, 556, 333, 333, 500, 500, 278, 556, 556, 556, 278, 278, 537, 350, 222, 333, 333, 556, 1000, 1000, 278, 611, 278,
    333, 333, 333, 333, 333, 333, 333, 333, 278, 333, 333, 278, 333, 333, 333, 1000, 278, 278, 278, 278, 278, 278, 278,
    278, 278, 278, 278, 278, 278, 278, 278, 278, 1000, 278, 370, 278, 278, 278, 278, 556, 778, 1000, 365, 278, 278, 278,
    278, 278, 889, 278, 278, 278, 278, 278, 278, 222, 611, 944, 611, 278, 278, 278, 278,
  ],
  'Times-Roman': [
    250, 333, 408, 500, 500, 833, 778, 333, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889,
    722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500,
    444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480,
    200, 480, 541, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250,
    250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 333, 500, 500, 167, 500, 500, 500, 500, 180,
    444, 500, 333, 333, 556, 556, 250, 500, 500, 500, 250, 250, 453, 350, 333, 444, 444, 500, 1000, 1000, 250, 444, 250,
    333, 333, 333, 333, 333, 333, 333, 333, 250, 333, 333, 250, 333, 333, 333, 1000, 250, 250, 250, 250, 250, 250, 250,
    250, 250, 250, 250, 250, 250, 250, 250, 250, 889, 250, 276, 250, 250, 250, 250, 611, 722, 889, 310, 250, 250, 250,
    250, 250, 667, 250, 250, 250, 278, 250, 250, 278, 500, 722, 500, 250, 250, 250, 250,
  ],
  'Times-Bold': [
    250, 333, 555, 500, 500, 1000, 833, 333, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944,
    722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556,
    444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394,
    220, 394, 520, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250,
    250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 333, 500, 500, 167, 500, 500, 500, 500, 278,
    500, 500, 333, 333, 556, 556, 250, 500, 500, 500, 250, 250, 540, 350, 333, 500, 500, 500, 1000, 1000, 250, 500, 250,
    333, 333, 333, 333, 333, 333, 333, 333, 250, 333, 333, 250, 333, 333, 333, 1000, 250, 250, 250, 250, 250, 250, 250,
    250, 250, 250, 250, 250, 250, 250, 250, 250, 1000, 250, 300, 250, 250, 250, 250, 667, 778, 1000, 330, 250, 250, 250,
    250, 250, 722, 250, 250, 250, 278, 250, 250, 278, 500, 722, 556, 250, 250, 250, 250,
  ],
  'Times-Italic': [
    250, 333, 420, 500, 500, 833, 778, 333, 333, 333, 500, 675, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 500, 333, 333, 675, 675, 675, 500, 920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833,
    667, 722, 611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500, 333, 500, 500, 444, 500,
    444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400,
    275, 400, 541, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250,
    250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 389, 500, 500, 167, 500, 500, 500, 500, 214,
    556, 500, 333, 333, 500, 500, 250, 500, 500, 500, 250, 250, 523, 350, 333, 556, 556, 500, 889, 1000, 250, 500, 250,
    333, 333, 333, 333, 333, 333, 333, 333, 250, 333, 333, 250, 333, 333, 333, 889, 250, 250, 250, 250, 250, 250, 250,
    250, 250, 250, 250, 250, 250, 250, 250, 250, 889, 250, 276, 250, 250, 250, 250, 556, 722, 944, 310, 250, 250, 250,
    250, 250, 667, 250, 250, 250, 278, 250, 250, 278, 500, 667, 500, 250, 250, 250, 250,
  ],
  Courier: [
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
  ],
  'Courier-Bold': [
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
  ],
};

/**
 * The advance of one character code in one face, or `null` when this table cannot speak for that code.
 *
 * `null` is the difference between "the engine draws this code zero units wide" — a real answer, for a code the
 * encoding leaves unmapped — and "this table has no idea", which is a caller's signal to measure another way.
 */
export function advanceWidthUnits(face: Base14Face, code: number): number | null {
  if (code < BASE14_FIRST_CODE || code > BASE14_LAST_CODE) return null;
  const width = WIDTHS[face][code - BASE14_FIRST_CODE];
  return typeof width === 'number' ? width : null;
}

/**
 * A face by the name a `font` option used, or `null` for a family this table does not describe.
 *
 * Two spellings of one font, and the alias is checked before the faces because it is the only one that is not a name:
 * `times` is Times-Roman, `Times-Roman` is itself, and `7` — or a CSS family list like `Helvetica, Arial, sans-serif`
 * — is `null`, which is a caller’s signal that the engine’s answer is not available under that name.
 */
export function base14Face(name: string): Base14Face | null {
  const wanted = name.trim().toLowerCase();
  const alias = BASE14_ALIASES[wanted];
  if (alias != null) return alias;
  return BASE14_FACES.find((face) => face.toLowerCase() === wanted) ?? null;
}

/**
 * How wide a string is, in points, as the engine advances it — `sum of the code widths × size / 1000`.
 *
 * `null` for a face this table cannot speak for, or for a byte below the printable range — a newline, a tab, a
 * control code — and the caller measures another way. Bytes are read one at a time because that is what PostScript
 * does with the string the overlay writes: a caption with `é` in it is **two codes** to the engine, and the width
 * here is of the two glyphs the page will really draw rather than of the one character the reader typed. That is the
 * honest reading of a box around ink, mojibake and all.
 *
 * Summing advances is what the engine does to a *string* as well: `stringwidth` is not kerning-aware here, measured —
 * `(AV)` is 1334 in Helvetica and `(To)` 1111 in Times-Roman, each exactly `A`+`V` and `T`+`o` — so a table of
 * per-code numbers is the same arithmetic, not an approximation of it.
 */
export function advanceWidthPoints(face: Base14Face, text: string, size: number): number | null {
  const bytes = new TextEncoder().encode(text);
  let units = 0;
  for (const byte of bytes) {
    if (byte < BASE14_FIRST_CODE || byte > BASE14_LAST_CODE) return null;
    units += advanceWidthUnits(face, byte) ?? 0;
  }
  return (units / 1000) * size;
}
