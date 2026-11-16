import type { MeBody } from '@pdftools/contracts/api';
import type { Catalog, CatalogEntry } from '@pdftools/contracts/tools';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { noteTripTaken } from '../features/sign-in-gate/bounce';
import { isSignedIn } from '../features/sign-in-gate/gate';
import { linkStore } from '../features/sign-in-gate/link';
import { LIVENESS_POLL_MS, livenessAction, shouldAttemptRelink } from '../features/sign-in-gate/liveness';
import { ApiError, getCatalog, getMe, signOutOfAccount } from '../lib/api-client';
import {
  allowAutoLink,
  autoLinkSuppressed,
  relinkRequested,
  stripRelinkParam,
  suppressAutoLink,
} from '../lib/auto-link';
import { reconcileLoad } from '../lib/session-load';

/**
 * Session and catalog state (`docs/0-FOLDER-STRUCTURE.md` §3, `app/providers.tsx`).
 *
 * Two pieces of state, both read-only for the whole app:
 *
 *  - `me` — who the caller is and what their plan allows, straight from `GET /me`;
 *  - `catalog` — the tool list, *with* per-caller `maxFileMb` and `available` already applied by the API.
 *
 * The catalog is the reason no screen in this app hardcodes a tool id, an accept-list, or a size ceiling: the
 * form fields come from `optionsUi`, the limits come from `plan`, and whether a tool is usable comes from
 * `available`. A second source of truth in the frontend is how "the UI let me pick 300 MB but the API rejected it
 * at 50 MB" happens.
 */

interface AppState {
  me: MeBody | null;
  catalog: Catalog | null;
  loading: boolean;
  error: ApiError | null;
  /**
   * Re-read the identity and the catalog. Resolves when the new answers have been written to state, so a screen
   * can wait for it before navigating somewhere that renders from the session — navigating first is how the header
   * flashes Anonymous after a successful sign-in.
   */
  reload: () => Promise<void>;
  /**
   * End this app's link to the workspace account. Resolves when the session has been reloaded, so a screen can tell
   * "signed out" from "asked to sign out".
   */
  signOut: () => Promise<void>;
  signingOut: boolean;
  /**
   * True when this browser was an account and stopped being one because something *else* ended the session — the
   * workspace's sign-out, or a sibling app's, since all three share one handle.
   *
   * Kept apart from `me` rather than folded into it, because it is a fact about the last few seconds and `me` is a
   * fact about now: the header must stop showing the avatar either way, but only this one is worth interrupting
   * someone mid-task to explain, and only once.
   */
  sessionEnded: boolean;
  dismissSessionEnded: () => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeBody | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  /**
   * Load ticket. Every load takes a number and only the newest one may write state, so a slow first call that
   * loses a race to a reload cannot overwrite the newer answer with its stale one — and a response that lands
   * after unmount is ignored for the same reason. A ref, not state: it gates writes and must never re-render.
   */
  const ticket = useRef(0);

