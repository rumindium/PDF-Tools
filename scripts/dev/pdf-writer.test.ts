import { describe, expect, test } from 'bun:test';
import { buildPdf, countPagesInPdf } from './pdf-writer';

/**
 * The fixture writer is test infrastructure, so it gets tested like production code — a malformed fixture would
 * make every downstream conversion test look like a bug in the tool being tested.
 *
 * The xref check is the important one: offsets are computed from byte positions, and an off-by-a-few xref is
 * accepted by lenient readers and rejected by strict ones, which is the worst kind of intermittency.
 */

describe('buildPdf', () => {
  test('produces the requested number of pages', () => {
    for (const pages of [1, 2, 7, 40]) {
      expect(countPagesInPdf(buildPdf({ pages, label: `test ${pages}` }))).toBe(pages);
    }
  });

  test('a page tree is not miscounted as a page', () => {
    // `/Type /Pages` contains `/Type /Page`; a naive substring count reports one page too many on every document.
    const bytes = buildPdf({ pages: 3 });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/Type /Pages');
    expect(countPagesInPdf(bytes)).toBe(3);
  });

  test('starts with a PDF header and ends with EOF', () => {
    const text = Buffer.from(buildPdf({ pages: 1 })).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  test('the cross-reference table points at the objects it claims', () => {
    const bytes = buildPdf({ pages: 2 });
    const text = Buffer.from(bytes).toString('latin1');

    const startxref = Number.parseInt(/startxref\s+(\d+)/.exec(text)?.[1] ?? '', 10);
    expect(Number.isFinite(startxref)).toBe(true);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    // Entry 0 is the free head; entry N must point at the literal bytes "N 0 obj".
    const header = /xref\s*\n(\d+) (\d+)\s*\n/.exec(text.slice(startxref));
    expect(header).not.toBeNull();
    const firstObjectNumber = Number(header![1]);
    const count = Number(header![2]);
    expect(firstObjectNumber).toBe(0);
    expect(count).toBeGreaterThan(2);

    // The table is: `xref`, `0 <count>`, then one entry per object starting with object 0 (the free head).
    const ledger = text.slice(startxref).split('\n');
    for (let objectNumber = 1; objectNumber < count; objectNumber += 1) {
      const entry = ledger[objectNumber + 2]!;
      const offset = Number.parseInt(entry.slice(0, 10), 10);
      expect(Number.isFinite(offset)).toBe(true);
      expect(text.slice(offset, offset + `${objectNumber} 0 obj`.length)).toBe(`${objectNumber} 0 obj`);
    }
  });

  test('the trailer declares every object and the root', () => {
    const text = Buffer.from(buildPdf({ pages: 4 })).toString('latin1');
    const size = Number.parseInt(/\/Size (\d+)/.exec(text)?.[1] ?? '', 10);
    expect(size).toBe(3 + 4 * 2 + 1);
    expect(text).toContain('/Root 1 0 R');
  });

  test('a custom page size reaches the page objects', () => {
    const text = Buffer.from(buildPdf({ pages: 1, pageSize: [842, 595] })).toString('latin1');
    expect(text).toContain('/MediaBox [0 0 842 595]');
  });

  test('parentheses in the label are escaped', () => {
    // An unescaped `)` would terminate the PDF string and corrupt the content stream.
    const text = Buffer.from(buildPdf({ pages: 1, label: 'Invoice (final)' })).toString('latin1');
    expect(text).toContain('Invoice \\(final\\)');
  });
});
