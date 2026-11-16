import { assertBootable, config } from '@pdftools/config';
import { closeDb } from '@pdftools/db';
import { childLogger } from '@pdftools/logger';
import { QUEUE_NAMES, closeQueueConnection } from '@pdftools/queue';
import { type Handler, preflight, startWorker } from '@pdftools/worker-shared';
import { htmlToPdf } from './handlers/html-to-pdf';
import { officeToPdf } from './handlers/office-to-pdf';

/**
 * `pdf-office` — LibreOffice headless (`docs/0-WORKERS.md` §1).
 *
 * This pool is capped hardest and runs with the lowest concurrency (default 2) because a soffice process is
 * ~400 MB resident before it opens a document, and because a document that takes 90 seconds of CPU is normal
 * here and pathological everywhere else.
 *
 * **Every tool queued to this pool is implemented, so there is no `NOT_IMPLEMENTED` entry here.** The convention is
 * still the one the other pools use: a missing tool gets an explicit handler rather than being absent from the map,
 * because an absent handler makes the job fail with "is not implemented in the office worker image" only after the
 * runtime has already claimed, staged and re-validated it (`docs/0-FOLDER-STRUCTURE.md` §4). It is worth naming why
 * this one entry was deleted rather than kept as a safety net: `pdf-to-office` is queued to `heavy` (the catalog says
 * so, and the comment there gives the reason — all three of its engines live in that image), so a stub for it here
 * advertised an unimplemented tool that this pool can never receive, which is how a real gap gets hidden by an
 * optimistic one.
 */

const log = childLogger({ component: 'office-worker' });

const handlers: Record<string, Handler<never>> = {
  'office-to-pdf': officeToPdf as Handler<never>,
  'html-to-pdf': htmlToPdf as Handler<never>,
};

async function main() {
  // The same refusal the API's bootstrap makes: a configuration under which nobody can use this deployment is not one
  // a pool should quietly serve from (`assertBootable`, and `packages/config/src/env.ts` for why this is a call here
  // rather than at import).
  assertBootable();

  const problems = await preflight('office');
  if (problems.some((p) => p.startsWith('missing engine'))) {
    // Without LibreOffice every job in this pool would fail identically; exiting lets the orchestrator restart
    // and alert on the deployment error instead of a queue full of failed conversions.
    log.error({ problems }, 'office worker cannot start without LibreOffice');
    process.exit(1);
  }

  const worker = startWorker({ pool: 'office', handlers });
  log.info({ queue: QUEUE_NAMES.office, concurrency: config.worker.concurrency.office }, 'office pool ready');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'draining');
    await worker.stop().catch(() => {});
    await closeQueueConnection().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
