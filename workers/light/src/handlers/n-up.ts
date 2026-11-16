import { join } from 'node:path';
import type { NUpOptions } from '@pdftools/contracts/tools';
import { countPdfPages, pythonOrThrow, readSignatureRecord, signatureInvalidatedWarning } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `n-up` — `docs/03-ORGANIZE-ROTATE-CROP.md`.
 *
 * Multiple source pages onto one sheet. Every engine in this image that could do it — `pdftk`, `pdfjam`, `pdfcpu` —
 * is absent, and the one that is present has no n-up: so the sheets are composed directly, by placing each source
 * page as a **Form XObject** and drawing it with an explicit `cm` matrix.
 *
 * That is not a fallback, it is the better of the two options here, for three reasons:
 *
 *  1. **Placement is exact and inspectable.** The matrix says exactly how much each page was scaled and where its
 *     origin went, so "8 pages per sheet, 12 mm gaps, no overflow" is arithmetic rather than a hope about what some
 *     other tool's defaults did.
 *  2. **It composes the *pages*, not a rasterisation of them.** The output stays vector — text stays selectable and
 *     the golden case still reads it back with `pdftotext`, which a render-then-place implementation could not do.
 *  3. **Rotation is not handled here at all, and that is the fix rather than an omission.** The first version
 *     compensated for `/Rotate` by hand — rotating the matrix and swapping the cell's width and height. Measuring the
 *     rendered sheet showed one page in four: `Page.as_form_xobject()` *already* bakes a page's `/Rotate` into the
 *     form's own `/Matrix` (a 90°-rotated page comes back with `/Matrix [0 -1 1 0 0 595]`), so the compensation
 *     rotated everything twice and pushed three of the four pages off the sheet, leaving the page count, the text and
 *     the sheet size all correct. The placement now transforms the form's `BBox` through its own `/Matrix` to get the
 *     rectangle the page actually *displays* as, and fits that — which is correct for every rotation, including a
 *     `/MediaBox` that does not start at the origin, without a single special case.
 *
 * The placement happens **inside the source document**, not in a fresh one. pikepdf refuses to write an object that
 * belongs to another `Pdf` (`copy_foreign` was removed in pikepdf 10), so the sheets are appended to the document
 * being read and the originals are deleted afterwards — one document, no cross-file object graph.
 */

/** `perSheet` → the grid, as `[columns, rows]` for a portrait sheet. Landscape sheets swap them. */
const GRIDS: Record<number, [number, number]> = {
  2: [1, 2],
  4: [2, 2],
  6: [2, 3],
  9: [3, 3],
  16: [4, 4],
};

/** Sheet sizes in points. `source` follows the first page of the input instead. */
const SHEET_SIZES: Record<string, [number, number]> = {
  a4: [595.276, 841.89],
  a3: [841.89, 1190.551],
  letter: [612, 792],
  legal: [612, 1008],
};

/** Margins around the sheet, in points — the same 10/15 pt the header-footer overlay uses, so printouts match. */
const MARGIN_X_PT = 10;
const MARGIN_Y_PT = 15;

const MM_TO_PT = 72 / 25.4;

