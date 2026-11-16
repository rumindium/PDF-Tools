import { join } from 'node:path';
import { JobFailure } from '@pdftools/errors';
import { type OverlayMergeTarget, mergeOverlayPdf } from './overlay';
import { parseJsonLine, runPythonScriptStdin } from './python';
import type { RunOptions } from './run';

/**
 * PDF annotations — `docs/13-EDIT-AND-ANNOTATE.md` §2, the `annotate` tool.
 *
 * The one thing that separates this tool from `edit-pdf`, and the reason it exists at all: an annotation is a
 * **dictionary** in the page's `/Annots` array, not paint in the content stream. A highlight written this way can be
 * selected, edited and deleted in any reader, it carries the author and a timestamp, and — the part most tools get
 * wrong — it prints, because the dictionary says so (`/F 4`). `edit-pdf` draws marks; this writes documents *about*
 * the document.
 *
 * Two mechanisms, one per value of `flatten`:
 *
 *  - **`flatten: false` (the default, and the point of the tool).** Real annotation dictionaries with `/QuadPoints`,
 *    `/C`, `/T`, `/CreationDate`, `/M` and `/F 4`. Nothing is added to the page content, so the marks are as
 *    reversible as the reader allows.
 *  - **`flatten: true`.** The marks are drawn into the page content instead — a filled quad for a highlight, a line
 *    for underline and strike — and merged with a constant alpha (`mergeOverlayPdf`'s `alpha`, which wraps the
 *    overlay content in an `/ExtGState` with `ca`/`CA`). Alpha is set at the **PDF** level rather than at the drawing
 *    level because the drawing engine cannot do it: **measured** — Ghostscript in the light image answers
 *    `0.2 setopacityalpha` with `Error: /undefined in setopacityalpha`, so a translucent highlight cannot come out of
 *    the PostScript path that `edit-pdf`, `watermark` and the bands use.
 *
 * What flatten does **not** do: touch the annotations the document already had. They are someone else's content, and
 * "flatten" is a statement about the marks this job writes. The handler warns when the input carried annotations, so a
 * caller cannot mistake the setting for a document-wide cleanup.
 *
 * `readAnnotations` is the read-back, and it is what makes the tool's claims checkable: the output's annotation counts
 * and subtypes come from the file, not from what was asked for.
 */

export type MarkupKind = 'highlight' | 'underline' | 'strike';

/** A text-markup mark: a rectangle covering one line of a selection (a drag across three lines is three of these). */
export interface MarkupMark {
  kind: MarkupKind;
  /** Bottom-left corner and size, in PDF user space (points from the page's bottom-left) — `edit-pdf`'s convention. */
  rect: { xPt: number; yPt: number; widthPt: number; heightPt: number };
  color: [number, number, number];
}

/** A sticky note: a point on the page plus text a reader shows in a popup. */
export interface NoteMark {
  kind: 'note';
  xPt: number;
  yPt: number;
  text: string;
  author: string;
  /** Side of the note's icon box, in points. A reader draws the icon; the text lives in `/Contents`. */
  iconSizePt: number;
}

export type AnnotationMark = MarkupMark | NoteMark;

export interface AnnotationPage {
  /** 1-based page number. */
  page: number;
  marks: AnnotationMark[];
}

/** The `/Subtype` each mark becomes. The doc's names, not a house spelling. */
export const ANNOTATION_SUBTYPES: Record<AnnotationMark['kind'], string> = {
  highlight: '/Highlight',
  underline: '/Underline',
  strike: '/StrikeOut',
  note: '/Text',
};

/** `/F 4` is the print flag. Without it a highlight is invisible on paper — the defect this tool exists to avoid. */
export const ANNOTATION_PRINT_FLAG = 4;

/**
 * The four corners of a rectangle as a PDF `/QuadPoints` array, in the order the format defines: **upper-left,
 * upper-right, lower-left, lower-right**.
 *
 * The order is not cosmetic. It is the one array in this codebase whose element order a reader depends on to know
 * which way the quad faces, and getting it wrong rotates the mark onto the wrong half of the line or inverts it —
 * a failure that no presence check can see, which is why the golden cases assert ink *inside* the rect and blank
 * *outside* it. Measured against poppler's renderer: written this way, the marking lands exactly on the rectangle.
 */
