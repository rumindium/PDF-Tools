import { config } from '@pdftools/config';
import { JobFailure } from '@pdftools/errors';
import { type RunOptions, type RunResult, run, runOrThrow } from './run';

export type { RunOptions, RunResult };
export { run, runOrThrow, stderrIndicatesFailure } from './run';
// The command-line guard (`0-SECURITY.md` §7.1): a job's passwords are registered by the worker for as long as the job
// runs, and the spawn path refuses any argument containing one. Exported so the worker can register, and so a test can
// prove the refusal without a container.
export { MIN_GUARDED_SECRET_LENGTH, guardedSecretCount, registerJobSecrets, releaseJobSecrets } from './run';
// What a tool's `limits.memoryMb` actually does (`run.ts`): the `RLIMIT_AS` ceiling, and whether this environment
// can apply it at all. Exported because the answer is per-environment — Linux has `prlimit` and a developer's
// machine does not — so the boot check and the tests have to be able to ask instead of assuming.
export {
  type MemoryLimitSupport,
  PRLIMIT_CANDIDATES,
  memoryLimitSupport,
  memoryLimitedCommand,
  resolvePrlimit,
} from './run';
// The PDF/A archival claim (`docs/09-PDF-A.md`): the preamble Ghostscript needs before `-dPDFA` produces a file that
// is actually archival, the profile lookup it embeds, the readers that verify the claim in the delivered bytes, and
// the two censuses that make the job's `changes` a measurement of the caller's document.
export {
  type FontCensus,
  type ImageCensus,
  type PdfaOutputIntent,
  PDFA_INTENT_FILENAME,
  buildPdfaOutputIntent,
  censusFonts,
  censusImages,
  findPdfaProfile,
  hasPdfaOutputIntent,
  parseFontCensus,
  parseImageCensus,
  readPdfaClaim,
} from './pdfa';

// The page-decoration pipeline (`docs/11-WATERMARK.md` §4): PostScript rendering plus the pikepdf merge, shared by
// `page-numbers`, `header-footer`, `watermark`, and `edit-pdf`.
export {
  type ImageStampPage,
  type MarkBox,
  type OverlayAnchor,
  type OverlayMergeTarget,
  type OverlayPage,
  type OverlayPlacement,
  type OverlayRule,
  type OverlayVector,
  type WatermarkPosition,
  WATERMARK_TILE_DEFAULT_PERCENT,
  WATERMARK_TILE_MAX_PERCENT,
  WATERMARK_TILE_MIN_PERCENT,
  buildImageOverlayPdf,
  buildOverlayPostScript,
  buildVectorOps,
  escapePostScriptText,
  marksOutsidePage,
  mergeOverlayPdf,
  placementGeometry,
  readPageBoxes,
  renderOverlayPdf,
  watermarkStampPoints,
} from './overlay';

// The ink signature (`docs/14-SIGN-AND-FORMS.md`): placement planning, the typed and bitmap overlay builders, and
// the metadata write plus the read-back that proves the output carries no `/Sig`, no `/ByteRange` and no `/Perms`.
export {
  type PageBox,
  type PlannedSignature,
  type SignatureLines,
  type SignaturePlacementInput,
  type SignatureRecord,
  SIGNATURE_FONTS,
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_IMAGE_MAX_PX,
  SIGNATURE_PLACEMENT_MAX,
  availableSignatureFonts,
  planSignaturePlacements,
  readSignatureRecord,
  readSignedText,
  resolveSignedAt,
  signatureBorders,
  signatureFont,
  signatureImageOverlay,
  signatureInvalidatedWarning,
  signatureLines,
  signatureMetaOverlay,
  signatureTextOverlay,
  writeSignatureMetadata,
} from './signatures';

