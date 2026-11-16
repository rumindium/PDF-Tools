import { describe, expect, test } from 'bun:test';
import {
  type PlannedSignature,
  type SignatureRecord,
  planSignaturePlacements,
  resolveSignedAt,
  signatureBorders,
  signatureImageOverlay,
  signatureInvalidatedWarning,
  signatureLines,
  signatureMetaOverlay,
  signatureTextOverlay,
} from '../src/signatures';

/**
 * The half of `sign` that runs on the host: units, line composition and overlay planning.
 *
 * Everything that needs an engine — the Ghostscript typesetting, the pikepdf image matrix, the metadata write and the
 * read-back — is Python inside the worker image and cannot be unit-tested here. What *can* be is the arithmetic that
 * decides where the ink goes, and this is where the mistakes that no golden case would catch live: a `mm` value that
 * skipped its conversion, a `percent` read as a share of the box instead of the page, or a set of overlay pages that
 * is not in the same order as the merge map the handler builds beside it.
 */

const A4 = { widthPt: 595.28, heightPt: 841.89 };
const LETTER_LANDSCAPE = { widthPt: 792, heightPt: 612 };

function placement(overrides: Partial<Parameters<typeof planSignaturePlacements>[0][number]> = {}) {
  return { page: 1, x: 72, y: 100, w: 200, h: 60, units: 'pt' as const, ...overrides };
}

describe('planSignaturePlacements', () => {
  test('points pass through unchanged, and the target page travels with the box', () => {
    const [planned] = planSignaturePlacements([placement()], [A4]);
    expect(planned).toMatchObject({ page: 1, xPt: 72, yPt: 100, wPt: 200, hPt: 60, offPage: false });
    // The overlay page has to be the *target page's* size, not the box's: pikepdf scales an overlay page to the
    // rectangle it decorates, so anything else stretches every stamp on it.
    expect(planned!.pageWidthPt).toBe(A4.widthPt);
    expect(planned!.pageHeightPt).toBe(A4.heightPt);
  });

  test('millimetres are converted, so a 25.4 mm box is 72 pt', () => {
    const [planned] = planSignaturePlacements([placement({ x: 25.4, y: 25.4, w: 25.4, h: 25.4, units: 'mm' })], [A4]);
    expect(planned!.wPt).toBeCloseTo(72, 1);
    expect(planned!.xPt).toBeCloseTo(72, 1);
  });

  test('percent is a share of the page on each axis, not of the box', () => {
    const [planned] = planSignaturePlacements([placement({ x: 10, y: 20, w: 50, h: 10, units: 'percent' })], [A4]);
    expect(planned!.xPt).toBeCloseTo(A4.widthPt * 0.1, 1);
    expect(planned!.wPt).toBeCloseTo(A4.widthPt * 0.5, 1);
    // The vertical figures come from the page's *height*, which is the only reading that keeps a signature in the
    // same visual place on a portrait and a landscape page.
    expect(planned!.yPt).toBeCloseTo(A4.heightPt * 0.2, 1);
    expect(planned!.hPt).toBeCloseTo(A4.heightPt * 0.1, 1);
  });

  test('a box that runs off the page is flagged rather than refused, because the job still draws it', () => {
    const [planned] = planSignaturePlacements([placement({ x: 500, w: 200 })], [A4]);
    expect(planned!.offPage).toBe(true);
  });

  test('a page the document does not have is an error, never a clamp', () => {
    expect(() => planSignaturePlacements([placement({ page: 3 })], [A4])).toThrow(/no page 3/);
  });

  test('an empty plan and an over-long one are both refused, with their own codes', () => {
    expect(() => planSignaturePlacements([], [A4])).toThrow(/no place to put a signature/);
    const many = Array.from({ length: 21 }, () => placement());
    expect(() => planSignaturePlacements(many, [A4])).toThrow(/above the limit of 20/);
  });
});

describe('signatureLines', () => {
  const signedAt = new Date('2026-09-17T09:30:00Z');

  test('prints the date, and the location beside it, when the date stamp is on', () => {
    const lines = signatureLines({
      signature: 'Boni Patama',
      signerName: 'Boni Patama',
      location: 'Jakarta',
      showSignerName: false,
      showDateStamp: true,
      signedAt,
    });
    expect(lines.name).toBe('Boni Patama');
    expect(lines.meta).toBe('2026-09-17 · Jakarta');
  });

  test('shows the signer name only when it was asked for — it is not part of what the user typed', () => {
    const lines = signatureLines({
      signature: 'Boni Patama',
      signerName: 'Boni Patama',
      showSignerName: true,
      showDateStamp: false,
      signedAt,
    });
    expect(lines.meta).toBe('Boni Patama');
  });

  test('nothing printed means no meta line at all, which is what skips the second merge', () => {
    const lines = signatureLines({
      signature: 'Boni Patama',
      showSignerName: false,
      showDateStamp: false,
      signedAt,
    });
    expect(lines.meta).toBeNull();
  });
});

