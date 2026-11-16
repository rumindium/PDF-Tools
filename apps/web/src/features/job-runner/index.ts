import type { JobPhase, JobStatus, JobView } from '@pdftools/contracts/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, createJob, getJob } from '../../lib/api-client';
import { type JobEvent, subscribeToJob } from '../../lib/sse';

/**
 * Job creation and progress (`docs/0-FOLDER-STRUCTURE.md` §3, `features/job-runner/`).
 *
 * Progress arrives over SSE, with a polling fallback that is not a nicety: a reverse proxy that buffers
 * `text/event-stream` turns the stream into a silent no-op, and a screen that then waits forever for a job which
 * finished in two seconds is the worst possible outcome. `subscribeToJob` reports that case and this hook
 * switches to `GET /jobs/:id` every two seconds until the job reaches a terminal state.
 *
 * A job that is already COMPLETED when the page opens never opens a stream at all — the state is final, so the
 * only thing streaming would add is a replay of history.
 */

export interface TimelineEntry {
  seq: number;
  kind: string;
  status: JobStatus | null;
  phase: JobPhase | null;
  progress: number | null;
  message: string | null;
  at: string;
}

export interface JobRunnerState {
  jobId: string | null;
  status: JobStatus | null;
  phase: JobPhase | null;
  progress: number;
  message: string | null;
  warnings: Array<{ code: string; detail?: string }>;
  error: { code: string; message: string } | null;
  /**
   * The original `ApiError`, kept alongside the flattened `error`.
   *
   * The flattened pair is what a banner needs; the instance is what a *form* needs, because a rejected options
   * object arrives with `details.issues` naming each offending field. Throwing that away and re-deriving it from
   * the message is how validation errors get shown as one unhelpful line.
   */
  failure: ApiError | null;
  timeline: TimelineEntry[];
  submitting: boolean;
  transport: 'idle' | 'sse' | 'polling';
}

const INITIAL: JobRunnerState = {
  jobId: null,
  status: null,
  phase: null,
  progress: 0,
  message: null,
  warnings: [],
  error: null,
  failure: null,
  timeline: [],
  submitting: false,
  transport: 'idle',
};

export function useJobRunner() {
  const [state, setState] = useState<JobRunnerState>(INITIAL);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const applyEvent = useCallback((event: JobEvent, kind: string) => {
    setState((current) => {
      const entry: TimelineEntry = {
        seq: current.timeline.length + 1,
        kind,
        status: event.status ?? null,
        phase: event.phase ?? null,
        progress: event.progress ?? null,
        message: event.message ?? null,
        at: new Date().toISOString(),
      };
      return {
        ...current,
        status: event.status ?? current.status,
        phase: event.phase ?? current.phase,
        progress: event.progress != null ? event.progress : current.progress,
        message: event.message ?? current.message,
        timeline: [...current.timeline, entry].slice(-60),
      };
    });
  }, []);

  const watch = useCallback(
    (job: JobView) => {
      cleanup.current?.();

      if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(job.status)) {
        setState((current) => ({
          ...current,
          jobId: job.id,
          status: job.status,
          phase: job.phase,
          progress: job.progress,
          warnings: job.warnings ?? [],
          error: job.error,
          transport: 'idle',
        }));
        return;
      }

      let poller: ReturnType<typeof setInterval> | null = null;

      const startPolling = () => {
        if (poller) return;
        setState((current) => ({ ...current, transport: 'polling' }));
        poller = setInterval(() => {
          void getJob(job.id)
            .then((fresh) => {
              setState((current) => ({
                ...current,
                status: fresh.status,
                phase: fresh.phase,
                progress: fresh.progress,
                warnings: fresh.warnings ?? [],
                error: fresh.error,
              }));
              if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(fresh.status)) {
                if (poller) clearInterval(poller);
                poller = null;
              }
            })
            .catch(() => {
              /* a transient failure: the next tick retries */
            });
        }, 2000);
      };

      const subscription = subscribeToJob(
        job.id,
        {
          onEvent: applyEvent,
          onFallback: startPolling,
          onOpen: () => setState((current) => ({ ...current, transport: 'sse' })),
        },
        job.status,
      );

      cleanup.current = () => {
        subscription.close();
        if (poller) clearInterval(poller);
        poller = null;
      };
      setState((current) => ({ ...current, jobId: job.id, transport: 'sse' }));
    },
    [applyEvent],
  );

  const submit = useCallback(
    async (input: { tool: string; files: string[]; options?: unknown; retainMinutes?: number }) => {
      setState({ ...INITIAL, submitting: true });
      try {
        const created = await createJob(input);
        setState((current) => ({
          ...current,
          jobId: created.id,
          status: created.status,
          progress: 0,
          submitting: false,
        }));
        const job = await getJob(created.id);
        watch(job);
        return created.id;
      } catch (cause) {
        const apiError = cause instanceof ApiError ? cause : null;
        setState((current) => ({
          ...current,
          submitting: false,
          status: 'FAILED',
          failure: apiError,
          error: {
            code: apiError?.code ?? 'INTERNAL_ERROR',
            message: apiError?.message ?? 'The job could not be created.',
          },
        }));
        return null;
      }
    },
    [watch],
  );

  const reset = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    setState(INITIAL);
  }, []);

  return { state, submit, reset, watch };
}

/** Watch an existing job (the job detail route). Separated so a page load does not create anything. */
export function useJobWatcher(jobId: string | undefined) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(jobId));

  useEffect(() => {
    if (!jobId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let subscription: { close: () => void } | null = null;
    let poller: ReturnType<typeof setInterval> | null = null;

    setLoading(true);
    getJob(jobId)
      .then((fresh) => {
        if (cancelled) return;
        setJob(fresh);
        setLoading(false);
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(fresh.status)) return;

        const refresh = () =>
          void getJob(jobId)
            .then((next) => {
              if (cancelled) return;
              setJob(next);
              if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(next.status)) {
                subscription?.close();
                if (poller) clearInterval(poller);
                poller = null;
              }
            })
            .catch(() => {});

        subscription = subscribeToJob(
          jobId,
          {
            onEvent: () => refresh(),
            onFallback: () => {
              if (!poller) poller = setInterval(refresh, 2000);
            },
          },
          fresh.status,
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause : new ApiError('INTERNAL_ERROR', String(cause), 0));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      subscription?.close();
      if (poller) clearInterval(poller);
    };
  }, [jobId]);

  return { job, error, loading, setJob };
}
