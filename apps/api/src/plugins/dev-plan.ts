/**
 * The development entitlement switch — how Pro-sized limits are exercised in a stack with no accounts.
 *
 * No tool in the registry is plan-gated (every tool runs on every plan), but limits still differ by plan — page
 * ceilings, file sizes, quotas — and every session a dev stack can hold is anonymous, so a Pro-sized archival job
 * would be refused by the *limits* before any engine runs. The plan that a *real* caller is evaluated against
 * comes from the entitlement mirror (Auth Platform subscription → `entitlements` row), which means the honest
 * options were (a) wire the whole subscription path, or (b) give a dev stack a way to say "this session is Pro"
 * and say so out loud, everywhere, including in the API's own response. This is (b).
 *
 * Three properties make it safe to have at all:
 *
 *  1. **It cannot be enabled in production.** `parseEnv` refuses to boot a `NODE_ENV=production` process with
 *     `DEV_PLAN_TOKEN` set, and this module refuses the header even if that guard were bypassed — `env` is a
 *     parameter here, not a read of the global config, so the refusal is unit-tested rather than assumed.
 *  2. **It needs a shared secret, not just a header.** A bare `x-dev-plan: pro` header would be a one-line
 *     privilege escalation on any stack that had the switch on by accident; the token makes an accidental
 *     *deployment* of the switch useless to a caller who does not know it.
 *  3. **It is visible.** The override is reported as `planSource: 'dev-override'` on `/me` and carried on the
 *     identity, so a job created under it can never be mistaken for a subscription that was actually paid for.
 *
 * It applies to **anonymous sessions only**, deliberately: a signed-in session's plan is exactly what the
 * entitlement mirror exists to resolve, and overriding it would hide the code path the override is meant to help
 * test.
 */

import { timingSafeEqual } from 'node:crypto';

/** The plans a caller may ask for. `anonymous` is not on the list: that is what a session already is. */
export const DEV_PLAN_IDS = ['free', 'pro', 'business'] as const;
export type DevPlanId = (typeof DEV_PLAN_IDS)[number];

export const DEV_PLAN_HEADER = 'x-dev-plan';
export const DEV_PLAN_TOKEN_HEADER = 'x-dev-plan-token';

/**
 * The two request headers, as the identity resolver sees them.
 *
 * `headers.get` (the standard `Request` shape) rather than Elysia's convenience `header()`: the declared type of
 * `ctx.request` is the standard `Request`, and a narrower interface that only the runtime happens to satisfy is how a
 * cast gets written and a bug hides behind it.
 */
export interface DevPlanRequest {
  headers: { get(name: string): string | null };
}

/**
 * The plan an anonymous session asked to be evaluated as, or `null` for "no override".
 *
 * Every failure returns `null` rather than throwing: an unrecognised or unauthorised header on a dev stack should
 * leave the caller exactly as anonymous as they were, not produce a 500 — and there is nothing to leak by ignoring
 * it, because the caller learns the answer from the job that follows.
 */
export function devPlanOverride(
  request: DevPlanRequest,
  options: { token: string | null; env: string },
): DevPlanId | null {
  if (!options.token) return null;
  if (options.env === 'production') return null;

  const supplied = request.headers.get(DEV_PLAN_TOKEN_HEADER);
  if (!supplied || !constantTimeEquals(supplied, options.token)) return null;

  const requested = request.headers.get(DEV_PLAN_HEADER)?.trim().toLowerCase();
  if (!requested) return null;
  return (DEV_PLAN_IDS as readonly string[]).includes(requested) ? (requested as DevPlanId) : null;
}

/**
 * Compare two secrets without leaking their length or their first difference through timing.
 *
 * `timingSafeEqual` throws on unequal lengths, which is itself a length oracle — so the length check happens first
 * and is the caller's problem to accept (it leaks only the length of a shared token, which the header's own bytes
 * already do).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
