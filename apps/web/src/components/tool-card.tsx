import { Link } from 'react-router';
import { IconArrowRight } from './icons';
import { categoryLabel, toolIcon } from './layout/nav';

/**
 * A tool, as a card — one component, two pages.
 *
 * The landing shows six of these with an **Explore** button and the catalog shows all of them with a quieter **Open**,
 * and both are the same card: a summary, the category it belongs to, and a way in. Writing it twice is how the two
 * pages end up disagreeing about what a tool's card says, which is the kind of drift nobody files a bug about.
 *
 * The tile colour is the category's, not the tool's. Thirty-three tools would mean thirty-three hues and a page that
 * looks like a spreadsheet of stickers; seven categories is a palette a person can learn, and it means the same
 * gradient appears in the sidebar, on the card and on the group header for the same group of tools.
 *
 * The glyph inside the tile is the tool's own (`toolIcon`), not the category's — that asymmetry is deliberate: the
 * colour says which family it belongs to, the glyph says which tool it is, and the sidebar row for the same tool
 * wears the same glyph.
 */

const CATEGORY_GRADIENTS: Record<string, string> = {
  organize: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
  convert: 'linear-gradient(135deg, #0ea5e9, #22d3ee)',
  optimize: 'linear-gradient(135deg, #f59e0b, #f97316)',
  edit: 'linear-gradient(135deg, #ec4899, #f43f5e)',
  security: 'linear-gradient(135deg, #10b981, #059669)',
  document: 'linear-gradient(135deg, #8b5cf6, #d946ef)',
  ocr: 'linear-gradient(135deg, #14b8a6, #0ea5e9)',
};

export function categoryGradient(category: string | undefined): string {
  if (!category) return 'linear-gradient(135deg, #64748b, #94a3b8)';
  return CATEGORY_GRADIENTS[category] ?? 'linear-gradient(135deg, #64748b, #94a3b8)';
}

export function ToolCard({
  id,
  title,
  summary,
  category,
  phase,
  disabled = false,
  explore = false,
}: {
  id: string;
  title: string;
  summary: string;
  category?: string;
  phase?: number;
  disabled?: boolean;
  explore?: boolean;
}) {
  const Icon = toolIcon(id, category);
  return (
    <article className="app-card">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className="app-icon" style={{ background: categoryGradient(category) }} aria-hidden="true">
          <Icon size={19} />
        </span>
        <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <span className="strong">{title}</span>
          {category ? <span className="tiny faint">{categoryLabel(category)}</span> : null}
        </span>
      </div>
      <p className="small muted" style={{ flex: '1 1 auto' }}>
        {summary}
      </p>
      <div className="row" style={{ gap: 10 }}>
        {disabled ? (
          <span className="badge badge-neutral">Unavailable</span>
        ) : (
          <Link className={explore ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} to={`/tools/${id}`}>
            {explore ? 'Explore' : 'Open'}
            <IconArrowRight size={14} />
          </Link>
        )}
        {phase && phase > 1 ? (
          <span className="tiny faint" style={{ marginLeft: 'auto' }}>
            Phase {phase}
          </span>
        ) : null}
      </div>
    </article>
  );
}
