export type {
  Handler,
  HandlerRegistry,
  HandlerResult,
  JobContext,
  OutputDescriptor,
  ProgressReport,
} from './context';
export { startWorker, type WorkerHandle } from './runtime';
export { prepareJobDirs, verifyInputs, placeForEngine, engineName, sha256File } from './staging';
export { verifyOutputs, packArchive, assertOutputCount, totalBytes, type VerifiedOutput } from './output';
export { expandRanges, pageBounds } from './page-ranges';
export { recordEvent, eventsSince, type JobEventInput, type PersistedJobEvent } from '@pdftools/queue';
export { compress, merge } from './handlers';
export { findMacroCarrier, describeMacroCarrier, type MacroCarrier } from './guards/macro-carriers';
export {
  findRemoteReferencesInHtml,
  findRemoteReferencesInCss,
  describeRemoteReferences,
  type RemoteReference,
} from './guards/remote-references';

import { mkdir, statfs } from 'node:fs/promises';
import { config } from '@pdftools/config';
import { engineCheckList } from '@pdftools/engines';
import { childLogger } from '@pdftools/logger';

/**
 * Boot checks (`docs/0-WORKERS.md` §6).
 *
 * A worker that starts with a missing engine binary would accept jobs and fail every one of them with
 * `ENGINE_UNAVAILABLE` — an outage that looks like a product bug. Failing at boot turns it into an obvious
 * deployment error, and the container restart loop is the correct signal.
 */
export async function preflight(pool: string): Promise<string[]> {
  const log = childLogger({ component: 'preflight', pool });
  const problems: string[] = [];

  for (const engine of engineCheckList(pool)) {
    const binary = engine.path.includes('/') ? engine.path : engine.name;
    try {
      const which = Bun.which(binary);
      if (!which && !engine.path.includes('/')) {
        problems.push(`missing engine: ${engine.name}`);
      }
    } catch {
      problems.push(`missing engine: ${engine.name}`);
    }
  }

  try {
    await mkdir(config.storage.tempDir, { recursive: true });
    const info = await statfs(config.storage.tempDir);
    const freeGb = (info.bavail * info.bsize) / 1024 ** 3;
    if (freeGb < config.storage.workerDiskMinFreeGb) {
      // A worker with no disk headroom must not claim work; it stays alive so the heartbeat keeps the pool
      // countable and the alert fires on the real cause rather than on "pool down".
      problems.push(`low disk: ${freeGb.toFixed(1)} GB free, need ${config.storage.workerDiskMinFreeGb} GB`);
      log.error({ freeGb: Math.round(freeGb * 10) / 10 }, 'insufficient disk space');
      return problems;
    }
  } catch (error) {
    problems.push(`temp dir not writable: ${String(error)}`);
  }

  if (problems.length > 0) {
    log.error({ problems }, 'worker preflight failed');
  } else {
    log.info({ engines: engineCheckList(pool).map((e) => e.name) }, 'worker preflight passed');
  }
  return problems;
}

export const version = config.version;
