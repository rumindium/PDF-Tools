import { expect, test } from '@playwright/test';
import { WEB_URL } from '../../playwright.config';

/**
 * The shell on an installation that publishes **nothing** (`docs/0-TENANT-FIRST.md` §4.4, §5.5).
 *
 * The only browser file here that begins as a visitor with no account, which is why it runs under
 * `playwright.strict.config.ts` rather than beside the five cases that drive the upload form: those need a stack that
 * serves visitors, and this one needs a stack that refuses to.
 *
 * Two cases, and they are the two ends of one decision. On this installation there is no page for such a visitor to
 * be on, so the welcome is not a card to press but the workspace's own sign-in page — and once that trip has been
 * taken in this tab, the visitor stays and the card is what the shell shows, because walking someone out a second
 * time for the same answer is a loop with the login page at both ends (`features/sign-in-gate/bounce.ts`). The card is
 * therefore both a state in its own right *and* the only state in which this shell can be looked at at all, which is
 * why the second case sets the trip flag before any page script runs.
 *
 * The card case is itself the record of three defects that were found by *looking at the page* and none of them by a
 * test. Two of them are observable here, and the order of the assertions is deliberate rather than tidy:
 *
 *  1. **No outage banner.** `GET /tools` answers 401 to a visitor on a strict installation, by design — and while
 *     `providers.tsx` fetched the catalogue and the identity with one `Promise.all`, that refusal was reported as
 *     "Could not reach the API" over a page that had lost the identity it needed to open the gate. Asserted *first*,
 *     because it is the defect that hides the gate: with the identity discarded there is nothing left to render a
 *     sign-in link from, so a case that checked the gate first would fail with the later symptom and name the wrong
 *     cause.
 *  2. **The identity arrived.** Which is the *other* half of the defect above and a different failure: the shell that
 *     threw the identity away cannot say who is looking at it, so the gate has nothing to render from. Asserted
 *     before the gate for the same reason the banner is: a case that asked for the gate first would report the later
 *     symptom. This is also the assertion the three falsification claims in `scripts/ci/falsify.ts` point at, so it
 *     says what a missing identity costs rather than what it looks like.
 *  3. **The gate replaces the page.** Not decoration: no catalogue, and the card with the way in. This is the half a
 *     predicate test cannot see — `gateRenders` can be right while the component asks a different question, which is
 *     exactly what shipped (an empty 520px box where the button should be). One assertion rather than two, and its
 *     message names **who** is looking: a guest and the holder of an anonymous session reach this page for different
 *     reasons and a case that labelled both the same way would report one line for two defects.
 *  4. **The link goes somewhere.** A card offering nothing is a dead end dressed as a next step — and on this
 *     installation it is also the fallback the trip deliberately leaves behind for a tab that has already been walked
 *     there, an installation with no workspace to sign in to, or a check that could not complete.
 *
 * What it does not do: assert the *absence* of the catalogue by counting links. The catalogue is refused by the API,
 * so a case that counted tool links would pass on a bundle that had simply failed to render — it would be measuring an
 * outage and calling it a gate. The gate's own text is what this asks for, and `test:tenant-first`'s strict leg is
 * where the API's half of the claim is measured.
 */

