import { type ErrorCode, NON_RETRYABLE, RETRYABLE, messageFor, statusFor } from '@pdftools/contracts/errors';

/** A failure that should become an HTTP response. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /** HTTP status the client should see; job-only codes are surfaced as 500 when they leak out. */
  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(messageFor(code, message));
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    const status = statusFor(code);
    this.status = status >= 400 && status < 600 ? status : 500;
  }
}

/**
 * A failure raised inside a worker handler.
 *
 * Carries the operator-only diagnosis (engine, exit code, stderr tail) separately from the user-facing message,
 * because those two audiences must never receive the same string: stderr can contain absolute paths.
 */
export class JobFailure extends Error {
  readonly code: ErrorCode;
  readonly engine: string | undefined;
  readonly exitCode: number | undefined;
  readonly stderrTail: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    opts: {
      message?: string;
      engine?: string;
      exitCode?: number;
      stderrTail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(messageFor(code, opts.message));
    this.name = 'JobFailure';
    this.code = code;
    this.engine = opts.engine;
    this.exitCode = opts.exitCode;
    this.stderrTail = opts.stderrTail?.slice(0, 2048);
    if (opts.cause !== undefined) this.cause = opts.cause;
    this.retryable = RETRYABLE.has(code) && !NON_RETRYABLE.has(code);
  }

  /** What the operator sees in `job_events.payload`. Never returned to a client. */
  toEventPayload() {
    return {
      code: this.code,
      engine: this.engine ?? null,
      exitCode: this.exitCode ?? null,
      stderrTail: this.stderrTail ?? null,
    };
  }

  toApiBody() {
    return { code: this.code, message: this.message };
  }
}

export function isJobFailure(e: unknown): e is JobFailure {
  return e instanceof JobFailure;
}

export function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof JobFailure) return new AppError(e.code, e.message);
  return new AppError('INTERNAL_ERROR');
}

export type { ErrorCode };
export { messageFor, statusFor } from '@pdftools/contracts/errors';
