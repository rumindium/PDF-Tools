import { assertBootable } from '@pdftools/config';
import { closeDb } from '@pdftools/db';
import { childLogger } from '@pdftools/logger';
import { closeQueueConnection } from '@pdftools/queue';
import { type Handler, preflight, startWorker } from '@pdftools/worker-shared';
import { ocr } from './handlers/ocr';

/**
 * `pdf-ocr` — its own pool because recognition is minutes per document and memory-hungry: putting it in the light
 * queue would starve every fast tool behind one 400-page scan (`docs/0-QUEUE-AND-JOBS.md` §2, §4).
 */
const log = childLogger({ component: 'ocr-worker' });

const handlers: Record<string, Handler<never>> = {
  ocr: ocr as Handler<never>,
};

async function main() {
  // The same refusal the API's bootstrap makes: a configuration under which nobody can use this deployment is not one
  // a pool should quietly serve from (`assertBootable`, and `packages/config/src/env.ts` for why this is a call here
  // rather than at import).
  assertBootable();

  const problems = await preflight('ocr');
  if (problems.some((p) => p.startsWith('missing engine'))) {
    log.error({ problems }, 'ocr worker cannot start without its engines');
    process.exit(1);
  }

  const worker = startWorker({ pool: 'ocr', handlers });
  log.info('ocr pool ready');

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
