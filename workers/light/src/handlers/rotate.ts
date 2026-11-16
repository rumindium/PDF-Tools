import { join } from 'node:path';
import type { RotateOptions } from '@pdftools/contracts/tools';
import { countPdfPages, qpdfOrThrow, readSignatureRecord, signatureInvalidatedWarning } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';
import { expandRanges } from '@pdftools/worker-shared';

/**
 * `rotate` — `docs/03-ORGANIZE-ROTATE-CROP.md`.
 *
 * Rotation is written as a page-attribute change (`/Rotate`), never as re-rendered pixels: the document stays
 * vector, the file size does not change, and text selection keeps working. This is the difference between a
 * rotation tool and a "re-save the PDF as images" tool, and it is why qpdf is the right engine.
 */

export const rotate: Handler<RotateOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;
  report({ progress: 15, phase: 'processing' });

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  // Before the rewrite, like every other tool that hands back the same document modified: a signature's `/ByteRange`
  // covers the file's bytes, and `/Rotate` is a write to the page tree those bytes hold.
  const signature = await readSignatureRecord(input, runOpts);

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }

  // `perPage` maps a page to its own angle; it takes precedence over the single `angle` when both are present,
  // because a user who drew eight different rotations means it.
  const perPage = options.perPage ?? {};
  // Counted before the selection is expanded, because `4-z`, `even` and `odd` cannot be resolved without the count
  // (`docs/02-SPLIT-AND-EXTRACT.md` §2). One `qpdf --show-npages` per job, only when pages were named at all.
  const targets = options.pages ? expandRanges(options.pages, await countPdfPages(input, runOpts)) : null;

  if (Object.keys(perPage).length > 0) {
    // qpdf can only apply one rotation to a page set per invocation, so group pages by angle. Five distinct
    // angles means five passes over the same file — still fast, and it keeps the semantics honest.
    const groups = new Map<number, number[]>();
    for (const [pageRaw, angle] of Object.entries(perPage)) {
      const page = Number.parseInt(pageRaw, 10);
      if (!Number.isFinite(page) || page < 1) {
        throw new JobFailure('VALIDATION_ERROR', { message: `"${pageRaw}" is not a page number.` });
      }
      const list = groups.get(angle) ?? [];
      list.push(page);
      groups.set(angle, list);
    }

    let current = input;
    let pass = 0;
    for (const [angle, pages] of [...groups.entries()].sort((a, b) => a[1][0]! - b[1][0]!)) {
      pass += 1;
      const target = pass === groups.size ? join(outputDir, 'rotated.pdf') : join(workDir, `pass-${pass}.pdf`);
      // `--rotate=` in one token, not `--rotate` then a value: qpdf rejects the split form outright ("--rotate must
      // be given as --rotate=[+|-]angle"), and because the handler used to ignore qpdf's exit code that surfaced as
      // a vaguer "produced no usable output". Rotation never worked.
      await qpdfOrThrow([`--rotate=+${angle}:${pages.join(',')}`, '--', current, target], runOpts);
      current = target;
      report({ progress: 15 + Math.round((pass / groups.size) * 65), phase: 'processing' });
    }
    if (options.pages) {
      warnings.push({
        code: 'PAGES_IGNORED',
        detail: 'A per-page rotation map was provided, so the page selection was not used.',
      });
    }
  } else {
    const selector = targets ? `:${targets.join(',')}` : '';
    await qpdfOrThrow([`--rotate=+${options.angle}${selector}`, '--', input, join(outputDir, 'rotated.pdf')], runOpts);
  }

  report({ progress: 90, phase: 'finalizing' });

  return {
    outputs: [{ name: 'rotated.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      angle: Object.keys(perPage).length > 0 ? 'per-page' : options.angle,
      pages: targets ? targets.length : 'all',
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: 'qpdf' },
  };
};
