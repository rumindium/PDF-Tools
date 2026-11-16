import { Link, useLocation } from 'react-router';
import { planLabel, quotaLabel, useCatalog, useSession } from '../../app/providers';
import { canOpenAdmin } from '../../features/app-admin/access';
import { accountLabel, initials, signInHref } from '../../features/sign-in-gate/gate';
import { withRelinkParam } from '../../lib/auto-link';
import { IconUser } from '../icons';
import { type NavIcon, activeGroupId, isActiveTarget, metaNav, overviewNav, toolNavGroups } from './nav';

/**
 * The sidebar — every destination in the app, on the left, the way Auth Platform and Procurement do it.
 *
 * Four things about it are deliberate:
 *
 *  - **The tools are in the navigation, not behind a link to a grid.** With thirty-three of them, "which one do I
 *    need" is answered by a category name and a tool name, and a page that lists cards makes the person read all of
 *    them every time.
 *  - **A category *is* a section label, spelled and styled exactly like "Workspace" and "Account".** There is no
 *    generic "Tools" heading: seven category names take its place, and the tools are listed inside the category they
 *    belong to. "Tools" tells a person nothing they did not already know — they are looking at a PDF toolbox — while
 *    "Organize" and "Convert" are the two words that answer what to click.
 *  - **Nothing is behind a caret.** A heading whose contents are hidden until it is clicked is a heading that has to
 *    be discovered, and once the category names *are* the headings there is nothing left for a caret to improve: the
 *    list under each one is one to nine rows, and it is what the person came for.
 *  - **A category label is still a link.** It goes to that category's filtered catalog (`/tools?category=organize`),
 *    which is the one thing a heading can usefully do here — it is how you compare the eight tools inside it — and it
 *    lights up while the current page is one of its own tools, so the heading over the selected row is never grey
 *    while its child is selected (`activeGroupId`, the rule that used to decide which group opened).
 *  - **Every tool row carries its own glyph** (`toolIcon` in `nav.ts`), not its category's: eight Organize tools
 *    wearing one layers icon each is a column of identical shapes where the icons are supposed to be the shortcut.
 *    The icon is the same one the tool's card and its row in the recent-jobs feed use, so the thing you clicked and
 *    the place you are look like the same thing.
 *
 * There are two sections, not three: "Workspace" and the categories. The account heading is gone — the app is fully free,
 * closes the workspace list, and the sign-in row (anonymous callers only) sits at the very bottom, because it is not
 * a destination inside the app but what comes before it.
 *
 * The account block sits above the navigation with the plan, because both change what the list below is: an anonymous
 * session and a signed-in one do not see the same app (`docs/0-TENANT-FIRST.md` §4).
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession();
  const catalog = useCatalog();
  const location = useLocation();

  const overview = overviewNav({ toolsCount: catalog ? catalog.tools.length : null, canAdmin: canOpenAdmin(me) });
  const toolGroups = toolNavGroups(catalog);
  const meta = metaNav();
  const activeGroup = activeGroupId({ pathname: location.pathname, search: location.search }, toolGroups);
  const signedIn = me != null && me.kind === 'user';
  const signIn = !signedIn
    ? signInHref(me, withRelinkParam(typeof window === 'undefined' ? '/' : window.location.href))
    : null;
  const quota = quotaLabel(me);

  return (
    <aside className="shell-side" data-open={open} aria-label="Navigation">
      <Link to="/" className="side-brand" onClick={onClose}>
        <span className="side-brand-badge" aria-hidden="true">
          PDF
        </span>
        <span>
          <span className="side-brand-name">Tools</span>
          <span className="side-brand-sub">Rumindium</span>
        </span>
      </Link>
      <div className="side-hair" />

      <div className="side-account">
        <span className="side-avatar" aria-hidden="true">
          {signedIn ? initials(me.displayName) || <IconUser size={15} /> : <IconUser size={15} />}
        </span>
        <span style={{ minWidth: 0, flex: '1 1 auto' }}>
          <span className="side-item-label" style={{ display: 'block', fontWeight: 600, color: 'var(--sidebar-fg)' }}>
            {signedIn ? accountLabel(me) : 'Not signed in'}
          </span>
          <span
            className="side-item-label"
            style={{ display: 'block', fontSize: 11, color: 'var(--sidebar-fg-faint)' }}
          >
            {planLabel(me)}
            {quota ? ` · ${quota}` : ''}
          </span>
        </span>
      </div>

      <nav className="side-scroll">
        <span className="side-label">Workspace</span>
        {overview.map((node) => (
          <SideLink
            key={node.id}
            to={node.to}
            icon={node.icon}
            label={node.label}
            count={node.count}
            onNavigate={onClose}
          />
        ))}
        {/*
          The workspace list is followed directly by the categories: the app is fully free, so there is no
          commercial row. The order is therefore workspace → categories → sign in.
        */}
        {meta.map((node) => (
          <SideLink key={node.id} to={node.to} icon={node.icon} label={node.label} onNavigate={onClose} />
        ))}

        {toolGroups.map((group) => (
          <div key={group.id}>
            <Link
              to={group.to}
              className="side-label side-label-link"
              data-active={isActiveTarget(group.to, location) || activeGroup === group.id}
              onClick={onClose}
            >
              {group.label}
            </Link>
            <div className="side-sub">
              {group.children?.map((child) => {
                const Icon = child.icon;
                return (
                  <Link
                    key={child.id}
                    to={child.to}
                    className="side-subitem"
                    data-active={location.pathname === child.to}
                    onClick={onClose}
                  >
                    <Icon size={14} />
                    <span className="side-item-label">{child.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

        {/*
          The sign-in row sits last, with no heading over it: it is not a destination inside the app, it is what
          comes before the app, and the account block at the top is already saying "Not signed in" — this is the one
          row that does something about it.
        */}
        {signIn ? (
          <a className="side-item" href={signIn} onClick={onClose}>
            <span className="side-item-icon">
              <IconUser size={16} />
            </span>
            <span className="side-item-label">Sign in</span>
          </a>
        ) : null}
      </nav>

      <div className="side-foot">
        Files are deleted automatically · {catalog ? `${catalog.tools.length} tools` : 'loading catalog'}
      </div>
    </aside>
  );
}

function SideLink({
  to,
  icon: Icon,
  label,
  count,
  onNavigate,
}: {
  to: string;
  icon: NavIcon;
  label: string;
  count?: number;
  onNavigate: () => void;
}) {
  const location = useLocation();
  return (
    <Link to={to} className="side-item" data-active={isActiveTarget(to, location)} onClick={onNavigate}>
      <span className="side-item-icon">
        <Icon size={16} />
      </span>
      <span className="side-item-label">{label}</span>
      {count == null ? null : <span className="side-item-count">{count}</span>}
    </Link>
  );
}
