import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import {
  type ToolQueue,
  effectiveQueue,
  effectiveTimeoutSeconds,
  extractSecrets,
  mergeSecrets,
  requireTool,
  secretKeysFor,
  validateOptions,
} from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { countPdfPages, registerJobSecrets, releaseJobSecrets } from '@pdftools/engines';
import { JobFailure, asAppError } from '@pdftools/errors';
import { childLogger, jobLogger } from '@pdftools/logger';
import {
  type JobPayload,
  QUEUE_NAMES,
  cancelKey,
  createQueue,
  heartbeatKey,
  lockKey,
  purgeJobReveal,
  purgeJobSecrets,
  readJobSecrets,
  redisConnection,
  stashJobReveal,
  workerHeartbeatKey,
} from '@pdftools/queue';
import { type Job, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Handler, JobContext, ProgressReport } from './context';
import { type VerifiedOutput, assertOutputCount, packArchive, totalBytes, verifyOutputs } from './output';
import { type StagedFile, prepareJobDirs, verifyInputs } from './staging';

/**
 * The worker runtime (`docs/0-QUEUE-AND-JOBS.md` §3, §6–§8).
 *
 * Responsibility split: the *runtime* owns the database and the queue — job status, progress fan-out, retry
 * classification, cancellation, cleanup. A *handler* owns only the conversion. Handlers never import `@pdftools/db`
 * because a conversion result should not depend on database availability, and a retry must not double-write state.
 */

const log = childLogger({ component: 'worker' });

interface RuntimeOptions {
  pool: ToolQueue;
  handlers: Record<string, Handler<never>>;
  concurrency?: number;
}

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export function startWorker({ pool, handlers, concurrency }: RuntimeOptions): WorkerHandle {
  const workerId = config.worker.id;
  const io = redisConnection();
  const log_ = log.child({ pool, workerId });
  const queueName = QUEUE_NAMES[pool];
  const effectiveConcurrency = concurrency ?? config.worker.concurrency[pool];

  const worker = new Worker<JobPayload>(queueName, async (job) => await executeJob(job, pool, handlers, workerId), {
    connection: io,
    concurrency: effectiveConcurrency,
    // Prefetch 2 keeps a light worker busy without letting one worker hoard a queue.
    limiter: pool === 'office' || pool === 'ocr' ? { max: 4, duration: 60_000 } : undefined,
  });

  worker.on('failed', (job, error) => {
    log_.warn({ jobId: job?.id, err: String(error) }, 'job attempt failed');
  });
  worker.on('error', (error) => {
    log_.error({ err: String(error) }, 'worker error');
  });

  // Heartbeat: "is this pool alive" is answered by a Redis key expiring, never by a list of processes
  // (`docs/0-WORKERS.md` §6).
  const beat = async () => {
    try {
      await io.set(
        workerHeartbeatKey(pool, workerId),
        JSON.stringify({
          version: config.version,
          concurrency: effectiveConcurrency,
          startedAt: new Date().toISOString(),
        }),
        'EX',
        30,
      );
    } catch {
      /* Redis blip: the next tick will re-register */
    }
  };
  void beat();
  const beatTimer = setInterval(() => void beat(), 10_000);
  beatTimer.unref?.();

  log_.info({ queue: queueName, concurrency: effectiveConcurrency, handlers: Object.keys(handlers) }, 'worker started');

  return {
    stop: async () => {
      clearInterval(beatTimer);
      // Stop claiming, let in-flight jobs finish, then exit. BullMQ's close() waits for active jobs.
      await worker.close();
      await io.del(workerHeartbeatKey(pool, workerId)).catch(() => 0);
      log_.info('worker stopped');
    },
  };
}

