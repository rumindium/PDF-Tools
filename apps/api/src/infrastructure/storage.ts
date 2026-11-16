import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import { AppError } from '@pdftools/errors';

/**
 * The only module in `apps/api` allowed to know about `TEMP_DIR` (`0-FOLDER-STRUCTURE.md` §2).
 *
 * Layout (per `docs/0-FILE-STORAGE.md`):
 *
 *   ${TEMP_DIR}/staging/<uploadId>          uploaded bytes, waiting to be claimed by a job
 *   ${TEMP_DIR}/<jobId>/input/              claimed inputs (a copy, so one purge cannot break another job)
 *   ${TEMP_DIR}/<jobId>/work/               engine scratch space
 *   ${TEMP_DIR}/<jobId>/output/             results, served until the TTL expires
 *
 * Every path that reaches the filesystem goes through `jobDir`/`stagingPath`, so a job id is always validated as
 * a UUID before it becomes part of a path.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertId(id: string): string {
  if (!UUID_RE.test(id)) throw new AppError('JOB_NOT_FOUND', 'That job does not exist.');
  return id;
}

export function stagingPath(uploadId: string): string {
  return join(config.storage.stagingDir, assertId(uploadId));
}

export function jobDir(jobId: string): string {
  return join(config.storage.tempDir, assertId(jobId));
}

export function jobInputDir(jobId: string): string {
  return join(jobDir(jobId), 'input');
}

export function jobOutputDir(jobId: string): string {
  return join(jobDir(jobId), 'output');
}

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

export async function ensureBaseDirs(): Promise<void> {
  await ensureDir(config.storage.tempDir);
  await ensureDir(config.storage.stagingDir);
}

/** Remove a directory, ignoring the case where it is already gone. */
export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 2 });
}

export async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function freeBytes(): Promise<number | null> {
  try {
    const info = await statfs(config.storage.tempDir);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

/** Job directories on disk, with their modification times — the sweeper's input for orphan detection. */
export async function listJobDirs(): Promise<Array<{ id: string; mtimeMs: number }>> {
  const out: Array<{ id: string; mtimeMs: number }> = [];
  const entries = await readdir(config.storage.tempDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const info = await stat(join(config.storage.tempDir, entry.name)).catch(() => null);
    if (info) out.push({ id: entry.name, mtimeMs: info.mtimeMs });
  }
  return out;
}

/** Staged uploads on disk, keyed by upload id. */
export async function listStagingFiles(): Promise<Array<{ id: string; mtimeMs: number }>> {
  const out: Array<{ id: string; mtimeMs: number }> = [];
  const entries = await readdir(config.storage.stagingDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !UUID_RE.test(entry.name)) continue;
    const info = await stat(join(config.storage.stagingDir, entry.name)).catch(() => null);
    if (info) out.push({ id: entry.name, mtimeMs: info.mtimeMs });
  }
  return out;
}
