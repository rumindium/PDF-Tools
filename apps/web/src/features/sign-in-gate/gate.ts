import type { MeBody, SsoProbeBody } from '@pdftools/contracts/api';
import { withRelinkParam } from '../../lib/auto-link';

/**
 * When the sign-in gate applies, and what it says (`docs/0-TENANT-FIRST.md` §4.2, §5).
 *
 * Separated from the component on purpose: the decision is three comparisons over `/me` plus a mapping from a probe
 * answer to a sentence, and both are the kind of logic that is worth asserting without rendering anything. The
 * component below only wires this to React.
 *
 * The rule the whole feature exists for: a **guest** on an installation whose anonymous switch is **off** cannot
 * create anything, so every surface that offers to create something must offer to sign in instead. Both halves come
 * from `/me` rather than being derived: `kind` says whether there is an identity at all, and `allowAnonymous` says
 * whether this installation was willing to hand one out. Read, not inferred — the switch lives in Auth Platform's
 * admin app management and can change without a deploy, so a bundle that baked in either answer would be wrong the
 * moment an operator flipped it (`docs/0-TENANT-FIRST.md` §4.5).
 */

/** Does this caller need an account they do not have? */
export function gateApplies(me: MeBody | null): boolean {
  return me != null && me.kind === 'guest' && me.allowAnonymous === false;
}

/**
 * Does this visitor get a *page* at all?
 *
 * The second question, and it is not `gateApplies` with a tighter condition — the two differ in who they catch and in
 * what is left on screen for them:
 *
 *  - **Who.** `gateApplies` is about a `guest`, the caller this installation declined to mint a session for. This one
 *    catches an **anonymous session** too, and that is the case a page gate cannot otherwise reach: a cookie minted
 *    while anonymous use was on keeps resolving as a perfectly good identity, so such a visitor would browse the
 *    catalogue of an installation that has decided it has no public page.
 *  - **What.** `gateApplies` marks the surfaces that would offer to *create* something, and the catalogue is not one
 *    of them — the catalogue is readable to a visitor by design. Strict mode is the switch that withdraws exactly
 *    that: with it on, every route is replaced by the gate, so the answer to "may I see anything here" is the same on
 *    the home page as it is on a tool form.
 *
 * Read off `/me` rather than inferred from `allowAnonymous`, which strict mode always resolves to `false`: a client
 * that derived it would be deciding a policy question from a correlated field, and the two would come apart the
 * moment an installation ran with anonymous use off but its pages public — which is the shipped default.
 */
export function strictGateApplies(me: MeBody | null): boolean {
  return me != null && me.strictMode === true && !isSignedIn(me);
}

/**
 * The automatic trip to the workspace's sign-in page — or `null` when this caller stays where they are.
 *
 * Strict mode means the installation publishes nothing (`docs/0-TENANT-FIRST.md` §4.4), so a visitor without an
 * account has no page to be on and a card offering a button is a worse answer than the one every other
 * account-required app gives: send them to the sign-in page. This is that decision, and it is deliberately *not*
 * "redirect as soon as strict mode is on":
 *
 *  - **The check goes first.** The session provider probes the workspace once per page load for every caller without
 *    an account, and that probe is what links a person who is already signed in at the workspace. Redirecting ahead
 *    of it would push a signed-in account out through a login page to be handed back to the page it was about to
 *    recognise on its own.
 *  - **Only a refusal is a reason to leave.** `failed` is a call that did not complete — an API restarting, a
 *    network drop — and it says nothing about the visitor's session; a trip to a platform that is not answering is a
 *    dead end. `checking` and `null` are the same statement one moment earlier.
 *  - **Once per tab, and this is the loop guard.** The workspace's login page returns the visitor to the address it
 *    was given, so a person who cancels the sign-in arrives back here with the same answer — and an unprotected
 *    redirect would send them straight out again, forever, with the login page at both ends. One trip per tab is
 *    enough for the case this exists for (a fresh visit to a strict installation), and after it the card is the
 *    answer: it states the situation and offers the link, which is what someone who has already been walked there
 *    once needs.
 *  - **Only where a sign-in page exists.** `signInHref` is `null` on an installation with no workspace configured,
 *    and a redirect to nowhere is worse than a card that says so (`gateNotice`, `not_configured`).
 */
