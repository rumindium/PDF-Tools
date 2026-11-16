import { assertBootable } from '@pdftools/config';
import { closeDb } from '@pdftools/db';
import { childLogger } from '@pdftools/logger';
import { closeQueueConnection } from '@pdftools/queue';
// The escalated light tools are imported, not stubbed: `merge` above 20 files or 1 000 pages and `compress` above
// the size thresholds both route *here* (`docs/0-ARCHITECTURE.md` §6), and a stub would have turned every one of
// those jobs into a failure for a tool the user never picked.
import { type Handler, compress, merge, preflight, startWorker } from '@pdftools/worker-shared';
import { fillFormHandler } from './handlers/fill-form';
import { pdfToCsv } from './handlers/pdf-to-csv';
import { pdfToHtml } from './handlers/pdf-to-html';
import { pdfToOffice } from './handlers/pdf-to-office';
import { pdfToPdfa } from './handlers/pdf-to-pdfa';
import { redactHandler } from './handlers/redact';
import { signHandler } from './handlers/sign';

/**
 * `pdf-heavy` — long-running, high-CPU work: compression of large documents, PDF/A, exports, redaction, signing.
 *
 * This pool also receives jobs escalated from `pdf-light` when the real file turns out to be larger than the
 * submission claimed (`docs/0-QUEUE-AND-JOBS.md` §3), which is why a job can appear here without the user ever
 * choosing it. Every tool whose registry entry can escalate into this queue therefore needs a real handler here,
 * not a placeholder.
 */
const log = childLogger({ component: 'heavy-worker' });

// Every registered tool has a real handler here: `redact` was the last one to be a stub, and a placeholder left in
// the registry is how a job for a tool the user picked turns into a failure nobody can explain.
const handlers: Record<string, Handler<never>> = {
  'pdf-to-pdfa': pdfToPdfa as Handler<never>,
  merge: merge as Handler<never>,
  compress: compress as Handler<never>,
  'pdf-to-html': pdfToHtml as Handler<never>,
  'pdf-to-csv': pdfToCsv as Handler<never>,
  'pdf-to-office': pdfToOffice as Handler<never>,
  'fill-form': fillFormHandler as Handler<never>,
  redact: redactHandler as Handler<never>,
  sign: signHandler as Handler<never>,
};

async function main() {
  // The same refusal the API's bootstrap makes: a configuration under which nobody can use this deployment is not one
  // a pool should quietly serve from (`assertBootable`, and `packages/config/src/env.ts` for why this is a call here
  // rather than at import).
  assertBootable();

  const problems = await preflight('heavy');
  if (problems.some((p) => p.startsWith('missing engine'))) {
    log.error({ problems }, 'heavy worker cannot start without its engines');
    process.exit(1);
  }

  const worker = startWorker({ pool: 'heavy', handlers });
  log.info('heavy pool ready');

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
