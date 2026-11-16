import { describe, expect, test } from 'bun:test';
import { PLANS, planFor } from '@pdftools/contracts';
import { AppError } from '@pdftools/errors';
import { assertCreationAllowed, assertSurfaceAllowed } from '../src/services/access-policy';
import type { AppSwitches } from '../src/services/app-switches';
import type { OwnerIdentity } from '../src/services/quota-service';

/**
 * The creation guard, one identity at a time (`docs/0-TENANT-FIRST.md` §4.2).
 *
 * What is asserted here is not "it throws" but *which* identities are refused under *which* switch position, because
 * every wrong answer is a silent category error:
 *
 *   - refusing a signed-in caller would close the product;
 *   - accepting a guest would reopen the anonymous path an operator switched off;
 *   - accepting an anonymous session while the switch is off gives the very allowance the gate exists to withhold;
 *   - refusing an anonymous session *entirely* — reads included — is not this function's business, and a test that
 *     asserted it here would encode the wrong rule in the wrong place.
 *
 * The cookie case is the interesting one: `docs/0-TENANT-FIRST.md` §4.3 keeps existing anonymous sessions readable,
 * so the switch changes what they may *start*, never what they may still open.
 */

const guest: OwnerIdentity = { kind: 'guest', ownerId: null, anonId: null, planId: null, userId: null, tenantId: null };

const anonymous: OwnerIdentity = {
  kind: 'anonymous',
  ownerId: 'session-1',
  anonId: 'anon-1',
  planId: 'anonymous',
  userId: null,
  tenantId: null,
};

const anonymousGranted: OwnerIdentity = { ...anonymous, planOverride: 'pro' };

const user: OwnerIdentity = {
  kind: 'user',
  ownerId: 'user-1',
  anonId: null,
  planId: 'free',
  userId: 'user-1',
  tenantId: 'tenant-1',
};

const apiKey: OwnerIdentity = {
  kind: 'api_key',
  ownerId: 'key-1',
  anonId: null,
  planId: 'pro',
  userId: 'user-1',
  tenantId: 'tenant-1',
};

/** The switches as the resolver hands them over — the guards take the whole answer, `source` and `resolvedAt` included. */
function policy(allowAnonymous: boolean, strictMode = false): AppSwitches {
  return { allowAnonymous, strictMode, source: 'env', resolvedAt: 0 };
}

function refusal(identity: OwnerIdentity, allowAnonymous: boolean): AppError | null {
  const switchAnswer = policy(allowAnonymous);
  try {
    assertCreationAllowed(identity, switchAnswer);
    return null;
  } catch (error) {
    return error instanceof AppError ? error : null;
  }
}

describe('assertCreationAllowed', () => {
  test('a guest is refused, whichever way the installation switch points', () => {
    // A guest only exists when the switch is off, so this is the state that produced them — but the guard does not
    // depend on that: `kind: 'guest'` is a fact about the caller.
    for (const allowAnonymous of [false, true]) {
      const error = refusal(guest, allowAnonymous);
      expect(error?.code).toBe('AUTH_REQUIRED');
      expect(error?.status).toBe(401);
      expect(error?.details).toMatchObject({ reason: 'no_account' });
    }
  });

  test('an anonymous session is refused only while anonymous use is off', () => {
    expect(refusal(anonymous, true)).toBeNull();

    const error = refusal(anonymous, false);
    expect(error?.code).toBe('AUTH_REQUIRED');
    expect(error?.details).toMatchObject({ reason: 'anonymous_disabled' });
    // The message has to say what is *not* lost: this caller may own an upload or a finished job, and the reads for
    // those still work (`docs/0-TENANT-FIRST.md` §4.3).
    expect(error?.message).toContain('already ran is still available');
  });

  test('a dev-granted plan does not stand in for an account', () => {
    // `x-dev-plan` grants a *plan*, not an identity. A stack that handed a session Pro must still refuse to create
    // work when anonymous use is off, or the switch would be bypassable from a header.
    const error = refusal(anonymousGranted, false);
    expect(error?.code).toBe('AUTH_REQUIRED');
  });

  test('the refusal reports the switch as it was resolved, never as a literal', () => {
    // Defect 206 in `docs/0-TENANT-FIRST.md` §7a.3 was exactly this shape: a literal where the resolved value was
    // meant, and it was invisible from the outside because the identity was carried on as if it were correct. The
    // details are what a gate UI reads to decide whether to offer the no-account path, so they have to be the same
    // answer the decision was made from — asserted in both switch positions, not only the one a guest can come from.
    expect(refusal(guest, false)?.details).toMatchObject({ allowAnonymous: false, reason: 'no_account' });
    expect(refusal(guest, true)?.details).toMatchObject({ allowAnonymous: true, reason: 'no_account' });
    expect(refusal(anonymous, false)?.details).toMatchObject({
      allowAnonymous: false,
      reason: 'anonymous_disabled',
    });
  });

  test('a signed-in caller passes regardless of the switch', () => {
    for (const allowAnonymous of [false, true]) {
      expect(refusal(user, allowAnonymous)).toBeNull();
    }
  });

  test('a keyed caller is authenticated, so it passes too', () => {
    // An API key is a verified user, not a session. Reading `kind !== 'user'` as "signed out" is the mistake the
    // boolean `authenticated` field on `/me` exists to prevent.
    expect(refusal(apiKey, false)).toBeNull();
  });
});

