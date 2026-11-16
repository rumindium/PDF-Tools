import type { SsoProbeBody } from '@pdftools/contracts/api';
import { ApiError, probeSso } from '../../lib/api-client';
import type { GateState } from './gate';

/**
 * The page load's answer to "is this browser signed in on the workspace?" — asked at most once, and shared
 * (`docs/0-TENANT-FIRST.md` §5.1).
 *
 * Two facts make this a store rather than a hook:
 *
 *  1. **The question is per page load, not per component.** The gate renders on the header's neighbours, on the tool
 *     page, on the catalog and on the account page, and every route change remounts them; a probe per mount would
 *     spend one handoff code per navigation for an answer that cannot change without a page load. The answer is
 *     therefore held in one object and read by everyone.
 *  2. **The caller is not always a guest.** A visitor on an installation that *does* serve anonymous use is a
 *     perfectly ordinary caller with a perfectly ordinary session, and they still may have signed in at the platform
 *     before opening this app. That case used to be unreachable: the probe only ran inside the gate, and the gate only
 *     exists where anonymous use is off — so a signed-in person kept being shown "Anonymous" in the header until an
 *     operator flipped a switch that has nothing to do with them. The trigger moved to the session provider, and this
 *     store is what makes it one question for the whole page either way.
 *
 * The store is built rather than module-level for the reason `services/app-switches.ts` gives: the interesting
 * behaviour here is the number of requests issued for a sequence of calls, and a rule that can only be exercised
 * against a live platform is a rule nobody tests.
 */

export interface LinkStore {
  /** The current answer, or `null` while nothing has asked — read on every render. */
  snapshot(): GateState | null;
  /** Subscribe to changes; returns the unsubscribe function `useSyncExternalStore` expects. */
  subscribe(listener: () => void): () => void;
  /**
   * Ask, sharing the request with anyone else who asks in the same tick.
   *
   * `force` is the person pressing a button. It re-asks after a refusal — the platform may have answered something
   * different in between — and it does **not** re-ask after a success, because "check again whether I am signed in"
   * has one useful answer and paying for it twice would be the app not believing itself.
   */
  link(options?: { force?: boolean }): Promise<GateState>;
  /**
   * Record the answer that is already known: an ordinary refusal, for a page load that will not ask at all because
   * the browser signed out here (`lib/auto-link.ts`).
   *
   * Without this the gate would sit at "Checking your workspace session" forever on an installation that requires an
   * account — a screen whose only honest next step is the sign-in link it is not showing.
   */
  noteSuppressed(): void;
  /**
   * Record that the link this store reported is no longer in place.
   *
   * `linked` is a statement about a moment, and nothing took it back: the store answers once per page load and the
   * answer stays, so a session that ended afterwards left the gate card still saying "You are signed in" — directly
   * under a header that had already stopped showing the avatar, and next to the notice explaining why. Two parts of
   * one page disagreeing about who is looking at it is worse than either being wrong alone.
   *
   * Published as the same refusal `noteSuppressed` produces, and deliberately not a fourth phase: "there is no
   * workspace session for this page to pick up" is the same sentence whether the browser declined to ask or asked and
   * found nothing, and the gate already says it in one place. A phase nothing renders differently is a phase that
   * exists only to be forgotten.
   */
  noteEnded(): void;
}

export interface LinkStoreDeps {
  /** The probe, injected so a test can count calls instead of standing up a platform. */
  probe?: () => Promise<SsoProbeBody>;
}

export function createLinkStore(deps: LinkStoreDeps = {}): LinkStore {
  const probe = deps.probe ?? probeSso;

  let answer: GateState | null = null;
  let inFlight: Promise<GateState> | null = null;
  const listeners = new Set<() => void>();

  function publish(state: GateState | null): void {
    answer = state;
    for (const listener of listeners) listener();
  }

  async function run(): Promise<GateState> {
    try {
      const body = await probe();
      return body.linked ? { phase: 'linked' } : { phase: 'refused', reason: body.reason };
    } catch (cause: unknown) {
      // The call itself failed — rate limited, offline, the API restarting. That is not a statement about the
      // caller's session, so it is not modelled as one.
      return { phase: 'failed', message: cause instanceof ApiError ? cause.message : String(cause) };
    }
  }

  return {
    snapshot: () => answer,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    link: (options = {}) => {
      if (inFlight) return inFlight;
      if (answer && !(options.force && answer.phase !== 'linked')) return Promise.resolve(answer);
      if (answer) publish({ phase: 'checking' });
      inFlight = run()
        .then((state) => {
          publish(state);
          return state;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    noteSuppressed: () => publish({ phase: 'refused' }),
    noteEnded: () => publish({ phase: 'refused' }),
  };
}

/**
 * The process-wide store, built lazily.
 *
 * Lazy for `app-switches.ts`'s reason: constructing it must not depend on a browser being present, because the
 * unit tests import this module for its factory and nothing else.
 */
let singleton: LinkStore | null = null;

export function linkStore(): LinkStore {
  singleton ??= createLinkStore();
  return singleton;
}

/** Test seam: drop the process-wide store so a test can build one against a probe it controls. */
export function resetLinkStore(): void {
  singleton = null;
}
