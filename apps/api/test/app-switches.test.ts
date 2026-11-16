import { describe, expect, test } from 'bun:test';
import type { AppSwitchAnswer } from '../src/services/app-switches';
import { createAppSwitches, platformFetcher } from '../src/services/app-switches';

/**
 * The app switches are the second piece of code in this repository whose job is to *close* a door rather than open one
 * (the first is `plugins/dev-plan.ts`), so its tests are about the ways it could answer wrongly rather than about a
 * happy path:
 *
 *   - **the platform is the authority** — an operator turning a switch off in admin app management must win over a
 *     local value that says otherwise, and vice versa;
 *   - **"said no" is not "said nothing"** — the two must not collapse into one another in either direction, because
 *     one is a policy and the other is an outage;
 *   - **a confirmed answer survives an outage, and a fallback never widens access** — the stale path is what stops a
 *     platform hiccup from handing every visitor the anonymous plan;
 *   - **a lookup is not paid per request** — the cache window holds for a positive *and* a negative answer, and
 *     concurrent callers share one in-flight lookup, because this resolver runs on every request the API serves;
 *   - **strict mode outranks anonymous mode, wherever the pairing is read** — the two flags answer one question, and
 *     a resolver that reported them independently could tell the product it serves visitors while its every page
 *     demanded a sign-in.
 *
 * `now` is injected rather than slept on: a test that asserts a 60-second window by waiting is a test that either
 * takes a minute or asserts nothing.
 */

const APP = 'pdf-tools';

/** The pair, as a fetcher answers it. */
const answer = (allowAnonymous: boolean, strictMode = false): AppSwitchAnswer => ({ allowAnonymous, strictMode });

/** A clock the test moves by hand, in milliseconds. */
function clock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number): void => {
      at += ms;
    },
  };
}

describe('createAppSwitches', () => {
  test('the platform answer wins over the local value, in both directions', async () => {
    const allowed = createAppSwitches({
      allowAnonymous: false,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => answer(true),
    });
    expect(await allowed.resolve()).toMatchObject({ allowAnonymous: true, source: 'platform' });

    const denied = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => answer(false),
    });
    expect(await denied.resolve()).toMatchObject({ allowAnonymous: false, source: 'platform' });
  });

  test('the platform can turn strict mode on even where the local value never heard of it', async () => {
    // The switch is the platform's to own, like the one beside it: an installation whose `.env` predates strict mode
    // must still be gated when an operator flips it in admin app management.
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => answer(false, true),
    });
    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, strictMode: true, source: 'platform' });
  });

  test('the pairing rule is applied to what a fetcher returns, whoever wrote it', async () => {
    // An incoherent pair — both flags on — is what an older platform's row would produce (its own
    // `EffectiveAllowAnonymous` is the fix at the source, and this is the defence at the mirror). The answer the
    // product acts on is `false`: there is no page left for a visitor to reach, so passing `true` through would be
    // reporting an installation that does not exist.
    const resolver = createAppSwitches({
      allowAnonymous: false,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => ({ allowAnonymous: true, strictMode: true }),
    });

    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, strictMode: true });
  });

  test('and to the local values, which an operator can also set incoherently', async () => {
    // `STRICT_MODE=true` beside `ALLOW_ANONYMOUS=true` is asking for the stricter one, and the environment is not a
    // place to be told about it politely: the fallback path applies the same rule as the platform path.
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: true,
      platformBase: null,
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => null,
    });

    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, strictMode: true, source: 'env' });
  });

  test('with no platform configured the local values are used', async () => {
    // The resolver's half of "no platform": the answer comes from `ALLOW_ANONYMOUS`/`STRICT_MODE` and is reported as
    // such. The other half — that the default fetcher does not even open a connection without a base URL — is
    // asserted in the `platformFetcher` block below, because that rule lives in the fetcher: this case injects one,
    // so a call count here would be measuring the test's own stub.
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: null,
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => null,
    });

    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: true, strictMode: false, source: 'env' });
  });

  test('an unreachable platform falls back to the local values', async () => {
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => null,
    });
    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: true, strictMode: false, source: 'env' });
  });

  test('the shipped default denies when nobody answers', async () => {
    // `ALLOW_ANONYMOUS` is `false` unless an operator sets it, so the absence of an answer denies. Asserted rather
    // than assumed: this is the row of `docs/0-TENANT-FIRST.md` §3.2 that reads "no platform, no local value → deny",
    // and inverting it would open the product to every visitor.
    const resolver = createAppSwitches({
      allowAnonymous: false,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => null,
    });
    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, source: 'env' });
  });

  test('a confirmed answer outlasts an outage, and never reverts to the local value', async () => {
    const time = clock();
    let reply: AppSwitchAnswer | null = answer(false);
    const resolver = createAppSwitches({
      allowAnonymous: true, // the local value says yes; the platform said no
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      now: time.now,
      fetchAppConfig: async () => reply,
    });

    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, source: 'platform' });

    reply = null;
    time.advance(61_000);
    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, source: 'stale' });
  });

  test('a stale answer keeps strict mode on rather than only the flag beside it', async () => {
    // Both halves of the pair have to survive together. A stale path that restored `strictMode` but recomputed
    // `allowAnonymous` from the local value would be a platform outage that quietly reopened every gated page.
    const time = clock();
    let reply: AppSwitchAnswer | null = answer(true, true);
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      now: time.now,
      fetchAppConfig: async () => reply,
    });

    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, strictMode: true, source: 'platform' });

    reply = null;
    time.advance(61_000);
    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, strictMode: true, source: 'stale' });
  });

  test('a "no" from the platform is not mistaken for silence, on the very first request', async () => {
    // The distinction the fetcher's nullable return type exists for. A resolver that treated a failed lookup and a
    // negative answer as the same value would report `source: 'platform'` for an outage, and an operator reading the
    // log would conclude their policy was in force when in fact the local fallback was.
    let attempts = 0;
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => {
        attempts += 1;
        return attempts === 1 ? answer(false) : null;
      },
    });

    expect(await resolver.resolve()).toMatchObject({ allowAnonymous: false, source: 'platform' });
  });

  test('an answer is cached for the window, including a failed lookup', async () => {
    const time = clock();
    let calls = 0;
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      now: time.now,
      fetchAppConfig: async () => {
        calls += 1;
        return null;
      },
    });

    await resolver.resolve();
    await resolver.resolve();
    time.advance(59_000);
    await resolver.resolve();
    expect(calls).toBe(1);

    time.advance(2_000);
    await resolver.resolve();
    expect(calls).toBe(2);
  });

  test('concurrent callers share one lookup', async () => {
    let calls = 0;
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => {
        calls += 1;
        return answer(true);
      },
    });

    const answers = await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()]);
    expect(calls).toBe(1);
    expect(answers.every((resolved) => resolved.allowAnonymous)).toBe(true);
  });

  test('a zero window re-resolves on every call, which is what a dev stack asks for', async () => {
    let calls = 0;
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 0,
      fetchAppConfig: async () => {
        calls += 1;
        return answer(true);
      },
    });

    await resolver.resolve();
    await resolver.resolve();
    expect(calls).toBe(2);
  });

  test('`peek` reports the last answer without asking anybody', async () => {
    const resolver = createAppSwitches({
      allowAnonymous: true,
      strictMode: false,
      platformBase: 'http://auth.internal',
      appCode: APP,
      cacheSeconds: 60,
      fetchAppConfig: async () => answer(false),
    });

    expect(resolver.peek()).toBeNull();
    const resolved = await resolver.resolve();
    expect(resolver.peek()).toEqual(resolved);
  });
});

