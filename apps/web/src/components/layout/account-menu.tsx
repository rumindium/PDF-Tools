import type { MeBody } from '@pdftools/contracts/api';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { accountLabel, initials } from '../../features/sign-in-gate/gate';

/**
 * The signed-in caller, in the header (`docs/0-UI-DESIGN.md` §2, `[account ▾]`).
 *
 * Before this, the header showed a plan badge whether or not anyone was behind it: an account and an anonymous
 * session were told apart only by the word on the badge, so a person who had signed in on the workspace had no way to
 * see that this app knew it. The avatar is that answer, and the dropdown is where the account's own destinations and
 * the way out of it live — the place a header conventionally puts them.
 *
 * Why a hand-rolled popover rather than a component library: this app has no dependency for it and needs three
 * things from the behaviour (close on outside click, close on Escape, close on navigation). Those are ten lines, and
 * the alternative is a dependency whose own focus and portal defaults would have to be turned off one by one.
 *
 * The avatar never shows a letter it invented: a caller with no mirrored name gets the glyph, not an initial derived
 * from an empty string.
 */
export function AccountMenu({
  me,
  planName,
  quotaLabel,
  signingOut,
  onSignOut,
}: {
  me: MeBody;
  planName: string;
  quotaLabel: string | null;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // A navigation is the end of "which account am I?" — leaving the menu open over a new page is how it ends up
  // floating over a screen it does not belong to. Adjusted during render rather than in an effect, which is the
  // pattern React documents for state that follows a prop: an effect would paint the open menu once on the new page
  // before closing it, and that frame is exactly the one being prevented here.
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const mark = initials(me.displayName);
  const label = accountLabel(me);

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${label}`}
        onClick={() => setOpen((value) => !value)}
        style={{ gap: 8, paddingLeft: 4, paddingRight: 8 }}
      >
        <Avatar mark={mark} />
        <span
          className="strong hide-sm"
          style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {label}
        </span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            minWidth: 260,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow)',
            padding: 6,
            zIndex: 30,
          }}
        >
          <div className="row" style={{ gap: 10, padding: '10px 10px 8px' }}>
            <Avatar mark={mark} size={34} />
            <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
              <span className="strong" style={{ overflowWrap: 'anywhere' }}>
                {label}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <span className="badge badge-accent">{planName}</span>
                {quotaLabel ? <span className="tiny muted">{quotaLabel}</span> : null}
              </span>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          <MenuLink to="/account" onNavigate={() => setOpen(false)}>
            Usage
          </MenuLink>
          <MenuLink to="/jobs" onNavigate={() => setOpen(false)}>
            Jobs
          </MenuLink>
          <MenuLink to="/drive" onNavigate={() => setOpen(false)}>
            My Drive
          </MenuLink>

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          <button type="button" role="menuitem" className="menu-item" disabled={signingOut} onClick={onSignOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          {/*
            What the action does, said where it is pressed — and it is no longer the smaller of the two things it
            could be. This ends the workspace session as well: the platform revokes the shared handle and records the
            moment, so the workspace and every other app on this browser are signed out too, and the same button over
            there does the same thing to this one (`docs/0-TENANT-FIRST.md` §7f). Saying "you stay signed in on the
            workspace" here would now be the opposite of what happens.
          */}
          <p className="tiny faint" style={{ padding: '2px 10px 8px' }}>
            Signs you out here, on the workspace, and on every other app you have open.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Avatar({ mark, size = 26 }: { mark: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: '50%',
        background: 'var(--accent-weak)',
        color: 'var(--accent-text)',
        display: 'grid',
        placeItems: 'center',
        fontWeight: 650,
        fontSize: size <= 26 ? 11 : 13,
        letterSpacing: '0.02em',
      }}
    >
      {mark || <PersonGlyph />}
    </span>
  );
}

function PersonGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21" strokeLinecap="round" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuLink({ to, children, onNavigate }: { to: string; children: string; onNavigate: () => void }) {
  return (
    <Link role="menuitem" className="menu-item" to={to} onClick={onNavigate}>
      {children}
    </Link>
  );
}