export function strictRedirectHref(
  me: MeBody | null,
  state: GateState | null,
  currentUrl: string,
  options: { tripTaken?: boolean } = {},
): string | null {
  if (!strictGateApplies(me)) return null;
  if (options.tripTaken) return null;
  if (state === null || state.phase === 'checking' || state.phase === 'linked' || state.phase === 'failed') {
    return null;
  }
  // Carries `relink`, exactly as the card's link does: the return trip is the browser's consent to link, and without
  // it a person who had signed out here would come back to a page that refused to look at them.
  return signInHref(me, withRelinkParam(currentUrl));
}

/**
 * Is there an account behind this browser session?
 *
 * The header's question, and it is deliberately **not** `me.authenticated`: that field means "not a guest", which is
 * true of an anonymous session as well — it is the answer to "was this caller granted a session", not to "whose
 * name should be on the avatar". Written out here rather than inlined in the component, because the two questions
 * look identical at a call site and only one of them is about an account (`docs/0-TENANT-FIRST.md` §4.1).
 *
 * `api_key` is included: a key is an account's credential, and a screen that treated it as "no one" would offer it a
 * sign-in form.
 */
export function isSignedIn(me: MeBody | null): boolean {
  return me != null && (me.kind === 'user' || me.kind === 'api_key');
}

/**
 * Does the gate card stand in for what the person is looking at?
 *
 * One predicate rather than a condition written inside the component, because the two questions above it are answered
 * in two places and a card that asked only one of them drew **nothing at all** for the case strict mode exists to
 * catch: an installation with no public page, a visitor holding an anonymous session, and `root-layout` correctly
 * replacing the page with a gate whose own render condition (`gateApplies`) said this visitor was not gated — they
 * have a session, so they are not a guest — and left an empty 520px box where the way in should be. Found by looking
 * at the screen; either predicate in isolation is correct, and the pair is what was missing.
 *
 * `linked` is the third clause and a different job: after a probe succeeds, this same card is what says "You are
 * signed in", so it must be able to render for a caller that is not gated at all.
 */
export function gateRenders(me: MeBody | null, state: GateState | null): boolean {
  return gateApplies(me) || strictGateApplies(me) || state?.phase === 'linked';
}

/**
 * What to call a signed-in caller: the name mirrored from the platform, or a phrase instead of an empty box.
 *
 * A mirror row created before the platform reported a name has none, and that is a normal state rather than a bug —
 * the header still has to be able to say who is signed in.
 */
export function accountLabel(me: MeBody | null): string {
  const name = me?.displayName?.trim();
  return name && name.length > 0 ? name : 'Your account';
}

/**
 * Avatar initials from a display name.
 *
 * First and last word, which is what makes "Boni Tester" read as BT rather than BO — and a single word falls back to
 * its first two letters, so "Boni" is BO rather than B. Empty for a caller with no name at all; the header draws a
 * glyph then, because an initial invented from nothing is a name this app made up.
 */