// The encryption engine (`docs/10-PROTECT-AND-UNLOCK.md`): one pikepdf write shared by `encrypt`, `restrict`, and
// `unlock`, plus the reader that checks what the written file actually says about itself.
export {
  type EncryptionName,
  type EncryptionRequest,
  type EncryptionResult,
  type EncryptionState,
  type SecurityPermissions,
  PERMISSION_TABLE,
  assertPasswordTransportable,
  assertPermissionsCoherent,
  buildPermissionValues,
  decryptPdf,
  encryptPdf,
  encryptionSettings,
  generateOwnerPassword,
  isAes,
  parseEncryptionReport,
  permissionWarnings,
  readEncryptionState,
} from './security';

// The annotation engine (`docs/13-EDIT-AND-ANNOTATE.md` §2): annotation dictionaries, the flattening path, and the
// reader both branches are verified against.
export {
  ANNOTATION_PRINT_FLAG,
  ANNOTATION_SUBTYPES,
  type AnnotationMark,
  type AnnotationPage,
  type AnnotationState,
  type MarkupMark,
  type NoteMark,
  FLATTEN_ALPHA,
  flattenAnnotations,
  pdfDate,
  quadPointsFor,
  readAnnotations,
  writeAnnotations,
} from './annotations';

// Redaction (`docs/13-EDIT-AND-ANNOTATE.md`): the region planning, the single PyMuPDF rewrite that scrubs, marks,
// applies and strips, and the two read-backs (poppler limited to each rectangle, plus a raw-and-inflated byte search
// that decodes the file's hex strings too) that an absence has to be proved with.
export {
  type PlannedRedaction,
  type RedactRect,
  type RedactionApplyOptions,
  type RedactionMetrics,
  type RedactionPlan,
  type RedactionText,
  REDACT_RECTS_PER_PAGE_MAX,
  REDACT_RECT_MAX,
  applyRedactions,
  collectRedactedText,
  planRedactionRegions,
  readRegionText,
  removableTokens,
  searchableBytes,
} from './redaction';

// AcroForm fields (`docs/14-SIGN-AND-FORMS.md`): one walk shared by `extract-fields` and `fill-form`, plus the
// second-engine read-back the fill path is verified with.
export {
  type FillFormFlattenMode,
  type FillResult,
  type FillValue,
  type FilledFormState,
  type FilledFormText,
  type FormField,
  type FormFieldType,
  type FormFieldWidget,
  type FormPresence,
  type FormReadResult,
  fillForm,
  formFieldsToCsv,
  readFilledFormState,
  readFilledText,
  readFormFields,
  readFormPresence,
} from './forms';

// The Python bridge: two transports, because a payload containing a password must not travel on argv.
export { parseJsonLine, runPythonScript, runPythonScriptStdin } from './python';

// What `--empty --pages` cannot carry: the outline tree and the first input's metadata, rebuilt with pikepdf.
export type {
  BookmarkMode,
  DecorateMergedInput,
  DecorateMergedResult,
  MergeSource,
  PageSelection,
  PageSelectionResult,
} from './outlines';
export { decorateMergedDocument, decoratePageSelections } from './outlines';

// Reading a document *before* composing it: where its bookmarks point, and what each page weighs. Out of qpdf's
// JSON, so a tool that reads a destination and a tool that counts pages cannot disagree about either.
export type { BookmarkNode } from './pdf-structure';
export { readOutline, readPageRotations, readPageSizes } from './pdf-structure';

// The stamping helpers are shared for the same reason the overlay pipeline is: two tools decorate pages, and a
// second copy of the font table is how they start disagreeing about what `helvetica` means.
export {
  POSTSCRIPT_FONTS,
  availablePostScriptFonts,
  hexToRgbTriplet,
  resolvePostScriptFont,
} from './fonts';

function bin(kind: keyof typeof config.engines): string {
  const value = config.engines[kind];
  if (!value) throw new JobFailure('ENGINE_UNAVAILABLE', { engine: kind, message: `${kind} path is not configured.` });
  return value;
}

