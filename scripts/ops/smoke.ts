import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_VERSION, TOOLS } from '@pdftools/contracts';
import { countPdfPages } from '../../e2e/lib/pdf-inspect';
import { requireAnonymousUse } from '../../e2e/lib/stack-gap';
import { buildPdf } from '../dev/pdf-writer';

/**
 * The deploy smoke (`docs/0-CICD.md` §10): nine steps over HTTP, against the deployment that is about to take traffic.
 *
 * ```text
 *   bun run ops:smoke -- --base https://pdf.example.test
 *   bun run ops:smoke -- --base http://localhost:8080 --ttl-wait --ttl-minutes 2
 *   bun run ops:smoke -- --base http://localhost:8080 --strict --ttl-wait --ttl-minutes 1   # what CI runs
 * ```
 *
 * It builds its own inputs rather than reaching for `fixtures/generated/`: a deployment host has no fixtures (they are
 * generated, never committed — `docs/0-CICD.md` §9), so a smoke that needed one would be a smoke nobody can run on the
 * machine that matters. The two documents and the text file are written by the repository's own writer
 * (`scripts/dev/pdf-writer.ts`), which is the same code the fixtures are built from and therefore not a second
 * opinion about what a PDF is.
 *
 * | Step | What it proves | Reading |
 * |---|---|---|
 * | 1 `health` | the API, its database, its Redis and all four pools are up | `status: ok`, and each of `light`, `office`, `heavy`, `ocr` reports at least one worker — which is also where a **missing engine** shows itself, because a pool refuses to boot without one |
 * | 2 `upload` | ingest works and its own page count is right | `201`, and `pages === 2` for a document written with two |
 * | 3 `merge` | a job is queued and finished by a real worker | `202`, then `COMPLETED` **within 30 s** — the figure §10 has always named, and a separate deadline from `--timeout` so a slow pool cannot hide behind a generous one |
 * | 4 `download` | the bytes the service produced are the document it promised | `200`, `application/pdf`, `%PDF-`, and the page count **re-parsed from the bytes** (`3` from a 2-page and a 1-page input) |
 * | 5 `office` | LibreOffice works in the deployed office image | a `.txt` uploaded as an office document converts; the most common deploy surprise is a font or a filter that is missing from the image |
 * | 6 `ocr` | Tesseract and its language data are in the deployed OCR image | a scanned page (pixels, no text layer) comes back as a searchable PDF, the job reports a page processed, and **`pdf-to-text` reads the word the scan was written with back out of it** — a different engine than the one that wrote the layer, because "the job completed" alone would pass on an empty recognition |
 * | 7 `catalog` | the running build is the build this checkout describes | `catalogVersion` equals the `CATALOG_VERSION` this checkout exports, and every tool this checkout declares is in the response and `enabled` — the check that catches a stale image behind a current tag |
 * | 8 `refusals` | a bad input is refused by the API rather than by an engine | two shapes, both `4xx` with `UNSUPPORTED_FILE_TYPE`: bytes no type detector can name (refused at **upload**) and a text file handed to `merge` (refused at **job creation**) |
 * | 9 `retention` | retention is enforced, not just documented | with `--ttl-wait`: a job created for `--ttl-minutes` (2 by default) reaches `EXPIRED` and its download answers `410 JOB_EXPIRED` |
 *
 * ## The two legs that can report themselves *not run*
 *
 * A smoke cannot invent a scan, and it should not pretend it checked retention without waiting for it:
 *
 * * **`ocr`** needs a page of pixels. In this repository those are generated **inside the `worker-ocr` container**
 *   (`bun run fixtures && bun run fixtures:scan`, which needs Ghostscript and therefore cannot run on a host — see
 *   `scripts/dev/make-scan-fixture.ts`). So the scan is taken from `--scan <path>`, else from
 *   `fixtures/generated/ocr-scan-eng-raster.pdf` if that file exists, and otherwise the step is reported as a **named
 *   gap** with the one-line repair rather than passed. Exit code stays 0 — a deployment is not wrong because the
 *   operator ran the smoke from a machine without fixtures — but the gap is printed and recorded, because a step that
 *   did not run must never read as a step that passed. `--strict` is the other half of that rule: it makes **any** gap
 *   exit 1, and it is what CI runs, because the job that uses it starts all four pools and generates the scan fixture
 *   first — so on that stack a gap is a gap in the job rather than a fixture missing from an operator's laptop.
 * * **`retention`** waits out a retention window for real, so it is off by default. `--ttl-wait` turns it on, and the
 *   window is one the run **asks for** (`--ttl-minutes`, 2 by default) rather than one it reads off the deployment:
 *   `POST /jobs` takes `retainMinutes`, the API caps it at the plan's own limit, and a job that expires *earlier* than
 *   asked still satisfies the reading. Nothing here needs to know `JOB_TTL_MINUTES`. It reads `EXPIRED` and `410`, not
 *   the job directory: the directory lives in the API's volume, which is not on a host path.
 *
 * An installation that requires an account reports a **named gap** (exit 3) before any step runs: every request here is
 * an anonymous session, and a smoke with no credentials would otherwise be a run of 401s dressed as a deploy failure.
 */

