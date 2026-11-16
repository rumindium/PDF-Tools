import { assertBootable, config } from '@pdftools/config';
import { closeDb, migrate } from '@pdftools/db';
import { childLogger } from '@pdftools/logger';
import { closeQueueConnection } from '@pdftools/queue';
import { buildApp } from './app';
import { ensureBaseDirs } from './infrastructure/storage';
import { startCleanupLoop } from './services/cleanup-service';

const log = childLogger({ component: 'server' });

/**
 * Bun bootstrap.
 *
 * Startup order matters: migrations → directories → HTTP listener → background sweepers. Serving traffic before
 * the schema exists would produce 500s that look like code bugs, and starting the sweeper before the directories
 * exist would log errors on every tick.
 */
async function main() {
  // Before the schema, the directories and the listener: a configuration under which nobody can use this deployment
  // is not a deployment, and the failure has to arrive as one sentence rather than as every route answering 401
  // (`assertBootable` carries the rule; `packages/config/src/env.ts` says why it is called here rather than at import).
  assertBootable();

  await migrate((message) => log.info(message));

  await ensureBaseDirs().catch((error) => {
    // A missing temp directory is fatal: without it every upload fails in a confusing way.
    log.error({ err: String(error) }, 'cannot prepare storage directories');
    throw error;
  });

  const app = buildApp();

  const stopCleanup = startCleanupLoop();

  app.listen({ port: config.api.port, hostname: config.api.host }, () => {
    log.info(
      {
        port: config.api.port,
        env: config.env,
        tempDir: config.storage.tempDir,
        authPlatform: config.api.authPlatformUrl ?? 'disabled (anonymous mode)',
      },
      'pdf-tools api listening',
    );
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopCleanup();
    await app.stop().catch(() => {});
    await closeQueueConnection().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
