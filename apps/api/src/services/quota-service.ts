import { config } from '@pdftools/config';
import { type PlanLimits, planFor } from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { AppError } from '@pdftools/errors';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { redisEval } from '../infrastructure/redis';

/**
 * Quota evaluation — `docs/16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3.
 *
 * Resolution order, first match wins: tenant entitlement → user override → plan row → plan constant. The plan
 * constant is the last line of defence, so a missing database row can only ever *narrow* access.
 *
 * Counting happens against the jobs table rather than a Redis counter, because a Redis wipe would otherwise hand
 * every anonymous user a fresh allowance. Redis is used for the fast per-minute rate limit only, where losing the
 * counter for a moment is harmless.
 */

export interface QuotaSnapshot {
  planId: EffectivePlanId;
  used: number;
  limit: number;
  windowSeconds: number;
  resetAt: string;
  /**
   * A signed-in account has no job-count ceiling: fair-use sizes still apply,
   * but `used >= limit` never refuses. The web app reads this rather than
   * comparing the numbers, so a raised plan can never look like a cap again.
   */
  unlimited: boolean;
}

/** The plans a session can be *evaluated* as, as opposed to the plan its account owns. */
export type EffectivePlanId = 'guest' | 'anonymous' | 'free' | 'pro' | 'business';

/**
 * A caller with no account, on an installation that does not serve anonymous visitors
 * (`docs/0-TENANT-FIRST.md` §4.1).
 *
 * Every field that names an owner is `null`, and that is the point: there is no row this caller may read, and
 * `ownerId: null` cannot be passed to a query by accident — the compiler refuses it, so every read path has to say
 * what a guest gets instead of quietly matching nothing. It is deliberately *not* the empty string, which would
 * compile everywhere and search for an owner that cannot exist.
 */
export interface GuestIdentity {
  kind: 'guest';
  ownerId: null;
  anonId: null;
  planId: null;
  userId: null;
  tenantId: null;
}

export interface AnonymousIdentity {
  kind: 'anonymous';
  ownerId: string;
  anonId: string;
  planId: 'anonymous';
  userId: null;
  tenantId: null;
  /**
   * A plan a *dev stack* granted this session (`plugins/dev-plan.ts`), never a subscription.
   *
   * Separate from `planId` on purpose: `kind: 'anonymous'` keeps meaning "no account", and every reader — the
   * quota resolver, the job gate, `/me` — can tell a granted plan from a paid one without a second lookup.
   */
  planOverride?: 'free' | 'pro' | 'business';
}

export interface UserIdentity {
  kind: 'user';
  ownerId: string;
  anonId: null;
  planId: 'free' | 'pro' | 'business';
  userId: string;
  tenantId: string | null;
}

export interface ApiKeyIdentity {
  kind: 'api_key';
  ownerId: string;
  anonId: null;
  planId: 'pro' | 'business';
  userId: string;
  tenantId: string | null;
}

export type OwnerIdentity = GuestIdentity | AnonymousIdentity | UserIdentity | ApiKeyIdentity;

/**
 * Every identity that can **own work** — everything except a guest.
 *
 * The distinction is enforced by the type of the functions that create or meter work (`storeUpload`, `createJob`,
 * `assertQuotaAvailable`, `assertConcurrencyAvailable`): a guest cannot reach them without first passing
 * `assertCreationAllowed`, which narrows the identity and has a unit test of its own. Spelling it as a named alias
 * rather than `Exclude<OwnerIdentity, GuestIdentity>` keeps the intent readable at the signature.
 */
export type WorkIdentity = AnonymousIdentity | UserIdentity | ApiKeyIdentity;

/**
 * Every plan a **job** can be recorded against.
 *
 * Not `EffectivePlanId`: a guest resolves to `'guest'`, and no job row, queue payload or usage record can ever carry
 * that value — the creation routes refuse a guest before anything is written (`services/access-policy.ts`). The name
 * exists so the database-facing types stay honest about it instead of the enum growing a member that cannot occur.
 */
export type BillingPlanId = Exclude<EffectivePlanId, 'guest'>;

/**
 * The plan a request is evaluated against — the account's plan, or the dev override where one was granted.
 *
 * One function rather than `identity.planOverride ?? identity.planId` at each site, because the plan gate and the
 * quota resolver disagreeing about which plan applies is precisely the bug that would make a gated tool look open.
 *
 * Overloaded on the identity so the caller gets the narrower answer it can actually have: `'guest'` is a plan name
 * (`/me`, the catalog) and never a billing value (a job row, a queue payload), and the overload is what makes that a
 * compile-time fact rather than a comment on the enum.
 */
