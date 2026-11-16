import { describe, expect, test } from 'bun:test';
import { DEV_PLAN_HEADER, DEV_PLAN_TOKEN_HEADER, devPlanOverride } from '../src/plugins/dev-plan';

/**
 * The dev plan switch is the only code in this repository whose job is to *widen* access, so it is the one place
 * where the tests are about refusals rather than features. Every case below is a way the switch could be on when it
 * should not be, or could honour something it should not:
 *
 *   - unset token (the production configuration) → the header means nothing;
 *   - wrong token → an accidental deployment of the switch is useless to a caller who does not know it;
 *   - `NODE_ENV=production` → refused even though `parseEnv` already refuses to boot that process, because the
 *     boot guard and the request guard are two independent `if`s and only one of them is tested by starting a
 *     container;
 *   - `anonymous` → not an override, since that is what a session already is;
 *   - anything else → ignored rather than thrown, so a dev stack cannot be turned into a 500 by a header.
 */

function request(headers: Record<string, string>): { headers: { get(name: string): string | null } } {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } };
}

const TOKEN = 'dev-plan-token';

describe('devPlanOverride', () => {
  test('an unset token disables the switch entirely', () => {
    const withHeader = request({ [DEV_PLAN_HEADER]: 'pro', [DEV_PLAN_TOKEN_HEADER]: TOKEN });
    expect(devPlanOverride(withHeader, { token: null, env: 'development' })).toBeNull();
  });

  test('a wrong token is refused', () => {
    const withHeader = request({ [DEV_PLAN_HEADER]: 'pro', [DEV_PLAN_TOKEN_HEADER]: 'not-the-token' });
    expect(devPlanOverride(withHeader, { token: TOKEN, env: 'development' })).toBeNull();
  });

  test('a missing token header is refused', () => {
    expect(devPlanOverride(request({ [DEV_PLAN_HEADER]: 'pro' }), { token: TOKEN, env: 'development' })).toBeNull();
  });

  test('production refuses the switch even with the right token', () => {
    const withHeader = request({ [DEV_PLAN_HEADER]: 'pro', [DEV_PLAN_TOKEN_HEADER]: TOKEN });
    expect(devPlanOverride(withHeader, { token: TOKEN, env: 'production' })).toBeNull();
  });

  test('a correct token grants the plan it names in a dev stack', () => {
    for (const plan of ['free', 'pro', 'business'] as const) {
      const withHeader = request({ [DEV_PLAN_HEADER]: plan, [DEV_PLAN_TOKEN_HEADER]: TOKEN });
      expect(devPlanOverride(withHeader, { token: TOKEN, env: 'development' })).toBe(plan);
    }
  });

  test('`anonymous` is not an override, and an unknown plan is ignored', () => {
    const anonymous = request({ [DEV_PLAN_HEADER]: 'anonymous', [DEV_PLAN_TOKEN_HEADER]: TOKEN });
    expect(devPlanOverride(anonymous, { token: TOKEN, env: 'development' })).toBeNull();

    const unknown = request({ [DEV_PLAN_HEADER]: 'enterprise', [DEV_PLAN_TOKEN_HEADER]: TOKEN });
    expect(devPlanOverride(unknown, { token: TOKEN, env: 'development' })).toBeNull();
  });

  test('the plan name is case- and whitespace-insensitive, because headers are', () => {
    const messy = request({ [DEV_PLAN_HEADER]: '  Pro  ', [DEV_PLAN_TOKEN_HEADER]: TOKEN });
    expect(devPlanOverride(messy, { token: TOKEN, env: 'test' })).toBe('pro');
  });
});