function resolve(kind: keyof typeof config.engines, fallback: string): string {
  return config.engines[kind] ?? fallback;
}

/** One input document and the pages taken from it, in qpdf's `<file> <range>` pair form. */
export interface QpdfPageSource {
  path: string;
  /** A qpdf page range — `1-z`, `1-3`, `1,3,5`. Defaults to every page of that document. */
  range?: string;
}

/**
 * The argument list for assembling a new document out of other documents' pages: the single place that knows this
 * rule, because four handlers got it wrong when they each built the list themselves.
 *
 * qpdf takes exactly **one** `--pages`, followed by every `<file> <range>` pair, terminated by `--`: repeating the
 * option per input is rejected with `qpdf: unrecognized argument --pages (pages options must be terminated with --)`.
 * The obvious reading of "append every file" is the repeated form, and it produced three separate production bugs
 * (`merge`, `office-to-pdf` with multiple inputs, `images-to-pdf`) plus a fourth in `split`'s `mergeOutputs` branch
 * that no test had ever reached.
 *
 * `--empty` is always present: every caller here is *building* a document rather than editing one, which avoids
 * inheriting a broken cross-reference table from any single input.
 */
export function buildQpdfPagesArgs(parts: QpdfPageSource[], outputPath: string): string[] {
  if (parts.length === 0) throw new Error('buildQpdfPagesArgs needs at least one input document');
  const args = ['--empty', '--pages'];
  for (const part of parts) args.push(part.path, part.range ?? '1-z');
  args.push('--', outputPath);
  return args;
}

/** qpdf — structural page operations, encryption, linearisation. */
export function runQpdf(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('qpdf', 'qpdf'), args, { ...opts, engine: 'qpdf' });
}

export function qpdfOrThrow(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return runOrThrow(resolve('qpdf', 'qpdf'), args, { ...opts, engine: 'qpdf' });
}

/**
 * Page count read from the file itself.
 *
 * `--show-npages` is not a failure when it fails (`runQpdf`, not `qpdfOrThrow`): a document whose page count cannot
 * be read is a document the caller has to refuse with its own message, and returning `0` lets it do that instead of
 * surfacing a qpdf error for a file that may be merely unusual. The timeout is clamped because counting pages is
 * microseconds of work and must never be what exhausts a job's budget before the real engine starts.
 */
export async function countPdfPages(path: string, opts: Omit<RunOptions, 'engine'>): Promise<number> {
  const result = await runQpdf(['--show-npages', path], { ...opts, timeoutMs: Math.min(opts.timeoutMs, 30_000) });
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

/** Ghostscript — compression, PDF/A, rasterisation fallback. */
export function runGhostscript(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('ghostscript', 'gs'), args, { ...opts, engine: 'ghostscript' });
}

export function gsOrThrow(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return runOrThrow(resolve('ghostscript', 'gs'), args, { ...opts, engine: 'ghostscript' });
}

/** MuPDF (`mutool`) — rasterising, text and HTML extraction, page inspection. */
export function runMutool(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('mutool', 'mutool'), args, { ...opts, engine: 'mutool' });
}

export function mutoolOrThrow(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return runOrThrow(resolve('mutool', 'mutool'), args, { ...opts, engine: 'mutool' });
}

/** Poppler's pdfinfo/pdftotext, used where they are the better tool than mutool. */
export function runPdfInfo(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run('pdfinfo', args, { ...opts, engine: 'pdfinfo' });
}

export function runPdfToText(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run('pdftotext', args, { ...opts, engine: 'pdftotext' });
}

/**
 * `pdftohtml` — the HTML export. Its two output shapes (`-c` and the default) are what `pdf-to-html`'s `mode`
 * selects between, and it writes each page's images alongside the HTML rather than embedding them.
 */
export function runPdfToHtml(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run('pdftohtml', args, { ...opts, engine: 'pdftohtml' });
}