export function effectivePlanId(identity: GuestIdentity): 'guest';
export function effectivePlanId(identity: WorkIdentity): BillingPlanId;
export function effectivePlanId(identity: OwnerIdentity): EffectivePlanId;
export function effectivePlanId(identity: OwnerIdentity): EffectivePlanId {
  if (identity.kind === 'guest') return 'guest';
  return identity.kind === 'anonymous' ? (identity.planOverride ?? 'anonymous') : identity.planId;
}

/** Effective limits for an owner: entitlement mirror first, then the plan table, then the constants. */
export async function limitsFor(identity: OwnerIdentity): Promise<PlanLimits> {
  const fallback = planFor(effectivePlanId(identity));
  // A guest's plan *is* the guest row — zeroes and an empty tool list — so there is nothing to merge and no
  // entitlement to look up, which is why it falls out of both branches below without a third one being written.
  // The consequence the catalog depends on: `available` is false for every tool, because `tools` is empty rather
  // than `['*']` (`docs/0-TENANT-FIRST.md` §4.2).
  if (identity.kind === 'guest') return fallback;
  if (identity.kind === 'anonymous') {
    // A granted plan has no entitlement row to resolve and no operator-managed limits: it is the plan table itself.
    // Applying the *anonymous* config ceiling here instead would silently cap the very tools the override exists to
    // exercise (`maxPages: 200` refuses a Pro-sized archival job before any engine runs).
    if (identity.planOverride) return fallback;
    return {
      ...fallback,
      maxFileMb: config.limits.maxFileSizeMb,
      maxJobMb: config.limits.maxJobSizeMb,
      maxPages: config.limits.maxPagesAnonymous,
      jobsPerWindow: config.limits.maxJobsPerDayAnonymous,
      windowSeconds: 86_400,
      maxConcurrent: config.limits.maxConcurrentJobsPerSession,
    };
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.entitlements)
    .where(
      identity.tenantId
        ? eq(schema.entitlements.tenantId, identity.tenantId)
        : eq(schema.entitlements.userId, identity.userId),
    )
    .limit(1);

  const entitlement = rows[0];
  if (entitlement?.limits) {
    const limits = entitlement.limits as Partial<PlanLimits>;
    const merged: PlanLimits = { ...fallback, ...limits, id: entitlement.planId };
    // A trial or period that has ended falls back to Free, never to a plan that was never confirmed.
    if (entitlement.validUntil && entitlement.validUntil.getTime() < Date.now()) {
      return planFor('free');
    }
    return merged;
  }

  return fallback;
}

export async function quotaSnapshot(identity: OwnerIdentity, limits: PlanLimits): Promise<QuotaSnapshot> {
  // A guest is not "at zero for this window": there is no window, and no counter that could ever move. Reported as
  // zeroes rather than thrown on, because `/me` has to answer a guest — that answer is how the web app knows to
  // show a sign-in gate instead of a quota meter.
  if (identity.kind === 'guest') {
    return { planId: 'guest', used: 0, limit: 0, windowSeconds: 0, resetAt: new Date().toISOString(), unlimited: false };
  }

  const since = new Date(Date.now() - limits.windowSeconds * 1000);
  const [row] = await getDb()
    .select({ value: count() })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.ownerId, identity.ownerId), gte(schema.jobs.createdAt, since)));

  return {
    planId: effectivePlanId(identity),
    used: Number(row?.value ?? 0),
    limit: limits.jobsPerWindow,
    windowSeconds: limits.windowSeconds,
    resetAt: new Date(Date.now() + limits.windowSeconds * 1000).toISOString(),
    // Accounts are unlimited by job count; API keys keep their plan's window.
    unlimited: identity.kind === 'user',
  };
}

export async function assertQuotaAvailable(identity: WorkIdentity, limits: PlanLimits): Promise<QuotaSnapshot> {
  const snapshot = await quotaSnapshot(identity, limits);
  if (!snapshot.unlimited && snapshot.used >= snapshot.limit) {
    throw new AppError('QUOTA_EXCEEDED', undefined, {
      used: snapshot.used,
      limit: snapshot.limit,
      resetAt: snapshot.resetAt,
      planId: snapshot.planId,
    });
  }
  return snapshot;
}

