import { describe, expect, test } from 'bun:test';
import type { MeBody } from '@pdftools/contracts/api';
import { LIVENESS_POLL_MS, identityFingerprint, livenessAction, shouldAttemptRelink } from './liveness';

/**
 * The liveness rules (`docs/0-TENANT-FIRST.md` §7f), asserted without a browser or a platform.
 *
 * Every case here is one where the wrong answer is *invisible* until it matters. `ended` missed means a signed-out
 * account keeps its avatar and its admin menu on a tab nobody reloaded; `ended` reported for an ordinary quota change
 * means a banner telling someone their session ended while they are still working in it. `reload` skipped means an
 * upgraded plan that still offers the old file ceiling — the UI letting a person pick a size the API will refuse.
 */

const me = (over: Partial<MeBody> = {}): MeBody =>
  ({
    kind: 'guest',
    userId: null,
    tenantId: null,
    displayName: null,
    planId: 'guest',
    planName: 'Guest',
    planSource: 'none',
    authenticated: false,
    allowAnonymous: false,
    authPlatformUrl: null,
    appRoles: [],
    appPermissions: [],
    entitlements: { maxFileMb: 0, maxJobMb: 0, maxPages: 0, maxFiles: 0, queuePriority: 99 },
    quota: { used: 0, limit: 0, windowSeconds: 0, resetAt: new Date(0).toISOString(), unlimited: false },
    ...over,
  }) as MeBody;

const account = (over: Partial<MeBody> = {}): MeBody =>
  me({
    kind: 'user',
    userId: 'u1',
    tenantId: 't1',
    displayName: 'System Admin',
    planId: 'free',
    planName: 'Free',
    planSource: 'account',
    authenticated: true,
    entitlements: { maxFileMb: 100, maxJobMb: 200, maxPages: 500, maxFiles: 20, queuePriority: 8 },
    quota: { used: 1, limit: 20, windowSeconds: 86_400, resetAt: new Date(0).toISOString(), unlimited: true },
    ...over,
  });

describe('the poll interval', () => {
  test('is the workspace poll’s own value', () => {
    // Two apps on one session have one answer to "how long may a signed-out tab keep looking signed in". If this
    // number moves here without moving there, a person sees the workspace signed out and this app signed in, and
    // whichever is slower decides how long that lasts.
    expect(LIVENESS_POLL_MS).toBe(20_000);
  });
});

describe('livenessAction', () => {
  test('an account that stopped being one has ended', () => {
    expect(livenessAction(account(), me({ planId: 'anonymous' }))).toBe('ended');
  });

  test('ended outranks a plan change, so the account is never reported as merely re-planned', () => {
    // The two answers are both true of this pair; only one of them is safe. `reload` would leave the header rendering
    // an avatar for a session the platform has already ended.
    expect(livenessAction(account({ planId: 'pro' }), me({ planId: 'guest' }))).toBe('ended');
  });

  test('an account signing in where there was none is not an ending', () => {
    // The reverse transition is the relink path's job, and it arrives as a full reload rather than a poll answer. A
    // poll must never describe signing *in* as the session having ended.
    expect(livenessAction(me(), account())).toBe('reload');
  });

  test('a plan that moved needs the catalog reloaded with it', () => {
    expect(livenessAction(account({ planId: 'free' }), account({ planId: 'pro' }))).toBe('reload');
  });

  test('newer numbers are an update, not a reload', () => {
    // A job just finished: one more of the day's allowance spent. The header's "1/20 jobs today" is the reader.
    expect(
      livenessAction(account({ quota: { used: 0, limit: 20, windowSeconds: 86_400, resetAt: '', unlimited: true } }), account()),
    ).toBe('update');
  });

  test('a role arriving is an update', () => {
    // This is how the Admin menu appears for someone granted the role in the platform while their tab was open.
    expect(livenessAction(account({ appRoles: ['user'] }), account({ appRoles: ['user', 'admin'] }))).toBe('update');
  });

  test('an identical answer is nothing at all', () => {
    // The common case by a wide margin, and the reason the comparison exists: a poll that re-renders the tree every
    // 20 s pays a cost forever for an event that almost never happens.
    expect(livenessAction(account(), account())).toBe('none');
  });

  test('a guest staying a guest is nothing at all', () => {
    expect(livenessAction(me(), me())).toBe('none');
  });
});

describe('identityFingerprint', () => {
  test('distinguishes the fields a screen is keyed to', () => {
    const base = identityFingerprint(account());
    for (const changed of [
      account({ displayName: 'Someone Else' }),
      account({ appRoles: ['admin'] }),
      account({ appPermissions: ['pdftools.admin.read'] }),
      account({ quota: { used: 9, limit: 20, windowSeconds: 86_400, resetAt: '', unlimited: true } }),
      account({ entitlements: { maxFileMb: 500, maxJobMb: 200, maxPages: 500, maxFiles: 20, queuePriority: 8 } }),
    ]) {
      expect(identityFingerprint(changed)).not.toBe(base);
    }
  });

  test('ignores what nothing reads', () => {
    // `resetAt` moves every window and changes no decision the UI makes. Fingerprinting it would turn a quiet poll
    // into a re-render on a schedule — the exact thing `none` exists to prevent.
    expect(
      identityFingerprint(account({ quota: { used: 1, limit: 20, windowSeconds: 86_400, resetAt: 'soon', unlimited: true } })),
    ).toBe(identityFingerprint(account()));
  });
});

describe('shouldAttemptRelink', () => {
  test('a guest who has not signed out here may look', () => {
    expect(shouldAttemptRelink(me(), false)).toBe(true);
  });

  test('a browser that signed out here may not', () => {
    // It still holds the platform's cookie. Without this the probe would link the account back seconds after a
    // deliberate sign-out, and the button would be a lie.
    expect(shouldAttemptRelink(me(), true)).toBe(false);
  });

  test('an account has nothing to look for', () => {
    // And asking is not free: while the platform is signed in, every probe mints a handoff code.
    expect(shouldAttemptRelink(account(), false)).toBe(false);
  });

  test('a load still in flight is not an answer', () => {
    expect(shouldAttemptRelink(null, false)).toBe(false);
  });
});
