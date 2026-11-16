import type { MeBody } from '@pdftools/contracts/api';
import { isSignedIn } from './gate';

/**
 * Whether this browser is *still* the account it was when the page loaded (`docs/0-TENANT-FIRST.md` §7f).
 *
 * The link between this app and the workspace is one shared handle, and the workspace is the writer of it: pressing
 * Sign out there — or on any sibling app, since it is the same handle — ends this browser's session too. The server
 * already answers that correctly on the very next request (`plugins/session.ts` asks the platform about the handle
 * before it answers who the caller is). What was missing was anyone asking: `me` was fetched once per page load, so a
 * tab that had been open before the sign-out kept rendering the avatar of a session the platform had already ended,
 * and the only way to notice was to find a button that happened to make a request.
 *
 * So this module is the missing question, and its timing is the platform's own: `SESSION_COOKIE_POLL_MS` in
 * `Auth-Platform/web/providers/auth-provider.tsx` is 20 s, and two apps sharing one session have one answer to "how
 * long may a signed-out tab keep looking signed in". Picking a *different* number here would mean a person could see
 * the workspace signed out and this app still signed in for as long as the slower of the two.
 *
 * The window/interval pair is deliberate rather than lazily the same call twice: browsers throttle timers in a hidden
 * tab to roughly one a minute, so the interval alone means a person who switches back to this tab waits for the
 * throttle to expire. The focus and visibility checks are what make coming back — the exact moment a person expects
 * the app to have caught up — instant. They cost one `GET /me` on the way in, which is the cheapest request this API
 * has and one every screen already makes on load.
 */

/**
 * How often a signed-in tab re-asks. 20 s, matching the workspace's own session poll.
 *
 * Not configurable from the server on purpose: this is the client's tolerance for a stale screen, not a product
 * setting, and the value only means anything when every app agrees on it.
 */
export const LIVENESS_POLL_MS = 20_000;

/**
 * What the poll should do about the answer it got.
 *
 * Four outcomes rather than "set the state and move on", because one of them is not a state update at all:
 *
 *  - `ended` — the caller was an account and is not one any more. This is the answer the whole module exists for, and
 *    it is also the one that has to say so out loud: the person is mid-task with an uploader in front of them, and an
 *    avatar turning into "Sign in" without a word is the app pretending nothing happened.
 *  - `reload` — the plan changed (an upgrade bought in another tab, a Free account becoming Pro). The *catalog* carries
 *    the ceilings — `maxFileMb`, `available` — so a plan that moved without reloading it leaves the UI offering a
 *    300 MB upload the API will refuse. This is the one outcome a `setMe` alone gets wrong.
 *  - `update` — same shape, newer numbers: quota used, roles granted or withdrawn, a name the platform has only just
 *    reported. Worth a re-render, not a reload.
 *  - `none` — nothing a reader could see has changed. Worth nothing, and this is the common case: a poll that
 *    re-rendered the tree every 20 s for no reason would be a cost paid forever for an event that almost never happens.
 */
export type LivenessAction = 'none' | 'update' | 'reload' | 'ended';

/**
 * Everything a screen reads off `me`, as one string.
 *
 * A fingerprint rather than a deep comparison because the comparison is not the point — *the reader* is. These are the
 * fields something on a page is actually keyed to; anything absent is either constant for a session or is not rendered.
 * Deep-equality would also make this function's own contract fragile: a new field on `MeBody` would silently change
 * whether the app re-renders, and nobody would look here when it did.
 */
export function identityFingerprint(me: MeBody): string {
  return [
    me.kind,
    me.planId,
    me.displayName ?? '',
    me.quota.used,
    me.quota.limit,
    // Optional on the body (a caller with no account has no roles, and the field predates the app-role model), so the
    // empty list is spelled out rather than assumed: `undefined` and `[]` must fingerprint the same, or an account
    // whose roles the platform stopped reporting would read as a change on every poll.
    (me.appRoles ?? []).join(','),
    (me.appPermissions ?? []).join(','),
    me.entitlements.maxFileMb,
    me.entitlements.maxPages,
  ].join('|');
}

/** What a fresh answer means next to the one being held. See `LivenessAction` for why each case exists. */
export function livenessAction(previous: MeBody, next: MeBody): LivenessAction {
  // First, because it is the only outcome the caller cannot recover from and the only one that outranks the rest: a
  // signed-in caller who is no longer signed in must not be reported as a changed plan with an account still attached.
  if (isSignedIn(previous) && !isSignedIn(next)) return 'ended';
  if (previous.planId !== next.planId) return 'reload';
  if (identityFingerprint(previous) === identityFingerprint(next)) return 'none';
  return 'update';
}

/**
 * May this browser go looking for a workspace session it does not have yet?
 *
 * The other direction of the same problem, and it needs its own answer: an open guest tab that a person then signs
 * into on the workspace should pick the account up, and the automatic probe only ever ran once per page load — so
 * signing in from another tab left this one showing "Sign in" until it was reloaded.
 *
 * Two refusals, and both are decisions rather than caution:
 *
 *  - **A browser that signed out here does not ask** (`lib/auto-link.ts`). It still holds the platform's cookie, so
 *    without this the probe would re-link the account seconds after a deliberate sign-out and the button would be a
 *    lie. The memory belongs to the person, and only an explicit sign-in clears it.
 *  - **A caller who is already an account does not ask.** There is nothing to find, and the probe is not free: when
 *    the platform *is* signed in it mints a fresh handoff code on every call, so asking while linked would spend a
 *    credential per poll to be told what the session row already says.
 *
 * `me === null` is the load still in flight — not a guest, and not an answer to act on.
 */
export function shouldAttemptRelink(me: MeBody | null, suppressed: boolean): boolean {
  return me !== null && !isSignedIn(me) && !suppressed;
}