export function quadPointsFor(rect: { xPt: number; yPt: number; widthPt: number; heightPt: number }): number[] {
  const left = rect.xPt;
  const right = rect.xPt + rect.widthPt;
  const bottom = rect.yPt;
  const top = rect.yPt + rect.heightPt;
  return [left, top, right, top, left, bottom, right, bottom];
}

/**
 * A PDF date string: `D:YYYYMMDDHHmmSS+00'00'`.
 *
 * UTC rather than local time because the worker's clock is the container's, and a document annotated at 03:00 UTC
 * should not claim a different hour depending on which host ran the job. The `+00'00'` spelling rather than a bare
 * `Z`: `Z` is a PDF 2.0 addition that older readers ignore, and the annotation timestamp is metadata a reviewer may
 * rely on.
 */
export function pdfDate(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}+00'00'`;
}

export interface AnnotationWriteResult {
  /** Annotations the file actually contains for the pages this job wrote, read back from the output. */
  written: number;
  pagesTouched: number;
  /** The document's total annotation count after the job, including any it arrived with. */
  totalInOutput: number;
  seconds: number;
}

/**
 * Write real annotations into `input`, producing `output`.
 *
 * The payload travels on stdin for the same reason a password does (`python.ts`): a note's text is the user's
 * content, and argv is readable by every process in the container that shares the worker's uid.
 */
export async function writeAnnotations(
  input: string,
  output: string,
  pages: AnnotationPage[],
  author: string,
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ annotations: number; seconds: number }> {
  const result = await runPythonScriptStdin(
    ANNOTATE_SCRIPT,
    {
      input,
      output,
      pages: scriptPayload(pages),
      author,
      printFlag: ANNOTATION_PRINT_FLAG,
      // One timestamp for the whole job: every mark this call writes was made at the same moment, and a per-mark
      // `new Date()` would make the marks of one save disagree by milliseconds for no reason.
      date: pdfDate(new Date()),
    },
    opts,
  );
  const parsed = parseJsonLine<{ written?: number; error?: { message: string } }>(result.stdout);
  if (parsed?.error) {
    throw new JobFailure('CONVERSION_FAILED', { message: parsed.error.message });
  }
  if (parsed?.written == null) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The annotations were not written.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return { annotations: parsed.written, seconds: Math.round(result.durationMs / 100) / 10 };
}

/**
 * Burn the marks into the page content instead of writing annotating dictionaries.
 *
 * Two calls, because the drawing is pikepdf work and the merge is the shared overlay operation: the marks become a
 * PDF with one page per touched page, and `mergeOverlayPdf` puts them on the right pages with a constant alpha.
 *
 * The note's icon is drawn as a filled square in a fixed colour — the contract's `note` carries no colour, and a
 * reader's own icon is what a flattened note becomes anyway (its `/Contents` text cannot live in a content stream).
 */
export async function flattenAnnotations(
  input: string,
  output: string,
  pages: AnnotationPage[],
  workDir: string,
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ pagesTouched: number; overlayBytes: number; seconds: number }> {
  const overlayPath = join(workDir, 'annotation-overlay.pdf');
  const built = await runPythonScriptStdin(
    MARK_OVERLAY_SCRIPT,
    { input, output: overlayPath, pages: scriptPayload(pages) },
    opts,
  );
  const parsed = parseJsonLine<{ pages?: number; bytes?: number; error?: { message: string } }>(built.stdout);
  if (parsed?.error) {
    throw new JobFailure('CONVERSION_FAILED', { message: parsed.error.message });
  }
  if (parsed?.pages == null) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The annotations could not be drawn.',
      stderrTail: built.stdout + built.stderr,
    });
  }

  const map: OverlayMergeTarget[] = pages.map((entry, index) => ({ page: entry.page, overlayPage: index + 1 }));
  const merged = await mergeOverlayPdf(input, overlayPath, output, map, { ...opts, alpha: FLATTEN_ALPHA });
  return {
    pagesTouched: merged.applied,
    overlayBytes: parsed.bytes ?? 0,
    seconds: Math.round((built.durationMs + merged.seconds * 1000) / 1000) / 10,
  };
}

/**
 * The alpha a flattened highlight is drawn with.
 *
 * A highlight's whole job is to sit *behind* the words it marks, so an opaque fill would hide them — the mark would be
 * flawless and the document unreadable. 0.45 is the customary value and it is applied to the overlay's fill **and**
 * stroke, which is what makes underline and strike (thin lines, not fills) come out at the same strength.
 */
export const FLATTEN_ALPHA = 0.45;

/** What a document says about its own annotations, read from the file. */
export interface AnnotationState {
  total: number;
  pages: Array<{
    /** 1-based page number. */
    page: number;
    /** `/Subtype` names without the slash, in the order the file lists them. */
    subtypes: string[];
    /** Quad points across the page's markup annotations — the array `quadPointsFor` builds. */
    quadPoints: number;
    /** True when every annotation on the page carries `/F 4`. */
    allPrint: boolean;
  }>;
}

/**
 * Read a document's annotations out of the file.
 *
 * This is the evidence for both branches of `flatten`: the annotated output has to contain the subtypes that were
 * asked for, and the flattened output has to contain **no more** of them than the input did.
 */
export async function readAnnotations(path: string, opts: Omit<RunOptions, 'engine'>): Promise<AnnotationState> {
  const result = await runPythonScriptStdin(READ_SCRIPT, { input: path }, opts);
  const parsed = parseJsonLine<AnnotationState>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The document’s annotations could not be read.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return parsed;
}

/** Marks in the shape the Python scripts read: absolute numbers, no unions. */
function scriptPayload(pages: AnnotationPage[]) {
  return pages.map((entry) => ({
    page: entry.page,
    marks: entry.marks.map((mark) =>
      mark.kind === 'note'
        ? { kind: 'note', x: mark.xPt, y: mark.yPt, text: mark.text, author: mark.author, size: mark.iconSizePt }
        : {
            kind: mark.kind,
            x: mark.rect.xPt,
            y: mark.rect.yPt,
            width: mark.rect.widthPt,
            height: mark.rect.heightPt,
            color: mark.color,
          },
    ),
  }));
}

const ANNOTATE_SCRIPT = `import json, sys
import pikepdf

