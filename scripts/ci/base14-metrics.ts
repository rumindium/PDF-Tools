import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// A **type** import, and only a type: the artifact this script generates is also the type of the faces it claims, so the
// parity check below can be written against the same union the browser compiles with. Type-only, because the runtime
// import of the table happens later and only in the check — `--write` has to work with the table missing or stale.
import type { Base14Face } from '../../apps/web/src/features/placement/base14-metrics';
import { stackGap } from '../../e2e/lib/stack-gap';
// The engine's own map, imported rather than copied: it is the list of fonts an overlay can be asked to draw, so it is
// the list this table has to cover, and importing it is what makes "the table cannot fall behind the map" a property
// instead of a promise. `packages/engines/src/fonts.ts` imports nothing, so this stays a pure source.
import { POSTSCRIPT_FONTS } from '../../packages/engines/src/fonts';

/**
 * The base-14 widths the canvas measures with, checked against the engine that draws them.
 *
 *   bun run test:base14            # compare the checked-in table with Ghostscript's own answer
 *   bun run test:base14 --write    # rewrite the table from Ghostscript's own answer
 *
 * `edit-pdf`'s text elements are drawn by **Ghostscript**, through a PostScript overlay that names a base-14 font and lets
 * the program measure itself (`/Helvetica findfont 12 scalefont setfont … stringwidth`,
 * `packages/engines/src/overlay.ts`). So the width of a string on the page is not an opinion: it is `stringwidth` in the
 * font Ghostscript resolves. This script asks for that, per character code, in the same font setup the overlay uses, and
 * its answer is the table the editor's dashed boxes are measured from
 * (`apps/web/src/features/placement/base14-metrics.ts`).
 *
 * The alternative — the browser's `canvas.measureText` — is *close* for the characters people type, and that is exactly
 * why it survived so long: the font browsers substitute is metric-compatible, so the two agree to a fraction of a pixel
 * for a caption in the default face. It is not the engine's answer, and it stops being close where the substitute
 * differs. Two rounds of extraction have each found one class of that:
 *
 *   * **the codes the encodings disagree about** (defect 250). Code 39 is `/quoteright` at **222 units** where a browser
 *     resolves U+0027 to `quotesingle` at 191, and code 96 is `/quoteleft` at 222 where a browser resolves U+0060 to
 *     `grave` at 333 — the first losing ink behind the box, the second inventing a third of a character that is not
 *     there;
 *   * **the faces the family name does not carry** (defect 251). `cssFamilyFor` can only name a *family* — for Times it
 *     is `Times New Roman, Times, serif` — and `measureText` resolves that to the upright regular face, so the box
 *     around a `Times-Italic` caption was measured in Times New Roman regular: twenty `a` at 444 units a glyph where the
 *     page draws 500, **12.6 % of the caption outside its own outline**.
 *
 * The faces are not a hand-written list here for the reason the second defect exists: what has to be covered is *every
 * font the overlay can be told to draw*, and that set is `POSTSCRIPT_FONTS`. So this script imports it, extracts one row
 * per face it maps to, and emits the aliases — option values that are not a face's own name. A font added to the map and
 * not to the table is a failure of `bun run test:base14`, not a silent fall back to the browser.
 *
 * `--write` is how the table is produced; the default mode *is* the claim, and it fails on one changed digit. It runs
 * `gs` directly when the host has one and otherwise shells into the worker image that carries the engine the product
 * uses — the same binary and the same version — and when neither answers it stops as a **named gap** rather than passing
 * (`e2e/lib/stack-gap.ts`).
 */

/**
 * The faces the table covers: every font a `font` option can name, as the engine's own map spells it.
 *
 * Eight names, three families. `Helvetica-BoldOblique` is deliberately absent: Ghostscript has it, but no option value
 * reaches it (`resolvePostScriptFont` has no key for it), and a row nothing can draw is a row nothing can be wrong
 * about. The families are complete for the styles that *are* reachable — regular, bold and oblique Helvetica; roman,
 * bold and italic Times; regular and bold Courier.
 */
const FACES = [...new Set(Object.values(POSTSCRIPT_FONTS))];

