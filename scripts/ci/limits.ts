import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAnonymousUse } from '../../e2e/lib/stack-gap';

/**
 * Per-tool rate limits, measured against the running API.
 *
 *   bun run test:limits
 *
 * `apps/api` charges two buckets per job: the per-identity one every request pays, and — for a tool that declares
 * `rateLimit` in the registry — a second, tighter one for that tool. `unlock` is the only tool that declares one, and
 * the reason is not load: it is the single tool in the catalogue that takes a guess at a password that is not the
 * caller's. A limit like that is worth exactly what it is measured to be worth, and nothing in the unit tests, the
 * golden suite or the falsification stage can see it: a unit test can assert the *number* in the registry, and only a
 * live stack can show that the number refuses a request.
 *
 * Five claims:
 *
 *   1. the bucket lets a small batch through — an allowance that refused a legitimate request would be a bug that
 *      reads as security (`0-API.md` §7). Six a minute is the registry's number, and six jobs are submitted **one at a
 *      time** and each one waited out, so the plan's five-job concurrency ceiling is never the limit that answers;
 *   2. the request *after* the allowance is refused, with `RATE_LIMITED` and a `retryAfterSeconds` a client can act
 *      on — the code alone would tell a caller to slow down without saying for how long;
 *   3. the refusal is the **tool's**, not a global tightening: a `merge` job in the same minute from the same session
 *      is accepted. This is the leg that distinguishes a per-tool bucket from a limiter that was simply made
 *      stricter for everyone, and it is the reason the stage exists rather than a unit test of the registry entry;
 *   4. a second tool's own limit is *not* charged for this tool: the merge job's own bucket is untouched (it has
 *      none), which is what makes claim 3 a statement about the registry rather than about timing;
 *   5. the allowance **refills**: after waiting out the tokens that were missing, the same tool is served again. A
 *      limiter nobody can recover from is an outage with a 429 next to it.
 *
 * Claim 5 is the expensive one — it waits for the bucket to refill (10 s a token at six a minute) — and it is the one
 * that would catch the failure mode the fixed-window limiter had before the token bucket: a caller told to retry in
 * one second and refused for the rest of the minute.
 *
 * Needs the compose stack only (`api`, `redis`, `worker-light`). Measurements land in `e2e/artifacts/limits.json`.
 */

interface Args {
  base: string;
  jsonPath: string;
  timeoutSeconds: number;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  jsonPath: value('--json') ?? 'e2e/artifacts/limits.json',
  timeoutSeconds: Number(value('--timeout') ?? 240),
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const DEV_PLAN_TOKEN = process.env.DEV_PLAN_TOKEN ?? 'dev-plan-token';

/** The fixture `unlock` needs: AES-256, published password (`bun run fixtures:encrypted`). */
const ENCRYPTED_FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'protected-aes256-a4.pdf');
const ENCRYPTED_PASSWORD = 'fixture-user-pass';
const MERGE_FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'pages-six-a4.pdf');

interface Check {
  check: string;
  detail: string;
}

const checks: Check[] = [];