function surfaceRefusal(identity: OwnerIdentity, strictMode: boolean): AppError | null {
  try {
    assertSurfaceAllowed(identity, policy(false, strictMode));
    return null;
  } catch (error) {
    return error instanceof AppError ? error : null;
  }
}

describe('assertSurfaceAllowed', () => {
  test('does nothing at all while strict mode is off', () => {
    // The whole point of the pair: an installation that serves visitors keeps a readable catalogue, and this guard
    // must not be the thing that quietly closes it.
    for (const identity of [guest, anonymous, user, apiKey]) {
      expect(surfaceRefusal(identity, false)).toBeNull();
    }
  });

  test('with strict mode on, a guest is refused before anything is rendered', () => {
    const error = surfaceRefusal(guest, true);
    expect(error?.code).toBe('AUTH_REQUIRED');
    expect(error?.status).toBe(401);
    expect(error?.details).toMatchObject({ reason: 'strict_mode', strictMode: true });
  });

  test('and so is an anonymous session, which is the case a page gate cannot reach', () => {
    // The interesting half. A cookie minted before the switch was flipped keeps working server-side — it resolves as
    // a perfectly valid anonymous identity — and it never loads a page that would have shown it the gate. So the
    // refusal has to happen on the route, and the message has to say that signing in keeps the work.
    const error = surfaceRefusal(anonymous, true);
    expect(error?.code).toBe('AUTH_REQUIRED');
    expect(error?.details).toMatchObject({ reason: 'strict_mode' });
    expect(error?.message).toContain('follows you in');
  });

  test('a different reason from the creation gate, because it is a different refusal', () => {
    // `anonymous_disabled` says "stop starting things while everything you already have stays open"; this says "this
    // installation has no public surface". A client that showed either sentence for the other would be describing a
    // product that does not exist, which is why the reasons are distinct rather than both `AUTH_REQUIRED` with a
    // generic message.
    expect(surfaceRefusal(anonymous, true)?.details).toMatchObject({ reason: 'strict_mode' });
    expect(refusal(anonymous, false)?.details).toMatchObject({ reason: 'anonymous_disabled' });
  });

  test('an account passes, a keyed caller too, and neither is examined further', () => {
    // Not a permission check: what an account may do inside the app is the platform's answer, and a second opinion
    // here is how two gates end up disagreeing about one request.
    expect(surfaceRefusal(user, true)).toBeNull();
    expect(surfaceRefusal(apiKey, true)).toBeNull();
  });
});

describe('the guest plan', () => {
  test('runs nothing, because its tool list is empty rather than a wildcard', () => {
    // The catalog computes `available` from this list, so a `['*']` here would make every tool read as available to
    // the one caller the gate exists for — the failure this test is here to make impossible.
    expect(PLANS.guest.tools).toEqual([]);
    for (const plan of [PLANS.free, PLANS.pro, PLANS.business, PLANS.anonymous]) {
      expect(plan.tools).toEqual(['*']);
    }
  });

  test('carries no allowance of any kind', () => {
    const guestPlan = planFor('guest');
    expect(guestPlan.id).toBe('guest');
    for (const value of [
      guestPlan.maxFileMb,
      guestPlan.maxJobMb,
      guestPlan.maxPages,
      guestPlan.maxFiles,
      guestPlan.jobsPerWindow,
      guestPlan.windowSeconds,
      guestPlan.maxConcurrent,
      guestPlan.resultTtlMinutes,
      guestPlan.historyDays,
      guestPlan.maxApiKeys,
    ]) {
      expect(value).toBe(0);
    }
  });

  test('is reached by name, never as the fallback for an unknown plan', () => {
    // The fallback is deliberately `anonymous`: a caller whose plan could not be resolved is treated as a visitor,
    // never as a caller with no account — and never as a paying one.
    expect(planFor('guest').id).toBe('guest');
    expect(planFor('enterprise').id).toBe('anonymous');
    expect(planFor(undefined).id).toBe('anonymous');
    expect(planFor(null).id).toBe('anonymous');
  });
});
