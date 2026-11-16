import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PdfToOfficeOptions } from '@pdftools/contracts/tools';
import { countPdfPages, pythonOrThrow } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, expandRanges, pageBounds } from '@pdftools/worker-shared';

/**
 * `pdf-to-office` — `docs/08-PDF-TO-OFFICE-AND-TEXT.md`.
 *
 * Three targets, three engines, and one thing they share: **reconstruction is not idempotent**. Converting PDF →
 * DOCX → PDF does not give the original document back, and the honest version of that fact is `LAYOUT_APPROXIMATE`
 * on every job rather than a paragraph in a tooltip.
 *
 *  1. **`docx` runs `pdf2docx`, which is the only one of the three that reproduces a page.** Its whole approach is
 *     layout reconstruction, and it emits real Word tables as a side effect of that. So the two options that would
 *     contradict it — `keepLayout: false` and `detectTables: false` — route to a **paragraph builder** instead
 *     (PyMuPDF's text blocks into `python-docx`), because pdf2docx has no switch for either. One engine with a
 *     documented alternative beats an option that quietly does nothing.
 *  2. **`xlsx` is the table extractor, not a document converter.** Camelot (the same engine `pdf-to-csv` uses) reads
 *     the tables and `openpyxl` writes them, one sheet per table by default — or one sheet per page with the tables
 *     stacked, when `oneSheetPerPage` asks for that. `detectTables: false` writes each page's text lines into a
 *     single column, which is what "no tables" means for a spreadsheet. When detection finds nothing at all it falls
 *     back to that text grid **with a warning**, rather than failing a job whose user asked for a spreadsheet.
 *  3. **`pptx` is a page image per slide with editable text on top**, which is what the document specifies: good for
 *     decks that came from slides, useless for a scan. PyMuPDF renders the page and hands back the text blocks with
 *     their coordinates, so the text is real text (selectable, editable) and the picture is only the background.
 *  4. **An all-image selection is refused, not converted.** Rebuilding a scan produces a document full of pictures of
 *     words, so `IMAGE_ONLY_PAGES` names the pages and `ocr` as the next step; a *partly* image-only document
 *     converts and warns instead, because refusing that would be refusing a working document.
 *  5. **A non-contiguous selection is widened where the engine can only take a range.** `pdf2docx` converts a start
 *     and an end page, so a selection like `1,4` becomes the span `1-4` and the job says so
 *     (`SELECTION_WIDENED`); our own writers use the exact page list and never widen.
 */

