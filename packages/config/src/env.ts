import { z } from 'zod';

/**
 * Environment contract — `docs/0-CONFIG.md`.
 *
 * Every operational limit comes from here, never from a literal in business code. Parsing happens once at
 * import time so a misconfigured deployment fails at boot instead of at 3 a.m. mid-job.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    // An unrecognised value is a typo in a deploy config. Quietly reading it as `false` would disable a feature
    // without saying so, which is the kind of thing that is discovered from a user report weeks later.
    .transform((v, ctx) => {
      if (v == null || v === '') return def;
      const normalized = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a boolean (true/false), got "${v}"` });
      return z.NEVER;
    });

/**
 * A numeric variable with a default and an enforced range.
 *
 * Out-of-range values are a boot failure, not a clamp: a `MAX_FILE_SIZE_MB=0` that silently became 50 would look
 * like the setting worked, and the operator would go looking for the bug somewhere else. The `ctx.addIssue` path
 * is what makes the error message name the variable and the bound.
 */
const num = (def: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v == null || v === '') return def;
      const range = z
        .number()
        .min(min ?? Number.NEGATIVE_INFINITY)
        .max(max ?? Number.POSITIVE_INFINITY);
      const result = range.safeParse(Number(v));
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected a number${min != null || max != null ? ` between ${min ?? '−∞'} and ${max ?? '∞'}` : ''}, got "${v}"`,
        });
        return z.NEVER;
      }
      return result.data;
    });

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : v));

const Env = z.object({
  NODE_ENV: str('development'),
  APP_VERSION: str('0.1.0'),
  LOG_LEVEL: str('info'),
  LOG_PRETTY: bool(true),

  // ── Ports and URLs ──────────────────────────────────────────────────────
  API_PORT: num(8080),
  API_HOST: str('0.0.0.0'),
  PUBLIC_API_URL: str('http://localhost:8080'),
  /** Comma-separated origins allowed to call the API with credentials. */
  CORS_ORIGINS: str('http://localhost:5180'),
  /**
   * Auth Platform base URLs. Empty means no SSO, no permission gate, and no app-config mirror — which is only
   * coherent while this installation serves anonymous callers; `bootProblems` refuses the combination.
   */
  AUTH_PLATFORM_URL: str(''),
  AUTH_PLATFORM_INTERNAL_URL: str(''),
  /**
   * The app whose admin record owns the installation-wide switches (`docs/0-TENANT-FIRST.md` §3).
   *
   * Held here rather than hardcoded because it is an identifier a deployment may have to change — a staging
   * installation registered as `pdf-tools-staging` is a legitimate thing to run — and because a literal in the
   * resolver is the kind of value that gets copied into a second place and then drifts.
   */
  AUTH_PLATFORM_APP_CODE: str('pdf-tools'),
  /**
   * The name of Auth Platform's shared-session cookie — the bridge this app reads to learn that the caller has an
   * account (`docs/0-TENANT-FIRST.md` §5).
   *
   * A name, not a URL, and therefore not something this app can discover: the cookie is set by the platform's own
   * web app on a host-only domain, and the browser hands it over to whoever shares that host. Configurable for the
   * one case a name has to change — a platform that renames its cookie — rather than as an invitation to guess.
   */
  AUTH_PLATFORM_SESSION_COOKIE: str('auth_session'),

  // ── Storage ─────────────────────────────────────────────────────────────
  TEMP_DIR: str('/var/lib/pdf-tools/jobs'),
  STAGING_DIR: str('/var/lib/pdf-tools/staging'),
  JOB_TTL_MINUTES: num(30),
  UPLOAD_TTL_MINUTES: num(60),
  FAILED_TTL_MINUTES: num(60),
  FS_SWEEP_INTERVAL_SECONDS: num(300),
  FS_SWEEP_MAX_AGE_MINUTES: num(180),
  CLEANUP_INTERVAL_SECONDS: num(60),
  WORKER_DISK_MIN_FREE_GB: num(5),

  // ── Database and queue ──────────────────────────────────────────────────
  DATABASE_URL: str('postgres://pdftools:pdftools@localhost:5435/pdftools'),
  DATABASE_POOL_MAX: num(10),
  REDIS_URL: str('redis://localhost:6382'),
  JOB_MAX_ATTEMPTS: num(2, 1, 10),
  JOB_BACKOFF_MS: num(2000),
  JOB_STALLED_MS: num(120_000),

  // ── Access (who may use this installation at all) ───────────────────────
  /**
   * Whether a caller with **no account** may use this installation.
   *
   * `false` is the shipped default — an installation is tenant-first unless an operator says otherwise
   * (`docs/0-TENANT-FIRST.md` §3.2). It is a *fallback* rather than the authority: when the Auth Platform answers
   * `GET /apps/{code}/public`, that answer wins, so the switch can be flipped from admin app management without a
   * redeploy. The local value is what a stack with no platform reachable at all uses — which is every CI stack,
   * where the alternative would be a suite that cannot open its own gate.
   */
  ALLOW_ANONYMOUS: bool(false),
  /**
   * Whether **any page** of this installation is public.
   *
   * The larger question beside `ALLOW_ANONYMOUS`, and the difference is what a visitor sees before signing in rather
   * than what they may do afterwards: with anonymous use off, the catalogue and the tool pages are still readable and
   * only *starting something* asks for an account; with strict mode on, the app renders nothing for a caller with no
   * account and every route asks them to sign in first.
   *
   * Same shape as the switch above — a local fallback the platform's answer overrides, because the authority is the
   * app's record in Auth Platform's admin app management (`STRICT_MODE` is what a stack with no platform reachable at
   * all uses, which is every CI stack). It also **outranks `ALLOW_ANONYMOUS`**: an installation that publishes no page
   * cannot be serving visitors, so the effective answer is computed once, in `effectiveAllowAnonymous` below, rather
   * than at each of the places that read it.
   */
  STRICT_MODE: bool(false),
  /**
   * How long a resolved answer (from the platform *or* from the fallback above) is trusted.
   *
   * Also the negative-cache window: an unreachable platform is not re-asked on every request, because a failed
   * lookup per request is a per-request latency cost that grows exactly when the platform is unwell.
   */
  APP_ANONYMOUS_CACHE_SECONDS: num(60, 0, 3600),
  /**
   * How many probes one caller may make per minute, keyed by hashed IP.
   *
   * The probe is the one route a guest may call that reaches Auth Platform, and a guest has no bucket of their own:
   * the identity-scoped limiter every other route uses keys on `owner_id`, which a guest does not have. So the key
   * is the IP hash — the same degradation `plugins/session.ts` already documents for anonymous quota accounting,
   * and for the same reason: it is the only handle a caller with no session leaves behind.
   */
  SSO_PROBE_PER_MINUTE: num(12, 1, 600),

  // ── Limits ──────────────────────────────────────────────────────────────
  MAX_FILE_SIZE_MB: num(50),
  MAX_JOB_SIZE_MB: num(100),
  MAX_PAGES_ANONYMOUS: num(200),
  MAX_JOBS_PER_DAY_ANONYMOUS: num(15),
  MAX_CONCURRENT_JOBS_PER_SESSION: num(2),
  RATE_LIMIT_PER_MINUTE: num(60),
  UPLOAD_CONCURRENCY: num(3),
  MAX_SPLIT_PARTS: num(200),
  SSE_HEARTBEAT_SECONDS: num(15),
  PROGRESS_MIN_INTERVAL_MS: num(500),
  IDEMPOTENCY_TTL_HOURS: num(24),
  ENGINE_LOG_TAIL_BYTES: num(4096),
  ENGINE_KILL_GRACE_SECONDS: num(5),

  // ── Anonymous session ───────────────────────────────────────────────────
  SESSION_COOKIE_NAME: str('pdft_session'),
  SESSION_SECRET: str('dev-only-change-me'),
  ANON_SESSION_TTL_HOURS: num(24),

  // ── Workers ─────────────────────────────────────────────────────────────
  WORKER_POOL: str('light'),
  WORKER_ID: str(''),
  WORKER_LIGHT_CONCURRENCY: num(4),
  WORKER_OFFICE_CONCURRENCY: num(2),
  WORKER_HEAVY_CONCURRENCY: num(2),
  WORKER_OCR_CONCURRENCY: num(2),
  SHUTDOWN_GRACE_SECONDS: num(30),
  LIBREOFFICE_TIMEOUT_SECONDS: num(300),

  // ── Engine paths (empty = resolve from PATH) ────────────────────────────
  ENGINE_QPDF_PATH: str(''),
  ENGINE_GS_PATH: str(''),
  ENGINE_MUTOOL_PATH: str(''),
  ENGINE_SOFFICE_PATH: str(''),
  ENGINE_MAGICK_PATH: str(''),
  ENGINE_OCRMYPDF_PATH: str(''),
  ENGINE_TESSERACT_PATH: str(''),
  ENGINE_VERAPDF_PATH: str(''),
  /**
   * The ICC profile the PDF/A output intent embeds, when a deployment has its own.
   *
   * Empty means "find Ghostscript's" — which is what the image ships and what a normal deployment wants. A path here
   * wins over discovery, because a colour-managed archive usually has to name a profile it was colour-managed with.
   */
  ENGINE_GS_ICC_PROFILE: str(''),
  ENGINE_PYTHON_PATH: str('python3'),

  // ── Development/test-only entitlement switch ────────────────────────────
  /**
   * The shared token that turns `x-dev-plan` into a plan for an anonymous session.
   *
   * Empty — the default, and the only value this process will accept in production — means the header is ignored.
   * A dev or CI stack sets it so plan-gated tools can be exercised without an Auth Platform subscription; the guard
   * in `parseEnv` refuses to boot a production process with it set, because a variable that grants Pro to every
   * caller is the one configuration mistake that must fail loudly rather than quietly.
   */
  DEV_PLAN_TOKEN: str(''),

  // ── Tool feature flags ──────────────────────────────────────────────────
  TOOL_MERGE_ENABLED: bool(true),
  TOOL_SPLIT_ENABLED: bool(true),
  TOOL_PDF_TO_IMAGES_ENABLED: bool(true),
  TOOL_OFFICE_TO_PDF_ENABLED: bool(true),
  TOOL_PDF_TO_PDFA_ENABLED: bool(true),
  TOOL_OCR_ENABLED: bool(true),
  // On by default, because the heavy image ships the validator (`infra/docker/Dockerfile.workers`, 18 MB for the CLI
  // pack — the figure the old default was justified by, ~200 MB, is the GUI distribution). A deployment that builds
  // the image without veraPDF sets this false deliberately, and the worker's engine check list then stops expecting
  // it; leaving it on without the binary fails the worker at boot rather than at the first archival job.
  PDFA_VALIDATE: bool(true),
});

export type Env = z.infer<typeof Env>;

export interface ConfigProblem {
  variable: string;
  message: string;
}

/**
 * The one rule that pairs strict mode with anonymous use, as a pure function of the two flags.
 *
 * **Strict mode wins.** An installation that publishes no page cannot be serving visitors, so the effective answer to
 * "may a caller with no account use this?" is `false` whenever strict mode is on, whatever the anonymous flag says.
 *
 * Exported and taking a plain pair rather than reading `raw`, because three callers need the same rule over three
 * different sources: this file's own `config.access` (the local fallback), the boot check above, and
 * `services/app-switches.ts`, which applies it to what the platform answered. Four spellings of one comparison is how
 * the two flags drift into disagreeing — and the failure that produces is a mirror reporting "visitors are welcome"
 * on an installation where every page demands a sign-in.
 */
export function combineAccessFlags(flags: { allowAnonymous: boolean; strictMode: boolean }): boolean {
  return flags.allowAnonymous && !flags.strictMode;
}

/** The local form of the rule above, over the parsed environment. */
function effectiveAllowAnonymous(raw: Env): boolean {
  return combineAccessFlags({ allowAnonymous: raw.ALLOW_ANONYMOUS, strictMode: raw.STRICT_MODE });
}

/**
 * Combinations of individually valid values that are, together, a configuration mistake.
 *
 * Separate from `parseEnv` and exported, for the reason the dev-plan switch is a parameter rather than a global
 * read: a rule that can only be exercised by starting a process with the wrong environment is a rule nobody tests.
 * Both of the entries below are rules whose failure mode is silence — a process that boots and then behaves in a
 * way no operator asked for — so both are checked here, once, at boot, and unit-tested against a plain object.
 *
 * Note the audience: this answers "may *this* process serve on this configuration", not "is this configuration
 * parseable". The distinction is what `assertBootable` exists to keep, and what defect 212 cost when it was lost.
 *
 * Called by the API's bootstrap and each worker pool's, and by nothing else: those are the processes where "no caller
 * could use this installation" is a fact about the deployment rather than about the file being run. A migration, a
 * seeder or a CI harness wants the same parsed values and no opinion about who may sign in.
 */
export function bootProblems(raw: Env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  // A production deployment with this set is a configuration error, and refusing to start is the only outcome that
  // cannot hand a plan to whoever asks for one. The request path also refuses it (defence in depth), but that path
  // is one `if` away from being edited; this one is not.
  if (raw.NODE_ENV === 'production' && raw.DEV_PLAN_TOKEN) {
    problems.push({
      variable: 'DEV_PLAN_TOKEN',
      message: 'must not be set when NODE_ENV=production — it lets any caller choose their own plan',
    });
  }

  // The combination that makes the product unusable for *everyone*: anonymous callers are refused, and there is no
  // platform to sign in against, so no request can ever carry an account. Checked everywhere rather than only in
  // production, because a stack that boots into this state is indistinguishable from a broken build — every route
  // answers 401 and nothing says why — and the accident this catches is a default nobody restated
  // (`docs/0-TENANT-FIRST.md` §3.2: the local value exists for stacks that *cannot* reach a platform).
  //
  // `NODE_ENV=test` is the one exemption, and it is the environment the rule would otherwise make impossible to
  // have: a stack nobody may enter is exactly the fixture the guest path needs, and a tenant-first profile that
  // cannot boot is a tenant-first profile with no test. CI's own container is `NODE_ENV: test` and states
  // `ALLOW_ANONYMOUS: true` explicitly, so the anonymous path is still proven there rather than merely assumed.
  // The rule is stated over the **effective** answer, not over one of the two variables that produce it, because
  // strict mode turns anonymous use off by itself: a check that read `ALLOW_ANONYMOUS` alone would pass a strict
  // installation whose `ALLOW_ANONYMOUS` happened to be `true`, which is precisely the combination that serves nobody
  // and says nothing about why.
  if (raw.NODE_ENV !== 'test' && !effectiveAllowAnonymous(raw) && !raw.AUTH_PLATFORM_URL) {
    problems.push({
      // Named for the flag an operator actually has to change: with strict mode on, `ALLOW_ANONYMOUS` is not the
      // problem and setting it to `true` would not fix anything, so pointing at it would send them to the wrong line.
      variable: raw.STRICT_MODE ? 'STRICT_MODE' : 'ALLOW_ANONYMOUS',
      // Both ways out, and both variables, because either one alone is a half-fix — and that sentence is what an
      // operator reads at 2am instead of the source. `ALLOW_ANONYMOUS=true` is named even when strict mode is the
      // flag at fault: turning strict mode off is the other half, and the message has to say so rather than leaving
      // someone to guess that the two are related.
      message:
        'leaves this installation with no caller who could use it while AUTH_PLATFORM_URL is empty, so neither a ' +
        'visitor nor a signed-in person can reach it; point AUTH_PLATFORM_URL at the Auth Platform API, or set ' +
        'ALLOW_ANONYMOUS=true, or turn STRICT_MODE off',
    });
  }

  return problems;
}

/**
 * Parse the environment's *shape*: types, ranges, defaults.
 *
 * The coherence rules are deliberately **not** applied here, and that is a correction rather than a preference. They
 * used to run at import time, which made them apply to every process that reads a configuration value — including the
 * ones that do not serve requests. `bun run db:seed` and `bun run db:migrate` import `@pdftools/db`, which imports
 * this module, so a host with no `AUTH_PLATFORM_URL` in its environment could not seed or migrate a database at all,
 * which is what the recipe in `docker-compose.verify.yml` asks for. A rule whose subject is "this installation can
 * serve nobody" has nothing to say about a one-shot script, and a guard that fires where its subject is absent is a
 * guard people learn to route around (`assertBootable` below is where it belongs, and defect 212 records the find).
 *
 * Shape, by contrast, genuinely is every process's business: a `MAX_FILE_SIZE_MB` of `"lots"` is wrong in a script
 * too.
 */
function parseEnv(): Env {
  const result = Env.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

const raw = parseEnv();

/**
 * Refuse to start a **serving process** whose environment makes the product unusable.
 *
 * Called by the API's bootstrap and each worker pool's, and by nothing else: those are the processes where "no caller
 * could use this installation" is a fact about the deployment rather than about the file being run. A migration, a
 * seeder or a CI harness wants the same parsed values and no opinion about who may sign in.
 *
 * The message still lists every problem at once, so an operator fixing two variables gets two sentences rather than
 * two restarts.
 */
export function assertBootable(source: Env = raw): void {
  const problems = bootProblems(source);
  if (problems.length === 0) return;
  const lines = problems.map((problem) => `  ${problem.variable}: ${problem.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}

