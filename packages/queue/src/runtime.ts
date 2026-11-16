import { config } from '@pdftools/config';
import type { ToolQueue } from '@pdftools/contracts';
import { type JobsOptions, Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

/**
 * Queue wiring — `docs/0-QUEUE-AND-JOBS.md` §2–§4.
 *
 * Four queues, one per worker pool. Priority reorders *within* a queue and never moves a job between queues,
 * which is why an anonymous merge can never jump ahead of a Pro OCR job.
 */

/**
 * One queue per pool, and the name is this pool's public identifier everywhere: the jobs table's `queue` column,
 * the `/health` payload, the worker log line.
 *
 * The hyphen is not a style choice. BullMQ builds its Redis keys as `prefix:name:…` and refuses a name containing
 * a colon outright — `pdf:light` throws `Queue name cannot contain :` before a worker can register, so the colon
 * form the design docs originally sketched could never have started. Namespacing belongs in BullMQ's `prefix`
 * option, which stays at its default (`bull`), leaving these keys as `bull:pdf-light:*`.
 */
export const QUEUE_NAMES: Record<ToolQueue, string> = {
  light: 'pdf-light',
  office: 'pdf-office',
  heavy: 'pdf-heavy',
  ocr: 'pdf-ocr',
};

export const ALL_QUEUES: ToolQueue[] = ['light', 'office', 'heavy', 'ocr'];

export const PRIORITY_BY_PLAN: Record<string, number> = {
  anonymous: 10,
  free: 8,
  pro: 5,
  business: 1,
  api_key: 5,
};

export interface JobFilePayload {
  id: string;
  /** The upload's display name, which still carries the user's extension — sanitized, but not replaced by ours. */
  name: string;
  /**
   * The MIME type the API detected from the **bytes**, not the client's header (`apps/api/src/shared/detect-type.ts`).
   *
   * Carried into the worker because a handler sometimes has to judge the *file* rather than its contents: `images-to-pdf`
   * refuses HEIC outright on a tenant that forbids transcoding, and a photo named `.jpg` whose bytes are HEIC would
   * escape a check written against the name alone (`docs/05-IMAGES-TO-PDF.md` §3).
   */
  detectedType?: string;
  sizeBytes: number;
  pages?: number | null;
  checksumSha256: string;
  /** On-disk path inside the job's input directory. Worker-only; never serialized to a client. */
  storedPath?: string;
  /**
   * `attachment` is a file the tool needs but the user did not pick as a document — resolved from an option that
   * names a file id (`ToolAuxiliaryFile`). It is staged and verified exactly like an input, and kept distinguishable
   * because a handler has to tell a watermark image from the PDF it watermarks.
   */
  kind?: 'input' | 'attachment';
  /** The option that named this attachment, so a handler looks it up by name rather than by position. */
  attachmentOption?: string;
}

export interface JobPayload {
  jobId: string;
  tool: string;
  queue: ToolQueue;
  priority: number;
  ownerKind: 'anonymous' | 'user' | 'api_key';
  planId: 'anonymous' | 'free' | 'pro' | 'business';
  options: unknown;
  files: JobFilePayload[];
  limits: {
    timeoutSeconds: number;
    memoryMb: number;
    /** The *tool's* own ceiling on pages, `0` where the tool adds none. Not the plan's — see below. */
    maxPages: number;
    /**
     * The **plan's** page ceiling for one job, `0` meaning unlimited — the number the API compares a job against and
     * the one it cannot apply when its byte scan answers `null` (`apps/api/src/shared/pdf-probe.ts`).
     *
     * It rides in the payload because the worker is the layer that can *read the file*: step 5 counts the real pages at
     * claim time (`docs/0-QUEUE-AND-JOBS.md` §3), and a ceiling that is only checked where the count is cheap to get is
     * a ceiling that is skipped precisely for the documents that need it most (defect 154). Separate from `maxPages`
     * rather than reusing it: those two numbers have different owners — the registry owns the tool's cap, the plan owns
     * this one — and collapsing them is how four handlers came to compare a plan rule against a `0` that never moved.
     */
    planMaxPages: number;
  };
  retentionTtlMinutes: number;
  createdAt: string;
}

let connection: Redis | null = null;

/**
 * BullMQ requires `maxRetriesPerRequest: null`; sharing that client with pub/sub subscribers would break it, so
 * subscribers get their own connection from `newSubscriber()`.
 */
export function redisConnection(): Redis {
  if (connection) return connection;
  connection = new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  return connection;
}

export function newSubscriber(): Redis {
  return new IORedis(config.redis.url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export function createQueue(queue: ToolQueue): Queue<JobPayload> {
  return new Queue<JobPayload>(QUEUE_NAMES[queue], {
    connection: redisConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
}

export function defaultJobOptions(): JobsOptions {
  return {
    attempts: config.queue.maxAttempts,
    backoff: { type: 'exponential', delay: config.queue.backoffMs },
    removeOnComplete: { age: 3600, count: 5000 },
    removeOnFail: { age: 86_400 },
    // Note: no `timeout` here on purpose. The per-tool budget is enforced inside the worker wrapper, which knows
    // which engine is running and can kill its process group; a queue-level timeout would abort a job that is
    // legitimately still working and leave the engine orphaned.
  };
}

export function queueForTool(queue: ToolQueue): string {
  return QUEUE_NAMES[queue];
}

export function jobChannel(jobId: string): string {
  return `channel:job:${jobId}`;
}

export function cancelKey(jobId: string): string {
  return `cancel:${jobId}`;
}

export function lockKey(jobId: string): string {
  return `job:${jobId}:lock`;
}

export function heartbeatKey(jobId: string): string {
  return `job:${jobId}:hb`;
}

export function workerHeartbeatKey(pool: string, workerId: string): string {
  return `pdftools:worker:${pool}:${workerId}`;
}

export function quotaKey(scope: string): string {
  return `quota:${scope}`;
}

/**
 * Where a job's secrets wait for its worker — `docs/0-SECURITY.md` §5, `packages/contracts/src/tools/secrets.ts`.
 *
 * The one place a caller's password is *held* rather than dropped. It is deliberately not the queue payload and not
 * the job row: a BullMQ job keeps its payload in Redis for a day after a failure (`removeOnFail`), and a row keeps
 * `options` for its whole retention window, so neither can be the answer for a value that only the conversion needs.
 *
 * The lifetime is the point. A stash is written with a TTL derived from the job's own time budget and attempt
 * count, and the worker deletes it when the job reaches a terminal state, so "held" means "for the duration of one
 * job attempt chain" and not "until someone cleans up". A job nobody ever claims leaves nothing behind either: the
 * TTL fires on its own, which is the difference between this and every sweep-based cleanup in the codebase.
 */
export function jobSecretsKey(jobId: string): string {
  return `job:${jobId}:secrets`;
}

export async function stashJobSecrets(
  jobId: string,
  secrets: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  await redisConnection().set(jobSecretsKey(jobId), JSON.stringify(secrets), 'EX', ttlSeconds);
}

/**
 * The stashed values, or `null` when there is nothing left to read.
 *
 * `null` and `{}` mean different things and the worker depends on that: `{}` is "this job declared secrets and none
 * were provided" (a healthy `encrypt` with only a user password would not look like that, but an `encrypt` whose
 * only secret was the placeholder does), while `null` is "the value this job needs is gone". Collapsing them into a
 * falsy check would run the job with the placeholder as the password.
 */
export async function readJobSecrets(jobId: string): Promise<Record<string, string> | null> {
  const raw = await redisConnection().get(jobSecretsKey(jobId));
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') secrets[key] = value;
    }
    return secrets;
  } catch {
    // A malformed stash is not a set of secrets: treat it as gone rather than guessing at half of one.
    return null;
  }
}

/** How many stash keys this job still has — 0 or 1, and the harness asserts it is 0 once the job has ended. */
export async function purgeJobSecrets(jobId: string): Promise<number> {
  return await redisConnection().del(jobSecretsKey(jobId));
}

/**
 * Where a value the *output* produced waits for the caller — the mirror image of `jobSecretsKey`.
 *
 * The input side holds a password the caller typed and the worker needs. This side holds one the worker produced and
 * the caller needs, and the two are the same problem in opposite directions: a value that must survive exactly one hop
 * and must never be written down. It is a different key from the input stash on purpose — a job's input secrets are
 * purged the moment it reaches a terminal state (`purgeJobSecrets`), while the reveal has to outlive that moment, since
 * the caller cannot have read it before the job finished.
 */
export function jobRevealKey(jobId: string): string {
  return `job:${jobId}:reveal`;
}

/**
 * Hold a revealed value for as long as the output it belongs to exists.
 *
 * The TTL is the job's own retention rather than a constant, and that is the coherent choice: the download URL stops
 * working when the output expires, and a password to a file nobody can fetch is either useless or a lie about how long
 * the service holds secrets. A job that is never read leaves nothing behind either — the TTL fires on its own.
 */
export async function stashJobReveal(jobId: string, reveal: Record<string, string>, ttlSeconds: number): Promise<void> {
  await redisConnection().set(jobRevealKey(jobId), JSON.stringify(reveal), 'EX', Math.max(60, ttlSeconds));
}

/**
 * The revealed values, or `null` when there is nothing to hand over.
 *
 * Read, not consumed. "Shown once" sounds stricter than it is: the caller reached this key by asking for a job they
 * already own, and taking the value away on the first read would lose a password to a dropped connection while the
 * document it belongs to is still downloadable for another half hour. What keeps it out of reach is the key's TTL and
 * the fact that only an explicit `?reveal=1` request reads it at all.
 */
export async function readJobReveal(jobId: string): Promise<Record<string, string> | null> {
  const raw = await redisConnection().get(jobRevealKey(jobId));
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const reveal: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') reveal[key] = value;
    }
    return Object.keys(reveal).length > 0 ? reveal : null;
  } catch {
    return null;
  }
}

/** Drop a job's revealed value early — for the purge path, where the output it belongs to is being deleted. */
export async function purgeJobReveal(jobId: string): Promise<number> {
  return await redisConnection().del(jobRevealKey(jobId));
}

/** Waiting + delayed + active, used by `/health` and the queue-depth metric. */
export async function queueDepth(queue: ToolQueue): Promise<number> {
  const q = createQueue(queue);
  try {
    const counts = await q.getJobCounts('waiting', 'delayed', 'active');
    return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
  } finally {
    await q.close();
  }
}

export async function closeQueueConnection(): Promise<void> {
  if (connection) {
    await connection.quit().catch(() => connection?.disconnect());
    connection = null;
  }
}