interface Args {
  base: string;
  jsonPath: string;
  timeoutSeconds: number;
  scan: string | null;
  ttlWait: boolean;
  ttlMinutes: number;
  /** Every step has to run: a gap is a failure, not a note. For a job whose stack is complete (CI), not for a laptop. */
  strict: boolean;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const DEFAULT_SCAN = join(REPO_ROOT, 'fixtures', 'generated', 'ocr-scan-eng-raster.pdf');

/** The word `ocr-scan-eng-raster.pdf` was written with; the golden case reads the same one back. */
const SCAN_WORD = 'fixture';

/** §10's own number for the merge leg, kept apart from the caller's patience. */
const MERGE_DEADLINE_SECONDS = 30;

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  jsonPath: value('--json') ?? 'e2e/artifacts/smoke.json',
  timeoutSeconds: Number(value('--timeout') ?? 180),
  scan: value('--scan') ?? (existsSync(DEFAULT_SCAN) ? DEFAULT_SCAN : null),
  ttlWait: argv.includes('--ttl-wait'),
  ttlMinutes: Number(value('--ttl-minutes') ?? 2),
  strict: argv.includes('--strict'),
};

const checks: Array<{ check: string; detail: string }> = [];
const gaps: string[] = [];
const measurements: Record<string, unknown> = {};
let serverErrors = 0;

function step(check: string, detail: string): void {
  checks.push({ check, detail });
  console.log(`  ✓ ${detail}`);
}

function gap(check: string, detail: string): void {
  gaps.push(`${check}: ${detail}`);
  console.log(`  ⊘ not run — ${detail}`);
}

function note(detail: string): void {
  console.log(`  · ${detail}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) {
    console.error(`  ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
  }
  if (checks.length > 0) console.error(`\nreached:\n${checks.map((entry) => `  · ${entry.detail}`).join('\n')}`);
  process.exit(1);
}