/**
 * Option values that are not a face's own name.
 *
 * The map spells `Times-Roman` twice (`times` and `times-roman`), and only one of those is a name: the other is an
 * alias a caller may use. Emitting it is what lets the editor answer a box measured in `times` — the option value a
 * user's JSON actually holds — with Times-Roman's own numbers instead of the browser's substitute.
 */
const ALIASES: Record<string, string> = {};
for (const [option, face] of Object.entries(POSTSCRIPT_FONTS)) {
  if (option.toLowerCase() !== face.toLowerCase()) ALIASES[option.toLowerCase()] = face;
}

/** Where the table lives, relative to the repository root. */
const TABLE_PATH = join(
  import.meta.dir,
  '..',
  '..',
  'apps',
  'web',
  'src',
  'features',
  'placement',
  'base14-metrics.ts',
);

/**
 * The program the overlay's own numbers come out of.
 *
 * It is deliberately the overlay's two lines — `findfont` and `scalefont` — and nothing else: no `/Encoding`, because the
 * overlay sets none either, and a table extracted under a different encoding would be a table of a different font. The
 * size is 1000 so the numbers are Adobe's own units per em, and every code is measured on its own, so a font that maps
 * two codes to one glyph is still read correctly.
 *
 * The **first line is the font it resolved to**, and it is asked for the same reason the widths are: `findfont` does not
 * fail on a name the engine does not have, it *substitutes* one — measured, `/NoSuchFace-PDFTOOLS findfont /FontName get`
 * answers `Courier` — and a table extracted under a name nobody draws is a table of a font the page does not use. Asking
 * makes a typo in the list below a failure with the substituted name in it instead of 224 plausible numbers.
 */
function program(face: string, from: number, to: number): string {
  return `%!PS
/${face} findfont dup /FontName get 60 string cvs print (\\n) print
1000 scalefont setfont
/nl (\\n) def
/codestr 1 string def
${from} 1 ${to} {
  /c exch def
  codestr 0 c put
  c 20 string cvs print ( ) print codestr stringwidth pop 20 string cvs print nl print
} for
quit
`;
}

