import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { Container } from '../components/layout';
import { Sidebar } from '../components/layout/sidebar';
import { Topbar } from '../components/layout/topbar';
import { Alert } from '../components/ui';
import { SignInGate } from '../features/sign-in-gate';
import { gateApplies, signInHref, strictGateApplies } from '../features/sign-in-gate/gate';
import { allowAutoLink, withRelinkParam } from '../lib/auto-link';
import { FocusModeProvider } from '../lib/focus-mode';
import { useMediaQuery } from '../lib/media';
import { useSession } from './providers';

/**
 * The shell: sidebar, topbar, content, footer.
 *
 * Three things live here because they are true of every screen and would otherwise be repeated on each one: the
 * session-error banner, the "signed out somewhere else" notice, and the strict-mode gate. A page renders its own
 * content and nothing about the chrome around it.
 *
 * The shell is also where the app decided to look like the rest of the suite. Auth Platform and Procurement both put
 * navigation in a fixed left column and identity in a 64px bar across the top; this app did not, so a person moving
 * between the three had to learn two of everything — where the menu is, where the account is, and how the two
 * platforms' borders line up (they do: the sidebar's brand row is `var(--header-height)` tall, so its hairline meets
 * the topbar's border as one continuous line).
 *
 * And it is where **full-screen editing** is decided (`lib/focus-mode.tsx`): the canvas asks, and what changes is the
 * chrome — the navigation column slides away and the header's handle comes back, at any width — while the topbar, the
 * breadcrumb and the account stay exactly where they were. An editor that hid the header too would be a page with no way
 * back to the rest of the app, which is not what "full screen" should cost.
 */
export function RootLayout() {
  const { me, error, signOut, signingOut, sessionEnded, dismissSessionEnded } = useSession();
  // The drawer, and it starts closed. It is pressed into service twice — below 1024px, where the sidebar does not fit
  // beside the content, and in full-screen editing, where it is deliberately out of the way — and the stylesheet keys
  // both on **one attribute** (`data-drawer`, `styles/globals.css`) rather than on a media query, so the drawer's rules
  // are written once. This hook is what sets it, and is the only reason the width is known in JavaScript at all.
  const [navOpen, setNavOpen] = useState(false);
  const narrow = useMediaQuery('(max-width: 1023px)');

  /**
   * Full-screen editing, held here because it is a fact about the *shell*: the navigation goes away and the header gets
   * its handle back, which is a change to the chrome rather than to the canvas that asked for it. Two ways out, and
   * both of them are a user's own move: the canvas's own button, or a navigation — a page left behind should not leave a
   * sidebar hidden, and the route is the only thing that says the page changed. The previous path is kept in a ref so the
   * effect fires on a real move rather than on the first render, which would be a reset of state that is already false.
   */
  const [fullscreen, setFullscreen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    setFullscreen(false);
    setSidebarHidden(false);
    setNavOpen(false);
  }, [pathname]);
  // A drawer nobody is looking at should not open itself on the way back to a wide layout.
  useEffect(() => {
    if (!narrow && !fullscreen && !sidebarHidden) setNavOpen(false);
  }, [narrow, fullscreen, sidebarHidden]);

  const drawer = narrow || fullscreen || sidebarHidden;
  const focus = useMemo(
    () => ({ fullscreen, setFullscreen, sidebarHidden, setSidebarHidden }),
    [fullscreen, sidebarHidden],
  );

  // A caller the gate applies to gets the sign-in link in place of the plan badge — on every page, including the ones
  // that never render the gate card, because "which page am I on" should not decide whether signing in is offered
  // (`docs/0-TENANT-FIRST.md` §5). Signed with the `relink` marker for the same reason the sidebar's own link is: the
  // trip is how this browser is told that signing in again is what the person asked for.
  const signIn =
    gateApplies(me) || strictGateApplies(me) ? { href: signInHref(me, withRelinkParam(window.location.href)) } : null;

  return (
    <div className="shell" data-drawer={drawer} data-focus={fullscreen}>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <button
        type="button"
        className="shell-overlay"
        data-open={navOpen}
        tabIndex={navOpen ? 0 : -1}
        aria-label="Close navigation"
        onClick={() => setNavOpen(false)}
      />

      <div className="shell-main">
        <Topbar
          me={me}
          signIn={signIn}
          signingOut={signingOut}
          onSignOut={() => void signOut()}
          onOpenNav={() => setNavOpen(true)}
        />

        <main className="shell-content">
          <div className="shell-inner">
            <Container>
              {error ? (
                <div style={{ paddingBottom: 18 }}>
                  <Alert tone="warning" title="Could not reach the API">
                    <p className="small">
                      {error.message} {error.requestId ? <span className="mono">({error.requestId})</span> : null}
                    </p>
                  </Alert>
                </div>
              ) : null}
              {/*
                A session that ended somewhere else, said out loud. The topbar stops showing the account on its own,
                but a person mid-task with an uploader in front of them deserves the reason rather than an avatar that
                quietly turned into "Sign in" — and the way back, in the same place. Shown only for the ending the app
                observed and did not perform: pressing Sign out three inches to the right is its own confirmation, and
                a banner explaining it back would be the app narrating the click it just received.
              */}
              {sessionEnded ? (
                <div style={{ paddingBottom: 18 }}>
                  <Alert tone="info" title="Signed out on the workspace">
                    <p className="small">
                      Your workspace session ended, and this app uses the same one — so you are signed out here too.
                      Nothing you already ran is lost.{' '}
                      {signIn?.href ? (
                        <a href={signIn.href} onClick={allowAutoLink}>
                          Sign in again
                        </a>
                      ) : null}
                    </p>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={dismissSessionEnded}>
                        Dismiss
                      </button>
                    </div>
                  </Alert>
                </div>
              ) : null}
            </Container>

            {/*
              Strict mode replaces the page rather than decorating it (`docs/0-TENANT-FIRST.md` §4.2). The decision is
              taken once, here, for every route — which is the whole point of the switch: this installation publishes
              nothing, so there is no page for a caller without an account to be on, and a per-screen gate would be a
              list of screens somebody has to keep complete. The API refuses the same callers on the routes that hand
              out the product (`plugins/strict-surface.ts`), so a bundle that got this wrong would show an empty shell
              rather than the tools.
            */}
            {strictGateApplies(me) ? (
              <Container>
                <div style={{ maxWidth: 520, margin: '44px auto' }}>
                  <SignInGate
                    title="Sign in to use PDF Tools"
                    hint="This installation has no public page: every tool, and the catalogue itself, is behind an account."
                  />
                </div>
              </Container>
            ) : (
              // The provider is here rather than around the whole shell: the shell above reads the same state directly,
              // and the routes below are the only callers that need it handed to them.
              <FocusModeProvider value={focus}>
                <Outlet />
              </FocusModeProvider>
            )}
          </div>
        </main>

        {/* Outside `main`, and the flex column above puts it at the bottom of a short page rather than half way up it. */}
        <footer className="shell-foot" style={{ borderTop: '1px solid var(--border)' }}>
          <Container>
            <div className="row-between wrap small muted" style={{ padding: '18px 0' }}>
              <span>
                Free for everyone · <Link to="/drive">My Drive</Link>
              </span>
              <span className="tiny">Downloads expire with the job's retention window.</span>
            </div>
          </Container>
        </footer>
      </div>
    </div>
  );
}
