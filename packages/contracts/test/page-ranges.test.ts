import { describe, expect, test } from 'bun:test';
import { DeletePagesOptions, ExtractPagesOptions, SplitOptions, validateOptions } from '../src/tools';
import { PAGE_RANGE_PATTERN, PageRangeError, expandPageSpecs, isPageRangeToken } from '../src/tools/page-ranges';

/**
 * The page-selection grammar of `docs/02-SPLIT-AND-EXTRACT.md` §2, tested where it is defined.
 *
 * Three layers parse this: the API's schema, the web form's validator, and the workers' expansion. The suite is
 * organised around the four things that must not drift between them —
 *
 *  - **every documented spelling expands to the pages it names.** `10-z`, `even` and `odd` are in the doc's grammar
 *    table, were in its examples, and were refused by both the schema and the parser until this pass (defect 124), so
 *    each has a case that would have failed then;
 *  - **the parser and the schema agree on what a token is.** `PAGE_RANGE_PATTERN` is the single source, and the cases
 *    below assert the two agree by running both on the same list rather than by reading it;
 *  - **a spec that cannot be honoured is refused, not guessed.** `9-5` counts backwards, `1-` looks like "to the end"
 *    and is not, `9-z` on five pages names a page that does not exist, and `z`/`even`/`odd` without a page count are
 *    refused rather than resolved against a number nobody has;
 *  - **one option's pages are the same pages in every tool that takes them.** The three registry entries at the bottom
 *    parse the same strings, because a grammar implemented per tool is a grammar per tool.
 */

describe('every documented spelling', () => {
  test('expands a page, a range and a union of specs', () => {
    expect(expandPageSpecs(['7'])).toEqual([7]);
    expect(expandPageSpecs(['1-5'])).toEqual([1, 2, 3, 4, 5]);
    expect(expandPageSpecs(['2', '5-6', '9'])).toEqual([2, 5, 6, 9]);
  });

  test('resolves the last-page spelling against the document it is given', () => {
    // The count is an argument, which is the whole point of the syntax: "to the end" does not need to know how many
    // pages there are, and the answer changes with the document.
    expect(expandPageSpecs(['3-z'], 6)).toEqual([3, 4, 5, 6]);
    expect(expandPageSpecs(['3-z'], 3)).toEqual([3]);
    expect(expandPageSpecs(['1-z'], 1)).toEqual([1]);
  });

  test('expands the parity shorthands over the document’s own pages', () => {
    expect(expandPageSpecs(['even'], 6)).toEqual([2, 4, 6]);
    expect(expandPageSpecs(['odd'], 6)).toEqual([1, 3, 5]);
    // A five-page document has three odd pages and two even ones — the shorthand is a filter over the count, not a
    // fixed list.
    expect(expandPageSpecs(['odd'], 5)).toEqual([1, 3, 5]);
    expect(expandPageSpecs(['even'], 5)).toEqual([2, 4]);
  });

  test('keeps the order it was given, because a selection is also a page order', () => {
    // `split`'s ranges are explicit page lists: `5,1` is a re-ordering, and a parser that sorted would silently
    // produce a different document.
    expect(expandPageSpecs(['5', '1'])).toEqual([5, 1]);
    expect(expandPageSpecs(['3-z', '1'], 4)).toEqual([3, 4, 1]);
  });

  test('is the same list of tokens at the schema as at the parser', () => {
    // The schema is the door and the parser is the engine, and the two are read from the same pattern. Asserted in
    // the direction that matters: **every token the parser can honour, the schema accepts** — the other direction has
    // exactly one documented exception, below, and it is a division of labour rather than a disagreement.
    const honoured = ['1', '1-5', '7-z', 'even', 'odd'];
    for (const token of honoured) {
      expect(isPageRangeToken(token)).toBe(true);
      expect(ExtractPagesOptions.safeParse({ pages: [token] }).success).toBe(true);
      expect(() => expandPageSpecs([token], 10)).not.toThrow();
    }
    // And what the grammar does not have is refused by both layers before a worker is ever asked to run a job.
    for (const token of ['1-', '1-2-3', 'z1', 'EVEN', '', 'zwz']) {
      expect(isPageRangeToken(token)).toBe(false);
      expect(ExtractPagesOptions.safeParse({ pages: [token] }).success).toBe(false);
    }
    // The pattern itself, not a copy of it: this case exists so that changing the grammar is a one-file decision.
    expect(PAGE_RANGE_PATTERN.source).toContain('z');
  });

  test('leaves a backwards range to the parser, which is the only layer that can compare two numbers', () => {
    // `9-5` is well-formed syntax and meaningless arithmetic: a regex cannot see the difference, so the schema accepts
    // it and the expansion refuses it. Stated here because "the schema accepts a range the parser rejects" reads as a
    // disagreement otherwise, and because a future attempt to do it in the regexp would fail this case.
    expect(ExtractPagesOptions.safeParse({ pages: ['9-5'] }).success).toBe(true);
    expect(() => expandPageSpecs(['9-5'])).toThrow(/counts backwards/);
  });
});