async function executeJob(
  job: Job<JobPayload>,
  pool: ToolQueue,
  handlers: Record<string, Handler<never>>,
  workerId: string,
): Promise<void> {
  const payload = job.data;
  const jobId = payload.jobId;
  const jlog = jobLogger(jobId, payload.tool, workerId);
  const db = getDb();
  const io = redisConnection();
  const jobDir = join(config.storage.tempDir, jobId);

  // ── 1. Lock ───────────────────────────────────────────────────────────────
  // Two workers can both receive the same job id if a stall monitor requeued it. The lock makes that harmless:
  // the loser acknowledges and returns, leaving the winner to finish.
  //
  // One conflict is not a conflict, though: a job this service **moved to a bigger pool** arrives on that pool's queue
  // while the worker that moved it is still finishing its own attempt — the escalation enqueues first and releases the
  // lock when its `process` function returns — so the successor is waiting for a handover, not racing a running job.
  // Skipping in that window loses the job silently: BullMQ has already counted the escalated delivery as processed,
  // the row stays `QUEUED` for ever, and nothing retries it. Measured before this wait existed: a 620-page escalation
  // was claimed 5 ms after it was enqueued, skipped, and never ran (defect 155). The wait is bounded, and running out
  // of it leaves the old behaviour — a real conflict is still a skip, just a few seconds later.
  const lockAcquired = await acquireLockWithHandoverGrace(jobId, workerId, payload.limits.timeoutSeconds, jlog);
  if (lockAcquired !== 'OK') {
    return;
  }

  const abort = new AbortController();
  const cancelWatch = setInterval(async () => {
    const flagged = await io.get(cancelKey(jobId)).catch(() => null);
    if (flagged) abort.abort();
  }, 2000);
  cancelWatch.unref?.();

  let lastProgress = -1;
  let lastReportAt = 0;
  /** Attempts recorded in the database for this job, which is also how the retry budget is counted. */
  let attemptsSoFar = 0;
  const report = (update: ProgressReport) => {
    const now = Date.now();
    if (now - lastReportAt < config.limits.progressMinIntervalMs) return;
    // `<=`, not `===`: progress is a percentage of one execution, so a lower number is never an update. The runtime
    // reports its own "verifying the output" step *after* the handler's last one, and a handler that finished its
    // work at 92 % would otherwise watch the bar step back to 90 %. Equal values are deduped for the same reason
    // they always were — the client keeps the highest it has seen only if it is never sent a lower one.
    if (update.progress <= lastProgress) return;
    lastProgress = update.progress;
    lastReportAt = now;
    void recordProgress(jobId, update);
  };

  try {
    // ── 2. Re-read the row: the API may have cancelled between enqueue and claim ──
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
    if (!row) {
      jlog.warn('job row is gone; nothing to do');
      // The row is the only reason to keep holding the value, and it is what the client reads. No row, no job.
      await purgeSecrets(jobId, jlog);
      return;
    }
    if (row.status === 'CANCELLED' || row.status === 'EXPIRED') {
      jlog.info({ status: row.status }, 'job was cancelled before it started');
      await cleanupJobDir(jobDir);
      // This attempt is the last one this job will ever have, so nothing is waiting for the value any more.
      await purgeSecrets(jobId, jlog);
      return;
    }
    attemptsSoFar = row.attempts ?? 0;

    // ── 3. Re-validate: the payload could have been crafted straight onto the queue ──
    const def = requireTool(payload.tool);
    // The payload carries a placeholder where a password was (`docs/0-SECURITY.md` §5). The real value is read back
    // here, before anything looks at the options, so no code below — not the schema, not a handler — can observe the
    // marker instead of the password. A job whose value is gone fails rather than running with `[secret]` as a
    // password: an encrypted output nobody can open is worse than a job that says it cannot proceed.
    const queuedOptions = await withSecrets(payload, def, jlog, jobId);
    // Registered for as long as this job runs: the spawn path refuses to put any of these values in a command line
    // (`0-SECURITY.md` §7.1), which is the one place a password could still become visible to another process in the
    // container. Release is in the `finally` below, so a failed job cannot leave a value guarded for the next one.
    registerJobSecrets(jobId, Object.values(extractSecrets(def, queuedOptions)));
    const validation = validateOptions(payload.tool, queuedOptions);
    if (!validation.ok) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: 'The queued options are no longer valid for this tool.',
        stderrTail: JSON.stringify(validation.issues),
      });
    }
    if (!handlers[payload.tool]) {
      throw new JobFailure('NOT_IMPLEMENTED', {
        message: `${def.title} is not implemented in the ${pool} worker image.`,
      });
    }

    await db
      .update(schema.jobs)
      .set({ status: 'PROCESSING', phase: 'staging', progress: 5, startedAt: new Date(), workerId })
      .where(eq(schema.jobs.id, jobId));
    await recordStatus(jobId, 'PROCESSING', 5, 'staging', 'Worker claimed the job.');

    // ── 4. Stage and verify inputs ────────────────────────────────────────────
    const staged = await verifyInputs(payload.files);
    const { inputDir, workDir, outputDir } = await prepareJobDirs(jobDir);

    // ── 5. Anti-spoofing size check → escalate the queue if the job is bigger than the claim ──
    //
    // The page count is **read from the files**, not read back out of the payload. It used to be the payload's own
    // `pages` field — the number the API derived from its cheap byte scan (`apps/api/src/shared/pdf-probe.ts`) and
    // the one it had already routed on — so this check could never disagree with the API, and the branch below was
    // unreachable for every job this service creates. The scan reads two windows of a file (its first 4 KB and its
    // last 512 KB); a fixture whose page tree sits between them comes back `null`, and the documented behaviour
    // (`docs/0-QUEUE-AND-JOBS.md` §3 step 5) is that this step settles it. Measured before the fix: 620 real pages,
    // accepted on `pdf-light`, run with the light pool's 300 s budget (defect 153).
    const documents = staged.filter((file) => file.kind !== 'attachment');
    const pages = await measureDocuments(documents, {
      cwd: workDir,
      timeoutMs: Math.min(payload.limits.timeoutSeconds * 1000, 30_000),
      memoryMb: payload.limits.memoryMb,
    });
    // Routing takes the **larger** of the two numbers, which is the safe direction in both ways it can be wrong. A
    // claim that overstates costs a bigger pool and a longer deadline; a measurement that understates something the
    // API could see (a document qpdf declines to open) must not *lower* the number below what the API itself routed
    // on, or a fix for an understatement would introduce the opposite bug for unusual files.
    const routingPages = Math.max(pages.claimed, pages.measured);
    if (pages.measured !== pages.claimed) {
      jlog.warn(
        { claimedPages: pages.claimed, measuredPages: pages.measured, unreadable: pages.unreadable },
        'the declared page count is not the one the files report',
      );
    }

    // ── 5½. The plan's page ceiling, against the count this step just read ──
    //
    // The API refuses a job over `plan.maxPages` when it can count the pages, and it *cannot* when its byte scan answers
    // `null` — which is precisely why this step re-reads the count from the files. So for those documents the ceiling is
    // enforced here or nowhere: measured on a Free account, a 620-page file the scan could not size ran to completion,
    // 620 pages in and 620 out (defect 154). The number comes from the payload because the API is the only layer that
    // resolves a plan: `maxPages` as it reaches a worker is the *tool's* cap from the catalog, `0` for every tool in the
    // registry, and a plan rule compared against that `0` is a rule that never runs (`limits.planMaxPages`).
    //
    // Against `pages.measured`, not `routingPages` — the opposite of the choice made one line above, on purpose. Routing
    // takes the larger of the two because over-provisioning costs a bigger pool and a longer deadline, which is cheap;
    // a limit takes the count read out of the file because refusing a document is the expensive error for the person
    // holding it, and the claim is a heuristic that overstates easily (it takes the largest `/Count` it finds in the
    // tail). A document qpdf could not read has already fallen back to its claim inside `measureDocuments`, so nothing
    // is exempt from the ceiling on that account.
    //
    // Before the escalation check rather than after it: a job that is too big for its plan is not a job that belongs on
    // a bigger pool, and moving it first would spend the heavy pool's worker on a refusal.
    //
    // `?? 0` rather than trusting the type, for a payload that was enqueued before this field existed and is claimed
    // after a deploy: such a job was accepted under the old rule, and reading a missing ceiling as `0` leaves it running
    // as it was accepted instead of rewriting history. The next submission carries the number.
    const planCeiling = payload.limits.planMaxPages ?? 0;
    if (planCeiling > 0 && pages.measured > planCeiling) {
      throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
        message: `This job has ${pages.measured} pages, above the ${payload.planId} plan's limit of ${planCeiling} pages in one job.`,
        stderrTail: `claimed ${pages.claimed} pages, measured ${pages.measured}, plan ceiling ${planCeiling}`,
      });
    }
    const targetQueue = effectiveQueue(def, {
      pages: routingPages || undefined,
      bytes: staged.reduce((sum, file) => sum + file.sizeBytes, 0),
      // Documents only: `aboveFiles` exists for "this is a 30-file merge", and an attachment named by an option is
      // not one of the files the user picked. Both places that route a job apply the same rule, or a job's pool
      // would depend on which of them looked first.
      files: documents.length,
    });
    if (targetQueue !== pool && targetQueue !== payload.queue) {
      jlog.info(
        { from: pool, to: targetQueue, claimedPages: pages.claimed, measuredPages: pages.measured },
        'escalating job after re-checking the real input sizes',
      );
      const escalated = createQueue(targetQueue);
      try {
        // The heavier pool gets the heavier budget. This is the second of the two places a job is routed — the API
        // routes on the *claimed* sizes, and this one on the sizes that turned out to be true — so both have to
        // apply the same rule or a job's timeout would depend on which of them noticed first.
        //
        // `payload.options` goes back out redacted, and the stash is deliberately left alone: the escalated attempt
        // is the same job and needs the same password, which is the reason a stash outlives an attempt rather than
        // a claim.
        await escalated.add(
          def.id,
          {
            ...payload,
            queue: targetQueue,
            limits: { ...payload.limits, timeoutSeconds: effectiveTimeoutSeconds(def, targetQueue) },
          },
          { jobId, priority: payload.priority },
        );
      } finally {
        await escalated.close();
      }
      await db
        .update(schema.jobs)
        .set({ status: 'QUEUED', phase: 'queued', queue: QUEUE_NAMES[targetQueue] })
        .where(eq(schema.jobs.id, jobId));
      await recordStatus(jobId, 'QUEUED', 5, 'queued', 'Moved to a larger worker pool.');
      return;
    }

    // ── 6. Run the handler ────────────────────────────────────────────────────
    const ctx: JobContext<never> = {
      jobId,
      tool: payload.tool,
      options: validation.options as never,
      files: staged,
      jobDir,
      workDir,
      outputDir,
      inputDir,
      limits: payload.limits,
      signal: abort.signal,
      report,
      fail: (code, detail) => new JobFailure(code, detail ?? {}),
    };

    const startedAt = Date.now();
    const result = await withTimeout(
      handlers[payload.tool]!(ctx),
      payload.limits.timeoutSeconds * 1000,
      payload.tool,
      abort,
    );

    // ── 7. Verify and record the output ───────────────────────────────────────
    report({ progress: 90, phase: 'finalizing', message: 'Verifying the output.' });
    const verified = await verifyOutputs(outputDir, result.outputs);
    await assertOutputCount(verified);
    if (verified.length > 1) {
      await packArchive(outputDir, verified);
    }

    const primary = verified.find((v) => v.primary) ?? verified[0]!;
    const outputBytes = await totalBytes(outputDir, verified);
    const durationMs = Date.now() - startedAt;

    // ── 7½. Hand over anything the caller must receive and the record must not keep ──
    //
    // Before the row says COMPLETED, and that ordering is the whole mechanism: the completion event is what makes a
    // client fetch the job, so a reveal stashed afterwards would race the request that needs it. Failing the job when
    // this cannot be stored is the honest outcome — the alternative is a document whose owner password the service
    // held, then lost, while telling the caller the job succeeded.
    await stashReveal(jobId, result.reveal, payload.retentionTtlMinutes, jlog);

    await db
      .update(schema.jobs)
      .set({
        status: 'COMPLETED',
        phase: 'done',
        progress: 100,
        outputBytes,
        outputPages: result.metrics?.outputPages != null ? Number(result.metrics.outputPages) : null,
        outputParts: verified.length,
        outputMime: primary.mime,
        outputName: primary.name,
        resultParts: verified.map((v) => ({
          name: v.name,
          bytes: v.bytes,
          mime: v.mime,
          primary: v.primary ?? false,
          ...(v.pages ? { pages: v.pages } : {}),
        })),
        metrics: {
          ...(result.metrics ?? {}),
          seconds: Math.round(durationMs / 100) / 10,
          outputs: verified.length,
          // The budget this job actually ran with. Without it, "it timed out" is unanswerable after the fact — the
          // payload is gone and the number depended on which pool claimed the job.
          budgetSeconds: payload.limits.timeoutSeconds,
          // What step 5 knew, both sides of it, whenever the job had a PDF to read. A routing decision is the kind of
          // fact that is worth being able to explain afterwards, and the pair is what makes the *re-check* visible:
          // a job whose two numbers differ is one the API could not size, and the pool it ran on is the answer to how
          // it was sized instead.
          ...(pages.documents > 0 ? { claimedInputPages: pages.claimed, measuredInputPages: pages.measured } : {}),
        },
        warnings: result.warnings ?? [],
        engineName: result.engine?.name ?? null,
        engineVersion: result.engine?.version ?? null,
        completedAt: new Date(),
        durationMs,
      })
      .where(eq(schema.jobs.id, jobId));

    await recordStatus(jobId, 'COMPLETED', 100, 'done', 'Job finished.', {
      output: { bytes: outputBytes, parts: verified.length, name: primary.name },
    });

    await recordUsage(jobId, payload);

    // Inputs and scratch space go immediately; the output stays until its TTL.
    await cleanupJobDir(jobDir, { keepOutput: true });
    // The job is over and its output is what the user keeps. The password that produced it has no further use, and
    // this is the moment the service stops holding it — not the TTL, which is only the backstop for a job that
    // never gets here.
    await purgeSecrets(jobId, jlog);

    jlog.info({ durationMs, outputs: verified.length, bytes: outputBytes }, 'job completed');
  } catch (error) {
    const failure = error instanceof JobFailure ? error : new JobFailure('INTERNAL_ERROR', { cause: error });
    // The retry budget is BullMQ's, and `payload.attemptsMade` never carried it (the payload is what the API
    // enqueued, so reading it was always `undefined`). The database column is the one this runtime maintains, so
    // it is the one consulted; BullMQ retries exactly when this throws, which keeps the two counts in step.
    const maxAttempts = job.opts.attempts ?? config.queue.maxAttempts;
    const willRetry = failure.retryable && attemptsSoFar + 1 < maxAttempts;

    await recordError(jobId, failure);

    if (willRetry) {
      // Inputs survive a retry; only scratch space is discarded. Removing `input/` here made every retry fail
      // `verifyInputs` with "An input file is missing on disk", so the first attempt's real error was replaced by
      // an unrelated second one — and a job whose *first* failure was a fluke could never recover at all.
      await cleanupScratch(jobDir);
      await db
        .update(schema.jobs)
        .set({ status: 'QUEUED', phase: 'queued', attempts: attemptsSoFar + 1, errorCode: failure.code })
        .where(eq(schema.jobs.id, jobId));
      jlog.warn({ code: failure.code, attempts: attemptsSoFar + 1, maxAttempts }, 'job failed, will retry');
      throw failure;
    }

    await cleanupJobDir(jobDir, { keepOutput: false });
    await purgeSecrets(jobId, jlog);
    // A failed job holds nothing to hand over. Only reachable in the window where the value was stashed and the row
    // could not be updated: the reveal is written immediately before `COMPLETED`, so this is the one path where a
    // value can exist for a job that never succeeded.
    await purgeJobReveal(jobId).catch(() => 0);
    await db
      .update(schema.jobs)
      .set({
        status: 'FAILED',
        phase: 'done',
        errorCode: failure.code,
        errorMessage: failure.message,
        completedAt: new Date(),
      })
      .where(eq(schema.jobs.id, jobId));
    await recordStatus(jobId, 'FAILED', undefined, 'done', failure.message, { code: failure.code });
    jlog.error({ code: failure.code, err: failure.message }, 'job failed');
    // Do not rethrow a non-retryable failure: BullMQ would mark it failed again and log a duplicate.
  } finally {
    clearInterval(cancelWatch);
    releaseJobSecrets(jobId);
    await io.del(lockKey(jobId)).catch(() => 0);
    await io.del(heartbeatKey(jobId)).catch(() => 0);
    await io.del(cancelKey(jobId)).catch(() => 0);
  }
}

