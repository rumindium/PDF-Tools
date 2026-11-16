import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  buildPdfaOutputIntent,
  findPdfaProfile,
  hasPdfaOutputIntent,
  parseFontCensus,
  parseImageCensus,
} from '../src/pdfa';

/**
 * The preamble is a few dozen lines of PostScript that decide whether a file is archival, and it cannot be type
 * checked. What can be checked is the part a caller influences: the two values interpolated into it. A profile path
 * with a backslash or a paren in it used to end the PostScript string early, and the symptom was a Ghostscript syntax
 * error naming neither the path nor the cause.
 */

describe('buildPdfaOutputIntent', () => {
  test('writes the intent the standard requires: a /GTS_PDFA1 intent with a stream profile', () => {
    const program = buildPdfaOutputIntent({
      profilePath: '/usr/share/ghostscript/10.05.1/iccprofiles/srgb.icc',
      components: 3,
      conditionIdentifier: 'sRGB',
    });

    expect(program).toContain('/S /GTS_PDFA1');
    expect(program).toContain('/Type /OutputIntent');
    expect(program).toContain('/DestOutputProfile {icc_PDFA}');
    expect(program).toContain('/OutputIntents [ {OutputIntent_PDFA} ]');
    expect(program).toContain('/N 3');
  });

  test("`/N` is the profile's component count, not a constant", () => {
    const cmyk = buildPdfaOutputIntent({
      profilePath: '/usr/share/ghostscript/10.05.1/iccprofiles/default_cmyk.icc',
      components: 4,
      conditionIdentifier: 'CMYK',
    });
    expect(cmyk).toContain('/N 4');
    expect(cmyk).not.toContain('/N 3');
  });

  test('a hostile profile path stays inside its PostScript string', () => {
    const program = buildPdfaOutputIntent({
      profilePath: '/tmp/awful (path)\\profile.icc',
      components: 3,
      conditionIdentifier: 'sRGB',
    });
    expect(program).toContain('/ICCProfile (/tmp/awful \\(path\\)\\\\profile.icc) def');
    // The unescaped form would close the string early and leave `path)` as PostScript, which is how this became a
    // syntax error instead of a clear message.
    expect(program).not.toContain('/ICCProfile (/tmp/awful (path)');
  });

  test('the preamble precedes the document it stamps, and reads the profile only through a permitted handle', () => {
    const program = buildPdfaOutputIntent({
      profilePath: '/tmp/profile.icc',
      components: 3,
      conditionIdentifier: 'sRGB',
    });
    // `(r) file` is the read; the caller must pass `--permit-file-read=<path>` for it to be allowed. Asserted here
    // because the handler's argument list is the other half of this contract and a reader of one should see the other.
    expect(program).toContain('{ICCProfile (r) file} stopped');
    expect(program).toContain('cleartomark');
  });
});

/**
 * The reader that decides whether the job may claim it produced an archival file.
 *
 * Every case here is a *byte* fixture rather than a produced PDF, because the two shapes being told apart are an
 * object in the file and an object inside a compressed object stream — and which of the two you get is a function of
 * the PDF/A level, not of anything the caller chose. The unit test is where that distinction can be pinned down
 * without a Docker build.
 */
