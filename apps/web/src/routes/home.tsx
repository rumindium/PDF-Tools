import type { JobView } from '@pdftools/contracts/api';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAvailableTools, useCatalog, useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { IconArrowRight, IconCheck, IconChevronRight, IconSparkles } from '../components/icons';
import { Container } from '../components/layout';
import { categoryIcon, categoryLabel, orderCategories, toolIcon } from '../components/layout/nav';
import { ToolCard, categoryGradient } from '../components/tool-card';
import { Card, EmptyState, Skeleton } from '../components/ui';
import { SignInGate } from '../features/sign-in-gate';
import { gateApplies, isSignedIn } from '../features/sign-in-gate/gate';
import { listJobs } from '../lib/api-client';
import { formatBytes, formatRelative, formatToolName, statusInfo } from '../lib/format';
import { homeSeo } from '../lib/seo';

/**
 * Home — the app's front door (`docs/0-FOLDER-STRUCTURE.md` §3, `routes/home.tsx`).
 *
 * The page walks two questions in order: **what is this** (hero), **which one do I want** (Top picks, then the
 * categories). A third — *where do I put my file* — deliberately has no section here: the drop target lives on the
 * tool page, where the options that decide the output are, and a second drop target on the landing meant one of the
 * two always ran with default options the person never saw. The hero's buttons go where the work actually happens.
 *
 * Everything animated is CSS only (`styles/globals.css` §Motion), and every one of those animations is a transform or
 * an opacity — the two properties a browser can animate without re-laying out — and all of it is switched off for
 * anyone whose system asks for reduced motion.
 */

/** The tool ids a first-time visitor is most likely to want, in the order they are shown. */
const TOP_PICKS = ['merge', 'split', 'compress', 'office-to-pdf', 'pdf-to-images', 'ocr'];

/**
 * One line under a category name, because a label alone says less than it looks like it does.
 *
 * "Organize" is a filing instruction, not a promise about what is inside; a person who has never used this app is
 * choosing between seven words, and the words that help are the verbs — merge, split, rotate. Keyed by the same
 * slugs `nav.ts` labels and icons, with a fallback so a category added to the catalog tomorrow still renders here
 * (it shows up with its own label rather than a blank line).
 */
const CATEGORY_BLURBS: Record<string, string> = {
  organize: 'Merge, split, reorder, rotate and crop pages.',
  convert: 'PDF out to Office, images, HTML and PDF/A — and back.',
  optimize: 'Shrink oversized files, repair the broken ones.',
  edit: 'Stamp text, watermarks, page numbers and headers.',
  security: 'Protect, unlock, redact, sign and fill in forms.',
  document: 'Pull out text, tables and form-field values.',
  ocr: 'Make scans searchable without losing the layout.',
};

function categoryBlurb(category: string): string {
  return CATEGORY_BLURBS[category] ?? `Every tool filed under ${categoryLabel(category).toLowerCase()}.`;
}

/** The three promises the hero repeats, each one visible in the app rather than in a marketing list. */
const HERO_FACTS = ['Uploads delete themselves', 'No document library', 'Jobs run isolated'];

