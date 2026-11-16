/**
 * The fonts a PostScript overlay may name, and the colour conversion the callers need alongside them.
 *
 * Ghostscript has no embedded font files to fall back on: asking for a family it cannot find makes it substitute a
 * different one *silently*, so a stamp comes out in a typeface nobody chose and nothing in the output explains why.
 * Two handlers decorate pages (`page-numbers`, `watermark`), so the table lives here and they share it — the first
 * copy of this list was already a liability the moment a second handler needed it.
 *
 * Base-14 only. `11-WATERMARK.md` §2 offers `font: custom` on the Business plan, which needs a font file uploaded
 * and embedded; that is not implemented, and naming a family this table does not know returns `FONT_NOT_FOUND`
 * rather than a substituted font.
 */
export const POSTSCRIPT_FONTS: Record<string, string> = {
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica-Bold',
  'helvetica-oblique': 'Helvetica-Oblique',
  times: 'Times-Roman',
  'times-roman': 'Times-Roman',
  'times-bold': 'Times-Bold',
  'times-italic': 'Times-Italic',
  courier: 'Courier',
  'courier-bold': 'Courier-Bold',
};

/** The PostScript name for a user-supplied family, or `null` when this build has no such font. */
export function resolvePostScriptFont(name: string): string | null {
  return POSTSCRIPT_FONTS[name.trim().toLowerCase()] ?? null;
}

/** What to tell the user when a family is not available. */
export function availablePostScriptFonts(): string[] {
  return Object.keys(POSTSCRIPT_FONTS);
}

/**
 * `#rrggbb` → the 0–1 triple `setrgbcolor` takes.
 *
 * The option schema already constrains the format (`^#[0-9a-fA-F]{6}$`), so this assumes six hex digits and is
 * deliberately not defensive: a fallback colour for a malformed value would hide a validation bug behind a stamp
 * that is quietly the wrong colour.
 */
export function hexToRgbTriplet(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    round2(Number.parseInt(value.slice(0, 2), 16) / 255),
    round2(Number.parseInt(value.slice(2, 4), 16) / 255),
    round2(Number.parseInt(value.slice(4, 6), 16) / 255),
  ];
}

/** PostScript prints these numbers; four decimals of a channel is already below one 8-bit step. */
function round2(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