/**
 * How long a claim waits for the worker that handed a job over to let go of the lock, and how often it looks.
 *
 * The window being waited out is a database write and a status publish — the escalation's own remaining work, which
 * is milliseconds. Three seconds is therefore not a budget anybody measures against; it is long enough that a
 * misbehaving clock cannot make the handover look like a conflict, and short enough that a delivery genuinely racing
 * a running job is still skipped promptly.
 */
const HANDOVER_WAIT_MS = 150;
const HANDOVER_WAIT_ATTEMPTS = 20;

/**
 * Take the job's lock, waiting out a handover if one is in flight (`docs/0-QUEUE-AND-JOBS.md` §7).
 *
 * A claim cannot tell "the previous attempt is finishing the escalation it just enqueued" from "another worker is
 * running this job" by looking at Redis — both are a lock held by a live worker — so both are given the same grace
 * period. What that costs is up to `HANDOVER_WAIT_MS × HANDOVER_WAIT_ATTEMPTS` on a delivery that was going to be
 * skipped anyway; what it buys is that an escalated job actually runs.
 */
async function acquireLockWithHandoverGrace(
  jobId: string,
  workerId: string,
  timeoutSeconds: number,
  jlog: ReturnType<typeof jobLogger>,
): Promise<string | null> {
  const io = redisConnection();
  const ttlMs = Math.max(timeoutSeconds, 60) * 2000;
  const acquire = () => io.set(lockKey(jobId), workerId, 'PX', ttlMs, 'NX');

  const started = Date.now();
  let acquired = await acquire();
  while (acquired !== 'OK' && Date.now() - started < HANDOVER_WAIT_MS * HANDOVER_WAIT_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, HANDOVER_WAIT_MS));
    acquired = await acquire();
  }

  const waitedMs = Date.now() - started;
  if (acquired === 'OK' && waitedMs >= HANDOVER_WAIT_MS) {
    jlog.info({ waitedMs }, 'waited for the previous attempt to release the job lock');
  }
  if (acquired !== 'OK') {
    jlog.warn({ waitedMs }, 'another worker holds this job; skipping');
  }
  return acquired;
}

