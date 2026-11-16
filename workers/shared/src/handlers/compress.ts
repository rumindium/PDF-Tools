import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompressOptions } from '@pdftools/contracts/tools';
import {
  gsOrThrow,
  qpdfOrThrow,
  readFormPresence,
  readSignatureRecord,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `compress` — `docs/04-COMPRESS.md`.
 *
 * Ghostscript re-encodes images and subsets fonts, which is where almost all of a PDF's weight lives. Three
 * behaviours are deliberate:
 *
 *  1. **The output is never larger than the input.** If a pass produced a bigger file, the original bytes are
 *     returned with a `NO_SAVINGS` warning. Handing back a "compressed" file that grew is the failure mode users
 *     report as a bug in the tool, and it is avoidable.
 *  2. **`targetSizeMb` walks a bounded ladder, and the ladder is the documented one.** Four rungs, best quality
 *     first — (300 dpi, 85), (200, 80), (120, 60), (96, 40) — and the first rung that fits the target ends the
 *     search, because every later rung is worse. The last rung *is* the quality floor `docs/04-COMPRESS.md` §3
 *     describes, so "the smallest result this document allows" is a rung this handler actually ran rather than an
 *     extrapolation. If even the floor misses, the job succeeds with `TARGET_SIZE_UNREACHED` and the achieved size:
 *     spending two minutes getting from 4.9 MB to 4.8 MB is worse than saying "4.9 MB is what this document can
 *     be". Before pass 5 the ladder was two presets and the doc promised four runs of a six-rung ladder that did not
 *     exist — the case that would have caught it (`targetSizeMb` had none) now exists in both directions.
 *  3. **Metadata stripping is capability-probed.** Older qpdf versions lack `--remove-metadata`; rather than
 *     assuming a flag exists, the rewrite is attempted and the job records `METADATA_KEPT` if the build cannot do
 *     it. Claiming a privacy property that was not applied is the one outcome that must never happen.
 *  4. **What the rewrite takes away is said out loud.** Ghostscript's `pdfwrite` cannot carry an interactive form:
 *     measured on `form-five-fields-a4.pdf`, the six widgets *and* the `/AcroForm` dictionary are gone from the
 *     output while a `/Highlight` on the same page stays — so a filled contract comes back with nothing to type in.
 *     `04-COMPRESS.md` §6 promised the opposite ("annotations and forms preserved, `-dPreserveAnnots=true`"), no
 *     case covered it, and the job was silent about the loss (defect 144). The input is now counted before the first
 *     pass and the rewrite reports `FORM_FIELDS_DROPPED` — the same resolution `n-up` already took for the same
 *     reason.
 */

interface Pass {
  setting: string | null;
  dpi: number;
  quality: number;
}

const PRESETS: Record<'extreme' | 'recommended' | 'light', Pass> = {
  extreme: { setting: '/screen', dpi: 96, quality: 40 },
  recommended: { setting: '/ebook', dpi: 150, quality: 65 },
  light: { setting: '/printer', dpi: 220, quality: 85 },
};

const MAX_PASSES = 4;

/**
 * The target-size ladder, best quality first — the six-rung ladder of `docs/04-COMPRESS.md` §4 compressed to the four
 * runs that document caps a job at, with its stated floor (96 dpi / quality 40) as the last rung.
 *
 * Each rung is a *custom* pass (`setting: null`), not one of `PRESETS`: a `-dPDFSETTINGS=` preset overrides the
 * per-image DPI and the JPEG quality on the same command line, so a ladder built from presets can only ever have as
 * many distinct rungs as there are presets — which is exactly why the old two-preset ladder could not search, and why
 * the numbers in §4 of the document (200/80, 120/60) had nowhere to live.
 */
const LADDER: Pass[] = [
  { setting: null, dpi: 300, quality: 85 },
  { setting: null, dpi: 200, quality: 80 },
  { setting: null, dpi: 120, quality: 60 },
  { setting: null, dpi: 96, quality: 40 },
];

export const compress: Handler<CompressOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;
  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  // Read before any pass. Every pass rewrites the file, which breaks a `/ByteRange` — but this handler has a branch
  // that returns the **input unchanged** (below), and a byte-identical copy still verifies, so the warning is gated on
  // which branch actually ran rather than on the tool being `compress`.
  const signature = await readSignatureRecord(input, runOpts);
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  // Read here rather than after the passes: the question is what the *input* had, and by the end there is nothing
  // left to count. A probe that cannot read the file does not fail the job — the passes below report their own
  // failure with a better message — it only means the sentence about the form is not owed.
  const form = await readFormPresence(input, runOpts).catch(() => null);

  const inputBytes = (await stat(input)).size;
  const targetBytes = options.targetSizeMb != null ? Math.round(options.targetSizeMb * 1024 * 1024) : null;

  const warnings: Array<{ code: string; detail?: string }> = [];
  const passes = buildPasses(options);
  const changes: Array<Record<string, unknown>> = [];

  report({ progress: 10, phase: 'processing', message: 'Re-encoding images.' });

  let best = { path: input, bytes: inputBytes, pass: 0 };
  // Ghostscript runs actually spent. Reported because it is the number `docs/04-COMPRESS.md` §4 caps ("never more than
  // four") and the only way a case can tell a ladder that stopped at its floor from one that ran out of rungs.
  let attempts = 0;
  for (const [index, pass] of passes.entries()) {
    report({
      progress: 12 + Math.round((index / passes.length) * 60),
      phase: 'processing',
      message:
        targetBytes != null
          ? `Pass ${index + 1}: aiming for ${formatMb(targetBytes)}.`
          : `Pass ${index + 1} of ${passes.length}.`,
    });

    // Each pass reads the *previous* pass's output, so a second pass builds on the first instead of starting over.
    const source = best.path;
    const target = join(workDir, `pass-${index + 1}.pdf`);
    attempts += 1;
    await gsOrThrow(ghostscriptArgs(source, target, pass), runOpts);

    const bytes = (await stat(target)).size;
    changes.push({ pass: index + 1, setting: pass.setting ?? 'custom', dpi: pass.dpi, bytes });
    if (bytes < best.bytes) best = { path: target, bytes, pass: index + 1 };

    if (targetBytes != null && best.bytes <= targetBytes) break;
    // Without a target there is nothing to iterate for: the chosen preset is the answer.
    if (targetBytes == null) break;
  }

  // ── Metadata ───────────────────────────────────────────────────────────────
  let current = best.path;
  if (options.stripMetadata) {
    const stripped = join(workDir, 'stripped.pdf');
    const result = await qpdfOrThrow(['--remove-metadata', '--', current, stripped], runOpts).catch(() => null);
    if (result) {
      current = stripped;
      changes.push({ kind: 'METADATA_STRIPPED' });
    } else {
      // Not every qpdf build ships the flag. Reporting it is required; silently implying privacy is not.
      warnings.push({
        code: 'METADATA_KEPT',
        detail: 'Document metadata could not be removed by this qpdf build; it is preserved in the output.',
      });
    }
  }

  // ── Linearisation ──────────────────────────────────────────────────────────
  if (options.linearize) {
    const linearized = join(workDir, 'linearized.pdf');
    const result = await qpdfOrThrow(['--linearize', '--', current, linearized], runOpts).catch(() => null);
    if (result) {
      current = linearized;
      changes.push({ kind: 'LINEARIZED' });
    } else {
      warnings.push({
        code: 'NOT_LINEARIZED',
        detail: 'The document could not be linearised; it will still open, but not progressively.',
      });
    }
  }

  const finalBytes = (await stat(current)).size;
  const outputPath = join(outputDir, 'compressed.pdf');

  // ── The "never bigger" rule ────────────────────────────────────────────────
  if (finalBytes >= inputBytes) {
    await Bun.write(outputPath, Bun.file(input));
    warnings.push({
      code: 'NO_SAVINGS',
      detail: 'This document is already as small as its content allows; the original file is returned unchanged.',
    });
    // A target that this document's own size already misses is still a target that was not met, and the caller has to
    // be told in the same vocabulary as the branch below: "the result is the closest achievable" is the sentence the UI
    // renders, and it is true here for a reason of its own — there was nothing to save, let alone to shrink.
    const targetReached = targetBytes == null || inputBytes <= targetBytes;
    if (!targetReached) {
      warnings.push({
        code: 'TARGET_SIZE_UNREACHED',
        detail: `This document is already as small as its content allows (${formatMb(inputBytes)}); the requested target of ${formatMb(targetBytes!)} was not reached.`,
      });
    }
    report({ progress: 92, phase: 'finalizing' });
    return {
      outputs: [{ name: 'compressed.pdf', mime: 'application/pdf', primary: true }],
      metrics: {
        inputBytes,
        outputBytes: inputBytes,
        savedBytes: 0,
        passes: best.pass,
        rungs: passes.length,
        attempts,
        targetSizeMb: options.targetSizeMb ?? null,
        targetReached,
        changes,
        // The input is returned byte-for-byte, so a signature in it is **not** invalidated and the warning is absent.
        rewritten: false,
        signatureObjects: signature.signatureObjects,
        signatureValues: signature.signatureValues,
        // ...and byte-for-byte means the form is still there too, which is why no `FORM_FIELDS_DROPPED` is owed and
        // why this branch reports the count at all: the pair of numbers is what makes the other branch's `true` mean
        // something rather than being a property of the tool.
        formFields: form?.widgets ?? null,
        acroFormDropped: false,
      },
      warnings,
      engine: { name: 'ghostscript' },
    };
  }

  await Bun.write(outputPath, Bun.file(current));
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }

  // A form cannot survive this rewrite, so the job says which one it was rather than handing back a document that
  // looks the same and accepts nothing. Gated on the *input* having one, which is why the pair of `acroFormDropped`
  // values matters: `true` on a form and `false` on its formless twin is a statement about the file, not the tool.
  const formDropped = form != null && (form.widgets > 0 || form.acroForm);
  if (formDropped) {
    warnings.push({
      code: 'FORM_FIELDS_DROPPED',
      detail: `This document carries an interactive form (${form.widgets} field widget(s)); Ghostscript's rewrite cannot keep it, so the output has no fields to fill. Flatten or fill the form first if the boxes have to stay.`,
    });
  }

  if (targetBytes != null && finalBytes > targetBytes) {
    warnings.push({
      code: 'TARGET_SIZE_UNREACHED',
      detail: `The smallest result this document allows is ${formatMb(finalBytes)}; the requested target of ${formatMb(targetBytes)} was not reached.`,
    });
  }

  report({ progress: 92, phase: 'finalizing' });

  return {
    outputs: [{ name: 'compressed.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      inputBytes,
      outputBytes: finalBytes,
      savedBytes: inputBytes - finalBytes,
      savedPercent: Math.round(((inputBytes - finalBytes) / inputBytes) * 1000) / 10,
      passes: best.pass,
      rungs: passes.length,
      attempts,
      targetSizeMb: options.targetSizeMb ?? null,
      targetReached: targetBytes == null || finalBytes <= targetBytes,
      preset: options.preset,
      changes,
      // Asserted the other way round from the branch above: this output is a rewrite, so a signature in the input no
      // longer verifies and the warning above is present.
      rewritten: true,
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
      formFields: form?.widgets ?? null,
      acroFormDropped: formDropped,
    },
    warnings,
    engine: { name: 'ghostscript' },
  };
};

