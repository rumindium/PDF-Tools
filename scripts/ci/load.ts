import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { largestInputBatch } from '@pdftools/contracts';
// The same two readers the golden and merge harnesses use: the text out of the inflated streams, and the structural
// invariant (page objects against the page tree, plus references that still name a page nothing lists).
import { decodedPdfText as decodedStreams, readPdfHealth } from '../../e2e/lib/pdf-inspect';
import { requireAnonymousUse } from '../../e2e/lib/stack-gap';
import { buildPdf, countPagesInPdf } from '../dev/pdf-writer';

/**
 * Merge at the contract's ceiling — the load measurement `01-MERGE.md` §7 and `docs/0-TESTING.md` §3 promised.
 *
 * The golden suite proves a two-file merge is *correct*. Nothing in it answers how long fifty files take, what the
 * queue adds while other jobs are running, or whether the worker cleans up after a job that big. This script
 * answers those three with measurements and fails when one of them crosses the threshold below.
 *
 *   docker compose up -d postgres redis api worker-light worker-heavy
 *   bun run test:load
 *   # any target, any size:
 *   bun run scripts/ci/load.ts --base http://localhost:8080 --cases 20,50
 *   # the parallel stage: eight callers, fifty files each, submitted at once
 *   bun run scripts/ci/load.ts --lanes 8 --lane-case 50x1
 *
 * What it measures, per case, all from the API's own timestamps rather than from this process's clock:
 *
 *   uploadMs   this process's wall time to stage N files, and the bytes it staged
 *   queueMs    `startedAt − createdAt` — the wait the queue and a busy worker add
 *   workerMs   `completedAt − startedAt` — what the conversion itself costs
 *   msPerFile  workerMs / files, the number a threshold can be set on
 *
 * And what it asserts, because a fast wrong answer is worse than a slow right one:
 *
 *   1. the job completes, reports the pages the inputs were built with, and the *downloaded* file holds that many
 *      page objects (the merge harness's check, at scale);
 *   2. every input's label survives, and the first input's label precedes the last one's — a 50-file merge that
 *      silently dropped or reordered pages fails here;
 *   3. the escalation rule fires: more files than `aboveFiles` (20) runs on `heavy`, not `light` (catalog);
 *   4. the structural invariant holds on the merged file (three readers agree; no orphan page, field or annotation);
 *   5. input/, work/, tmp/ and home/ are gone from the job directory when it finishes — only output/ remains, which
 *      is what "temp usage returns to baseline" means for a job whose result is still downloadable;
 *   6. the contract ceiling is real: maxFiles+1 is refused with the documented validation error rather than accepted
 *      and truncated, so "hundreds of files" is a *request-level* answer and not a silent limit;
 *   7. every lane of the parallel stage passes checks 1–5 on its own output, while the stage's numbers are reported
 *      against the *drain* — first submission to last output — rather than against one job's worker time;
 *   8. the queue depth the stage claims was observed, not inferred: `/health` is sampled while the lanes run, and
 *      the stage fails if lanes were queued behind the workers and no depth was ever reported.
 *
 * The sequential cases answer "what does a big merge cost". The parallel stage answers the other question — what the
 * system does when several of them arrive together — which is the one a queue, a limiter and a worker pool are all
 * built for, and the one no single-job measurement can see.
 */

interface Case {
  files: number;
  pages: number;
}

interface Args {
  base: string;
  timeoutSeconds: number;
  cases: Case[];
  pagesPerFile: number;
  concurrency: number;
  plan: 'free' | 'pro' | 'business' | null;
  planToken: string;
  thresholdMsPerPage: number;
  skipCeiling: boolean;
  skipLimiter: boolean;
  jsonPath: string;
  /** Callers in the parallel stage; 0 keeps the run exactly as it was before the stage existed. */
  lanes: number;
  /** What each of those callers submits. */
  laneCase: Case;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  // `20` or `20x25` — files, or files × pages. Both dimensions matter: the escalation rule steps on file count
  // *and* on a page total, so a curve that only varies files measures half the rule.
  const parsed = (value('--cases') ?? '20,50')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [files, pages] = entry.split('x').map((part) => Number(part));
      return { files: files ?? 0, pages: pages ?? (Number(value('--pages-per-file')) || 1) };
    })
    .filter((entry) => Number.isFinite(entry.files) && entry.files > 1 && entry.pages > 0);
  const lane = (value('--lane-case') ?? '50x1').split('x').map((part) => Number(part));
  const laneCase: Case = {
    files: Number.isFinite(lane[0]) && (lane[0] ?? 0) > 1 ? (lane[0] as number) : 50,
    pages: Number.isFinite(lane[1]) && (lane[1] ?? 0) > 0 ? (lane[1] as number) : 1,
  };
  return {
    base: value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080',
    timeoutSeconds: Number(value('--timeout')) || 600,
    cases:
      parsed.length > 0
        ? parsed
        : [
            { files: 20, pages: 1 },
            { files: 50, pages: 1 },
          ],
    pagesPerFile: Number(value('--pages-per-file')) || 1,
    concurrency: Number(value('--upload-concurrency')) || 8,
    plan: (value('--plan') as Args['plan']) ?? 'pro',
    planToken: value('--plan-token') ?? process.env.DEV_PLAN_TOKEN ?? 'dev-plan-token',
    // 0 means "measure and report, do not judge" by a threshold of this script's own invention: the time assertion
    // that always holds is the job's own budget, which the worker reports. Set this to gate on a tighter number.
    thresholdMsPerPage: Number(value('--threshold-ms-per-page')) || 0,
    skipCeiling: argv.includes('--skip-ceiling'),
    skipLimiter: argv.includes('--skip-limiter'),
    jsonPath: value('--json') ?? 'e2e/artifacts/load-merge.json',
    lanes: Number(value('--lanes')) || 0,
    laneCase,
  };
}

