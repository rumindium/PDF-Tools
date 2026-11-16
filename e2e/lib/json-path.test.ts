import { describe, expect, test } from 'bun:test';
import { MISSING, parseJsonPathPair, readJsonPath } from './json-path';

/**
 * The reader's tests, written around the failures that would make a data case lie rather than fail.
 *
 * Every one of these is a shape the harness meets for real: `extract-fields` reports an array of fields, each with a
 * `rects` array, and the cases index into both. The interesting ones are the near-misses — a path that resolves to the
 * *parent* rather than the leaf, and a key read off an array — because those are the mistakes that assert something
 * true about the wrong thing.
 */

const BODY = {
  widgets: 6,
  fields: [
    { name: 'employee_name', type: 'text', value: null, required: true, maxLength: 80, rects: [{ xPt: 72 }] },
    {
      name: 'shift',
      type: 'radio',
      value: false,
      required: false,
      rects: [{ xPt: 72 }, { xPt: 100 }],
    },
  ],
  notes: ['a', 'b'],
  empty: {},
};

describe('readJsonPath', () => {
  test('reads a top-level key', () => {
    expect(readJsonPath(BODY, 'widgets')).toBe(6);
  });

  test('reads into an array element and a nested array element', () => {
    expect(readJsonPath(BODY, 'fields[0].name')).toBe('employee_name');
    expect(readJsonPath(BODY, 'fields[1].rects[1].xPt')).toBe(100);
  });

  test('keeps false and null apart from missing', () => {
    // `false` is a value a checkbox case asserts; `null` is an empty text field. Neither may read as "no such path",
    // or a case asserting `false` would fail against a field that is genuinely false.
    expect(readJsonPath(BODY, 'fields[1].value')).toBe(false);
    expect(readJsonPath(BODY, 'fields[0].value')).toBe(null);
    expect(readJsonPath(BODY, 'fields[0].absent')).toBe(MISSING);
    // `undefined` inside an object is the same non-answer as a key that is not there.
    expect(readJsonPath({ a: undefined }, 'a')).toBe(MISSING);
  });

  test('does not read an array index out of a key of the same name', () => {
    expect(readJsonPath(BODY, 'notes[1]')).toBe('b');
    expect(readJsonPath(BODY, 'notes.nope')).toBe(MISSING);
    expect(readJsonPath(BODY, 'fields[9].name')).toBe(MISSING);
  });

  test('refuses to read keys off arrays and indexes off objects', () => {
    // The near-miss this catches: `fields.length` would be `2` if the reader treated an array as an object, and a case
    // that meant to assert the tool's own count would then be asserting JavaScript's.
    expect(readJsonPath(BODY, 'fields.length')).toBe(MISSING);
    expect(readJsonPath(BODY, 'widgets[0]')).toBe(MISSING);
    expect(readJsonPath(BODY, 'widgets.name')).toBe(MISSING);
  });

  test('walks through a null in the middle rather than throwing', () => {
    expect(readJsonPath(BODY, 'fields[0].value.deeper')).toBe(MISSING);
    expect(readJsonPath(null, 'anything')).toBe(MISSING);
  });

  test('treats an empty segment as a missing key, not as the whole body', () => {
    expect(readJsonPath(BODY, 'fields..name')).toBe(MISSING);
    // The one answer that would make a case vacuous: an empty path returning the body itself, so `''` compares against
    // whatever the case declared and passes whenever the expectation happens to be an object.
    expect(readJsonPath(BODY, '')).toBe(MISSING);
  });
});

describe('parseJsonPathPair', () => {
  test('parses typed values, so `true` is a boolean', () => {
    expect(parseJsonPathPair('required=true')).toEqual(['required', true]);
    expect(parseJsonPathPair('widgets=6')).toEqual(['widgets', 6]);
    expect(parseJsonPathPair('fields[0].value=null')).toEqual(['fields[0].value', null]);
    expect(parseJsonPathPair('fields[0].name="employee_name"')).toEqual(['fields[0].name', 'employee_name']);
  });

  test('keeps a bare word a string', () => {
    expect(parseJsonPathPair('fields[0].type=text')).toEqual(['fields[0].type', 'text']);
  });

  test('splits at the first = so a value may contain one, or end in one', () => {
    // Both directions matter and only the first `=` satisfies both: a query string of the case's own, and base64
    // padding — which the last `=` turns into an empty value, a truncation nothing about the failure would explain.
    expect(parseJsonPathPair('url=https://example.test/?a=1&b=2')).toEqual(['url', 'https://example.test/?a=1&b=2']);
    expect(parseJsonPathPair('token=YWJj=')).toEqual(['token', 'YWJj=']);
  });

  test('rejects a pair with no path or no =', () => {
    expect(parseJsonPathPair('name')).toBeNull();
    expect(parseJsonPathPair('=value')).toBeNull();
  });
});