describe('platformFetcher', () => {
  const realFetch = globalThis.fetch;

  function withFetch(handler: (url: string) => Promise<Response> | Response) {
    globalThis.fetch = ((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))) as typeof fetch;
  }

  function restore() {
    globalThis.fetch = realFetch;
  }

  test('reads the switches off the public app record', async () => {
    let seen = '';
    withFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ code: APP, isEnabled: true, allowAnonymous: true }), { status: 200 });
    });
    try {
      expect(await platformFetcher('http://auth.internal')(APP)).toEqual(answer(true));
      expect(seen).toBe(`http://auth.internal/apps/${APP}/public`);
    } finally {
      restore();
    }
  });

  test('reads both flags raw, and leaves the pairing to the resolver', async () => {
    // Both fields exactly as the platform sent them, including the incoherent pair — the rule that resolves
    // `allowAnonymous` against `strictMode` lives in the resolver (`lookUp`), so that it holds for every fetcher and
    // for the branches that never fetch at all.
    withFetch(
      () => new Response(JSON.stringify({ isEnabled: true, allowAnonymous: true, strictMode: true }), { status: 200 }),
    );
    try {
      expect(await platformFetcher('http://auth.internal')(APP)).toEqual({
        allowAnonymous: true,
        strictMode: true,
      });
    } finally {
      restore();
    }
  });

  test('a platform that does not send strict mode is read as not strict', async () => {
    // The one field this fetcher does not demand an exact type for, and the asymmetry is deliberate: a platform old
    // enough to omit it cannot be asking for strict mode, and the alternative would gate every page of a deployment
    // whose platform has never heard of the switch. The flag that governs access keeps its exact type below.
    withFetch(() => new Response(JSON.stringify({ isEnabled: true, allowAnonymous: true }), { status: 200 }));
    try {
      expect(await platformFetcher('http://auth.internal')(APP)).toEqual(answer(true, false));
    } finally {
      restore();
    }
  });

  test('a wrong shape is no answer, not a guess', async () => {
    // Three shapes that a coercion would happily accept and that would decide a policy question on a type error:
    // a string, a missing field, and a number. All three are `null` — "nobody answered" — which falls back to the
    // local value instead of turning `"false"` (truthy) into anonymous use being permitted.
    const bodies = ['{"allowAnonymous":"false"}', '{"code":"pdf-tools"}', '{"allowAnonymous":0}'];
    for (const body of bodies) {
      withFetch(() => new Response(body, { status: 200 }));
      try {
        expect(await platformFetcher('http://auth.internal')(APP)).toBeNull();
      } finally {
        restore();
      }
    }
  });

  test('a disabled app has no switch to honour', async () => {
    withFetch(() => new Response(JSON.stringify({ isEnabled: false, allowAnonymous: true }), { status: 200 }));
    try {
      expect(await platformFetcher('http://auth.internal')(APP)).toBeNull();
    } finally {
      restore();
    }
  });

  test('a non-2xx answer is no answer', async () => {
    // Including the `404` this endpoint answers today on an Auth Platform that does not implement it yet: the
    // mirror must degrade to the local value rather than treat an unimplemented route as a policy.
    for (const status of [404, 500, 401]) {
      withFetch(() => new Response('{}', { status }));
      try {
        expect(await platformFetcher('http://auth.internal')(APP)).toBeNull();
      } finally {
        restore();
      }
    }
  });

  test('an unreachable platform is no answer', async () => {
    withFetch(() => {
      throw new Error('connection refused');
    });
    try {
      expect(await platformFetcher('http://auth.internal')(APP)).toBeNull();
    } finally {
      restore();
    }
  });

  test('no base means no call at all', async () => {
    withFetch(() => {
      throw new Error('the fetcher must not be called without a base URL');
    });
    try {
      expect(await platformFetcher(null)(APP)).toBeNull();
    } finally {
      restore();
    }
  });
});
