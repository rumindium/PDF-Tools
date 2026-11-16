import { describe, expect, test } from 'bun:test';
import { assertSafePartName, contentDisposition, deriveOutputName, sanitizeDisplayName } from '../src/shared/filenames';

/**
 * Filenames are the boundary between an untrusted string and a filesystem path, and this file exists because the
 * control-character stripping is a *rewrite* rather than a copy: the range it used to match was written as a
 * regex character class, which is invisible on review. These cases pin the behaviour it has to keep.
 */

describe('sanitizeDisplayName', () => {
  test('drops control characters and DEL', () => {
    expect(sanitizeDisplayName('la\u0000por\u001bti\u007fn.pdf')).toBe('laportin.pdf');
  });

  test('removes controls rather than turning them into spaces, and collapses runs of space', () => {
    // A tab and a newline are C0 controls like NUL, so they are dropped outright: the words around them are
    // joined instead of separated. That is the pre-existing rule and is kept as-is here — the point of these
    // cases is that the stripping still behaves the same, not that it behaves differently.
    expect(sanitizeDisplayName('  lap\toran\n\nfinal.pdf \n')).toBe('laporanfinal.pdf');
    expect(sanitizeDisplayName('laporan   keuangan.pdf')).toBe('laporan keuangan.pdf');
  });

  test('keeps only the last path segment', () => {
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDisplayName('C:\\Users\\boni\\laporan.pdf')).toBe('laporan.pdf');
    expect(sanitizeDisplayName('/var/tmp//x.pdf')).toBe('x.pdf');
  });

  test('leaves non-ASCII names alone instead of transliterating them', () => {
    expect(sanitizeDisplayName('Laporan Keuangan 2026 — Q1 📄.pdf')).toBe('Laporan Keuangan 2026 — Q1 📄.pdf');
  });

  test('falls back to "file" when nothing survives', () => {
    expect(sanitizeDisplayName('\u0000\u0001\u007f')).toBe('file');
    expect(sanitizeDisplayName('   ')).toBe('file');
    expect(sanitizeDisplayName('')).toBe('file');
  });

  test('truncates by code point, so it cannot cut a surrogate pair in half', () => {
    const long = '📄'.repeat(200);
    const result = sanitizeDisplayName(long);
    expect([...result].length).toBe(180);
    // A lone surrogate is not a character: it renders as mojibake and makes the Content-Disposition header throw.
    expect(() => encodeURIComponent(result)).not.toThrow();
    expect(result).toBe('📄'.repeat(180));
  });

  test('leaves a name that is already within the cap untouched', () => {
    const exact = 'a'.repeat(180);
    expect(sanitizeDisplayName(exact)).toBe(exact);
  });
});

describe('deriveOutputName', () => {
  test('appends the suffix to the stem and the extension once', () => {
    expect(deriveOutputName('laporan.pdf', '-compressed', '.pdf')).toBe('laporan-compressed.pdf');
    expect(deriveOutputName('laporan.pdf', '-compressed', 'pdf')).toBe('laporan-compressed.pdf');
  });

  test('sanitises the stem it derives from', () => {
    expect(deriveOutputName('../../etc/laporan.pdf', '-merged', '.pdf')).toBe('laporan-merged.pdf');
  });

  test('falls back to "document" when the input has no stem', () => {
    expect(deriveOutputName('.pdf', '-x', '.pdf')).toBe('document-x.pdf');
  });
});

describe('assertSafePartName', () => {
  test('accepts the names this service generates', () => {
    expect(assertSafePartName('merged-0f2b.pdf')).toBe('merged-0f2b.pdf');
  });

  test.each(['../escape.pdf', 'a/b.pdf', 'a\\b.pdf', '.hidden', '..', '', 'a b.pdf', 'x'.repeat(121)])(
    'rejects %p',
    (name) => {
      expect(() => assertSafePartName(name)).toThrow();
    },
  );
});

describe('contentDisposition', () => {
  test('carries an ASCII fallback plus the RFC 5987 form for non-ASCII names', () => {
    expect(contentDisposition('laporan keuangan.pdf')).toBe(
      'attachment; filename="laporan keuangan.pdf"; filename*=UTF-8\'\'laporan%20keuangan.pdf',
    );
    expect(contentDisposition('laporan — 2026.pdf', 'inline')).toBe(
      'inline; filename="laporan _ 2026.pdf"; filename*=UTF-8\'\'laporan%20%E2%80%94%202026.pdf',
    );
  });
});
