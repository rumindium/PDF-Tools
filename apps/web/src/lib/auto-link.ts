/**
 * Whether this browser may pick up the workspace session **on its own** (`docs/0-TENANT-FIRST.md` §5.4).
 *
 * The state after a sign-out is not "no account". The browser still holds Auth Platform's `auth_session` cookie —
 * PDF Tools cannot clear a cookie it does not own — so the next automatic probe would link the account straight back
 * and the person who pressed Sign out would find themselves signed in again on the next page they open. This module
 * is the memory that stops exactly that, and each of its properties is a decision:
 *
 *  - **A cookie, not `localStorage` and not module state.** The thing being suppressed happens *on page load*, in
 *    whichever tab the person opens; a decision kept in one tab's memory is not a decision.
 *  - **Written by the page, not by the API.** The session row is the app's record of the link; this is the person's
 *    statement about their own browser, and the two are different facts that would otherwise have to share a column.
 *    It is also why the cookie is not `HttpOnly`: everything it can do is *suppress* an automatic link, and a
 *    narrowing state is not one anyone gains from forging.
 *  - **Never read by the API.** `POST /api/v1/sso/probe` links whoever calls it. What must not exist is a route that
 *    decides *for* a caller whether to ask, and "the page chose not to ask" therefore has to live here, where the
 *    only person it constrains is the one who set it.
 */

const COOKIE = 'pdft_no_autolink';

/** A month: long enough that a sign-out outlives a weekend; short enough that it is not a permanent fork. */
const MAX_AGE_SECONDS = 30 * 24 * 3600;

/** The query parameter an explicit sign-in comes back with. */
export const RELINK_PARAM = 'relink';

/** The cookie's decision, as a pure function of the raw `document.cookie` string. */
export function hasSuppressionCookie(rawCookie: string): boolean {
  for (const part of rawCookie.split(';')) {
    if (part.trim().startsWith(`${COOKIE}=`)) return part.trim().slice(COOKIE.length + 1) === '1';
  }
  return false;
}

export function autoLinkSuppressed(): boolean {
  if (typeof document === 'undefined') return false;
  return hasSuppressionCookie(document.cookie);
}

/** Remember that this browser signed out; the automatic probe stops asking until the person says otherwise. */
export function suppressAutoLink(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE}=1; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * Forget it — done when someone asks to sign in, which is the only event this memory is waiting for.
 *
 * Called *before* the browser leaves for the platform's login page, so the visitor who comes back is asked about by
 * the probe again and links on arrival: the sign-in they just performed is consent, and asking them to press a second
 * button after it would be the app forgetting what they said.
 */
export function allowAutoLink(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/** Does this address carry the marker that says the visitor has just signed in? */
export function relinkRequested(search: string): boolean {
  try {
    return new URLSearchParams(search).get(RELINK_PARAM) === '1';
  } catch {
    return false;
  }
}

/**
 * Where to send someone so that coming back counts as an explicit sign-in.
 *
 * Appended to the address handed to the platform as `redirect`, which is why it has to be part of *that* value: the
 * platform returns the visitor to it verbatim, and the marker is the only thing that distinguishes "they pressed Sign
 * in" from "they opened the app again" once they are back on our own URL.
 */
export function withRelinkParam(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.set(RELINK_PARAM, '1');
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * Take the marker back out of the address bar, once it has been honoured.
 *
 * `history.replaceState`, not a navigation: the visitor is already on the page the sign-in was started from, and
 * reloading it — or pushing a history entry for the sanitised URL — would either throw away the state the app just
 * loaded or offer a Back button that returns to the marked URL and therefore re-links.
 */
export function stripRelinkParam(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RELINK_PARAM)) return;
  url.searchParams.delete(RELINK_PARAM);
  window.history.replaceState(null, '', url.toString());
}
