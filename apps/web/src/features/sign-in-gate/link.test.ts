import { describe, expect, test } from 'bun:test';
import type { SsoProbeBody } from '@pdftools/contracts/api';
import { ApiError } from '../../lib/api-client';
import { createLinkStore } from './link';

/**
 * The store's request discipline (`docs/0-TENANT-FIRST.md` §5.1).
 *
 * The cases worth having are all about **how many times the platform is asked**, because every other property of this
 * code is visible in a browser and this one is not: a probe per mount would spend one handoff code per navigation for
 * an answer that cannot change, one probe per page load is the design, and a forced retry that quietly does not happen
 * is a button that does nothing. None of them can be seen by looking at the screen.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createLinkStore', () => {
  test('callers in the same tick share one request', async () => {
    let calls = 0;
    const answer = deferred<SsoProbeBody>();
    const store = createLinkStore({
      probe: () => {
        calls += 1;
        return answer.promise;
      },
    });

    const first = store.link();
    const second = store.link();
    answer.resolve({ linked: true });

    expect(await first).toEqual({ phase: 'linked' });
    expect(await second).toEqual({ phase: 'linked' });
    expect(calls).toBe(1);
  });

  test('a settled answer is not asked for again', async () => {
    let calls = 0;
    const store = createLinkStore({
      probe: async () => {
        calls += 1;
        return { linked: false };
      },
    });

    await store.link();
    await store.link();

    expect(calls).toBe(1);
    expect(store.snapshot()).toEqual({ phase: 'refused' });
  });

  test('a refusal keeps its reason, which is what the screen branches on', async () => {
    const store = createLinkStore({ probe: async () => ({ linked: false, reason: 'bridge_expired' }) });
    expect(await store.link()).toEqual({ phase: 'refused', reason: 'bridge_expired' });
  });

  test('force re-asks after a refusal, and only after a refusal', async () => {
    let calls = 0;
    const store = createLinkStore({
      probe: async () => {
        calls += 1;
        return calls === 1 ? { linked: false, reason: 'platform_unreachable' } : { linked: true };
      },
    });

    expect(await store.link()).toEqual({ phase: 'refused', reason: 'platform_unreachable' });
    expect(await store.link({ force: true })).toEqual({ phase: 'linked' });
    expect(calls).toBe(2);

    // And now the other half: "check again whether I am signed in" has one useful answer, and a second request for it
    // is the app not believing itself.
    expect(await store.link({ force: true })).toEqual({ phase: 'linked' });
    expect(calls).toBe(2);
  });

  test('force during a request in flight joins it instead of racing a second one', async () => {
    let calls = 0;
    const answer = deferred<SsoProbeBody>();
    const store = createLinkStore({
      probe: () => {
        calls += 1;
        return answer.promise;
      },
    });

    const automatic = store.link();
    const pressed = store.link({ force: true });
    answer.resolve({ linked: true });

    expect(await automatic).toEqual({ phase: 'linked' });
    expect(await pressed).toEqual({ phase: 'linked' });
    expect(calls).toBe(1);
  });

  test('a forced re-ask publishes the checking state, so the button has something to be', async () => {
    const seen: Array<string | null> = [];
    let calls = 0;
    const store = createLinkStore({
      probe: async () => {
        calls += 1;
        return calls === 1 ? { linked: false } : { linked: true };
      },
    });
    store.subscribe(() => seen.push(store.snapshot()?.phase ?? null));

    await store.link();
    await store.link({ force: true });

    expect(seen).toEqual(['refused', 'checking', 'linked']);
  });

  test('a call that failed is a failed check, not a statement about the session', async () => {
    const store = createLinkStore({
      probe: async () => {
        throw new ApiError('RATE_LIMITED', 'Too many requests.', 429);
      },
    });

    expect(await store.link()).toEqual({ phase: 'failed', message: 'Too many requests.' });
  });

  test('a suppressed page load records the answer without asking', async () => {
    let calls = 0;
    const store = createLinkStore({
      probe: async () => {
        calls += 1;
        return { linked: true };
      },
    });

    store.noteSuppressed();

    expect(store.snapshot()).toEqual({ phase: 'refused' });
    expect(calls).toBe(0);
  });

  test('an ended link stops being reported as linked', async () => {
    // The one that was a real contradiction on screen rather than a request too many. `linked` is a statement about a
    // moment and nothing took it back, so a session that ended after a successful link left the gate card saying
    // "You are signed in" — under a header that had already stopped showing the avatar, beside the notice explaining
    // why. Who is looking at this page has one answer, and this is what keeps the store from holding another.
    let calls = 0;
    const store = createLinkStore({
      probe: async () => {
        calls += 1;
        return { linked: true };
      },
    });

    await store.link();
    expect(store.snapshot()).toEqual({ phase: 'linked' });

    const seen: Array<string | null> = [];
    store.subscribe(() => seen.push(store.snapshot()?.phase ?? null));
    store.noteEnded();

    expect(store.snapshot()).toEqual({ phase: 'refused' });
    expect(seen).toEqual(['refused']);
    // Recorded, not re-asked: the app has already observed this from the session, and a probe here would be a second
    // opinion about a fact it just established.
    expect(calls).toBe(1);
  });
});