export function HomeRoute() {
  const { me } = useSession();
  const catalog = useCatalog();
  const available = useAvailableTools();
  const [recent, setRecent] = useState<JobView[] | null>(null);

  // A gated caller's catalog marks every tool unavailable — the guest plan has none — so "the tools you can use"
  // would be an empty grid above the words "All 0 tools". The page falls back to what the registry implements and
  // lets the gate carry the explanation, because the alternative is a home page that reads as a broken build
  // (`docs/0-TENANT-FIRST.md` §4.5).
  const gated = gateApplies(me);
  const tools = gated ? (catalog?.tools ?? []).filter((tool) => tool.enabled) : available;
  const categories = orderCategories(tools.map((tool) => tool.category));

  useEffect(() => {
    listJobs({ pageSize: 5 })
      .then((body) => setRecent(body.items))
      .catch(() => setRecent([]));
  }, []);

  const picks = TOP_PICKS.map((id) => tools.find((tool) => tool.id === id))
    .filter((tool) => tool != null)
    .slice(0, 6);
  const maxMb = catalog?.plan.maxFileMb;
  // The count for the sign-in band comes from the whole catalog rather than from `tools`, which is empty for a
  // gated caller: "0 tools, one account" is the one sentence a page advertising the toolbox must never print.
  const catalogSize = gated ? (catalog?.tools.length ?? 0) : tools.length;
  const titleFor = (toolId: string) =>
    catalog?.tools.find((tool) => tool.id === toolId)?.title ?? formatToolName(toolId);

  return (
    <>
      <Seo meta={homeSeo()} />
      <Container wide>
        <div className="landing">
          <section className="hero">
            <span className="hero-blob hero-blob-a drift" aria-hidden="true" />
            <span className="hero-blob hero-blob-b drift" style={{ animationDelay: '-6s' }} aria-hidden="true" />
            {/* The plan's own ceiling, in the corner where a ribbon goes (`styles/globals.css` §hero-tag). */}
            {maxMb ? (
              <span className="hero-tag">
                <span className="hero-tag-value">{maxMb} MB</span>
                <span className="hero-tag-unit">per file</span>
              </span>
            ) : null}

            <div className="hero-inner">
              <div className="anim-up stack" style={{ gap: 18 }}>
                <span className="pill">
                  <IconSparkles size={14} />
                  Runs in your browser — nothing to install
                </span>
                <h1 className="hero-title">
                  Do something with a <span className="grad-text">PDF</span>
                  <br />
                  in about ten seconds.
                </h1>
                <p className="muted" style={{ maxWidth: 560 }}>
                  Merge, split, convert, compress, sign, redact, OCR — each one runs as an isolated job and the upload
                  is deleted automatically. There is no document library to clean up later.
                </p>
                <div className="hero-actions">
                  <Link className="btn btn-primary" to="/tools">
                    Explore all tools
                    <IconArrowRight size={15} />
                  </Link>
                  {picks[0] ? (
                    <Link className="btn btn-secondary" to={`/tools/${picks[0].id}`}>
                      Try {picks[0].title}
                    </Link>
                  ) : null}
                </div>
                <ul className="hero-facts">
                  {HERO_FACTS.map((fact) => (
                    <li key={fact}>
                      <IconCheck size={13} />
                      {fact}
                    </li>
                  ))}
                </ul>
              </div>

              <HeroPreview />
            </div>
          </section>

          {/*
          The gate, not a disabled dropzone. A gated caller's tools all refuse the job, so the page says so once, in
          one card, before the grids that would otherwise look like a promise (`docs/0-TENANT-FIRST.md` §4.5).
        */}
          {gated ? (
            <section className="anim-up" style={{ '--d': '90ms' } as React.CSSProperties}>
              <Card className="card-pad">
                <SignInGate hint="Every tool below opens the same way once you are signed in." />
              </Card>
            </section>
          ) : null}

          <section className="stack" style={{ gap: 16 }}>
            <div className="row-between wrap">
              <div className="stack-sm" style={{ gap: 2 }}>
                <h2 style={{ fontSize: 20 }}>Top picks</h2>
                <p className="small muted">The six people reach for most. Explore opens the tool with its options.</p>
              </div>
              <Link className="small" to="/tools">
                All {tools.length || ''} tools →
              </Link>
            </div>
            <div className="grid-picks">
              {picks.length === 0
                ? [0, 1, 2, 3, 4, 5].map((index) => (
                    <article key={index} className="app-card">
                      <Skeleton width="55%" />
                      <Skeleton width="90%" />
                      <Skeleton width="35%" />
                    </article>
                  ))
                : picks.map((tool, index) => (
                    <div
                      key={tool.id}
                      className="anim-pop"
                      style={{ '--d': `${140 + index * 55}ms`, display: 'flex' } as React.CSSProperties}
                    >
                      <ToolCard
                        id={tool.id}
                        title={tool.title}
                        summary={tool.summary}
                        category={tool.category}
                        explore
                        disabled={!gated && (!tool.available || !tool.enabled)}
                      />
                    </div>
                  ))}
            </div>
          </section>

          <section id="categories" className="stack" style={{ gap: 16 }}>
            <div className="stack-sm" style={{ gap: 2 }}>
              <h2 style={{ fontSize: 20 }}>Browse by category</h2>
              <p className="small muted">
                The same seven groups as the sidebar. A card opens that category's tools; the count is how many are in
                it.
              </p>
            </div>
            <div className="cat-cards">
              {categories.map((category, index) => {
                const Icon = categoryIcon(category);
                const count = tools.filter((tool) => tool.category === category).length;
                return (
                  <Link
                    key={category}
                    to={`/tools?category=${encodeURIComponent(category)}`}
                    className="cat-card anim-pop"
                    style={{ '--d': `${index * 45}ms` } as React.CSSProperties}
                  >
                    <span
                      className="cat-card-tile"
                      style={{ background: categoryGradient(category) }}
                      aria-hidden="true"
                    >
                      <Icon size={20} />
                    </span>
                    <span className="stack-sm" style={{ gap: 3, minWidth: 0 }}>
                      <span className="row" style={{ gap: 8 }}>
                        <span className="strong">{categoryLabel(category)}</span>
                        <span className="pill pill-xs">{count}</span>
                      </span>
                      <span className="small muted">{categoryBlurb(category)}</span>
                    </span>
                    <span className="cat-card-go" aria-hidden="true">
                      <IconArrowRight size={15} />
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>

          <section className="stack" style={{ gap: 16 }}>
            <div className="row-between wrap">
              <div className="stack-sm" style={{ gap: 2 }}>
                <h2 style={{ fontSize: 20 }}>Your recent jobs</h2>
                <p className="small muted">Downloads stay valid for the retention window; then they expire.</p>
              </div>
              <Link className="small" to="/jobs">
                Job history →
              </Link>
            </div>
            {recent == null ? (
              <div className="job-feed">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="job-feed-row">
                    <Skeleton width="34px" height={34} />
                    <span className="stack-sm" style={{ gap: 6, flex: '1 1 auto' }}>
                      <Skeleton width="38%" />
                      <Skeleton width="22%" />
                    </span>
                  </div>
                ))}
              </div>
            ) : recent.length === 0 ? (
              <Card>
                <EmptyState
                  title="Nothing yet"
                  description="Jobs you run show up here, with the status, the output size and a link to the result."
                />
              </Card>
            ) : (
              <div className="job-feed">
                {recent.map((job) => {
                  const info = statusInfo(job.status);
                  const entry = catalog?.tools.find((tool) => tool.id === job.tool);
                  // The tool's own glyph, the one its sidebar row and its card wear — the feed is the third place the
                  // same job can be recognised from, and it should not need the label to be read twice.
                  const Icon = toolIcon(job.tool, entry?.category);
                  const detail = job.output
                    ? `${job.output.parts} ${job.output.parts === 1 ? 'file' : 'files'} · ${formatBytes(job.output.bytes)}`
                    : info.description;
                  return (
                    <Link key={job.id} to={`/jobs/${job.id}`} className="job-feed-row">
                      <span
                        className="job-feed-tile"
                        style={{ background: categoryGradient(entry?.category) }}
                        aria-hidden="true"
                      >
                        <Icon size={16} />
                      </span>
                      <span className="stack-sm" style={{ gap: 3, flex: '1 1 auto', minWidth: 0 }}>
                        <span className="strong small truncate">{titleFor(job.tool)}</span>
                        <span className="tiny faint truncate">{detail}</span>
                      </span>
                      <span className={`badge badge-${info.tone}`}>{info.label}</span>
                      <span className="tiny faint job-feed-time">{formatRelative(job.createdAt)}</span>
                      <span className="job-feed-go" aria-hidden="true">
                        <IconChevronRight size={15} />
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section className="stack" style={{ gap: 12 }}>
            <div className="row-between wrap">
              <div className="stack-sm" style={{ gap: 2 }}>
                <h2 style={{ fontSize: 20 }}>My Drive</h2>
                <p className="small muted">
                  {isSignedIn(me)
                    ? 'Every result you run is kept here while its retention window lasts.'
                    : 'Anonymous runs are free but never stored — sign in to keep results in your drive.'}
                </p>
              </div>
              <Link className="small" to="/drive">
                Open drive →
              </Link>
            </div>
            {!isSignedIn(me) ? (
              <Card className="card-pad">
                <SignInGate hint="Signing in is what turns a run into a file kept in your drive." />
              </Card>
            ) : null}
          </section>

          <section className="cta-band anim-up">
            <div className="stack-sm" style={{ gap: 4 }}>
              <h2 style={{ fontSize: 19 }}>
                {catalogSize > 0 ? `${catalogSize} tools, all free` : 'Every tool, free'}
              </h2>
              <p className="small muted" style={{ maxWidth: 560 }}>
                Anonymous runs are free but never stored — sign in and every result is kept in your drive, across
                devices.
              </p>
            </div>
            <Link className="btn btn-primary" to="/drive">
              Open My Drive
              <IconArrowRight size={15} />
            </Link>
          </section>
        </div>
      </Container>
    </>
  );
}

/**
 * The hero's illustration: a miniature of the app, drawn in markup.
 *
 * Deliberately a mock of *this* product rather than a stock picture of paper clips — the moment a hero shows exactly
 * what the screen behind it will look like, the person has already learned the layout. Two cards, one floating, and
 * every element is a div with a border: nothing to download, and it recolours itself in dark mode because it is built
 * from the same tokens as the rest of the app.
 */
function HeroPreview() {
  return (
    <div className="anim-pop" style={{ position: 'relative', '--d': '220ms' } as React.CSSProperties}>
      <div className="preview-card float">
        <div className="row-between" style={{ marginBottom: 14 }}>
          <span className="row" style={{ gap: 9 }}>
            {' '}
            <span className="app-icon" style={{ background: categoryGradient('organize'), width: 32, height: 32 }}>
              <span className="tiny" style={{ fontWeight: 700 }}>
                3
              </span>
            </span>
            <span className="stack-sm" style={{ gap: 2 }}>
              <span className="strong small">Merge PDF</span>
              <span className="tiny faint">3 files · 1.8 MB</span>
            </span>
          </span>
          <span className="badge badge-success">Done</span>
        </div>

        {[92, 74, 58].map((width, index) => (
          <div key={width} className="row" style={{ gap: 10, padding: '7px 0' }}>
            <span className="app-icon" style={{ background: categoryGradient('convert'), width: 22, height: 22 }}>
              <span className="tiny" style={{ fontWeight: 700, fontSize: 9 }}>
                {index + 1}
              </span>
            </span>
            <span className="stack-sm" style={{ gap: 6, flex: '1 1 auto' }}>
              <span className="preview-line" style={{ width: `${width}%` }} />
              <span className="preview-line" style={{ width: `${width / 2}%`, height: 6, opacity: 0.7 }} />
            </span>
          </div>
        ))}

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <span className="preview-line" style={{ flex: '1 1 auto', height: 6 }} />
          <span className="tiny faint">2.6 s</span>
        </div>
      </div>

      <div
        className="preview-card"
        style={{ position: 'absolute', right: 8, bottom: -26, width: 210, animationDelay: '400ms' }}
      >
        <div className="row" style={{ gap: 9 }}>
          <span className="app-icon" style={{ background: categoryGradient('security'), width: 30, height: 30 }}>
            <IconCheck size={16} />
          </span>
          <span className="stack-sm" style={{ gap: 2 }}>
            <span className="strong small">Output ready</span>
            <span className="tiny faint">Downloads for 24 hours</span>
          </span>
        </div>
      </div>
    </div>
  );
}
