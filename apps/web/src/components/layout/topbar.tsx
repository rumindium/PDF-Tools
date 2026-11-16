import type { MeBody } from '@pdftools/contracts/api';
import { Link, useLocation } from 'react-router';
import { planLabel, quotaLabel, useSession, useToolDefinition } from '../../app/providers';
import { isSignedIn } from '../../features/sign-in-gate/gate';
import { IconChevronRight, IconMenu } from '../icons';
import { AccountMenu } from './account-menu';
import { crumbs } from './nav';

/**
 * The topbar — where you are, and who you are, on every page.
 *
 * It exists so pages do not have to answer either question themselves: a route renders its content and the bar above
 * says which part of the app it belongs to (breadcrumb) and which account is looking at it. That is also why the
 * document title and the breadcrumb cannot disagree — both come from the same route (`nav.ts` `crumbs`).
 *
 * The menu button is the only control that appears here and nowhere else, and it appears for **one reason in two states**:
 * the sidebar is a drawer below 1024px, and it is a drawer in full-screen editing at any width — so a drawer nobody can
 * open is a navigation that does not exist in either of them. Which of the two it is, the bar does not ask: the shell
 * writes one attribute for both (`app/root-layout.tsx`), and this button is visible wherever it is set.
 *
 * There is deliberately no second control here for leaving full screen. The canvas carries its own toggle — a labelled
 * button in the toolbar that never scrolls away, because the stage's page scrolls inside itself — and a mode whose exit
 * is in two places has two names for one action in the accessibility tree, which is how a screen-reader user ends up
 * choosing between identical buttons.
 */
export function Topbar({
  me,
  signIn,
  signingOut,
  onSignOut,
  onOpenNav,
}: {
  me: MeBody | null;
  signIn?: { href: string | null } | null;
  signingOut: boolean;
  onSignOut: () => void;
  onOpenNav: () => void;
}) {
  const location = useLocation();
  const toolId = location.pathname.startsWith('/tools/') ? location.pathname.slice('/tools/'.length) : undefined;
  const tool = useToolDefinition(toolId);
  const trail = crumbs(location.pathname, { toolTitle: tool?.title });
  const signedIn = isSignedIn(me);
  const quota = quotaLabel(me);

  return (
    <header className="shell-topbar">
      <button type="button" className="icon-btn nav-toggle" aria-label="Open navigation" onClick={onOpenNav}>
        <IconMenu size={19} />
      </button>

      <nav className="crumbs" aria-label="Breadcrumb">
        {trail.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 7, minWidth: 0 }}>
            {index > 0 ? (
              <span className="crumb-sep" aria-hidden="true">
                <IconChevronRight size={13} />
              </span>
            ) : null}
            {crumb.to && index < trail.length - 1 ? (
              <Link to={crumb.to}>{crumb.label}</Link>
            ) : (
              <span className="crumb-now">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>

      <span className="grow" />

      <div className="row" style={{ gap: 10 }}>
        {quota ? <span className="topbar-chip hide-below-lg">{quota}</span> : null}
        {signIn ? (
          signIn.href ? (
            <a className="btn btn-primary btn-sm" href={signIn.href}>
              Sign in
            </a>
          ) : (
            <span className="badge badge-warning">No account</span>
          )
        ) : signedIn && me ? (
          <AccountMenu
            me={me}
            planName={planLabel(me)}
            quotaLabel={quota}
            signingOut={signingOut}
            onSignOut={onSignOut}
          />
        ) : (
          <span className="badge badge-accent">{planLabel(me)}</span>
        )}
      </div>
    </header>
  );
}
