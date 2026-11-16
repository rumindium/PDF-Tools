import { mkdir, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { OfficeToPdfOptions } from '@pdftools/contracts/tools';
import { buildQpdfPagesArgs, countPdfPages, qpdfOrThrow, sofficeOrThrow } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, type OutputDescriptor, describeMacroCarrier, findMacroCarrier } from '@pdftools/worker-shared';

/**
 * `office-to-pdf` — `docs/07-OFFICE-TO-PDF.md`.
 *
 * Per-job LibreOffice profile directories are mandatory, not an optimisation: a shared profile is a global mutable
 * lock, and it is the single most common cause of "it works alone and hangs under load". Each job gets
 * `-env:UserInstallation=file://$JOB_DIR/lo-profile`, so two containers converting at once never share state.
 *
 * Macros are refused before conversion, and the check reads the file rather than its MIME. The MIME set that used to
 * do this job could never match anything: uploads are typed from magic bytes, a `.xlsm` and a `.xlsx` are the same
 * ZIP whose directory says `xl/workbook.xml`, so a macro-enabled workbook arrived here as `…spreadsheetml.sheet`.
 * `findMacroCarrier` looks at what the formats actually put in the package — `vbaProject.bin`, an ODF `Basic/`
 * library, an OLE2 `_VBA_PROJECT` stream — so the refusal fires on the documents it was written for. The MIME set is
 * kept as the cheap first answer for a deployment whose upload typing is stricter than this one's.
 *
 * **The three options are wired to the engine, and each one was measured rather than named hopefully.**
 *
 *   * `pageRange` → the export filters' own `PageRange`. It was `sheetRange`, an option that selected *sheets*: the
 *     engine has no such selector. `PageRange` numbers the document's pages across sheets, and it is a page range
 *     for all three families (measured: a three-sheet workbook asked for `3` came back as sheet 2's first page —
 *     told apart from `1` by which sheet's marker text the output carried — and the same property selects page 1 of
 *     a Writer document and of a deck). A sheet *name* is not a page range and produces **no file at all**, which is
 *     why the grammar is validated here instead of being handed to an engine that answers a typo with silence.
 *   * `fitToPage` → `SinglePageSheets`. Measured: a 45-row, eight-column sheet that paginates to two pages comes
 *     back as one 385.6 × 576 pt page. There is no width-only scaling in the export filter, so the option is
 *     documented as "one page per sheet", which is what it does — the option itself used to set this property to
 *     `false` when it was `true`, i.e. it did nothing in either direction.
 *   * `slideNotes` → `ExportNotesPages`, **not** `ExportNotes`. Binary-search by measurement: `ExportNotes` is not a
 *     property of the Impress export filter and was ignored in silence, while `ExportNotesPages: true` turns a
 *     two-slide deck with one page of notes into a four-page PDF whose third page carries the notes text.
 *
 * **The `landscape` option is gone, and that is the measurement.** `IsLandscape` changes nothing in any of the three
 * filters — spreadsheet, text document and deck all came back byte-for-byte the shape they had without it, portrait
 * A4 where the document was portrait. Orientation lives in the document's page style, which a converter must not
 * rewrite without being asked, so there is nothing here to wire the option to; leaving a dropdown that returns the
 * same file either way in the UI was the worse choice.
 */

const MACRO_MIME = new Set([
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
]);

const FILTER_BY_EXT: Record<string, string> = {
  docx: 'writer_pdf_Export',
  doc: 'writer_pdf_Export',
  odt: 'writer_pdf_Export',
  rtf: 'writer_pdf_Export',
  txt: 'writer_pdf_Export',
  csv: 'calc_pdf_Export',
  xlsx: 'calc_pdf_Export',
  xls: 'calc_pdf_Export',
  ods: 'calc_pdf_Export',
  pptx: 'impress_pdf_Export',
  ppt: 'impress_pdf_Export',
  odp: 'impress_pdf_Export',
};