payload = json.load(sys.stdin)
pdf = pikepdf.Pdf.open(payload['input'])
subtypes = {'highlight': '/Highlight', 'underline': '/Underline', 'strike': '/StrikeOut', 'note': '/Text'}
written = 0
for entry in payload['pages']:
    page = pdf.pages[entry['page'] - 1]
    annots = pikepdf.Array(page.obj.get('/Annots', []))
    for mark in entry['marks']:
        kind = mark['kind']
        dictionary = pikepdf.Dictionary(
            Type=pikepdf.Name('/Annot'),
            Subtype=pikepdf.Name(subtypes[kind]),
            # /F 4 is the print flag: an annotation without it is invisible on paper.
            F=payload['printFlag'],
            T=mark.get('author') or payload['author'],
            CreationDate=payload['date'],
            M=payload['date'],
        )
        if kind == 'note':
            dictionary['/Rect'] = pikepdf.Array([mark['x'], mark['y'], mark['x'] + mark['size'], mark['y'] + mark['size']])
            dictionary['/Contents'] = mark['text']
            # /Name picks which of the reader's icons to draw; /Comment is the speech bubble.
            dictionary['/Name'] = pikepdf.Name('/Comment')
        else:
            left, bottom = mark['x'], mark['y']
            right, top = left + mark['width'], bottom + mark['height']
            dictionary['/Rect'] = pikepdf.Array([left, bottom, right, top])
            # Upper-left, upper-right, lower-left, lower-right.
            dictionary['/QuadPoints'] = pikepdf.Array([left, top, right, top, left, bottom, right, bottom])
            dictionary['/C'] = pikepdf.Array(mark['color'])
        # An annotation dictionary must be an indirect object — a reader resolves /Annots entries through references,
        # and a direct dictionary there is a structural error even though it renders. Made explicit rather than left to
        # save-time promotion, because "pikepdf probably promotes it" is exactly the kind of assumption this tool
        # proves wrong: the read-back reports the file, not what was asked for.
        annots.append(pdf.make_indirect(dictionary))
        written += 1
    if len(annots) > 0:
        page.obj['/Annots'] = annots
