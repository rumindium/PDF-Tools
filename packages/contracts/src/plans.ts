/**
 * Plan limits — the single table both the API (enforcement) and the web app (copy) read.
 *
 * Values come from `docs/16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3. In production these are also mirrored into the
 * `plans` table so an operator can raise a limit without a deploy; this constant table is the seed and the
 * fallback when a row is missing, so a database problem can never widen access.
 */

export type PlanId = 'guest' | 'anonymous' | 'free' | 'pro' | 'business';

export interface PlanLimits {
  id: PlanId;
  name: string;
  maxFileMb: number;
  maxJobMb: number;
  maxPages: number;
  maxFiles: number;
  jobsPerWindow: number;
  windowSeconds: number;
  maxConcurrent: number;
  queuePriority: number;
  resultTtlMinutes: number;
  historyDays: number;
  maxApiKeys: number;
  /**
   * The tools this plan may run: `['*']` for everything, or an explicit list.
   *
   * This is the **entitlement mirror**, not the per-tier tool gate. Tier gating lives in the registry's own
   * `plans` field on each tool (a Pro-only tool is refused even for a wildcard entitlement), so an empty list here
   * does not mean "no tools matter" — it means "this caller may run nothing at all". Two plans say exactly that,
   * and only two: `guest`, which is a caller with no account on an installation where anonymous use is switched
   * off, and a restricted Auth Platform entitlement. Every other plan starts at `['*']`.
   */
  tools: string[];
}

export const PLANS: Record<PlanId, PlanLimits> = {
  /**
   * A caller with no account, on an installation that does not serve anonymous visitors
   * (`docs/0-TENANT-FIRST.md`). Every number is zero and the tool list is empty, on purpose: this plan is not a
   * floor that a missing row falls back to, it is the *absence* of an allowance, and a guest's request never gets
   * far enough to consult one — the creation routes refuse it first with `AUTH_REQUIRED`.
   *
   * It exists as a row rather than as a special case in the resolver so that "which plan is this" has one
   * representation everywhere: the catalog, `/me`, the plan name in a log line. A `guest` identity wearing the
   * *anonymous* plan's limits is the one thing that must not happen — it would hand the very caller the gate is
   * for a 200-page, 10-job allowance and a `['*']` tool list, and every tool would read as available.
   */
  guest: {
    id: 'guest',
    name: 'Guest',
    maxFileMb: 0,
    maxJobMb: 0,
    maxPages: 0,
    maxFiles: 0,
    jobsPerWindow: 0,
    windowSeconds: 0,
    maxConcurrent: 0,
    // Last in every queue there is, rather than first: `1` is Business's priority, and a guest worker slot is a
    // hypothetical that must not outrank a paying tenant's if one is ever constructed by mistake.
    queuePriority: 99,
    resultTtlMinutes: 0,
    historyDays: 0,
    maxApiKeys: 0,
    tools: [],
  },
  anonymous: {
    id: 'anonymous',
    name: 'Anonymous',
    maxFileMb: 50,
    maxJobMb: 100,
    maxPages: 200,
    maxFiles: 5,
    jobsPerWindow: 15,
    windowSeconds: 86_400,
    maxConcurrent: 1,
    queuePriority: 10,
    resultTtlMinutes: 30,
    historyDays: 0,
    maxApiKeys: 0,
    tools: ['*'],
  },
  free: {
    id: 'free',
    name: 'Free',
    maxFileMb: 100,
    maxJobMb: 200,
    maxPages: 500,
    maxFiles: 20,
    jobsPerWindow: 20,
    windowSeconds: 86_400,
    maxConcurrent: 2,
    queuePriority: 8,
    resultTtlMinutes: 30,
    historyDays: 7,
    maxApiKeys: 0,
    tools: ['*'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    maxFileMb: 300,
    maxJobMb: 600,
    maxPages: 2000,
    maxFiles: 50,
    jobsPerWindow: 200,
    windowSeconds: 86_400,
    maxConcurrent: 5,
    queuePriority: 5,
    resultTtlMinutes: 60,
    historyDays: 30,
    maxApiKeys: 5,
    tools: ['*'],
  },
  business: {
    id: 'business',
    name: 'Business',
    maxFileMb: 1024,
    maxJobMb: 2048,
    maxPages: 10_000,
    maxFiles: 200,
    jobsPerWindow: 2000,
    windowSeconds: 86_400,
    maxConcurrent: 10,
    queuePriority: 1,
    resultTtlMinutes: 120,
    historyDays: 90,
    maxApiKeys: 50,
    tools: ['*'],
    // No OCR-specific page ceiling: `15-OCR.md` §6 bounds OCR by the plan's own page limit (500 Free, 2 000 Pro),
    // and `16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3 is the table that defines it — one page limit per plan, not two.
    // An earlier `ocrPagesPerJob` here declared 0 for anonymous, which reads as "no OCR" while behaving as
    // "unlimited", and nothing read it either way.
  },
};

/**
 * The limits for a plan id, and the floor when there is no row at all.
 *
 * An unknown id falls back to `anonymous`, deliberately: a caller whose plan could not be resolved is treated as a
 * visitor, never as a paying one. `guest` is not that fallback — it is reached only by an identity that says it has
 * no account, which is a fact about the caller rather than a failure to look one up.
 */
/**
 * The plans that exist as rows in the `plans` table (`docs/16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3).
 *
 * `guest` is deliberately absent. That table is how an operator tunes a limit without a deploy, and a guest has no
 * limit to tune — every number is zero and the tool list is empty, so a row for it would be a policy surface that
 * anybody editing it could only get wrong. The constant above is the whole definition of a guest, and the distinction
 * is named here rather than expressed as a filter in the seeder so that both readers spell it the same way.
 */
export const PLAN_ROW_IDS = ['anonymous', 'free', 'pro', 'business'] as const satisfies readonly PlanId[];

export type PlanRowId = (typeof PLAN_ROW_IDS)[number];

export function planFor(planId: string | null | undefined): PlanLimits {
  if (planId && planId in PLANS) return PLANS[planId as PlanId];
  return PLANS.anonymous;
}
