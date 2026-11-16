import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPdf, countPagesInPdf } from '../../../scripts/dev/pdf-writer';
import { probePdf } from '../src/shared/pdf-probe';

/**
 * The API's page count is a byte scan, and it has exactly one structural obligation: the two windows it scans — the
 * header and the tail — must not share a byte. They did, which made every file smaller than the header window count
 * its page objects twice, so a one-page form was reported as two.
 *
 * These cases pin that, and they use the smallest PDFs the writer can produce rather than checking the arithmetic of
 * the windows: a probe that is right about large files and wrong about small ones is the bug, so the small file is
 * the case.
 */

const dir = await mkdtemp(join(tmpdir(), 'pdf-probe-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A page tree with **no** `/Count`, so the probe falls back to counting `/Type /Page` occurrences. */
function handWritten(pages: number): string {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ');
  const pageObjects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`,
  ).join('');
  return `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids}] >>\nendobj\n${pageObjects}trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
}

async function probe(name: string, bytes: string | Uint8Array) {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return probePdf(path);
}

describe('probePdf page count', () => {
  test('a file that fits inside the header window counts its pages once', async () => {
    // 400 bytes, so the whole document is inside the first 4096 — the exact shape the overlap broke.
    const bytes = handWritten(1);
    expect(bytes.length).toBeLessThan(4096);
    expect((await probe('one-page.pdf', bytes)).pages).toBe(1);
  });

  test('three hand-written pages are three, not six', async () => {
    expect((await probe('three-pages.pdf', handWritten(3))).pages).toBe(3);
  });

  test('a document with a /Count is read from the page tree, not from the page objects', async () => {
    // `buildPdf` writes `/Type /Pages` immediately followed by `/Count`, which is the cheap accurate path — and the
    // path the regression never touched. Kept here so the two branches are both asserted.
    const bytes = buildPdf({ pages: 2, label: 'Probe fixture' });
    expect(countPagesInPdf(bytes)).toBe(2);
    expect((await probe('counted.pdf', bytes)).pages).toBe(2);
  });

  test('a file bigger than the header window still counts every page', async () => {
    // 24 pages of labelled content pushes the file past 4096 bytes, so the head/tail split is exercised for real.
    const bytes = buildPdf({ pages: 24, label: 'Probe fixture long' });
    expect(bytes.length).toBeGreaterThan(4096);
    expect((await probe('twenty-four-pages.pdf', bytes)).pages).toBe(24);
  });

  test('encryption is reported and the count is withheld rather than guessed', async () => {
    const encrypted = `%PDF-1.7\n${handWritten(2)}trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n`;
    const result = await probe('encrypted.pdf', encrypted);
    expect(result.encrypted).toBe(true);
    expect(result.pages).toBeNull();
  });
});
