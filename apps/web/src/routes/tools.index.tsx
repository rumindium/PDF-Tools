import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useCatalog, useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { categoryLabel, orderCategories } from '../components/layout/nav';
import { ToolCard } from '../components/tool-card';
import { Card, EmptyState, Field, Skeleton, TextInput } from '../components/ui';
import { SignInGate } from '../features/sign-in-gate';
import { gateApplies } from '../features/sign-in-gate/gate';
import { toolsIndexSeo } from '../lib/seo';

/**
 * Catalog (`docs/0-FOLDER-STRUCTURE.md` §3, `routes/tools.index.tsx`).
 *
 * Filtering happens on data the API already computed for this caller. Tools that exist but are not in the plan or not
 * enabled in this build are shown as unavailable rather than hidden — "the tool you read about is not in your plan" is
 * a clearer answer than an empty page and a support ticket.
 *
 * The category lives in the **URL**, not in component state, and that is what makes the sidebar work: a group header
 * navigates to `/tools?category=organize`, and the same URL is what the group's own row highlights. Before this, the
 * filter existed only while the page did — so a category was reachable from the sidebar and immediately forgotten by
 * the address bar, and two links to "the same" list were not the same link.
 */
export function ToolsIndexRoute() {
  const catalog = useCatalog();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? 'all';
  const query = params.get('q') ?? '';
  // A gated caller's tools all read as `available: false`, because availability is computed from a plan they do not
  // have. Saying "requires a higher plan" about every tool would be both wrong and repetitive; the gate says the one
  // thing that is true instead, once, at the top.
  const gated = gateApplies(me);

  // The same reading order the sidebar and the landing use, not alphabetical: a category that is third in the
  // sidebar should not be fifth in the chips, or the two lists look like two different taxonomies.
  const categories = useMemo(() => orderCategories(catalog?.tools.map((tool) => tool.category) ?? []), [catalog]);

  const visible = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    return catalog.tools.filter((tool) => {
      if (category !== 'all' && tool.category !== category) return false;
      if (!needle) return true;
      return `${tool.title} ${tool.summary} ${tool.id}`.toLowerCase().includes(needle);
    });
  }, [catalog, category, query]);

  /** One writer for both filters, so a chip click and a typed search cannot disagree about what the URL says. */
  const setFilter = (next: { category?: string; q?: string }) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (!value || value === 'all') merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  };

  return (
    <>
      <Seo
        meta={toolsIndexSeo(
          catalog?.tools.length ?? null,
          catalog?.tools.map((tool) => ({ id: tool.id, title: tool.title, summary: tool.summary })),
        )}
      />
      <Container>
        <div className="page stack" style={{ gap: 20 }}>
          <PageTitle
            title="All tools"
            description="Everything the API exposes. Availability, size ceilings, and page limits come from your plan and are applied on the server."
          />

          {gated ? (
            <Card className="card-pad">
              <SignInGate hint="Everything in this list is available once you sign in — the catalog itself is public." />
            </Card>
          ) : null}

          <div className="stack-sm">
            <div className="chips">
              <button
                type="button"
                className="chip"
                data-active={category === 'all'}
                onClick={() => setFilter({ category: 'all' })}
              >
                All
              </button>
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="chip"
                  data-active={category === name}
                  onClick={() => setFilter({ category: name })}
                >
                  {categoryLabel(name)}
                </button>
              ))}
            </div>
            <div style={{ maxWidth: 340 }}>
              <Field label="Search" htmlFor="tool-search">
                <TextInput
                  id="tool-search"
                  value={query}
                  placeholder="merge, compress, ocr…"
                  onChange={(event) => setFilter({ q: event.currentTarget.value })}
                />
              </Field>
            </div>
          </div>

          {!catalog ? (
            <div className="grid-tools">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <Card key={index} className="card-pad stack-sm">
                  <Skeleton width="60%" />
                  <Skeleton width="90%" />
                  <Skeleton width="40%" />
                </Card>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState title="No tools match that filter" description="Try a different category or search term." />
            </Card>
          ) : (
            <div className="grid-tools">
              {visible.map((tool) => (
                <div
                  key={tool.id}
                  className="stack-sm"
                  style={{ opacity: gated || (tool.available && tool.enabled) ? 1 : 0.55 }}
                >
                  <ToolCard
                    id={tool.id}
                    title={tool.title}
                    summary={tool.summary}
                    category={tool.category}
                    phase={tool.phase}
                    disabled={!gated && (!tool.available || !tool.enabled)}
                  />
                  {!tool.enabled ? (
                    <span className="tiny faint">Not in this build yet (phase {tool.phase})</span>
                  ) : gated ? (
                    <span className="tiny faint">Sign in to use this</span>
                  ) : !tool.available ? (
                    <span className="tiny faint">Requires {tool.requiresPlan?.join(' or ') ?? 'a higher plan'}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </Container>
    </>
  );
}
