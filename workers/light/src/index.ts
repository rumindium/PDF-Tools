import { assertBootable, config } from '@pdftools/config';
import { closeDb } from '@pdftools/db';
import { childLogger } from '@pdftools/logger';
import { QUEUE_NAMES, closeQueueConnection } from '@pdftools/queue';
// `merge` and `compress` come from `worker-shared`: they escalate to `pdf-heavy`, and the heavy pool must run the
// *same* handler, so it is one implementation shared by both pools rather than a copy in each.
import { type Handler, compress, merge, preflight, startWorker } from '@pdftools/worker-shared';
import { annotate } from './handlers/annotate';
import { crop } from './handlers/crop';
import { editPdf } from './handlers/edit-pdf';
import { extractFields } from './handlers/extract-fields';
import { headerFooter } from './handlers/header-footer';
import { imagesToPdf } from './handlers/images-to-pdf';
import { linearize } from './handlers/linearize';
import { nUp } from './handlers/n-up';
import { pageNumbers } from './handlers/page-numbers';
import { deletePages, extractPages, reorderPages } from './handlers/pages';
import { pdfToImages } from './handlers/pdf-to-images';
import { pdfToText } from './handlers/pdf-to-text';
import { removeMetadata } from './handlers/remove-metadata';
import { rotate } from './handlers/rotate';
import { encrypt, restrict, unlock } from './handlers/security';
import { split } from './handlers/split';
import { watermark } from './handlers/watermark';

/**
 * `pdf-light` — cheap, deterministic, memory-bounded structural work (`docs/0-WORKERS.md` §1).
 *
 * Every tool the catalog marks `enabled: true` for this pool has a real handler here: merge, split, the page
 * operations, rotate, pdf-to-images, images-to-pdf, compress, page-numbers, watermark, header-footer, remove-metadata,
 * linearize, pdf-to-text, crop, n-up, edit-pdf, annotate, extract-fields and the three security tools (encrypt,
 * restrict, unlock).
 *
 * The `NOT_IMPLEMENTED` stub helper that used to live here is **gone**, not commented out: it existed to make a tool
 * the catalog enabled but this pool had not written yet fail with a reason, and with `annotate` and `extract-fields`
 * registered there is no such tool left in this pool. Keeping a fallback nobody can reach is how a dead path becomes
 * a fallback somebody trusts — and the failure it was there to produce is now produced one layer down, where the
 * registry rejects a job whose tool has no handler.
 */

const log = childLogger({ component: 'light-worker' });

const handlers: Record<string, Handler<never>> = {
  merge: merge as Handler<never>,
  split: split as Handler<never>,
  'extract-pages': extractPages as Handler<never>,
  'delete-pages': deletePages as Handler<never>,
  'reorder-pages': reorderPages as Handler<never>,
  rotate: rotate as Handler<never>,
  'pdf-to-images': pdfToImages as Handler<never>,
  'images-to-pdf': imagesToPdf as Handler<never>,
  compress: compress as Handler<never>,
  'page-numbers': pageNumbers as Handler<never>,
  watermark: watermark as Handler<never>,
  'header-footer': headerFooter as Handler<never>,
  'remove-metadata': removeMetadata as Handler<never>,
  linearize: linearize as Handler<never>,
  'pdf-to-text': pdfToText as Handler<never>,
  crop: crop as Handler<never>,
  'n-up': nUp as Handler<never>,
  'edit-pdf': editPdf as Handler<never>,
  encrypt: encrypt as Handler<never>,
  restrict: restrict as Handler<never>,
  unlock: unlock as Handler<never>,
  annotate: annotate as Handler<never>,
  'extract-fields': extractFields as Handler<never>,
};

async function main() {
  // The same refusal the API's bootstrap makes: a configuration under which nobody can use this deployment is
  // not one a pool should quietly serve from (`assertBootable`, and `packages/config/src/env.ts` for why this
  // is a call here rather than at import).
  assertBootable();

  const problems = await preflight('light');
  if (problems.some((p) => p.startsWith('missing engine'))) {
    // A missing engine means every job would fail identically; exiting lets the orchestrator restart and alert.
    log.error({ problems }, 'light worker cannot start without its engines');
    process.exit(1);
  }

  const worker = startWorker({ pool: 'light', handlers });
  log.info({ queue: QUEUE_NAMES.light, concurrency: config.worker.concurrency.light }, 'light pool ready');

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
