import { describe, expect, test } from 'bun:test';
import { type FormField, formFieldsToCsv } from '../src/forms';

/**
 * The half of `extract-fields` that runs on the host: turning a field list into CSV.
 *
 * The walk itself is Python inside the worker image and cannot be unit-tested here — it needs pikepdf — so its test is
 * the fixture generator's cross-engine verification plus the golden case that indexes into the third field's *second*
 * widget. What is left on this side is the writer, and the two decisions it encodes are both about a caller who opens
 * the file in a spreadsheet: quoting, and whether the `value` column exists at all.
 */

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    name: 'employee_name',
    type: 'text',
    value: null,
    page: 1,
    rects: [{ page: 1, xPt: 72, yPt: 640, widthPt: 248, heightPt: 24 }],
    required: false,
    readOnly: false,
    maxLength: null,
    options: [],
    hasAppearance: true,
    flags: 0,
    ...overrides,
  };
}

describe('formFieldsToCsv', () => {
  test('writes a header and one row per field, with the value column last', () => {
    const csv = formFieldsToCsv([field(), field({ name: 'acknowledged', type: 'checkbox', value: true })], true);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('name,type,page,required,readOnly,maxLength,options,value');
    expect(lines[1]).toBe('employee_name,text,1,false,false,,,');
    expect(lines[2]).toBe('acknowledged,checkbox,1,false,false,,,true');
    expect(csv.endsWith('\n')).toBe(true);
  });

  test('drops the column rather than blanking it when values were not asked for', () => {
    // The reason this is a column and not an empty cell: an empty cell is indistinguishable from an empty field, so a
    // schema export and a filtered view of the data would be the same file.
    const csv = formFieldsToCsv([field({ value: 'Boni Pratama' })], false);
    expect(csv.split('\n')[0]).toBe('name,type,page,required,readOnly,maxLength,options');
    expect(csv).not.toContain('Boni Pratama');
    expect(csv).not.toContain('value');
  });

  test('quotes a name that would otherwise break the row, and doubles its quotes', () => {
    const csv = formFieldsToCsv([field({ name: 'Last name, first' }), field({ name: 'He said "yes"' })], false);
    const lines = csv.trim().split('\n');
    expect(lines[1]?.startsWith('"Last name, first",')).toBe(true);
    expect(lines[2]?.startsWith('"He said ""yes""",')).toBe(true);
  });

  test('wraps a newline inside a cell in quotes, so the row is still one record', () => {
    const csv = formFieldsToCsv([field({ type: 'choice', options: ['Finance', 'IT'] })], false);
    expect(csv).toContain('Finance | IT');

    const withNewline = formFieldsToCsv([field({ name: 'a\nb' })], false);
    const [, ...body] = withNewline.split('\n');
    // Asserted as the *whole* row rather than as a line count, because the line count is 3 either way — the quoting is
    // what makes those two physical lines one record, and a test that counted lines would pass for a writer that never
    // quoted a thing. The first character is the quote, so the newline is inside it. The schema export has seven
    // columns, which is why the row ends in two empty cells (maxLength and options) rather than three.
    expect(body.join('\n')).toMatch(/^"a\nb",text,1,false,false,,\n$/);
  });

  test('writes a radio group once, with every option in its options column', () => {
    const radio = field({
      name: 'shift',
      type: 'radio',
      value: false,
      rects: [
        { page: 1, xPt: 72, yPt: 520, widthPt: 14, heightPt: 14 },
        { page: 1, xPt: 100, yPt: 520, widthPt: 14, heightPt: 14 },
      ],
    });
    const csv = formFieldsToCsv([radio], true);
    expect(csv.trim().split('\n').length).toBe(2);
    // The rectangle list is deliberately not a column: a per-widget position belongs in the JSON output, where it has
    // a shape that can hold it, rather than flattened into one cell a caller cannot parse.
    expect(csv).not.toContain('xPt');
  });
});