const args = parseArgs();
const api = args.base.replace(/\/$/, '');
const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
/** The catalog's own escalation rule for `merge`, asserted here rather than trusted. */
const ESCALATES_ABOVE_FILES = 20;
const ESCALATES_ABOVE_PAGES = 1000;
const MERGE_MAX_FILES = 50;
/**
 * `files.ts` rate-limits staging at half the general limit, and `RATE_LIMIT_PER_MINUTE` defaults to 60 — so a
 * 50-file submission cannot be staged faster than about two minutes, whatever the engine costs. Measured here
 * rather than assumed, because it is the dominant cost of a large merge and it is not the engine's.
 */
const UPLOADS_PER_MINUTE = 30;

const steps: string[] = [];

function step(message: string): void {
  steps.push(message);
  console.log(`  ✓ ${message}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n  ✗ ${message}`);
  if (detail !== undefined)
    console.error(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
  console.error(`\ncompleted steps:\n${steps.map((s) => `  · ${s}`).join('\n')}`);
  process.exit(1);
}

/**
 * One caller: its own session cookie, its own rate-limit counters.
 *
 * `cookie` used to be module state, which was fine while the script had exactly one caller. It is not fine for the
 * parallel stage, and not because of tidiness: the upload limiter is per identity, so running four lanes through one
 * session would measure the limiter rather than the system, and one lane's 429s would be reported inside another
 * lane's row. Per-session counters are what make "no rate-limit hits" a statement about a lane.
 */
class Session {
  cookie: string | null = null;
  rateLimitHits = 0;
  rateLimitWaitsMs = 0;
  uploads = 0;
  private establishing: Promise<void> | null = null;

  /** Every request carries the dev-plan headers when a plan was asked for: the override is evaluated per request. */
  async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    if (args.plan) {
      headers.set('x-dev-plan', args.plan);
      headers.set('x-dev-plan-token', args.planToken);
    }
    const response = await fetch(`${api}${path}`, { ...init, headers, redirect: 'manual' });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const value of setCookie) {
      const pair = value.split(';')[0];
      if (pair?.startsWith('pdft_session=')) this.cookie = pair;
    }
    return response;
  }

  /**
   * Make sure this caller holds a session before anything runs in parallel.
   *
   * The session is minted by the first request that needs an owner, which is invisible while requests are sequential
   * and wrong the moment they are not: eight concurrent uploads from a cold session each mint their own, and the job
   * then refuses the files that came from the others — `403 FORBIDDEN: That upload belongs to another session`. Found
   * by the parallel stage, in the stage's first run.
   *
   * De-duplicated through `establishing` because the callers that need this are, by definition, concurrent: without
   * it, eight lanes' uploads would each fire their own `/me` and the same race would just move one request earlier.
   */
  async ensureSession(): Promise<void> {
    if (this.cookie) return;
    this.establishing ??= (async () => {
      await this.json('/api/v1/me');
    })().finally(() => {
      this.establishing = null;
    });
    await this.establishing;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.call(path, init);
    const text = await response.text();
    if (!response.ok) fail(`${init?.method ?? 'GET'} ${path} returned ${response.status}`, text.slice(0, 800));
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * One upload. A refusal is returned rather than waited out, because some checks assert the refusal itself — a
   * limiter can only be shown to work by spending it.
   */
  async uploadOnce(
    name: string,
    bytes: Uint8Array,
  ): Promise<{ id: string } | { refused: { retryAfterSeconds?: number } }> {
    const form = new FormData();
    form.append('kind', 'input');
    form.append('file', new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/pdf' }));
    const response = await this.call('/api/v1/files', { method: 'POST', body: form });
    const text = await response.text();
    if (response.status === 429) {
      const retryAfter = (JSON.parse(text) as { error?: { details?: { retryAfterSeconds?: number } } }).error?.details
        ?.retryAfterSeconds;
      return { refused: { ...(retryAfter != null ? { retryAfterSeconds: retryAfter } : {}) } };
    }
    if (response.status !== 201) fail(`uploading ${name} returned ${response.status}`, text.slice(0, 400));
    this.uploads += 1;
    return { id: (JSON.parse(text) as { id: string }).id };
  }

  /**
   * The same upload, honouring `retryAfterSeconds` — what a real client does.
   *
   * The waits are counted and reported, so a slow run is never blamed on the engine when it was the limiter doing its
   * job; and a run that is refused while staging one maximal batch is a limiter defect, which is exactly what this
   * counter caught before the bucket existed.
   */
  async upload(name: string, bytes: Uint8Array): Promise<string> {
    const attempt = await this.uploadOnce(name, bytes);
    if (!('refused' in attempt)) return attempt.id;

    const waitMs = Math.min((attempt.refused.retryAfterSeconds ?? 1) * 1000 + 250, 60_000);
    this.rateLimitHits += 1;
    this.rateLimitWaitsMs += waitMs;
    console.log(`      rate limited after ${this.uploads} upload(s); waiting ${Math.round(waitMs / 1000)}s`);
    await Bun.sleep(waitMs);
    return await this.upload(name, bytes);
  }

  /**
   * Upload in fixed-size batches: a hundred parallel requests measure the socket, not the pipeline.
   *
   * `rateLimitWaitsMs` is the sum of the waits **asked for**, which is not wall time when uploads run in parallel:
   * eight waiting uploads each add their own wait while sleeping at the same time. Both numbers are reported for that
   * reason — the count is what happened, the sum is why the upload phase was slow, and `ms` is the wall clock they
   * both live behind.
   */
  async uploadAll(files: Array<{ name: string; bytes: Uint8Array }>): Promise<{
    ids: string[];
    bytes: number;
    ms: number;
    rateLimitHits: number;
    rateLimitWaitsMs: number;
  }> {
    // Before the batch, not per request: see `ensureSession`.
    await this.ensureSession();
    const hitsBefore = this.rateLimitHits;
    const waitsBefore = this.rateLimitWaitsMs;
    const started = performance.now();
    const ids: string[] = [];
    let bytes = 0;
    for (let index = 0; index < files.length; index += args.concurrency) {
      const batch = files.slice(index, index + args.concurrency);
      const uploaded = await Promise.all(batch.map((file) => this.upload(file.name, file.bytes)));
      ids.push(...uploaded);
      for (const file of batch) bytes += file.bytes.length;
    }
    return {
      ids,
      bytes,
      ms: Math.round(performance.now() - started),
      rateLimitHits: this.rateLimitHits - hitsBefore,
      rateLimitWaitsMs: this.rateLimitWaitsMs - waitsBefore,
    };
  }
}

interface JobView {
  id: string;
  status: string;
  phase: string;
  queue: string;
  progress: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  output: { bytes: number; pages: number | null; parts: number; name: string } | null;
  error: { code: string; message: string } | null;
  warnings: Array<{ code: string; detail?: string }>;
  metrics?: Record<string, unknown>;
}

async function waitForJob(session: Session, jobId: string, prefix = '      '): Promise<JobView> {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let last: JobView | null = null;
  let lastLabel = '';
  while (Date.now() < deadline) {
    const job = await session.json<JobView>(`/api/v1/jobs/${jobId}`);
    last = job;
    const label = `${job.status}/${job.phase} ${job.progress}%`;
    if (label !== lastLabel) {
      console.log(`${prefix}${label}`);
      lastLabel = label;
    }
    if (job.status === 'COMPLETED') return job;
    if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(job.status)) fail(`the job ended as ${job.status}`, job.error);
    await Bun.sleep(500);
  }
  fail(`the job did not finish within ${args.timeoutSeconds}s`, last);
}

