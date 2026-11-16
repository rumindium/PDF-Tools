import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PdfToCsvOptions } from '@pdftools/contracts/tools';
import { countPdfPages, pythonOrThrow } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, expandRanges } from '@pdftools/worker-shared';

/**
 * `pdf-to-csv` — `docs/08-PDF-TO-OFFICE-AND-TEXT.md`.
 *
 * Camelot does the detection (its `lattice` flavour reads drawn rules, `stream` reads column alignment), so the
 * handler is about the decisions around it:
 *
 *  1. **`tableStrategy` maps onto flavours, and `auto` is two passes, not one guess.** `ruled` and `lattice` are the
 *     same request in the docs, `stream` is the whitespace reader, and `auto` asks `lattice` first and only falls back
 *     to `stream` when the ruled reader found nothing at all — which is the order that matters, because `stream` on a
 *     ruled form returns the rules as cells.
 *  2. **The page selection is passed through exactly.** Camelot takes a page *list* (`1,3,5`), so unlike the tools
 *     that only understand `-f`/`-l`, a non-contiguous selection here really is that selection. Nothing is widened.
 *  3. **A document with no table is a typed failure; a *page* without one is a warning.** `TABLE_NOT_FOUND` names the
 *     two things a user can fix (scanned pages need OCR; a table needs rules or alignment), because an empty CSV looks
 *     like a result. The two halves are separate on purpose and the distinction was lost in the first version of this
 *     comment: only a run that found *nothing anywhere* fails, while a mixed document reports `PAGES_WITHOUT_TABLES`
 *     naming the pages it skipped — `tables-mixed-a4.pdf` (tables on 1 and 3, none on 2 and 4) is the fixture that
 *     separates them, and both branches are asserted in `scripts/ci/golden.ts`.
 *  4. **`headerRow: false` cannot be honoured by this engine, and says so.** The reason is not the one the plan
 *     assumed: Camelot 2 does *not* consume a header (measured — `frame.columns` comes back as a `RangeIndex`), so
 *     the handler promotes the table's own first row to be the header line, exactly what `headerRow: true` asks for.
 *     With the flag off the file would be byte-identical anyway, because a CSV header line and the first data row
 *     carry the same cells in the same places — so the job carries `HEADER_ROW_NOT_HONOURED` instead of pretending
 *     otherwise. Same shape as `printBackground` in `html-to-pdf`: an option the UI accepts, the engine cannot
 *     express, and the warning admits to.
 *  5. **Low confidence is reported per table.** `TABLE_LOW_CONFIDENCE` when Camelot's own accuracy is under 70 % — a
 *     stream table on a busy page is frequently right about the cells and wrong about the rows, and a user reading a
 *     spreadsheet cannot tell by looking.
 */

/** Below this, Camelot's own accuracy score means the table is a guess worth naming. */
const LOW_CONFIDENCE = 70;
/** A "table" smaller than this is noise: one cell of a page's own text is not a table. */
const MIN_ROWS = 2;
const MIN_COLUMNS = 2;

export const pdfToCsv: Handler<PdfToCsvOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to read.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to read.' });
  }

  const selected = options.pages
    ? expandRanges(options.pages, pages).filter((page) => page >= 1 && page <= pages)
    : null;
  if (selected && selected.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: 'No page in this document matches that selection.',
    });
  }
  const pageSpec = selected ? [...new Set(selected)].sort((a, b) => a - b).join(',') : 'all';

  report({ progress: 25, phase: 'processing', message: 'Looking for tables.' });

  const result = await pythonOrThrow(
    CSV_SCRIPT,
    {
      input: document.path,
      outputDir,
      pages: pageSpec,
      flavors: flavorsFor(options.tableStrategy),
      minRows: MIN_ROWS,
      minColumns: MIN_COLUMNS,
      allTables: options.allTables,
      delimiter: options.delimiter,
      decimalComma: options.decimalComma,
      headerRow: options.headerRow,
    },
    runOpts,
  );

  const parsed = parseReport(result.stdout);
  if (parsed.error) {
    throw new JobFailure('UNSUPPORTED_CONTENT', { message: parsed.error, stderrTail: result.stderr });
  }

  const tables = parsed.tables ?? [];
  if (tables.length === 0) {
    throw new JobFailure('TABLE_NOT_FOUND', {
      message: selected
        ? `No table was found on page(s) ${pageSpec}. Scanned pages need the \`ocr\` tool first, and a table needs drawn rules or clearly aligned columns.`
        : 'No table was found in this document. Scanned pages need the `ocr` tool first, and a table needs drawn rules or clearly aligned columns.',
      stderrTail: result.stderr,
    });
  }

  report({ progress: 85, phase: 'finalizing', message: `Packaging ${tables.length} table(s).` });

  const warnings: Array<{ code: string; detail?: string }> = [];
  const lowConfidence = tables.filter((table) => table.accuracy < LOW_CONFIDENCE).map((table) => table.name);
  if (lowConfidence.length > 0) {
    warnings.push({
      code: 'TABLE_LOW_CONFIDENCE',
      detail: `${lowConfidence.join(', ')} scored under ${LOW_CONFIDENCE}% accuracy — check the rows and columns before using the values.`,
    });
  }
  if (!options.headerRow) {
    warnings.push({
      code: 'HEADER_ROW_NOT_HONOURED',
      detail:
        'A CSV header line and the table first row are the same cells in the same order, so this file is identical either way. Turn the option off only if a reader of yours needs no header line.',
    });
  }
  const pagesWithTables = new Set(tables.map((table) => table.page));
  const withoutTables = (selected ?? Array.from({ length: pages }, (_, index) => index + 1)).filter(
    (page) => !pagesWithTables.has(page),
  );
  if (withoutTables.length > 0 && tables.length > 0) {
    warnings.push({
      code: 'PAGES_WITHOUT_TABLES',
      detail: `No table was found on page(s) ${withoutTables.join(', ')}; every other selected page is in the output.`,
    });
  }

  const outputs = tables.map((table, index) => ({
    name: table.name,
    mime: 'text/csv',
    pages: [table.page],
    ...(index === 0 ? { primary: true } : {}),
  }));

  let bytes = 0;
  for (const output of outputs) bytes += (await stat(join(outputDir, output.name))).size;

  return {
    outputs,
    metrics: {
      tables: tables.length,
      rows: tables.reduce((total, table) => total + table.rows, 0),
      columns: tables.reduce((total, table) => Math.max(total, table.columns), 0),
      strategy: parsed.flavor,
      strategyRequested: options.tableStrategy,
      minAccuracy: tables.reduce((min, table) => Math.min(min, table.accuracy), 100),
      pages: pagesWithTables.size,
      pagesInDocument: pages,
      bytes,
    },
    warnings,
    engine: { name: `camelot:${parsed.flavor}` },
  };
};