/** The two page counts step 5 compares, plus what it could not read. */
interface MeasuredPages {
  /** What the payload declared, summed over the job's documents — the number the API routed on. */
  claimed: number;
  /** The same sum, read from the files. A document that cannot be read falls back to its claim. */
  measured: number;
  /** How many PDF documents were read. Zero means this job had no page count to re-check at all. */
  documents: number;
  /** Documents whose count could not be read, by name — for the log line, not for the routing. */
  unreadable: string[];
}

/**
 * The real page counts of a job's PDF inputs (`docs/0-QUEUE-AND-JOBS.md` §3 step 5).
 *
 * `qpdf --show-npages`, because the worker is allowed to spawn an engine and this is exactly the question the API's
 * in-process scan cannot answer for every file: it reads two windows of the bytes (a header and a tail), so a
 * document whose page tree lives between them is reported as *unknown* rather than counted.
 *
 * The count is read from **every** PDF input rather than only when the claim looks suspicious. A shortcut here would
 * reintroduce the bug this replaced — "the claim says 200 pages, and 200 is under the threshold, so there is nothing
 * to check" would silently skip every file whose claim is wrong in the direction that matters. One qpdf invocation
 * per document is tens of milliseconds (it reads the xref and the page tree, not the content), paid once per
 * attempt, against jobs that take seconds.
 *
 * It cannot fail the job, and it must not: a document qpdf declines to open is a document the handler will refuse
 * with its own message, and a re-check that turned an unusual file into a `VALIDATION_ERROR` would be a new way for
 * the routing step to break a working job. Such a document keeps its claimed count.
 */
