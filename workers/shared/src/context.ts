import type { JobFailure } from '@pdftools/errors';
import type { JobFilePayload, JobPayload } from '@pdftools/queue';

/**
 * What a handler receives and returns (`docs/0-WORKERS.md` §8).
 *
 * A handler is a pure function of this context: it declares nothing about HTTP, the database, or queues, keeps no
 * module-level state, and writes nothing outside `workDir`. That constraint is what makes a handler testable
 * without a stack and safe to run four-at-a-time in one process.
 */

export interface OutputDescriptor {
  /** File name inside `workDir/output`. Validated before it is stored or served. */
  name: string;
  mime: string;
  /** The output the plain `GET /download` returns. Exactly one output should set this. */
  primary?: boolean;
  pages?: number[];
}

export interface HandlerResult {
  outputs: OutputDescriptor[];
  metrics?: Record<string, unknown>;
  warnings?: Array<{ code: string; detail?: string }>;
  /** Engine that did the work, recorded on the job for diagnostics. */
  engine?: { name: string; version?: string };
  /**
   * Values the **caller** must receive and the record must not keep — today, only the owner password a protected
   * document was given when the caller did not choose one.
   *
   * It is a field of its own rather than a `metrics` key on purpose. Everything in `metrics` is written into the `jobs`
   * row as JSON and read back by any client that asks for the job, so a secret placed there is a secret in a database
   * column with a retention window — exactly what `packages/contracts/src/tools/secrets.ts` exists to prevent for the
   * *input* side. The runtime stashes this in Redis under a key whose TTL is the output's own lifetime, and the API
   * hands it out only to a request that explicitly asks (`?reveal=1`).
   */
  reveal?: Record<string, string>;
}

export interface ProgressReport {
  progress: number;
  phase?: 'queued' | 'staging' | 'processing' | 'finalizing' | 'done';
  message?: string;
}

export interface JobContext<TOptions = unknown> {
  jobId: string;
  tool: string;
  options: TOptions;
  files: Array<JobFilePayload & { path: string }>;
  /** The one writable root. `input/`, `work/`, `output/`, `tmp/`, `home/` live inside it. */
  jobDir: string;
  workDir: string;
  outputDir: string;
  inputDir: string;
  limits: JobPayload['limits'];
  signal: AbortSignal;
  /** Throttled inside the runtime, so a handler may call it freely. */
  report: (update: ProgressReport) => void;
  /** Classify a failure with engine context attached. Consumes `JobFailure`, so the codes stay in one vocabulary. */
  fail: (
    code: ConstructorParameters<typeof JobFailure>[0],
    detail?: ConstructorParameters<typeof JobFailure>[1],
  ) => JobFailure;
}

export type Handler<TOptions = unknown> = (ctx: JobContext<TOptions>) => Promise<HandlerResult>;

export interface HandlerRegistry {
  [toolId: string]: Handler<never>;
}
