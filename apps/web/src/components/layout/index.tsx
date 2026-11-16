import type { ReactNode } from 'react';

/**
 * Layout pieces.
 *
 * The header that used to live here is gone: identity, plan and quota moved into the shell's topbar
 * (`./topbar.tsx`), and navigation moved into the sidebar (`./sidebar.tsx`), because the app now wears the same chrome
 * as Auth Platform and Procurement — a fixed column on the left and a 64px bar across the top. What remains is the one
 * piece every route uses, `Container`, and the page heading nobody should have to spell out five properties for.
 *
 * `Container` is deliberately unchanged in shape: routes render into it and did not have to be touched when the shell
 * around them changed. That is the point of a page not knowing what its chrome is.
 */

export function Container({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? 'container container-wide' : 'container'}>{children}</div>;
}

export function PageTitle({
  title,
  description,
  icon,
  aside,
}: {
  title: string;
  description?: ReactNode;
  /**
   * The page's own glyph, in a tinted tile beside the heading.
   *
   * A tool page takes the tool's navigation icon, so the row that was clicked and the heading that arrives are the
   * same object. It is `aria-hidden` by construction — the heading already says the name, and an icon that repeats it
   * is noise in a screen reader's reading of the page.
   */
  icon?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="row-between wrap" style={{ alignItems: 'flex-end', marginBottom: 4 }}>
      <div className="stack-sm">
        <div className="row" style={{ gap: 11, alignItems: 'center' }}>
          {icon ? (
            <span className="page-title-icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <h1 style={{ fontSize: 24 }}>{title}</h1>
        </div>
        {description ? (
          <p className="muted small" style={{ maxWidth: 720 }}>
            {description}
          </p>
        ) : null}
      </div>
      {aside}
    </div>
  );
}