/**
 * What is left in the job directory once the job is done.
 *
 * Read from inside the worker container through `docker compose exec`, because that is where the volume is — the
 * whole point is the *worker's* own cleanup, so asking the API would answer a different question.
 */
async function jobDirContents(service: string, jobId: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      'docker',
      'compose',
      'exec',
      '-T',
      service,
      'sh',
      '-c',
      `ls -1 /var/lib/pdf-tools/jobs/${jobId} 2>/dev/null || true`,
    ],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return [];
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface CaseMeasurement {
  files: number;
  pagesPerFile: number;
  totalPages: number;
  /** The worker's own `metrics.seconds`, read from `/result` — a second opinion on `workerMs`. */
  workerReportedSeconds: number | null;
  /** The time budget the job actually ran with, also from `/result`: the light budget or the escalated one. */
  budgetSeconds: number | null;
  inputBytes: number;
  uploadMs: number;
  /** `429 RATE_LIMITED` responses this case's upload phase saw, and the sum of the waits they asked for. */
  uploadRateLimitHits: number;
  uploadRateLimitWaitsMs: number;
  queueMs: number | null;
  workerMs: number | null;
  msPerFile: number | null;
  msPerPage: number | null;
  queue: string;
  outputBytes: number;
  jobId: string;
  jobDirLeftovers: string[];
}

const measurements: CaseMeasurement[] = [];

async function runCase(spec: Case, session: Session): Promise<CaseMeasurement> {
  const { files, pages } = spec;
  console.log(`\n── ${files} file(s), ${pages} page each (${files * pages} pages in total) ──`);

  const generated: Array<{ name: string; bytes: Uint8Array; label: string }> = [];
  for (let index = 0; index < files; index += 1) {
    // A distinct label per input, so "which input is missing" is answerable from the merged file alone.
    const label = `Load fixture ${String(index + 1).padStart(3, '0')}`;
    generated.push({
      name: `load-${String(index + 1).padStart(3, '0')}.pdf`,
      bytes: buildPdf({ pages, label }),
      label,
    });
  }
  const expectedPages = generated.reduce((total, file) => total + countPagesInPdf(file.bytes), 0);

  const upload = await session.uploadAll(generated);
  const uploadHits = upload.rateLimitHits;
  const uploadWaits = upload.rateLimitWaitsMs;
  step(
    `staged ${files} file(s) — ${(upload.bytes / 1024 / 1024).toFixed(2)} MB in ${upload.ms} ms (${Math.round(
      files / (upload.ms / 1000),
    )} files/s)${
      uploadHits > 0
        ? ` — ${uploadHits} rate-limit hit(s), ${Math.round(uploadWaits / 1000)}s of asked-for waits across the parallel uploads`
        : ''
    }`,
  );

  const created = await session.json<JobView>('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files: upload.ids, options: { bookmarks: 'keep' } }),
  });

  // The **queue name**, which is what `POST /jobs` answers with: `pdf-heavy`, not the `heavy` pool id. The pool is
  // published under its own name elsewhere (`/health` → `checks.pools`).
  const expectedQueue =
    files > ESCALATES_ABOVE_FILES || expectedPages > ESCALATES_ABOVE_PAGES ? 'pdf-heavy' : 'pdf-light';
  if (created.queue !== expectedQueue) {
    fail(
      `a ${files}-file merge was queued on ${created.queue}, but the catalog escalates above ${ESCALATES_ABOVE_FILES} files`,
      { expectedQueue, queue: created.queue },
    );
  }
  step(
    `queued on ${created.queue} (escalation rule: > ${ESCALATES_ABOVE_FILES} files or > ${ESCALATES_ABOVE_PAGES} pages → heavy)`,
  );

  const job = await waitForJob(session, created.id);
  // The worker's own timing comes from `/result`, not from the job view: the view carries state, the result carries
  // what the run cost. Two independent numbers for the same interval is what makes either of them trustworthy.
  const result = await session.json<{ metrics?: Record<string, unknown> }>(`/api/v1/jobs/${job.id}/result`);
  const reportedSeconds = typeof result.metrics?.seconds === 'number' ? (result.metrics.seconds as number) : null;
  const budgetSeconds =
    typeof result.metrics?.budgetSeconds === 'number' ? (result.metrics.budgetSeconds as number) : null;
  const startedAt = job.startedAt ? Date.parse(job.startedAt) : null;
  const completedAt = job.completedAt ? Date.parse(job.completedAt) : null;
  const queueMs = startedAt ? startedAt - Date.parse(job.createdAt) : null;
  const workerMs = startedAt && completedAt ? completedAt - startedAt : null;
  const msPerFile = workerMs != null ? Math.round(workerMs / files) : null;
  const msPerPage = workerMs != null ? Math.round((workerMs / expectedPages) * 100) / 100 : null;
  step(
    `completed: queue ${queueMs ?? '?'} ms · worker ${workerMs ?? '?'} ms · ${msPerFile ?? '?'} ms per file · ${
      msPerPage ?? '?'
    } ms per page (the worker reports ${reportedSeconds ?? '?'}s of its ${budgetSeconds ?? '?'}s budget)`,
  );

  const verified = await verifyOutput(session, job, generated, expectedPages, { workerMs, budgetSeconds, files });

  return {
    files,
    pagesPerFile: pages,
    totalPages: expectedPages,
    workerReportedSeconds: reportedSeconds,
    budgetSeconds,
    inputBytes: upload.bytes,
    uploadMs: upload.ms,
    uploadRateLimitHits: uploadHits,
    uploadRateLimitWaitsMs: uploadWaits,
    queueMs,
    workerMs,
    msPerFile,
    msPerPage,
    queue: job.queue,
    outputBytes: verified.bytes.length,
    jobId: job.id,
    jobDirLeftovers: verified.leftover,
  };
}