export const officeToPdf: Handler<OfficeToPdfOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const warnings: Array<{ code: string; detail?: string }> = [];
  const outputs: OutputDescriptor[] = [];
  const metrics: Record<string, unknown> = { inputFiles: files.length };
  let engineStderr = '';

  // Refused before the first conversion, so a mistyped range cannot cost an engine run each.
  const pageRange = pageRangeOrThrow(options.pageRange);
  if (pageRange) metrics.pageRange = pageRange;

  for (const file of files) {
    if (MACRO_MIME.has(file.kind ?? '')) {
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message: 'Macro-enabled Office files are not converted. Save it as a macro-free format first.',
      });
    }
    const carrier = await findMacroCarrier(file.path);
    if (carrier) {
      // The refusal is the control, not a nicety: LibreOffice *does* have a Basic runtime in this image (measured —
      // an application-scope macro in a user profile executes), and its document-macro policy is its own default
      // rather than this product's decision. Refusing the document before the engine sees it is what makes "macros
      // are not executed" a statement about the service instead of a bet on the engine's configuration.
      // The second reason is the user's: a document whose macros were silently dropped looks right and is not.
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message: `This is ${describeMacroCarrier(carrier)}, and macro-carrying documents are not converted. Save a macro-free copy (.xlsx, .docx, .odt) and submit that.`,
      });
    }
  }

  // Inside `workDir`, not `jobDir`. A handler is contracted to write only inside `workDir`, and the runtime's
  // cleanup only removes `input/`, `work/`, `tmp/`, `home/` (and `output/`) — so a profile at `jobDir/lo-profile`
  // is never deleted, and a few hundred of them accumulate on the shared volume until someone notices the disk.
  const profileDir = join(workDir, 'lo-profile');
  await mkdir(profileDir, { recursive: true });
  const convertDir = join(workDir, 'converted');
  await mkdir(convertDir, { recursive: true });

  for (const [index, file] of files.entries()) {
    report({
      progress: 10 + Math.round((index / files.length) * 70),
      phase: 'processing',
      message: `Converting ${index + 1} of ${files.length}.`,
    });

    const ext = basename(file.path).split('.').pop()?.toLowerCase() ?? '';
    const filter = FILTER_BY_EXT[ext] ?? 'writer_pdf_Export';

    const result = await sofficeOrThrow(
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        '--invisible',
        `-env:UserInstallation=file://${profileDir}`,
        ...(ext === 'csv' ? ['--infilter=CSV:44,34,76,1'] : []),
        '--convert-to',
        buildFilter(filter, { ...options, ...(pageRange ? { pageRange } : {}) }),
        '--outdir',
        convertDir,
        file.path,
      ],
      {
        cwd: workDir,
        timeoutMs: limits.timeoutSeconds * 1000,
        memoryMb: limits.memoryMb,
        ...(signal ? { signal } : {}),
      },
    );
    engineStderr = result.stderr || engineStderr;
  }

  const produced = (await readdir(convertDir)).filter((name) => name.toLowerCase().endsWith('.pdf')).sort();
  if (produced.length === 0) {
    // `soffice` exits **0** while reporting a failure on stderr, so an exit code is not the signal it looks like:
    // a mistyped filter produced "Error: no export filter for … found, aborting" and `sofficeOrThrow` returned
    // happily, leaving this branch to report only "produced no PDF output" — true, and useless for diagnosis.
    // The engine's own message is attached here rather than checked up front with `stderrIndicatesFailure`,
    // because a *warning* on stderr (LibreOffice warns about the absent JRE in this image) must not fail a job
    // whose output is sitting on disk.
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'LibreOffice produced no PDF output.',
      ...(engineStderr ? { stderrTail: engineStderr } : {}),
    });
  }

  // A single input keeps its own name; several inputs are merged into one document (the documented default).
  if (produced.length === 1) {
    const target = join(outputDir, 'converted.pdf');
    await rename(join(convertDir, produced[0]!), target);
    outputs.push({ name: 'converted.pdf', mime: 'application/pdf', primary: true });
  } else {
    const merged = join(outputDir, 'converted.pdf');
    // One `--pages` group holding every file: repeating it here, one per input, was the reason a two-file
    // conversion produced nothing. The builder is shared with `merge` and `images-to-pdf`, which made the same
    // mistake independently.
    const args = buildQpdfPagesArgs(
      produced.map((file) => ({ path: join(convertDir, file) })),
      merged,
    );
    // `qpdfOrThrow`, not `runQpdf`: the plain variant returns the exit code for the caller to inspect, and this
    // handler inspected nothing, so a qpdf that exited 2 fell through to output verification and was reported as
    // "the tool reported success but produced no usable output" — the opposite of what happened, with qpdf's own
    // explanation discarded.
    await qpdfOrThrow(args, {
      cwd: workDir,
      timeoutMs: limits.timeoutSeconds * 1000,
      memoryMb: limits.memoryMb,
      ...(signal ? { signal } : {}),
    });
    outputs.push({ name: 'converted.pdf', mime: 'application/pdf', primary: true });

    // Merging with qpdf's `--pages` does not rebuild a document outline; say so instead of pretending.
    warnings.push({
      code: 'BOOKMARKS_APPROXIMATED',
      detail: 'Multiple inputs were merged; the individual documents’ outlines are not reconstructed.',
    });
  }

  // Page sizes differ between sources, which is worth telling the user about: a merged 12-page deck and a
  // A4 document produce a document with mixed page sizes that surprises people in print.
  if (produced.length > 1) {
    warnings.push({
      code: 'MIXED_PAGE_SIZES',
      detail: 'The merged document uses each source’s own page size.',
    });
  }

  metrics.outputFiles = produced.length;
  // The page count of what actually came out, read back from the file rather than assumed from the input. `metrics`
  // is where the API's `pages` field comes from (`workers/shared/src/runtime.ts` reads `metrics.outputPages`), and a
  // document's page count is not something a caller can predict from the request: it is the engine's layout.
  const outputPages = await countPdfPages(join(outputDir, outputs[0]!.name), {
    cwd: workDir,
    timeoutMs: Math.min(limits.timeoutSeconds * 1000, 30_000),
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  });
  if (outputPages > 0) metrics.outputPages = outputPages;
  report({ progress: 92, phase: 'finalizing' });

  return {
    outputs,
    metrics,
    warnings,
    engine: { name: 'libreoffice' },
  };
};

