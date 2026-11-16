import { getDb, schema } from '@pdftools/db';
import { eq, sql } from 'drizzle-orm';
import { jobChannel } from './index';
import { newSubscriber, redisConnection } from './index';

/**
 * Job event recording — one implementation, used by the API and by every worker.
 *
 * It lives in `@pdftools/queue` because that is the only package both sides already depend on, and because the
 * two halves are inseparable: an event is written to `job_events` *and* published on the job's channel. Splitting
 * them across two call sites is how a live stream and the replayed stream start disagreeing.
 *
 * The write always precedes the publish (`docs/0-QUEUE-AND-JOBS.md` §6): a client that reconnects with
 * `Last-Event-ID` reads from the table, so an event that exists only as a Redis message would be lost forever.
 */

export type JobEventType = 'status' | 'progress' | 'warning' | 'error' | 'log';

export type JobStatusLiteral = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type JobPhaseLiteral = 'queued' | 'staging' | 'processing' | 'finalizing' | 'done';

export interface JobEventInput {
  jobId: string;
  type: JobEventType;
  status?: JobStatusLiteral | undefined;
  phase?: JobPhaseLiteral | undefined;
  progress?: number | undefined;
  message?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface PersistedJobEvent {
  seq: number;
  type: JobEventType;
  status: string | null;
  phase: string | null;
  progress: number | null;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function recordEvent(input: JobEventInput): Promise<PersistedJobEvent | null> {
  const db = getDb();

  // `seq` comes from the table, not from a counter in memory: a restarted API or two workers publishing at once
  // must not be able to produce a duplicate sequence. The unique constraint on (job_id, seq) is the real
  // guarantee — a lost race recomputes and retries instead of corrupting the stream.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [row] = await db
      .select({ maxSeq: sql<number>`coalesce(max(${schema.jobEvents.seq}), 0)` })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, input.jobId));
    const seq = (row?.maxSeq ?? 0) + 1;

    const event: PersistedJobEvent = {
      seq,
      type: input.type,
      status: input.status ?? null,
      phase: input.phase ?? null,
      progress: input.progress ?? null,
      message: input.message ?? null,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };

    try {
      await db.insert(schema.jobEvents).values({
        jobId: input.jobId,
        seq,
        type: input.type,
        status: input.status,
        phase: input.phase,
        progress: input.progress,
        message: input.message,
        payload: event.payload,
      });
      await redisConnection()
        .publish(jobChannel(input.jobId), JSON.stringify(event))
        .catch(() => 0);
      return event;
    } catch {}
  }
  return null;
}

export async function eventsSince(jobId: string, sinceSeq: number): Promise<PersistedJobEvent[]> {
  const rows = await getDb()
    .select()
    .from(schema.jobEvents)
    .where(sql`${schema.jobEvents.jobId} = ${jobId} and ${schema.jobEvents.seq} > ${sinceSeq}`)
    .orderBy(schema.jobEvents.seq)
    .limit(200);

  return rows.map((r) => ({
    seq: r.seq,
    type: r.type as JobEventType,
    status: r.status,
    phase: r.phase,
    progress: r.progress,
    message: r.message,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Subscribe to a job's live events. The returned function unsubscribes and disconnects the subscriber. */
export function subscribeToJob(jobId: string, onEvent: (event: PersistedJobEvent) => void): () => void {
  const subscriber = newSubscriber();
  void subscriber.subscribe(jobChannel(jobId));
  subscriber.on('message', (_channel, message) => {
    try {
      onEvent(JSON.parse(message) as PersistedJobEvent);
    } catch {
      /* a malformed payload must not tear down a live stream */
    }
  });
  return () => {
    void subscriber.unsubscribe(jobChannel(jobId)).finally(() => subscriber.disconnect());
  };
}