/**
 * Checks 1–5, on one finished job's output.
 *
 * One function for the sequential cases and for every lane of the parallel stage, because the failure this guards
 * against is a lane reporting throughput next to a file nobody walked. The budget check lives here too: it is the
 * only time assertion that is not this script's opinion — the job has to finish inside the budget the product itself
 * promises for that pool (`catalog.limits.timeoutSeconds`, or the escalated one, both reported by the worker in
 * `metrics.budgetSeconds`), so a merge that takes longer than its own contract says fails whatever any threshold in
 * this file is set to.
 */
async function verifyOutput(
  session: Session,
  job: JobView,
  generated: Array<{ name: string; bytes: Uint8Array; label: string }>,
  expectedPages: number,
  timings: { workerMs: number | null; budgetSeconds: number | null; files: number },
): Promise<{ bytes: Uint8Array; leftover: string[] }> {
  const { workerMs, budgetSeconds, files } = timings;
  if (workerMs != null && budgetSeconds != null && workerMs > budgetSeconds * 1000) {
    fail(`the merge took ${workerMs} ms, more than the ${budgetSeconds}s budget the job ran with`, {
      files,
      pages: expectedPages,
      queue: job.queue,
    });
  }
  if (workerMs != null && budgetSeconds != null) {
    const used = ((workerMs / (budgetSeconds * 1000)) * 100).toFixed(2);
    step(`it used ${used}% of the ${budgetSeconds}s budget the pool gives this job`);
  }

  const reportedPages = job.output?.pages ?? null;
  if (reportedPages != null && reportedPages !== expectedPages) {
    fail(`the job reported ${reportedPages} page(s) but the inputs hold ${expectedPages}`);
  }
  if (!job.output || job.output.bytes <= 0) fail('the job reported a zero-byte output');

  const download = await session.call(`/api/v1/jobs/${job.id}/download`);
  if (!download.ok) fail(`download returned ${download.status}`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const actualPages = countPagesInPdf(bytes);
  if (actualPages !== expectedPages) {
    fail(`the downloaded file holds ${actualPages} page(s), expected ${expectedPages}`);
  }
  step(`downloaded ${bytes.length} bytes and counted ${actualPages} page(s) in the file itself`);

  // Every label must be present, and the first must precede the last: at 50 inputs a dropped or reordered file is
  // exactly the failure a size-only check would miss.
  const text = decodedStreams(Buffer.from(bytes));
  const missing = generated.filter((file) => !text.includes(file.label)).map((file) => file.label);
  if (missing.length > 0) fail(`${missing.length} input label(s) are absent from the merged file`, missing.slice(0, 5));
  if (text.indexOf(generated[0]!.label) > text.indexOf(generated[files - 1]!.label)) {
    fail('the inputs are in the wrong order: the last file appears before the first');
  }
  step(`all ${files} input label(s) present and in order`);

  const structure = await readPdfHealth(bytes, REPO_ROOT);
  const readers: Array<[string, number | null]> = [
    ['a byte scan', structure.objects],
    ['an object walk', structure.parserObjects],
    ['the page tree', structure.tree],
  ];
  const known = readers.filter((entry): entry is [string, number] => entry[1] != null);
  const reference = known[0];
  if (!reference) {
    step('no reader was reachable, so the page-object/tree invariant was not checked');
  } else {
    const disagreeing = known.find(([, count]) => count !== reference[1]);
    if (disagreeing) {
      fail(`${disagreeing[0]} counts ${disagreeing[1]} page(s) where ${reference[0]} counts ${reference[1]}`, {
        readers: Object.fromEntries(known),
      });
    }
    if ((structure.orphanPages?.length ?? 0) > 0) {
      fail(`the merged file holds page object(s) its tree does not list: ${structure.orphanPages!.join(', ')}`);
    }
    if (structure.danglingFields || structure.danglingAnnotations) {
      fail(
        `the merged file has ${structure.danglingFields ?? 0} field(s) and ${structure.danglingAnnotations ?? 0} annotation(s) pointing at a page its tree does not have`,
      );
    }
    step(`the file holds ${reference[1]} page object(s) and every reader that could open it agrees`);
  }

  // The job is finished, so nothing but the output may remain: input/, work/, tmp/ and home/ are what the runtime
  // promises to remove (`0-WORKERS.md` §3). A leftover tmp/ is an engine's scratch that survived the job.
  // `job.queue` is the column, so it is a queue name (`pdf-heavy`); comparing it against the pool id picked the light
  // container for every escalated job, and "only output/ may remain" was then read off the wrong worker. The queue-name
  // spelling is what made it visible; before that this line matched neither value it could receive.
  const leftover = await jobDirContents(job.queue === 'pdf-heavy' ? 'worker-heavy' : 'worker-light', job.id);
  const unexpected = leftover.filter((entry) => entry !== 'output');
  if (unexpected.length > 0) {
    fail(`the job directory still holds ${unexpected.join(', ')} after completion — only output/ may remain`, leftover);
  }
  step(
    `the job directory holds ${leftover.length === 0 ? 'nothing (output already gone)' : leftover.join(', ')} — no scratch left behind`,
  );

  return { bytes, leftover };
}

/** The ceiling is part of the contract, so the measurement checks it instead of implying it. */
async function checkCeiling(session: Session): Promise<void> {
  console.log('\n── contract ceiling ──');
  const tooMany = Array.from({ length: MERGE_MAX_FILES + 1 }, (_, index) => `load-ceiling-${index + 1}.pdf`);
  const first = buildPdf({ pages: 1, label: 'Ceiling fixture' });
  const ids: string[] = [];
  for (const name of tooMany) ids.push(await session.upload(name, first));

  const response = await session.call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files: ids, options: { bookmarks: 'keep' } }),
  });
  const text = await response.text();
  // 422, not 400: `VALIDATION_ERROR` is this API's unprocessable-entity code for a well-formed request it refuses.
  if (response.status !== 422) {
    fail(
      `merge answered ${MERGE_MAX_FILES + 1} files with HTTP ${response.status}; it should refuse with 422 VALIDATION_ERROR`,
      text.slice(0, 400),
    );
  }
  const body = JSON.parse(text) as { error?: { code?: string; details?: { issues?: Array<{ message?: string }> } } };
  const issue = body.error?.details?.issues?.[0]?.message ?? '';
  if (!issue.includes(`${MERGE_MAX_FILES}`)) {
    fail(`the refusal does not name the ${MERGE_MAX_FILES}-file ceiling`, body);
  }
  step(
    `${MERGE_MAX_FILES + 1} files refused with ${body.error?.code}: "${issue}" — so "hundreds of files" is a request-level fact, not a silent truncation`,
  );
}