pdf.save(payload['output'])
print(json.dumps({'written': written}))`;

const MARK_OVERLAY_SCRIPT = `import json, sys
import os
import pikepdf

# The colours and the stroke width live here rather than being templated in from TypeScript, so the script is a
# script: it can be copied out and run for a single page when a case fails. Yellow for a flattened note's icon — the
# contract's note carries no colour of its own — and a 1 pt hairline for underline and strike, which is what a reader
# draws for both.
NOTE_COLOR = (0.95, 0.76, 0.0)
STRIKE_WIDTH = 1

payload = json.load(sys.stdin)
# Every overlay page is the exact size of the target page it will be placed on. pikepdf scales the overlay's box onto
# the target's rectangle (calc_form_xobject_placement with shrink and expand both enabled), so equal sizes are what
# make one user-space point in the marks mean one point on the page; a fixed overlay size would silently scale every
# mark by the page-size ratio and the square would land as a rectangle.
with pikepdf.Pdf.open(payload['input']) as target, pikepdf.Pdf.new() as overlay:
    for entry in payload['pages']:
        box = target.pages[entry['page'] - 1].mediabox
        page = overlay.add_blank_page(page_size=(float(box[2]) - float(box[0]), float(box[3]) - float(box[1])))
        operations = []
        for mark in entry['marks']:
            if mark['kind'] == 'note':
                # A flattened note becomes its icon, because a content stream cannot carry a popup.
                operations.append(
                    'q %s %s %s rg %s %s %s %s re f Q'
                    % (NOTE_COLOR[0], NOTE_COLOR[1], NOTE_COLOR[2],
                       mark['x'], mark['y'], mark['size'], mark['size'])
                )
            elif mark['kind'] == 'highlight':
                operations.append(
                    'q %s %s %s rg %s %s %s %s re f Q'
                    % (mark['color'][0], mark['color'][1], mark['color'][2],
                       mark['x'], mark['y'], mark['width'], mark['height'])
                )
            else:
                # Underline sits on the rectangle's bottom edge, strike through its middle: the two marks differ only in
                # where the line goes, and both are drawn slightly inside the box so a hairline is not clipped.
                y = mark['y'] + (1.2 if mark['kind'] == 'underline' else mark['height'] / 2)
                operations.append(
                    'q %s %s %s RG %s w %s %s m %s %s l S Q'
                    % (mark['color'][0], mark['color'][1], mark['color'][2], STRIKE_WIDTH,
                       mark['x'], y, mark['x'] + mark['width'], y)
                )
        page.contents_add(pikepdf.Stream(overlay, ('\\n'.join(operations) + '\\n').encode('ascii')))
    overlay.save(payload['output'])
print(json.dumps({'pages': len(payload['pages']), 'bytes': os.path.getsize(payload['output'])}))`;

const READ_SCRIPT = `import json, sys
import pikepdf


payload = json.load(sys.stdin)
with pikepdf.Pdf.open(payload['input']) as pdf:
    pages = []
    total = 0
    for index, page in enumerate(pdf.pages, start=1):
        annots = page.obj.get('/Annots', [])
        subtypes = []
        quads = 0
        prints = True
        for annot in annots:
            subtype = str(annot.get('/Subtype', '')).lstrip('/')
            if subtype:
                subtypes.append(subtype)
            if '/QuadPoints' in annot:
                quads += len(annot['/QuadPoints']) // 8
            flags = int(annot.get('/F', 0))
            # Bit 3 (value 4) is "print". A mark without it is invisible on paper, which is the defect this tool
            # exists to avoid, so it is read back rather than assumed.
            if not flags & 4:
                prints = False
            total += 1
        pages.append({'page': index, 'subtypes': subtypes, 'quadPoints': quads, 'allPrint': prints})
print(json.dumps({'total': total, 'pages': pages}))`;