describe('resolveSignedAt', () => {
  test('reads an ISO string and falls back to the job clock', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(resolveSignedAt(undefined, now)).toBe(now);
    expect(resolveSignedAt('2026-09-17T09:30:00Z', now).toISOString()).toBe('2026-09-17T09:30:00.000Z');
  });

  test('an ISO date without a time is read as UTC, not as a local midnight', () => {
    expect(resolveSignedAt('2026-09-17', new Date()).toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });

  test('a date that only *looks* parseable is refused, because `new Date` would accept it', () => {
    // The reason this check exists at all: V8 parses all three of these to a moment nobody specified, and a
    // signature dated by a parser's guess is worse than one dated by the job clock.
    for (const input of ['17 September 2026', 'September 17, 2026', '2026']) {
      expect(() => resolveSignedAt(input, new Date())).toThrow(/not ISO 8601/);
    }
  });
});

describe('signatureTextOverlay', () => {
  const plan = planSignaturePlacements([placement({ page: 2 }), placement({ page: 1 })], [A4, A4]);

  test('one overlay page per signed page, in page order, each the size of its target page', () => {
    const pages = signatureTextOverlay(plan, { name: 'Boni Patama', meta: null }, 'Times-Roman');
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.widthPt)).toEqual([A4.widthPt, A4.widthPt]);
    expect(pages.every((page) => page.heightPt === A4.heightPt)).toBe(true);
  });

  test('the name is centred in the box, and the meta line sits below it inside the same box', () => {
    const pages = signatureTextOverlay(
      planSignaturePlacements([placement()], [A4]),
      { name: 'Boni Patama', meta: '2026-09-17' },
      'Times-Roman',
    );
    const [name, meta] = pages[0]!.placements;
    expect(name!.centerPt!.x).toBeCloseTo(72 + 100, 1);
    expect(meta!.centerPt!.x).toBeCloseTo(72 + 100, 1);
    expect(meta!.centerPt!.y).toBeLessThan(name!.centerPt!.y);
    // Both inside the box, which is what a signature block is: nothing spills onto the page below it.
    expect(meta!.centerPt!.y).toBeGreaterThan(100);
    expect(name!.centerPt!.y).toBeLessThan(160);
  });

  test('a taller box sets a larger name, within the readable bounds', () => {
    const small = signatureTextOverlay(
      planSignaturePlacements([placement({ h: 20 })], [A4]),
      { name: 'Boni', meta: null },
      'Times-Roman',
    );
    const large = signatureTextOverlay(
      planSignaturePlacements([placement({ h: 200 })], [A4]),
      { name: 'Boni', meta: null },
      'Times-Roman',
    );
    expect(small[0]!.placements[0]!.sizePt).toBe(9);
    expect(large[0]!.placements[0]!.sizePt).toBe(28);
  });

  test('a border colour adds one stroked rectangle per placement, drawn under the text', () => {
    const solo = planSignaturePlacements([placement()], [A4]);
    const pages = signatureTextOverlay(solo, { name: 'Boni', meta: null }, 'Times-Roman', '#12224a', '#cccccc');
    expect(pages[0]!.vectors).toHaveLength(1);
    expect(pages[0]!.vectors![0]).toMatchObject({ kind: 'rect', xPt: 72, yPt: 100, widthPt: 200, heightPt: 60 });
    expect(signatureBorders(solo, undefined)).toEqual([]);
  });
});

describe('signatureImageOverlay', () => {
  test('stamps the box it was given, centred, and asks the engine to keep the aspect ratio', () => {
    const plan = planSignaturePlacements([placement({ x: 100, y: 200, w: 160, h: 80 })], [A4]);
    const [page] = signatureImageOverlay(plan);
    expect(page!.widthPt).toBe(A4.widthPt);
    expect(page!.stamps[0]).toMatchObject({ x: 180, y: 240, widthPt: 160, heightPt: 80, fit: 'contain' });
  });
});

