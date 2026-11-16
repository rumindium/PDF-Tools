import { config } from '@pdftools/config';
import type { SsoProbeBody } from '@pdftools/contracts/api';
import { getDb, pingDb, rawSql, schema } from '@pdftools/db';
import { AppError } from '@pdftools/errors';
import { ALL_QUEUES, queueDepth } from '@pdftools/queue';
import { count, desc, eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { pingRedis, redis } from '../infrastructure/redis';
import { freeBytes } from '../infrastructure/storage';
import {
  type IdentitySource,
  endLinkedSession,
  hashIp,
  resolveIdentity,
  sessionPlatformBridge,
} from '../plugins/session';
import { callerAccess } from '../services/app-access';
import { appSwitches } from '../services/app-switches';
import {
  type HandoffFailure,
  codeFromBridge,
  consumeFailure,
  linkFromHandoffCode,
  revokeBridge,
} from '../services/handoff';
import {
  type OwnerIdentity,
  assertRateLimit,
  effectivePlanId,
  limitsFor,
  quotaSnapshot,
} from '../services/quota-service';

/**
 * `GET /me`, usage aggregation, and the health endpoints.
 *
 * The health check is deliberately split: `/health/live` says "the process is up" (used by Docker to decide
 * whether to restart), while `/health/ready` says "this instance can do useful work" (used by a load balancer to
 * decide whether to send traffic). A pool with zero workers makes readiness `degraded` but does not fail it —
 * other pools still work, and taking the whole service out of rotation would turn a partial outage into a total
 * one (`docs/0-WORKERS.md` §6).
 */
/**
 * Where the caller's plan came from, as one word.
 *
 * Extracted rather than inlined because it now has four answers and a nested ternary in a response object is where
 * the fifth one would be added wrongly. `'none'` is the guest's: not a plan granted by nobody, but the absence of a
 * plan, which is what a client needs in order to tell "you are on the anonymous floor" from "you have no account at
 * all" (`docs/0-TENANT-FIRST.md` §4.2).
 */
function planSourceOf(identity: OwnerIdentity): 'account' | 'anonymous' | 'dev-override' | 'none' {
  if (identity.kind === 'guest') return 'none';
  if (identity.kind !== 'anonymous') return 'account';
  return identity.planOverride ? 'dev-override' : 'anonymous';
}

/**
 * The probe's refusal, in the shape a screen can act on.
 *
 * The one translation here is the third case: the platform refusing a code it had just minted is a race between two
 * requests, not a state a caller is in, so it reaches the screen as `exchange_failed` — which the gate answers with
 * "try again" rather than "sign in" (`apps/web/src/features/sign-in-gate/gate.ts`).
 */
function probeRefusal(failure: HandoffFailure): { linked: false; reason: NonNullable<SsoProbeBody['reason']> } {
  switch (failure) {
    case 'code_rejected':
      return { linked: false, reason: 'exchange_failed' };
    case 'platform_unreachable':
      return { linked: false, reason: 'platform_unreachable' };
    // Both of these mean "sign in again" to the screen, which is why the contract has one reason for them; what
    // differs is what already happened to the session, and that is what the row records rather than the response.
    case 'bridge_expired':
    case 'bridge_revoked':
      return { linked: false, reason: 'bridge_expired' };
    case 'not_configured':
      return { linked: false, reason: 'not_configured' };
  }
}

/**
 * End this browser's link, if it has one, because the platform says the session is over.
 *
 * Used by the probe, whose callers are usually strangers but need not be: a page load with a linked session and a
 * revoked handle must not leave the row answering as an account. Idempotent — a caller with no link is already in the
 * state this produces.
 */
async function endExistingLink(ctx: IdentitySource): Promise<void> {
  const auth = await resolveIdentity(ctx);
  if (auth.identity.kind !== 'user' || !auth.sessionId) return;
  await endLinkedSession(ctx, auth.sessionId);
}

/** The handle this link was made with, for the case where the browser's cookie is already gone. */
async function storedPlatformBridge(sessionId: string): Promise<string | null> {
  const row = (await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1))[0];
  return row?.platformBridge ?? null;
}

