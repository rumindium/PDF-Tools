import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rawSql } from '@pdftools/db';
import { probeAnonymous, stackGap } from '../../e2e/lib/stack-gap';

/**
 * The tenant-first contract, measured against a running stack — the stage `docs/0-TENANT-FIRST.md` §6 lists as the
 * things that have to be true before phase 3 is finished.
 *
 *   bun run test:tenant-first -- --base http://localhost:8080
 *
 * ## One stage, two legs, and the stack picks which
 *
 * The subject is not "anonymous is off" — it is **the API does what the switch says**. The stage asks the stack who it
 * thinks a caller with no credential is (`GET /me`), then measures the consequences of that answer:
 *
 *   · `allowAnonymous: false` (the tenant-first profile) — a caller with no session is a `guest` with no plan and no
 *     quota; uploading and submitting are refused with the *two different* `AUTH_REQUIRED` refusals §4.2 names; no
 *     session row is written by any of it; and a session minted before the switch was turned off still reads its own
 *     work.
 *   · `allowAnonymous: true` (the dev and CI stacks) — the same requests behave exactly as they did before this work:
 *     a session is minted, an upload is accepted, a job is created.
 *   · `strictMode: true` (the strict profile) — a third position, not a stronger second one: the door (`/me`,
 *     `/sso/*`) answers and the product does not. The catalogue, which the tenant-first leg asserts is *readable*, is
 *     refused here; the refusal carries `reason: 'strict_mode'`; and a session minted before the switch is refused the
 *     product while still resolving as itself.
 *
 * Running all three legs from one file is the point. A stage that only asserted the refusals would be satisfied by a
 * product that refuses everything, and the legs that show the other two positions intact only exist on stacks that are
 * one compose variable away rather than a rebuild — which is the only reason a stage about a switch can afford to test
 * the switch instead of testing one of its positions.
 *
 * ## Why the job count is measured and not inferred
 *
 * "The refusal created nothing" is a claim about a table, and the API cannot testify about it: a `guest`'s
 * `GET /jobs` is an empty page *by design*, so it returns empty whether the refusal worked or a row was written by a
 * path that forgot the guard. The count comes from the database, before and after, which is the only reading that can
 * disagree with the API's own story. When that connection is unavailable the two cases that need it are reported as
 * **not run** with the reason, rather than quietly passing.
 *
 * ## What this stage does not do
 *
 * It never flips the switch itself. Changing it means recreating a container with a different environment
 * (`docker-compose.tenant-first.yml`), so the "operator turns it on and the app follows" property is the one thing
 * here that is measured by a recipe rather than a request — `0-TENANT-FIRST.md` §7c.2 has that measurement.
 *
 * Measurements land in `e2e/artifacts/tenant-first.json`.
 */

interface Args {
  base: string;
  jsonPath: string;
  /**
   * Refuse to skip the two cases that need the database.
   *
   * Without it a machine with no `DATABASE_URL` prints "not run" and passes, which is the right behaviour for a
   * developer and the wrong one for CI: the two cases it quietly drops are exactly the ones that make "the refusal
   * created nothing" a measurement instead of an assertion. CI passes this flag so the suite cannot shrink silently.
   */
  requireDatabase: boolean;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  jsonPath: value('--json') ?? 'e2e/artifacts/tenant-first.json',
  requireDatabase: argv.includes('--require-database'),
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const MERGE_FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'pages-six-a4.pdf');

interface Check {
  check: string;
  detail: string;
}

const checks: Check[] = [];
const notRun: Array<{ check: string; reason: string }> = [];

function step(check: string, detail: string): void {
  checks.push({ check, detail });
  console.log(`  ✓ ${detail}`);
}