async function measureDocuments(
  documents: StagedFile[],
  opts: { cwd: string; timeoutMs: number; memoryMb: number },
): Promise<MeasuredPages> {
  const result: MeasuredPages = {
    claimed: documents.reduce((sum, file) => sum + (file.pages ?? 0), 0),
    measured: 0,
    documents: 0,
    unreadable: [],
  };

  for (const file of documents) {
    const claimed = file.pages ?? 0;
    // Only a PDF has pages to read, and the type is the one the API detected from the bytes rather than the name.
    const readable = file.detectedType === 'application/pdf';
    if (!readable) {
      result.measured += claimed;
      continue;
    }
    result.documents += 1;
    const measured = await countPdfPages(file.path, opts);
    if (measured > 0) {
      result.measured += measured;
      continue;
    }
    result.measured += claimed;
    result.unreadable.push(file.name);
  }

  return result;
}

/** The per-tool timeout is enforced here rather than by BullMQ, so a slow engine is not killed mid-write twice. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  tool: string,
  abort: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new JobFailure('CONVERSION_TIMEOUT', { message: `${tool} exceeded its time budget.` }));
        }, timeoutMs);
      }),
      new Promise<T>((_resolve, reject) => {
        abort.signal.addEventListener(
          'abort',
          () => reject(new JobFailure('JOB_CANCELLED', { message: 'The job was cancelled.' })),
          {
            once: true,
          },
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The options a handler should see: the payload with this job's stashed secrets merged back in.
 *
 * Only the tools that declare secrets touch Redis at all, so the cost of the whole mechanism lands on the three
 * password tools rather than on every job in the service.
 *
 * The failure is `SECRET_UNAVAILABLE` and non-retryable on purpose. A stash is written with a TTL that covers the
 * job's whole attempt chain, so its absence means the value is genuinely gone — Redis was wiped, the job sat in the
 * queue past its budget, or the API never wrote it. Retrying would spend an attempt to fail identically, and the
 * user's next action is the same either way: submit the job again.
 */
