import type { ErrorCode } from './errors';

/** `docs/0-API.md` §7 — every failure uses this shape. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type JobPhase = 'queued' | 'staging' | 'processing' | 'finalizing' | 'done';
/**
 * What can **own a row**: a job or a file is created by a session, an account, or an API key.
 *
 * Kept in step with the database's `owner_kind` enum on purpose — it is the set the columns can hold, and it is why
 * `guest` is not in it.
 */
export type OwnerKind = 'anonymous' | 'user' | 'api_key';

/**
 * What a **caller** can be, which is one more thing than what can own a row (`docs/0-TENANT-FIRST.md` §4.1).
 *
 * A guest is a caller with no account on an installation whose anonymous switch is off: they have no session, so
 * they own nothing and `owner_kind` never records them. They still need a name in `/me`, because every screen that
 * decides between "start something" and "sign in first" branches on it — and a response that says `anonymous` for
 * them would describe an allowance they do not have.
 */
export type CallerKind = OwnerKind | 'guest';

export interface UploadedFile {
  id: string;
  name: string;
  detectedType: string;
  sizeBytes: number;
  pages: number | null;
  encrypted: boolean;
  checksumSha256: string;
  expiresAt: string;
}

export interface JobOutputSummary {
  bytes: number;
  pages: number | null;
  parts: number;
  mime: string;
  name: string;
}

export interface JobResultPart {
  name: string;
  bytes: number;
  mime: string;
  pages?: number[];
}

export interface JobResultBody {
  jobId: string;
  parts: JobResultPart[];
  archiveUrl?: string;
  metrics?: Record<string, unknown>;
  warnings?: Array<{ code: string; detail?: string }>;
}