function step(check: string, detail: string): void {
  checks.push({ check, detail });
  console.log(`  ✓ ${detail}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

let cookie = '';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  // `unlock` is a Pro tool, so the session has to be one for the right reason rather than borrowing entitlement:
  // the limiter that refuses the seventh request is the one that would refuse a real caller's.
  headers.set('x-dev-plan', 'pro');
  headers.set('x-dev-plan-token', DEV_PLAN_TOKEN);
  const response = await fetch(`${args.base}${path}`, { ...init, headers, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    if (pair?.startsWith('pdft_session=')) cookie = pair;
  }
  return response;
}

async function upload(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const name = path.split('/').pop() ?? 'document.pdf';
  const form = new FormData();
  form.append('kind', 'input');
  form.append('file', new File([bytes], name, { type: 'application/pdf' }));
  const response = await call('/api/v1/files', { method: 'POST', body: form });
  const text = await response.text();
  if (response.status !== 201) fail(`uploading ${name} returned ${response.status}`, text.slice(0, 600));
  return (JSON.parse(text) as { id: string }).id;
}

/** One submission, returning the raw answer so a refusal can be read instead of thrown. */
async function submit(
  tool: string,
  files: string[],
  options: Record<string, unknown>,
): Promise<{ status: number; body: { id?: string; error?: { code?: string; details?: Record<string, unknown> } } }> {
  const response = await call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, files, options }),
  });
  const text = await response.text();
  let body: { id?: string; error?: { code?: string; details?: Record<string, unknown> } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    fail(`POST /api/v1/jobs returned ${response.status} with a body that is not JSON`, text.slice(0, 400));
  }
  return { status: response.status, body };
}

/**
 * Wait for a job to leave the queue.
 *
 * The allowance is spent **one job at a time**, and this is why: the Pro plan allows five jobs running at once
 * (`plans.ts` → `maxConcurrent`), so six submissions fired at the worker are refused at the sixth with
 * `CONCURRENCY_LIMIT` — measured, on the first run of this stage. That would have made the stage fail for a reason
 * that has nothing to do with the limit under test, and "fixing" it by lowering the tool's bucket would be fitting the
 * product to the test. What this stage is about is a *rate*: six jobs inside one minute from one identity. Sequential
 * submission spends the same allowance with one job in flight, and the concurrency ceiling is never the thing that
 * answers.
 */
async function settle(jobId: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await call(`/api/v1/jobs/${jobId}`);
    if (response.ok) {
      const job = (await response.json()) as { status?: string; error?: { code?: string } };
      if (job.status === 'COMPLETED') return;
      if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        fail(`${label} finished ${job.status} (${job.error?.code ?? 'no code'}) inside its own allowance`, job);
      }
    }
    if (Date.now() > deadline) fail(`${label} had not finished 30 s after it was accepted`);
    await Bun.sleep(250);
  }
}

async function main(): Promise<void> {
  console.log(`limits → ${args.base}, the per-tool rate limit against the live API\n`);

  // The bucket belongs to an identity, and this stage's identity is an anonymous session it has to be able to create
  // (`e2e/lib/stack-gap.ts`).
  await requireAnonymousUse(args.base, 'this stage spends a rate-limit allowance as one anonymous session');

  const health = await call('/health');
  if (!health.ok) fail(`/health answered ${health.status}`);
  step('the API answers /health', `${args.base} is up`);

  const catalog = (await (await call('/api/v1/tools/unlock')).json()) as {
    id: string;
    requiresPlan?: string[] | null;
  };
  if (catalog.id !== 'unlock') fail('the catalog does not describe `unlock`', catalog);
  step('the catalog describes the tool under test', `unlock requires ${catalog.requiresPlan?.join(', ') ?? 'no plan'}`);

  const encryptedFile = await upload(ENCRYPTED_FIXTURE);
  const mergeFiles = [await upload(MERGE_FIXTURE), await upload(MERGE_FIXTURE)];
  step('uploaded the fixtures', 'one password-protected document and two plain ones');

  // ── 1. The allowance is spent, and the seventh request is refused ────────────────────────────────────────────
  const allowance = 6;
  const accepted: string[] = [];
  const started = Date.now();
  for (let index = 0; index < allowance; index += 1) {
    const attempt = await submit('unlock', [encryptedFile], { password: ENCRYPTED_PASSWORD });
    if (attempt.status !== 202) {
      fail(
        `unlock was refused at request ${index + 1} of ${allowance}, inside its own allowance`,
        attempt.body.error ?? attempt.status,
      );
    }
    const jobId = attempt.body.id ?? '';
    accepted.push(jobId);
    // Settled before the next one, so the plan's concurrency ceiling is never the limit that answers (see `settle`).
    await settle(jobId, `unlock request ${index + 1} of ${allowance}`);
  }
  step(
    `${allowance} unlock jobs were accepted and completed`,
    `the registry allows ${allowance} a minute for one identity, none of them was refused, and each one ran — a rate limit that let submissions through into a pool that then rejected them would read as a pass here without being one`,
  );

  const refused = await submit('unlock', [encryptedFile], { password: ENCRYPTED_PASSWORD });
  if (refused.status !== 429) {
    fail(
      `the ${allowance + 1}th unlock job was accepted (status ${refused.status}), so the tool's own limit is not enforced`,
      refused.body,
    );
  }
  if (refused.body.error?.code !== 'RATE_LIMITED') {
    fail(`the refusal carries ${refused.body.error?.code ?? 'no code'}, not RATE_LIMITED`, refused.body.error);
  }
  const retryAfter = Number(
    (refused.body.error?.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds,
  );
  if (!Number.isFinite(retryAfter) || retryAfter < 1 || retryAfter > 60) {
    fail('the refusal does not say when to come back, or says something a client cannot act on', {
      retryAfterSeconds: retryAfter,
      details: refused.body.error?.details,
    });
  }
  step(
    'the request after the allowance is refused with RATE_LIMITED',
    `retryAfterSeconds: ${retryAfter}, which is the wait for the bucket to refill rather than a window edge`,
  );

  // ── 2. The refusal is the tool's, not a global tightening ───────────────────────────────────────────────────
  const merge = await submit('merge', mergeFiles, {});
  if (merge.status !== 202) {
    fail(
      'a merge job in the same minute from the same session was refused, so the limit is not the tool’s',
      merge.body,
    );
  }
  step(
    'another tool in the same minute is served',
    'merge was accepted, so the bucket that refused the unlock job belongs to `unlock` and not to the identity',
  );

  // ── 3. The allowance refills, so a wait is a remedy ─────────────────────────────────────────────────────────
  const waitMs = retryAfter * 1000 + 1000;
  await Bun.sleep(waitMs);
  const recovered = await submit('unlock', [encryptedFile], { password: ENCRYPTED_PASSWORD });
  if (recovered.status !== 202) {
    fail(
      `the tool refused a request ${(waitMs / 1000).toFixed(1)} s after telling the caller to wait ${retryAfter} s, so the advice was wrong`,
      recovered.body,
    );
  }
  step('the allowance refills', `after waiting out the ${retryAfter} s the refusal named, unlock was accepted again`);

  const elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
  const judged = await call('/health');
  if (!judged.ok) fail(`/health answered ${judged.status} at the end of the run`);

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base: args.base,
        tool: { id: 'unlock', limitPerMinute: allowance, source: 'packages/contracts/src/tools/catalog.ts' },
        control: { tool: 'merge', status: merge.status, jobId: merge.body.id ?? null },
        accepted,
        refused: { status: refused.status, code: refused.body.error?.code, retryAfterSeconds: retryAfter },
        refill: {
          waitedSeconds: Math.round(waitMs / 1000),
          status: recovered.status,
          jobId: recovered.body.id ?? null,
        },
        elapsedSeconds,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\nlimits passed — ${checks.length} check(s) against ${args.base} in ${Math.round(elapsedSeconds)} s (${Math.round(
      waitMs / 1000,
    )} s of that is the bucket refilling)`,
  );
  console.log(`Measurements: ${args.jsonPath}`);
}

main().catch((cause: unknown) => {
  console.error('\n✗ the stage threw', cause);
  process.exit(1);
});
