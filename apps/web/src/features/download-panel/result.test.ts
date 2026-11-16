import { describe, expect, test } from 'bun:test';
import { comparePages, describeInputs, describeRetention } from './result';

describe('comparePages', () => {
  test('a merge that lost nothing says so', () => {
    expect(comparePages(84, 84)).toEqual({
      tone: 'success',
      label: 'Every page accounted for',
      detail: '84 pages in, 84 out.',
    });
  });

  test('a single page is written as one page', () => {
    expect(comparePages(1, 1)?.detail).toBe('1 page in, 1 out.');
  });

  test('more pages out than in is flagged rather than presented as normal', () => {
    const verdict = comparePages(84, 92);
    expect(verdict?.tone).toBe('warning');
    expect(verdict?.label).toBe('8 pages more than went in');
    expect(verdict?.detail).toBe('84 pages in, 92 out.');
  });

  test('fewer pages out is described without claiming a fault', () => {
    const verdict = comparePages(84, 42);
    expect(verdict?.tone).toBe('neutral');
    expect(verdict?.label).toBe('42 pages fewer than went in');
    expect(verdict?.detail).toContain('can produce fewer');
  });

  test('an unknown count refuses to compare instead of comparing against zero', () => {
    expect(comparePages(null, 84)).toBeNull();
    expect(comparePages(84, null)).toBeNull();
    expect(comparePages(null, null)).toBeNull();
  });
});

describe('describeInputs', () => {
  test('files, pages and size, in that order', () => {
    expect(describeInputs(3, 84, 12 * 1024 * 1024)).toBe('3 files · 84 pages · 12 MB');
  });

  test('an unknown page count is left out rather than shown as a dash', () => {
    expect(describeInputs(1, null, 1024)).toBe('1 file · 1.0 KB');
  });
});

describe('describeRetention', () => {
  const now = Date.parse('2026-09-23T10:00:00.000Z');

  test('minutes are counted from the deadline the server set', () => {
    expect(describeRetention('2026-09-23T10:29:00.000Z', now)).toEqual({
      expired: false,
      label: 'Deleted in 29 minutes.',
    });
  });

  test('a minute is written as one minute', () => {
    expect(describeRetention('2026-09-23T10:01:00.000Z', now)?.label).toBe('Deleted in 1 minute.');
  });

  test('under a minute does not round up to one', () => {
    expect(describeRetention('2026-09-23T10:00:30.000Z', now).label).toBe('Deleted in less than a minute.');
  });

  test('hours and days are used for long retentions', () => {
    expect(describeRetention('2026-09-23T12:30:00.000Z', now).label).toBe('Deleted in 2h 30m.');
    expect(describeRetention('2026-09-25T12:00:00.000Z', now).label).toBe('Deleted in 2 days.');
  });

  test('a deadline that has passed is stated as deleted, not as zero minutes', () => {
    expect(describeRetention('2026-09-23T09:59:00.000Z', now)).toEqual({
      expired: true,
      label: 'This result has been deleted.',
    });
  });

  test('no deadline on the row falls back to the plan rather than inventing one', () => {
    expect(describeRetention(null, now).label).toBe('Retention follows your plan.');
    expect(describeRetention('not a date', now).label).toBe('Retention follows your plan.');
  });
});
