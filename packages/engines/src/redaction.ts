import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { RedactOptions } from '@pdftools/contracts/tools';
import { JobFailure } from '@pdftools/errors';
import { type RunOptions, runPdfToText } from './index';
import { parseJsonLine, runPythonScript } from './python';

/**
 * Redaction — `docs/13-EDIT-AND-ANNOTATE.md`, heavy pool.
 *
 * The only tool in this build whose product is an **absence**, which makes the verification the tool rather than a
 * check bolted onto it. Three things that decision forces, all of them measured before this file was written
 * (`scripts/dev/probe-redact.py`):
 *
 *  1. **PyMuPDF is the only engine here that removes text rather than covering it.** `apply_redactions` walks the
 *     content stream, drops the glyphs and images under the marks and rewrites it, and `garbage=4` on save is what
 *     makes the removal physical rather than an orphaned object (`docs/13-EDIT-AND-ANNOTATE.md` §4).
 *  2. **Order is scrub → mark → apply.** Adding the `/Redact` annotation first and then scrubbing overlapping
 *     annotations deletes the redaction itself: `apply_redactions` has nothing to apply, the page is saved unchanged,
 *     and every structural check passes. Measured, with the ordering reversed, before this module existed.
 *  3. **`apply_redactions` does not touch annotations** (measured: a `/Text` note over a redacted area survives), so
 *     `scrubAnnotations` is the only thing standing between "blacked out" and a sticky note that still shows the
 *     removed value. It is therefore implemented here rather than assumed.
 *
 * Two engines read the result back, and neither of them wrote it: poppler's `pdftotext` limited to each rectangle
 * (the region's text must be gone) and a raw-plus-inflated byte search for the tokens that occurred *only* inside the
 * marked areas (an un-garbage-collected object is the failure a text-layer check cannot see). That byte search reads
 * the file's `<hex>` strings too, and it has to: the rewrite this tool depends on writes a run as hex whenever the
 * text does not fit the font's encoding, so a reader that knows only `(…)` literals would be blind to exactly the
 * files it is asked about — a leak the byte half of the verification could not see.
 */

/** §6's caps: 200 rectangles for the job, 20 on one page. The contract enforces the same numbers at the door. */
export const REDACT_RECT_MAX = 200;
export const REDACT_RECTS_PER_PAGE_MAX = 20;

/** A rectangle in PDF user space with the page's lower-left origin — the contract's convention, not PyMuPDF's. */
export interface RedactRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlannedRedaction {
  /** 1-based page. */
  page: number;
  /** Position of this rectangle in the flattened job — how the verification and the metrics refer to it. */
  index: number;
  /** The rectangle as asked for, in PDF points. */
  rect: RedactRect;
  /** The same rectangle clipped to the page box; identical to `rect` unless part of it fell off the page. */
  clipped: RedactRect;
  fill: { r: number; g: number; b: number };
  /** Part of the rectangle lay outside the page and was clipped. Warned about, not refused. */
  offPage: boolean;
}

export interface RedactionPlan {
  rectangles: PlannedRedaction[];
  pages: number[];
  offPage: number;
}

/** `#rrggbb` as three 0–1 channels, which is the shape PyMuPDF's `fill` wants. */
function hexToUnitRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  };
}

/**
 * Turn the caller's regions into the rectangles an engine can be handed, refusing the ones that cannot mean anything.
 *
 * The refusals are the tool's first safety property: a rectangle on page 99, or one that does not intersect its page
 * at all, is a coordinate mistake, and the alternative to refusing it is a job that reports success and erased
 * nothing. A rectangle that *partly* leaves the page is a different case — the user's mark is real, it is simply
 * larger than the paper — so it is clipped and reported (`ELEMENT_OFF_PAGE`), which is the behaviour `sign` uses for
 * a placement that runs off the edge.
 */