export const nUp: Handler<NUpOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to lay out.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to lay out.' });
  }

  // Composing onto sheets produces a new document — but it is a *replacement* for the one that came in, not an
  // extract from it, so a signature on the input is gone and the user is owed the sentence before the rewrite.
  const signature = await readSignatureRecord(document.path, runOpts);

  const grid = GRIDS[options.perSheet];
  if (!grid) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `${options.perSheet} per sheet is not one of the supported layouts: 2, 4, 6, 9, 16.`,
    });
  }

  report({ progress: 20, phase: 'processing', message: `Laying out ${pages} page(s), ${options.perSheet} per sheet.` });

  // `source` means the sheet is the input's own page size, which is what a user printing on the same stock wants; the
  // first page decides, and a warning says so, because a mixed-size input then comes out uniform.
  const sheetSize = SHEET_SIZES[options.pageSize] ?? null;
  const effective = options.orientation === 'landscape' ? ([grid[1], grid[0]] as [number, number]) : grid;
  report({ progress: 35, phase: 'processing', message: `Sheet of ${effective[0]} x ${effective[1]} cells.` });

  const result = await pythonOrThrow(
    NUP_SCRIPT,
    {
      input: document.path,
      output: join(outputDir, 'n-up.pdf'),
      perSheet: options.perSheet,
      grid: effective,
      sheetSize,
      orientation: options.orientation,
      gapPt: options.gap * MM_TO_PT,
      marginX: MARGIN_X_PT,
      marginY: MARGIN_Y_PT,
      border: options.border,
    },
    runOpts,
  );

  let written: {
    sheets?: number;
    placed?: number;
    sheetSize?: [number, number];
    rotated?: number;
    acroFormDropped?: boolean;
    error?: string;
  } = {};
  try {
    written = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as typeof written;
  } catch {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The layout pass did not report what it produced.',
      stderrTail: result.stdout.slice(-400),
    });
  }
  if (written.error) {
    throw new JobFailure('VALIDATION_ERROR', { message: written.error });
  }

  if (!written.sheets || !written.placed) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The layout pass produced no sheets.',
      stderrTail: result.stdout.slice(-400),
    });
  }

  // Checked against the engine rather than assumed: the placement and the sheet count are arithmetic in the script,
  // so a page that silently failed to place is the one failure mode that leaves every other number intact.
  const outputPages = await countPdfPages(join(outputDir, 'n-up.pdf'), runOpts);
  const expected = Math.ceil(pages / options.perSheet);
  if (outputPages !== expected) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Expected ${expected} sheet(s) for ${pages} page(s) at ${options.perSheet} per sheet, but the output has ${outputPages}.`,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (written.acroFormDropped) {
    // The widgets lived on the originals, and the sheets are new pages that carry none of them, so an interactive
    // form cannot survive this composition. The output used to keep the `/AcroForm` anyway, and with it the pages its
    // fields still pointed at — pages no page tree listed any more (defect 83). Dropping the dictionary is the fix;
    // saying so is the other half, because "your form fields are gone" is a fact about the output the caller cannot
    // see in a rendered page.
    warnings.push({
      code: 'FORM_FIELDS_DROPPED',
      detail:
        'The input carries an interactive form. Widgets live on the pages they are drawn on, so no field survives being composed onto sheets, and the form dictionary is not carried into the output.',
    });
  }
  if (written.placed !== pages) {
    warnings.push({
      code: 'PAGES_NOT_PLACED',
      detail: `${pages - written.placed} page(s) were not placed on a sheet.`,
    });
  }
  if ((written.rotated ?? 0) > 0) {
    warnings.push({
      code: 'ROTATION_BAKED_IN',
      detail: `${written.rotated} page(s) carried a /Rotate value, which was baked into the placement so they appear the right way up.`,
    });
  }
  if (options.pageSize === 'source' && outputPages > 0) {
    // Worth saying out loud: every sheet takes the *first* page's size, so a mixed-size input comes out uniform.
    warnings.push({
      code: 'SHEET_SIZE_FROM_FIRST_PAGE',
      detail: 'Every sheet uses the first page of the input as its size.',
    });
  }

  report({ progress: 92, phase: 'finalizing' });
  return {
    outputs: [{ name: 'n-up.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages,
      sheets: outputPages,
      perSheet: options.perSheet,
      grid: effective,
      orientation: options.orientation,
      pageSize: options.pageSize,
      placed: written.placed,
      sheetSize: written.sheetSize,
      gapMm: options.gap,
      border: options.border,
      acroFormDropped: written.acroFormDropped === true,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: 'pikepdf' },
  };
};

/**
 * The layout pass.
 *
 * The sheet is drawn as one content stream of `q … cm /FmN Do Q` blocks: `q`/`Q` so a page's own graphics state
 * cannot leak into the next cell, `cm` with a uniform scale and a translation so the aspect ratio is preserved and
 * the page is centred in its cell, and `Do` to paint the form. The translation subtracts the form's own `BBox`
 * origin, because a page whose box does not start at `(0, 0)` would otherwise be offset by exactly that much — the
 * subtle half of this that a fixture with an unusual MediaBox would catch and this one would not.
 */
const NUP_SCRIPT = `
import json, sys
import pikepdf
from pikepdf import Pdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
pdf = Pdf.open(payload['input'])
total = len(pdf.pages)

columns, rows = payload['grid']
gap = payload['gapPt']
margin_x = payload['marginX']
margin_y = payload['marginY']

def displayed_rect(form):
    """The rectangle the form actually paints, in the space it is drawn into.

    A form's /Matrix (default identity) is applied to its /BBox *and* to its content before the current transform, and
    as_form_xobject uses that matrix to carry a page's /Rotate. Transforming the four corners of the box through the
    matrix therefore gives the displayed rectangle for free — for any rotation, and for a MediaBox that does not start
    at the origin. Compensating for /Rotate by hand instead is how this handler first rotated every page twice.
    """
    box = [float(value) for value in form.BBox]
    matrix = form.get('/Matrix')
    values = [float(value) for value in matrix] if matrix is not None else [1, 0, 0, 1, 0, 0]
    a, b, c, d, e, f = values
    corners = []
    for x in (box[0], box[2]):
        for y in (box[1], box[3]):
            corners.append((a * x + c * y + e, b * x + d * y + f))
    xs = [corner[0] for corner in corners]
    ys = [corner[1] for corner in corners]
    return [min(xs), min(ys), max(xs), max(ys)]