/** Nearest-rank percentile, no interpolation: with eight lanes this is a fact about a lane, not a distribution. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

function summarise(values: number[]): { min: number; p50: number; p95: number; max: number } {
  return {
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

/**
 * The limiter's two claims, measured rather than asserted in prose.
 *
 * 1. **One maximal legal batch is always admissible.** A fresh session stages the 50-file ceiling and must not be
 *    refused once. This is the claim the token bucket was introduced for: before it, the upload limiter charged 30
 *    per minute per file, so "merge up to 50 files" could not be staged inside a minute at all — the previous run of
 *    this script sat through 578 s of asked-for waits to prove it.
 * 2. **The bucket still runs out.** A limit nobody has seen refuse anything is a limit nobody has tested, so the
 *    allowance is then *spent*: uploads until a 429, held to the arithmetic the docs state — capacity
 *    `limitPerMinute + largestInputBatch()` — with a tolerance only for the tokens that refill during the sweep.
 *
 * Both halves are needed. Without the first, the product refuses its own maximum request; without the second, the
 * fix for the first would have been "remove the limiter".
 */
async function checkUploadAllowance(): Promise<void> {
  console.log('\n── upload allowance ──');
  const session = new Session();
  const one = buildPdf({ pages: 1, label: 'Allowance fixture' });
  const burst = Array.from({ length: MERGE_MAX_FILES }, (_, index) => `load-allowance-${index + 1}.pdf`);
  const staged = await session.uploadAll(burst.map((name) => ({ name, bytes: one })));
  if (staged.rateLimitHits > 0) {
    fail(
      `a fresh session was refused ${staged.rateLimitHits} time(s) while staging a ${MERGE_MAX_FILES}-file batch; the limiter must admit one maximal legal request`,
      { uploads: session.uploads, waitsMs: staged.rateLimitWaitsMs },
    );
  }
  step(`a fresh session staged the ${MERGE_MAX_FILES}-file ceiling in ${staged.ms} ms with no rate-limit refusal`);

  const capacity = UPLOADS_PER_MINUTE + largestInputBatch();
  const sweepLimit = capacity + 25;
  let accepted = MERGE_MAX_FILES;
  let refused: { retryAfterSeconds?: number } | null = null;
  while (accepted < sweepLimit && !refused) {
    const attempt = await session.uploadOnce(`load-allowance-sweep-${accepted + 1}.pdf`, one);
    if ('refused' in attempt) refused = attempt.refused;
    else accepted += 1;
  }
  if (!refused) {
    fail(
      `the bucket never refused: ${accepted} uploads in a row from one session, where the allowance is ${capacity}`,
      { capacity },
    );
  }
  if (accepted < capacity - 5) {
    fail(
      `the bucket refused after ${accepted} upload(s), but the allowance it advertises is ${capacity} (${UPLOADS_PER_MINUTE}/min + a ${largestInputBatch()}-file burst)`,
      { capacity, accepted },
    );
  }
  if (accepted > capacity + 25) {
    fail(
      `the bucket allowed ${accepted} upload(s) before refusing, ${accepted - capacity} more than the ${capacity} it advertises`,
      { capacity, accepted },
    );
  }
  step(
    `the bucket refused after ${accepted} upload(s) — capacity ${capacity} (${UPLOADS_PER_MINUTE}/min + a ${largestInputBatch()}-file burst), refill ${UPLOADS_PER_MINUTE}/min`,
  );

  const retryAfter = refused.retryAfterSeconds ?? 0;
  if (retryAfter < 1 || retryAfter > 60) {
    fail(`the refusal asked the client to retry in ${retryAfter}s, which is not a usable answer`, refused);
  }
  step(`the refusal carries retryAfterSeconds=${retryAfter}s — the wait the missing tokens actually need`);
}

