import { describe, expect, test } from 'bun:test';
import { combineAccessFlags, config, isProduction } from '../src';
import { type Env, bootProblems } from '../src/env';

/**
 * The boot guards (`docs/0-TENANT-FIRST.md` §3.3).
 *
 * Both rules exist because their failure mode is silence: a process that starts and then behaves in a way no operator
 * asked for. The tests therefore assert *which combinations are refused*, not that a function returns a list — and
 * the important half of each pair is the combination that must be **allowed**, because a guard that also refuses the
 * legitimate configuration is a guard that gets deleted.
 *
 * `bootProblems` takes the parsed environment as an argument rather than reading `process.env`, which is what makes
 * these cases possible at all: a rule that could only be exercised by starting a process with the wrong environment
 * is a rule nobody tests. The values below are the shape `Env.parse` produces — the fields that matter are spelled
 * out and the defaults are irrelevant to these two rules, so the object is built from the real defaults below.
 */

function parsed(overrides: Partial<Env>): Env {
  return {
    NODE_ENV: 'development',
    DEV_PLAN_TOKEN: '',
    ALLOW_ANONYMOUS: false,
    STRICT_MODE: false,
    AUTH_PLATFORM_URL: '',
    ...overrides,
  } as Env;
}

describe('bootProblems', () => {
  test('a dev or production stack nobody could use is refused', () => {
    // The default, restated: anonymous off (the shipped default) and no platform to sign in against. Booting here
    // means every route answers 401 to everybody, with nothing anywhere saying why.
    for (const env of ['development', 'staging', 'production'] as const) {
      const problems = bootProblems(parsed({ NODE_ENV: env }));
      expect(problems.map((problem) => problem.variable)).toEqual(['ALLOW_ANONYMOUS']);
      // The message has to name *both* variables and the two ways out, because either one alone is a half-fix.
      expect(problems[0]?.message).toContain('AUTH_PLATFORM_URL');
      expect(problems[0]?.message).toContain('ALLOW_ANONYMOUS=true');
    }
  });

  test('either half of the pair is enough to make the stack usable', () => {
    expect(bootProblems(parsed({ ALLOW_ANONYMOUS: true }))).toEqual([]);
    expect(bootProblems(parsed({ AUTH_PLATFORM_URL: 'https://auth.example.com' }))).toEqual([]);
  });

  test('strict mode alone is the same unusable stack, and is named as the variable at fault', () => {
    // The combination the effective-value rule exists for: `ALLOW_ANONYMOUS` is left at the shipped `false`, so an
    // operator turning strict mode on has changed *one* flag — and a guard that named `ALLOW_ANONYMOUS` would send
    // them to a line they never touched.
    const problems = bootProblems(parsed({ STRICT_MODE: true }));
    expect(problems.map((problem) => problem.variable)).toEqual(['STRICT_MODE']);
    expect(problems[0]?.message).toContain('AUTH_PLATFORM_URL');
    // The way out is turning strict mode off, or pointing at a platform an account can sign in against.
    expect(problems[0]?.message).toContain('STRICT_MODE off');
  });

  test('strict mode with a platform is exactly the tenant-first stack an operator asked for', () => {
    // The legitimate configuration, which is the half of every guard that keeps it from being deleted: no public
    // page, and a platform to sign in against.
    expect(bootProblems(parsed({ STRICT_MODE: true, AUTH_PLATFORM_URL: 'https://auth.example.com' }))).toEqual([]);
  });

  test('a test stack may be a stack nobody may enter', () => {
    // The fixture the guest path needs: anonymous off, no platform, and that is the point rather than the mistake.
    expect(bootProblems(parsed({ NODE_ENV: 'test' }))).toEqual([]);
  });

  test('the dev-plan switch is refused in production, and only there', () => {
    // `ALLOW_ANONYMOUS: true` in the fixture, so the only problem reported is the one under test: a case that also
    // tripped the other rule would pass while proving nothing about this one.
    const usable = { DEV_PLAN_TOKEN: 'dev-plan-token', ALLOW_ANONYMOUS: true };
    expect(bootProblems(parsed({ NODE_ENV: 'production', ...usable })).map((p) => p.variable)).toEqual([
      'DEV_PLAN_TOKEN',
    ]);
    expect(bootProblems(parsed({ ...usable }))).toEqual([]);
  });

  test('both mistakes are reported together, not one restart at a time', () => {
    // An operator fixing two variables should get two sentences. A guard that returned on the first problem would
    // have them restart twice to learn the same thing.
    const problems = bootProblems(parsed({ NODE_ENV: 'production', DEV_PLAN_TOKEN: 'dev-plan-token' }));
    expect(problems.map((problem) => problem.variable).sort()).toEqual(['ALLOW_ANONYMOUS', 'DEV_PLAN_TOKEN']);
  });

  test('a test process is exempt from the usability guard, which is why the suites can import this module at all', () => {
    // Not a property of the guard — a property of the *build*: `bun test` runs with NODE_ENV=test and nothing else
    // set, so without this exemption every unit test that imports `@pdftools/config` (which is most of them, through
    // a service) would fail at import rather than at an assertion. Stated as a test because the exemption is the kind
    // of rule that gets "tidied away" by someone who has not seen this failure.
    expect(isProduction()).toBe(false);
    expect(bootProblems({ ...parsed({}), NODE_ENV: 'test' })).toEqual([]);
  });
});

/**
 * The values the sign-in gate depends on (`docs/0-TENANT-FIRST.md` §5).
 *
 * Asserted against the live parse rather than the schema's defaults, because what matters to the probe is what this
 * process ended up with. The one name here is a fact about **another** deployment — the platform's cookie — so a
 * rename on that side which this file did not follow would surface as "every visitor has to sign in twice": a support
 * ticket, not a stack trace. The other is a ceiling on a route a caller with no session can reach.
 */
describe('combineAccessFlags', () => {
  test('strict mode wins over anonymous use, in that direction only', () => {
    // One function, three call sites (the local fallback, the boot check, and the platform mirror) — and the whole
    // point is that they cannot spell the comparison differently. The three rows below are the truth table; the
    // fourth combination is the one this must never produce: strict mode on while visitors are welcome.
    expect(combineAccessFlags({ allowAnonymous: true, strictMode: false })).toBe(true);
    expect(combineAccessFlags({ allowAnonymous: false, strictMode: false })).toBe(false);
    expect(combineAccessFlags({ allowAnonymous: true, strictMode: true })).toBe(false);
    expect(combineAccessFlags({ allowAnonymous: false, strictMode: true })).toBe(false);
  });
});

describe('the sign-in gate’s configuration', () => {
  test('the shared-session cookie is the platform’s, by name', () => {
    expect(config.api.platformCookieName).toBe('auth_session');
    // The public and internal bases are read separately: the browser-facing URL is what the gate publishes, and the
    // internal one is what the probe calls. Both being null is the "not configured" case the gate names.
    expect(config.api.authPlatformUrl === null || typeof config.api.authPlatformUrl === 'string').toBe(true);
  });

  test('the probe has a budget of its own, and it is small', () => {
    // The probe reaches Auth Platform, mints a code there on every call, and is reachable without an account: a route
    // with no ceiling at all is an amplification vector, not a feature.
    expect(config.limits.ssoProbePerMinute).toBeGreaterThan(0);
    expect(config.limits.ssoProbePerMinute).toBeLessThanOrEqual(60);
  });
});
