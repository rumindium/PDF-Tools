import { IconPageExtract, IconPageRemove } from '../../components/icons';
// The project's own name for "a glyph component" — the same type the sidebar and the tool table are declared with, so a
// glyph here is the same kind of value as a glyph there.
import type { NavIcon } from '../../components/layout/nav';

/**
 * The glyph a catalog choice asks for, by name (`OptionsUiField.choices[].icon`).
 *
 * A name rather than a component because the catalog crosses the wire as JSON: an icon set is a build artefact of the
 * web app, and the registry is data the API serves. The vocabulary is therefore closed here and asserted there — every
 * `icon` any tool declares has to resolve through this map, or the choice renders an empty tile
 * (`./choice-glyph.test.ts`).
 *
 * `null` for a name nothing resolves, and for *no* name at all: a choice without a glyph is a perfectly good choice,
 * and the segmented control draws it without the tile rather than with a placeholder that looks like a broken image.
 */
const GLYPHS: Record<string, NavIcon> = {
  // The two directions of a page selection (`extract-pages`), and the same glyphs the sidebar and the catalogue use
  // for those tools — the choice a user clicks and the entry they clicked to get here are visibly the same thing.
  'page-keep': IconPageExtract,
  'page-remove': IconPageRemove,
};

export function choiceGlyph(name: string | undefined): NavIcon | null {
  if (!name) return null;
  return GLYPHS[name] ?? null;
}

/** Every name this map knows — the assertion in `./choice-glyph.test.ts` reads the catalog against it. */
export const CHOICE_GLYPH_NAMES = Object.keys(GLYPHS).sort();
