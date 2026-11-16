import { config } from '@pdftools/config';
import { APP_PERMISSIONS, type AdminOverviewBody } from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { AppError } from '@pdftools/errors';
import { ALL_QUEUES, queueDepth } from '@pdftools/queue';
import { gte, sql } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { redis } from '../infrastructure/redis';
import { resolveIdentity } from '../plugins/session';
import { callerAccess, hasPermission } from '../services/app-access';
import { appSwitches } from '../services/app-switches';
import { runSweep } from '../services/cleanup-service';

/**
 * The app's own admin surface — the routes behind the menu only an app `admin` sees.
 *
 * What makes this module worth having rather than a page that reads the public API: these are the questions an
 * operator asks when something is wrong, and they are questions about *other people's* rows (every job, every file,
 * every session). Answering them needs a permission the platform defines, so the gate is the first statement of each
 * route, and it is the same check the menu makes — one permission code, read from the platform, enforced here.
 *
 * Why the permission and not the role name: a role is a bag the platform's app management can re-cut at any time
 * (that is the point of defining them there), so a route testing `roles.includes('admin')` would stop matching the
 * moment somebody renamed or re-scoped it. The code is the contract (`APP_PERMISSIONS`).
 *
 * The refusal is the same whether the caller is a guest or a signed-in account with no roles: the difference is not
 * theirs to see, and "an administrator can grant you this" is actionable in both cases.
 */

/** Resolve the caller and answer whether they hold a permission — the gate both routes start with. */
async function requirePermission(ctx: Parameters<typeof resolveIdentity>[0], code: string) {
  const auth = await resolveIdentity(ctx);
  const access = await callerAccess(ctx, auth);
  if (!hasPermission(access, code)) {
    throw new AppError(
      'FORBIDDEN',
      'This is the app administration area. An administrator of this app can grant your account the admin role.',
    );
  }
  return { auth, access };
}

/** Workers register a short-TTL heartbeat key, so "is a pool alive" is Redis expiring rather than a list anyone keeps. */
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

/**
 * The platform, as this app can see it right now.
 *
 * Two different questions, asked together because the answer to one makes the other meaningful: a live probe of the
 * platform's public app route (`reachable`, `status`), and the installation switch as this app *enforces* it with its
 * `source`. The switch comes from the resolver rather than from the probe, because what an operator needs to know is
 * what the app will do: "the platform says visitors may not, but we are serving them from a stale answer" is exactly
 * the situation this pair of fields exists to make visible.
 */
async function platformState() {
  const resolved = await appSwitches().resolve();
  const base = config.api.authPlatformInternalUrl;

  let reachable: boolean | null = null;
  let status: number | null = null;
  if (base) {
    try {
      const response = await fetch(`${base}/apps/${encodeURIComponent(config.api.appCode)}/public`, {
        signal: AbortSignal.timeout(3000),
      });
      // Any answer is an answer: a `404` means an app code the platform does not know, which is a misconfiguration
      // worth showing rather than an outage to hide.
      reachable = true;
      status = response.status;
    } catch {
      reachable = false;
    }
  }

  return {
    appCode: config.api.appCode,
    baseUrl: base,
    reachable,
    status,
    allowAnonymous: resolved.allowAnonymous,
    allowAnonymousSource: resolved.source,
    // The second switch, from the same answer and the same source: an operator diagnosing "why is every page asking
    // for a sign-in" needs one place that says which of the two is in force and whether the app got it from the
    // platform or from its own environment.
    strictMode: resolved.strictMode,
  };
}

export const adminModule = new Elysia({ prefix: '/api/v1/admin', tags: ['admin'] })
  .get('/overview', async (ctx) => {
    const { access } = await requirePermission(ctx, APP_PERMISSIONS.adminRead);

    const db = getDb();
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 3600_000);
    const weekAgo = new Date(now - 7 * 24 * 3600_000);

    const [jobTotal, jobs24h, jobs7d, jobsByStatus, oldestActive, fileTotals, userTotals, sessionCounts, platform] =
      await Promise.all([
        db.select({ value: sql<number>`count(*)::int` }).from(schema.jobs),
        db.select({ value: sql<number>`count(*)::int` }).from(schema.jobs).where(gte(schema.jobs.createdAt, dayAgo)),
        db.select({ value: sql<number>`count(*)::int` }).from(schema.jobs).where(gte(schema.jobs.createdAt, weekAgo)),
        db
          .select({ status: schema.jobs.status, value: sql<number>`count(*)::int` })
          .from(schema.jobs)
          .groupBy(schema.jobs.status),
        // The age of the oldest job that has not finished. A pool can be short and still stuck, and one long-running
        // job is invisible in a count of rows.
        db
          .select({ oldest: schema.jobs.createdAt })
          .from(schema.jobs)
          .where(sql`${schema.jobs.status} in ('QUEUED','PROCESSING')`)
          .orderBy(schema.jobs.createdAt)
          .limit(1),
        db
          .select({
            count: sql<number>`count(*)::int`,
            bytes: sql<string>`coalesce(sum(${schema.files.sizeBytes}),0)::bigint`,
          })
          .from(schema.files),
        db
          .select({
            total: sql<number>`count(*)::int`,
            seenLast7d: sql<number>`count(*) filter (where ${schema.users.lastSeenAt} >= ${weekAgo.toISOString()})::int`,
          })
          .from(schema.users),
        db
          .select({
            active: sql<number>`count(*) filter (where ${schema.sessions.expiresAt} > now() and ${schema.sessions.revokedAt} is null)::int`,
            anonymous: sql<number>`count(*) filter (where ${schema.sessions.kind} = 'anonymous')::int`,
            linked: sql<number>`count(*) filter (where ${schema.sessions.kind} = 'user')::int`,
          })
          .from(schema.sessions),
        platformState(),
      ]);

    const queues: AdminOverviewBody['queues'] = [];
    for (const pool of ALL_QUEUES) {
      const [waiting, workers] = await Promise.all([queueDepth(pool).catch(() => 0), countWorkers(pool)]);
      queues.push({ pool, waiting, workers });
    }

    const oldest = oldestActive[0]?.oldest ?? null;
    const overview: AdminOverviewBody = {
      generatedAt: new Date().toISOString(),
      jobs: {
        total: jobTotal[0]?.value ?? 0,
        last24h: jobs24h[0]?.value ?? 0,
        last7d: jobs7d[0]?.value ?? 0,
        byStatus: jobsByStatus
          .map((row) => ({ status: row.status, count: row.value }))
          .sort((a, b) => b.count - a.count),
        oldestActiveMinutes: oldest ? Math.round((now - oldest.getTime()) / 60_000) : null,
      },
      files: {
        count: fileTotals[0]?.count ?? 0,
        bytes: Number(fileTotals[0]?.bytes ?? 0),
      },
      users: { total: userTotals[0]?.total ?? 0, seenLast7d: userTotals[0]?.seenLast7d ?? 0 },
      sessions: {
        active: sessionCounts[0]?.active ?? 0,
        anonymous: sessionCounts[0]?.anonymous ?? 0,
        linked: sessionCounts[0]?.linked ?? 0,
      },
      queues,
      platform,
      caller: access,
    };

    return overview;
  })
  /**
   * The maintenance action, moved here from the account module for one reason: it used to be open to any signed-in
   * caller on a development stack, and "any account may delete other people's expired files" is not a rule that should
   * depend on `NODE_ENV`. It needs the app's operate permission now, in every environment.
   */
  .post('/sweep', async (ctx) => {
    await requirePermission(ctx, APP_PERMISSIONS.adminOperate);
    return await runSweep();
  });
