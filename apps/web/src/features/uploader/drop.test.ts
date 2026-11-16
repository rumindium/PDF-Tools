import { describe, expect, test } from 'bun:test';
import { acceptLabel, hasFilePayload, mimeTokensFromAccept, typeRejection } from './drop';

/** The accept attribute `merge` produces: the PDF family's extension and MIME, then the unconditional PDF entry. */
const PDFS = '.pdf,application/pdf';
/** `pdf-to-images`-style mixed list, to cover both halves of the parsing. */
const MIXED = '.pdf,application/pdf,.jpg,.jpeg,.png,.webp,image/*';

describe('hasFilePayload', () => {
  test('a file drag is recognised', () => {
    expect(hasFilePayload(['Files'])).toBe(true);
    expect(hasFilePayload(['text/plain', 'FILES'])).toBe(true);
  });

  test('a text or element drag is not', () => {
    expect(hasFilePayload(['text/plain'])).toBe(false);
    expect(hasFilePayload(undefined)).toBe(false);
    expect(hasFilePayload([])).toBe(false);
  });
});

describe('accept parsing', () => {
  test('only the MIME entries are tokens', () => {
    expect(mimeTokensFromAccept(PDFS)).toEqual(['application/pdf']);
    expect(mimeTokensFromAccept(MIXED)).toEqual(['application/pdf', 'image/*']);
  });

  test('the label is built from extensions, not MIME types', () => {
    expect(acceptLabel(PDFS)).toBe('PDF');
    expect(acceptLabel(MIXED)).toBe('PDF, JPG, PNG, WEBP');
  });

  test('duplicate extensions are said once', () => {
    expect(acceptLabel('.pdf,.jpg,.JPEG,application/pdf')).toBe('PDF, JPG');
  });

  test('a list with no extensions falls back to the MIME entries', () => {
    expect(acceptLabel('application/pdf,image/*')).toBe('application/pdf, image/*');
    expect(acceptLabel('')).toBe('the accepted formats');
  });
});

describe('typeRejection', () => {
  test('a stated wrong type is refused with the list it should have been', () => {
    expect(typeRejection({ name: 'notes.docx', type: 'application/msword' }, PDFS)).toBe(
      'notes.docx — this tool takes PDF only.',
    );
  });

  test('an image is refused where only PDFs are wanted, and a PDF where images are wanted', () => {
    expect(typeRejection({ name: 'scan.png', type: 'image/png' }, PDFS)).toBe('scan.png — this tool takes PDF only.');
    expect(typeRejection({ name: 'doc.pdf', type: 'application/pdf' }, '.png,image/png')).toBe(
      'doc.pdf — this tool takes PNG only.',
    );
  });

  test('the exact type, and anything under a wildcard family, is accepted', () => {
    expect(typeRejection({ name: 'a.pdf', type: 'application/pdf' }, PDFS)).toBeNull();
    expect(typeRejection({ name: 'a.heic', type: 'image/heic' }, MIXED)).toBeNull();
    expect(typeRejection({ name: 'a.webp', type: 'image/webp' }, MIXED)).toBeNull();
  });

  test('an unstated type is not a verdict — the API detects the real one from the bytes', () => {
    expect(typeRejection({ name: 'mystery', type: '' }, PDFS)).toBeNull();
    expect(typeRejection({ name: 'mystery', type: '   ' }, PDFS)).toBeNull();
  });

  test('an empty accept list refuses nothing', () => {
    expect(typeRejection({ name: 'a.zip', type: 'application/zip' }, '')).toBeNull();
  });
});
