import { config } from '@pdftools/config';
import { getDb, rawSql, schema } from '@pdftools/db';
import { childLogger } from '@pdftools/logger';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { jobDir, listJobDirs, listStagingFiles, removeDir, stagingPath } from '../infrastructure/storage';
import { purgeStaleUploads } from './file-service';

/**
 * Three independent cleanup layers (`docs/0-QUEUE-AND-JOBS.md` §9).
 *
 * The design assumption is that *everything else* has failed at least once: the browser closed, the API
 * restarted mid-job, a worker was SIGKILLed, Redis was wiped. So the sweeper depends on nothing but the
 * database and the filesystem — no queue, no cache, no in-memory timers. That is also why it runs on an interval
 * rather than on job completion: a job that never completes still has to have its bytes removed.
 */

const log = childLogger({ component: 'cleanup' });

export interface SweepResult {
  expiredJobs: number;
  purgedJobDirs: number;
  purgedUploads: number;
  orphanStaging: number;
  orphanJobDirs: number;
  errors: number;
}

export async function runSweep(): Promise<SweepResult> {
  const db = getDb();
  const result: SweepResult = {
    expiredJobs: 0,
    purgedJobDirs: 0,
    purgedUploads: 0,
    orphanStaging: 0,
    orphanJobDirs: 0,
    errors: 0,
  };

  const now = new Date();

  // ── 1. Terminal jobs past their TTL become EXPIRED ─────────────────────────
  try {
    const expired = await db
      .update(schema.jobs)
      .set({ status: 'EXPIRED', phase: 'done' })
      .where(
        and(
          inArray(schema.jobs.status, ['COMPLETED', 'FAILED', 'CANCELLED'] as never[]),
          lt(schema.jobs.expiresAt, now),
        ),
      )
      .returning({ id: schema.jobs.id });
    result.expiredJobs = expired.length;

    for (const job of expired) {
      await removeDir(jobDir(job.id));
      result.purgedJobDirs += 1;
    }
  } catch (error) {
    result.errors += 1;
    log.warn({ err: String(error) }, 'expiry sweep failed');
  }

  // ── 2. Failed jobs keep their directory for debugging, but not forever ─────
  try {
    const failedCutoff = new Date(Date.now() - config.storage.failedTtlMinutes * 60_000);
    const stale = await db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(inArray(schema.jobs.status, ['FAILED', 'CANCELLED'] as never[]), lt(schema.jobs.completedAt, failedCutoff)),
      )
      .limit(200);
    for (const job of stale) {
      await removeDir(jobDir(job.id));
      result.purgedJobDirs += 1;
    }
  } catch (error) {
    result.errors += 1;
    log.warn({ err: String(error) }, 'failed-job sweep failed');
  }

  // ── 3. Staged uploads that were never claimed ─────────────────────────────
  try {
    result.purgedUploads = await purgeStaleUploads(config.storage.uploadTtlMinutes);
  } catch (error) {
    result.errors += 1;
    log.warn({ err: String(error) }, 'upload sweep failed');
  }

  // ── 4. Filesystem truth check: directories with no live job row ───────────
  // This is the layer that catches a crashed API: a directory whose row was never written, or whose row was
  // deleted, would otherwise sit on disk forever because every other layer is driven by the database.
  const client = rawSql();
  const maxAgeMs = config.storage.fsSweepMaxAgeMinutes * 60_000;

  try {
    const dirs = await listJobDirs();
    for (const dir of dirs) {
      const rows = await client<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${dir.id} LIMIT 1`;
      const row = rows[0];

      if (!row) {
        // No row at all. Only remove it once it is old enough that an in-flight creation cannot own it.
        if (Date.now() - dir.mtimeMs > maxAgeMs) {
          await removeDir(jobDir(dir.id));
          result.orphanJobDirs += 1;
        }
        continue;
      }

      // "Terminal and past its TTL" is decided by Postgres, not by JavaScript. Reading `expires_at` into JS (the
      // previous version) got a *string* back from the raw driver, so `row.expires_at.getTime()` threw on the
      // first terminal job and aborted this whole pass — which is how expired job directories quietly stayed on
      // disk forever while the sweep reported an error nobody read. Comparing in the database removes the
      // conversion, and with it the class of bug.
      if (row.status === 'EXPIRED') {
        await removeDir(jobDir(dir.id));
        result.purgedJobDirs += 1;
        continue;
      }

      const purged = await client<{ id: string }[]>`
        SELECT id FROM jobs
        WHERE id = ${dir.id}
          AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')
          AND expires_at IS NOT NULL
          AND expires_at < now()
        LIMIT 1`;
      if (purged.length > 0) {
        await removeDir(jobDir(dir.id));
        result.purgedJobDirs += 1;
      }
    }
  } catch (error) {
    result.errors += 1;
    log.warn({ err: String(error) }, 'orphan directory sweep failed');
  }

  // ── 5. Staging files with no row ──────────────────────────────────────────
  try {
    const staged = await listStagingFiles();
    for (const file of staged) {
      const rows = await client<{ id: string }[]>`SELECT id FROM files WHERE id = ${file.id} LIMIT 1`;
      if (rows.length === 0 && Date.now() - file.mtimeMs > maxAgeMs) {
        await removeDir(stagingPath(file.id));
        result.orphanStaging += 1;
      }
    }
  } catch (error) {
    result.errors += 1;
    log.warn({ err: String(error) }, 'orphan staging sweep failed');
  }

  // ── 6. Retention: idempotency keys ────────────────────────────────────────
  try {
    await db.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.expiresAt, now));
  } catch (error) {
    result.errors += 1;
    log.warn({ err: String(error) }, 'idempotency sweep failed');
  }

  return result;
}

/** Long-lived jobs whose worker died: no heartbeat, still PROCESSING. */
export async function requeueStalledJobs(): Promise<number> {
  const client = rawSql();
  // A Date cannot be bound as a parameter here — the driver rejects it ("The string argument must be of type string
  // or an instance of Buffer or ArrayBuffer. Received an instance of Date"), and because this call sits outside
  // `runSweep`'s per-section error handling, the throw took down the whole cleanup tick once a minute. The stalled
  // monitor is the only thing that recovers a job whose worker was SIGKILLed, so it has to actually run: an ISO
  // string binds cleanly and compares exactly the same way.
  const cutoff = new Date(Date.now() - config.queue.stalledMs).toISOString();
  const stalled = await client<{ id: string; attempts: number; max_attempts: number }[]>`
    SELECT id, attempts, ${config.queue.maxAttempts}::smallint AS max_attempts
    FROM jobs
    WHERE status = 'PROCESSING' AND started_at < ${cutoff}::timestamptz
    LIMIT 50`;

  let handled = 0;
  for (const job of stalled) {
    // attempt 1 → put it back; attempt 2 → FAILED WORKER_LOST. The monitor is the guarantee, not the worker's
    // good behaviour (`0-QUEUE-AND-JOBS.md` §8).
    if (job.attempts < config.queue.maxAttempts) {
      await getDb()
        .update(schema.jobs)
        .set({ status: 'QUEUED', phase: 'queued', attempts: job.attempts + 1, workerId: null })
        .where(eq(schema.jobs.id, job.id));
    } else {
      await getDb()
        .update(schema.jobs)
        .set({
          status: 'FAILED',
          errorCode: 'WORKER_LOST',
          errorMessage: 'The worker handling this job stopped responding.',
          completedAt: new Date(),
        })
        .where(eq(schema.jobs.id, job.id));
    }
    handled += 1;
  }
  return handled;
}

export function startCleanupLoop(intervalSeconds = config.storage.cleanupIntervalSeconds): () => void {
  let stopped = false;
  // The two passes are isolated from each other. They answer different questions ("what is expired" and "what is
  // stuck"), so a failure in one must not silently cancel the other — that coupling is what hid the Date-binding
  // error above for as long as it existed, surfacing only as "cleanup sweep threw" once a minute.
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runSweep();
      if (result.expiredJobs || result.purgedJobDirs || result.purgedUploads || result.orphanJobDirs) {
        log.info(result, 'cleanup sweep');
      }
    } catch (error) {
      log.warn({ err: String(error) }, 'cleanup sweep threw');
    }
    try {
      const stalled = await requeueStalledJobs();
      if (stalled > 0) log.info({ stalled }, 'requeued stalled jobs');
    } catch (error) {
      log.warn({ err: String(error) }, 'stalled-job monitor failed');
    }
  };
  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