export interface JobView {
  id: string;
  tool: string;
  status: JobStatus;
  progress: number;
  phase: JobPhase;
  queue: string;
  priority: number;
  output: JobOutputSummary | null;
  warnings: Array<{ code: string; detail?: string }>;
  error: { code: ErrorCode; message: string } | null;
  engine: { name: string; version: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  downloadUrl?: string;
  eventsUrl: string;
  /**
   * Values this job produced that only the caller may hold — today, the owner password `encrypt` generated.
   *
   * Two rules make this field unlike every other one here, and both are the API's rather than the client's:
   * a plain `GET /jobs/:id` never carries it (the request must ask with `?reveal=1`), and the response that does
   * carries `sensitive: true` and `Cache-Control: no-store`. The value is never in the job row, the queue payload,
   * the event stream or a log line, so this response is the only place it exists outside the engine that wrote it.
   */
  secrets?: Record<string, string>;
  /** Marks a response that must not be stored by anything between the service and the caller. */
  sensitive?: boolean;
}

export interface JobListBody {
  items: JobView[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface CreateJobBody {
  tool: string;
  files: string[];
  options?: unknown;
  retainMinutes?: number;
  callbackUrl?: string;
  priority?: number;
  /** Internal: the module slug from the URL, used by the Auth Platform permission gate. */
  module?: string;
}

export interface CreatedJobBody {
  id: string;
  tool: string;
  status: JobStatus;
  queue: string;
  priority: number;
  estimatedSeconds: number | null;
  expiresAt: string;
  eventsUrl: string;
}

export interface HealthBody {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  checks: {
    database: ComponentHealth;
    redis: { ok: boolean; latencyMs: number | null };
    storage: { ok: boolean; tempDir: string; freeBytes: number | null };
    pools: Record<string, { workers: number; queueDepth: number | null }>;
  };
}

export interface ComponentHealth {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface MeBody {
  kind: CallerKind;
  userId: string | null;
  tenantId: string | null;
  displayName: string | null;
  planId: string;
  /**
   * The app roles this caller holds, as Auth Platform defines them for this app.
   *
   * Snapshotted when the session was linked and refreshed at most once per TTL, because the roles are the platform's
   * answer and this app can only ask with something the browser has — the shared-session cookie (`services/app-access.ts`).
   * Empty for a caller with no account, and for a caller whose platform call failed: an empty role list is "nothing
   * granted", never "everyone is an admin".
   */
  appRoles?: string[];
  /**
   * The permission codes those roles carry — the part a menu is actually built from.
   *
   * Codes rather than a boolean per feature, because the app gates on what the platform granted and an `isAdmin`
   * field would be this app's second opinion about a decision it does not own.
   */
  appPermissions?: string[];
  /** Human name of the effective plan, for display only — never a gate. `planId` is what the server branches on. */
  planName: string;
  /**
   * Where the plan came from — `'account'`, `'anonymous'`, `'dev-override'`, or `'none'` for a caller with no
   * account at all (`docs/0-TENANT-FIRST.md` §4.5).
   */
  planSource?: 'account' | 'anonymous' | 'dev-override' | 'none';
  /**
   * Whether an account stands behind this request.
   *
   * The field a sign-in gate reads. It is a boolean rather than a comparison the client makes on `kind`, because a
   * keyed API caller is authenticated without being a browser session.
   */
  authenticated?: boolean;
  /**
   * Whether this installation serves callers with no account (`GET /me`, `docs/0-TENANT-FIRST.md` §3.2).
   *
   * The browser must read this rather than bake it in: the switch lives in Auth Platform's admin app management and
   * can change without a PDF Tools deploy.
   */
  allowAnonymous?: boolean;
  /**
   * Whether **any page** of this installation is public (`GET /me`, `docs/0-TENANT-FIRST.md` §3.2).
   *
   * The larger switch beside `allowAnonymous`, and the browser reads it for a different decision: that one says
   * whether to offer "continue without an account", this one says whether to render the page at all. When it is on
   * every route is replaced by the sign-in gate for a caller with no account — the catalogue and the tool pages
   * included — because there is no page here for them to be on.
   *
   * Separate from `allowAnonymous` rather than folded into it, even though strict mode always resolves that flag to
   * `false`: a screen has to be able to tell the two refusals apart, and "this installation is account-only" is a
   * sentence "anonymous use is switched off" cannot say.
   */
  strictMode?: boolean;
  /**
   * Where to send a caller who needs an account — Auth Platform's public base URL, or `null` when the integration is
   * not configured.
   *
   * Published by the API instead of being written into the web bundle for two reasons: the API already owns that
   * configuration (one fact, one source), and a URL baked into a bundle cannot be corrected by changing the
   * deployment, only by rebuilding it. The browser appends `/login?redirect=<where they were>` itself, because only
   * the browser knows where they were.
   */
  authPlatformUrl?: string | null;
  entitlements: {
    maxFileMb: number;
    maxJobMb: number;
    maxPages: number;
    maxFiles: number;
    queuePriority: number;
  };
  quota: {
    used: number;
    limit: number;
    windowSeconds: number;
    resetAt: string;
    /** Signed-in accounts have no job-count ceiling; sizes still apply. */
    unlimited: boolean;
  };
}

/**
 * The answer to `POST /api/v1/sso/probe` (`docs/0-TENANT-FIRST.md` §5).
 *
 * A probe is a question, not a gate: `linked: false` is the ordinary answer for a caller who has not signed in on the
 * platform, and the caller's next useful move is the sign-in link rather than a retry.
 */
export interface SsoProbeBody {
  /** Did this call turn the browser's shared-session cookie into an account on this session? */
  linked: boolean;
  /**
   * Why not, when there was something to explain — four answers a screen can say differently, which is the reason
   * they are distinct values rather than one `failed`:
   *
   * `'bridge_expired'` — the cookie was there and the platform no longer recognises it (signed out elsewhere, or the
   * token behind it expired). The answer is *sign in again*, and offering a retry would be wrong.
   * `'platform_unreachable'` — the platform did not answer, or answered something unusable. The caller may well be
   * signed in; what failed is the connection, so the answer is *try again*.
   * `'exchange_failed'` — the platform refused the handoff code it had just minted; a race between two requests, not
   * a state anyone is in.
   * `'not_configured'` — this installation has no platform to ask, so there is no sign-in link to offer either.
   */
  reason?: 'bridge_expired' | 'platform_unreachable' | 'exchange_failed' | 'not_configured';
  userId?: string;
  tenantId?: string | null;
  displayName?: string | null;
  planId?: string;
}

/**
 * What one caller may do in this app, straight from the platform that defines the roles.
 *
 * `roles` is what a person holds; `permissions` is the union of what those roles carry. Both are needed because they
 * answer different questions: a screen says *why* ("admins can do this"), and a gate asks *whether*.
 *
 * An empty pair is the honest default for "the platform did not answer": it grants nothing, which is the only
 * direction a failure may point.
 */
export interface AppAccessSnapshot {
  roles: string[];
  permissions: string[];
}

/**
 * The permission codes this app gates on, defined in Auth Platform's seed.
 *
 * Named here as constants rather than spelled inline, because three places must agree: the platform's catalogue (the
 * source), the API route that enforces one, and the web menu that shows the door.
 */
export const APP_PERMISSIONS = {
  /** Open the app's operational dashboard. */
  adminRead: 'pdftools.admin.read',
  /** Run the app's maintenance actions, such as the storage sweep. */
  adminOperate: 'pdftools.admin.operate',
} as const;

/**
 * The app's own operational picture, for the admin dashboard (`GET /api/v1/admin/overview`).
 *
 * Counts, not a live feed: everything here answers a question an operator asks when something looks wrong ("are jobs
 * failing", "is storage filling", "is the platform reachable"), and each answer is a `COUNT`/`SUM` over a table this
 * app already owns.
 */
export interface AdminOverviewBody {
  generatedAt: string;
  jobs: {
    total: number;
    last24h: number;
    last7d: number;
    byStatus: { status: string; count: number }[];
    /** Age of the oldest job still running, in minutes — the number that says whether the pool is keeping up. */
    oldestActiveMinutes: number | null;
  };
  files: { count: number; bytes: number };
  users: { total: number; seenLast7d: number };
  sessions: { active: number; anonymous: number; linked: number };
  /** Queue depth and live worker count per pool — asked together because "nothing is moving" has two causes. */
  queues: { pool: string; waiting: number; workers: number }[];
  platform: {
    /** This installation's app code, as the platform knows it — what the app asks about. */
    appCode: string;
    /** Where the platform answers, or `null` when this installation is not connected to one. */
    baseUrl: string | null;
    /**
     * Whether the platform answered a live request just now — measured, not read from the cache.
     *
     * `null` is "there is no platform to ask", which is a configuration fact rather than an outage.
     */
    reachable: boolean | null;
    /** The status of that probe — a `404` is an answer, and a different problem from silence. */
    status: number | null;
    /**
     * The installation switch as this app *enforces* it, and where that answer came from: `platform` (asked and
     * answered), `stale` (the platform is not answering, so the last confirmed answer is in use), `env` (never
     * answered — the environment's default is in force).
     */
    allowAnonymous: boolean;
    allowAnonymousSource: 'platform' | 'stale' | 'env';
  };
  /** What the caller holds, so the page can state who it is for rather than assuming. */
  caller: AppAccessSnapshot;
}

/**
 * The answer to `POST /api/v1/sso/sign-out` (`docs/0-TENANT-FIRST.md` §5.4).
 *
 * What this ends is the link **and the workspace session behind it**. The browser's `auth_session` cookie belongs to
 * Auth Platform, and on the deployment everybody shares (one host, several ports) a sibling app can revoke the handle
 * inside it — which is what signs the person out of the workspace and of every other app — but it cannot read or
 * rewrite a cookie on another origin. The revocation is therefore done at the platform (`POST /sso/bridge/revoke`,
 * which also records *when*: see `ISignOutLog` in the Auth Platform) and this app's own link is removed where it lives,
 * on the session row. `platform` reports how that call went, because "signed out everywhere" is a claim this
 * installation can only make when the workspace actually heard about it.
 */
export interface SsoSignOutBody {
  /** Always `true`: there is nothing to refuse, and a sign-out that could fail would need a sentence for "you are
   *  still signed in", which is a state nobody can be in afterwards. */
  signedOut: boolean;
  /**
   * What the caller now is: `anonymous` on an installation that serves visitors, `guest` on one that does not.
   *
   * Reported rather than assumed by the client, because the two differ in what the browser may do next — a guest has
   * no session to keep working in, and the sign-in gate is what it will get instead.
   */
  kind: CallerKind;
  /**
   * What happened to the workspace session this browser was holding.
   *
   *  - `revoked` — the platform ended it, so this really was a sign-out everywhere;
   *  - `none` — the browser had no workspace session to end (a link made by URL code, a stack with no platform);
   *  - `unreachable` — the call did not get through. The link here still ended, and the workspace will end its own
   *    copy the next time anything asks it — but nobody should be told it already happened;
   *  - `not_configured` — this installation has no Auth Platform to tell.
   */
  platform: 'revoked' | 'none' | 'unreachable' | 'not_configured';
}

/** SSE event payloads (`docs/0-API.md` §4.6). */
export interface ProgressEvent {
  jobId: string;
  status: JobStatus;
  progress: number;
  phase: JobPhase;
  message?: string;
}
