import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import { runOrThrow } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { OutputDescriptor } from './context';

/**
 * Output discovery and packing.
 *
 * A handler declares what it produced; this module checks the declaration against reality. Trusting the
 * declaration would mean a job that reports success while the file is missing or zero bytes — the kind of bug
 * that reaches production, because the API happily serves a 0-byte download and the user reports "the merged PDF
 * is broken" three days later.
 */

export interface VerifiedOutput extends OutputDescriptor {
  bytes: number;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export async function verifyOutputs(outputDir: string, outputs: OutputDescriptor[]): Promise<VerifiedOutput[]> {
  if (outputs.length === 0) {
    throw new JobFailure('CONVERSION_FAILED', { message: 'The tool produced no output.' });
  }

  const verified: VerifiedOutput[] = [];
  for (const output of outputs) {
    if (!SAFE_NAME.test(output.name) || output.name.startsWith('.')) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: 'The tool produced an output with an unsafe name.',
        stderrTail: `rejected: ${output.name}`,
      });
    }
    const info = await stat(join(outputDir, output.name)).catch(() => null);
    if (!info || info.size === 0) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: 'The tool reported success but produced no usable output.',
        stderrTail: `missing or empty: ${output.name}`,
      });
    }
    verified.push({ ...output, bytes: info.size });
  }

  const primaryCount = verified.filter((v) => v.primary).length;
  if (primaryCount === 0) verified[0]!.primary = true;
  if (primaryCount > 1) {
    // Ambiguity would make `GET /download` non-deterministic between runs; keep the first and be explicit.
    let seen = false;
    for (const output of verified) {
      if (output.primary) {
        if (seen) output.primary = undefined;
        seen = true;
      }
    }
  }

  return verified;
}

/**
 * Pack multiple outputs into one archive.
 *
 * Stored, not deflated: the parts are JPEG/PNG/PDF, which are already compressed. Deflating them again costs CPU
 * for roughly 1 % and makes the archive slower to open.
 */
export async function packArchive(
  outputDir: string,
  parts: VerifiedOutput[],
  archiveName = 'parts.zip',
): Promise<string> {
  if (parts.length === 0) throw new JobFailure('CONVERSION_FAILED', { message: 'Nothing to archive.' });

  const archivePath = join(outputDir, archiveName);

  // `zip` streams, so a 2 GB archive never has to exist in memory. It goes through the engine wrapper like every
  // other process, which means it inherits the timeout, the kill escalation, and the log caps.
  await runOrThrow('zip', ['-j', '-0', '-q', archivePath, ...parts.map((p) => join(outputDir, p.name))], {
    cwd: outputDir,
    timeoutMs: 120_000,
    engine: 'zip',
  });
  return archivePath;
}

export async function totalBytes(outputDir: string, outputs: VerifiedOutput[]): Promise<number> {
  let total = 0;
  for (const output of outputs) {
    const info = await stat(join(outputDir, output.name)).catch(() => null);
    if (info) total += info.size;
  }
  return total;
}

/**
 * Guard against a tool that quietly produced 10 000 files.
 *
 * The page limit is the real bound on output count, but a bug in a split handler could still create one file per
 * character. Failing here leaves the job's output directory intact for diagnosis.
 */
export async function assertOutputCount(
  outputs: VerifiedOutput[],
  max = config.limits.maxSplitParts + 50,
): Promise<void> {
  if (outputs.length > max) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The tool produced more parts than this plan allows in one job.',
      stderrTail: `parts: ${outputs.length}, limit: ${max}`,
    });
  }
}