describe('signatureMetaOverlay', () => {
  test('nothing to print means no overlay at all — the handler then skips the second merge', () => {
    const plan = planSignaturePlacements([placement()], [A4]);
    expect(signatureMetaOverlay(plan, { name: 'Boni', meta: null }, 'Times-Roman')).toEqual([]);
  });

  test('the date goes under the box, and inside it at the top when there is no room below', () => {
    const above = planSignaturePlacements([placement({ y: 200 })], [A4]);
    const below = planSignaturePlacements([placement({ y: 2 })], [A4]);
    const lines = { name: 'Boni', meta: '2026-09-17' };

    const [underTheBox] = signatureMetaOverlay(above, lines, 'Times-Roman');
    // Below the box's bottom edge (200), and clear of the page's own edge.
    expect(underTheBox!.placements[0]!.centerPt!.y).toBeLessThan(200);
    expect(underTheBox!.placements[0]!.centerPt!.y).toBeGreaterThan(180);

    const [insideTheBox] = signatureMetaOverlay(below, lines, 'Times-Roman');
    // Box bottom 2 pt, so anything below it would be off the page; the line moves inside instead of disappearing.
    expect(insideTheBox!.placements[0]!.centerPt!.y).toBeGreaterThan(2);
    expect(insideTheBox!.placements[0]!.centerPt!.y).toBeLessThan(62);
  });
});

describe('overlay order', () => {
  test('a plan given out of page order still yields ascending overlay pages, which the merge map indexes into', () => {
    const plan = planSignaturePlacements(
      [placement({ page: 3 }), placement({ page: 1 }), placement({ page: 3 })],
      [A4, A4, A4],
    );
    const pages = signatureTextOverlay(plan, { name: 'Boni', meta: null }, 'Times-Roman');
    // Three placements on two pages: two overlay pages, and the page with two boxes carries two placements.
    expect(pages).toHaveLength(2);
    expect(pages[1]!.placements).toHaveLength(2);
  });
});

describe('PlannedSignature', () => {
  test('carries everything the two builders need and nothing they do not', () => {
    const planned: PlannedSignature = planSignaturePlacements([placement()], [A4])[0]!;
    expect(Object.keys(planned).sort()).toEqual(
      ['hPt', 'offPage', 'page', 'pageHeightPt', 'pageWidthPt', 'units', 'wPt', 'xPt', 'yPt'].sort(),
    );
    expect(planned.units).toBe('pt');
  });

  test('a landscape page measures percent against its own axes', () => {
    const [planned] = planSignaturePlacements(
      [placement({ x: 10, y: 10, w: 10, h: 10, units: 'percent' })],
      [LETTER_LANDSCAPE],
    );
    expect(planned!.xPt).toBeCloseTo(79.2, 1);
    expect(planned!.yPt).toBeCloseTo(61.2, 1);
  });
});

/**
 * The gate five handlers share, and the one predicate in this file that a golden case cannot pin down on its own.
 *
 * The signed fixture proves the warning is *reported*; only these cases prove it is reported **for the right
 * reason** — in particular that an empty `/FT /Sig` placeholder, which is a form waiting to be signed rather than a
 * document that has been, does not produce a sentence about invalidating a signature that does not exist.
 */
describe('signatureInvalidatedWarning', () => {
  const record = (overrides: Partial<SignatureRecord> = {}): SignatureRecord => ({
    pages: 1,
    subject: null,
    keywords: null,
    signatureObjects: 0,
    signatureValues: 0,
    unsignedSignatureFields: 0,
    byteRange: false,
    perms: false,
    producer: null,
    ...overrides,
  });

  test('an ordinary document gets no warning at all, which is what makes the case a statement about the input', () => {
    expect(signatureInvalidatedWarning(record())).toBeNull();
  });

  test('an empty signature placeholder is vocabulary, not a signature: nothing to invalidate yet', () => {
    expect(signatureInvalidatedWarning(record({ signatureObjects: 1, unsignedSignatureFields: 1 }))).toBeNull();
  });

  test('a signature value dictionary is reported, and the count in the sentence is the one that exists', () => {
    const warning = signatureInvalidatedWarning(record({ signatureObjects: 2, signatureValues: 2, byteRange: true }));
    expect(warning?.code).toBe('ELECTRONIC_SIGNATURE_INVALIDATED');
    expect(warning?.detail).toContain('2 signature(s)');
    expect(warning?.detail).toContain('byte range: true');
  });

  test('a byte range or a trailer /Perms is enough on its own, with no /Sig object the walk would name', () => {
    expect(signatureInvalidatedWarning(record({ byteRange: true }))?.code).toBe('ELECTRONIC_SIGNATURE_INVALIDATED');
    expect(signatureInvalidatedWarning(record({ perms: true }))?.code).toBe('ELECTRONIC_SIGNATURE_INVALIDATED');
  });
});
