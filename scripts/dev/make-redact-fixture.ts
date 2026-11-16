import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPdf, countPagesInPdf } from './pdf-writer';

/**
 * Build the two fixtures `redact`'s golden cases need.
 *
 * Both exist for the same reason: a redaction test proves an **absence**, and an absence assertion is only as good as
 * the presence it could have seen. That makes the geometry part of the evidence. `pdf-writer` draws every run at
 * coordinates this file chooses, and the verification step below measures each token's *real* bounding box with
 * PyMuPDF (`search_for`) and refuses to write the fixture unless the rectangle the golden cases aim at actually
 * contains it — the failure mode being a case that redacts a band of blank paper and reports success.
 *
 * `redact-secret-a4.pdf` carries four things at once, because one file with a known secret in every place a secret can
 * hide is what makes the removal provable:
 *
 *  - a token under the marked area (`ACCT-4471-9930`), which must be gone afterwards;
 *  - a line 50 pt below it that is **not** marked (`PUBLIC-KEEP-0001`), which must survive — the assertion that the
 *    rectangle is scoped rather than a page-wide erase;
 *  - the same token twice, once inside a marked area and once outside it (`SHARED-7731`), which is what proves the
 *    job's verification only asserts the absence of tokens that occurred *nowhere* else. Without that row, the honest
 *    job fails its own check and the case would have to be weakened instead;
 *  - the same secret in the `/Info` dictionary, the XMP packet and an embedded file, so `removeMetadata` and
 *    `removeAttachments` have something to be measured against.
 *
 * `redact-signed-a4.pdf` is the same document with a signature **field and value dictionary** — not an ink signature
 * (`sign` writes none of this). Redaction invalidates any signature whose bytes it changes, and the warning that says
 * so can only be tested against a file that really has one; the walk the handler detects it with is verified here with
 * the same pikepdf walk, so a fixture that quietly lost its `/Sig` fails at generation rather than turning
 * `ELECTRONIC_SIGNATURE_INVALIDATED` into a case that asserts nothing.
 *
 *   docker compose up -d worker-heavy
 *   bun run fixtures:redact
 */

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(ROOT, 'fixtures', 'generated');
const SECRET_TARGET = join(OUT_DIR, 'redact-secret-a4.pdf');
const SIGNED_TARGET = join(OUT_DIR, 'redact-signed-a4.pdf');
const CONTAINER = 'worker-heavy';
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;

const PAGE = { widthPt: 595, heightPt: 842 } as const;

/**
 * The fixture's geometry, exported so the golden cases aim at the same numbers this file drew. A placement number
 * repeated in a case is a second copy that can drift; these are read from here by `scripts/ci/golden.ts`.
 *
 * Every rectangle is in PDF user space with the page's lower-left origin — the contract's convention — and is drawn
 * generously in `x` and tightly in `y`: the black box should look like a redaction of the whole line, and it must not
 * reach the line above or below it, which is what the blank-region assertions check.
 */
