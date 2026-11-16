/**
 * The once-per-tab memory behind the automatic sign-in trip (`docs/0-TENANT-FIRST.md` §5.5).
 *
 * `strictRedirectHref` sends a visitor without an account to the workspace's sign-in page, and the workspace hands
 * them back to the address it was given. That is a round trip with a person in the middle, and two of its three
 * outcomes come back **refused** — they cancelled the sign-in, or their workspace session had already ended — so the
 * page they return to is the same page that decided to send them away, holding the same answer. Without a memory,
 * that is a loop: out to the login page, back, out again, until something gives.
 *
 * `sessionStorage`, and each word is the decision:
 *
 *  - **Not `localStorage`.** The flag is about a visit, not about a browser. A tab that has been walked to the sign-in
 *    page once this session gets the card on every page after it — which is also the honest answer for someone who
 *    presses Sign out on a strict installation: there is no signed-out state to sit in, but there is a card that says
 *    so and a link, and re-bouncing a person who has just told the app they are done is the app arguing with them.
 *  - **Not a cookie, unlike the sign-out memory next door.** `lib/auto-link.ts` has to outlive the tab because someone
 *    who signs out opens the app in a new one; this flag must not, because a *new tab is a new arrival* and that is
 *    exactly the case the trip exists for.
 *  - **Set before the navigation, and again on the way back.** The first write is what survives the round trip at
 *    all; the second covers the visitor who took the trip from the card's own link (`Sign in` on the gate), where no
 *    automatic trip was recorded but a sign-in has plainly been attempted (`app/providers.tsx`, on `?relink=1`).
 */

const KEY = 'pdft.signin_trip';

/** The stored decision, as a pure function of the raw value — so it can be asserted without a browser. */
export function tripTaken(raw: string | null): boolean {
  return raw === '1';
}

export function readTripTaken(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return tripTaken(window.sessionStorage.getItem(KEY));
  } catch {
    // Storage can be refused outright (a hardened browser, a partitioned context). The flag is a loop guard, not the
    // feature: without it the visitor is redirected — which is still correct, just not protected against coming back.
    return false;
  }
}

export function noteTripTaken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, '1');
  } catch {
    // As above: a guard that cannot be stored must not take the feature down with it.
  }
}
