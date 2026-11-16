import type { JobPhase, JobStatus } from '@pdftools/contracts/api';

/**
 * The only module that knows the events endpoint (`docs/0-FOLDER-STRUCTURE.md` §3).
 *
 * `EventSource` is used directly rather than a wrapper library because its reconnect behaviour is exactly what
 * the API is built for: on reconnect the browser sends `Last-Event-ID`, and the API replays every event after it
 * from `job_events` before resuming the live stream (`0-API.md` §4.6). That is why a dropped connection never
 * loses the completion event.
 *
 * The caller still gets a polling fallback: `onFallback` is invoked when the stream has failed to open or has
 * gone quiet past a deadline, so a proxy that buffers `text/event-stream` degrades into slower progress instead
 * of a frozen screen.
 */

export interface JobEvent {
  status?: JobStatus;
  progress?: number;
  phase?: JobPhase;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface SubscribeOptions {
  onEvent: (event: JobEvent, kind: string) => void;
  onError?: (error: Event) => void;
  /** Called once when the stream is considered unusable; the caller should switch to polling. */
  onFallback?: () => void;
  onOpen?: () => void;
  /** Milliseconds without a single event (including heartbeats) before falling back. */
  quietAfterMs?: number;
}

export interface Subscription {
  close: () => void;
}

const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);

export function subscribeToJob(jobId: string, options: SubscribeOptions, currentStatus?: JobStatus): Subscription {
  // A job that is already finished has nothing live to stream — the terminal state was delivered by the POST
  // response or by the previous page load, so opening a stream would only produce a replay of history.
  if (currentStatus && TERMINAL.has(currentStatus)) {
    return { close: () => {} };
  }

  const source = new EventSource(`/api/v1/jobs/${jobId}/events`, { withCredentials: true });
  let closed = false;
  const quietAfter = options.quietAfterMs ?? 45_000;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let failedOpens = 0;

  const armQuietTimer = () => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      // No heartbeat for a full interval means the stream is being buffered somewhere between us and the API.
      options.onFallback?.();
    }, quietAfter);
  };

  const handle = (kind: string) => (event: MessageEvent) => {
    if (closed) return;
    armQuietTimer();
    let parsed: JobEvent = {};
    try {
      parsed = JSON.parse(event.data) as JobEvent;
    } catch {
      return;
    }
    options.onEvent(parsed, kind);
    if (parsed.status && TERMINAL.has(parsed.status)) close();
  };

  source.addEventListener('progress', handle('progress'));
  source.addEventListener('completed', handle('completed'));
  source.addEventListener('failed', handle('failed'));
  source.addEventListener('heartbeat', () => armQuietTimer());

  source.onopen = () => {
    failedOpens = 0;
    options.onOpen?.();
    armQuietTimer();
  };

  source.onerror = (error) => {
    options.onError?.(error);
    // `EventSource` retries by itself; the only thing worth intervening in is a stream that never opened at all
    // — for example a proxy that refuses `text/event-stream`. Two consecutive failures is enough evidence.
    if (source.readyState === EventSource.CLOSED) {
      failedOpens += 1;
      if (failedOpens >= 2) options.onFallback?.();
    }
  };

  function close() {
    if (closed) return;
    closed = true;
    if (quietTimer) clearTimeout(quietTimer);
    source.close();
  }

  armQuietTimer();
  return { close };
}