export const REDACT_FIXTURE = {
  page: PAGE,
  /** The line that must be gone, and the rectangle the cases mark. */
  secret: { token: 'ACCT-4471-9930', rect: { x: 66, y: 594, w: 380, h: 24 } },
  /** 50 pt lower and unmarked: the proof that the rectangle is scoped. */
  keeper: { token: 'PUBLIC-KEEP-0001', rect: { x: 66, y: 544, w: 380, h: 24 } },
  /** The band between the two, which must stay blank — a redaction that covered the page would fill it. */
  gap: { rect: { x: 66, y: 572, w: 380, h: 16 } },
  /** The same token inside a marked area and outside every marked area. */
  shared: { token: 'SHARED-7731', rect: { x: 66, y: 474, w: 380, h: 24 } },
  /** A second page's own secret, so "the removal followed the page numbers" is a fact rather than a hope. */
  secondPage: { token: 'PIN-2299-4417', rect: { x: 66, y: 594, w: 380, h: 24 } },
  /** Metadata markers: absent means removed, present means the option was off, and both are asserted. */
  docInfo: 'DOCINFO-REDACT-MARKER',
  xmp: 'XMP-REDACT-MARKER',
  attachment: 'ATTACHMENT-REDACT-MARKER',
} as const;

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const compose = COMPOSE_FILE ? ['-f', COMPOSE_FILE] : [];
  const proc = Bun.spawn(['docker', 'compose', ...compose, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** The measurement, in the container where PyMuPDF and pikepdf live. */
const VERIFY_SCRIPT = `import json, os, sys
import pikepdf
import pymupdf

FIXTURE = ${JSON.stringify(REDACT_FIXTURE)}
SECRET = '/tmp/redact-fixture/redact-secret-a4.pdf'
SIGNED = '/tmp/redact-fixture/redact-signed-a4.pdf'

report = {}


def flat(value):
    return ' '.join(value.split())


doc = pymupdf.open(SECRET)
report['pages'] = doc.page_count
report['page_text'] = [flat(doc[number].get_text()) for number in range(doc.page_count)]
report['embfiles'] = doc.embfile_count()
report['xmp'] = doc.xref_xml_metadata()
report['docinfo_subject'] = doc.metadata.get('subject')

# Where the tokens really are. The contract's rect is lower-left; search_for returns PyMuPDF's upper-left boxes.
report['boxes'] = {}
# occurrences is how many times the token is on its page; inside is how many of those lie inside the marked band.
# The pair is what makes the fixture evidence: the shared token appears twice on purpose — once where a rectangle
# will cover it and once where none will — and that second copy is what a job's token filter has to tolerate.
EXPECTED = {
    'secret': {'occurrences': 1, 'inside': 1},
    'keeper': {'occurrences': 1, 'inside': 1},
    'shared': {'occurrences': 2, 'inside': 1},
    'secondPage': {'occurrences': 1, 'inside': 1},
}
for key in ('secret', 'keeper', 'shared', 'secondPage'):
    spec = FIXTURE[key]
    page_number = 2 if key == 'secondPage' else 1
    found = doc[page_number - 1].search_for(spec['token'])
    rect = spec['rect']
    target = pymupdf.Rect(
        rect['x'],
        FIXTURE['page']['heightPt'] - (rect['y'] + rect['h']),
        rect['x'] + rect['w'],
        FIXTURE['page']['heightPt'] - rect['y'],
    )
    report['boxes'][key] = {
        'found': len(found),
        'covered': [bool(target.contains(box)) for box in found],
        'inside': sum(1 for box in found if target.contains(box)),
        'expected': EXPECTED[key],
        'boxes': [[round(value, 2) for value in box] for box in found],
        'target': [round(value, 2) for value in target],
    }
doc.close()

data = open(SECRET, 'rb').read()
report['bytes'] = {
    token: token.encode() in data
    for token in (FIXTURE['secret']['token'], FIXTURE['docInfo'], FIXTURE['xmp'], FIXTURE['attachment'],
                  FIXTURE['keeper']['token'], FIXTURE['shared']['token'], FIXTURE['secondPage']['token'])
}

# The signed variant: the same document, plus a signature field and a signature value dictionary, written the way a
# real signed document carries them.
with pikepdf.Pdf.open(SECRET) as pdf:
    page = pdf.pages[0]
    value = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/Sig'),
        Filter=pikepdf.Name('/Adobe.PPKLite'),
        SubFilter=pikepdf.Name('/adbe.pkcs7.detached'),
        ByteRange=pikepdf.Array([0, 100, 200, 300]),
        Contents=pikepdf.String('0' * 128),
        M=pikepdf.String("D:20260917090000+07'00'"),
        Name=pikepdf.String('Fixture Signer'),
        Reason=pikepdf.String('Fixture'),
    ))
    field = pdf.make_indirect(pikepdf.Dictionary(
        FT=pikepdf.Name('/Sig'),
        Type=pikepdf.Name('/Annot'),
        Subtype=pikepdf.Name('/Widget'),
        Rect=pikepdf.Array([300, 700, 480, 745]),
        T=pikepdf.String('ApprovalSignature'),
        F=4,
        P=page.obj,
        DA=pikepdf.String('/Helv 0 Tf 0 g'),
        V=value,
    ))
    # A text field *beside* the signature, so fill-form's case writes a value next to a signature that is already
    # there rather than only skipping the signature field it was pointed at. No /AP, exactly like the form fixture:
    # the appearance warning is a real finding and this fixture should not hide it.
    adjacent = pdf.make_indirect(pikepdf.Dictionary(
        FT=pikepdf.Name('/Tx'),
        Type=pikepdf.Name('/Annot'),
        Subtype=pikepdf.Name('/Widget'),
        Rect=pikepdf.Array([300, 640, 480, 672]),
        T=pikepdf.String('ApprovedBy'),
        F=4,
        P=page.obj,
        DA=pikepdf.String('/Helv 10 Tf 0 g'),
    ))
    page.obj['/Annots'] = pikepdf.Array([field, adjacent])
    # The AcroForm's own font resources, and not a detail: the appearance a filled field generates names the font in
    # its /DA (/Helv), and poppler resolves that name through the widget's resources and then the form's /DR. This
    # document's page text is drawn by the fixture writer with its own font, so /Helv exists nowhere without this
    # dictionary — measured, poppler answered "Unknown font tag Helv" and extracted nothing, which would have turned
    # fill-form's case into a comparison against an empty page.
    helvetica = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/Font'),
        Subtype=pikepdf.Name('/Type1'),
        BaseFont=pikepdf.Name('/Helvetica'),
    ))
    pdf.Root.AcroForm = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array([field, adjacent]),
        SigFlags=3,
        DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=helvetica)),
    ))
    # pikepdf, not PyMuPDF: the signature dictionary has to survive the save exactly as written, and its writer drops
    # unreferenced objects by default.
    pdf.save(SIGNED, compress_streams=True)


def signature_walk(path):
    """The same walk readSignatureRecord uses, so the fixture is checked by the code that will read it."""
    with pikepdf.Pdf.open(path) as pdf:
        objects = 0
        values = 0
        unsigned_fields = 0
        byte_range = False
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary):
                is_value = False
                is_field = False
                for key, wanted in (('/Type', '/Sig'), ('/FT', '/Sig')):
                    found = obj.get(key)
                    if found is not None and str(found) == wanted:
                        if key == '/FT':
                            is_field = True
                        else:
                            is_value = True
                if is_value or is_field:
                    objects += 1
                    if is_value or (is_field and '/V' in obj and obj.get('/V') is not None):
                        values += 1
                    else:
                        unsigned_fields += 1
                if '/ByteRange' in obj:
                    byte_range = True
        fields = []
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary) and '/T' in obj and '/FT' in obj:
                fields.append([str(obj.get('/T')), str(obj.get('/FT'))])
        fields.sort()
        return {
            'signatureObjects': objects,
            'signatureValues': values,
            'unsignedSignatureFields': unsigned_fields,
            'byteRange': byte_range,
            'pages': len(pdf.pages),
            'fields': fields,
        }


report['signature_in_secret'] = signature_walk(SECRET)
report['signature_in_signed'] = signature_walk(SIGNED)
report['sizes'] = {'secret': os.path.getsize(SECRET), 'signed': os.path.getsize(SIGNED)}
print('REDACT-FIXTURE ' + json.dumps(report))`;

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const fixture = REDACT_FIXTURE;
  const bytes = buildPdf({
    pages: 3,
    label: 'Redaction fixture',
    pageSize: [PAGE.widthPt, PAGE.heightPt],
    docInfo: {
      title: 'Redaction fixture',
      author: 'PDF Tools fixture',
      subject: fixture.docInfo,
      // The secret in the metadata as well as on the page: a redaction that removes the text and leaves the number in
      // `/Keywords` has removed nothing that a reader would care about.
      keywords: fixture.secret.token,
      creator: 'Fixture Writer',
    },
    xmp: { creator: fixture.xmp },
    attachment: { name: 'redact-secret.txt', content: `${fixture.attachment}\n` },
    texts: [
      { page: 1, text: `Account ${fixture.secret.token} belongs to Nadia Rahman`, x: 72, y: 600 },
      { page: 1, text: `Reference ${fixture.keeper.token} must survive`, x: 72, y: 550 },
      { page: 1, text: `${fixture.shared.token} inside the marked area`, x: 72, y: 480 },
      { page: 1, text: `${fixture.shared.token} outside every marked area`, x: 72, y: 400 },
      { page: 2, text: `Personal ${fixture.secondPage.token} on the second page`, x: 72, y: 600 },
    ],
  });
  await writeFile(SECRET_TARGET, bytes);

  const writtenPages = countPagesInPdf(bytes);
  if (writtenPages !== 3) {
    console.error(`the writer produced ${writtenPages} pages, the cases expect 3`);
    process.exit(1);
  }

  const ps = await docker(['ps', '--status', 'running', '--services']);
  if (!ps.stdout.split('\n').includes(CONTAINER)) {
    console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
    process.exit(1);
  }

  // The directory has to exist inside the container before `docker cp` can name a file in it.
  const prepared = await docker(['exec', '-T', CONTAINER, 'mkdir', '-p', '/tmp/redact-fixture']);
  if (prepared.code !== 0) {
    console.error(`could not prepare the fixture directory in ${CONTAINER}: ${prepared.stderr.trim()}`);
    process.exit(1);
  }

  const copyIn = await docker(['cp', SECRET_TARGET, `${CONTAINER}:/tmp/redact-fixture/redact-secret-a4.pdf`]);
  if (copyIn.code !== 0) {
    console.error(`could not copy the fixture into ${CONTAINER}: ${copyIn.stderr.trim()}`);
    process.exit(1);
  }

  const proc = Bun.spawn(
    ['docker', 'compose', ...(COMPOSE_FILE ? ['-f', COMPOSE_FILE] : []), 'exec', '-T', CONTAINER, 'python3', '-'],
    {
      cwd: ROOT,
      stdin: new Blob([VERIFY_SCRIPT]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.error(`the verification script failed in ${CONTAINER}:\n${stderr.trim()}`);
    process.exit(1);
  }

  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('REDACT-FIXTURE '))
    .pop();
  if (!line) {
    console.error(`the verification script printed no report:\n${stdout.trim()}\n${stderr.trim()}`);
    process.exit(1);
  }

  const report = JSON.parse(line.slice('REDACT-FIXTURE '.length)) as {
    pages: number;
    page_text: string[];
    embfiles: number;
    xmp: number;
    docinfo_subject: string | null;
    boxes: Record<
      string,
      {
        found: number;
        covered: boolean[];
        inside: number;
        expected: { occurrences: number; inside: number };
        boxes: number[][];
        target: number[];
      }
    >;
    bytes: Record<string, boolean>;
    signature_in_secret: { signatureObjects: number; byteRange: boolean };
    signature_in_signed: {
      signatureObjects: number;
      signatureValues: number;
      unsignedSignatureFields: number;
      byteRange: boolean;
      pages: number;
      fields: string[][];
    };
    sizes: { secret: number; signed: number };
  };

  // Assertions, not printouts: a fixture that does not put its tokens where the cases aim turns those cases into
  // tests of a blank rectangle, and this is the only place where that is still cheap to notice.
  const problems: string[] = [];
  if (report.pages !== 3) problems.push(`the read-back found ${report.pages} pages, expected 3`);
  for (const [key, measured] of Object.entries(report.boxes)) {
    if (measured.found !== measured.expected.occurrences) {
      problems.push(
        `${key}: the token appears ${measured.found} time(s) on its page, expected ${measured.expected.occurrences}`,
      );
    }
    if (measured.inside !== measured.expected.inside) {
      problems.push(
        `${key}: ${measured.inside} of the ${measured.found} box(es) ${JSON.stringify(measured.boxes)} lie inside the declared rect ${JSON.stringify(measured.target)}, expected ${measured.expected.inside}`,
      );
    }
  }
  if (report.page_text[0]?.includes(fixture.secondPage.token)) {
    problems.push('the second page token leaked onto page 1, so the page assertion would prove nothing');
  }
  if (!report.bytes[fixture.secret.token]) problems.push('the secret is not in the file bytes');
  if (!report.bytes[fixture.docInfo]) problems.push('the DocInfo marker is not in the file bytes');
  if (!report.bytes[fixture.xmp]) problems.push('the XMP marker is not in the file bytes');
  if (!report.bytes[fixture.attachment]) problems.push('the attachment marker is not in the file bytes');
  if (report.embfiles !== 1) problems.push(`expected 1 embedded file, found ${report.embfiles}`);
  if (report.xmp <= 0) problems.push('the document has no XMP metadata object');
  if (report.docinfo_subject !== fixture.docInfo) {
    problems.push(`the DocInfo subject reads back as ${JSON.stringify(report.docinfo_subject)}`);
  }
  // The control: the unsigned fixture must have no signature at all, or the warning case would pass against any file.
  if (report.signature_in_secret.signatureObjects !== 0 || report.signature_in_secret.byteRange) {
    problems.push(
      'the unsigned fixture already carries a signature, so ELECTRONIC_SIGNATURE_INVALIDATED proves nothing',
    );
  }
  if (report.signature_in_signed.signatureObjects < 1 || !report.signature_in_signed.byteRange) {
    problems.push('the signed fixture does not read back as signed, so the warning case would assert nothing');
  }
  // The vocabulary and the signature are different facts, and the five handlers gate the warning on the second one.
  // A fixture whose only `/Sig` were the field would make the warning fire on something that is not signed.
  if (report.signature_in_signed.signatureValues < 1) {
    problems.push('the signed fixture has no signature *value*, so an empty placeholder would be all the walk finds');
  }
  if (report.signature_in_signed.unsignedSignatureFields !== 0) {
    problems.push('the signed fixture carries an unsigned /FT /Sig placeholder as well as a signature');
  }
  // `fill-form`'s case needs a field it can actually write into beside the signature, or the job would only skip the
  // signature field and the case would prove nothing about the warning it shares.
  const signedFields = report.signature_in_signed.fields.map((field) => field.join(':'));
  if (!signedFields.includes('ApprovedBy:/Tx') || !signedFields.includes('ApprovalSignature:/Sig')) {
    problems.push(`the signed fixture's fields read back as ${JSON.stringify(signedFields)}`);
  }
  if (report.signature_in_signed.pages !== report.pages) {
    problems.push('signing the fixture changed its page count');
  }

  if (problems.length > 0) {
    console.error(
      `the fixtures were built but are not what the cases need:\n${problems.map((p) => `  · ${p}`).join('\n')}`,
    );
    process.exit(1);
  }

  const copyOut = await docker(['cp', `${CONTAINER}:/tmp/redact-fixture/redact-signed-a4.pdf`, SIGNED_TARGET]);
  if (copyOut.code !== 0) {
    console.error(`could not copy the signed fixture back out: ${copyOut.stderr.trim()}`);
    process.exit(1);
  }

  const secretSize = (await stat(SECRET_TARGET)).size;
  const signedSize = (await stat(SIGNED_TARGET)).size;
  if (secretSize !== report.sizes.secret || signedSize !== report.sizes.signed) {
    console.error(
      `the copied files are ${secretSize}/${signedSize} bytes, the container wrote ${report.sizes.secret}/${report.sizes.signed}`,
    );
    process.exit(1);
  }

  console.log(`redact-secret-a4.pdf  ${secretSize} bytes  3 pages  secret in text, metadata and attachment`);
  console.log(
    `redact-signed-a4.pdf  ${signedSize} bytes  signature field + value dictionary ` +
      `(${report.signature_in_signed.signatureValues} signature(s) of ${report.signature_in_signed.signatureObjects} /Sig object(s), ` +
      `byte range: ${report.signature_in_signed.byteRange}, fields: ${signedFields.join(', ')})`,
  );
  console.log(`  verified with PyMuPDF and pikepdf in ${CONTAINER} — every token is inside its marked rectangle`);
}

await main();