export const config = {
  env: raw.NODE_ENV,
  version: raw.APP_VERSION,
  logLevel: raw.LOG_LEVEL,
  logPretty: raw.LOG_PRETTY,

  api: {
    port: raw.API_PORT,
    host: raw.API_HOST,
    publicUrl: raw.PUBLIC_API_URL,
    corsOrigins: raw.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    authPlatformUrl: raw.AUTH_PLATFORM_URL || null,
    authPlatformInternalUrl: raw.AUTH_PLATFORM_INTERNAL_URL || raw.AUTH_PLATFORM_URL || null,
    appCode: raw.AUTH_PLATFORM_APP_CODE,
    /**
     * The **shared-session cookie the browser is expected to hold**, and the one name in this file that describes
     * something this app does not set. Named here so the probe and the deployment's own documentation cannot spell
     * it differently (`docs/0-TENANT-FIRST.md` §5 step 5).
     */
    platformCookieName: raw.AUTH_PLATFORM_SESSION_COOKIE,
  },

  access: {
    /**
     * The local answer to "may a caller with no account use this?" — the fallback of `docs/0-TENANT-FIRST.md` §3.2,
     * **with strict mode already applied**: `false` whenever `STRICT_MODE` is on, whatever `ALLOW_ANONYMOUS` says.
     *
     * Paired here rather than at each read site for the reason `App.EffectiveAllowAnonymous` gives on the platform
     * side: the two flags answer one question, and a caller that combined them itself is a caller that can get the
     * combination wrong. `strictMode` below is what tells the two reasons apart when a screen needs to say why.
     */
    allowAnonymous: effectiveAllowAnonymous(raw),
    /** Whether this installation publishes anything at all to a caller with no account. */
    strictMode: raw.STRICT_MODE,
    switchCacheSeconds: raw.APP_ANONYMOUS_CACHE_SECONDS,
  },

  storage: {
    tempDir: raw.TEMP_DIR,
    stagingDir: raw.STAGING_DIR,
    jobTtlMinutes: raw.JOB_TTL_MINUTES,
    uploadTtlMinutes: raw.UPLOAD_TTL_MINUTES,
    failedTtlMinutes: raw.FAILED_TTL_MINUTES,
    fsSweepIntervalSeconds: raw.FS_SWEEP_INTERVAL_SECONDS,
    fsSweepMaxAgeMinutes: raw.FS_SWEEP_MAX_AGE_MINUTES,
    cleanupIntervalSeconds: raw.CLEANUP_INTERVAL_SECONDS,
    workerDiskMinFreeGb: raw.WORKER_DISK_MIN_FREE_GB,
  },

  db: {
    url: raw.DATABASE_URL,
    poolMax: raw.DATABASE_POOL_MAX,
  },

  redis: {
    url: raw.REDIS_URL,
  },

  queue: {
    maxAttempts: raw.JOB_MAX_ATTEMPTS,
    backoffMs: raw.JOB_BACKOFF_MS,
    stalledMs: raw.JOB_STALLED_MS,
  },

  limits: {
    maxFileSizeMb: raw.MAX_FILE_SIZE_MB,
    maxJobSizeMb: raw.MAX_JOB_SIZE_MB,
    maxPagesAnonymous: raw.MAX_PAGES_ANONYMOUS,
    maxJobsPerDayAnonymous: raw.MAX_JOBS_PER_DAY_ANONYMOUS,
    maxConcurrentJobsPerSession: raw.MAX_CONCURRENT_JOBS_PER_SESSION,
    rateLimitPerMinute: raw.RATE_LIMIT_PER_MINUTE,
    ssoProbePerMinute: raw.SSO_PROBE_PER_MINUTE,
    uploadConcurrency: raw.UPLOAD_CONCURRENCY,
    maxSplitParts: raw.MAX_SPLIT_PARTS,
    sseHeartbeatSeconds: raw.SSE_HEARTBEAT_SECONDS,
    progressMinIntervalMs: raw.PROGRESS_MIN_INTERVAL_MS,
    idempotencyTtlHours: raw.IDEMPOTENCY_TTL_HOURS,
    engineLogTailBytes: raw.ENGINE_LOG_TAIL_BYTES,
    engineKillGraceSeconds: raw.ENGINE_KILL_GRACE_SECONDS,
  },

  session: {
    cookieName: raw.SESSION_COOKIE_NAME,
    secret: raw.SESSION_SECRET,
    anonTtlHours: raw.ANON_SESSION_TTL_HOURS,
    /** `null` when unset, which is the production configuration: the dev plan header is then ignored entirely. */
    devPlanToken: raw.DEV_PLAN_TOKEN || null,
  },

  worker: {
    pool: raw.WORKER_POOL,
    id: raw.WORKER_ID || `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    concurrency: {
      light: raw.WORKER_LIGHT_CONCURRENCY,
      office: raw.WORKER_OFFICE_CONCURRENCY,
      heavy: raw.WORKER_HEAVY_CONCURRENCY,
      ocr: raw.WORKER_OCR_CONCURRENCY,
    },
    shutdownGraceSeconds: raw.SHUTDOWN_GRACE_SECONDS,
    libreOfficeTimeoutSeconds: raw.LIBREOFFICE_TIMEOUT_SECONDS,
  },

  engines: {
    qpdf: raw.ENGINE_QPDF_PATH || null,
    ghostscript: raw.ENGINE_GS_PATH || null,
    mutool: raw.ENGINE_MUTOOL_PATH || null,
    soffice: raw.ENGINE_SOFFICE_PATH || null,
    magick: raw.ENGINE_MAGICK_PATH || null,
    ocrmypdf: raw.ENGINE_OCRMYPDF_PATH || null,
    tesseract: raw.ENGINE_TESSERACT_PATH || null,
    verapdf: raw.ENGINE_VERAPDF_PATH || null,
    ghostscriptIccProfile: raw.ENGINE_GS_ICC_PROFILE || null,
    python: raw.ENGINE_PYTHON_PATH,
  },

  flags: {
    merge: raw.TOOL_MERGE_ENABLED,
    split: raw.TOOL_SPLIT_ENABLED,
    'pdf-to-images': raw.TOOL_PDF_TO_IMAGES_ENABLED,
    'office-to-pdf': raw.TOOL_OFFICE_TO_PDF_ENABLED,
    'pdf-to-pdfa': raw.TOOL_PDF_TO_PDFA_ENABLED,
    ocr: raw.TOOL_OCR_ENABLED,
  } as Record<string, boolean>,

  pdfaValidate: raw.PDFA_VALIDATE,
} as const;

export type Config = typeof config;

export function isProduction(): boolean {
  return config.env === 'production';
}