describe('hasPdfaOutputIntent', () => {
  /** A PDF whose intent dictionary is where PDF/A-1 puts it: plain, uncompressed object bytes. */
  const plainBytes = Buffer.from(
    '%PDF-1.7\n5 0 obj\n<<\n/Type /OutputIntent\n/S /GTS_PDFA1\n/DestOutputProfile 7 0 R\n>>\nendobj\n' +
      '9 0 obj\n<< /Type /Catalog /OutputIntents [ 5 0 R ] >>\nendobj\n',
    'latin1',
  );

  /** The same intent, but where PDF/A-2 and -3 put it: inside a Flate-compressed `/Type /ObjStm` stream. */
  const objectStreamBytes = Buffer.concat([
    Buffer.from('%PDF-1.7\n4 0 obj\n<< /Type /ObjStm /N 2 >>\nstream\n', 'latin1'),
    deflateSync(
      Buffer.from(
        '5 0 obj\n<< /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile 7 0 R >>\nendobj\n' +
          '6 0 obj\n<< /Type /Catalog /OutputIntents [ 5 0 R ] >>\nendobj\n',
        'latin1',
      ),
    ),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);

  test('a plain intent dictionary is found', () => {
    expect(hasPdfaOutputIntent(plainBytes)).toBe(true);
  });

  test('an intent inside an object stream is found, and a raw-byte search would miss it', () => {
    // The negative assertion is the point of the case: it is what makes "search the inflated half too" a requirement
    // rather than a preference, and it is exactly how the golden suite read a correct PDF/A-2 output as a defect.
    expect(objectStreamBytes.toString('latin1')).not.toContain('GTS_PDFA1');
    expect(hasPdfaOutputIntent(objectStreamBytes)).toBe(true);
  });

  test('the XMP claim alone is not an intent', () => {
    // The failure this function exists to catch: Ghostscript writes `pdfaid:part` and the preamble's pdfmark never
    // lands, so the file says PDF/A and is not.
    const claimOnly = Buffer.from('%PDF-1.7\n<rdf:Description pdfaid:part="2" pdfaid:conformance="B"/>\n', 'latin1');
    expect(hasPdfaOutputIntent(claimOnly)).toBe(false);
  });

  test('an intent that is not registered in the catalog does not count', () => {
    // `/OutputIntents` is the third fact, and it is the one a hand-built preamble forgets: the dictionary can be a
    // perfect `/GTS_PDFA1` intent and still not be the document's.
    const orphaned = Buffer.from(
      '%PDF-1.7\n5 0 obj\n<< /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile 7 0 R >>\nendobj\n',
      'latin1',
    );
    expect(hasPdfaOutputIntent(orphaned)).toBe(false);
  });

  test('a document stream that happens to contain the words does not count', () => {
    // The intent needs all three parts together; a page whose text mentions them (a scanned invoice for this tool,
    // say) tickles a substring search but has no intent.
    const pageText = 'BT (GTS_PDFA1 and DestOutputProfile are words) Tj ET\n';
    const decoy = Buffer.concat([
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length 60 >>\nstream\n', 'latin1'),
      deflateSync(Buffer.from(pageText, 'latin1')),
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
    // The two words really are in there once the stream is inflated — so the `false` below is the `/OutputIntents`
    // requirement doing the work, not the words being absent.
    expect(pageText).toContain('GTS_PDFA1');
    expect(pageText).toContain('DestOutputProfile');
    expect(hasPdfaOutputIntent(decoy)).toBe(false);
  });
});

/**
 * The two censuses, against output captured from the engines they read.
 *
 * These exist because the columns are positional and the reading was wrong once in a way nothing else could see: the
 * `object ID` field is *two* tokens, so counting back three from the end lands on `uni` rather than `emb` — and `uni`
 * is `no` for most fonts, which made an embedded file read as one with a missing font program. The verbatim rows below
 * are what `pdffonts` and `pdfimages -list` print for this repository's own fixtures.
 */
describe('parseFontCensus', () => {
  test('reads emb and sub past the two-token object ID, header and rule included', () => {
    const census = parseFontCensus(
      [
        'name                                 type              encoding         emb sub uni object ID',
        '------------------------------------ ----------------- ---------------- --- --- --- ---------',
        'Helvetica                            Type 1            WinAnsi          no  no  no      15  0',
        'QOEDAU+Helvetica                     Type 1C           WinAnsi          yes yes no       7  0',
        '',
      ].join('\n'),
    );
    // Two rows: one without a program (what the embed pass exists for) and one embedded *and* substituted (what
    // FONT_SUBSTITUTED reports). The header and the rule contribute nothing, which is the point of the assertion.
    expect(census).toEqual({ total: 2, notEmbedded: 1, substituted: 1 });
  });

  test('survives a font family with a space in its name', () => {
    // The case the end-relative reading is for: a three-word family pushes every column to the right, and a fixed
    // offset from the start of the line would read "Sans" as the type and the encoding as `emb`.
    const census = parseFontCensus(
      ['Nimbus Sans Narrow Bold Italic        Type 1            WinAnsi          yes  no  no      12  0'].join('\n'),
    );
    expect(census).toEqual({ total: 1, notEmbedded: 0, substituted: 0 });
  });

  test('counts nothing for a document with no fonts at all', () => {
    expect(
      parseFontCensus(
        [
          'name                                 type              encoding         emb sub uni object ID',
          '------------------------------------ ----------------- ---------------- --- --- --- ---------',
        ].join('\n'),
      ),
    ).toEqual({ total: 0, notEmbedded: 0, substituted: 0 });
  });
});

describe('parseImageCensus', () => {
  test('counts only the images above the threshold, and keeps the highest resolution', () => {
    const census = parseImageCensus(
      [
        'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
        '--------------------------------------------------------------------------------------------',
        '   1     0 image    1200  1200  rgb     3   8  image  no         6  0   720   720 4226B 0.1%',
        '   1     1 image     200   200  rgb     3   8  image  no         7  0   100   100  144B 0.1%',
        '',
      ].join('\n'),
      300,
    );
    // The pair is the whole point: two images counted, one above 300 dpi. A census that returned `total` would say
    // "everything was reduced", and one that returned 0 would say "nothing was" — both are numbers this fixture can
    // distinguish, which is why it carries a 720 dpi image beside a 100 dpi one.
    expect(census).toEqual({ total: 2, aboveDpi: 1, maxDpi: 720 });
  });

  test('takes the higher of the two axes, because a reader reports both', () => {
    const census = parseImageCensus(
      [
        'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
        '--------------------------------------------------------------------------------------------',
        '   1     0 image     900   300  rgb     3   8  image  no         6  0   250   800  999B 0.1%',
        '',
      ].join('\n'),
      300,
    );
    expect(census).toEqual({ total: 1, aboveDpi: 1, maxDpi: 800 });
  });

  test('reports nothing for a document with no images', () => {
    expect(
      parseImageCensus(
        [
          'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
          '--------------------------------------------------------------------------------------------',
        ].join('\n'),
      ),
    ).toEqual({ total: 0, aboveDpi: 0, maxDpi: 0 });
  });
});

describe('findPdfaProfile', () => {
  test('finds an sRGB and a CMYK profile in this environment, and they differ', async () => {
    const rgb = await findPdfaProfile(true);
    const cmyk = await findPdfaProfile(false);
    // A development machine may have no Ghostscript at all; the contract then is `null` (the handler fails the job),
    // never a silent "no intent". Both branches are asserted so the test is meaningful in either environment.
    if (rgb && cmyk) {
      expect(rgb.components).toBe(3);
      expect(cmyk.components).toBe(4);
      expect(rgb.profilePath).not.toBe(cmyk.profilePath);
    } else {
      expect(rgb).toBeNull();
      expect(cmyk).toBeNull();
    }
  });
});