interface LaneResult {
  lane: number;
  uploadMs: number;
  uploadBytes: number;
  rateLimitHits: number;
  createdAt: number;
  startedAt: number;
  completedAt: number;
  outputBytes: number;
  expectedPages: number;
  queue: string;
}

interface ParallelMeasurement {
  lanes: number;
  files: number;
  pagesPerFile: number;
  totalFiles: number;
  totalPages: number;
  submitSpreadMs: number;
  drainMs: number;
  queueMs: ReturnType<typeof summarise>;
  workerMs: ReturnType<typeof summarise>;
  stagingMs: ReturnType<typeof summarise>;
  filesPerSecond: number;
  pagesPerSecond: number;
  queueDepth: { samples: number; max: number; average: number };
  heavyWorkers: number;
  rateLimitHits: number;
  totalOutputBytes: number;
}

/**
 * The parallel stage: `lanes` independent callers, each submitting its own merge at the same moment.
 *
 * This is the half of the measurement the sequential cases cannot see. A single job answers what a merge *costs*; it
 * says nothing about what the queue adds while other jobs are running, whether the worker pool actually saturates, or
 * whether staging several batches at once collides with the limiter. Those are the questions the queue, the pools and
 * the limiter exist for, and the only way to answer them is to send the traffic.
 *
 * Three properties are deliberate rather than incidental:
 *
 *  * **One session per lane.** The upload limiter is per identity, so lanes sharing a session would measure the
 *    limiter instead of the system — and would hide the collision the stage is looking for.
 *  * **The drain is the headline number.** From the first submission to the last output: queue wait plus worker time
 *    plus everything the scheduler adds, which is what a user of a busy system actually waits for. Per-lane p50/p95
 *    are reported beside it, and both come from the API's own timestamps.
 *  * **Depth is observed.** `/health` is sampled every 200 ms by a session of its own while the lanes run. If lanes
 *    were queued behind the workers and no depth was ever seen, the stage fails: "eight jobs at once" has to be a
 *    fact about the queue, not an assumption about it.
 */