export function planRedactionRegions(
  regions: RedactOptions['regions'],
  boxes: ReadonlyArray<{ widthPt: number; heightPt: number }>,
  defaultFill: string,
): RedactionPlan {
  const rectangles: PlannedRedaction[] = [];
  const pages = new Set<number>();
  let offPage = 0;
  let index = 0;

  for (const region of regions) {
    const box = boxes[region.page - 1];
    if (!box) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `The job marks page ${region.page}, and the document has ${boxes.length} page(s).`,
      });
    }
    if (region.rects.length > REDACT_RECTS_PER_PAGE_MAX) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `Page ${region.page} has ${region.rects.length} redaction rectangles; the limit is ${REDACT_RECTS_PER_PAGE_MAX} per page.`,
      });
    }
    const fill = hexToUnitRgb(region.fill ?? defaultFill);

    for (const rect of region.rects) {
      index += 1;
      if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !(rect.w > 0) || !(rect.h > 0)) {
        throw new JobFailure('VALIDATION_ERROR', {
          message: `Rectangle ${index} on page ${region.page} has no area (x ${rect.x}, y ${rect.y}, w ${rect.w}, h ${rect.h}).`,
        });
      }

      const left = Math.max(0, rect.x);
      const bottom = Math.max(0, rect.y);
      const right = Math.min(box.widthPt, rect.x + rect.w);
      const top = Math.min(box.heightPt, rect.y + rect.h);
      if (right <= left || top <= bottom) {
        throw new JobFailure('VALIDATION_ERROR', {
          message: `Rectangle ${index} on page ${region.page} lies outside the page (${box.widthPt}×${box.heightPt} pt), so nothing could be removed under it.`,
        });
      }

      const clipped = { x: left, y: bottom, w: right - left, h: top - bottom };
      const wasClipped = clipped.x !== rect.x || clipped.y !== rect.y || clipped.w !== rect.w || clipped.h !== rect.h;
      if (wasClipped) offPage += 1;

      rectangles.push({ page: region.page, index, rect: { ...rect }, clipped, fill, offPage: wasClipped });
      pages.add(region.page);
    }
  }

  if (rectangles.length > REDACT_RECT_MAX) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `A redaction job takes at most ${REDACT_RECT_MAX} rectangles; this one has ${rectangles.length}.`,
    });
  }

  return { rectangles, pages: [...pages].sort((a, b) => a - b), offPage };
}

export interface RedactionText {
  /** Every page's text, before anything was removed. */
  document: string;
  /** Page by page, which is how a job names the pages that held no text to remove at all. */
  pages: string[];
  /** Text under each rectangle, keyed by `PlannedRedaction.index`. */
  regions: Array<{ index: number; page: number; text: string }>;
  /**
   * What the document's three metadata stores say, read before the rewrite.
   *
   * The byte-level check searches the whole file, and a job that was told to *keep* the metadata — or the
   * attachments — would otherwise fail on its own success: the secret is still in `/Info`, which is precisely what
   * `removeMetadata: false` asked for. Naming the stores separately is what lets the handler excuse a token from the
   * byte search only when the option that parked it there was switched off, while the page-text check stays absolute.
   */
  metadata: { docInfo: string; xmp: string; attachments: string };
}

/**
 * Read the text that is about to be removed, with PyMuPDF's clipped extraction.
 *
 * Two uses, and both are load-bearing. It is what the job reports as `textRemoved`, and it is how the byte-level
 * check decides *which* tokens must be gone: a token that also occurs outside the marked rectangles cannot be
 * asserted against, because its survival is correct. `removableTokens` is where that filter lives.
 */
export async function collectRedactedText(
  inputPath: string,
  rectangles: ReadonlyArray<Pick<PlannedRedaction, 'index' | 'page' | 'clipped'>>,
  pageHeight: (page: number) => number,
  opts: Omit<RunOptions, 'engine'>,
): Promise<RedactionText> {
  const payload = {
    input: inputPath,
    // The engine's coordinate system is the page's upper-left, so the flip happens exactly here — once, for both the
    // extraction and the redaction, so the two cannot disagree about which band a rectangle names.
    rects: rectangles.map((rectangle) => ({
      index: rectangle.index,
      page: rectangle.page,
      x: rectangle.clipped.x,
      top: pageHeight(rectangle.page) - (rectangle.clipped.y + rectangle.clipped.h),
      w: rectangle.clipped.w,
      h: rectangle.clipped.h,
    })),
  };
  const result = await runPythonScript(READ_TEXT_SCRIPT, payload, opts);
  const parsed = parseJsonLine<RedactionText & { error?: { message: string } }>(result.stdout);
  if (!parsed || parsed.error) {
    throw new JobFailure('ENCRYPTED_INPUT', {
      engine: 'python',
      message:
        parsed?.error?.message ?? 'The text under the marked areas could not be read; the document may be encrypted.',
    });
  }
  return {
    document: parsed.document,
    pages: parsed.pages,
    regions: parsed.regions,
    metadata: parsed.metadata ?? { docInfo: '', xmp: '', attachments: '' },
  };
}

