import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PdfToTextOptions } from '@pdftools/contracts/tools';
import { countPdfPages, runPdfToText } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, pageBounds } from '@pdftools/worker-shared';

/**
 * `pdf-to-text` — `docs/04-CONVERT.md`.
 *
 * The whole tool is one engine call, so the interesting part is what the handler does *around* it:
 *
 *  1. **A scanned document produces an empty file, and that is reported, not shipped.** `pdftotext` exits 0 on a
 *     clear scan and writes nothing, so "0 characters" is the signal. Returning a zero-byte `.txt` as success is the
 *     failure mode this tool has to avoid — a user who asked for the text of an invoice must be told the file has no
 *     text layer, not handed an empty file that looks like an answer.
 *  2. **`ocrFallback` is honest about what this pool can do.** Tesseract and OCRmyPDF live in the *ocr* image, not
 *     this one. Rather than silently ignoring the flag or inventing a second OCR path here, the handler resolves the
 *     flag to a `NO_TEXT_LAYER` failure that names `ocr` as the tool that will work — a second round trip, but one
 *     the caller can act on.
 *  3. **`layout: 'preserve'` is `-layout`,** which keeps the columns of a table together; `plain` is the reading
 *     order a screen reader would take. Both are pdftotext modes, so neither is approximated here.
 */

/** Below this many characters the extraction found no text layer rather than little text. */
const NO_TEXT_THRESHOLD = 1;

export const pdfToText: Handler<PdfToTextOptions> = async (ctx) => {
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
  report({ progress: 20, phase: 'processing', message: 'Reading the text layer.' });

  // `-f`/`-l` are first/last page, so a selection is resolved to its bounds rather than passed page by page: a
  // non-contiguous selection still has to be one engine call, and the extracted text is labelled with the pages it
  // came from so a reader can tell which part of the document they are looking at.
  const bounds = pageBounds(options.pages, pages);
  const args = [
    ...(options.layout === 'preserve' ? ['-layout'] : []),
    ...(bounds ? ['-f', String(bounds.first), '-l', String(bounds.last)] : []),
    // No `-nopgbrk`: pdftotext's own form feeds are the page breaks the tool's summary promises, and a consumer
    // that wants one page per section relies on them.
    document.path,
    join(outputDir, 'text.txt'),
  ];

  const result = await runPdfToText(args, runOpts);
  // pdftotext reports a damaged document on stderr and still exits 0 when it recovered; a lexer failure is worth
  // surfacing but is not fatal, because a partial extraction of a 300-page document is usually still useful.
  const text = await readFile(join(outputDir, 'text.txt'), 'utf8').catch(() => null);
  if (text == null) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The text extraction produced no output file.',
      stderrTail: result.stderr,
    });
  }

  const characters = text.length;
  if (characters <= NO_TEXT_THRESHOLD) {
    if (options.ocrFallback) {
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message:
          'This document has no text layer, and the OCR fallback needs the OCR worker — run it through the `ocr` tool first, then extract the text from the result.',
        stderrTail: result.stderr,
      });
    }
    throw new JobFailure('UNSUPPORTED_CONTENT', {
      message:
        'This document has no text layer, so there is nothing to extract. It is probably a scan — run it through the `ocr` tool, or enable the OCR fallback.',
      stderrTail: result.stderr,
    });
  }

  const warnings: Array<{ code: string; detail?: string }> = [];
  if (/Error|Syntax Warning/i.test(result.stderr)) {
    warnings.push({
      code: 'TEXT_EXTRACTION_INCOMPLETE',
      detail: 'The reader reported damage in the document; some text may be missing from the output.',
    });
  }

  report({ progress: 95, phase: 'finalizing' });
  return {
    outputs: [{ name: 'text.txt', mime: 'text/plain', primary: true }],
    metrics: {
      pages,
      pagesExtracted: bounds ? bounds.last - bounds.first + 1 : pages,
      characters,
      // Words, not characters: it is what a user checks against their own count, and it is cheap here because the
      // text is already in memory.
      words: text.split(/\s+/).filter((token) => token.length > 0).length,
      layout: options.layout,
      hasTextLayer: true,
      bytes: (await stat(join(outputDir, 'text.txt'))).size,
    },
    warnings,
    engine: { name: 'pdftotext' },
  };
};