async function runParallel(spec: Case, lanes: number, heavyWorkers: number): Promise<ParallelMeasurement> {
  const { files, pages } = spec;
  console.log(
    `\n── parallel: ${lanes} caller(s) × ${files} file(s) × ${pages} page(s) = ${lanes * files} files, ${lanes * files * pages} pages ──`,
  );

  const generateStarted = performance.now();
  const fixtures = Array.from({ length: lanes }, () => {
    const generated: Array<{ name: string; bytes: Uint8Array; label: string }> = [];
    for (let index = 0; index < files; index += 1) {
      const label = `Lane fixture ${String(index + 1).padStart(3, '0')}`;
      generated.push({
        name: `lane-${String(index + 1).padStart(3, '0')}.pdf`,
        bytes: buildPdf({ pages, label }),
        label,
      });
    }
    return generated;
  });
  step(`built ${lanes} × ${files} fixture(s) locally in ${Math.round(performance.now() - generateStarted)} ms`);

  const depths: number[] = [];
  let sampling = true;
  const probe = new Session();
  const sampler = (async () => {
    while (sampling) {
      try {
        const health = await probe.json<{ checks: { pools: Record<string, { queueDepth?: number }> } }>('/health');
        depths.push(health.checks.pools.heavy?.queueDepth ?? 0);
      } catch {
        // A probe that fails is not the measurement: `/health` is allowed to be briefly unreadable under load.
      }
      await Bun.sleep(200);
    }
  })();

  const expectedQueue =
    files > ESCALATES_ABOVE_FILES || files * pages > ESCALATES_ABOVE_PAGES ? 'pdf-heavy' : 'pdf-light';
  const laneResults: LaneResult[] = [];
  try {
    const settled = await Promise.all(
      fixtures.map(async (generated, lane) => {
        const session = new Session();
        const expectedPages = generated.reduce((total, file) => total + countPagesInPdf(file.bytes), 0);
        const upload = await session.uploadAll(generated);
        const created = await session.json<JobView>('/api/v1/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: 'merge', files: upload.ids, options: { bookmarks: 'keep' } }),
        });
        if (created.queue !== expectedQueue) {
          fail(`lane ${lane + 1} was queued on ${created.queue}, expected ${expectedQueue}`, created);
        }
        // `POST /jobs` answers with the queue and the events URL, not with the row's `createdAt` — so the submit time
        // is read from the job itself, which is where every other timestamp in this measurement comes from. Mixing in
        // this process's clock would put a network round trip inside the drain and call it queue latency.
        const submitted = await session.json<JobView>(`/api/v1/jobs/${created.id}`);
        const job = await waitForJob(session, created.id, `      [lane ${lane + 1}] `);
        const result = await session.json<{ metrics?: Record<string, unknown> }>(`/api/v1/jobs/${job.id}/result`);
        const budgetSeconds =
          typeof result.metrics?.budgetSeconds === 'number' ? (result.metrics.budgetSeconds as number) : null;
        const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
        const completedAt = job.completedAt ? Date.parse(job.completedAt) : Number.NaN;
        // Every lane's output goes through the same checks as a sequential case: a throughput number next to an
        // unverified file is the one result worth less than no result.
        const verified = await verifyOutput(session, job, generated, expectedPages, {
          workerMs: Number.isNaN(startedAt) || Number.isNaN(completedAt) ? null : completedAt - startedAt,
          budgetSeconds,
          files,
        });
        const laneResult: LaneResult = {
          lane: lane + 1,
          uploadMs: upload.ms,
          uploadBytes: upload.bytes,
          rateLimitHits: upload.rateLimitHits,
          createdAt: Date.parse(submitted.createdAt),
          startedAt,
          completedAt,
          outputBytes: verified.bytes.length,
          expectedPages,
          queue: job.queue,
        };
        return laneResult;
      }),
    );
    laneResults.push(...settled);
  } finally {
    sampling = false;
    await sampler;
  }

  const refused = laneResults.filter((lane) => lane.rateLimitHits > 0);
  if (refused.length > 0) {
    fail(
      `${refused.length} lane(s) were rate limited while staging one batch each; lanes are separate identities, so no lane should meet the limiter at all`,
      refused.map((lane) => ({ lane: lane.lane, hits: lane.rateLimitHits })),
    );
  }
  step(`all ${lanes} lane(s) staged their batch in parallel without a single rate-limit refusal`);

  const submitTimes = laneResults.map((lane) => lane.createdAt);
  const ends = laneResults.map((lane) => lane.completedAt);
  const queueWaits = laneResults.map((lane) => lane.startedAt - lane.createdAt);
  const workerTimes = laneResults.map((lane) => lane.completedAt - lane.startedAt);
  const staging = laneResults.map((lane) => lane.uploadMs);
  const firstSubmit = Math.min(...submitTimes);
  const drainMs = Math.max(...ends) - firstSubmit;
  const totalFiles = lanes * files;
  const totalPages = laneResults.reduce((total, lane) => total + lane.expectedPages, 0);

  if (drainMs <= 0) fail('the drain measured zero milliseconds, which cannot be right for a finished set of jobs');
  step(
    `all ${lanes} job(s) finished — submit spread ${Math.max(...submitTimes) - firstSubmit} ms · drain ${drainMs} ms · queue p50 ${percentile(queueWaits, 0.5)} ms / p95 ${percentile(queueWaits, 0.95)} ms · worker p50 ${percentile(workerTimes, 0.5)} ms / p95 ${percentile(workerTimes, 0.95)} ms`,
  );
  step(
    `${totalFiles} files and ${totalPages} pages in ${drainMs} ms — ${(totalFiles / (drainMs / 1000)).toFixed(1)} files/s, ${(totalPages / (drainMs / 1000)).toFixed(0)} pages/s`,
  );

  const depthMax = depths.length > 0 ? Math.max(...depths) : 0;
  const depthAverage = depths.length > 0 ? depths.reduce((total, value) => total + value, 0) / depths.length : 0;
  if (lanes > heavyWorkers && depthMax === 0) {
    fail(
      `${lanes} lane(s) ran with ${heavyWorkers} heavy worker(s) and the queue depth never rose above zero — the stage did not exercise a queue`,
      { samples: depths.length },
    );
  }
  step(
    depthMax > 0
      ? `the queue depth was seen at ${depthMax} (${depths.length} sample(s), average ${depthAverage.toFixed(2)}) — the lanes really did wait for each other`
      : `no depth was seen, and none was expected: ${lanes} lane(s) against ${heavyWorkers} heavy worker(s)`,
  );

  return {
    lanes,
    files,
    pagesPerFile: pages,
    totalFiles,
    totalPages,
    submitSpreadMs: Math.max(...submitTimes) - firstSubmit,
    drainMs,
    queueMs: summarise(queueWaits),
    workerMs: summarise(workerTimes),
    stagingMs: summarise(staging),
    filesPerSecond: Math.round((totalFiles / (drainMs / 1000)) * 10) / 10,
    pagesPerSecond: Math.round(totalPages / (drainMs / 1000)),
    queueDepth: { samples: depths.length, max: depthMax, average: Math.round(depthAverage * 100) / 100 },
    heavyWorkers,
    rateLimitHits: laneResults.reduce((total, lane) => total + lane.rateLimitHits, 0),
    totalOutputBytes: laneResults.reduce((total, lane) => total + lane.outputBytes, 0),
  };
}

