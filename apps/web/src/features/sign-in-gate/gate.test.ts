import { describe, expect, test } from 'bun:test';
import type { MeBody } from '@pdftools/contracts/api';
import {
  accountLabel,
  canSignIn,
  gateApplies,
  gateNotice,
  gateRenders,
  initials,
  isSignedIn,
  nextPath,
  signInHref,
  strictGateApplies,
  strictRedirectHref,
} from './gate';

/**
 * The gate's decision layer (`docs/0-TENANT-FIRST.md` §4.2, §5), asserted without rendering anything.
 *
 * The cases worth having are the ones where a wrong answer is invisible in a browser: the gate shown to a signed-in
 * caller closes the product, the gate hidden from a guest offers a form the API refuses, a `?next=` accepted from a
 * link someone else wrote navigates off the site, and one sentence used for two different failures sends people to
 * sign in again for an outage.
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
    entitlements: { maxFileMb: 0, maxJobMb: 0, maxPages: 0, maxFiles: 0, queuePriority: 99 },
    quota: { used: 0, limit: 0, windowSeconds: 0, resetAt: new Date(0).toISOString(), unlimited: false },
    ...over,
  }) as MeBody;

describe('gateApplies', () => {
  test('a guest on a tenant-first installation is gated', () => {
    expect(gateApplies(me())).toBe(true);
  });

  test('a guest on an installation that still serves visitors is not', () => {
    // The switch, not the identity: this installation mints sessions, so a `guest` here is a request in flight rather
    // than someone who needs an account.
    expect(gateApplies(me({ allowAnonymous: true }))).toBe(false);
  });

  test('a signed-in caller is never gated, whichever way the switch points', () => {
    for (const allowAnonymous of [true, false]) {
      expect(gateApplies(me({ kind: 'user', userId: 'u1', allowAnonymous }))).toBe(false);
    }
  });

  test('strict mode gates an anonymous session too, which is the case a page gate cannot otherwise reach', () => {
    // A cookie minted while anonymous use was on keeps resolving as a valid identity, so `gateApplies` is `false` for
    // it — and the catalogue of an installation that has decided it publishes nothing would render anyway.
    const session = me({ kind: 'anonymous', allowAnonymous: false, strictMode: true });
    expect(gateApplies(session)).toBe(false);
    expect(strictGateApplies(session)).toBe(true);
  });

  test('strict mode leaves an account alone, and leaves a non-strict installation unchanged', () => {
    expect(strictGateApplies(me({ kind: 'user', userId: 'u1', strictMode: true }))).toBe(false);
    expect(strictGateApplies(me({ strictMode: false }))).toBe(false);
    // The shipped default: anonymous use off, pages public. This is the state `gateApplies` describes, and the one a
    // client that derived strict mode from `allowAnonymous` would get wrong.
    expect(gateApplies(me({ allowAnonymous: false }))).toBe(true);
    expect(strictGateApplies(me({ allowAnonymous: false }))).toBe(false);
  });

  test('an unknown session is not gated', () => {
    // `/me` has not answered yet, and a gate rendered on a guess is a gate flashed at people who are signed in.
    expect(gateApplies(null)).toBe(false);
  });

  test('an anonymous session on a switched-off installation is not gated but is also not allowed to create', () => {
    // The read-only case (§4.3): the guard refuses creation, and the gate's job here is the copy on pages that would
    // otherwise explain a missing history as a cookie problem. It is deliberately not the "sign in to start" gate.
    expect(gateApplies(me({ kind: 'anonymous', planId: 'anonymous' }))).toBe(false);
  });
});

describe('isSignedIn', () => {
  test('an account and a key are signed in; a session with neither is not', () => {
    expect(isSignedIn(me({ kind: 'user', userId: 'u1' }))).toBe(true);
    expect(isSignedIn(me({ kind: 'api_key', userId: 'u1' }))).toBe(true);
    expect(isSignedIn(me({ kind: 'anonymous', planId: 'anonymous' }))).toBe(false);
    expect(isSignedIn(me())).toBe(false);
  });

  test('`authenticated` is deliberately not the question', () => {
    // `/me` reports `authenticated: true` for an anonymous session — it means "this caller was granted a session",
    // which the sign-in gate also branches on. A header that read it instead of `kind` would draw an avatar for
    // someone with no account, which is the defect this function exists to make impossible to write again.
    const anonymous = me({ kind: 'anonymous', planId: 'anonymous', authenticated: true });
    expect(anonymous.authenticated).toBe(true);
    expect(isSignedIn(anonymous)).toBe(false);
  });
});

describe('accountLabel', () => {
  test('uses the mirrored name, and says something rather than nothing when there is none', () => {
    expect(accountLabel(me({ kind: 'user', displayName: 'Boni Tester' }))).toBe('Boni Tester');
    expect(accountLabel(me({ kind: 'user', displayName: '  ' }))).toBe('Your account');
    expect(accountLabel(me({ kind: 'user', displayName: null }))).toBe('Your account');
  });
});

describe('initials', () => {
  test('first and last word, which is what makes Boni Tester read as BT', () => {
    expect(initials('Boni Tester')).toBe('BT');
    expect(initials('boni  van der tester')).toBe('BT');
    expect(initials('  Boni   Tester  ')).toBe('BT');
  });

  test('one word gives two letters rather than one', () => {
    expect(initials('Boni')).toBe('BO');
  });

  test('no name at all is empty, not an invented initial', () => {
    // The header draws a glyph for this case; an avatar reading "?" would be a name this app made up.
    expect(initials(null)).toBe('');
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
  });
});

describe('signInHref', () => {
  test('appends /login and carries the page as the return address', () => {
    const href = signInHref(me({ authPlatformUrl: 'https://auth.example.com' }), 'https://pdf.example.com/tools/merge');
    expect(href).toBe('https://auth.example.com/login?redirect=https%3A%2F%2Fpdf.example.com%2Ftools%2Fmerge');
  });

  test('a platform mounted under a path keeps its prefix', () => {
    const href = signInHref(me({ authPlatformUrl: 'https://example.com/auth/' }), 'https://example.com/x');
    expect(href).toBe('https://example.com/auth/login?redirect=https%3A%2F%2Fexample.com%2Fx');
  });

  test('carries a port, because development needs it', () => {
    const href = signInHref(me({ authPlatformUrl: 'http://localhost:3000' }), 'http://localhost:5180/tools/split');
    expect(href).toBe('http://localhost:3000/login?redirect=http%3A%2F%2Flocalhost%3A5180%2Ftools%2Fsplit');
  });

  test('no configured platform means no link, rather than a link to nowhere', () => {
    expect(signInHref(me(), 'https://pdf.example.com/')).toBeNull();
    expect(canSignIn(me())).toBe(false);
    expect(canSignIn(me({ authPlatformUrl: 'https://auth.example.com' }))).toBe(true);
  });

  test('a malformed URL is refused instead of being sent', () => {
    // `AUTH_PLATFORM_URL=not a url` is an operator mistake; `/login` on the string "not a url" is not a destination.
    expect(signInHref(me({ authPlatformUrl: 'not a url' }), 'https://pdf.example.com/')).toBeNull();
  });
});

describe('nextPath', () => {
  test('accepts a path on this app', () => {
    expect(nextPath('?next=/tools/merge')).toBe('/tools/merge');
    expect(nextPath('?a=1&next=/jobs/abc?x=2')).toBe('/jobs/abc?x=2');
  });

  test('refuses anything that leaves the app', () => {
    // `//evil.example` is `https://evil.example` spelled without a scheme, and it is the case a naive `startsWith('/')`
    // check lets through.
    for (const search of [
      '?next=https://evil.example/steal',
      '?next=//evil.example/steal',
      '?next=tools/merge',
      '?next=',
      '?none=/tools',
    ]) {
      expect(nextPath(search)).toBeNull();
    }
  });
});

describe('gateNotice', () => {
  test('the ordinary refusal offers the sign-in link', () => {
    const notice = gateNotice({ phase: 'refused', reason: undefined }, { hasSignIn: true });
    expect(notice.action).toBe('signin');
    expect(notice.title).toContain('Sign in');
  });

  test('an expired bridge asks for a sign-in, not a retry', () => {
    expect(gateNotice({ phase: 'refused', reason: 'bridge_expired' }, { hasSignIn: true }).action).toBe('signin');
  });

  test('a platform that did not answer asks for a retry, not a sign-in', () => {
    // The distinction the taxonomy exists for: the caller may still be signed in, and sending them to sign in again
    // for an outage is the failure this test is here to prevent.
    const notice = gateNotice({ phase: 'refused', reason: 'platform_unreachable' }, { hasSignIn: true });
    expect(notice.action).toBe('probe');
    expect(notice.title).toContain('did not answer');
  });

  test('a handoff that expired mid-flight asks for a retry', () => {
    expect(gateNotice({ phase: 'refused', reason: 'exchange_failed' }, { hasSignIn: true }).action).toBe('probe');
  });

  test('no platform at all offers nothing, and never a dead button', () => {
    const notice = gateNotice({ phase: 'refused', reason: 'not_configured' }, { hasSignIn: false });
    expect(notice.action).toBe('none');
    expect(notice.body).toContain('Auth Platform is not configured');
  });

  test('a refusal with no reason and no configured platform also offers nothing', () => {
    // Belt and braces: the two facts can disagree, and a rendered button that goes nowhere is worse than a sentence.
    expect(gateNotice({ phase: 'refused', reason: undefined }, { hasSignIn: false }).action).toBe('none');
  });

  test('a failed call is reported as a failed check, not as a status', () => {
    const notice = gateNotice({ phase: 'failed', message: 'Too many requests.' }, { hasSignIn: true });
    expect(notice.tone).toBe('warning');
    expect(notice.body).toContain('Too many requests.');
    expect(notice.action).toBe('probe');
  });

  test('checking and linked are informational states with nothing to press', () => {
    for (const state of [{ phase: 'checking' } as const, { phase: 'linked' } as const]) {
      const notice = gateNotice(state, { hasSignIn: true });
      expect(notice.tone).toBe('info');
      expect(notice.action).toBe('none');
    }
  });
});

describe('gateRenders', () => {
  test('an anonymous session on a strict installation gets the card', () => {
    // The defect this predicate was extracted for, and the one case where the two questions disagree: the creation
    // gate says "not gated" (an anonymous session is not a guest), while the page is replaced all the same — so a card
    // that asked only the first question rendered an **empty box**, on the one installation that has nothing else to
    // offer. Asserted as the disagreement rather than as one call, because the disagreement is the bug.
    const anonymous = me({ kind: 'anonymous', authenticated: true, strictMode: true, allowAnonymous: false });

    expect(gateApplies(anonymous)).toBe(false);
    expect(gateRenders(anonymous, { phase: 'refused' })).toBe(true);
  });

  test('with strict mode off an anonymous visitor is left in peace', () => {
    // The dev stack and every installation that serves visitors. A card here would be the gate closing a product that
    // is open, which is the failure in the other direction.
    const anonymous = me({ kind: 'anonymous', authenticated: true, strictMode: false, allowAnonymous: true });
    expect(gateRenders(anonymous, { phase: 'refused' })).toBe(false);
  });

  test('the creation gate still renders on the screens that offer to create something', () => {
    const guest = me({ kind: 'guest', authenticated: false, strictMode: false, allowAnonymous: false });
    expect(gateRenders(guest, { phase: 'refused' })).toBe(true);
  });

  test('a successful check renders the card that confirms it', () => {
    // The third clause: after linking, this card is what says "You are signed in", so it must render for a caller that
    // is not gated at all.
    const signedIn = me({ kind: 'user', authenticated: true, strictMode: false, allowAnonymous: false });
    expect(gateRenders(signedIn, { phase: 'linked' })).toBe(true);
  });

  test('nothing renders before /me has answered', () => {
    expect(gateRenders(null, null)).toBe(false);
    expect(gateRenders(null, { phase: 'linked' })).toBe(true);
  });
});

describe('strictRedirectHref', () => {
  const strict = (over: Partial<MeBody> = {}): MeBody =>
    me({ strictMode: true, authPlatformUrl: 'http://localhost:3000', ...over });

  test('a refusal on a strict installation sends the visitor to the sign-in page, and back', () => {
    // The request this decision exists for: a strict installation publishes nothing, so "here is a card, press this"
    // is a worse answer than the one every other account-required app gives.
    const href = strictRedirectHref(strict(), { phase: 'refused' }, 'http://localhost:5180/tools/merge');
    expect(href).not.toBeNull();

    const signIn = new URL(href as string);
    expect(signIn.pathname).toBe('/login');
    // The return address is this page, and it carries `relink` — the marker that makes the trip home count as consent
    // to link, without which a browser that had signed out here would come back to a page that refused to look.
    const back = new URL(signIn.searchParams.get('redirect') as string);
    expect(back.href).toBe('http://localhost:5180/tools/merge?relink=1');
  });

  test('the check goes first, and only a refusal is a reason to leave', () => {
    // `null` and `checking` are the same statement earlier: redirecting ahead of the probe would push out a person the
    // workspace is about to hand back. `linked` is that hand-back arriving. `failed` is a call that did not complete —
    // an API restarting, a network drop — and a trip to a platform that is not answering is a dead end.
    for (const state of [
      null,
      { phase: 'checking' } as const,
      { phase: 'linked' } as const,
      { phase: 'failed', message: 'Too many requests.' } as const,
    ]) {
      expect(strictRedirectHref(strict(), state, 'http://localhost:5180/')).toBeNull();
    }
  });

  test('a tab that has already been walked there gets the card instead', () => {
    // The loop guard. The workspace returns the visitor to the address it was given, and two of the three outcomes
    // come back refused (they cancelled, or their session had already ended) — so a second automatic trip would send
    // them out again for the same answer, forever.
    expect(
      strictRedirectHref(strict(), { phase: 'refused' }, 'http://localhost:5180/', { tripTaken: true }),
    ).toBeNull();
  });

  test('an installation with no workspace to sign in to does not send anyone anywhere', () => {
    // `signInHref` is `null` here, and a redirect to nowhere is worse than a card that says the platform is missing.
    expect(
      strictRedirectHref(strict({ authPlatformUrl: null }), { phase: 'refused' }, 'http://localhost:5180/'),
    ).toBeNull();
  });

  test('strict mode off leaves the ordinary gate as the card it is', () => {
    // The shipped default and every non-strict installation: anonymous use off, pages public. This caller gets a card
    // on the surfaces that offer to create something — being sent to a login page from the catalogue would be the app
    // refusing a page it deliberately publishes.
    const tenantFirst = me({ strictMode: false, allowAnonymous: false, authPlatformUrl: 'http://localhost:3000' });
    expect(strictRedirectHref(tenantFirst, { phase: 'refused' }, 'http://localhost:5180/')).toBeNull();
  });

  test('a signed-in caller is never sent anywhere', () => {
    const signedIn = strict({ kind: 'user', userId: 'u1', authenticated: true });
    expect(strictRedirectHref(signedIn, { phase: 'refused' }, 'http://localhost:5180/')).toBeNull();
  });
});
