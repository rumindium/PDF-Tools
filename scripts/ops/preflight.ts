import { mkdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertBootable, config } from '@pdftools/config';
import { closeDb, pingDb, rawSql } from '@pdftools/db';
import { closeQueueConnection, redisConnection } from '@pdftools/queue';

/**
 * The deploy gate (`docs/0-CICD.md` §5): what has to be true **before** the new images take traffic.
 *
 * ```text
 *   bun run ops:preflight                                    # from a host that can reach the deployment
 *   docker compose -f docker-compose.prod.yml run --rm preflight   # the way a deploy runs it
 * ```
 *
 * The second form is the one that matters, and it is a *service* in the production compose file for a reason this
 * repository learned the hard way: in the production topology nothing publishes a port but Caddy, so Postgres, Redis
 * and the job volume are reachable only on the compose network. A preflight script that ran on the host and opened
 * `DATABASE_URL` would fail on a healthy deployment — a check that is wrong about its own subject. It therefore runs
 * as a one-shot container, exactly like `migrate`, and checks the deployment from inside it.
 *
 * ## What it checks
 *
 * | Check | Question it answers | Failure |
 * |---|---|---|
 * | `environment` | is this a deployment rather than a laptop (`NODE_ENV` is `production` or `staging`) | abort |
 * | `boot` | does the configuration make the product usable at all (`assertBootable`'s rules: `DEV_PLAN_TOKEN` in production, and the combination where nobody — visitor or account — can call it) | abort |
 * | `secrets` | is `SESSION_SECRET` still the value the repository ships, or shorter than the 32 characters a signing key needs to be worth having | abort |
 * | `urls` | do `PUBLIC_API_URL` and `CORS_ORIGINS` name the public origin rather than `localhost` — the mistake that makes a deployment work from the host and fail from a browser | abort |
 * | `database` | does `DATABASE_URL` answer, and is every migration file on disk already in `schema_migrations` | abort (pending) / warn (schema ahead of the code) |
 * | `redis` | does `REDIS_URL` answer | abort |
 * | `storage` | is `TEMP_DIR` absolute, creatable and **writable** (a probe file is written and removed, not assumed from a mode bit), with `WORKER_DISK_MIN_FREE_GB` free | abort |
 *
 * ## What it deliberately does not check
 *
 * * **The engines.** They live in the four pool images, not in this one, and each pool already refuses to *boot* with
 *   a missing binary (`preflight(pool)` in `worker-shared`, which is why a pool with a missing engine is a restart
 *   loop rather than a pool that fails every job with `ENGINE_UNAVAILABLE`). Re-listing the binaries here would be a
 *   second copy of that list, in an image that has none of them. The smoke's first step reads the four pools back.
 * * **Metrics and tracing.** `docs/0-MONITORING.md` is unimplemented, so there is no exporter, no `METRICS_ENABLED`,
 *   no `METRICS_TOKEN` and nothing to assert about them. A check for a variable that no code reads would be a check
 *   that always passes, which is the one kind of check this repository does not keep.
 * * **Backups.** `docs/0-CICD.md` §9 owns that drill; it is an operator procedure, not a boot assertion.
 */

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const jsonPath = value('--json') ?? null;

/** The secret the repository ships. Named here so the check reads as a sentence about this file, not about a habit. */
const SHIPPED_SESSION_SECRET = 'dev-only-change-me';
const MIN_SESSION_SECRET_LENGTH = 32;

interface Finding {
  check: string;
  detail: string;
  level: 'ok' | 'warn' | 'fail' | 'note';
}

const findings: Finding[] = [];

function record(check: string, level: Finding['level'], detail: string): void {
  findings.push({ check, level, detail });
  const mark = level === 'ok' ? '✓' : level === 'warn' ? '!' : level === 'fail' ? '✗' : '·';
  console.log(`  ${mark} ${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * A dependency check has to answer, not wait.
 *
 * Both clients below are built for a *serving* process: `redisConnection()` sets `maxRetriesPerRequest: null`, which
 * means an unreachable Redis queues the command and retries forever rather than failing — correct for a worker that
 * should ride out a blip, and useless for a gate whose whole job is to say whether this deployment is ready now. So
 * every reachability check runs under its own deadline, and a timeout is reported as the failure it is.
 */
async function within<T>(promise: Promise<T>, seconds: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${seconds}s`)), seconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REACHABILITY_TIMEOUT_SECONDS = 10;