let cookie = '';
/** Only sent when this environment has the token to send: on a deployment the header is ignored, and saying so is the point. */
const devPlanToken = process.env.DEV_PLAN_TOKEN ?? '';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (devPlanToken) {
    headers.set('x-dev-plan', 'pro');
    headers.set('x-dev-plan-token', devPlanToken);
  }
  const response = await fetch(`${args.base}${path}`, { ...init, headers, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    if (pair?.startsWith('pdft_session=')) cookie = pair;
  }
  if (response.status >= 500) {
    serverErrors += 1;
    const text = await response.text();
    fail(
      `${init.method ?? 'GET'} ${path} answered ${response.status} — a deploy smoke treats any 5xx as a failure`,
      text.slice(0, 600),
    );
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  const text = await response.text();
  if (!response.ok) fail(`${init?.method ?? 'GET'} ${path} returned ${response.status}`, text.slice(0, 600));
  return (text ? JSON.parse(text) : undefined) as T;
}

interface HealthReport {
  status: string;
  version: string;
  checks: {
    database: { ok: boolean; latencyMs: number };
    redis: { ok: boolean; latencyMs: number };
    storage: { ok: boolean; tempDir: string; freeBytes: number | null };
    pools: Record<string, { workers: number; queueDepth: number | null }>;
  };
}

interface UploadedFile {
  id: string;
  detectedType?: string;
  pages: number | null;
}

interface JobView {
  id: string;
  status: string;
  error: { code: string; message: string } | null;
  metrics?: Record<string, unknown>;
}

interface ApiError {
  error: { code: string; message: string };
}

/** `/jobs/:id/result` — the parts a caller can fetch, and the metrics the handler measured while making them. */
interface JobResult {
  parts: Array<{ name: string; bytes: number; pages?: number[] }>;
  metrics: Record<string, unknown>;
}

async function uploadBytes(bytes: Uint8Array, name: string, mime: string): Promise<Response> {
  const form = new FormData();
  form.append('kind', 'input');
  // Copied into a plain `ArrayBuffer`-backed view: `buildPdf` types its output as `Uint8Array<ArrayBufferLike>`, which
  // `File` will not take, and a copy of two kilobytes is cheaper than a cast that hides where the bytes came from.
  form.append('file', new File([new Uint8Array(bytes)], name, { type: mime }));
  return call('/api/v1/files', { method: 'POST', body: form });
}

async function upload(bytes: Uint8Array, name: string, mime: string): Promise<UploadedFile> {
  const response = await uploadBytes(bytes, name, mime);
  const text = await response.text();
  if (response.status !== 201) fail(`uploading ${name} returned ${response.status}`, text.slice(0, 600));
  return JSON.parse(text) as UploadedFile;
}

async function runJob(
  tool: string,
  files: string[],
  options: Record<string, unknown>,
  deadlineSeconds: number,
  retainMinutes?: number,
): Promise<JobView> {
  const created = await json<JobView>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ tool, files, options, ...(retainMinutes == null ? {} : { retainMinutes }) }),
    headers: { 'content-type': 'application/json' },
  });
  const deadline = Date.now() + deadlineSeconds * 1000;
  let last: JobView | null = null;
  while (Date.now() < deadline) {
    const job = await json<JobView>(`/api/v1/jobs/${created.id}`);
    last = job;
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') return job;
    await Bun.sleep(400);
  }
  fail(`${tool} did not finish within ${deadlineSeconds}s`, last);
}

