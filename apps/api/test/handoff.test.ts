import { describe, expect, test } from 'bun:test';
import type { AppError } from '@pdftools/errors';
import {
  type FetchLike,
  codeFromBridge,
  consumeFailure,
  linkFromHandoffCode,
  revokeBridge,
} from '../src/services/handoff';

/**
 * The handoff's failure taxonomy (`docs/0-TENANT-FIRST.md` §5), asserted against a fetch that answers by hand.
 *
 * The cases here are the ones a running platform cannot be asked to produce on demand — a 500, a timeout, a 200 with
 * no `code` in it, a code refused a millisecond after it was minted — and each of them decides what a person reads.
 * Getting the mapping wrong is invisible in a happy-path test and very visible in an outage: "the workspace did not
 * answer" reported as "your session ended" makes thousands of people sign in again for nothing.
 */

/** A platform that answers exactly what the test says, and records what it was asked. */
function platform(answers: Array<{ status?: number; body?: unknown; throws?: boolean }>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = answers[index++] ?? { status: 500 };
    if (answer.throws) throw new Error('connection refused');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  };
  return { fetchImpl, calls };
}

/** The route layer's own context is only used by the success path (it links a session), which needs a database. */
const ctx = {} as never;

describe('codeFromBridge', () => {
  test('a good bridge becomes a handoff code', async () => {
    const { fetchImpl, calls } = platform([{ body: { code: 'one-time-code', expiresIn: 60 } }]);
    const result = await codeFromBridge('bridge-handle', {
      base: 'http://auth.test',
      fetchImpl,
      appCode: 'pdf-tools',
    });
    // No `appRoles` in the answer — an older platform, or one that did not recognise the app code — reads as "no
    // snapshot yet", which is a state the refresh can fix and never a grant.
    expect(result).toEqual({ code: 'one-time-code', access: null });
    expect(calls[0]?.url).toBe('http://auth.test/sso/handoff-bridge');
    // The app names itself in the request, because "what may this account do here" is only answerable with a here.
    expect(calls[0]?.body).toEqual({ bridge: 'bridge-handle', appCode: 'pdf-tools' });
  });

  test('the roles travel beside the code, in the same round trip', async () => {
    const { fetchImpl } = platform([
      { body: { code: 'one-time-code', appRoles: ['user', 'admin'], appPermissions: ['pdftools.admin.read'] } },
    ]);
    const result = await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl, appCode: 'pdf-tools' });
    expect(result).toEqual({
      code: 'one-time-code',
      access: { roles: ['user', 'admin'], permissions: ['pdftools.admin.read'] },
    });
  });

  test('an answer that grants nothing is an answer, not a missing one', async () => {
    // `[]`/`[]` means the platform looked and this account holds nothing here — which must stop the app asking again
    // on every page load. `null` (below) is the state that keeps asking. The two cannot be collapsed.
    const { fetchImpl } = platform([{ body: { code: 'c', appRoles: [], appPermissions: [] } }]);
    expect(await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl })).toEqual({
      code: 'c',
      access: { roles: [], permissions: [] },
    });
  });

  test('half an answer is not half a role list', async () => {
    // Roles without permissions (or the reverse) is a different version of the contract rather than a partial one.
    // Guessing the missing half would either grant nothing while claiming roles, or grant codes nobody defined.
    const bodies = [
      { code: 'c', appRoles: ['admin'] },
      { code: 'c', appPermissions: ['pdftools.admin.read'] },
      { code: 'c', appRoles: 'admin', appPermissions: [] },
      { code: 'c', appRoles: [1, 2], appPermissions: [] },
      { code: 'c' },
    ];
    for (const body of bodies) {
      const { fetchImpl } = platform([{ body }]);
      expect(await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl })).toEqual({
        code: 'c',
        access: null,
      });
    }
  });

  test('a platform that knows the bridge and says it is gone is "signed out elsewhere"', async () => {
    // 401 is the platform's `invalid_bridge`. It is the one answer that means something specific, and the gate turns
    // it into "sign in again" rather than "try again".
    for (const status of [401, 403]) {
      const { fetchImpl } = platform([{ status }]);
      expect(await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl })).toEqual({
        failure: 'bridge_expired',
      });
    }
  });

  test('a 401 that names a sign-out is a revoked session, not a lapsed hour', async () => {
    // The distinction the whole "log out everywhere" flow rests on. A lapsed handle keeps a link the app already has
    // (`bridge_expired`); a revoked one means the account signed out and the link is over (`bridge_revoked`), and an
    // app that answered both the same way would either resurrect a sign-out or throw away a session nobody ended.
    const { fetchImpl } = platform([{ status: 401, body: { error: 'bridge_revoked' } }]);
    expect(await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl })).toEqual({
      failure: 'bridge_revoked',
    });

    // And the older answer — a 401 with nothing in it — still reads as the lapse it always meant.
    const { fetchImpl: plain } = platform([{ status: 401, body: {} }]);
    expect(await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl: plain })).toEqual({
      failure: 'bridge_expired',
    });
  });

  test('a platform that fails is not reported as a session that ended', async () => {
    for (const answer of [{ status: 500 }, { status: 503 }, { throws: true }, { body: {} }, { body: { code: 42 } }]) {
      const { fetchImpl } = platform([answer]);
      expect(await codeFromBridge('bridge', { base: 'http://auth.test', fetchImpl })).toEqual({
        failure: 'platform_unreachable',
      });
    }
  });

  test('an unconnected installation is named before anything is asked', async () => {
    const { fetchImpl, calls } = platform([{ body: { code: 'x' } }]);
    expect(await codeFromBridge('bridge', { base: null, fetchImpl })).toEqual({ failure: 'not_configured' });
    expect(calls).toHaveLength(0);
  });
});