export function initials(displayName: string | null): string {
  const parts = (displayName ?? '')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const first = parts[0] ?? '';
  if (first.length === 0) return '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/**
 * The platform's sign-in URL, carrying this page as the return address.
 *
 * Built from the **API's** `authPlatformUrl` rather than a Vite variable: the API owns that configuration, and a URL
 * baked into a bundle can only be corrected by rebuilding it. `null` when the installation is not connected — which
 * is also the state in which the gate cannot offer a sign-in link at all.
 *
 * `redirect` is the caller's own `location.href`, so the platform brings them back to the tool they were on. Only
 * the browser can produce that value, which is why this function takes it rather than deriving it.
 */
export function signInHref(me: MeBody | null, currentUrl: string): string | null {
  const base = me?.authPlatformUrl?.trim();
  if (!base) return null;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // A malformed URL is a configuration mistake the API should not have published; offering no link is better than
    // sending someone to `undefined/login`.
    return null;
  }

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/login`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('redirect', currentUrl);
  return url.toString();
}

/**
 * Can this installation offer a sign-in link at all?
 *
 * The placeholder return address is passed only because `signInHref` insists on being given one — nothing about
 * whether a link can be built depends on its value, and the screen asking this question has a live location of its
 * own for the link it eventually renders.
 */
export function canSignIn(me: MeBody | null): boolean {
  return signInHref(me, 'https://example.invalid/') != null;
}

/**
 * Where to land after signing in, from `?next=`.
 *
 * A single leading slash, no scheme, no `//` — so this can only ever navigate *within* this app. The check is the
 * whole reason this is a function: `?next=https://evil.example` in a link someone else wrote must not become a
 * navigation, and `//evil.example` is the same destination spelled without a scheme.
 */
export function nextPath(search: string): string | null {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get('next');
  } catch {
    return null;
  }
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

/** What the gate is doing, as the component sees it. */
export type GateState =
  | { phase: 'checking' }
  /** `reason` is absent for the ordinary refusal — no cookie on the platform's side — which is also the answer a
   *  browser that signed out here gets (`lib/auto-link.ts`). Leaving it required made every such answer carry a
   *  literal `undefined`, which is a value that has to be remembered at four call sites and means nothing at any. */
  | { phase: 'refused'; reason?: SsoProbeBody['reason'] }
  | { phase: 'linked' }
  | { phase: 'failed'; message: string };

export interface GateNotice {
  tone: 'info' | 'warning';
  title: string;
  body: string;
  /** What the button does: call the probe again, send the caller to the platform, or nothing to offer. */
  action: 'probe' | 'signin' | 'none';
}

/**
 * The sentence for a probe answer.
 *
 * Four answers, and the reason they are four is that they need four different things from the person reading them:
 * a caller whose bridge expired must sign in *again*, a caller whose platform did not answer should simply retry,
 * and a caller on an installation with no platform at all has been told nothing they can act on — offering them a
 * sign-in link would be a dead end dressed as a next step.
 *
 * `hasSignIn` is the second input because the two facts can disagree: a configured-looking installation may still
 * have published no URL, and a screen must never render a button that goes nowhere.
 */
export function gateNotice(state: GateState, options: { hasSignIn: boolean }): GateNotice {
  switch (state.phase) {
    case 'checking':
      return {
        tone: 'info',
        title: 'Checking your workspace session',
        body: 'One moment — if you are already signed in, this page will continue on its own.',
        action: 'none',
      };

    case 'linked':
      return {
        tone: 'info',
        title: 'You are signed in',
        body: 'This session is now linked to your account, and anything you already uploaded is still here.',
        action: 'none',
      };

    case 'failed':
      return {
        tone: 'warning',
        title: 'Could not check your session',
        body: `${state.message} The check is optional — you can try it again without losing anything.`,
        action: 'probe',
      };

    case 'refused':
      switch (state.reason) {
        case 'bridge_expired':
          return {
            tone: 'warning',
            title: 'Your workspace session has ended',
            body: 'You were signed in, but the workspace no longer recognises this browser. Sign in again to continue.',
            action: 'signin',
          };

        case 'platform_unreachable':
          return {
            tone: 'warning',
            title: 'The workspace did not answer',
            body: 'Your session may still be valid. Try the check again in a moment — nothing has been lost.',
            action: 'probe',
          };

        case 'exchange_failed':
          return {
            tone: 'warning',
            title: 'That sign-in did not complete',
            body: 'The handoff expired before it finished. Try again — the form has not been touched.',
            action: 'probe',
          };

        case 'not_configured':
          // No reason to offer a link: there is no platform to sign in to, which is a deployment problem for an
          // operator rather than a step for this person. The boot guard makes it near-unreachable, and a screen that
          // names it is how it stays a five-minute fix instead of a mystery.
          return {
            tone: 'warning',
            title: 'This installation needs an account, and has no workspace to sign in to',
            body: 'Auth Platform is not configured here, so there is no account to create or use. Ask whoever runs this installation to finish connecting it.',
            action: 'none',
          };

        default:
          // `linked: false` with no reason: the ordinary case. The browser has never signed in on the platform — no
          // cookie, or a cookie from another host — so the only useful next step is the sign-in link.
          return options.hasSignIn
            ? {
                tone: 'info',
                title: 'Sign in to use these tools',
                body: 'This installation requires an account. Signing in takes a moment, and the files you pick afterwards are processed the same way as before.',
                action: 'signin',
              }
            : {
                tone: 'warning',
                title: 'Sign-in is not available on this installation',
                body: 'An account is required here, but no workspace is configured to sign in to. Ask whoever runs this installation.',
                action: 'none',
              };
      }
  }
}
