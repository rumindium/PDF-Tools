import { describe, expect, test } from 'bun:test';
import { resolveDisposition } from '../src/services/download-service';
import { contentDisposition } from '../src/shared/filenames';

/**
 * Inline versus attachment (`0-API.md` §4.5).
 *
 * The question this pins is not cosmetic: an inline response is a document the browser renders on **this origin**,
 * and one of the tools in this repository produces HTML. The list has to be an allow-list, and the fallback has to be
 * the file rather than an error — a caller that asked to preview a zip should get a zip.
 */

describe('resolveDisposition', () => {
  test('a PDF asked for inline is inline, and by default it is an attachment', () => {
    expect(resolveDisposition('inline', 'application/pdf')).toBe('inline');
    expect(resolveDisposition(undefined, 'application/pdf')).toBe('attachment');
    expect(resolveDisposition('attachment', 'application/pdf')).toBe('attachment');
  });

  test('images are renderable content', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']) {
      expect(resolveDisposition('inline', mime)).toBe('inline');
    }
  });

  test('HTML is never served inline, whatever the caller asks', () => {
    // The result of `pdf-to-html` is a document that may carry a `<script>`; rendering it here would be running
    // untrusted markup on the API's own origin.
    expect(resolveDisposition('inline', 'text/html')).toBe('attachment');
    expect(resolveDisposition('inline', 'image/svg+xml')).toBe('attachment');
    expect(resolveDisposition('inline', 'application/xhtml+xml')).toBe('attachment');
  });

  test('archives and office formats fall back to a download', () => {
    expect(resolveDisposition('inline', 'application/zip')).toBe('attachment');
    expect(
      resolveDisposition('inline', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('attachment');
  });

  test('a parameterised type is judged on its media type alone', () => {
    expect(resolveDisposition('inline', 'application/pdf; charset=binary')).toBe('inline');
    expect(resolveDisposition('inline', 'TEXT/HTML; charset=utf-8')).toBe('attachment');
  });

  test('an unknown or absent type is never inline', () => {
    expect(resolveDisposition('inline', 'application/octet-stream')).toBe('attachment');
    expect(resolveDisposition('inline', '')).toBe('attachment');
  });

  test('only the exact word grants it, so a misspelling is not a grant', () => {
    expect(resolveDisposition('INLINE', 'application/pdf')).toBe('attachment');
    expect(resolveDisposition(' inline', 'application/pdf')).toBe('attachment');
    expect(resolveDisposition('inlineish', 'application/pdf')).toBe('attachment');
  });

  test('the header it produces keeps the filename, with the right token', () => {
    expect(contentDisposition('merged.pdf', 'inline')).toContain('inline');
    expect(contentDisposition('merged.pdf')).toContain('attachment');
    expect(contentDisposition('merged.pdf', 'inline')).toContain('merged.pdf');
  });
});