test.describe('an installation with no public page', () => {
  /**
   * The session the visitor already holds, when the harness captured one before the stack changed position.
   *
   * Two visitors reach this page and they are not the same case: a caller with **no** session, and one holding an
   * anonymous cookie minted while anonymous use was on. The second is the one a page gate cannot cover on its own —
   * the cookie resolves perfectly well and never loads a page that would ask — and it is the case the card's condition
   * got wrong, so a run that has the cookie uses it. Absent (a stack that never served visitors), the case drives the
   * guest, and the claim that needs the session reports itself `not-falsified` loudly rather than passing.
   */
  test.beforeEach(async ({ context }) => {
    const cookie = process.env.PDFTOOLS_SESSION_COOKIE;
    if (!cookie) return;
    const [name, value] = cookie.split('=');
    if (!name || !value) return;
    await context.addCookies([{ name, value, url: WEB_URL }]);
  });

  test('a visitor this installation refuses is walked to the sign-in page', async ({ page }) => {
    /**
     * The trip, and the reason it is a *navigation* rather than a card with a button on it: this installation has no
     * page for a caller without an account, so the one useful thing it can do is hand them to the workspace.
     *
     * Asserted through `waitForURL` rather than by reading the page, because the page being read is the app's own and
     * the visitor is supposed to have left it. The URL it is walked to is the platform's login page with this page as
     * the return address — and the return address carries `relink`, which is what makes the trip back count as consent
     * to link (`lib/auto-link.ts`); without it a browser that had signed out here would come back to a page that
     * refused to look at it. What is deliberately *not* asserted is the platform's host: the API publishes that URL,
     * so a literal here would be a deployment detail dressed as a claim.
     */
    await page.goto('/');

    const walked = await page
      .waitForURL(/\/login\?redirect=/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    expect(
      walked,
      'a visitor this installation refuses must be walked to the sign-in page — with strict mode on there is no page to land on, and a card to press is not an answer to "there is nothing here for you"',
    ).toBe(true);

    const target = new URL(page.url());
    expect(target.pathname.endsWith('/login')).toBe(true);

    const back = new URL(target.searchParams.get('redirect') ?? '');
    expect(back.origin).toBe(new URL(WEB_URL).origin);
    expect(back.searchParams.get('relink')).toBe('1');
  });

  test('a tab that has already been walked there once gets the card instead', async ({ page }) => {
    // The guard, set the way it survives a round trip: before any page script runs. This is not a test convenience —
    // it is the state a visitor returns in after cancelling a sign-in, and the one in which the shell has to answer
    // for itself rather than handing them back to the login page for the answer they just gave.
    await page.addInitScript(() => {
      try {
        window.sessionStorage.setItem('pdft.signin_trip', '1');
      } catch {
        // Storage refused: the case would then be measuring the redirect, and the assertion below says so.
      }
    });

    /**
     * Who is looking, decided by the cookie the harness handed this context.
     *
     * Two visitors arrive here and a failure means a different thing for each: a caller with **no** session, and one
     * holding an anonymous cookie minted while anonymous use was on. The second is the case a page gate cannot cover
     * on its own — the cookie resolves perfectly well and never loads a page that would ask — and it is the case that
     * shipped an empty box, so the gate assertion below says which of the two is on screen when it fails.
     */
    const refusedSession = Boolean(process.env.PDFTOOLS_SESSION_COOKIE);

    await page.goto('/');

    // ── 0. The session the harness handed over is really there ────────────────
    // A precondition, asserted rather than assumed. A cookie the browser refuses — a name carrying a stray `set-cookie:`
    // prefix, a value with a semicolon in it — is dropped **silently**, and the case then drives a guest: the gate
    // renders for a different reason, and the claim that needs this visitor reports the product healthy for having
    // measured somebody else. One request from this context through the same proxy the page uses, which is also the
    // identity the gate is built from, so a failure here names the harness rather than the page.
    if (refusedSession) {
      const seen = (await (await page.request.get('/api/v1/me')).json()) as { kind?: string };
      expect(
        seen.kind,
        'the harness handed this context a session and the API does not see it — every assertion below would be about a guest instead of the visitor this case exists for',
      ).toBe('anonymous');
    }

    // ── 1. A refusal is not a fault ───────────────────────────────────────────
    // The banner is the shell's reaction to a failed call, and `AUTH_REQUIRED` from the catalogue is a *policy*. Two
    // minutes of a real page's life are worth stating: this is the assertion that would have caught the identity being
    // thrown away with the catalogue, and it fails before the gate assertion for that reason.
    const outage = page.getByText('Could not reach the API');
    await expect(
      outage,
      'the catalogue refusal must not be reported as an outage — this installation publishes no catalogue on purpose',
    ).toHaveCount(0);

    // ── 2. The identity the gate is made of arrived ───────────────────────────
    // The header names the caller, and a page whose identity never arrived is stuck on `Loading` for ever — the other
    // half of the defect above, and a different failure: the shell cannot say who is looking at it, and no banner is
    // raised for a refusal. Asserted as text the page *must* show rather than the identity's value, because what is
    // being asked is "did the shell get an answer at all".
    const loading = page.getByText('Loading', { exact: true });
    await expect(
      loading,
      'the identity must survive a refused catalogue: without it this page cannot say who is looking at it, and the gate has nothing to render from',
    ).toHaveCount(0);

    // ── 3. The gate stands in for the page ────────────────────────────────────
    const heading = page.getByText('Sign in to use PDF Tools');
    await expect(
      heading,
      refusedSession
        ? 'the gate card must render for a visitor who holds a session this installation refuses, not an empty page'
        : 'the strict gate must replace the page on an installation with no public page: every tool, and the catalogue itself, is behind an account',
    ).toBeVisible();

    // ── 4. And it offers the way in ───────────────────────────────────────────
    // The href is the platform's own login page carrying this page as the return address — the API publishes the
    // platform's URL, so a case that asserted a literal host here would be asserting a deployment detail.
    const signIn = page.getByRole('link', { name: 'Sign in' }).first();
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute('href', /\/login\?redirect=/);
  });
});
