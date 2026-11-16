import { config } from '@pdftools/config';
import { getTool } from '@pdftools/contracts';
import { AppError } from '@pdftools/errors';
import { readJobReveal } from '@pdftools/queue';
import { Elysia, t } from 'elysia';
import { assertId } from '../infrastructure/storage';
import { resolveIdentity } from '../plugins/session';
import { assertCreationAllowed } from '../services/access-policy';
import { appSwitches } from '../services/app-switches';
import { resolveDisposition, resolveDownload, streamPart } from '../services/download-service';
import { type PersistedJobEvent, eventsSince, subscribeToJob } from '../services/event-service';
import { cancelJob, createJob, getJob, listJobs, toJobView } from '../services/job-service';
import { assertRateLimit } from '../services/quota-service';

/**
 * `docs/0-API.md` §4 — create, read, list, cancel, download, and the SSE progress stream.
 */
export const jobsModule = new Elysia({ prefix: '/api/v1/jobs', tags: ['jobs'] })
  .post(
    '/',
    async (ctx) => {
      // Read off the context rather than destructured out of it — `resolveIdentity` needs `set` (for the session
      // cookie) and `request`, and pulling them out of the parameter list is how they went missing before.
      const { body, headers, set } = ctx;
      const auth = await resolveIdentity(ctx);
      // The gate sits above both rate limiters on purpose: `unlock` carries its own per-tool budget, and a caller who
      // cannot create work at all should not have that budget spent on a refusal. After this line `auth.identity` is
      // a `WorkIdentity`, which is what `createJob` requires (`services/access-policy.ts`).
      assertCreationAllowed(auth.identity, await appSwitches().resolve());
      await assertRateLimit(`jobs:${auth.identity.ownerId}`, config.limits.rateLimitPerMinute);

      // A tool may carry a limit of its own, charged in addition to the one above (`ToolDefinition.rateLimit`).
      // `unlock` does: it is a guess at a password that is not the caller's, and the limit there is about what the
      // request *is* rather than about load — six a minute against the sixty every caller shares. Reading it off the
      // registry keeps the number next to the tool it describes; an unknown id pays nothing here and is refused by
      // `createJob` a few lines later, with a message about the tool rather than about a rate.
      const toolDef = getTool(body.tool);
      if (toolDef?.rateLimit) {
        await assertRateLimit(
          `tool:${toolDef.id}:${auth.identity.ownerId}`,
          toolDef.rateLimit.perMinute,
          toolDef.rateLimit.burst ?? 0,
        );
      }

      const idempotencyKey = headers['idempotency-key'] ?? null;
      const created = await createJob(auth.identity, {
        tool: body.tool,
        files: body.files,
        options: body.options,
        retainMinutes: body.retainMinutes,
        callbackUrl: body.callbackUrl,
        priority: body.priority,
        idempotencyKey,
        module: body.module ?? null,
      });
      set.status = 202;
      return created;
    },
    {
      body: t.Object({
        tool: t.String({ minLength: 1 }),
        files: t.Array(t.String({ format: 'uuid' }), { minItems: 1 }),
        options: t.Optional(t.Any()),
        retainMinutes: t.Optional(t.Number({ minimum: 1, maximum: 1440 })),
        callbackUrl: t.Optional(t.String()),
        priority: t.Optional(t.Number()),
        module: t.Optional(t.String()),
      }),
      detail: {
        summary: 'Create a job',
        description:
          'Validates the tool, files, options, plan limits, quota, and concurrency before enqueueing. Every rejection happens here, never silently inside a worker.',
      },
    },
  )
  .get(
    '/',
    async ({ query, ...ctx }) => {
      const auth = await resolveIdentity(ctx);
      const page = Math.max(1, Number(query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
      return await listJobs(auth.identity, {
        status: query.status ? String(query.status).split(',') : undefined,
        tool: query.tool ? String(query.tool) : undefined,
        from: query.from ? new Date(String(query.from)) : undefined,
        to: query.to ? new Date(String(query.to)) : undefined,
        page,
        pageSize,
      });
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
        status: t.Optional(t.String()),
        tool: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
      }),
    },
  )
  /**
   * `docs/0-API.md` §4.2 — the job, and on request the value the caller has to be given exactly once.
   *
   * `?reveal=1` is opt-in rather than "always include it when we have one", and that is a security decision with a
   * measurable consequence: the progress poller hits this route every two seconds while a job runs, and a response that
   * carried a password whenever one existed would put it in browser devtools, in any intermediary that logs bodies, and
   * in every retry the client happens to make. So a plain GET never reveals, and the one request that asks for it gets
   * `sensitive: true` plus `Cache-Control: no-store` — nothing between this process and the user may keep the value.
   */
  .get(
    '/:id',
    async (ctx) => {
      const { params, query, set } = ctx;
      // `ctx` whole, not spread around it: `resolveIdentity` needs `set` (for the session cookie) and reading it out of
      // the parameter list is how it went missing before — the same trap the create handler above documents.
      const auth = await resolveIdentity(ctx);
      const job = await getJob(assertId(params.id), auth.identity);
      const view = toJobView(job as never);
      if (query.reveal !== '1') return view;

      const secrets = await readJobReveal(job.id);
      if (!secrets) return view;

      // Only a finished job has anything to hand over, and only its owner got this far (`getJob` scopes by identity).
      set.headers['cache-control'] = 'no-store';
      return { ...view, secrets, sensitive: true };
    },
    { query: t.Object({ reveal: t.Optional(t.String()) }) },
  )
  .get('/:id/result', async ({ params, ...ctx }) => {
    const auth = await resolveIdentity(ctx);
    const job = await getJob(assertId(params.id), auth.identity);
    const parts =
      ((job.resultParts ?? []) as Array<{ name: string; bytes: number; mime: string; pages?: number[] }>) ?? [];
    return {
      jobId: job.id,
      parts,
      archiveUrl: parts.length > 1 ? `/api/v1/jobs/${job.id}/download?part=archive` : undefined,
      metrics: job.metrics ?? {},
      warnings: job.warnings ?? [],
    };
  })
  .get('/:id/download', async ({ params, query, ...ctx }) => {
    const auth = await resolveIdentity(ctx);
    const { part } = await resolveDownload(
      assertId(params.id),
      auth.identity,
      query.part ? String(query.part) : undefined,
    );
    // `?disposition=inline` is what the result panel's Preview uses (`0-API.md` §4.5): the same bytes, the same
    // identity check, and a `Content-Disposition` that lets the browser's own viewer show a PDF in a tab instead of
    // saving it. It is granted per media type and falls back to an attachment rather than refusing.
    return await streamPart(
      part,
      resolveDisposition(query.disposition ? String(query.disposition) : undefined, part.mime),
    );
  })
  .delete('/:id', async (ctx) => {
    const { params, set } = ctx;
    const auth = await resolveIdentity(ctx);
    const result = await cancelJob(assertId(params.id), auth.identity);
    if (result.status === 'CANCELLED') set.status = 200;
    return { jobId: params.id, ...result };
  })
  /**
   * SSE progress (`docs/0-API.md` §4.6).
   *
   * Replay comes first — a reconnecting client sends `Last-Event-ID` and every event after it is read from
   * `job_events` before the live stream takes over. Without that step, a client that missed the completion event
   * while its connection was down would poll forever.
   */
  .get('/:id/events', async (ctx) => {
    const { params, request, headers } = ctx;
    const auth = await resolveIdentity(ctx);
    const jobId = assertId(params.id);
    const job = await getJob(jobId, auth.identity);

    const lastEventId = Number(headers['last-event-id'] ?? 0);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    // The status a progress event is stamped with, tracked as the stream advances. A progress event carries no
    // status of its own — it is written before the row's status changes, and its job in the payload is to describe
    // progress — so falling back to the snapshot taken when the stream *opened* stamped every one of them `QUEUED`.
    // The web client applies that field, so a job that was visibly processing flipped back to "Queued" on its next
    // progress line. The snapshot is the right answer for the replayed history and for the first event; after that,
    // the last status actually seen is.
    let streamStatus: string = job.status;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: PersistedJobEvent) => {
          if (closed) return;
          const kind =
            event.type === 'status' && event.status === 'COMPLETED'
              ? 'completed'
              : event.type === 'status' && (event.status === 'FAILED' || event.status === 'CANCELLED')
                ? 'failed'
                : event.type === 'error'
                  ? 'failed'
                  : 'progress';
          controller.enqueue(
            encoder.encode(
              `id: ${event.seq}\nevent: ${kind}\ndata: ${JSON.stringify({
                jobId,
                status: event.status ?? streamStatus,
                progress: event.progress ?? undefined,
                phase: event.phase ?? undefined,
                message: event.message ?? undefined,
                payload: event.payload,
              })}\n\n`,
            ),
          );
          if (event.status) streamStatus = event.status;
          if (event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'CANCELLED') {
            cleanup();
            controller.close();
          }
        };

        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
          request.signal.removeEventListener('abort', cleanup);
        };

        const replay = await eventsSince(jobId, Number.isFinite(lastEventId) ? lastEventId : 0);
        for (const event of replay) send(event);

        if (!closed) {
          unsubscribe = subscribeToJob(jobId, send);
          request.signal.addEventListener('abort', cleanup);
          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`),
              );
            } catch {
              cleanup();
            }
          }, config.limits.sseHeartbeatSeconds * 1000);
        }
      },
      cancel() {
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    // A terminal job is fully served by the replay above: the stream closes itself once the last event is sent,
    // so a client that loads the page after completion still gets the whole story.
    void job;

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