/**
 * The `--convert-to` argument: `pdf:<filter>` — the target **extension first**, then the filter name.
 *
 * This ordering is load-bearing and quietly unforgiving. LibreOffice parses the argument as
 * `<extension>[:<filter>[:<options>]]`, so passing the filter name alone makes it look for an export filter
 * matching the output *extension* `writer_pdf_Export` and abort with "no export filter for x.writer_pdf_Export" —
 * while still exiting 0. Every conversion in the office pool therefore produced nothing until this was fixed.
 *
 * Options are a JSON string after the selector, e.g.
 * `pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}`.
 */
function buildFilter(filter: string, options: OfficeToPdfOptions): string {
  const properties: Record<string, unknown> = {};

  if (options.pageRange) {
    // Validated by `pageRangeOrThrow` before the conversion starts, so this value is known to be in the grammar the
    // engine accepts (`1`, `1-3`, `1,3-5`). An unparseable value is the one case the engine answers with *no file at
    // all* (`PageRange: 'Beta'` on a workbook), which would otherwise surface as `CONVERSION_FAILED` — true, and
    // useless for diagnosis.
    properties.PageRange = { type: 'string', value: options.pageRange.replace(/\s/g, '') };
  }
  if (filter === 'calc_pdf_Export' && options.fitToPage) {
    // `true` — the value that actually means "each sheet on one page". It was `false` here, which is the engine's
    // default, so `fitToPage` did nothing whichever way it was set (measured: six pages for a three-sheet workbook
    // either way, three pages with the property set to `true`).
    properties.SinglePageSheets = { type: 'boolean', value: 'true' };
  }
  if (filter === 'impress_pdf_Export' && options.slideNotes) {
    // `ExportNotesPages`, measured: `ExportNotes` is not a property of this filter and was ignored silently.
    properties.ExportNotesPages = { type: 'boolean', value: 'true' };
  }

  const selector = `pdf:${filter}`;
  return Object.keys(properties).length === 0 ? selector : `${selector}:${JSON.stringify(properties)}`;
}

/** The page-range grammar LibreOffice's export filters accept, and the shapes it answers with silence for. */
const PAGE_RANGE = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;

/**
 * The requested page range, or a refusal that names the grammar.
 *
 * The engine's own failure for a value it cannot parse is *no output file* — not an error message — so a caller who
 * asked for a sheet by name would get "LibreOffice produced no PDF output" with nothing pointing at the option. The
 * check is here because this is the only layer that knows the value came from `pageRange`.
 */
function pageRangeOrThrow(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.replace(/\s/g, '');
  if (!PAGE_RANGE.test(normalized)) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `"${value}" is not a page range. Use page numbers or ranges separated by commas, e.g. "1", "1-3" or "1,4-6".`,
    });
  }
  return normalized;
}