export const pdfToOffice: Handler<PdfToOfficeOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to rebuild.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to rebuild.' });
  }
  const bounds = pageBounds(options.pages, pages);
  // The selection the user asked for, exactly: `1,3` is two pages, not the window between them.
  const requested = options.pages
    ? [...new Set(expandRanges(options.pages, pages))].filter((page) => page <= pages)
    : null;
  // `pdf2docx` converts a range and cannot skip a page inside it, so the docx *layout* branch converts the span of
  // the selection; our own writers (python-docx, openpyxl, python-pptx) are handed the exact list. The two lists are
  // kept apart on purpose — computing "was it widened?" from the list we already widened makes that question
  // unanswerable, which is exactly how this warning came out unreachable the first time (defect 52).
  const spanPages = bounds ? rangeBounds(bounds).filter((page) => page <= pages) : [];
  const convertsRange = options.target === 'docx' && options.keepLayout && options.detectTables;
  const selected =
    requested == null ? Array.from({ length: pages }, (_, index) => index + 1) : convertsRange ? spanPages : requested;
  const selectionWidened = convertsRange && requested != null && spanPages.length !== requested.length;

  report({ progress: 20, phase: 'processing', message: `Rebuilding ${selected.length} page(s).` });

  const outputName =
    options.target === 'docx' ? 'report.docx' : options.target === 'xlsx' ? 'workbook.xlsx' : 'deck.pptx';

  const result = await pythonOrThrow(
    OFFICE_SCRIPT,
    {
      input: document.path,
      output: join(outputDir, outputName),
      outputDir,
      workDir,
      target: options.target,
      // pdf2docx takes a contiguous range only; everything else takes the list.
      span: bounds ? { first: bounds.first, last: bounds.last } : null,
      pages: selected,
      keepLayout: options.keepLayout,
      detectTables: options.detectTables,
      imageQuality: options.imageQuality,
      oneSheetPerPage: options.oneSheetPerPage,
    },
    runOpts,
  );

  const parsed = parseReport(result.stdout);
  if (parsed.error) {
    if (parsed.errorCode === 'IMAGE_ONLY_PAGES') {
      throw new JobFailure('IMAGE_ONLY_PAGES', { message: parsed.error, stderrTail: result.stderr });
    }
    throw new JobFailure('CONVERSION_FAILED', { message: parsed.error, stderrTail: result.stderr });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  warnings.push({
    code: 'LAYOUT_APPROXIMATE',
    detail:
      options.target === 'docx'
        ? 'Text is editable but its positions are approximate: columns, frames and rotated text can shift.'
        : options.target === 'xlsx'
          ? 'Cells come from table detection, so a merged or unruled table can land in the wrong columns.'
          : 'Each slide is an image of the page with editable text boxes on top; the picture is not text.',
  });
  if (parsed.imageOnlyPages.length > 0) {
    warnings.push({
      code: 'IMAGE_ONLY_PAGES',
      detail: `Page(s) ${parsed.imageOnlyPages.join(', ')} have no text layer, so they are only an image in this output. Run the whole document through \`ocr\` for editable text.`,
    });
  }
  if (selectionWidened && bounds) {
    warnings.push({
      code: 'SELECTION_WIDENED',
      detail: `This engine converts one range at a time, so pages ${bounds.first}-${bounds.last} were converted; every page in that span is in the output, which is more than the ${requested?.length ?? 0} page(s) selected.`,
    });
  }
  if (parsed.tablesLowConfidence) {
    warnings.push({
      code: 'TABLE_LOW_CONFIDENCE',
      detail:
        'At least one detected table scored under 70% accuracy — check its rows and columns before trusting the values.',
    });
  }
  if (parsed.tablesFallback) {
    warnings.push({
      code: 'TABLES_NOT_FOUND_FALLBACK',
      detail: 'No table was detected, so each page was written as one column of text lines instead of failing the job.',
    });
  }

  const bytes = (await stat(join(outputDir, outputName))).size;
  return {
    outputs: [
      {
        name: outputName,
        mime:
          options.target === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : options.target === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        primary: true,
      },
    ],
    metrics: {
      pages: selected.length,
      pagesInDocument: pages,
      target: options.target,
      tables: parsed.tables,
      slides: parsed.slides,
      images: parsed.images,
      characters: parsed.characters,
      keepLayout: options.keepLayout,
      detectTables: options.detectTables,
      bytes,
    },
    warnings,
    engine: { name: parsed.engine ?? 'unknown' },
  };
};

/** The explicit page list a span covers — used to hand our own writers exactly what the user selected. */
function rangeBounds(bounds: { first: number; last: number }): number[] {
  const pages: number[] = [];
  for (let page = bounds.first; page <= bounds.last; page += 1) pages.push(page);
  return pages;
}

interface OfficeReport {
  tables?: number;
  slides?: number;
  images?: number;
  characters?: number;
  engine?: string;
  imageOnlyPages?: number[];
  tablesLowConfidence?: boolean;
  tablesFallback?: boolean;
  error?: string;
  errorCode?: string;
}

function parseReport(stdout: string): OfficeReport & { imageOnlyPages: number[] } {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  if (!line) {
    return { error: 'The reconstruction engine produced no report.', imageOnlyPages: [] };
  }
  try {
    const parsed = JSON.parse(line) as OfficeReport;
    return { ...parsed, imageOnlyPages: parsed.imageOnlyPages ?? [] };
  } catch {
    return { error: 'The reconstruction engine produced an unreadable report.', imageOnlyPages: [] };
  }
}

/**
 * All three targets, as one Python program.
 *
 * Split into three functions rather than one branchy flow because the three share almost nothing beyond the payload:
 * a document converter, a table extractor and a slide builder. The two rules that are stated where they are used:
 * a text-layer probe runs *before* any branch (so a scan is refused once, with one message), and nothing is written
 * to a partial file — the writers close their own document before the program reports success, so a truncated output
 * cannot be mistaken for a complete one.
 */
