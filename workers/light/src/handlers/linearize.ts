import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { LinearizeOptions } from '@pdftools/contracts/tools';
import {
  countPdfPages,
  qpdfOrThrow,
  readSignatureRecord,
  runQpdf,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `linearize` — `docs/05-OPTIMIZE-COMPRESS.md`.
 *
 * Linearization ("fast web view") moves the objects a reader needs for *page one* to the front of the file and adds
 * a hint table that says where the rest live, so a browser can paint the first page before the download finishes.
 * It is a restructure of the existing objects, not a re-render: nothing is rasterised and no text is re-encoded.
 *
 * Two things this handler does that a bare `qpdf --linearize` would not:
 *
 *  1. **It verifies the result rather than trusting the exit code.** `qpdf --linearize` succeeds on documents it
 *     silently declines to linearize (an encrypted input, an object layout it cannot hint), so the output is read
 *     back and the `/Linearized` dictionary checked for. A tool called "linearize" that returns a linear-looking
 *     file is the exact failure a user cannot detect.
 *  2. **It reports the page count before and after.** Linearization rebuilds the page tree, and a page tree is the
 *     one structure whose damage is invisible until someone scrolls.
 */

/** `qpdf --linearize` refuses encrypted input; the message is more useful than qpdf's own. */
export const linearize: Handler<LinearizeOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to linearize.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);

  // Restructuring is a rewrite even though not a byte of content changes: linearization moves objects, so the bytes a
  // signature's `/ByteRange` covers are rearranged and the signature stops verifying.
  const signature = await readSignatureRecord(document.path, runOpts);
  const invalidatedSignature = signatureInvalidatedWarning(signature);

  report({ progress: 25, phase: 'processing', message: 'Restructuring the document.' });

  const outputPath = join(outputDir, 'linearized.pdf');
  // `--optimize-images` is a second pass with the same tool (it re-encodes image streams as JPEG/Flate); the
  // linearization itself is the `--linearize` flag.
  const args = [
    '--linearize',
    ...(options.optimizeImages ? ['--optimize-images'] : []),
    '--',
    document.path,
    outputPath,
  ];
  const result = await qpdfOrThrow(args, runOpts);

  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Linearizing changed the page count: ${pages} in, ${outputPages} out.`,
      stderrTail: result.stderr,
    });
  }

  report({ progress: 80, phase: 'processing', message: 'Checking the linearization hint table.' });
  // Two checks, because they catch different failures. `--show-linearization` is qpdf's own reader walking the hint
  // table: if it cannot, the file is not usable for progressive download no matter what bytes are in it. The head
  // read is the structural half — a linearized file's first object *is* the hint dictionary, so the marker being in
  // the first 2 KB is what makes the difference between "linearized" and "rebuilt with a stale dictionary at the
  // end", which `--show-linearization` alone would report as fine on some inputs.
  const check = await runQpdf(['--show-linearization', outputPath], {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 60_000),
  });
  const head = await readHead(outputPath, 2048);
  const linearized =
    check.code === 0 && !/not linearized/i.test(check.stdout + check.stderr) && head.includes('/Linearized');
  if (!linearized) {
    throw new JobFailure('CONVERSION_FAILED', {
      message:
        'The document was rebuilt but not linearized — qpdf accepted the job and produced a file without a /Linearized dictionary, which some inputs (encrypted, or already linear) cause.',
      stderrTail: result.stderr,
    });
  }

  report({ progress: 95, phase: 'finalizing' });
  return {
    outputs: [{ name: 'linearized.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      optimizeImages: options.optimizeImages,
      qpdfWarnings: countWarnings(result.stderr),
      linearized: true,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings: invalidatedSignature ? [invalidatedSignature] : [],
    engine: { name: 'qpdf' },
  };
};

/** The first `byteCount` bytes, as latin1 — the hint dictionary is ASCII, and this never throws on a PDF's binary
 * comment line the way a UTF-8 decode would. */
async function readHead(path: string, byteCount: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await handle.close();
  }
}

/**
 * qpdf's exit code is 3 for "completed with warnings", which `qpdfOrThrow` accepts — the count is what the job
 * report shows instead of a stderr blob nobody reads.
 */
function countWarnings(stderr: string): number {
  return stderr.split('\n').filter((line) => line.startsWith('WARNING:')).length;
}
