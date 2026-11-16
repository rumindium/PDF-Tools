import { describe, expect, test } from 'bun:test';
import type { MeBody } from '@pdftools/contracts/api';
import type { Catalog } from '@pdftools/contracts/tools';
import { ApiError } from './api-client';
import { reconcileLoad } from './session-load';

/**
 * The load rule, one case at a time — and the case that matters is the one a live stack cannot produce while its switch
 * is in one position.
 *
 * What went wrong was not a wrong answer to any single request: it was the *pairing*. `Promise.all` treated a refusal
 * of the catalogue as a failure of the load, so on a strict installation the identity that would have opened the
 * sign-in gate was discarded along with it and the page rendered an outage instead of a way in. Both halves are
 * asserted here because the cheap fix for that — swallowing every catalogue failure — would turn a real outage into a
 * silent empty grid.
 */

const me = (over: Partial<MeBody> = {}): MeBody =>
  ({
    kind: 'guest',
    authenticated: false,
    allowAnonymous: false,
    strictMode: true,
    displayName: null,
    planId: 'guest',
    planName: 'Guest',
    planSource: 'none',
    authPlatformUrl: 'http://localhost:3000',
    quota: { planId: 'guest', used: 0, limit: 0, windowSeconds: 0, resetAt: '2026-09-22T00:00:00.000Z', unlimited: false },
    entitlements: { maxFileMb: 0, maxJobMb: 0, maxPages: 0, maxFiles: 0, queuePriority: 99 },
    ...over,
  }) as MeBody;

const catalog = { tools: [] } as unknown as Catalog;
const refused = () => new ApiError('AUTH_REQUIRED', 'Sign in to run jobs.', 401, 'req-1', { reason: 'strict_mode' });

describe('reconcileLoad', () => {
  test('keeps the identity when the catalogue is refused by policy', () => {
    // The defect. `/me` answers, `/tools` refuses because this installation has no public page, and the gate is built
    // from the identity — so a load that drops it drops the only door the installation still has.
    const written = reconcileLoad({
      me: { status: 'fulfilled', value: me() },
      catalog: { status: 'rejected', reason: refused() },
    });

    expect(written.me?.strictMode).toBe(true);
    expect(written.catalog).toBeNull();
    // Not a fault, so not a banner: "Could not reach the API" over a deliberate refusal describes an outage that did
    // not happen, and hides the sign-in link behind the wrong story.
    expect(written.error).toBeNull();
  });

  test('clears a catalogue it may no longer read', () => {
    // A catalogue held from an earlier load carries ceilings computed for somebody this installation no longer serves,
    // and the forms read those ceilings: leaving it up offers an upload the API will refuse.
    const written = reconcileLoad({
      me: { status: 'fulfilled', value: me() },
      catalog: { status: 'rejected', reason: refused() },
    });
    expect(written.catalog).toBeNull();
  });

  test('a real catalogue failure still reaches the screen', () => {
    // The other half, and the reason this is not a blanket swallow: a 500 or a dropped connection is a fault, and the
    // person should be told rather than shown an empty grid that looks like an empty product.
    const written = reconcileLoad({
      me: { status: 'fulfilled', value: me() },
      catalog: { status: 'rejected', reason: new ApiError('INTERNAL_ERROR', 'boom', 500) },
    });
    expect(written.error?.code).toBe('INTERNAL_ERROR');
  });

  test('a failed identity is reported, and does not erase the one on screen', () => {
    const written = reconcileLoad({
      me: { status: 'rejected', reason: new ApiError('INTERNAL_ERROR', 'boom', 500) },
      catalog: { status: 'fulfilled', value: catalog },
    });
    // `null` means "leave what you have", not "you have nobody": a page that blanked its identity on one failed poll
    // would drop an avatar over a session that is still perfectly alive.
    expect(written.me).toBeNull();
    expect(written.error?.code).toBe('INTERNAL_ERROR');
    expect(written.catalog).toBe(catalog);
  });

  test('a refused catalogue never speaks for a failed identity', () => {
    // Both went wrong, and the identity is the one worth reporting: it is the failure that leaves the page unable to
    // say who is looking at it, and a refusal from the other call would otherwise be mistaken for the whole story.
    const written = reconcileLoad({
      me: { status: 'rejected', reason: new ApiError('INTERNAL_ERROR', 'boom', 500) },
      catalog: { status: 'rejected', reason: refused() },
    });
    expect(written.error?.code).toBe('INTERNAL_ERROR');
    expect(written.me).toBeNull();
  });

  test('both answers arriving is the ordinary case', () => {
    const written = reconcileLoad({
      me: { status: 'fulfilled', value: me({ kind: 'anonymous', strictMode: false, allowAnonymous: true }) },
      catalog: { status: 'fulfilled', value: catalog },
    });
    expect(written.me?.kind).toBe('anonymous');
    expect(written.catalog).toBe(catalog);
    expect(written.error).toBeNull();
  });

  test('a non-ApiError rejection is shaped like a fault rather than leaking', () => {
    // A thrown string is not an `ApiError`, and the banner renders `message` and `requestId`: an exception object
    // reaching it would print `[object Object]` at somebody.
    const written = reconcileLoad({
      me: { status: 'fulfilled', value: me() },
      catalog: { status: 'rejected', reason: new Error('socket closed') },
    });
    expect(written.error?.code).toBe('INTERNAL_ERROR');
    expect(written.error?.message).toContain('socket closed');
  });
});