describe('revokeBridge', () => {
  test('it revokes by handle, at the one route that also records the moment', async () => {
    const { fetchImpl, calls } = platform([{ body: { revoked: true } }]);
    expect(await revokeBridge('bridge-handle', { base: 'http://auth.test', fetchImpl })).toBe('revoked');
    expect(calls[0]?.url).toBe('http://auth.test/sso/bridge/revoke');
    expect(calls[0]?.body).toEqual({ bridge: 'bridge-handle' });
  });

  test('a platform that would not take the revocation is reported, not thrown', async () => {
    // The caller's own link has to end either way — this installation can always end that — so a failed call here is a
    // fact to report rather than a reason to leave somebody signed in.
    for (const answer of [{ status: 500 }, { throws: true }]) {
      const { fetchImpl } = platform([answer]);
      expect(await revokeBridge('bridge', { base: 'http://auth.test', fetchImpl })).toBe('unreachable');
    }
  });

  test('an unconnected installation never calls anything', async () => {
    const { fetchImpl, calls } = platform([{ body: { revoked: true } }]);
    expect(await revokeBridge('bridge', { base: null, fetchImpl })).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });
});

describe('linkFromHandoffCode', () => {
  test('an unconnected installation is named', async () => {
    expect(await linkFromHandoffCode(ctx, 'code', null, { base: null })).toEqual({ failure: 'not_configured' });
  });

  test('a code the platform refuses is a race, not an expired session', async () => {
    const { fetchImpl, calls } = platform([{ status: 401 }]);
    expect(await linkFromHandoffCode(ctx, 'code', null, { base: 'http://auth.test', fetchImpl })).toEqual({
      failure: 'code_rejected',
    });
    expect(calls[0]?.url).toBe('http://auth.test/sso/exchange');
  });

  test('an exchange that answers without a credential is not a link', async () => {
    // A 200 whose body has no `accessToken` would otherwise fall through to `/auth/me` with `undefined` and surface as
    // an unauthenticated 401 much later, where the cause is no longer visible.
    const { fetchImpl } = platform([{ body: { accessToken: '' } }]);
    expect(await linkFromHandoffCode(ctx, 'code', null, { base: 'http://auth.test', fetchImpl })).toEqual({
      failure: 'platform_unreachable',
    });
  });

  test('a platform that does not answer is not a rejected code', async () => {
    const { fetchImpl } = platform([{ throws: true }]);
    expect(await linkFromHandoffCode(ctx, 'code', null, { base: 'http://auth.test', fetchImpl })).toEqual({
      failure: 'platform_unreachable',
    });
  });
});

describe('consumeFailure', () => {
  test('each failure becomes a status a client can act on', () => {
    expect(consumeFailure('not_configured').code).toBe('FORBIDDEN');
    expect(consumeFailure('code_rejected').code).toBe('UNAUTHORIZED');
    expect(consumeFailure('bridge_expired').code).toBe('UNAUTHORIZED');
    expect(consumeFailure('bridge_revoked').code).toBe('UNAUTHORIZED');
    expect(consumeFailure('platform_unreachable').code).toBe('INTERNAL_ERROR');
  });

  test('the unreachable message never claims the session ended', () => {
    // The sentence is the whole reason `platform_unreachable` is a separate value: a caller whose platform hiccuped is
    // still signed in, and telling them otherwise costs them a sign-in they did not need.
    const error = consumeFailure('platform_unreachable') as AppError;
    expect(error.message.toLowerCase()).toContain('did not answer');
    expect(error.message.toLowerCase()).not.toContain('session');
  });
});