function flavorsFor(strategy: PdfToCsvOptions['tableStrategy']): string[] {
  if (strategy === 'stream') return ['stream'];
  if (strategy === 'lattice' || strategy === 'ruled') return ['lattice'];
  return ['lattice', 'stream'];
}

interface TableReport {
  name: string;
  page: number;
  rows: number;
  columns: number;
  accuracy: number;
}

function parseReport(stdout: string): { tables?: TableReport[]; flavor?: string; error?: string } {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  if (!line) {
    return { error: 'The table extractor produced no report.' };
  }
  try {
    return JSON.parse(line) as { tables?: TableReport[]; flavor?: string; error?: string };
  } catch {
    return { error: 'The table extractor produced an unreadable report.' };
  }
}

/**
 * The extractor, as one Python program.
 *
 * Camelot reads a *file*, so there is no engine binary to call: the program is passed on stdin-like `-c` with its
 * arguments as JSON on argv (`runPython`), which keeps every user-controlled value out of the command line — the same
 * convention the overlay pipeline uses.
 *
 * Two details that are easy to get wrong and are therefore explicit: the fallback only runs when the first flavour
 * found *nothing* (a `stream` pass over a ruled table returns the rules as cells), and a cell is only re-interpreted
 * as a number when the request asked for European decimals, because silently rewriting `1.234` is a data-loss bug the
 * user would only find in their totals.
 */
const CSV_SCRIPT = `
import csv, json, os, re, sys

import camelot

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])

EUROPEAN = re.compile(r'^-?\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?$|^-?\\d+,\\d+$')


def header_and_rows(frame):
    """The header line, and the data rows.

    Camelot 2 leaves a synthetic RangeIndex in frame.columns (0, 1, 2 ...) because it does not consume a header
    row, so those names are not column names: writing them put a junk 0,1,2 first line above every table. Names
    are used when they are real ones, and otherwise the table's own first row is the header.
    """
    names = frame.columns.tolist()
    if len(frame) == 0:
        return [], []
    if any(isinstance(value, str) for value in names):
        return names, frame.values.tolist()
    return frame.values[0].tolist(), frame.values[1:].tolist()


def canonical(value):
    """Parse a European decimal, and nothing else. Values are passed through untouched otherwise."""
    text = str(value).strip()
    if not payload['decimalComma'] or not EUROPEAN.match(text):
        return value
    return text.replace('.', '').replace(',', '.')


tables, flavor = [], None
for candidate in payload['flavors']:
    try:
        found = camelot.read_pdf(payload['input'], pages=payload['pages'], flavor=candidate)
    except Exception as error:
        print(json.dumps({'error': 'The table extractor could not read this document: ' + str(error)[:200]}))
        sys.exit(0)
    if len(found) > 0:
        flavor = candidate
        tables = list(found)
        break

kept = []
for table in tables:
    frame = table.df
    if len(frame) < payload['minRows'] or len(frame.columns) < payload['minColumns']:
        continue
    kept.append(table)

if not payload['allTables'] and kept:
    kept = [max(kept, key=lambda item: len(item.df) * len(item.df.columns))]

report = []
for index, table in enumerate(kept):
    name = 'table-%02d.csv' % (index + 1)
    frame = table.df
    path = os.path.join(payload['outputDir'], name)
    header, rows = header_and_rows(frame)
    with open(path, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle, delimiter=payload['delimiter'])
        if payload['headerRow']:
            writer.writerow([canonical(value) for value in header])
            body = rows
        else:
            body = [header] + rows if header else rows
        for row in body:
            writer.writerow([canonical(value) for value in row])
    report.append({
        'name': name,
        'page': int(table.page),
        'rows': int(len(frame)),
        'columns': int(len(frame.columns)),
        'accuracy': round(float(table.accuracy), 2),
    })

print(json.dumps({'flavor': flavor, 'tables': report}))
`;
