import type { CSSProperties, ReactNode } from 'react';
import { IconCheck, IconSparkles } from '../../components/icons';
import { categoryLabel, toolIcon } from '../../components/layout/nav';
import { categoryGradient } from '../../components/tool-card';

/**
 * The tool page's banner (`docs/0-UI-DESIGN.md` §3.2).
 *
 * A tool page used to open with a plain heading and a line of copy, which is honest and reads as a form. This is the
 * same facts, dressed as the landing's hero: the gradient wash, the drifting blobs, the tool's own glyph in a tinted
 * tile, and the heading at a **medium** size — smaller than the landing's `clamp(30px, 4.2vw, 46px)`, because here it
 * is a title above a form rather than an invitation, and the files under it are what the person came for.
 *
 * What the banner says is bounded, and it is the same three promises the landing makes, in the tool's own terms: how
 * many documents go in, that the upload is deleted, and that the job runs isolated. The accept-list is deliberately
 * **not** among them — the title already says *PDF* for every tool that takes one, and the card under the banner
 * prints the extensions and the size ceiling in full.
 *
 * The illustration is drawn, not shipped, and it says the shape of the tool: a tool that takes several files shows
 * sheets converging into one page, a tool that takes one shows a single sheet. It animates on `transform`/`opacity`
 * only, and stops entirely for a reader whose system asks for reduced motion.
 *
 * `tool.title` is split so the last word carries the gradient. The heading is still one `<h1>` with the whole title in
 * it — a screen reader reads "Merge PDF", not "Merge" and "PDF".
 */
export function ToolBanner({
  tool,
  aside,
}: {
  tool: { id: string; title: string; summary: string; category: string; input: { maxFiles: number } };
  /** The `ⓘ` facts, drawn beside the banner's own facts. */
  aside?: ReactNode;
}) {
  const Glyph = toolIcon(tool.id, tool.category);
  const words = tool.title.split(' ');
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const head = words.length > 1 ? words.slice(0, -1).join(' ') : tool.title;
  const multi = tool.input.maxFiles > 1;
  //
  // One tool draws something else, and it is the one whose job the merge picture gets **wrong**: sheets converging into
  // one page is exactly what `reorder-pages` does *not* do — the same sheets come back out, in a different order. A
  // banner that illustrates the opposite of the tool is worse than a generic one, so the illustration is chosen by tool
  // rather than by input shape, and the shape is what the other thirty-two keep using.
  //
  const reorders = tool.id === 'reorder-pages';

  return (
    <section className="hero tool-hero anim-up">
      {/*
        The two blobs are drawn outside the banner's own box on purpose — they are the glow behind its corners — so
        something has to crop them. It used to be the banner itself (`overflow: hidden` on `.hero`), which cropped the
        `ⓘ` panel too: the panel hangs **below** its trigger, the trigger is at the foot of the banner, and measured at
        1440 × 900 the panel was 340 × 176 at `574, 278` inside a box that ends at 296 — the reader saw an 18 px strip of
        it, and five hit tests in its middle answered the page behind it (defect 259). The crop lives in a box that holds
        nothing else, and the banner stops clipping what is drawn out of it.
      */}
      <span className="hero-glow" aria-hidden="true">
        <span className="hero-blob hero-blob-a drift" />
        <span className="hero-blob hero-blob-b drift" style={{ animationDelay: '-6s' }} />
      </span>

      <div className="tool-hero-inner">
        <span className="tool-hero-icon" style={{ background: categoryGradient(tool.category) }} aria-hidden="true">
          <Glyph size={23} />
        </span>

        <div className="tool-hero-copy">
          <span className="pill">
            <IconSparkles size={13} />
            {categoryLabel(tool.category)}
          </span>
          <h1 className="tool-hero-title">
            {head}
            {last ? (
              <>
                {' '}
                <span className="grad-text">{last}</span>
              </>
            ) : null}
          </h1>
          <p className="muted tool-hero-summary">{tool.summary}</p>{' '}
          {/*
            The facts and the `ⓘ` share one row rather than stacking, because they answer sibling questions (what goes
            in, what the run costs) and a lone cluster of buttons on its own line under two lines of text reads as a
            third thing.
          */}
          <div className="tool-hero-meta">
            {' '}
            <ul className="hero-facts tool-hero-facts">
              <li>
                <IconCheck size={13} />
                {multi ? `Merges up to ${tool.input.maxFiles} files into one` : 'One document per run'}
              </li>
              <li>
                <IconCheck size={13} />
                Deleted when the job ends
              </li>
              <li>
                <IconCheck size={13} />
                Jobs run isolated
              </li>
            </ul>
            {aside}
          </div>
        </div>

        {reorders ? <OrderArt /> : <ToolBannerArt multi={multi} />}
      </div>
    </section>
  );
}

/**
 * The banner's illustration: sheets sliding into one page.
 *
 * Deliberately a picture of *this* tool's job rather than a generic document glyph — the page is about to ask for
 * files, and the picture is the sentence "several go in, one comes out" for exactly the tools where that is true.
 * Three sheets is the whole visual vocabulary; a fourth would be noise, and a tools' own file ceiling is an integer
 * nothing is going to count in an illustration.
 */
function ToolBannerArt({ multi }: { multi: boolean }) {
  return (
    <div className="merge-art" data-multi={multi} aria-hidden="true">
      <div className="merge-art-stack">
        {['a', 'b', 'c'].map((key, index) => (
          <span key={key} className="merge-art-sheet" style={{ '--d': `${index * 260}ms` } as CSSProperties} />
        ))}
      </div>
      <span className="merge-art-link" />
      <span className="merge-art-out" />
    </div>
  );
}

/**
 * The reorder illustration: three numbered sheets and one of them stepping to the end.
 *
 * It is the merge picture's opposite and has to be readable as such in a glance — the same three sheets come out as went
 * in, which is why there is no second stack and no output page here. The mover carries the accent and is lifted while it
 * travels, so "this one is the page being moved" reads even in a screenshot; the other two step along with it, because a
 * page that moves is a page that changes the order of everything else.
 *
 * Drawn, not shipped, and animated on `transform`/`opacity` only — and it stops entirely for a reader whose system asks
 * for reduced motion (`0-UI-DESIGN.md` §6).
 */
function OrderArt() {
  return (
    <div className="order-art" aria-hidden="true">
      {[0, 1, 2].map((slot) => (
        <span key={slot} className="order-art-sheet" data-slot={slot}>
          <span className="order-art-no">{slot + 1}</span>
        </span>
      ))}
    </div>
  );
}