const READ_TEXT_SCRIPT = `import json, sys
import pymupdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
try:
    doc = pymupdf.open(payload['input'])
except Exception as error:
    print(json.dumps({'error': {'message': '%s: %s' % (type(error).__name__, error)}}))
    raise SystemExit(0)

if doc.needs_pass:
    print(json.dumps({'error': {'message': 'The document is password protected; unlock it first.'}}))
    raise SystemExit(0)


def flat(value):
    return ' '.join(value.split())


try:
    pages = [flat(doc[number].get_text()) for number in range(doc.page_count)]
    document = '\\n'.join(pages)
    regions = []
    for rect in payload['rects']:
        clip = pymupdf.Rect(rect['x'], rect['top'], rect['x'] + rect['w'], rect['top'] + rect['h'])
        regions.append({
            'index': rect['index'],
            'page': rect['page'],
            'text': flat(doc[rect['page'] - 1].get_text('text', clip=clip)),
        })

    # The three metadata stores, as text, so the handler can tell a leak from content it was asked to keep.
    docinfo = flat(' '.join(str(value) for value in doc.metadata.values() if value))
    xmp = ''
    try:
        reference = doc.xref_xml_metadata()
        if reference:
            xmp = flat(doc.xref_stream(reference).decode('latin-1', 'ignore'))
    except Exception:
        xmp = ''
    attachments = ''
    for index in range(doc.embfile_count()):
        try:
            attachments += ' ' + doc.embfile_get(index).decode('latin-1', 'ignore')
        except Exception:
            attachments += ' ' + str(doc.embfile_info(index))
    metadata = {'docInfo': docinfo, 'xmp': xmp, 'attachments': flat(attachments)}
except Exception as error:
    print(json.dumps({'error': {'message': '%s: %s' % (type(error).__name__, error)}}))
    raise SystemExit(0)

print(json.dumps({'document': document, 'pages': pages, 'regions': regions, 'metadata': metadata}))`;

/**
 * The tokens a redaction job is allowed to assert the absence of.
 *
 * A word that appears anywhere else in the document cannot be used as evidence — "of" under a marked rectangle and
 * "of" in the next paragraph are the same string, and a check that treated the second as a leak would fail every
 * honest job. So a token qualifies only when **every** occurrence of it in the document was inside a marked
 * rectangle; that is a property of the input, computed before anything is removed, and it is what makes the
 * byte-level assertion meaningful instead of vacuous in one direction and wrong in the other.
 */
export function removableTokens(document: string, regionTexts: readonly string[]): string[] {
  const regions = regionTexts.join('\n');
  const tokens = new Set<string>();
  for (const match of regions.matchAll(/[A-Za-z0-9][A-Za-z0-9._@/-]{3,}/g)) tokens.add(match[0]);

  const count = (haystack: string, needle: string): number => {
    let total = 0;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) return total;
      total += 1;
      from = at + needle.length;
    }
  };

  return [...tokens]
    .filter((token) => count(document, token) === count(regions, token))
    .sort((a, b) => a.localeCompare(b));
}

export interface RedactionMetrics {
  pages: number;
  pagesTouched: number;
  regions: number;
  /** Rectangles that still read text after the rewrite. Non-zero means the job has to fail. */
  rectsStillReadable: number;
  imagesRemoved: number;
  graphicsRemoved: number;
  annotationsRemoved: number;
  attachmentsRemoved: number;
  /** Text read back inside each rectangle by the engine that wrote the file, for diagnostics. */
  regionTextRemaining: Array<{ index: number; text: string }>;
  /** `/Info` entries that survived a job which asked for `removeMetadata`. */
  metadataSurvived: string[];
  /** Attachments still in the file after a job which asked for `removeAttachments`. */
  attachmentsRemaining: number;
  bytes: number;
  seconds: number;
}

export interface RedactionApplyOptions {
  removeContent: boolean;
  removeMetadata: boolean;
  removeAttachments: boolean;
  scrubAnnotations: boolean;
}

/**
 * Apply the redactions, and read the written file back with the same engine on the other side of the save.
 *
 * The read-back is not the verification — poppler is (`readRegionText`). It is what turns "the engine exited 0" into
 * a measurement: which images and vector drawings left the page, which annotations were deleted, how many bytes the
 * rewrite produced, and whether the text under each rectangle is still there *by the writer's own account*, which is
 * the half of the check that can still fail when `pdftotext` cannot read the output at all.
 */