async function withSecrets(
  payload: JobPayload,
  def: ReturnType<typeof requireTool>,
  jlog: ReturnType<typeof jobLogger>,
  jobId: string,
): Promise<Record<string, unknown>> {
  const declared = secretKeysFor(def);
  if (declared.length === 0) return payload.options as Record<string, unknown>;

  const stashed = await readJobSecrets(jobId);
  if (!stashed) {
    jlog.error({ tool: payload.tool }, 'the job needs a password that is no longer held');
    throw new JobFailure('SECRET_UNAVAILABLE');
  }
  return mergeSecrets(def, payload.options as Record<string, unknown>, stashed);
}

/**
 * Hold a handler's revealed values for the caller, for as long as the output they belong to exists.
 *
 * A handler that reveals nothing costs one branch and no Redis call, so this is not a tax on the other thirty tools.
 * The failure is a **job failure** rather than a log line: by the time this runs the conversion succeeded, and a
 * generated owner password that cannot be delivered leaves the user with a document they cannot later re-permission.
 * Retrying is meaningful here — the handler runs again and generates a fresh password — so this is left retryable.
 */
async function stashReveal(
  jobId: string,
  reveal: Record<string, string> | undefined,
  retentionTtlMinutes: number,
  jlog: ReturnType<typeof jobLogger>,
): Promise<void> {
  if (!reveal || Object.keys(reveal).length === 0) return;
  try {
    await stashJobReveal(jobId, reveal, retentionTtlMinutes * 60);
  } catch (error) {
    jlog.error(
      { err: String(error), keys: Object.keys(reveal) },
      'the revealed value could not be held for the caller',
    );
    throw new JobFailure('SECRET_UNAVAILABLE', {
      message:
        'The service could not hold a value this job has to hand back to you (the generated owner password), so the job was not completed.',
    });
  }
}

