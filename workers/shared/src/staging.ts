import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { JobFailure } from '@pdftools/errors';
import type { JobFilePayload } from '@pdftools/queue';

/**
 * Claim step (`docs/0-QUEUE-AND-JOBS.md` §3).
 *
 * The API already copied each upload into the job's input directory, so staging here is about *verification*:
 * the bytes must be where the payload says, the size must match, and the checksum must match. A mismatch means
 * something outside this job changed the files — failing loudly is the only safe response, because a truncated
 * PDF merges into a silently corrupt output.
 */

export interface StagedFile extends JobFilePayload {
  path: string;
}

export async function prepareJobDirs(
  jobDir: string,
): Promise<{ inputDir: string; workDir: string; outputDir: string }> {
  const inputDir = join(jobDir, 'input');
  const workDir = join(jobDir, 'work');
  const outputDir = join(jobDir, 'output');
  for (const dir of [inputDir, workDir, outputDir, join(jobDir, 'tmp'), join(jobDir, 'home')]) {
    await mkdir(dir, { recursive: true });
  }
  return { inputDir, workDir, outputDir };
}

export async function verifyInputs(files: JobFilePayload[]): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];

  for (const file of files) {
    const path = file.storedPath;
    if (!path) {
      throw new JobFailure('INVALID_FILE', { message: 'The job payload has no stored path for an input.' });
    }

    const info = await stat(path).catch(() => null);
    if (!info) {
      throw new JobFailure('INVALID_FILE', { message: 'An input file is missing on disk.' });
    }
    if (info.size !== file.sizeBytes) {
      throw new JobFailure('INVALID_FILE', {
        message: 'An input file changed size after upload.',
        stderrTail: `expected ${file.sizeBytes} bytes, found ${info.size}`,
      });
    }

    const checksum = await sha256File(path);
    if (checksum !== file.checksumSha256) {
      throw new JobFailure('INVALID_FILE', {
        message: 'An input file failed its integrity check.',
        stderrTail: `expected ${file.checksumSha256}, got ${checksum}`,
      });
    }

    staged.push({ ...file, path });
  }

  return staged;
}

/**
 * Streaming SHA-256 over a file.
 *
 * A read stream rather than reading the whole file: a 1 GB Business upload must be verified without a 1 GB
 * allocation, and the checksum is the only thing standing between a truncated upload and a silently corrupt
 * merged document.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Handlers are given a stable, engine-friendly file name (`001__name.pdf`).
 *
 * Two reasons: engines are far more predictable with simple ASCII names, and the numeric prefix means the
 * argument order visibly matches the user's order — which matters when a merge comes out backwards.
 */
export function engineName(index: number, originalName: string, ext: string): string {
  const stem =
    basename(originalName, ext)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 60) || 'file';
  return `${String(index + 1).padStart(3, '0')}__${stem}${ext}`;
}

export async function placeForEngine(file: StagedFile, index: number, workInputDir: string): Promise<string> {
  const ext = file.path.includes('.') ? `.${file.path.split('.').pop()}` : '';
  const target = join(workInputDir, engineName(index, file.name, ext));
  await mkdir(dirname(target), { recursive: true });

  // Copied, never renamed. Two reasons, and the second is the one that bites:
  //
  //   1. `mogrify`-style engines edit their argument in place, so handing them the canonical input would let a
  //      handler rewrite the user's upload;
  //   2. `verifyInputs` looks for every input at the path the payload named. `rename` moved the file out from
  //      under that path, so the *retry* of any failed job died with "An input file is missing on disk" — the
  //      first attempt's error became an unrelated second failure, and the real cause was buried.
  await copyFile(file.path, target);
  return target;
}