/** `pdfimages -list` reports the resolution and colour of every embedded image — how OCR measures a scan. */
export function runPdfImages(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run('pdfimages', args, { ...opts, engine: 'pdfimages' });
}

/**
 * `pdffonts` — which fonts a document names and whether their programs are in it.
 *
 * The one reader that can say "this document's fonts are not embedded", which is both the most common reason a PDF/A
 * conversion has anything to do and the reason a validator refuses one. `pdf-to-pdfa` measures before and after
 * instead of asserting that a rewrite happened: a change entry that appears on every document, including one whose
 * fonts were already embedded, is a statement nobody made (`packages/engines/src/pdfa.ts`).
 */
export function runPdfFonts(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run('pdffonts', args, { ...opts, engine: 'pdffonts' });
}

/** ImageMagick 7 (`magick`) — image assembly and format conversion. */
export function runMagick(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('magick', 'magick'), args, { ...opts, engine: 'magick' });
}

export function magickOrThrow(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return runOrThrow(resolve('magick', 'magick'), args, { ...opts, engine: 'magick' });
}

/** LibreOffice headless — office and HTML conversion. Never share a user profile between jobs. */
export function runSoffice(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('soffice', 'soffice'), args, {
    ...opts,
    engine: 'libreoffice',
    timeoutMs: Math.max(opts.timeoutMs, config.worker.libreOfficeTimeoutSeconds * 1000),
  });
}

export function sofficeOrThrow(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return runOrThrow(resolve('soffice', 'soffice'), args, {
    ...opts,
    engine: 'libreoffice',
    timeoutMs: Math.max(opts.timeoutMs, config.worker.libreOfficeTimeoutSeconds * 1000),
  });
}

/** Tesseract and OCRmyPDF — recognition. */
export function runOcrmypdf(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('ocrmypdf', 'ocrmypdf'), args, { ...opts, engine: 'ocrmypdf' });
}

export function ocrmypdfOrThrow(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return runOrThrow(resolve('ocrmypdf', 'ocrmypdf'), args, { ...opts, engine: 'ocrmypdf' });
}

export function runTesseract(args: string[], opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  return run(resolve('tesseract', 'tesseract'), args, { ...opts, engine: 'tesseract' });
}

/**
 * Python bridge (pikepdf, PyMuPDF) — structural edits qpdf's CLI cannot express.
 *
 * The script is passed on stdin (`python3 -`), never as an argument, so no user-controlled value is ever
 * concatenated into a command line. Values reach the script through `--json` on argv, parsed with `json.load`,
 * which keeps shell metacharacters inert.
 */
export function runPython(script: string, jsonPayload: unknown, opts: Omit<RunOptions, 'engine'>): Promise<RunResult> {
  const args = ['-c', script, '--json', JSON.stringify(jsonPayload ?? {})];
  return run(resolve('python', 'python3'), args, { ...opts, engine: 'python' });
}

export function pythonOrThrow(
  script: string,
  jsonPayload: unknown,
  opts: Omit<RunOptions, 'engine'>,
): Promise<RunResult> {
  const args = ['-c', script, '--json', JSON.stringify(jsonPayload ?? {})];
  return runOrThrow(resolve('python', 'python3'), args, { ...opts, engine: 'python' });
}

/**
 * veraPDF — PDF/A conformance validation. Its absence is a configuration error, not a silent pass.
 *
 * **The exit code is the verdict, and there are three of them.** Measured against veraPDF 1.30.2: `0` compliant, `1`
 * non-compliant, and `4` for a file the validator declined to process at all (a path that neither exists nor ends in
 * `.pdf`). Only the first two are statements about the document; reporting the third as "not conformant" would blame
 * the file for a validator that never opened it, so it is a failure of this pipeline step instead.
 *
 * The version is read on every validation rather than hard-coded, because the claim in the job's metrics is "*this*
 * validator passed *this* file" — a number nobody can reproduce is not evidence, and an image upgrade changes it.
 */