# The forms and their displayed rectangles are read before any sheet is added, so appending pages cannot change the
# indices.
sources = []
rotated_count = 0
for index in range(total):
    page = pdf.pages[index]
    form = page.as_form_xobject()
    if int(page.get('/Rotate', 0) or 0) % 360 != 0:
        rotated_count += 1
    sources.append({'form': form, 'rect': displayed_rect(form)})

if payload['sheetSize'] is not None:
    sheet_width, sheet_height = [float(value) for value in payload['sheetSize']]
else:
    rect = sources[0]['rect']
    sheet_width, sheet_height = rect[2] - rect[0], rect[3] - rect[1]
if payload['orientation'] == 'landscape' and sheet_height > sheet_width:
    sheet_width, sheet_height = sheet_height, sheet_width

cell_width = (sheet_width - 2 * margin_x - gap * (columns - 1)) / columns
cell_height = (sheet_height - 2 * margin_y - gap * (rows - 1)) / rows
if cell_width <= 0 or cell_height <= 0:
    print(json.dumps({'error': 'the gap and margins leave no room for a cell'}))
    sys.exit(0)

per_sheet = columns * rows
sheets, placed = 0, 0
for base in range(0, total, per_sheet):
    sheet = pdf.add_blank_page(page_size=(sheet_width, sheet_height))
    sheets += 1
    if '/XObject' not in sheet.Resources:
        sheet.Resources.XObject = pikepdf.Dictionary()
    code = []
    for slot in range(per_sheet):
        index = base + slot
        if index >= total:
            break
        rect = sources[index]['rect']
        width, height = rect[2] - rect[0], rect[3] - rect[1]
        column, row = slot % columns, slot // columns
        # One uniform scale, so the aspect ratio is preserved: the page is fitted, never stretched to the cell.
        scale = min(cell_width / width, cell_height / height)

        cell_x = margin_x + column * (cell_width + gap)
        cell_y = margin_y + (rows - 1 - row) * (cell_height + gap)
        # Centred in the cell, and the displayed rectangle's own origin is subtracted so a page whose box does not
        # start at (0, 0) lands in the cell rather than offset by exactly that much.
        offset_x = cell_x + (cell_width - width * scale) / 2 - rect[0] * scale
        offset_y = cell_y + (cell_height - height * scale) / 2 - rect[1] * scale

        name = '/Fm%d' % index
        sheet.Resources.XObject[name] = sources[index]['form']
        code.append('q %.4f 0 0 %.4f %.4f %.4f cm %s Do Q' % (scale, scale, offset_x, offset_y, name))
        if payload['border']:
            code.append(
                'q 0.4 w 0.6 G %.4f %.4f %.4f %.4f re S Q'
                % (cell_x, cell_y, cell_width, cell_height)
            )
        placed += 1
    sheet.Contents = pdf.make_stream('\\n'.join(code).encode())

# The originals are removed only after every sheet exists: the forms are separate objects, but the page indices the
# loop relied on are not.
del pdf.pages[0:total]

# A form is the one thing that outlives the pages it was drawn on. The widgets were annotations on the originals, so
# the sheets — new pages carrying only a content stream — cannot show a single field, but the AcroForm dictionary in
# the trailer is still reachable and each of its fields still names the page it came from. That reference keeps *those
# page objects* in the file after the page tree has stopped listing them: measured on the signed fixture, two sheets
# and **three** page objects, where the document without a form gives two and two. Readers follow the tree, so nothing
# is visibly wrong and only a check that counts objects can see it (defect 83). The dictionary goes, and the job says
# so — a caller whose form vanished has to be told which job took it.
had_acroform = '/AcroForm' in pdf.Root
if had_acroform:
    del pdf.Root.AcroForm

pdf.save(payload['output'], object_stream_mode=pikepdf.ObjectStreamMode.generate, compress_streams=True)
print(json.dumps({
    'sheets': sheets,
    'placed': placed,
    'rotated': rotated_count,
    'sheetSize': [round(sheet_width, 3), round(sheet_height, 3)],
    'acroFormDropped': had_acroform,
}))
`;
