import { describe, expect, test } from 'bun:test';
import { TOOLS } from '@pdftools/contracts/tools';
import { CHOICE_GLYPH_NAMES, choiceGlyph } from './choice-glyph';

/**
 * The one thing a name in the catalog cannot check for itself.
 *
 * `OptionsUiField.choices[].icon` is a string in JSON that the API serves and the web app resolves into a glyph. A
 * name nothing resolves is not an error anywhere in that chain — the card renders without its tile, the JSON stays
 * valid, and the only way to notice is to look at the page and wonder. So the assertion lives on the side that owns
 * the icon set, and it reads the catalog rather than a list kept here: every icon any tool declares, in every choice,
 * has to resolve.
 */
describe('the catalog’s choice glyphs', () => {
  test('every icon any tool declares resolves in the web icon set', () => {
    const declared = TOOLS.flatMap((tool) =>
      tool.optionsUi.flatMap((field) =>
        (field.choices ?? []).flatMap((choice) => (choice.icon ? [{ tool: tool.id, icon: choice.icon }] : [])),
      ),
    );
    // The map is not empty, and the tools that exist today are in it — otherwise this test passes by covering nothing.
    expect(CHOICE_GLYPH_NAMES.length).toBeGreaterThan(0);
    expect(declared.map((entry) => entry.tool)).toContain('extract-pages');

    const unresolved = declared.filter((entry) => choiceGlyph(entry.icon) == null);
    expect(unresolved).toEqual([]);
  });

  test('no icon, and an unknown name, draw nothing rather than a placeholder', () => {
    expect(choiceGlyph(undefined)).toBeNull();
    expect(choiceGlyph('page-keep')).not.toBeNull();
    // A name that is gone from the map is what the assertion above catches; this is the behaviour that makes it a
    // caught mistake instead of a broken tile in production.
    expect(choiceGlyph('not-an-icon')).toBeNull();
  });
});