const OFFICE_SCRIPT = `
import json, os, sys

import fitz  # PyMuPDF

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])

input_path = payload['input']
pages = payload['pages']
target = payload['target']
image_only = []


def probe_pages():
    """Pages with no text layer. One pass, used by all three branches and by the refusal below."""
    document = fitz.open(input_path)
    empty = []
    for page_number in pages:
        text = document[page_number - 1].get_text('text').strip()
        if len(text) == 0:
            empty.append(page_number)
    document.close()
    return empty


def write_docx_tables():
    """pdf2docx: layout reconstruction, with real Word tables."""
    from pdf2docx import Converter

    span = payload['span'] or {'first': 1, 'last': max(pages)}
    converter = Converter(input_path)
    converter.convert(payload['output'], start=int(span['first']) - 1, end=int(span['last']) - 1)
    converter.close()
    return {'tables': count_docx_tables(payload['output']), 'engine': 'pdf2docx'}


def count_docx_tables(path):
    import zipfile
    with zipfile.ZipFile(path) as archive:
        body = archive.read('word/document.xml').decode('utf-8', 'replace')
    return body.count('<w:tbl>')


def write_docx_paragraphs():
    """python-docx from PyMuPDF's text blocks: flowing paragraphs, no tables, no positioning."""
    import docx

    document = docx.Document()
    source = fitz.open(input_path)
    for page_number in pages:
        blocks = [block for block in source[page_number - 1].get_text('blocks') if block[4].strip()]
        for block in blocks:
            document.add_paragraph(block[4].strip())
    source.close()
    document.save(payload['output'])
    return {'tables': 0, 'engine': 'python-docx'}


def sheet_rows(table):
    """The cells of one Camelot table, with the engine's synthetic column names kept out of the sheet.

    Camelot 2 does not consume a header row and hands back a RangeIndex as columns (0, 1, 2 ...), so writing them
    put a junk row above every table — a spreadsheet that opens with 0 1 2 and only then the real header. Real
    (string) names are still written, so an engine that does detect a header keeps it.
    """
    frame = table.df
    names = frame.columns.tolist()
    if any(isinstance(value, str) for value in names):
        return [names] + frame.values.tolist()
    return frame.values.tolist()


def write_xlsx():
    """Camelot for tables, openpyxl for the workbook. Falls back to one text column per page."""
    import openpyxl

    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    tables, low_confidence, fallback = 0, False, False

    if payload['detectTables']:
        import camelot

        found = []
        for flavor in ('lattice', 'stream'):
            try:
                detected = camelot.read_pdf(input_path, pages=','.join(str(page) for page in pages), flavor=flavor)
            except Exception:
                detected = []
            if len(detected) > 0:
                found = [table for table in detected if table.df.shape[0] >= 2 and table.df.shape[1] >= 2]
                if found:
                    break
        if not found:
            fallback = True
        elif payload['oneSheetPerPage']:
            by_page = {}
            for table in found:
                by_page.setdefault(int(table.page), []).append(table)
            for page_number in sorted(by_page):
                sheet = workbook.create_sheet('page-%d' % page_number)
                row = 1
                for table in by_page[page_number]:
                    if table.accuracy < 70:
                        low_confidence = True
                    rows = sheet_rows(table)
                    for values in rows:
                        for column, value in enumerate(values, start=1):
                            sheet.cell(row=row, column=column, value=value)
                        row += 1
                    row += 1
                    tables += 1
        else:
            for index, table in enumerate(found, start=1):
                if table.accuracy < 70:
                    low_confidence = True
                sheet = workbook.create_sheet('table-%02d-p%d' % (index, int(table.page)))
                rows = sheet_rows(table)
                for row_number, values in enumerate(rows, start=1):
                    for column, value in enumerate(values, start=1):
                        sheet.cell(row=row_number, column=column, value=value)
                widen(sheet, rows)
                tables += 1

    if tables == 0:
        fallback = payload['detectTables'] or fallback
        source = fitz.open(input_path)
        for page_number in pages:
            sheet = workbook.create_sheet('page-%d' % page_number)
            lines = [line for line in source[page_number - 1].get_text('text').splitlines() if line.strip()]
            for row_number, line in enumerate(lines, start=1):
                sheet.cell(row=row_number, column=1, value=line)
            sheet.column_dimensions['A'].width = 90
        source.close()

    workbook.save(payload['output'])
    return {
        'tables': tables,
        'engine': 'camelot+openpyxl',
        'tablesLowConfidence': low_confidence,
        'tablesFallback': fallback and payload['detectTables'],
    }


def widen(sheet, rows):
    # Imported here, not in write_xlsx: a function-local import is local to that function, so this one used to raise
    # NameError from a different scope than the import — and only on the branch that widens columns.
    from openpyxl.utils import get_column_letter

    for column in range(1, len(rows[0]) + 1 if rows else 1):
        width = max(len(str(row[column - 1])) for row in rows if len(row) >= column) if rows else 8
        sheet.column_dimensions[get_column_letter(column)].width = min(max(width + 2, 10), 60)


def write_pptx():
    """One slide per page: the page as an image, its text as editable boxes on top."""
    from PIL import Image
    from pptx import Presentation
    from pptx.util import Emu, Pt

    source = fitz.open(input_path)
    presentation = Presentation()
    first = source[pages[0] - 1].rect
    # The slide takes the page's aspect ratio, so a landscape deck does not come out cropped into portrait frames.
    presentation.slide_width = Emu(int(9144000))
    presentation.slide_height = Emu(int(9144000 * (first.height / first.width)))
    blank = presentation.slide_layouts[6]
    images, characters = 0, 0

    for page_number in pages:
        page = source[page_number - 1]
        slide = presentation.slides.add_slide(blank)
        scale = 2
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        image_path = os.path.join(payload['workDir'], 'page-%04d.jpg' % page_number)
        Image.frombytes('RGB', (pixmap.width, pixmap.height), pixmap.samples).save(
            image_path, 'JPEG', quality=int(payload['imageQuality'])
        )
        slide.shapes.add_picture(
            image_path, 0, 0, width=presentation.slide_width, height=presentation.slide_height
        )
        images += 1

        # Text blocks keep their coordinates, converted from points to EMU by the page's own width.
        for block in page.get_text('blocks'):
            text = block[4].strip()
            if len(text) == 0:
                continue
            x0, y0, x1, y1 = block[:4]
            left = Emu(int(x0 / first.width * presentation.slide_width))
            top = Emu(int(y0 / first.height * presentation.slide_height))
            width = Emu(int(max(x1 - x0, 20) / first.width * presentation.slide_width))
            height = Emu(int(max(y1 - y0, 12) / first.height * presentation.slide_height))
            box = slide.shapes.add_textbox(left, top, width, height)
            frame = box.text_frame
            frame.word_wrap = True
            frame.text = text
            # Font size is derived from the block's own height, so a heading stays a heading.
            frame.paragraphs[0].font.size = Pt(max(8, min(36, (y1 - y0) * 0.7)))
            characters += len(text)

    source.close()
    presentation.save(payload['output'])
    return {'slides': len(pages), 'images': images, 'characters': characters, 'engine': 'pymupdf+python-pptx'}


image_only = probe_pages()
if len(image_only) == len(pages):
    print(json.dumps({
        'error': 'Every selected page is an image with no text layer, so there is nothing to rebuild as editable content. Run the document through the OCR tool first.',
        'errorCode': 'IMAGE_ONLY_PAGES',
    }))
    sys.exit(0)

try:
    if target == 'docx':
        result = write_docx_tables() if (payload['keepLayout'] and payload['detectTables']) else write_docx_paragraphs()
    elif target == 'xlsx':
        result = write_xlsx()
    else:
        result = write_pptx()
except Exception as error:
    print(json.dumps({'error': 'The reconstruction failed: ' + str(error)[:300]}))
    sys.exit(0)

if not os.path.exists(payload['output']) or os.path.getsize(payload['output']) == 0:
    print(json.dumps({'error': 'The reconstruction produced no output file.'}))
    sys.exit(0)

result['imageOnlyPages'] = image_only
print(json.dumps(result))
`;