describe('a spec that cannot be honoured', () => {
  test('a backwards range names the token and the correct spelling', () => {
    expect(() => expandPageSpecs(['9-5'])).toThrow(PageRangeError);
    expect(() => expandPageSpecs(['9-5'])).toThrow(/counts backwards/);
    expect(() => expandPageSpecs(['9-5'])).toThrow(/5-9/);
  });

  test('an open range is refused rather than read as the single page it starts at', () => {
    // `1-` is what a user types when they mean "to the end". Reading it as page 1 is a wrong answer delivered
    // confidently, and the documented spelling for it is `1-z`.
    expect(isPageRangeToken('1-')).toBe(false);
    expect(() => expandPageSpecs(['1-'])).toThrow(/not a page range/);
  });

  test('a last page the document does not have is refused with the count', () => {
    // Distinct from `1-99` on a 20-page document, which the callers clip: `9-z` on five pages resolves to *nothing*,
    // and an empty selection that looks like a successful one is worse than a refusal.
    expect(() => expandPageSpecs(['9-z'], 5)).toThrow(/This document has 5 pages; page 9 does not exist/);
  });

  test('does not clip a range that reaches past the document', () => {
    // Deliberate: `split` refuses this with the real page count (§2) while the page-stamping tools keep the pages
    // that exist, and both readings need the same expansion. The expansion is not where the decision is made.
    expect(expandPageSpecs(['1-99'], 5)).toHaveLength(99);
  });

  test('a count-dependent spec without a count is refused, not guessed', () => {
    for (const token of ['3-z', 'even', 'odd']) {
      expect(() => expandPageSpecs([token])).toThrow(/needs the document's page count/);
    }
    // `1-3` does not need one, and a tool that has not counted its pages must still accept it.
    expect(expandPageSpecs(['1-3'])).toEqual([1, 2, 3]);
  });

  test('page zero and negative pages are refused', () => {
    expect(() => expandPageSpecs(['0'])).toThrow(/numbered from 1/);
    expect(() => expandPageSpecs(['0-3'])).toThrow(/numbered from 1/);
    // `-3` is not a page at all: the pattern refuses it as malformed, which is the earlier and more accurate answer.
    expect(() => expandPageSpecs(['-3'])).toThrow(/not a page range/);
  });

  test('a spec wider than one job allows is refused instead of expanded', () => {
    expect(() => expandPageSpecs(['1-5000'])).not.toThrow();
    expect(() => expandPageSpecs(['1-5001'])).toThrow(/more pages than one job allows/);
  });
});

describe('the tools that take a page selection', () => {
  test('parse the documented grammar through the registry schema', () => {
    // Through `validateOptions`, the same door the API and the worker use, so this is the *registry's* acceptance and
    // not a schema read from the file.
    expect(validateOptions('extract-pages', { pages: ['2-z'] }).ok).toBe(true);
    expect(validateOptions('extract-pages', { pages: ['even'] }).ok).toBe(true);
    expect(validateOptions('delete-pages', { pages: ['odd'] }).ok).toBe(true);
    expect(validateOptions('split', { mode: 'ranges', ranges: [['1-3'], ['4-z']] }).ok).toBe(true);
  });

  test('refuse a token the grammar does not have, with a sentence naming the grammar', () => {
    const result = validateOptions('extract-pages', { pages: ['1-'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('pages.0');
    expect(result.issues[0]?.message).toContain('10-z');
  });

  test('give the same grammar to a union of ranges as to a single selection', () => {
    // `ranges` is `string[][]` — one array per output — and both layers of it are the same grammar.
    expect(SplitOptions.safeParse({ mode: 'ranges', ranges: [['even'], ['1-z']] }).success).toBe(true);
    expect(ExtractPagesOptions.safeParse({ pages: ['1-z'] }).success).toBe(true);
    expect(DeletePagesOptions.safeParse({ pages: ['odd', '2-z'] }).success).toBe(true);
  });
});
