import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useSession } from '../../app/providers';
import { Button } from '../../components/ui';
import { allowAutoLink, withRelinkParam } from '../../lib/auto-link';
import { noteTripTaken, readTripTaken } from './bounce';
import { type GateState, canSignIn, gateNotice, gateRenders, nextPath, signInHref, strictRedirectHref } from './gate';
import { linkStore } from './link';

/**
 * The sign-in gate (`docs/0-TENANT-FIRST.md` §5).
 *
 * Rendered wherever an installation with anonymous use off would otherwise offer a form the API will refuse: the tool
 * page's run panel, the account page, the catalog and the home page. It does two things and nothing else:
 *
 *  1. **Show this page load's answer** to "is this browser signed in on the workspace?" — which the session provider
 *     asked for, once, for every caller without an account (`app/providers.tsx`). The gate used to be the one asking;
 *     it no longer is, and the reason is a defect rather than a taste: while the probe lived here, a person who signed
 *     in at the platform and opened this app on an installation that *serves* anonymous use was never asked about, so
 *     the header said "Anonymous" to a signed-in account. The question belongs to the session, not to the screen that
 *     happens to display its answer.
 *  2. **Offer the sign-in link when there is nothing to check**, with the sentence that fits why — and the one button
 *     a person can press to ask again, which is the only case where the same page load probes twice.
 *
 * The sign-in link carries two things: the return address (so the platform brings them back to the tool they were on)
 * and the `relink` marker, which is what makes the return trip count as consent — the browser's memory of a sign-out
 * is cleared on the way out (`lib/auto-link.ts`), because the sign-in they are about to perform *is* the answer to it.
 *
 * What it deliberately does **not** do: infer anything from `me.kind` (see `gate.ts`), render before `/me` has
 * answered, or treat a failed check as a failure of the visit — the check is an optional step, and the copy says so.
 *
 * On a **strict** installation it is also the screen that leaves: once the check has answered, a caller with no
 * account is sent to the workspace's sign-in page automatically rather than being asked to press a button (the
 * decision and its guards are `strictRedirectHref`; the once-per-tab memory is `bounce.ts`). The card stays on screen
 * for the states where a trip is the wrong answer — the check failed, there is no workspace to sign in to, or this
 * tab has already been walked there once — which is why both live in the same component instead of the redirect
 * being a separate guard somewhere above it.
 *
 * Whether it renders at all is `gateRenders`, and it used to be a locally written condition that asked only the
 * creation gate. The difference is not stylistic: `root-layout` replaces the whole page whenever *either* question
 * says this caller has none, so a card that answered only one of them rendered an empty box for an anonymous session
 * on a strict installation — the case the switch exists for.
 */

/** The page load's answer, from the shared store. `null` until the provider has asked (or decided not to). */
function useLinkState(): GateState | null {
  const store = linkStore();
  return useSyncExternalStore(store.subscribe, store.snapshot, () => null);
}

export function SignInGate({ title, hint }: { title?: string; hint?: string } = {}) {
  const { me, reload } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useLinkState();
  const store = linkStore();

  // A successful check changes what this page is allowed to show, so the session is reloaded — and `?next=` takes the
  // visitor to the page they originally clicked, which matters when the sign-in started somewhere else. The reload is
  // awaited before navigating: the target renders from the session, and arriving before the new identity lands is how
  // the header flashes Anonymous after a successful sign-in.
  useEffect(() => {
    if (state?.phase !== 'linked') return;
    void reload().then(() => {
      const target = nextPath(location.search);
      if (target && target !== `${location.pathname}${location.search}`) {
        navigate(target, { replace: true });
      }
    });
  }, [state, reload, navigate, location.pathname, location.search]);

  // The one button on this screen that asks again. Forcing is the person's decision, so the sign-out memory goes with
  // it: they are telling the app to go and look.
  const retry = useCallback(() => {
    allowAutoLink();
    void store.link({ force: true });
  }, [store]);

  const notice = gateNotice(state ?? { phase: 'checking' }, { hasSignIn: canSignIn(me) });

  // The automatic trip, on the installations where the card is not the answer. Read once per page load: the flag is
  // written by this same component on the way out, and re-reading it on every render would only make the decision it
  // feeds unstable. `window.location.href` matches the link below — the platform returns the visitor here.
  const [tripTaken] = useState(readTripTaken);
  const redirect = strictRedirectHref(me, state, window.location.href, { tripTaken });
  useEffect(() => {
    if (!redirect) return;
    // Recorded before leaving: the page is about to be replaced, and this write is what the visitor comes back to.
    noteTripTaken();
    // `replace`, not `assign` — the page that was refused is not a place Back should return to, and going back to it
    // would bounce again on arrival.
    window.location.replace(redirect);
  }, [redirect]);

  // One predicate, both questions (`gateRenders`). Asking only the creation one left this card empty for an anonymous
  // session on a strict installation — the page replaced by a gate that drew nothing.
  if (!gateRenders(me, state)) return null;

  const href = signInHref(me, withRelinkParam(window.location.href));

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="stack-sm">
        <span className="strong">{title ?? notice.title}</span>
        <span className="small muted">{notice.body}</span>
        {hint ? <span className="tiny faint">{hint}</span> : null}
      </div>

      {notice.action === 'signin' && href ? (
        <div className="row">
          <a className="btn btn-primary btn-sm" href={href} onClick={allowAutoLink}>
            Sign in
          </a>
        </div>
      ) : null}

      {notice.action === 'probe' ? (
        <div className="row">
          <Button
            size="sm"
            variant={state?.phase === 'failed' ? 'primary' : 'secondary'}
            loading={state?.phase === 'checking'}
            onClick={retry}
          >
            Check again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