async function main(): Promise<void> {
  console.log(`pdf-tools merge load measurement → ${api}\n`);

  // The measurement enrolls its own sessions and drives merge jobs through them, so a stack that serves no caller
  // without an account cannot measure anything here (`e2e/lib/stack-gap.ts`).
  await requireAnonymousUse(api, 'the load measurement enrolls anonymous sessions and runs merge jobs through them');

  // One session for the sequential measurement, and a fresh one for each contract check: a check that inherits
  // another check's spent allowance would be measuring the limiter's memory rather than the claim it names.
  const session = new Session();
  const health = await session.json<{
    status: string;
    checks: { pools: Record<string, { workers: number; queueDepth?: number }> };
  }>('/health');
  if (health.status !== 'ok') fail(`/health reports "${health.status}"`, health);
  const heavyWorkers = health.checks.pools.heavy?.workers ?? 0;
  if (heavyWorkers === 0) {
    fail('no worker is registered for the heavy pool; a >20-file merge would queue forever. Start worker-heavy.');
  }
  step(
    `api healthy (${Object.entries(health.checks.pools)
      .map(([pool, info]) => `${pool}:${info.workers}`)
      .join(' ')})`,
  );

  // The plan's own ceiling, read from the API rather than reimplemented here: a script that guesses the limit
  // measures a different product than the one that is running.
  const me = await session.json<{ planId: string; planSource: string; entitlements: { maxFiles: number } }>(
    '/api/v1/me',
  );
  const maxFiles = me.entitlements?.maxFiles ?? 5;
  step(`session plan ${me.planId} (${me.planSource}); it may attach ${maxFiles} files per job`);
  if (args.cases.some((spec) => spec.files > maxFiles)) {
    fail(`a case asks for more files than the ${me.planId} plan allows (${maxFiles})`);
  }
  if (args.cases.some((spec) => spec.files > MERGE_MAX_FILES)) {
    fail(`merge accepts at most ${MERGE_MAX_FILES} files per job, so that is the ceiling a case can measure`);
  }

  if (args.lanes > 0) {
    if (args.laneCase.files > maxFiles) {
      fail(`a lane asks for ${args.laneCase.files} files, more than the ${me.planId} plan allows (${maxFiles})`);
    }
    if (args.laneCase.files < 2 || args.laneCase.files > MERGE_MAX_FILES) {
      fail(`a lane must submit 2–${MERGE_MAX_FILES} files, so --lane-case cannot be ${args.laneCase.files}`);
    }
  }

  for (const spec of args.cases) measurements.push(await runCase(spec, session));
  let parallel: ParallelMeasurement | null = null;
  if (args.lanes > 0) {
    parallel = await runParallel(args.laneCase, args.lanes, heavyWorkers);
  } else {
    step('the parallel stage was not run (--lanes 0): this is a single-job measurement only');
  }
  if (args.skipCeiling) {
    step('the contract-ceiling check was skipped (--skip-ceiling); it costs 51 uploads');
  } else {
    await checkCeiling(new Session());
  }
  if (args.skipLimiter) {
    step("the upload-allowance check was skipped (--skip-limiter); it spends one session's whole allowance");
  } else {
    await checkUploadAllowance();
  }

  const judged = measurements.filter((entry) => entry.msPerPage != null);
  if (args.thresholdMsPerPage > 0) {
    const over = judged.filter((entry) => (entry.msPerPage ?? 0) > args.thresholdMsPerPage);
    if (over.length > 0) {
      fail(
        `${over.length} case(s) exceeded ${args.thresholdMsPerPage} ms per page`,
        over.map((entry) => ({ files: entry.files, pages: entry.totalPages, msPerPage: entry.msPerPage })),
      );
    }
    step(`every case is within the ${args.thresholdMsPerPage} ms/page threshold`);
  } else {
    step('no ms/page threshold set: the run is a measurement, and the only time assertion is the job budget');
  }

  console.log('\nfiles  pages  upload     429s  wait(s)  queue      worker     ms/file  ms/page  output');
  for (const entry of measurements) {
    console.log(
      [
        String(entry.files).padEnd(6),
        String(entry.totalPages).padEnd(6),
        `${entry.uploadMs} ms`.padEnd(10),
        String(entry.uploadRateLimitHits).padEnd(5),
        `${entry.uploadRateLimitHits > 0 ? Math.round(entry.uploadRateLimitWaitsMs / 1000) : '—'}`.padEnd(8),
        `${entry.queueMs ?? '?'} ms`.padEnd(10),
        `${entry.workerMs ?? '?'} ms`.padEnd(10),
        String(entry.msPerFile ?? '?').padEnd(8),
        String(entry.msPerPage ?? '?').padEnd(8),
        `${(entry.outputBytes / 1024 / 1024).toFixed(2)} MB`,
      ].join(' '),
    );
  }

  if (parallel) {
    const line = (label: string, values: { min: number; p50: number; p95: number; max: number }): string =>
      `  ${label.padEnd(8)} min ${String(values.min).padStart(6)} ms · p50 ${String(values.p50).padStart(6)} ms · p95 ${String(values.p95).padStart(6)} ms · max ${String(values.max).padStart(6)} ms`;
    console.log('\nparallel stage');
    console.log(
      `  ${parallel.lanes} caller(s) × ${parallel.files} file(s) × ${parallel.pagesPerFile} page(s) = ${parallel.totalFiles} files / ${parallel.totalPages} pages`,
    );
    console.log(
      `  submit spread ${parallel.submitSpreadMs} ms · drain ${parallel.drainMs} ms · ${parallel.filesPerSecond} files/s · ${parallel.pagesPerSecond} pages/s`,
    );
    console.log(line('queue', parallel.queueMs));
    console.log(line('worker', parallel.workerMs));
    console.log(line('staging', parallel.stagingMs));
    console.log(
      `  queue depth max ${parallel.queueDepth.max} over ${parallel.queueDepth.samples} sample(s) (average ${parallel.queueDepth.average}) · ${parallel.heavyWorkers} heavy worker(s)`,
    );
  }

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: api,
        plan: me.planId,
        planSource: me.planSource,
        thresholdMsPerPage: args.thresholdMsPerPage || null,
        uploadsPerMinute: UPLOADS_PER_MINUTE,
        cases: measurements,
        parallel,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\nload measurement passed — ${measurements.length} sequential case(s)${parallel ? ` and ${parallel.lanes} parallel lane(s)` : ''} against ${api}`,
  );
  console.log(`Measurements: ${args.jsonPath}`);
}

await main();