  /**
   * Fetch the identity and the catalog together, because they answer one question between them: what may this caller
   * do? `quiet` is for the refresh that follows a liveness finding — the plan moved or the link ended — where the
   * screen is already rendered with a correct-enough answer and the *only* thing being replaced is a set of ceilings.
   * Raising `loading` there would blank a page the person is working on, every time their quota ticked over.
   *
   * **Settled, not `all`, and that is a fix rather than a preference.** With strict mode on the catalogue is refused
   * to anyone without an account *by design*, and under `Promise.all` that refusal discarded the identity that came
   * back 200 — the identity the sign-in gate is built from. The rule, and the two cases it keeps apart, are in
   * `lib/session-load.ts`.
   */
  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const mine = ++ticket.current;
    if (!options.quiet) setLoading(true);
    try {
      const [meResult, catalogResult] = await Promise.allSettled([getMe(), getCatalog()]);
      if (mine !== ticket.current) return;
      const written = reconcileLoad({ me: meResult, catalog: catalogResult });
      if (written.me) setMe(written.me);
      setCatalog(written.catalog);
      setError(written.error);
    } finally {
      if (mine === ticket.current && !options.quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      // Retire this load's ticket: whatever it is still waiting on arrives too late to matter.
      ticket.current += 1;
    };
  }, [load]);

  const reload = useCallback(() => load(), [load]);

  /**
   * The workspace link, attempted once per page load for every caller that has no account yet.
   *
   * Moved here from the sign-in gate, and the move is the fix for a real defect rather than a tidy-up: the gate only
   * exists on an installation that *refuses* callers with no account, so on one that serves them — the dev stack, and
   * every installation where the anonymous switch is on — a visitor who had signed in at the platform was never asked
   * about and the header called them Anonymous. The question is about the session, so the session asks it.
   *
   * Three things it is careful not to do: ask more than once per page load (a second answer cannot exist without a
   * page load, and each attempt spends a handoff code), ask a caller who is already signed in, or ask at all when this
   * browser signed out here (`lib/auto-link.ts`) — that last one is what makes the sign-out button stick.
   */
  const attemptedLink = useRef(false);
  useEffect(() => {
    if (!me || isSignedIn(me) || attemptedLink.current) return;
    if (autoLinkSuppressed()) {
      // The answer is already known for this page load: the person signed out in this browser. Recording it keeps a
      // gate from waiting on a check that is deliberately not happening.
      linkStore().noteSuppressed();
      return;
    }
    attemptedLink.current = true;
    void linkStore()
      .link()
      .then((state) => {
        if (state.phase === 'linked') void load();
      });
  }, [me, load]);

  /**
   * The return from an explicit sign-in.
   *
   * `?relink=1` is on the address because the person pressed Sign in and came back through the platform's login page
   * (§5.4). It clears the sign-out memory before the attempt — signing in again *is* the answer to that memory — and
   * then asks. Asked before the automatic attempt in the effect below, which is why it is declared first: the two
   * share one request through the store, so the forced one is the one that happens.
   */
  useEffect(() => {
    if (!relinkRequested(window.location.search)) return;
    stripRelinkParam();
    // A sign-in has been attempted in this tab, from the card's own link rather than from an automatic trip — and the
    // strict-mode trip must not send them out a second time for the same attempt (`features/sign-in-gate/bounce.ts`).
    // Recorded before the probe, and whatever it answers: the answer is about the session, this is about the visit.
    noteTripTaken();
    if (me && isSignedIn(me)) return;
    allowAutoLink();
    attemptedLink.current = true;
    void linkStore()
      .link({ force: true })
      .then((state) => {
        if (state.phase === 'linked') void load();
      });
  }, [me, load]);

  const [signingOut, setSigningOut] = useState(false);

  /**
   * Sign out of this app — and make it stick.
   *
   * Order matters and is the whole implementation: the session is unlinked first, and only then is the browser told
   * not to link it back. Doing it the other way round would leave a window in which the memory says "do not ask" and
   * the session still says "signed in", which is the one state a reload in that window would render as the avatar on
   * a signed-out screen.
   *
   * A refused call changes nothing: the link is still in place, so the memory is not written and the failure is
   * reported through the same banner as every other failed call. Silently claiming success would leave the header
   * showing Anonymous over a session that is still an account.
   */
  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutOfAccount();
      suppressAutoLink();
      linkStore().noteSuppressed();
      await load();
    } catch (cause: unknown) {
      setError(cause instanceof ApiError ? cause : new ApiError('INTERNAL_ERROR', String(cause), 0));
    } finally {
      setSigningOut(false);
    }
  }, [signingOut, load]);

  // ── Liveness ────────────────────────────────────────────────────────────
  // One shared handle backs all three apps, and the workspace is its writer: pressing Sign out there — or on
  // Procurement, which is the same handle — ends this browser's session too. The server already answers that on the
  // next request (`plugins/session.ts` asks the platform about the handle before it says who the caller is). What was
  // missing was anyone asking: `me` was fetched once per page load, so a tab left open across the sign-out kept
  // rendering the avatar of a session the platform had already ended, and the only way to notice was to find a button
  // that happened to make a request. See `features/sign-in-gate/liveness.ts` for why the timing is what it is.
  const [sessionEnded, setSessionEnded] = useState(false);
  const dismissSessionEnded = useCallback(() => setSessionEnded(false), []);
  const signedIn = me !== null && isSignedIn(me);

  /**
   * The current identity, readable from a callback that outlives this render.
   *
   * A ref rather than a dependency: the interval below must not be torn down and restarted every time the quota ticks
   * over, because a clock that resets on every change is a clock that never fires on a busy page.
   */
  const meRef = useRef<MeBody | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  /**
   * While this browser is an account: ask whether it still is.
   *
   * The interval is the workspace's own 20 s, and the focus/visibility checks are not decoration — browsers throttle
   * timers in a hidden tab to about one a minute, so returning to this tab is the moment a person expects the app to
   * have caught up, and waiting for the throttle to expire is exactly when they would not.
   */
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    let running = false;

    const check = async () => {
      // One at a time: a slow API plus a burst of focus events would otherwise stack requests that all answer the same
      // question, and the later ones would be compared against an identity the earlier ones had already replaced.
      if (cancelled || running) return;
      running = true;
      try {
        const next = await getMe();
        if (cancelled) return;
        const previous = meRef.current;
        // A poll that lands after the person signed out here is answering about a session that no longer exists, and
        // its answer is `guest` — writing that state would be re-deriving a decision already made, at the risk of
        // clearing a banner they have not read yet.
        if (!previous || !isSignedIn(previous)) return;
        const action = livenessAction(previous, next);
        if (action === 'none') return;
        // The identity first, then the ceilings: the header should not keep an avatar while a catalog round trip is
        // in flight, and the catalog is the slower of the two.
        setMe(next);
        if (action === 'ended') {
          setSessionEnded(true);
          // The store's `linked` answer described a moment that has passed, and it is what the gate renders from: left
          // alone, the card under this header would go on saying "You are signed in" to a browser the platform has
          // already signed out.
          linkStore().noteEnded();
          void load({ quiet: true });
          return;
        }
        if (action === 'reload') void load({ quiet: true });
      } catch {
        // A failed poll says nothing about the session — the API may be restarting, or the network gone. It is left
        // to the next poll, and deliberately not surfaced: a transient failure is not worth the "Could not reach the
        // API" banner on a page that is still working from its last good answer.
      } finally {
        running = false;
      }
    };

    const interval = window.setInterval(() => void check(), LIVENESS_POLL_MS);
    const onWake = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [signedIn, load]);

  /**
   * While this browser is *not* an account: look for one it may have just acquired.
   *
   * The other direction of the same fact, and it is why this is not merely the mirror of the effect above. The
   * automatic probe runs once per page load, so a person who signed in on the workspace in another tab and came back
   * to this one was still shown "Sign in" until they reloaded — the app being the last to hear about something it
   * exists to serve.
   *
   * Woken by coming back to the tab rather than by the interval, and the asymmetry with the effect above is the whole
   * decision: an *ending* has to be noticed promptly, because a stale avatar over a dead session is wrong on every
   * screen at once, whereas *finding* an account is free to wait for the moment a person is looking. Asking on a
   * timer would re-ask a question whose answer the store already holds — and when the platform is signed in, every
   * ask mints a handoff code, so an interval here would spend a credential every 20 s to be told nothing.
   */
  useEffect(() => {
    if (signedIn || !shouldAttemptRelink(me, autoLinkSuppressed())) return;
    let cancelled = false;

    const look = async () => {
      if (cancelled) return;
      const state = await linkStore().link({ force: true });
      if (cancelled || state.phase !== 'linked') return;
      // A full load, not a quiet one: the catalog this page is holding was built for a guest, and its file ceilings
      // are the account's now.
      await load();
    };

    const onWake = () => {
      if (document.visibilityState === 'visible') void look();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [me, signedIn, load]);

  // An account that is back is not a session that ended: whoever signed in again has answered that banner, and leaving
  // it up over a live session would be the app arguing with the person who just fixed it.
  useEffect(() => {
    if (signedIn) setSessionEnded(false);
  }, [signedIn]);

  const value = useMemo<AppState>(
    () => ({ me, catalog, loading, error, reload, signOut, signingOut, sessionEnded, dismissSessionEnded }),
    [me, catalog, loading, error, reload, signOut, signingOut, sessionEnded, dismissSessionEnded],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>.');
  return context;
}

export function useSession(): AppState {
  return useApp();
}

export function useCatalog(): Catalog | null {
  return useApp().catalog;
}

export function useToolDefinition(toolId: string | undefined): CatalogEntry | null {
  const catalog = useApp().catalog;
  if (!catalog || !toolId) return null;
  return catalog.tools.find((tool) => tool.id === toolId) ?? null;
}

/** Tools that this caller can actually submit, used for the home page and the catalog grid. */
export function useAvailableTools(): CatalogEntry[] {
  const catalog = useApp().catalog;
  if (!catalog) return [];
  return catalog.tools.filter((tool) => tool.enabled && tool.available);
}

/**
 * The tier badge. The app is fully free, so this is always one word rather
 * than the plan the API mirrored — a badge naming Anonymous/Free/Pro would
 * describe tiers nobody buys. The numbers that do vary (quota, ceilings) are
 * fair-use accounting and are stated where they are shown.
 */
export function planLabel(me: MeBody | null): string {
  if (!me) return 'Loading';
  return 'Free';
}

export function quotaLabel(me: MeBody | null): string | null {
  if (!me) return null;
  if (me.quota.unlimited) return 'Unlimited jobs';
  const window = me.quota.windowSeconds >= 86_400 ? 'today' : 'this hour';
  return `${me.quota.used}/${me.quota.limit} jobs ${window}`;
}
