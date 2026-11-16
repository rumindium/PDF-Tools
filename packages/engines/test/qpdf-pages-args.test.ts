import { describe, expect, test } from 'bun:test';
import { buildQpdfPagesArgs } from '../src/index';

/**
 * The invariant that four handlers violated, each in their own copy of the argument list: qpdf accepts exactly one
 * `--pages`, whose pairs run until the terminating `--`. These tests are cheap and the bugs they describe reached
 * production three times, which is the entire argument for keeping this rule in one function.
 */

describe('buildQpdfPagesArgs', () => {
  test('emits exactly one --pages for any number of inputs', () => {
    const one = buildQpdfPagesArgs([{ path: 'a.pdf' }], 'out.pdf');
    const three = buildQpdfPagesArgs([{ path: 'a.pdf' }, { path: 'b.pdf' }, { path: 'c.pdf' }], 'out.pdf');
    expect(one.filter((arg) => arg === '--pages')).toHaveLength(1);
    expect(three.filter((arg) => arg === '--pages')).toHaveLength(1);
  });

  test('keeps the inputs and their ranges in the order given', () => {
    const args = buildQpdfPagesArgs(
      [{ path: 'first.pdf', range: '1-3' }, { path: 'second.pdf' }, { path: 'third.pdf', range: '2,5' }],
      'merged.pdf',
    );
    expect(args).toEqual([
      '--empty',
      '--pages',
      'first.pdf',
      '1-3',
      'second.pdf',
      '1-z',
      'third.pdf',
      '2,5',
      '--',
      'merged.pdf',
    ]);
  });

  test('defaults an omitted range to every page', () => {
    expect(buildQpdfPagesArgs([{ path: 'a.pdf' }], 'out.pdf')).toContain('1-z');
  });

  test('terminates with `--` immediately before the output path', () => {
    const args = buildQpdfPagesArgs([{ path: 'a.pdf' }, { path: 'b.pdf' }], 'result.pdf');
    expect(args.at(-1)).toBe('result.pdf');
    expect(args.at(-2)).toBe('--');
    // Nothing may follow the terminator except the output: an argument after it is read as a second input document.
    expect(args.slice(args.indexOf('--')).slice(1)).toEqual(['result.pdf']);
  });

  test('starts from `--empty`, so a merge never inherits an input xref', () => {
    expect(buildQpdfPagesArgs([{ path: 'a.pdf' }], 'out.pdf')[0]).toBe('--empty');
  });

  test('refuses an empty input list instead of building a command that cannot work', () => {
    expect(() => buildQpdfPagesArgs([], 'out.pdf')).toThrow();
  });
});