async function download(jobId: string): Promise<Uint8Array> {
  const response = await call(`/api/v1/jobs/${jobId}/download`);
  if (!response.ok) fail(`downloading ${jobId} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
  console.log(`smoke → ${args.base}`);
  if (devPlanToken)
    note('DEV_PLAN_TOKEN is set here, so this run asks for a plan — a deployment has none, and ignores the header');

  await requireAnonymousUse(args.base, 'the deploy smoke');

  // ── 1. Health, and the four pools ─────────────────────────────────────────
  console.log('\n1. health');
  const health = await json<HealthReport>('/health');
  if (health.status !== 'ok') fail(`/health reports ${health.status}`, health.checks);
  for (const pool of ['light', 'office', 'heavy', 'ocr']) {
    const entry = health.checks.pools[pool];
    if (!entry) fail(`/health reports no pool named ${pool}`, Object.keys(health.checks.pools));
    if (entry.workers < 1) {
      fail(
        `the ${pool} pool reports ${entry.workers} worker(s) — a pool with a missing engine never boots, which is how this step covers every engine binary the deployment needs`,
        entry,
      );
    }
  }
  const ready = await call('/health/ready');
  if (!ready.ok) fail(`/health/ready answered ${ready.status}`);
  measurements.health = {
    version: health.version,
    databaseLatencyMs: health.checks.database.latencyMs,
    redisLatencyMs: health.checks.redis.latencyMs,
    freeBytes: health.checks.storage.freeBytes,
    pools: health.checks.pools,
  };
  step(
    'health',
    `status ok, version ${health.version}, database ${health.checks.database.latencyMs} ms, redis ${health.checks.redis.latencyMs} ms`,
  );
  step(
    'health',
    `all four pools report workers: ${Object.entries(health.checks.pools)
      .map(([name, p]) => `${name} ${p.workers}`)
      .join(', ')}`,
  );

  // ── 2. Upload, with the page count the API measures for itself ────────────
  console.log('\n2. upload');
  const twoPages = buildPdf({ pages: 2, label: 'Smoke fixture A' });
  const onePage = buildPdf({ pages: 1, label: 'Smoke fixture B' });
  const first = await upload(twoPages, 'smoke-two.pdf', 'application/pdf');
  const second = await upload(onePage, 'smoke-one.pdf', 'application/pdf');
  if (first.pages !== 2) fail(`the two-page upload reports pages: ${first.pages}`, first);
  step('upload', `a two-page document uploaded as ${first.id} and reports pages: 2 (the other: ${second.id})`);

  // ── 3. Merge, on a real worker, inside §10's 30 seconds ───────────────────
  console.log('\n3. merge');
  const merge = await runJob('merge', [first.id, second.id], {}, MERGE_DEADLINE_SECONDS);
  if (merge.status !== 'COMPLETED') fail(`merge ended ${merge.status}`, merge.error);
  step('merge', `two inputs merged to COMPLETED within ${MERGE_DEADLINE_SECONDS}s`);

  // ── 4. The bytes, re-parsed by this run's own reader ──────────────────────
  console.log('\n4. download');
  const merged = await download(merge.id);
  const header = new TextDecoder().decode(merged.slice(0, 5));
  if (header !== '%PDF-') fail('the download does not start with %PDF-', merged.slice(0, 16));
  const pages = countPdfPages(merged);
  if (pages !== 3)
    fail(`the merged document has ${pages} page(s), and its two inputs had 2 and 1`, { pages, bytes: merged.length });
  measurements.merge = { bytes: merged.length, pages };
  step('download', `the merged document is a ${merged.length}-byte PDF whose page count re-parses as 3`);

  // ── 5. The office engine, in the deployed office image ────────────────────
  console.log('\n5. office');
  const text = new TextEncoder().encode('Smoke fixture\nLibreOffice converts this line.\n');
  const document = await upload(text, 'smoke-office.txt', 'text/plain');
  const office = await runJob('office-to-pdf', [document.id], {}, args.timeoutSeconds);
  if (office.status !== 'COMPLETED') fail(`office-to-pdf ended ${office.status}`, office.error);
  const converted = await download(office.id);
  const convertedPages = countPdfPages(converted);
  if (convertedPages < 1) fail('the converted text file produced a PDF with no pages');
  step('office', `a text file converted in the office pool to a ${convertedPages}-page, ${converted.length}-byte PDF`);

  // ── 6. Recognition, on pixels, with the language data in the image ────────
  console.log('\n6. ocr');
  if (!args.scan) {
    gap(
      'ocr',
      'no scan fixture on this host — pass --scan <file>, or generate one with `bun run fixtures && bun run fixtures:scan` ' +
        '(they rasterise inside the worker-ocr container, so Ghostscript is not needed here)',
    );
  } else {
    const scan = new Uint8Array(await Bun.file(args.scan).arrayBuffer());
    const scanned = await upload(scan, 'smoke-scan.pdf', 'application/pdf');
    const ocr = await runJob('ocr', [scanned.id], { languages: ['eng'] }, args.timeoutSeconds);
    if (ocr.status !== 'COMPLETED') fail(`ocr ended ${ocr.status}`, ocr.error); // The handler's own measurement, read from `/result` rather than inferred from "the job completed": the OCR
    // handler fails a job whose page came back empty, so this is the second of two independent readings that a page
    // was really recognised rather than skipped.
    const ocrResult = await json<JobResult>(`/api/v1/jobs/${ocr.id}/result`);
    const processed = Number(ocrResult.metrics?.pagesProcessed ?? 0);
    if (processed < 1) {
      fail(`the ocr job reports pagesProcessed: ${processed}, so no page was recognised at all`, ocrResult.metrics);
    }
    const recognised = await download(ocr.id);

    // The text layer is read back by a **different engine** than the one that wrote it: `pdf-to-text` runs Poppler in
    // the light pool, and this host has no engine of its own to read a subset font's `ToUnicode` map with. Half the point
    // of the step is that the layer exists, and the other half is that the words in it are the page's.
    const layer = await upload(recognised, 'smoke-scan-recognised.pdf', 'application/pdf');
    const extracted = await runJob('pdf-to-text', [layer.id], {}, args.timeoutSeconds);
    if (extracted.status !== 'COMPLETED')
      fail(`pdf-to-text over the recognised page ended ${extracted.status}`, extracted.error);
    const text = new TextDecoder().decode(await download(extracted.id)).toLowerCase();
    if (!text.includes(SCAN_WORD)) {
      fail(
        `the recognised page carries no text layer containing "${SCAN_WORD}" when another engine reads it — a completed job with an empty recognition is exactly what this step is here to tell apart`,
        text.slice(0, 400),
      );
    }
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    measurements.ocr = {
      scan: args.scan,
      scanBytes: scan.length,
      recognisedBytes: recognised.length,
      pagesProcessed: processed,
      excerpt,
    };
    step(
      'ocr',
      `a scan (${scan.length} bytes, no text layer) recognised ${processed} page into ${recognised.length} bytes`,
    );
    step('ocr', `pdf-to-text reads "${SCAN_WORD}" back out of the layer: ${excerpt}`);
  }

  // ── 7. The catalog, against this checkout ────────────────────────────────
  console.log('\n7. catalog');
  interface ServedTool {
    id: string;
    enabled: boolean;
    input: { accepts: string[] };
    optionsUi: Array<{ key: string }>;
  }
  const catalog = await json<{ catalogVersion: number; plan: { id: string; maxFileMb: number }; tools: ServedTool[] }>(
    '/api/v1/tools',
  );
  if (catalog.catalogVersion !== CATALOG_VERSION) {
    fail(
      `the deployment serves catalog ${catalog.catalogVersion} where this checkout is ${CATALOG_VERSION} — the running image is not the build being deployed`,
    );
  }
  // The version alone would not catch much: `CATALOG_VERSION` is a constant that has never moved, so a stale image
  // would answer the same number. The registry is what actually drifts, so the id set, each tool's accepted input types
  // and the options its panel renders are compared with this checkout's own declarations.
  const served = new Map(catalog.tools.map((tool) => [tool.id, tool]));
  const missing = TOOLS.filter((tool) => !served.has(tool.id)).map((tool) => tool.id);
  const extra = [...served.keys()].filter((id) => !TOOLS.some((tool) => tool.id === id));
  const disabled = TOOLS.filter((tool) => served.get(tool.id)?.enabled === false).map((tool) => tool.id);
  const drifted = TOOLS.filter((tool) => {
    const answered = served.get(tool.id);
    if (!answered) return false;
    const options = (fields: Array<{ key: string }>) =>
      fields
        .map((field) => field.key)
        .sort()
        .join(',');
    return (
      JSON.stringify(answered.input.accepts) !== JSON.stringify(tool.input.accepts) ||
      options(answered.optionsUi) !== options(tool.optionsUi)
    );
  }).map((tool) => tool.id);
  if (missing.length > 0) fail(`the deployment's catalog is missing ${missing.join(', ')}`);
  if (extra.length > 0)
    fail(`the deployment's catalog serves ${extra.join(', ')}, which this checkout does not declare`);
  if (disabled.length > 0) fail(`the deployment's catalog disables ${disabled.join(', ')}`);
  if (drifted.length > 0) {
    fail(
      `these tools answer with different input types or options than this checkout declares: ${drifted.join(', ')} — the running image is not the build being deployed`,
    );
  }
  measurements.catalog = {
    catalogVersion: catalog.catalogVersion,
    tools: catalog.tools.length,
    plan: catalog.plan.id,
  };
  step(
    'catalog',
    `catalog ${catalog.catalogVersion} matches this checkout: ${TOOLS.length} tools, same ids, same input types, same options`,
  );

  // ── 8. Two refusals, at the two layers that can make them ────────────────
  console.log('\n8. refusals');
  const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x7f, 0x00, 0xff, 0xfe, 0x00, 0x00]);
  const junkResponse = await uploadBytes(junk, 'smoke-not-a-document.pdf', 'application/pdf');
  if (junkResponse.status >= 500) fail(`an unnameable upload answered ${junkResponse.status}`);
  const junkBody = (await junkResponse.json()) as ApiError;
  if (junkResponse.status !== 415 || junkBody.error?.code !== 'UNSUPPORTED_FILE_TYPE') {
    fail(`unnameable bytes were answered ${junkResponse.status} ${junkBody.error?.code ?? ''}`, junkBody);
  }
  const textAgain = await upload(text, 'smoke-merge-input.txt', 'text/plain');
  const refused = await call('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ tool: 'merge', files: [textAgain.id, first.id], options: {} }),
    headers: { 'content-type': 'application/json' },
  });
  if (refused.status >= 500) fail(`a merge of a text file answered ${refused.status}`);
  const refusedBody = (await refused.json()) as ApiError;
  if (refused.status !== 415 || refusedBody.error?.code !== 'UNSUPPORTED_FILE_TYPE') {
    fail(`a text file handed to merge was answered ${refused.status} ${refusedBody.error?.code ?? ''}`, refusedBody);
  }
  step(
    'refusals',
    `415 ${junkBody.error.code} for bytes no detector can name, and 415 ${refusedBody.error.code} for the wrong type at job creation`,
  );

  // ── 9. Retention, only when the run is told the window ───────────────────
  console.log('\n9. retention');
  if (!args.ttlWait) {
    gap(
      'retention',
      `pass --ttl-wait to ask for a ${args.ttlMinutes}-minute retention and wait it out (~${Math.round((args.ttlMinutes * 60 + 120) / 60)} minutes)`,
    );
  } else {
    // A job of its own, so the wait is about the window this run asked for rather than about the jobs above — and one
    // whose result nobody wants, since the point is that it stops existing.
    const expiring = await runJob('merge', [first.id, second.id], {}, MERGE_DEADLINE_SECONDS, args.ttlMinutes);
    if (expiring.status !== 'COMPLETED') fail(`the retention job ended ${expiring.status}`, expiring.error);
    const waitSeconds = args.ttlMinutes * 60 + 120;
    note(
      `waiting up to ${waitSeconds}s for the ${args.ttlMinutes}-minute retention to take effect (plus a sweep grace)`,
    );
    const deadline = Date.now() + waitSeconds * 1000;
    let expired: JobView | null = null;
    while (Date.now() < deadline) {
      const job = await json<JobView>(`/api/v1/jobs/${expiring.id}`);
      if (job.status === 'EXPIRED') {
        expired = job;
        break;
      }
      await Bun.sleep(5_000);
    }
    if (!expired) {
      fail(`the job was still ${(await json<JobView>(`/api/v1/jobs/${expiring.id}`)).status} after ${waitSeconds}s`);
    }
    const gone = await call(`/api/v1/jobs/${expiring.id}/download`);
    const goneBody = (await gone.json()) as ApiError;
    if (gone.status !== 410 || goneBody.error?.code !== 'JOB_EXPIRED') {
      fail(`a download of the expired job answered ${gone.status} ${goneBody.error?.code ?? ''}`, goneBody);
    }
    note(
      'the job directory itself lives in the API volume, which is not readable from here: 410 is the reading this run can take',
    );
    measurements.retention = { requestedMinutes: args.ttlMinutes, status: expired.status, downloadStatus: gone.status };
    step(
      'retention',
      `a job asked for ${args.ttlMinutes} minute(s) reached EXPIRED, and its download answers 410 ${goneBody.error.code}`,
    );
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log(`\n${checks.length} step(s) passed · ${gaps.length} not run · ${serverErrors} server error(s)`);
  for (const entry of gaps) console.log(`  ⊘ ${entry}`);
  await Bun.write(args.jsonPath, `${JSON.stringify({ base: args.base, checks, gaps, measurements }, null, 2)}\n`);
  console.log(`readings: ${args.jsonPath}`);
  if (gaps.length > 0) {
    console.log('\nsmoke passed, with steps that did not run — they are named above and must not be read as green');
    if (args.strict) {
      // The JSON above is written before this exits: a failed run's readings are the useful ones, and a `--strict`
      // failure is a run whose gap has to be readable from the artifact as well as the log.
      console.error(
        `\n--strict: this run requires every step, and ${gaps.length} did not run:\n${gaps
          .map((entry) => `  ⊘ ${entry}`)
          .join('\n')}`,
      );
      process.exit(1);
    }
  } else {
    console.log('smoke passed — every step ran');
  }
}

await main();