export async function applyRedactions(
  inputPath: string,
  outputPath: string,
  rectangles: ReadonlyArray<PlannedRedaction>,
  pageHeight: (page: number) => number,
  options: RedactionApplyOptions,
  opts: Omit<RunOptions, 'engine'>,
): Promise<RedactionMetrics> {
  const payload = {
    input: inputPath,
    output: outputPath,
    removeContent: options.removeContent,
    removeMetadata: options.removeMetadata,
    removeAttachments: options.removeAttachments,
    scrubAnnotations: options.scrubAnnotations,
    rects: rectangles.map((rectangle) => ({
      index: rectangle.index,
      page: rectangle.page,
      x: rectangle.clipped.x,
      top: pageHeight(rectangle.page) - (rectangle.clipped.y + rectangle.clipped.h),
      w: rectangle.clipped.w,
      h: rectangle.clipped.h,
      fill: [rectangle.fill.r, rectangle.fill.g, rectangle.fill.b],
    })),
  };

  const result = await runPythonScript(APPLY_SCRIPT, payload, opts);
  const parsed = parseJsonLine<RedactionMetrics & { error?: { code?: string; message: string } }>(result.stdout);
  if (!parsed || parsed.error) {
    throw new JobFailure(parsed?.error?.code === 'ENCRYPTED_INPUT' ? 'ENCRYPTED_INPUT' : 'CONVERSION_FAILED', {
      engine: 'pymupdf',
      message: parsed?.error?.message ?? 'The redaction engine produced no result.',
      stderrTail: result.stdout.slice(-2000),
    });
  }
  return parsed;
}

/**
 * The whole structural job in one PyMuPDF process, because it is one rewrite of one document: scrub, mark, apply,
 * strip, save, read back. `apply_redactions` is called with all four switches explicitly, which is what makes
 * `removeContent: false` the *same* code path with the removal turned off rather than a second implementation that
 * paints a rectangle and hopes it matches.
 */