async function main(): Promise<void> {
  console.log('preflight — the deploy gate (`docs/0-CICD.md` §5)');
  console.log(`  environment: NODE_ENV=${config.env} · temp ${config.storage.tempDir}`);

  // ── 1. A deployment, not a laptop ─────────────────────────────────────────
  section('environment');
  if (config.env === 'production' || config.env === 'staging') {
    record('environment', 'ok', `NODE_ENV is ${config.env}`);
  } else {
    record(
      'environment',
      'fail',
      `NODE_ENV is ${config.env} — this gate is for a deployment; a development stack keeps the dev defaults it was built with, and asserting they are gone here would only teach people to skip the gate`,
    );
  }

  // ── 2. The rules that make the product usable at all ──────────────────────
  section('boot configuration');
  try {
    assertBootable();
    record('boot', 'ok', 'no configuration problem that would leave this installation unreachable');
  } catch (error) {
    const lines = String((error as Error).message)
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.startsWith('Invalid environment'));
    for (const line of lines) record('boot', 'fail', line.trim());
  }

  // ── 3. Secrets ────────────────────────────────────────────────────────────
  section('secrets');
  const secret = config.session.secret;
  if (secret === SHIPPED_SESSION_SECRET) {
    record('secrets', 'fail', 'SESSION_SECRET is still the value the repository ships (`dev-only-change-me`)');
  } else if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    record(
      'secrets',
      'fail',
      `SESSION_SECRET is ${secret.length} characters; a signing key shorter than ${MIN_SESSION_SECRET_LENGTH} is a key someone can guess. The value itself is never printed here`,
    );
  } else {
    // Length and identity only — never the value, and the reason the length is checked rather than its alphabet is
    // that a passphrase of thirty-two words is a better secret than sixteen random bytes.
    record('secrets', 'ok', `SESSION_SECRET is set, ${secret.length} characters, and is not the shipped default`);
  }
  if (config.session.devPlanToken === null) {
    record('secrets', 'ok', 'DEV_PLAN_TOKEN is unset, so the `x-dev-plan` header is ignored');
  } else if (config.env !== 'production') {
    // In production the boot rule above has already refused this and named it; repeating it here would read as two
    // problems. Everywhere else it is worth a warning, because that rule is deliberately written for services only.
    record(
      'secrets',
      'warn',
      'DEV_PLAN_TOKEN is set — the `x-dev-plan` header is honoured, so any caller can choose their own plan',
    );
  }

  // ── 4. The public origin ──────────────────────────────────────────────────
  section('urls');
  const localish = /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;
  const publicUrl = config.api.publicUrl;
  if (localish.test(publicUrl)) {
    record('urls', 'fail', `PUBLIC_API_URL is ${publicUrl} — a deployment cannot hand browsers a loopback address`);
  } else if (!publicUrl.startsWith('https://')) {
    // Not a failure: a deployment behind a private network or a load balancer that terminates TLS elsewhere is a real
    // configuration. It is worth saying out loud because the session cookie is `Secure` in production
    // (`plugins/session.ts`), and a browser drops a `Secure` cookie on an `http://` origin without an error message.
    record(
      'urls',
      'warn',
      `PUBLIC_API_URL is ${publicUrl} — not https, so the browser's Secure session cookie is dropped`,
    );
  } else {
    record('urls', 'ok', `PUBLIC_API_URL is ${publicUrl}`);
  }
  const badOrigins = config.api.corsOrigins.filter((origin) => localish.test(origin));
  if (badOrigins.length > 0) {
    record(
      'urls',
      'fail',
      `CORS_ORIGINS still names ${badOrigins.join(', ')} — the browser calls this from the public origin`,
    );
  } else {
    record('urls', 'ok', `CORS_ORIGINS is ${config.api.corsOrigins.join(', ') || '(empty)'}`);
  }

  // ── 5. Postgres, and the migration ledger ─────────────────────────────────
  section('database');
  try {
    const latency = await within(pingDb(), REACHABILITY_TIMEOUT_SECONDS, 'DATABASE_URL');
    record('database', 'ok', `DATABASE_URL answers in ${latency} ms`);

    const files = (
      await Array.fromAsync(
        new Bun.Glob('*.sql').scan({ cwd: new URL('../../packages/db/migrations/', import.meta.url).pathname }),
      )
    )
      .map((file) => file.replace(/\.sql$/, ''))
      .sort();
    const applied = new Set(
      (await rawSql()<{ version: string }[]>`SELECT version FROM schema_migrations`).map((row) => row.version),
    );
    const pending = files.filter((version) => !applied.has(version));
    const unknown = [...applied].filter((version) => !files.includes(version));

    if (pending.length > 0) {
      record(
        'database',
        'fail',
        `${pending.length} migration(s) on disk are not applied: ${pending.join(', ')} — run \`bun run db:migrate\` (the compose service is \`migrate\`) before the new API takes traffic`,
      );
    } else {
      record('database', 'ok', `schema_migrations holds all ${files.length} migration file(s) on disk`);
    }
    if (unknown.length > 0) {
      // The schema being ahead of the code is not a failure to abort on: rolling back the application is exactly the
      // case that produces it, and §6's rule is that schema changes are forward-only. It is worth naming because the
      // deployed code is then older than its database, which is what the operator is usually trying to establish.
      record(
        'database',
        'warn',
        `the database has ${unknown.length} version(s) this checkout does not: ${unknown.join(', ')}`,
      );
    }
  } catch (error) {
    const message = String((error as Error).message ?? error);
    record(
      'database',
      'fail',
      `DATABASE_URL did not answer: ${message}. In the production topology the database publishes no port, so this gate has to run inside the compose network — \`docker compose -f docker-compose.prod.yml run --rm preflight\``,
    );
  }

  // ── 6. Redis ──────────────────────────────────────────────────────────────
  section('redis');
  try {
    const start = performance.now();
    await within(redisConnection().ping(), REACHABILITY_TIMEOUT_SECONDS, 'REDIS_URL');
    record('redis', 'ok', `REDIS_URL answers in ${Math.round(performance.now() - start)} ms`);
  } catch (error) {
    const message = String((error as Error).message ?? error);
    record(
      'redis',
      'fail',
      `REDIS_URL did not answer: ${message}. The queues live here — an API that cannot reach Redis accepts uploads and starts no jobs`,
    );
  }

  // ── 7. Storage ────────────────────────────────────────────────────────────
  section('storage');
  for (const [name, dir] of [
    ['TEMP_DIR', config.storage.tempDir],
    ['STAGING_DIR', config.storage.stagingDir],
  ] as const) {
    if (!isAbsolute(dir)) {
      record('storage', 'fail', `${name} is ${dir} — a relative path resolves against whichever process reads it`);
      continue;
    }
    try {
      await mkdir(dir, { recursive: true });
      // Written rather than inferred from a mode bit: the question is "can this process put bytes here", and a
      // directory can look writable and be a read-only mount, a full filesystem, or owned by another uid.
      const probe = join(dir, '.preflight-probe');
      await writeFile(probe, 'ok');
      await unlink(probe);
      const free = await statfs(dir);
      const freeGb = (free.bavail * free.bsize) / 1024 ** 3;
      const needed = config.storage.workerDiskMinFreeGb;
      if (freeGb < needed) {
        record(
          'storage',
          'fail',
          `${name} has ${freeGb.toFixed(1)} GB free, and a worker will not claim work below ${needed} GB`,
        );
      } else {
        record('storage', 'ok', `${name} is writable with ${freeGb.toFixed(1)} GB free (floor ${needed} GB)`);
      }
    } catch (error) {
      record('storage', 'fail', `${name} (${dir}) could not be written: ${String((error as Error).message ?? error)}`);
    }
  }

  // ── The checks this gate does not make, said out loud ─────────────────────
  section('not checked here');
  record(
    'engines',
    'note',
    'the pool images own this: a pool refuses to boot with a missing engine, and the smoke reads the four pools back',
  );
  record('metrics', 'note', 'no exporter exists yet (`docs/0-MONITORING.md`), so there is nothing to assert');
  record('backups', 'note', 'an operator drill, not a boot assertion (`docs/0-CICD.md` §9)');

  // ── Verdict ───────────────────────────────────────────────────────────────
  const failures = findings.filter((finding) => finding.level === 'fail');
  const warnings = findings.filter((finding) => finding.level === 'warn');
  const passes = findings.filter((finding) => finding.level === 'ok');

  console.log(
    `\n${passes.length} check(s) passed · ${warnings.length} warning(s) · ${failures.length} blocking failure(s)`,
  );
  if (jsonPath) {
    await Bun.write(
      jsonPath,
      `${JSON.stringify({ verdict: failures.length === 0 ? 'pass' : 'fail', findings }, null, 2)}\n`,
    );
    console.log(`findings: ${jsonPath}`);
  }
  if (failures.length > 0) {
    console.log('\npreflight failed — the deploy must not proceed');
    for (const failure of failures) console.log(`  ✗ ${failure.detail}`);
    await closeDb().catch(() => {});
    await closeQueueConnection().catch(() => {});
    process.exit(1);
  }
  console.log('preflight passed');
  await closeDb().catch(() => {});
  await closeQueueConnection().catch(() => {});
}

await main();