/** Ask `gs` — the host's if it has one, otherwise the engine inside the worker image. `null` when neither answers. */
function askGhostscript(source: string): string | null {
  const args = ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=nullpage', '-'];
  const host = spawnSync('gs', args, { input: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (host.status === 0 && typeof host.stdout === 'string' && host.stdout.length > 0) return host.stdout;
  const docker = spawnSync('docker', ['compose', 'exec', '-T', 'worker-light', 'gs', ...args], {
    input: source,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (docker.status === 0 && typeof docker.stdout === 'string' && docker.stdout.length > 0) return docker.stdout;
  return null;
}

/** One face as the engine answers it: the font it resolved to, and its width per character code. */
function extraction(face: string): { resolved: string; widths: Record<number, number> } {
  const output = askGhostscript(program(face, FIRST_CODE, LAST_CODE));
  if (output == null) {
    stackGap(
      'no Ghostscript to ask: this host has no `gs` and the worker image is not running',
      'start the stack (`docker compose up -d`) or install Ghostscript — this is the engine that draws the text',
    );
  }
  const [first = '', ...rest] = output.split('\n');
  const resolved = first.trim();
  if (resolved !== face) {
    console.error(
      `  · ${face}: the engine resolved this to /${resolved || '(nothing)'} — it does not have a font by that name and substituted one`,
    );
    process.exit(1);
  }
  const widths: Record<number, number> = {};
  for (const line of rest) {
    const match = /^(\d+) (\d+(?:\.\d+)?)$/.exec(line.trim());
    if (!match) continue;
    widths[Number(match[1])] = Number(match[2]);
  }
  const expected = LAST_CODE - FIRST_CODE + 1;
  if (Object.keys(widths).length !== expected) {
    console.error(`  · ${face}: asked for ${expected} codes, Ghostscript answered ${Object.keys(widths).length}`);
    process.exit(1);
  }
  return { resolved, widths };
}

/** The module text, as it is written — the same shape the checked-in file already has. */
function render(table: Record<string, number[]>): string {
  const lines = [
    '/**',
    " * The base-14 widths, per character code, in Adobe's own units per em.",
    ' *',
    ' * **Generated, never edited by hand.** `bun run test:base14 --write` asks Ghostscript for `stringwidth` in the font',
    ' * setup the overlay draws with (`scripts/ci/base14-metrics.ts`), and `bun run test:base14` fails on one digit that',
    ' * no longer matches what the engine says. A full em is 1000, which is what PostScript measures in, so a width in',
    ' * points is `units / 1000 × size`.',
    ' *',
    ' * The file exists because the **engine** owns the answer and a browser cannot ask it. `canvas.measureText` measures',
    ' * whatever font the browser substituted, and for the families that have a substitute it is metric-compatible for the',
    ' * characters people type and someone else’s font everywhere else — including the codes the encodings disagree about',
    ' * (defect 250: Helvetica’s apostrophe is `/quoteright` at 222 where a browser resolves U+0027 to `quotesingle` at',
    ' * 191) and every face whose *style* a family name does not carry (defect 251: a `Times-Italic` box was measured with',
    ' * upright Times New Roman, so twenty `a` came out 444 units a glyph where the page draws 500).',
    ' *',
    ' * **Every face a `font` option can name is in here, and the list is the engine’s own.** It is derived from',
    ' * `POSTSCRIPT_FONTS` (`packages/engines/src/fonts.ts`) — the map the node handler resolves an element’s font through',
    ' * before the overlay ever names it — so the table cannot fall behind the map that decides what Ghostscript draws, and',
    ' * `bun run test:base14` fails the day a font is added to one and not the other.',
    ' *',
    ' * Two facts about these faces belong in the file rather than in a comment somewhere else, and the generator checks',
    ' * both: every Courier glyph advances **600 units** in every Courier face (the family is monospaced, so those rows are',
    ' * 224 identical numbers kept anyway — “measured constant” and “assumed constant” are different things), and the Times',
    ' * faces are **not** each other’s metrics — `Times-Italic` and `Times-Bold` are different designs from `Times-Roman`,',
    ' * where `Helvetica-Oblique` is `Helvetica` slanted and agrees with it on every code.',
    ' *',
    ' * A face is spelled the way a `font` option spells it: the schema’s own default is `Helvetica`, the map’s keys are the',
    ' * same names one case down, and the lookup below is case-insensitive for exactly that reason. `BASE14_ALIASES` carries',
    ' * the map’s one real alias — `times`, which is `Times-Roman`.',
    ' */',
    '',
    '/** The faces this table covers, spelled the way a `font` option names them. */',
    'export const BASE14_FACES = [',
  ];
  for (const face of FACES) lines.push(`  '${face}',`);
  lines.push(
    '] as const;',
    '',
    '/** A face whose widths are known exactly. */',
    'export type Base14Face = (typeof BASE14_FACES)[number];',
    '',
    '/**',
    ' * Option values that are not a face’s own name.',
    ' *',
    ' * `POSTSCRIPT_FONTS` spells `Times-Roman` twice, and an element’s JSON may hold either spelling: a box measured in',
    ' * `times` is a box measured in Times-Roman, and saying so here is what stops that value from going to the browser for',
    ' * an answer the engine already has. Generated, like the rest of the file: an alias added to the map and not here is a',
    ' * failure of `bun run test:base14`.',
    ' */',
    'export const BASE14_ALIASES: Readonly<Record<string, Base14Face>> = {',
  );
  for (const [option, face] of Object.entries(ALIASES)) lines.push(`  ${option}: '${face}',`);
  lines.push(
    '};',
    '',
    '/** The first and last character code the table describes. */',
    `export const BASE14_FIRST_CODE = ${FIRST_CODE};`,
    `export const BASE14_LAST_CODE = ${LAST_CODE};`,
    '',
    '/**',
    ' * One width in units per em per code, index 0 being `BASE14_FIRST_CODE`.',
    ' *',
    ' * A flat array rather than a map of codes: it is read on every keystroke of the page’s own text field, and this is',
    ' * the shape that reads with one subtraction and no lookups that can miss.',
    ' */',
    'const WIDTHS: Record<Base14Face, readonly number[]> = {',
  );
  for (const face of FACES) {
    const widths = table[face]!;
    lines.push(`  '${face}': [`);
    for (let index = 0; index < widths.length; index += 16) {
      lines.push(`    ${widths.slice(index, index + 16).join(', ')},`);
    }
    lines.push('  ],');
  }
  lines.push(
    '};',
    '',
    '/**',
    ' * The advance of one character code in one face, or `null` when this table cannot speak for that code.',
    ' *',
    ' * `null` is the difference between "the engine draws this code zero units wide" — a real answer, for a code the',
    ' * encoding leaves unmapped — and "this table has no idea", which is a caller\'s signal to measure another way.',
    ' */',
    'export function advanceWidthUnits(face: Base14Face, code: number): number | null {',
    '  if (code < BASE14_FIRST_CODE || code > BASE14_LAST_CODE) return null;',
    '  const width = WIDTHS[face][code - BASE14_FIRST_CODE];',
    "  return typeof width === 'number' ? width : null;",
    '}',
    '',
    '/**',
    ' * A face by the name a `font` option used, or `null` for a family this table does not describe.',
    ' *',
    ' * Two spellings of one font, and the alias is checked before the faces because it is the only one that is not a name:',
    ' * `times` is Times-Roman, `Times-Roman` is itself, and `7` — or a CSS family list like `Helvetica, Arial, sans-serif`',
    ' * — is `null`, which is a caller’s signal that the engine’s answer is not available under that name.',
    ' */',
    'export function base14Face(name: string): Base14Face | null {',
    '  const wanted = name.trim().toLowerCase();',
    '  const alias = BASE14_ALIASES[wanted];',
    '  if (alias != null) return alias;',
    '  return BASE14_FACES.find((face) => face.toLowerCase() === wanted) ?? null;',
    '}',
    '',
    '/**',
    ' * How wide a string is, in points, as the engine advances it — `sum of the code widths × size / 1000`.',
    ' *',
    ' * `null` for a face this table cannot speak for, or for a byte below the printable range — a newline, a tab, a',
    ' * control code — and the caller measures another way. Bytes are read one at a time because that is what PostScript',
    ' * does with the string the overlay writes: a caption with `é` in it is **two codes** to the engine, and the width',
    ' * here is of the two glyphs the page will really draw rather than of the one character the reader typed. That is the',
    ' * honest reading of a box around ink, mojibake and all.',
    ' *',
    ' * Summing advances is what the engine does to a *string* as well: `stringwidth` is not kerning-aware here, measured —',
    ' * `(AV)` is 1334 in Helvetica and `(To)` 1111 in Times-Roman, each exactly `A`+`V` and `T`+`o` — so a table of',
    ' * per-code numbers is the same arithmetic, not an approximation of it.',
    ' */',
    'export function advanceWidthPoints(face: Base14Face, text: string, size: number): number | null {',
    '  const bytes = new TextEncoder().encode(text);',
    '  let units = 0;',
    '  for (const byte of bytes) {',
    '    if (byte < BASE14_FIRST_CODE || byte > BASE14_LAST_CODE) return null;',
    '    units += advanceWidthUnits(face, byte) ?? 0;',
    '  }',
    '  return (units / 1000) * size;',
    '}',
    '',
  );
  return lines.join('\n');
}

const FIRST_CODE = 32;
const LAST_CODE = 255;

const write = process.argv.includes('--write');
const extracted: Record<string, number[]> = {};

for (const face of FACES) {
  const { widths } = extraction(face);
  const row: number[] = [];
  for (let code = FIRST_CODE; code <= LAST_CODE; code += 1) row.push(widths[code] ?? 0);
  extracted[face] = row;
  console.log(`  · ${face.padEnd(21)} ${row.filter((_, index) => index % 32 === 0).join(' ')}`);
}

//
// Every face has to be a value `resolvePostScriptFont` accepts, spelled this way, because the row's own control writes a
// face's name (`apps/web/src/features/placement/shapes/elements.tsx`): a face the table measures and the handler refuses
// would be a control that produces `FONT_NOT_FOUND`. Cheap to check, and the check is case-insensitive for the same
// reason the lookup is.
//
for (const face of FACES) {
  if (!(face.toLowerCase() in POSTSCRIPT_FONTS)) {
    console.error(`  · ${face}: the overlay's map has no value spelled like this, so no element could name it`);
    process.exit(1);
  }
}

//
// Courier is monospaced: every glyph of every one of its faces advances 600 units, measured. Kept as a check because the
// table stores those 224 numbers anyway, and a row of them is exactly the shape a wrong extraction would produce —
// `Courier` answered with Helvetica's numbers would be a 600 that is not there.
//
for (const face of FACES) {
  if (!face.startsWith('Courier')) continue;
  const odd = extracted[face]!.filter((width) => width !== 600);
  if (odd.length > 0) {
    console.error(
      `  · ${face}: a Courier face advances 600 units per code and this one gave ${odd.length} codes that do not`,
    );
    process.exit(1);
  }
}

//
// Which faces share their metrics and which do not, both measured rather than assumed — because the first is what lets a
// reader skip a row and the second is why the rows cannot alias each other. An oblique is the upright font slanted, so
// PostScript draws it from the same numbers; a Times italic is a different design, with its own.
//
const SHARED: Array<[string, string]> = [['Helvetica-Oblique', 'Helvetica']];
const DISTINCT: Array<[string, string]> = [
  ['Times-Italic', 'Times-Roman'],
  ['Times-Bold', 'Times-Roman'],
];
for (const [face, other] of SHARED) {
  if (extracted[face]!.join() !== extracted[other]!.join()) {
    console.error(`  · ${face} does not share ${other}'s widths — the table cannot treat them as one font`);
    process.exit(1);
  }
}
for (const [face, other] of DISTINCT) {
  if (extracted[face]!.join() === extracted[other]!.join()) {
    console.error(`  · ${face} has ${other}'s widths exactly — that is one font under two names, not another face`);
    process.exit(1);
  }
}

if (write) {
  await writeFile(TABLE_PATH, render(extracted), 'utf8');
  // The digits are this script's; the **layout** is the repository's. Biome's formatter decides how many numbers fit on a
  // line, so a regeneration cannot leave the file failing `bun run lint` over whitespace — which is the kind of failure
  // that looks like a code problem and is not one.
  const formatter = join(import.meta.dir, '..', '..', 'node_modules', '.bin', 'biome');
  const formatted = spawnSync(formatter, ['format', '--write', TABLE_PATH], { encoding: 'utf8' });
  if (formatted.status !== 0) {
    console.error(`  · the table was written but biome would not format it: ${formatted.stderr ?? formatted.error}`);
    process.exit(1);
  }
  console.log(`  · wrote ${TABLE_PATH.split('/').slice(-4).join('/')} — ${FACES.length} faces`);
  if (Object.keys(ALIASES).length > 0) {
    console.log(
      `  · aliases: ${Object.entries(ALIASES)
        .map(([o, f]) => `${o} → ${f}`)
        .join(', ')}`,
    );
  }
  process.exit(0);
}

const table = await import('../../apps/web/src/features/placement/base14-metrics').catch(() => null);
if (table == null) {
  console.error('  · the checked-in table could not be imported — run `bun run test:base14 --write`');
  process.exit(1);
}

const mismatches: string[] = [];
for (const face of FACES) {
  const fromEngine = extracted[face]!;
  if (!table.BASE14_FACES.includes(face as Base14Face)) {
    mismatches.push(`${face}: the table does not claim this face`);
    continue;
  }
  for (let index = 0; index < fromEngine.length; index += 1) {
    const code = FIRST_CODE + index;
    const checkedIn = table.advanceWidthUnits(face as Base14Face, code);
    if (checkedIn !== fromEngine[index]) {
      mismatches.push(`${face} code ${code}: table ${checkedIn}, engine ${fromEngine[index]}`);
    }
  }
}
//
// …and what the table says *about* the map rather than about the engine: which option values are aliases. Checked
// against the map this script read, so a name added to `POSTSCRIPT_FONTS` without a regeneration fails here — naming
// the value, which is the sentence a reader needs.
//
for (const [option, face] of Object.entries(ALIASES)) {
  const claimed = table.BASE14_ALIASES?.[option];
  if (claimed !== face) {
    mismatches.push(
      `${option}: the overlay resolves this to ${face}, the checked-in table says ${claimed ?? '(nothing)'}`,
    );
  }
}

if (mismatches.length > 0) {
  console.error(`  ✗ ${mismatches.length} width(s) disagree with the engine:`);
  for (const line of mismatches.slice(0, 10)) console.error(`      ${line}`);
  console.error("    run `bun run test:base14 --write` to take the engine's own answer");
  process.exit(1);
}

console.log(`  ✓ ${FACES.length} faces, codes ${FIRST_CODE}–${LAST_CODE}, agree with Ghostscript's own stringwidth`);