export async function verifyPdfa(
  file: string,
  profile: '1b' | '2b' | '3b',
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ version: string; report: string }> {
  const path = config.engines.verapdf;
  if (!path) {
    throw new JobFailure('ENGINE_UNAVAILABLE', {
      engine: 'verapdf',
      message: 'PDF/A validation requires veraPDF, which is not installed in this worker image.',
    });
  }
  const versionRun = await run(path, ['--version'], { ...opts, engine: 'verapdf' });
  const version = /veraPDF\s+([\w.\-]+)/i.exec(versionRun.stdout)?.[1] ?? 'unknown';

  const result = await run(path, ['--format', 'text', '--flavour', profile, file], { ...opts, engine: 'verapdf' });
  const report = `${result.stdout}${result.stderr}`.trim();
  if (result.code === 0) return { version, report };

  if (result.code === 1) {
    // The conversion succeeded and the *claim* did not survive inspection. The file is not delivered: the caller asked
    // for an archival document, and an unvalidated file labelled PDF/A is the failure this tool exists to prevent.
    throw new JobFailure('PDFA_CONFORMANCE_FAILED', {
      engine: 'verapdf',
      exitCode: result.code,
      stderrTail: report,
      message:
        `veraPDF ${version} rejected the converted file as PDF/A-${profile}. ${report.split('\n').slice(0, 3).join(' ')}`.trim(),
    });
  }

  throw new JobFailure('CONVERSION_FAILED', {
    engine: 'verapdf',
    exitCode: result.code,
    stderrTail: report,
    message: `veraPDF ${version} could not process the converted file (exit ${result.code}), so nothing was validated.`,
  });
}

/** Engine binaries this pool expects — checked at boot so a broken image fails fast. */
export function engineCheckList(pool: string): Array<{ name: string; path: string }> {
  const light = [
    { name: 'qpdf', path: resolve('qpdf', 'qpdf') },
    { name: 'mutool', path: resolve('mutool', 'mutool') },
    { name: 'magick', path: resolve('magick', 'magick') },
    { name: 'pdfinfo', path: 'pdfinfo' },
  ];
  const office = [{ name: 'libreoffice', path: resolve('soffice', 'soffice') }];
  const heavy = [
    { name: 'ghostscript', path: resolve('ghostscript', 'gs') },
    { name: 'mutool', path: resolve('mutool', 'mutool') },
    { name: 'pdftohtml', path: 'pdftohtml' },
    // Expected because `pdf-to-pdfa` reads them: `pdffonts` and `pdfimages` are how the handler says what the document
    // contained before and after the rewrite, rather than reporting a fixed list of "changes" for every input. An
    // image without them would produce a job whose `changes` are guesses, and the boot check is where that becomes a
    // container that never becomes healthy.
    { name: 'pdffonts', path: 'pdffonts' },
    { name: 'pdfimages', path: 'pdfimages' },
    // Expected *because validation was asked for*, not unconditionally: a deployment that runs with `PDFA_VALIDATE`
    // false has no reason to carry the validator, and one that asks for conformance checks must not discover at job
    // time that the image cannot perform them. The boot check is where that becomes a startup failure instead — with
    // the configured path when there is one, and with a `PATH` lookup otherwise, so "validate, but I told you no
    // validator" is a container that never becomes healthy rather than a job that lies in its metrics.
    ...(config.pdfaValidate
      ? [{ name: 'verapdf', path: config.engines.verapdf ?? resolve('verapdf', 'verapdf') }]
      : []),
  ];
  const ocr = [
    { name: 'ocrmypdf', path: resolve('ocrmypdf', 'ocrmypdf') },
    { name: 'tesseract', path: resolve('tesseract', 'tesseract') },
    { name: 'ghostscript', path: resolve('ghostscript', 'gs') },
    { name: 'pdfimages', path: 'pdfimages' },
  ];
  return { light, office, heavy, ocr }[pool] ?? [];
}

export { bin };