const APPLY_SCRIPT = `import json, os, sys
import pymupdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])


def flat(value):
    return ' '.join(value.split())


def annots(page):
    return list(page.annots() or [])


try:
    doc = pymupdf.open(payload['input'])
except Exception as error:
    print(json.dumps({'error': {'code': 'ENCRYPTED_INPUT', 'message': '%s: %s' % (type(error).__name__, error)}}))
    raise SystemExit(0)

if doc.needs_pass:
    print(json.dumps({'error': {'code': 'ENCRYPTED_INPUT', 'message': 'The document is password protected; unlock it first.'}}))
    raise SystemExit(0)

by_page = {}
for rect in payload['rects']:
    by_page.setdefault(rect['page'], []).append(rect)

before = {}
for number, rects in by_page.items():
    page = doc[number - 1]
    before[number] = {
        'annots': len(annots(page)),
        'images': len(page.get_images(full=True)),
        'drawings': len(page.get_drawings()),
    }

# 1) Scrub first. A /Redact annotation is never a candidate: the marks this job is about to write are, by
#    definition, inside the rectangles it would be testing against, and deleting them silently turns the whole job
#    into a no-op that every structural check still passes.
scrubbed = 0
if payload['scrubAnnotations']:
    for number, rects in by_page.items():
        page = doc[number - 1]
        areas = [pymupdf.Rect(r['x'], r['top'], r['x'] + r['w'], r['top'] + r['h']) for r in rects]
        for annot in annots(page):
            if 'Redact' in str(annot.type):
                continue
            if any(annot.rect.intersects(area) for area in areas):
                page.delete_annot(annot)
                scrubbed += 1

# 2) Mark, then 3) apply. removeContent picks the three strategies rather than the control flow: the overlay-only
#    branch applies the same redaction annotations with every removal switched off, which is why the box is painted
#    in both branches and only the content differs (measured: ink share 1.0 either way).
removed = payload['removeContent']
for number, rects in by_page.items():
    page = doc[number - 1]
    for rect in rects:
        area = pymupdf.Rect(rect['x'], rect['top'], rect['x'] + rect['w'], rect['top'] + rect['h'])
        page.add_redact_annot(area, fill=tuple(rect['fill']))
    page.apply_redactions(
        images=pymupdf.PDF_REDACT_IMAGE_REMOVE if removed else pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED if removed else pymupdf.PDF_REDACT_LINE_ART_NONE,
        text=pymupdf.PDF_REDACT_TEXT_REMOVE if removed else pymupdf.PDF_REDACT_TEXT_NONE,
    )

after = {}
images_removed = graphics_removed = 0
for number, rects in by_page.items():
    page = doc[number - 1]
    after[number] = {
        'annots': len(annots(page)),
        'images': len(page.get_images(full=True)),
        'drawings': len(page.get_drawings()),
    }
    images_removed += max(0, before[number]['images'] - after[number]['images'])
    graphics_removed += max(0, before[number]['drawings'] - after[number]['drawings'])

# Anything that vanished during the rewrite (an annotation the engine dropped as its area was replaced) is counted
# too, so the number in the warning is the number of annotations the file actually lost.
annotations_removed = scrubbed + sum(max(0, before[n]['annots'] - after[n]['annots']) for n in by_page)

attachments_removed = 0
if payload['removeMetadata']:
    doc.set_metadata({'title': '', 'author': '', 'subject': '', 'keywords': '', 'creator': '', 'producer': ''})
    doc.del_xml_metadata()
if payload['removeAttachments']:
    attachments_removed = doc.embfile_count()
    for index in range(doc.embfile_count() - 1, -1, -1):
        doc.embfile_del(index)

try:
    doc.save(payload['output'], garbage=4, deflate=True)
except Exception as error:
    print(json.dumps({'error': {'message': '%s: %s' % (type(error).__name__, error)}}))
    raise SystemExit(0)
doc.close()

# Read the written file back with the same engine on the other side of the save.
written = pymupdf.open(payload['output'])
region_text = []
still_readable = 0
for rect in payload['rects']:
    clip = pymupdf.Rect(rect['x'], rect['top'], rect['x'] + rect['w'], rect['top'] + rect['h'])
    remaining = flat(written[rect['page'] - 1].get_text('text', clip=clip))
    region_text.append({'index': rect['index'], 'text': remaining})
    if remaining:
        still_readable += 1

info = written.metadata
survived = []
if payload['removeMetadata']:
    for key in ('title', 'author', 'subject', 'keywords', 'creator', 'producer'):
        if info.get(key):
            survived.append(key)
    try:
        if written.xref_xml_metadata() > 0:
            survived.append('xmp')
    except Exception:
        pass

metrics = {
    'pages': written.page_count,
    'pagesTouched': len(by_page),
    'regions': len(payload['rects']),
    'rectsStillReadable': still_readable,
    'imagesRemoved': images_removed,
    'graphicsRemoved': graphics_removed,
    'annotationsRemoved': annotations_removed,
    'attachmentsRemoved': attachments_removed,
    'regionTextRemaining': region_text,
    'metadataSurvived': survived,
    'attachmentsRemaining': written.embfile_count(),
    'bytes': os.path.getsize(payload['output']),
    'seconds': 0.0,
}
written.close()
print(json.dumps(metrics))`;

/**
 * The primary verification: poppler's `pdftotext` limited to each rectangle.
 *
 * The doc's recipe extracts the whole document and greps for the removed token, which cannot answer the question that
 * matters — a token that also appears elsewhere survives correctly, so a document-wide grep either fails honest jobs
 * or is quietly weakened into a no-op. Poppler's `-x/-y/-W/-H` reads only the rectangle (`-r 72` so the units are
 * points and the conversion is exact), which makes "the text under this mark is gone" an assertion that holds
 * regardless of what the rest of the document says. It is also a third engine in the chain: neither the PyMuPDF that
 * rewrote the page nor the pikepdf that reads the metadata.
 */
export async function readRegionText(
  outputPath: string,
  rectangles: ReadonlyArray<Pick<PlannedRedaction, 'index' | 'page' | 'clipped'>>,
  pageHeight: (page: number) => number,
  opts: Omit<RunOptions, 'engine'>,
): Promise<Array<{ index: number; text: string }>> {
  const read: Array<{ index: number; text: string }> = [];
  for (const rectangle of rectangles) {
    const { x, y, w, h } = rectangle.clipped;
    const top = Math.max(0, pageHeight(rectangle.page) - (y + h));
    const result = await runPdfToText(
      [
        '-f',
        String(rectangle.page),
        '-l',
        String(rectangle.page),
        '-x',
        String(Math.round(x)),
        '-y',
        String(Math.round(top)),
        '-W',
        String(Math.max(1, Math.round(w))),
        '-H',
        String(Math.max(1, Math.round(h))),
        '-r',
        '72',
        outputPath,
        '-',
      ],
      opts,
    );
    if (result.code !== 0) {
      throw new JobFailure('CONVERSION_FAILED', {
        engine: 'pdftotext',
        message: 'The redacted document could not be read back, so the removal cannot be verified.',
        stderrTail: result.stderr.slice(-2000),
      });
    }
    read.push({ index: rectangle.index, text: result.stdout.replace(/\s+/g, ' ').trim() });
  }
  return read;
}