/** Which passes to run, in order. */
function buildPasses(options: CompressOptions): Pass[] {
  // A target size is the one mode that iterates, and it does not consult `preset` except for `custom`. The reason is
  // in the metrics rather than in the options: the caller asked for a *size*, and a preset is a (dpi, quality) pair,
  // so honouring `preset: 'light'` here would mean either refusing the target or walking a ladder whose first rung
  // is not the best quality available. `custom` is the exception because its numbers are the caller's own intent —
  // they become the first rung, and the rest of the ladder is the rungs *cheaper* than it.
  if (options.targetSizeMb != null) {
    if (options.preset !== 'custom') return LADDER.slice(0, MAX_PASSES);
    const own: Pass = { setting: null, dpi: options.dpi, quality: options.imageQuality };
    return [own, ...LADDER.filter((rung) => rung.quality < own.quality)].slice(0, MAX_PASSES);
  }

  if (options.preset === 'custom') {
    return [{ setting: null, dpi: options.dpi, quality: options.imageQuality }];
  }

  const ladder: Array<'light' | 'recommended' | 'extreme'> =
    options.preset === 'extreme' ? ['extreme'] : options.preset === 'light' ? ['light'] : ['recommended'];

  return ladder.slice(0, MAX_PASSES).map((name) => PRESETS[name]);
}

function ghostscriptArgs(source: string, target: string, pass: Pass): string[] {
  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-dSAFER',
    '-dAutoRotatePages=/None',
    // Fonts are subset by default; making it explicit stops a future gs default change from silently inflating
    // every compressed document.
    '-dSubsetFonts=true',
    '-dEmbedAllFonts=true',
    '-dDownsampleColorImages=true',
    `-dColorImageResolution=${pass.dpi}`,
    '-dDownsampleGrayImages=true',
    `-dGrayImageResolution=${pass.dpi}`,
    '-dDownsampleMonoImages=true',
    `-dMonoImageResolution=${Math.max(pass.dpi, 300)}`,
    '-dColorImageDownsampleType=/Bicubic',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dMonoImageDownsampleType=/Subsample',
  ];

  if (pass.setting) {
    args.push(`-dPDFSETTINGS=${pass.setting}`);
  } else {
    args.push('-dColorImageFilter=/DCTEncode', '-dGrayImageFilter=/DCTEncode', `-dJPEGQ=${pass.quality}`);
  }

  args.push(`-sOutputFile=${target}`, source);
  return args;
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
