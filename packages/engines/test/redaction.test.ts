import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { JobFailure } from '@pdftools/errors';
import { REDACT_RECT_MAX, planRedactionRegions, removableTokens, searchableBytes } from '../src/redaction';

/**
 * The two halves of `redact` that are pure logic, and both of them decide whether a job is allowed to succeed.
 *
 * `planRedactionRegions` is the refusal path: a rectangle that names a page the document does not have, or that lies
 * off the page, is a coordinate mistake, and the alternative to refusing it is a job that reports success and erased
 * nothing. `removableTokens` is the other direction — the filter that decides which strings the verification is
 * *allowed* to assert the absence of. It is the difference between a check that catches a leak and a check that fails
 * every honest job, so its two failure modes (too strict, too weak) are both tested here rather than in the suite,
 * where they would look like a product bug.
 */

const A4 = { widthPt: 595, heightPt: 842 };
const BOX = { x: 66, y: 594, w: 380, h: 24 };

function failure(action: () => unknown): JobFailure {
  try {
    action();
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error('expected a JobFailure, and the call returned');
}

describe('planRedactionRegions', () => {
  test('numbers the rectangles in job order, which is how the verification refers to them', () => {
    const plan = planRedactionRegions(
      [
        { page: 1, rects: [BOX, { ...BOX, y: 474 }] },
        { page: 2, rects: [BOX] },
      ],
      [A4, A4, A4],
      '#000000',
    );
    expect(plan.rectangles.map((rectangle) => rectangle.index)).toEqual([1, 2, 3]);
    expect(plan.rectangles.map((rectangle) => rectangle.page)).toEqual([1, 1, 2]);
    expect(plan.pages).toEqual([1, 2]);
    expect(plan.offPage).toBe(0);
  });

  test('a per-page fill overrides the job-wide one, and both arrive as 0-1 channels', () => {
    const plan = planRedactionRegions(
      [
        { page: 1, rects: [BOX], fill: '#ff0000' },
        { page: 2, rects: [BOX] },
      ],
      [A4, A4],
      '#000080',
    );
    expect(plan.rectangles[0]?.fill).toEqual({ r: 1, g: 0, b: 0 });
    expect(plan.rectangles[1]?.fill).toEqual({ r: 0, g: 0, b: 128 / 255 });
  });

  test('a page the document does not have is refused, and the message names both numbers', () => {
    const refused = failure(() => planRedactionRegions([{ page: 9, rects: [BOX] }], [A4], '#000000'));
    expect(refused.code).toBe('VALIDATION_ERROR');
    expect(refused.message).toContain('page 9');
    expect(refused.message).toContain('1 page');
  });

  test('a rectangle that does not intersect its page is refused rather than silently ignored', () => {
    const refused = failure(() => planRedactionRegions([{ page: 1, rects: [{ ...BOX, y: 900 }] }], [A4], '#000000'));
    expect(refused.code).toBe('VALIDATION_ERROR');
    expect(refused.message).toContain('outside the page');
  });

  test('a rectangle that only partly leaves the page is clipped and reported, not refused', () => {
    // 40 pt above the paper, 30 of which are outside: the user's mark is real, it is just larger than the page.
    const plan = planRedactionRegions([{ page: 1, rects: [{ x: 10, y: 820, w: 200, h: 40 }] }], [A4], '#000000');
    const rectangle = plan.rectangles[0]!;
    expect(rectangle.offPage).toBe(true);
    expect(rectangle.clipped).toEqual({ x: 10, y: 820, w: 200, h: 22 });
    expect(rectangle.rect).toEqual({ x: 10, y: 820, w: 200, h: 40 });
    expect(plan.offPage).toBe(1);
  });

  test('a rectangle with no area is refused — a vertical line erases nothing', () => {
    const refused = failure(() => planRedactionRegions([{ page: 1, rects: [{ ...BOX, w: 0 }] }], [A4], '#000000'));
    expect(refused.code).toBe('VALIDATION_ERROR');
    expect(refused.message).toContain('no area');
  });

  test('more than 20 rectangles on one page is refused, before any of them is applied', () => {
    const rects = Array.from({ length: 21 }, (_, index) => ({ ...BOX, y: 400 + index * 30 }));
    const refused = failure(() => planRedactionRegions([{ page: 1, rects }], [A4], '#000000'));
    expect(refused.code).toBe('VALIDATION_ERROR');
    expect(refused.message).toContain('21 redaction rectangles');
  });

  test('the job-wide cap counts rectangles, not page groups', () => {
    // Every group is inside the per-page limit and the job as a whole is not: the check has to add them up rather
    // than look at each region on its own. This is the arithmetic the contract's `superRefine` mirrors at the door.
    const regions = Array.from({ length: 11 }, (_, page) => ({
      page: page + 1,
      rects: Array.from({ length: 19 }, () => BOX),
    }));
    const refused = failure(() =>
      planRedactionRegions(
        regions as never,
        Array.from({ length: 11 }, () => A4),
        '#000000',
      ),
    );
    expect(refused.code).toBe('VALIDATION_ERROR');
    expect(refused.message).toContain(String(REDACT_RECT_MAX));
  });
});

describe('removableTokens', () => {
  test('keeps a token whose every occurrence was inside the marked areas', () => {
    const tokens = removableTokens('Account ACCT-4471-9930 belongs to Nadia', ['Account ACCT-4471-9930']);
    expect(tokens).toContain('ACCT-4471-9930');
    expect(tokens).toContain('Account');
    expect(tokens).not.toContain('Nadia');
  });

  test('drops a token that also occurs outside them, because its survival is correct', () => {
    const document = 'SHARED-7731 inside the marked area SHARED-7731 outside every marked area';
    const tokens = removableTokens(document, ['SHARED-7731 inside the marked area']);
    expect(tokens).not.toContain('SHARED-7731');
    expect(tokens).toContain('inside');
  });

  test('counts occurrences rather than presence, so a token twice inside and once outside is dropped', () => {
    const document = 'SECRET-9911 SECRET-9911 elsewhere SECRET-9911';
    expect(removableTokens(document, ['SECRET-9911 SECRET-9911'])).not.toContain('SECRET-9911');
    expect(removableTokens('SECRET-9911 SECRET-9911 elsewhere', ['SECRET-9911 SECRET-9911'])).toContain('SECRET-9911');
  });

  test('ignores fragments too short to be evidence', () => {
    // Four characters is the floor: below it a "token" is a word fragment that would match half the document.
    const tokens = removableTokens('a of the 42 PIN', ['a of the 42 PIN']);
    expect(tokens).toEqual([]);
  });

  test('keeps the account-shaped tokens a redaction is usually aimed at', () => {
    const tokens = removableTokens('7712-0031-8842 nadia.rahman@example.com /v2/ledger', [
      '7712-0031-8842 nadia.rahman@example.com /v2/ledger',
    ]);
    // A leading slash is not part of the token: the match starts at a letter or digit, which is what keeps `-` inside
    // the pattern rather than at its edge.
    expect(tokens).toEqual(['7712-0031-8842', 'nadia.rahman@example.com', 'v2/ledger']);
  });

  test('an empty region text produces no tokens, which is what a blank rectangle looks like', () => {
    expect(removableTokens('public text', [''])).toEqual([]);
  });
});

describe('searchableBytes', () => {
  test('reads a value the file carries as a hex string, which is how the engine writes one back', async () => {
    // The measured shape rather than an invented one: PyMuPDF writes the page label below back as this hex string
    // (`7265…` is UTF-8 for `redact fixture — page 1 of 1`, em dash and all) where the input carried the same words as
    // a `(…) Tj` literal. The verification searches this haystack for values that survived the rewrite, so a reading
    // that stopped at literals would be blind to a leak exactly in the files this tool produces.
    const label = 'redact fixture — page 1 of 1';
    const content = Buffer.from(`BT /F1 20 Tf 72 746 TD <${Buffer.from(label, 'utf8').toString('hex')}>Tj ET`, 'utf8');
    const body = deflateSync(content);
    const cwd = await mkdtemp(join(tmpdir(), 'pdftools-redact-'));
    try {
      const file = join(cwd, 'redacted.pdf');
      await writeFile(
        file,
        Buffer.concat([
          Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
          body,
          // Plus a hex string in the object half, with the byte-order mark a producer writes for text one byte per
          // character cannot hold: a `/Info` copy is an object, so it never reaches the inflater at all.
          Buffer.from(
            '\nendstream\nendobj\ntrailer\n<< /Info << /Title <FEFF005300650063007200650074> >> >>\n%%EOF\n',
            'latin1',
          ),
        ]),
      );

      const bytes = await searchableBytes(file);
      // The two literal halves cannot see it, which is what makes the third one load-bearing rather than redundant.
      expect(bytes.raw).not.toContain('redact fixture');
      expect(bytes.inflated).not.toContain('redact fixture');
      expect(bytes.hex).toContain(label);
      expect(bytes.hex).toContain('Secret');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