export async function assertConcurrencyAvailable(identity: WorkIdentity, limits: PlanLimits): Promise<void> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(schema.jobs)
    .where(
      and(eq(schema.jobs.ownerId, identity.ownerId), inArray(schema.jobs.status, ['QUEUED', 'PROCESSING'] as const)),
    );
  const running = Number(row?.value ?? 0);
  if (running >= limits.maxConcurrent) {
    throw new AppError('CONCURRENCY_LIMIT', undefined, { running, limit: limits.maxConcurrent });
  }
}

/**
 * Charge one request against `scope`, refusing it with `RATE_LIMITED` when the allowance is spent.
 *
 * A token bucket rather than a fixed window, for two reasons that are both about what the limiter is *for*:
 *
 *  1. **A limit must not refuse a legal request.** Uploads are charged per file, and the largest batch the registry
 *     accepts is 50 files (`merge`) or 100 (`images-to-pdf`) — so a flat 30-per-minute ceiling made the product's
 *     own maximum request impossible to stage inside a minute. `burst` is the size of one such batch, and capacity
 *     is `limitPerMinute + burst`: one maximal request always fits, from a cold or a long-idle session.
 *  2. **"Per minute" said two different things.** A fixed window allows `2 × limit` across a boundary — 30 at
 *     12:00:59 and 30 at 12:01:00 is 60 in one second — while a bucket allows at most `burst` instantly and then
 *     `limitPerMinute` per minute *for every minute afterwards*, which is the sentence the docs can be held to.
 *
 * The refill is continuous, so a caller that spends its burst waits for the tokens rather than for a window edge.
 * `RATE_LIMITED` carries `retryAfterSeconds`, derived from the tokens actually missing, so a client that honours
 * it is never told to wait longer than it has to — nor to come back before it would be served.
 *
 * If Redis is unavailable the request is allowed through rather than blocked: a cache outage must not become an
 * outage of the product. That is a deliberate asymmetry — the limiter protects a process, and it is not the thing
 * that decides whether a caller may do something.
 */
export async function assertRateLimit(
  scope: string,
  limitPerMinute = config.limits.rateLimitPerMinute,
  /**
   * Extra requests available as an instantaneous allowance, on top of `limitPerMinute` per minute of refill.
   * Passed by callers whose *single legal request* is itself many charged requests — uploads, where the charge is
   * one per file. A caller whose request is one charge (job creation) leaves this at 0.
   */
  burst = 0,
): Promise<void> {
  try {
    const capacity = limitPerMinute + Math.max(0, burst);
    const refillPerMs = limitPerMinute / 60_000;
    const [allowed, tokens] = (await redisEval(
      RATE_LIMIT_SCRIPT,
      [`ratelimit:${scope}`],
      [
        Date.now(),
        capacity,
        refillPerMs,
        // Two minutes of TTL: long enough that a bucket is never thrown away mid-refill (which would hand back a full
        // allowance), short enough that an idle identity leaves nothing in Redis.
        120_000,
      ],
    )) as [number, number];
    if (allowed === 0) {
      const missing = 1 - tokens;
      throw new AppError('RATE_LIMITED', undefined, {
        retryAfterSeconds: Math.max(1, Math.ceil(missing / (refillPerMs * 1000))),
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    return;
  }
}

/**
 * The bucket, as one atomic step: refill from elapsed time, charge if there is anything to charge, report the rest.
 *
 * Written as a script rather than `GET` + `SET` because the gap between those two commands is exactly where a
 * caller spends the same token twice — and a limiter that can be beaten by sending requests concurrently is a
 * limiter that has never been tested by the traffic it exists for.
 *
 * `KEYS[1]` is the bucket. `ARGV`: now (ms), capacity, refill per ms, TTL (ms). Returns `{allowed, tokens}` with
 * `tokens` floored, so a caller told to retry can be told how long for.
 */
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local stored = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(stored[1])
local at = tonumber(stored[2])
if tokens == nil then
  tokens = capacity
  at = now
end

local elapsed = now - at
if elapsed > 0 then
  tokens = math.min(capacity, tokens + elapsed * refillPerMs)
  at = now
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'at', at)
redis.call('PEXPIRE', key, ttlMs)
return { allowed, math.floor(tokens) }
`;