export const accountModule = new Elysia({ prefix: '/api/v1', tags: ['account'] })
  .get('/me', async (ctx) => {
    const auth = await resolveIdentity(ctx);
    const limits = await limitsFor(auth.identity);
    const quota = await quotaSnapshot(auth.identity, limits);
    // Resolved here rather than inside `resolveIdentity`: this is the route a page load hits, so it is the natural
    // place for the TTL refresh, and identity resolution stays a read with no platform call in it. The admin routes
    // resolve it again for themselves before they answer — a menu that trusts `/me` is fine, an API that does is not.
    const access = await callerAccess(ctx, auth);
    // The installation switches, resolved once for this response: this is the route every page load hits, so the
    // answer the client gates its router on arrives with the identity it is gating (`docs/0-TENANT-FIRST.md` §3.2).
    const switches = await appSwitches().resolve();

    const profile =
      auth.identity.userId != null
        ? (await getDb().select().from(schema.users).where(eq(schema.users.id, auth.identity.userId)).limit(1))[0]
        : undefined;

    const planId = effectivePlanId(auth.identity);
    return {
      kind: auth.identity.kind,
      userId: auth.identity.userId,
      tenantId: auth.identity.tenantId,
      displayName: profile?.displayName ?? null,
      planId,
      planName: limits.name,
      /** Where this plan came from — including `'none'`, which is a guest's answer (`planSourceOf` above). */
      planSource: planSourceOf(auth.identity),
      /**
       * Is there an account behind this request?
       *
       * A boolean rather than something the client derives from `kind`, because a keyed API caller is authenticated
       * without being a browser session — a gate that tested `kind !== 'user'` would offer it a sign-in form.
       */
      authenticated: auth.identity.kind !== 'guest',
      /**
       * Where to send a caller who needs an account. `null` when this installation is not connected to a platform —
       * a state the boot guard refuses to start in *when* anonymous use is off (`packages/config/src/env.ts`), which
       * is exactly the state the gate screen exists for.
       */
      authPlatformUrl: config.api.authPlatformUrl,
      /**
       * The installation switches, as resolved for this request (`services/app-switches.ts`).
       *
       * Published so the browser is never told at build time: a web bundle carrying its own copy of this answer
       * would disagree with the API the moment an operator changed it in admin app management — the "one fact,
       * two spellings" family this codebase keeps meeting (`0-FINAL-SUMMARY.md` §3).
       *
       * Read from the resolver here rather than off the identity context, because a copy on the context is a copy that
       * can be written wrongly once and believed everywhere (`plugins/session.ts` says which literal did that).
       */
      allowAnonymous: switches.allowAnonymous,
      /**
       * Whether **any page** of this installation is public.
       *
       * The larger question beside `allowAnonymous`, and the client needs it for a different decision: that one tells a
       * screen whether to offer "continue without an account", this one tells the router whether to render the page at
       * all. Published from the resolver for the same reason, and reported separately rather than folded into the flag
       * above because the two reasons a visitor is refused must be tellable apart on screen (`services/access-policy.ts`).
       */
      strictMode: switches.strictMode,
      /**
       * What this caller may do in this app, as the platform defines it.
       *
       * Published for the same reason `allowAnonymous` is: the answer lives in Auth Platform's admin app management
       * and can change without a deploy here, so a bundle that decided the menu at build time would be wrong the
       * moment a sysadmin granted somebody the admin role.
       */
      appRoles: access.roles,
      appPermissions: access.permissions,
      entitlements: {
        maxFileMb: limits.maxFileMb,
        maxJobMb: limits.maxJobMb,
        maxPages: limits.maxPages,
        maxFiles: limits.maxFiles,
        queuePriority: limits.queuePriority,
      },
      quota,
      // `quota.planId` is the effective plan too, so a client does not have to reconcile two answers.
    };
  })
  .get('/me/usage', async ({ query, ...ctx }) => {
    const auth = await resolveIdentity(ctx);
    const groupBy = String(query?.groupBy ?? 'tool');

    // A guest has neither an `anon_id` nor a `user_id`, so the aggregation below would bind two nulls and match
    // nothing — correctly, but by accident. Said out loud instead, because "this endpoint returns nothing for a
    // guest" is a fact worth being able to read rather than deduce from a query that cannot match.
    if (auth.identity.kind === 'guest') return { groupBy, buckets: [] };

    const client = rawSql();

    // Anonymous callers get aggregate counts only — no history by design, which is also why this endpoint
    // cannot be used to enumerate someone's past documents.
    const rows =
      groupBy === 'day'
        ? await client<{ bucket: string; jobs: number; bytes: number }[]>`
            SELECT to_char(occurred_at, 'YYYY-MM-DD') AS bucket,
                   count(*)::int AS jobs,
                   coalesce(sum(value) FILTER (WHERE metric = 'bytes_out'), 0)::bigint AS bytes
            FROM usage_records WHERE anon_id = ${auth.identity.anonId} OR user_id = ${auth.identity.userId}
            GROUP BY 1 ORDER BY 1 DESC LIMIT 30`
        : await client<{ bucket: string; jobs: number; bytes: number }[]>`
            SELECT tool AS bucket,
                   count(*)::int AS jobs,
                   coalesce(sum(value) FILTER (WHERE metric = 'bytes_out'), 0)::bigint AS bytes
            FROM usage_records WHERE anon_id = ${auth.identity.anonId} OR user_id = ${auth.identity.userId}
            GROUP BY 1 ORDER BY 2 DESC LIMIT 30`;

    return { groupBy, buckets: rows };
  })
  .get('/me/jobs', async ({ query, ...ctx }) => {
    // Alias of GET /jobs scoped to the caller — kept because the docs promise it and clients use it.
    const auth = await resolveIdentity(ctx);
    const page = Math.max(1, Number(query?.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize ?? 20)));

    // Same reasoning as `/me/usage`: an empty page, not a refusal, so this alias and `GET /jobs` cannot answer
    // differently for the same caller.
    if (auth.identity.kind === 'guest') {
      return { items: [], page, pageSize, total: 0, hasMore: false };
    }

    const db = getDb();
    const [totals] = await db
      .select({ value: count() })
      .from(schema.jobs)
      .where(eq(schema.jobs.ownerId, auth.identity.ownerId));
    const rows = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.ownerId, auth.identity.ownerId))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const total = Number(totals?.value ?? 0);
    return {
      items: rows.map((job) => ({
        id: job.id,
        tool: job.tool,
        status: job.status,
        progress: job.progress,
        output: job.outputBytes != null ? { bytes: job.outputBytes } : null,
        createdAt: job.createdAt.toISOString(),
        expiresAt: job.expiresAt.toISOString(),
      })),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
    };
  })
  /**
   * The other end of the My Apps handoff (`docs/CROSS-MODULE.md` §3).
   *
   * A user clicks PDF Tools in the workspace's My apps, the workspace mints a single-use code and opens
   * `<this app>/auth/sso?code=…`. This endpoint turns that code into a **session**, and the distinction from
   * "return the tokens" is the whole design:
   *
   *  - The exchange happens here. The access token is used to ask Auth Platform who the caller is and is then
   *    dropped — it is never returned, so it cannot end up in `localStorage`, a readable cookie, or a URL. (A
   *    real token is well past the 4 KB cookie limit anyway, which is the failure the sibling platforms hit.)
   *  - The caller's anonymous session is *upgraded*, not replaced, so files and jobs already uploaded survive
   *    the sign-in.
   *  - Anonymous use is untouched: a browser that never visits a handoff URL keeps its anonymous session and
   *    its anonymous quota forever. Signing in is an addition, never a gate.
   */
  .post('/sso/consume', async (ctx) => {
    const { body } = ctx;
    const platformBase = config.api.authPlatformInternalUrl ?? config.api.authPlatformUrl;
    if (!config.api.authPlatformUrl || !platformBase) {
      throw new AppError('FORBIDDEN', 'Auth Platform integration is not configured on this installation.');
    }
    const code = (body as { code?: string } | undefined)?.code;
    if (!code) throw new AppError('VALIDATION_ERROR', 'A handoff code is required.');

    // The exchange and the link live in `services/handoff.ts`, shared with `POST /sso/probe`: both doors differ only
    // in where the code came from, and the failure taxonomy is worth spelling once.
    // A URL code carries no app roles: the platform mints it for a caller who may not even be signed in there yet
    // (`My apps` is reachable from a workspace, not from the platform's own session), so the snapshot starts empty and
    // the first read that has a cookie refreshes it (`services/app-access.ts`). Passing `null` explicitly is the
    // point: it clears anything a previous sign-in left on this browser's session row.
    const result = await linkFromHandoffCode(ctx, code, null);
    if ('failure' in result) throw consumeFailure(result.failure);

    const session = result.session;
    return {
      linked: true,
      sessionId: session.sessionId,
      userId: session.userId,
      tenantId: session.tenantId,
      displayName: session.displayName,
      planId: session.planId,
      appRoles: session.access.roles,
      appPermissions: session.access.permissions,
    };
  })
  /**
   * The same link, discovered from the shared-session cookie instead of from a URL (`docs/0-TENANT-FIRST.md` §5).
   *
   * This is the door for a visitor who signed in at the platform and came back: Auth Platform pushes them to
   * `?redirect=<this app>`, its own `auth_session` cookie is now in the browser (host-only, so every port on this
   * host sees it), and there is *no* handoff code in the URL — the platform had nobody to mint one for at the moment
   * it redirected. The cookie is HttpOnly, so only this process can read it, which is why the probe is an API route
   * rather than something the browser does.
   *
   * Three properties are deliberate:
   *
   *  - **Not a gate.** `linked: false` is a normal answer, not an error, and this route resolves no identity: it
   *    never mints an anonymous session, never writes a row, and is reachable on a flag-on installation that has
   *    nothing to gate. The caller's next move (a sign-in link, a retry) is theirs to make.
   *  - **Idempotent enough to call on mount.** A caller who is already linked gets `linked: false` — nothing is
   *    exchanged, because there is no cookie to exchange when the platform is not signed in... and when it is, the
   *    platform mints a fresh code each time, which is why the web app calls this at most once per page load
   *    (`apps/web/src/features/sign-in-gate/index.tsx`).
   *  - **Rate-limited by IP hash.** A guest has no `owner_id`, so the identity-scoped limiter every other route uses
   *    cannot key on anything of theirs; the hash is the only handle they leave behind, and a request with no
   *    discoverable IP shares one conservative bucket rather than enjoying none.
   */
  .post('/sso/probe', async (ctx) => {
    const ipKey = hashIp(ctx.server?.requestIP(ctx.request)?.address ?? null) ?? 'unknown';
    await assertRateLimit(`sso:probe:${ipKey}`, config.limits.ssoProbePerMinute);

    const bridge = sessionPlatformBridge(ctx);
    // Not signed in on the platform, or the browser never had the cookie (a different host, a private window, a
    // browser that blocks third-party cookies). All three are the same answer, and none of them is an error.
    if (!bridge) return { linked: false };

    const minted = await codeFromBridge(bridge);
    if ('failure' in minted) {
      // A revoked handle is a sign-out that happened somewhere else, and the caller may still be linked *here* (the
      // probe is not only for strangers): end this browser's link before answering, so the page that asked cannot
      // render an account over a session the platform has already ended.
      if (minted.failure === 'bridge_revoked') await endExistingLink(ctx);
      // `bridge_expired` is the only failure worth a reason here: the caller is not signed in *and* needs to sign in
      // again, which the gate says differently from "we could not reach the workspace".
      return probeRefusal(minted.failure);
    }

    // The roles travel with the link: this is the one door that already holds the shared-session cookie, so the
    // platform answered "who is this" and "what may they do in this app" in the same round trip, and the session row
    // is written with both.
    const result = await linkFromHandoffCode(ctx, minted.code, minted.access);
    if ('failure' in result) return probeRefusal(result.failure);

    return {
      linked: true,
      userId: result.session.userId,
      tenantId: result.session.tenantId,
      displayName: result.session.displayName,
      planId: result.session.planId,
      appRoles: result.session.access.roles,
      appPermissions: result.session.access.permissions,
    };
  })
  /**
   * Sign out of **this app** — the reverse of `consume`/`probe` (`docs/0-TENANT-FIRST.md` §5.4).
   *
   * Why this route exists at all: the browser holds Auth Platform's shared-session cookie, so a sign-out that only
   * deleted something in the page would be undone by the very next probe — the caller would press Sign out, open any
   * tool, and find themselves signed in again. The link therefore has to be broken where it lives (the session row)
   * *and* the browser has to be told not to re-link on its own, which is the flag the web app writes next to it.
   *
   * Three deliberate properties:
   *
   *  - **It only revokes a session the account was resolved from.** The bearer-token path resolves with `sessionId`
   *    set to the *user* id, and the cookie may point at a session that was never linked while a token did the
   *    authenticating; revoking either of those would end somebody else's session or throw away an anonymous
   *    browser's own history. "This cookie's row is the account I just resolved" is the whole test.
   *  - **Idempotent, and never an error.** Signing out twice, or signing out as a caller whose cookie was never
   *    linked, has one answer: you are a guest or an anonymous visitor again. A refusal would need a sentence
   *    explaining a state the caller cannot be in.
   *  - **The platform's cookie is not touched.** It is not ours to clear (see the contract's note on
   *    `SsoSignOutBody`); what stops the next page load from linking it straight back is the web app's own memory
   *    (`apps/web/src/lib/auto-link.ts`).
   *  - **What the caller becomes is this installation's own answer.** A stack that serves visitors puts the session
   *    back on the anonymous floor it came from; a stack that requires an account revokes it so the caller is a real
   *    `guest` and the gate applies. Returning everybody to "the state a stranger would be in" is the whole rule
   *    (`plugins/session.ts` spells out why neither branch can serve both).
   */
  .post('/sso/sign-out', async (ctx) => {
    const auth = await resolveIdentity(ctx);
    const rawCookie = ctx.cookie[config.session.cookieName]?.value;
    const cookieSessionId = typeof rawCookie === 'string' && rawCookie.length > 0 ? rawCookie : null;

    const fromThisCookie =
      cookieSessionId != null &&
      !auth.bearerToken &&
      auth.identity.kind === 'user' &&
      auth.sessionId === cookieSessionId;

    // The workspace session goes first, and it goes even when this installation serves anonymous visitors: the person
    // pressed Sign out, and "signed out of this app but still signed in on the workspace" is the state they were
    // trying to leave (`docs/0-TENANT-FIRST.md` §7f). The handle to revoke is the one in the cookie, or — when the
    // browser no longer has it — the one this link was made with.
    const linkedBridge = cookieSessionId ? await storedPlatformBridge(cookieSessionId) : null;
    const handle = sessionPlatformBridge(ctx) ?? linkedBridge;
    const platform = handle ? await revokeBridge(handle) : 'none';

    if (fromThisCookie && cookieSessionId) {
      await endLinkedSession(ctx, cookieSessionId);
    }

    // The caller's *new* identity, re-resolved rather than assumed, because the two installations answer differently:
    // on one that requires an account the cleared cookie resolves as `guest` and the header offers a sign-in, and on
    // one that serves visitors the same request mints a fresh anonymous session. That second case is also why the
    // resolve below comes last: it may write its own `Set-Cookie`, and the identity that names the answer has to be
    // the one the response carries.
    const after = await resolveIdentity(ctx);
    // `platform` is reported rather than assumed: this installation can always end its *own* link, and saying
    // "signed out everywhere" over a workspace that never heard about it would be the app claiming more than it did.
    return { signedOut: true, kind: after.identity.kind, platform };
  });