/**
 * Stop holding a job's secrets.
 *
 * Called at every terminal state and nowhere else: a retry, an escalation and a lost lock all leave the stash in
 * place, because in each of those the job is still going to run. A failure to purge is logged rather than thrown —
 * the job's outcome is already decided at that point, and the TTL is the backstop that makes this safe to lose.
 */
async function purgeSecrets(jobId: string, jlog: ReturnType<typeof jobLogger>): Promise<void> {
  await purgeJobSecrets(jobId).catch((error) => {
    jlog.warn({ err: String(error) }, 'the job secret could not be purged; it expires on its own');
  });
}

/**
 * Discard everything a conversion wrote except `input/` and `output/`.
 *
 * Split out of `cleanupJobDir` because the two callers want different halves: a retry needs its inputs back, and
 * a finished job does not.
 */
async function cleanupScratch(jobDir: string): Promise<void> {
  for (const target of ['work', 'tmp', 'home']) {
    await rm(join(jobDir, target), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

async function cleanupJobDir(jobDir: string, options: { keepOutput?: boolean } = {}): Promise<void> {
  await cleanupScratch(jobDir);
  const targets = ['input'];
  if (!options.keepOutput) targets.push('output');
  for (const target of targets) {
    await rm(join(jobDir, target), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

async function recordProgress(jobId: string, update: ProgressReport): Promise<void> {
  const { recordEvent } = await import('./events');
  await getDb()
    .update(schema.jobs)
    .set({
      progress: Math.max(0, Math.min(99, Math.round(update.progress))),
      ...(update.phase ? { phase: update.phase } : {}),
    })
    .where(eq(schema.jobs.id, jobId));
  await recordEvent({
    jobId,
    type: 'progress',
    progress: update.progress,
    phase: update.phase,
    message: update.message,
  });
}

async function recordStatus(
  jobId: string,
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED',
  progress: number | undefined,
  phase: 'queued' | 'staging' | 'processing' | 'finalizing' | 'done',
  message: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { recordEvent } = await import('./events');
  await recordEvent({ jobId, type: 'status', status, progress, phase, message, payload });
}

async function recordError(jobId: string, failure: JobFailure): Promise<void> {
  const { recordEvent } = await import('./events');
  await recordEvent({
    jobId,
    type: 'error',
    status: undefined,
    message: failure.message,
    // stderr stays operator-only: it can contain absolute paths, and this payload is what the API projects
    // into the job view for the user.
    payload: failure.toEventPayload(),
  });
}

/**
 * Metering (`docs/16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3).
 *
 * Written once, on the completion transition, which is what stops a retry from double-counting a job the user
 * paid for once.
 */
async function recordUsage(jobId: string, payload: JobPayload): Promise<void> {
  const [row] = await getDb().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!row) return;
  const values: Array<{ metric: string; value: number; unit: string }> = [
    { metric: 'jobs', value: 1, unit: 'count' },
    { metric: 'bytes_in', value: row.inputBytes, unit: 'bytes' },
    { metric: 'bytes_out', value: row.outputBytes ?? 0, unit: 'bytes' },
  ];
  if (row.inputPages) values.push({ metric: 'pages', value: row.inputPages, unit: 'pages' });
  if (payload.tool === 'ocr' && row.inputPages)
    values.push({ metric: 'ocr_pages', value: row.inputPages, unit: 'pages' });

  for (const value of values) {
    await getDb()
      .insert(schema.usageRecords)
      .values({
        id: crypto.randomUUID(),
        tenantId: row.tenantId,
        userId: row.userId,
        anonId: row.anonId,
        planId: row.planId,
        tool: row.tool,
        metric: value.metric as never,
        value: String(value.value),
        unit: value.unit,
        source: 'job',
      });
  }
}

export { asAppError, type VerifiedOutput };