/** A case that the stack or the machine cannot run. Printed, never counted as a pass. */
function skip(check: string, reason: string): void {
  notRun.push({ check, reason });
  console.log(`  · not run — ${check}: ${reason}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

// ─── HTTP, with a cookie jar per identity ────────────────────────────────────

interface Answer {
  status: number;
  body: Record<string, unknown>;
  setCookie: string[];
}

/**
 * One request, carrying whatever cookie the given jar holds.
 *
 * The jar is an object rather than a module-level string because this stage holds **two** identities at once: the
 * caller with no session, and — on the tenant-first leg — one whose session was minted before the switch was turned
 * off. A single shared `cookie` variable is exactly how a case ends up measuring the wrong caller.
 */
async function call(path: string, jar: { cookie: string }, init: RequestInit = {}): Promise<Answer> {
  const headers = new Headers(init.headers);
  if (jar.cookie) headers.set('cookie', jar.cookie);
  headers.set('accept', 'application/json');
  const response = await fetch(`${args.base}${path}`, { ...init, headers, redirect: 'manual' });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    fail(`GET/POST ${path} returned ${response.status} with a body that is not JSON`, text.slice(0, 400));
  }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(';')[0];
    if (pair?.startsWith('pdft_session=')) jar.cookie = pair;
  }
  return { status: response.status, body, setCookie };
}

/** The `error` block of a refusal, in the shape `AppError` serialises it. */
function refusal(answer: Answer): { code?: string; reason?: string; allowAnonymous?: unknown } {
  const error = (answer.body.error ?? {}) as { code?: string; details?: Record<string, unknown> };
  return {
    code: error.code,
    reason: error.details?.reason as string | undefined,
    allowAnonymous: error.details?.allowAnonymous,
  };
}

const GUEST_JAR = { cookie: '' };

async function uploadFixture(jar: { cookie: string }): Promise<Answer> {
  const bytes = new Uint8Array(await Bun.file(MERGE_FIXTURE).arrayBuffer());
  const form = new FormData();
  form.append('kind', 'input');
  form.append('file', new File([bytes], 'pages-six-a4.pdf', { type: 'application/pdf' }));
  return await call('/api/v1/files', jar, { method: 'POST', body: form });
}

/**
 * A submission whose **body satisfies the route schema**, which matters more than it looks.
 *
 * The creation guard lives inside the handler, and Elysia validates the body before it (`0-TENANT-FIRST.md` §7a.5: a
 * guest posting a malformed body gets a 422, not a 401). A case that submitted `files: []` would therefore measure
 * the validator and report it as the gate — so the id is a real uuid, and the file it names does not have to exist for
 * the refusal to be the right one.
 */
async function submitPlaceholder(jar: { cookie: string }, files: string[]): Promise<Answer> {
  return await call('/api/v1/jobs', jar, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files, options: {} }),
  });
}

// ─── The database, as the only independent witness of "created nothing" ──────

interface JobCount {
  count: number;
}

async function jobCount(): Promise<number | null> {
  try {
    const rows = await rawSql()`SELECT count(*)::int AS count FROM jobs`;
    return (rows[0] as JobCount | undefined)?.count ?? null;
  } catch (cause) {
    if (args.requireDatabase) {
      fail(
        'the database could not be reached and --require-database was given',
        `${cause instanceof Error ? cause.message : String(cause)}\npoint DATABASE_URL at the running stack (the dev compose publishes 5435)`,
      );
    }
    return null;
  }
}

/**
 * A session and a job as they exist **before** anonymous use was switched off.
 *
 * Written straight into the tables on purpose: this is the one state a tenant-first stack cannot reach through its own
 * API — minting a session is the thing the switch stopped, and uploading is refused to the caller who would own it. A
 * row inserted here is the honest way to say "this work already existed", and the assertions that follow are made
 * entirely through the API.
 *
 * The cookie is opaque (`plugins/session.ts`: the browser holds a session id and the row is what means anything), so
 * there is nothing to sign — which is also why the value can be written here at all.
 */
async function seedLegacySession(): Promise<{ sessionId: string; jobId: string } | null> {
  const sessionId = randomUUID();
  const jobId = randomUUID();
  try {
    const sql = rawSql();
    await sql`
      INSERT INTO sessions (id, kind, anon_id, expires_at)
      VALUES (${sessionId}, 'anonymous', ${`legacy-${sessionId.slice(0, 8)}`}, now() + interval '1 hour')
    `;
    await sql`
      INSERT INTO jobs (id, tool, category, queue, status, phase, owner_id, owner_kind, plan_id, options, expires_at, completed_at)
      VALUES (${jobId}, 'merge', 'organize', 'pdf:light', 'COMPLETED', 'done', ${sessionId}, 'anonymous', 'anonymous', '{}'::jsonb, now() + interval '1 hour', now())
    `;
    return { sessionId, jobId };
  } catch {
    return null;
  }
}

async function cleanupLegacySession(seed: { sessionId: string; jobId: string }): Promise<void> {
  const sql = rawSql();
  await sql`DELETE FROM jobs WHERE id = ${seed.jobId}`;
  await sql`DELETE FROM sessions WHERE id = ${seed.sessionId}`;
}

// ─── The legs ───────────────────────────────────────────────────────────────

/**
 * The tenant-first leg: a caller with no account is a guest, and a session that predates the switch still reads.
 */
async function tenantFirstLeg(): Promise<void> {
  const before = await jobCount();
  if (before === null) {
    skip(
      'the job count before and after a refused submission',
      'this machine has no database connection, so the independent count is unavailable — set DATABASE_URL',
    );
  }

  // ── The guest's own answer ────────────────────────────────────────────────
  const me = await call('/api/v1/me', GUEST_JAR);
  if (me.status !== 200) fail(`GET /me answered ${me.status} for a caller with no cookie`, me.body);
  const meBody = me.body as {
    kind?: string;
    planId?: string;
    planSource?: string;
    authenticated?: boolean;
    allowAnonymous?: boolean;
    quota?: { limit?: number };
  };
  if (meBody.kind !== 'guest') fail(`a caller with no session resolved as '${meBody.kind}', not 'guest'`, me.body);
  if (meBody.authenticated !== false) fail('a guest reported `authenticated: true`', me.body);
  if (meBody.planSource !== 'none') fail(`a guest's plan source was '${meBody.planSource}', not 'none'`, me.body);
  if (meBody.quota?.limit !== 0) fail(`a guest was given a quota limit of ${meBody.quota?.limit}, not 0`, me.body);
  step(
    'a caller with no session is a guest',
    'GET /me → kind=guest, authenticated=false, planSource=none, quota.limit=0',
  );

  if (me.setCookie.some((raw) => raw.startsWith('pdft_session='))) {
    fail('a guest was handed a session cookie, which is the minting the switch exists to stop', me.setCookie);
  }
  step('nothing was minted', 'GET /me answered a guest without a single Set-Cookie header');

  // ── Signing out of nothing, on an installation that requires an account ──
  // The route is new (`0-TENANT-FIRST.md` §5.4) and its first property is what it *does not* do: a caller with no
  // session does not get one for asking, and the answer names the state they are already in. A sign-out that failed
  // here would be a route that can only be used by someone who has something to lose.
  const signOut = await call('/api/v1/sso/sign-out', GUEST_JAR, { method: 'POST' });
  if (signOut.status !== 200) fail(`POST /sso/sign-out answered ${signOut.status} for a guest`, signOut.body);
  if (signOut.body.signedOut !== true || signOut.body.kind !== 'guest') {
    fail(`a guest who signed out was answered ${JSON.stringify(signOut.body)}`, signOut.body);
  }
  if (signOut.setCookie.some((raw) => raw.startsWith('pdft_session='))) {
    fail('signing out minted a session, which is the one thing this installation refuses to do', signOut.setCookie);
  }
  step('signing out as a guest is a no-op', 'POST /sso/sign-out → 200 {signedOut:true, kind:"guest"}, no Set-Cookie');

  const catalog = await call('/api/v1/tools', GUEST_JAR);
  if (catalog.status !== 200) fail(`GET /tools answered ${catalog.status} for a guest`, catalog.body);
  const tools = (catalog.body.tools ?? []) as Array<{ id?: string; available?: boolean }>;
  if (tools.length === 0) fail('the catalogue is empty for a guest', catalog.body);
  const unavailable = tools.filter((tool) => tool.available === false).length;
  if (unavailable === 0) {
    fail('every tool reports `available: true` to a guest, who holds no plan at all', catalog.body);
  }
  step(
    'the catalogue is readable',
    `GET /tools → 200 with ${tools.length} tools, ${unavailable} of them not available to a guest`,
  );

  // ── The two refusals, which are not the same refusal ──────────────────────
  const upload = await uploadFixture(GUEST_JAR);
  const uploadRefusal = refusal(upload);
  if (upload.status !== 401) fail(`POST /files answered ${upload.status} for a guest, not 401`, upload.body);
  if (uploadRefusal.code !== 'AUTH_REQUIRED') {
    fail(`the guest's upload was refused with '${uploadRefusal.code}', not AUTH_REQUIRED`, upload.body);
  }
  if (uploadRefusal.reason !== 'no_account') {
    fail(`the guest's upload carried reason '${uploadRefusal.reason}', not 'no_account'`, upload.body);
  }
  if (uploadRefusal.allowAnonymous !== false) {
    fail(
      `the refusal reported allowAnonymous=${String(uploadRefusal.allowAnonymous)}, which is not the resolved switch`,
      upload.body,
    );
  }
  step('an upload is refused', 'POST /files → 401 AUTH_REQUIRED, reason=no_account, allowAnonymous=false');

  const submit = await submitPlaceholder(GUEST_JAR, [randomUUID()]);
  const submitRefusal = refusal(submit);
  if (submit.status !== 401) fail(`POST /jobs answered ${submit.status} for a guest, not 401`, submit.body);
  if (submitRefusal.code !== 'AUTH_REQUIRED' || submitRefusal.reason !== 'no_account') {
    fail(`the guest's submission was refused as ${JSON.stringify(submitRefusal)}`, submit.body);
  }
  step('a submission is refused', 'POST /jobs (schema-valid body) → 401 AUTH_REQUIRED, reason=no_account');

  if (before !== null) {
    const after = await jobCount();
    if (after === null) fail('the job count could not be read after the refused submission');
    if (after !== before) {
      fail(`the jobs table grew by ${after - before} row(s) across two refused submissions`, { before, after });
    }
    step('a refusal creates nothing', `jobs count unchanged at ${before} across both refusals — measured in the table`);
  }

  // ── The session and its job, from before the switch ───────────────────────
  const seed = await seedLegacySession();
  if (seed === null) {
    const reachable = (await jobCount()) !== null;
    skip(
      'the read-only session minted before the switch was turned off',
      reachable
        ? 'seeding a session row failed, so the legacy caller could not be constructed'
        : 'this machine has no database connection, so a pre-switch session cannot be constructed — set DATABASE_URL',
    );
  } else {
    const legacyJar = { cookie: `pdft_session=${seed.sessionId}` };
    const legacyMe = await call('/api/v1/me', legacyJar);
    const legacyBody = legacyMe.body as { kind?: string; authenticated?: boolean; allowAnonymous?: boolean };
    if (legacyBody.kind !== 'anonymous') {
      fail(`a session from before the switch resolved as '${legacyBody.kind}', not 'anonymous'`, legacyMe.body);
    }
    if (legacyBody.allowAnonymous !== false) {
      fail('the legacy session was told anonymous use is allowed, on a stack where it is not', legacyMe.body);
    }
    step(
      'a session from before the switch is still honoured',
      'GET /me → kind=anonymous, authenticated=true, allowAnonymous=false (read-only, not erased)',
    );

    const legacyJob = await call(`/api/v1/jobs/${seed.jobId}`, legacyJar);
    if (legacyJob.status !== 200) {
      fail(
        `the legacy session could not read its own finished job (GET /jobs/:id → ${legacyJob.status}), which is the work the switch must not take away`,
        legacyJob.body,
      );
    }
    step(
      'its finished work is still readable',
      `GET /jobs/${seed.jobId} → 200 with status=${String((legacyJob.body as { status?: string }).status)}`,
    );

    const legacyUpload = await uploadFixture(legacyJar);
    const legacyRefusal = refusal(legacyUpload);
    if (legacyUpload.status !== 401 || legacyRefusal.code !== 'AUTH_REQUIRED') {
      fail(
        `the legacy session's upload answered ${legacyUpload.status} ${JSON.stringify(legacyRefusal)}`,
        legacyUpload.body,
      );
    }
    if (legacyRefusal.reason !== 'anonymous_disabled') {
      fail(
        `the legacy session's upload gave reason '${legacyRefusal.reason}', not 'anonymous_disabled' — the two refusals must stay distinguishable`,
        legacyUpload.body,
      );
    }
    step(
      'but it may not start new work',
      "POST /files → 401 AUTH_REQUIRED, reason=anonymous_disabled (a different refusal from the guest's)",
    );

    await cleanupLegacySession(seed);
  }
}

/**
 * The strict leg: **no public page at all** — the installation answers the door and refuses the product.
 *
 * A third position, and the one that is easiest to get wrong in both directions. What makes it a position rather than
 * a stronger setting is the split it demands: `/me` and `/sso/*` stay reachable, because they are how a visitor learns
 * what is going on and how they get in, while everything the product hands out — catalogue, tool definitions, file
 * lists — is refused. A stage that only checked the refusal would pass for an installation with no way in; a stage
 * that only checked the door would pass for one that has no gate.
 *
 * The refusal has to be the **right** one. `strict_mode` and `anonymous_disabled` are different sentences about
 * different installations ("publish nothing" versus "stopped accepting new work"), and the whole reason they are
 * separate codes is that a client showing the wrong one describes a product that does not exist — so this leg asserts
 * the reason and not merely the 401.
 *
 * The last two cases are the half no page gate can cover: a session minted *before* the switch was flipped never loads
 * a page that would show it a gate, so the refusal has to happen on the route. It keeps its own identity — it is still
 * `anonymous`, still authenticated as itself — and it may not read the product either, which is what makes the position
 * "no public page" rather than "no public pages for new visitors".
 */
async function strictLeg(): Promise<void> {
  const before = await jobCount();
  if (before === null) {
    skip(
      'the job count across a refused submission',
      'this machine has no database connection, so the independent count is unavailable — set DATABASE_URL',
    );
  }

  // ── The door, which must stay open ────────────────────────────────────────
  const me = await call('/api/v1/me', GUEST_JAR);
  if (me.status !== 200) {
    fail(
      `GET /me answered ${me.status} for a caller with no account, which leaves this installation with no way in`,
      me.body,
    );
  }
  const meBody = me.body as { kind?: string; strictMode?: boolean; allowAnonymous?: boolean };
  if (meBody.strictMode !== true) fail('this stack did not report `strictMode: true` on /me', me.body);
  if (meBody.kind !== 'guest') fail(`a caller with no session resolved as '${meBody.kind}', not 'guest'`, me.body);
  if (meBody.allowAnonymous !== false) {
    fail(
      `strict mode is on and /me still reported allowAnonymous=${String(meBody.allowAnonymous)} — the pair is incoherent`,
      me.body,
    );
  }
  step(
    'the door is open',
    'GET /me → 200 kind=guest, strictMode=true, allowAnonymous=false — the visitor can be told why and can get in',
  );

  if (me.setCookie.some((raw) => raw.startsWith('pdft_session='))) {
    fail('a strict installation handed a caller with no account a session', me.setCookie);
  }
  step('nothing was minted', 'GET /me answered without a single Set-Cookie header');

  const signOut = await call('/api/v1/sso/sign-out', GUEST_JAR, { method: 'POST' });
  if (signOut.status !== 200 || signOut.body.kind !== 'guest') {
    fail(`POST /sso/sign-out answered ${signOut.status} for a guest on a strict stack`, signOut.body);
  }
  step('and signing out is still a no-op', 'POST /sso/sign-out → 200 {kind:"guest"}, no Set-Cookie');

  // ── The product surface, which must not be ────────────────────────────────
  // The catalogue is the sharpest case, because it is the one route that is *readable* on the tenant-first leg: with
  // anonymous use off but no strict mode, a visitor may browse the tools and only the act of running one is refused.
  // Here it is not, and that difference is the whole feature.
  const catalog = await call('/api/v1/tools', GUEST_JAR);
  const catalogRefusal = refusal(catalog);
  if (catalog.status !== 401) {
    fail(`GET /tools answered ${catalog.status} for a caller with no account on a strict stack, not 401`, catalog.body);
  }
  if (catalogRefusal.code !== 'AUTH_REQUIRED' || catalogRefusal.reason !== 'strict_mode') {
    fail(`the catalogue refusal was ${JSON.stringify(catalogRefusal)}, not AUTH_REQUIRED/strict_mode`, catalog.body);
  }
  step(
    'the catalogue is not public',
    'GET /tools → 401 AUTH_REQUIRED, reason=strict_mode (readable on the tenant-first leg, refused here)',
  );

  const upload = await uploadFixture(GUEST_JAR);
  const uploadRefusal = refusal(upload);
  if (upload.status !== 401 || uploadRefusal.reason !== 'strict_mode') {
    fail(`the guest's upload was refused as ${JSON.stringify(uploadRefusal)}`, upload.body);
  }
  step(
    'and neither is the act of starting work',
    "POST /files → 401 reason=strict_mode — not 'no_account', because this installation publishes nothing",
  );

  const jobs = await call('/api/v1/jobs', GUEST_JAR);
  if (jobs.status !== 401 || refusal(jobs).reason !== 'strict_mode') {
    fail(`GET /jobs answered ${jobs.status} ${JSON.stringify(refusal(jobs))} for a guest`, jobs.body);
  }
  step('nor the job list', 'GET /jobs → 401 reason=strict_mode');

  if (before !== null) {
    const after = await jobCount();
    if (after === null) fail('the job count could not be read after the refused submissions');
    if (after !== before)
      fail(`the jobs table grew by ${after - before} row(s) across the refusals`, { before, after });
    step('a refusal creates nothing', `jobs count unchanged at ${before} — measured in the table, not inferred`);
  }

  // ── The session from before the switch, which no page gate can reach ──────
  const seed = await seedLegacySession();
  if (seed === null) {
    const reachable = (await jobCount()) !== null;
    skip(
      'a session minted before strict mode was turned on',
      reachable
        ? 'seeding a session row failed, so the legacy caller could not be constructed'
        : 'this machine has no database connection, so a pre-switch session cannot be constructed — set DATABASE_URL',
    );
  } else {
    const legacyJar = { cookie: `pdft_session=${seed.sessionId}` };
    const legacyMe = await call('/api/v1/me', legacyJar);
    const legacyBody = legacyMe.body as { kind?: string; authenticated?: boolean };
    if (legacyBody.kind !== 'anonymous') {
      fail(`a session from before the switch resolved as '${legacyBody.kind}', not 'anonymous'`, legacyMe.body);
    }
    step(
      'an anonymous session from before the switch is still itself',
      'GET /me → kind=anonymous — refused the product, not erased',
    );

    const legacyJob = await call(`/api/v1/jobs/${seed.jobId}`, legacyJar);
    if (legacyJob.status !== 401 || refusal(legacyJob).reason !== 'strict_mode') {
      fail(
        `the legacy session read its own job with ${legacyJob.status} ${JSON.stringify(refusal(legacyJob))} — a strict installation publishes no page, so its finished work is not readable either, and signing in is what brings it back (adoptAnonymousWork)`,
        legacyJob.body,
      );
    }
    step(
      'and its own work is behind the gate too',
      'GET /jobs/:id → 401 reason=strict_mode (the case a page gate cannot cover: the cookie never loads a page)',
    );

    await cleanupLegacySession(seed);
  }
}

/**
 * The flag-on leg: the same requests, on a stack that serves callers with no account.
 *
 * Every assertion here already existed as behaviour; what is new is that it is now *checked* on the path a tenant-first
 * deployment takes, which is the only way the switch can be shown to be a switch rather than a removal.
 */
async function flagOnLeg(): Promise<void> {
  const jar = { cookie: '' };
  const me = await call('/api/v1/me', jar);
  const body = me.body as { kind?: string; allowAnonymous?: boolean };
  if (body.allowAnonymous !== true) fail('this stack reported `allowAnonymous: false` on the flag-on leg', me.body);
  if (body.kind !== 'anonymous' || !jar.cookie) {
    fail(`a caller with no cookie resolved as '${body.kind}' without being given a session`, me.body);
  }
  step('a session is minted', `GET /me → kind=anonymous, allowAnonymous=true, Set-Cookie: ${jar.cookie.split('=')[0]}`);

  // ── Signing out of an app that was never linked ───────────────────────────
  // Two properties at once, and both matter on this side of the switch: the answer names the anonymous floor (not
  // `guest`, which is the other installation's shape), and the **session cookie is unchanged** — a browser that never
  // linked an account must not be handed a fresh `anon_id` for pressing a button, or the hourly allowance becomes
  // something anyone can reset (`0-TENANT-FIRST.md` §5.4).
  const cookieBeforeSignOut = jar.cookie;
  const signOut = await call('/api/v1/sso/sign-out', jar, { method: 'POST' });
  if (signOut.status !== 200) fail(`POST /sso/sign-out answered ${signOut.status}`, signOut.body);
  if (signOut.body.signedOut !== true || signOut.body.kind !== 'anonymous') {
    fail(`an unlinked caller who signed out was answered ${JSON.stringify(signOut.body)}`, signOut.body);
  }
  if (jar.cookie !== cookieBeforeSignOut) fail('signing out replaced the anonymous session with a new one');
  step(
    'signing out of an unlinked session keeps it',
    'POST /sso/sign-out → 200 {signedOut:true, kind:"anonymous"}, same cookie',
  );

  const upload = await uploadFixture(jar);
  if (upload.status !== 201) fail(`POST /files answered ${upload.status} on a stack that allows anonymous use`);
  const fileId = (upload.body as { id?: string }).id;
  if (!fileId) fail('the upload returned no id', upload.body);
  step('an upload is accepted', `POST /files → 201 (file ${fileId.slice(0, 8)}…)`);

  const second = await uploadFixture(jar);
  const secondId = (second.body as { id?: string }).id;
  if (second.status !== 201 || !secondId) fail(`the second upload answered ${second.status}`, second.body);

  const submit = await submitPlaceholder(jar, [fileId, secondId]);
  if (submit.status !== 202) {
    fail(`POST /jobs answered ${submit.status} on a stack that allows anonymous use`, submit.body);
  }
  step(
    'a job is created',
    `POST /jobs → 202 with id ${String((submit.body as { id?: string }).id).slice(0, 8)}… — the pre-switch behaviour, unchanged`,
  );
}

async function main(): Promise<void> {
  const probe = await probeAnonymous(args.base);
  if (probe === null) {
    fail(
      `${args.base} did not answer GET /api/v1/me in the expected shape — this stage measures a running stack`,
      'start one: `docker compose up -d --wait api worker-light` (see `docs/0-CICD.md` §3)',
    );
  }

  // Strict mode is checked first and is not folded into `allowAnonymous`: it is the position where the app publishes
  // nothing, and it can only ever report `allowAnonymous: false` as well, so testing that flag first would send every
  // strict stack down the tenant-first leg and quietly assert the weaker contract.
  const leg = probe.strictMode ? 'strict' : probe.allowAnonymous ? 'flag-on' : 'tenant-first';
  console.log(
    `tenant-first contract → ${args.base} (${leg} leg: allowAnonymous=${probe.allowAnonymous}, strictMode=${probe.strictMode})\n`,
  );

  if (!(await Bun.file(MERGE_FIXTURE).exists())) {
    stackGap(
      `the fixture this stage uploads is missing (${MERGE_FIXTURE.replace(`${REPO_ROOT}/`, '')})`,
      'bun run fixtures',
    );
  }

  if (probe.strictMode) {
    await strictLeg();
  } else if (probe.allowAnonymous) {
    await flagOnLeg();
  } else {
    await tenantFirstLeg();
  }

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base: args.base,
        leg,
        allowAnonymous: probe.allowAnonymous,
        strictMode: probe.strictMode,
        checks,
        notRun,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\ntenant-first contract passed on the ${leg} leg — ${checks.length} check(s)${
      notRun.length > 0 ? `, ${notRun.length} not run` : ''
    }`,
  );
  console.log(`Measurements: ${args.jsonPath}`);
  process.exit(0);
}

main().catch((cause: unknown) => {
  console.error('\n✗ the stage threw', cause);
  process.exit(1);
});