// The on-demand cleanup sweep used to live in this module, guarded by `env !== 'development'`. It moved to
// `modules/admin.ts` with a real gate (`pdftools.admin.operate`): "any signed-in caller on a development stack may
// delete other people's expired files" was a rule that depended on an environment variable, which is not a
// permission model.

export const healthModule = new Elysia({ tags: ['health'] })
  .get('/health', async () => await healthReport())
  .get('/health/live', () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }))
  .get('/health/ready', async ({ set }) => {
    const report = await healthReport();
    if (!report.checks.database.ok || !report.checks.redis.ok) set.status = 503;
    return report;
  });

async function healthReport() {
  const [dbLatency, redisLatency, storageFree] = await Promise.all([
    pingDb().catch(() => null),
    pingRedis().catch(() => null),
    freeBytes(),
  ]);

  const pools: Record<string, { workers: number; queueDepth: number | null }> = {};
  for (const pool of ALL_QUEUES) {
    const workers = await countWorkers(pool);
    const depth = await queueDepth(pool).catch(() => null);
    pools[pool] = { workers, queueDepth: depth };
  }

  const database = {
    ok: dbLatency != null,
    latencyMs: dbLatency,
    ...(dbLatency == null ? { error: 'unreachable' } : {}),
  };
  const redis = { ok: redisLatency != null, latencyMs: redisLatency };

  return {
    status: database.ok && redis.ok ? ('ok' as const) : ('degraded' as const),
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database,
      redis,
      storage: { ok: storageFree != null, tempDir: config.storage.tempDir, freeBytes: storageFree },
      pools,
    },
  };
}

/**
 * Workers register themselves with a short-TTL heartbeat key, so "is a pool alive" is answered by Redis
 * expiring rather than by anyone keeping a list of processes (`docs/0-WORKERS.md` §6).
 */
async function countWorkers(pool: string): Promise<number> {
  try {
    const keys = await redis().keys(`pdftools:worker:${pool}:*`);
    let alive = 0;
    for (const key of keys) {
      if (await redis().exists(key)) alive += 1;
    }
    return alive;
  } catch {
    return 0;
  }
}