/**
 * The byte-level half: the raw file plus every stream this process can inflate.
 *
 * `docs/13-EDIT-AND-ANNOTATE.md` §4's recipe uses `strings`, which is not in the heavy image (measured) and would in
 * any case miss a deflated content stream — the exact place a removed token hides when the rewrite left an orphan.
 * So the haystack is the file's bytes *and* the bytes of every zlib stream in it, as latin1 strings so a byte maps to
 * exactly one character. Searching uncompressed bytes first is what catches the DocInfo and XMP copies that a
 * text-layer check cannot see.
 *
 * The third field, `hex`, is the text of the `<hex>` strings those two contain (`decodeHexStrings`): a run the
 * producer could not spell in the font's encoding is a `(…)` literal's twin, and a search that reads only the literal
 * half would report a leak-free file for a document that still says the value.
 */
export async function searchableBytes(path: string): Promise<{ raw: string; inflated: string; hex: string }> {
  const data = await readFile(path);
  const raw = data.toString('latin1');
  const inflated: string[] = [];

  const marker = Buffer.from('stream');
  let from = 0;
  for (;;) {
    const at = data.indexOf(marker, from);
    if (at === -1) break;
    let start = at + marker.length;
    if (data[start] === 0x0d) start += 1;
    if (data[start] === 0x0a) start += 1;
    const end = data.indexOf(Buffer.from('endstream'), start);
    if (end === -1) break;
    from = end + 1;
    try {
      inflated.push(inflateSync(data.subarray(start, end)).toString('latin1'));
    } catch {
      // Not a deflate stream (an image, or a stream with its own filter): the raw bytes above already cover it.
    }
  }

  const inflatedText = inflated.join('\n');
  // Decoded per half rather than over their concatenation: a haystack this large is why the raw and inflated strings are
  // held separately in the first place, and joining them to run one regex would copy the whole document again.
  return {
    raw,
    inflated: inflatedText,
    hex: [decodeHexStrings(raw), decodeHexStrings(inflatedText)].filter((text) => text.length > 0).join('\n'),
  };
}

/**
 * The `<hex>` strings in a haystack of PDF bytes, decoded — the third reading of the same file.
 *
 * A PDF string is written either literally (`(KEEP9X7)`) or as an even run of hex digits between angle brackets, and
 * a producer switches to the hex form the moment the text does not fit the font's own encoding. **Measured**, on this
 * tool's own output: PyMuPDF writes the surviving page label `redact fixture — page 1 of 1` back as
 * `<726564616374206669787475726520e2809420…> Tj`, where the input carried it as a `(…) Tj` literal. That matters here
 * more than anywhere else in the build, because this tool's product is an absence — a value that survived as a hex
 * string would be invisible to the byte half of the leak check, and the job would report success.
 *
 * `<<` opens a dictionary, so a candidate whose inside is not an even run of hex digits is rejected rather than
 * decoded: `<< /A 1 >>` contains a bracket pair that is not a string, and decoding it would turn a `/Length` and a
 * `/Filter` into bytes and search those. The bytes are then read as a PDF reader would: a leading `FEFF` means
 * UTF-16BE (the spec's encoding for text one byte per character cannot hold), otherwise UTF-8, otherwise latin1.
 */
function decodeHexStrings(text: string): string {
  const decoded: string[] = [];
  for (const match of text.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const digits = match[1]!.replace(/\s+/g, '');
    if (digits.length === 0 || digits.length % 2 !== 0) continue;
    const bytes = Buffer.from(digits, 'hex');
    if (bytes.length === 0) continue;
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      let body = bytes.subarray(2);
      if (body.length % 2 !== 0) body = body.subarray(0, body.length - 1);
      decoded.push(body.swap16().toString('utf16le'));
      continue;
    }
    try {
      decoded.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      decoded.push(bytes.toString('latin1'));
    }
  }
  return decoded.join('\n');
}
