import { useMemo, useState } from 'react';
import { IconCheck, IconReturn, IconX, IconZoom } from '../../components/icons';
import { Alert } from '../../components/ui';
import { PageLightbox, PagePreview } from '../preview';
import { type BoardRow, DocumentRow, Dropzone } from '../uploader';
import { type PagePlan, describePages, resolvedPagesNote } from './plan';

/**
 * The plan, drawn: which pages of this document go into which file
 * (`docs/0-UI-DESIGN.md` §3.2, `docs/02-SPLIT-AND-EXTRACT.md`).
 *
 * This is the preview that replaced a list of filenames for every tool that takes **one** document and decides pages
 * from it. A merge is a picture of the inputs, because the inputs are the product; a split is a picture of the
 * *outputs*, because the product is a decision about pages — and for that, "here is your document" is the one answer
 * nobody needed. The plan's arithmetic is `./plan.ts` (a pure, tested module); this file only draws it.
 *
 * Three things it deliberately does:
 *
 *  - **It draws the outputs, one section each**, with the pages in them. On an eight-page document split into two
 *    ranges, that is `File 1 · 1–5` and `File 2 · 6–8`, which is the question the job's zip answers three seconds
 *    later.
 *  - **It names what no file gets.** A range list does not have to cover the document, and the pages it leaves out are
 *    exactly what a person does not notice until they open the output. They are one line under the groups.
 *  - **It says what it cannot know.** `by-size` and `by-bookmarks` are decided inside the job from the file's own
 *    weight and outline, so the preview shows the whole document plus the sentence explaining why it cannot be sharper.
 *    The alternative — drawing a guess — is a preview that disagrees with the job.
 *
 * Nothing here renders a page through an engine: the tiles come from the same `pdf.js` module as the file board
 * (`features/preview/`), which is a render that never leaves the browser and never becomes a job (`0-UI-DESIGN.md` §6).
 */

/** How many pages one group draws before it stops and offers the rest. */
const PAGES_PER_GROUP = 12;

function plural(count: number): string {
  return `${count} page${count === 1 ? '' : 's'}`;
}

/**
 * One side of a document that is being parted in two: the pages the output keeps, or the pages it drops.
 *
 * The two halves are what make a page clickable without ambiguity. A tile in this grid is **always** a page that is
 * currently on that side, so clicking it can only mean one thing — it changes sides — and that is true for both tools
 * even though they spell the same page list in opposite directions (`delete-pages` names the pages that go,
 * `extract-pages` in `include` mode names the pages that stay). Nothing here has to know which of those it is drawing:
 * the page moves, the value changes, and the option's own sentence says what the value means.
 *
 * Two actions live on a tile and they are deliberately not the same gesture: **the tile moves the page** (and says so,
 * in the accessible name and on hover), and a labelled magnifier in its corner opens the page larger. A click that
 * silently did one of those, on a page whose number is the only thing identifying it, is how a preview deletes a page
 * somebody only wanted to look at.
 */
function PlanHalf({
  side,
  pages,
  file,
  total,
  onMove,
  onOpen,
}: {
  side: 'kept' | 'removed';
  pages: number[];
  file: File | null;
  total: number | null;
  /** Absent on every tool that does not part the document in two — the tiles then only open the lightbox. */
  onMove?: (page: number) => void;
  onOpen: (page: number) => void;
}) {
  const kept = side === 'kept';
  const shown = pages.slice(0, PAGES_PER_GROUP);
  const rest = pages.length - shown.length;

  return (
    <section className="plan-half" data-side={side}>
      <header className="plan-half-head">
        <span className="plan-half-badge">
          {kept ? <IconCheck size={12} /> : <IconX size={12} />}
          {kept ? 'Kept' : 'Removed'}
        </span>
        <span className="tiny faint">
          {pages.length === 0 ? (kept ? 'no page' : 'None — every page stays in the output.') : plural(pages.length)}
        </span>
      </header>

      {shown.length > 0 ? (
        <ul className="plan-pages">
          {shown.map((page) => (
            <li className="plan-cell" key={page}>
              <button
                type="button"
                className="plan-page"
                data-move={onMove ? side : undefined}
                aria-label={
                  onMove
                    ? kept
                      ? `Remove page ${page} from the output`
                      : `Keep page ${page} in the output`
                    : `Preview page ${page}`
                }
                title={onMove ? (kept ? 'Remove this page' : 'Keep this page') : undefined}
                onClick={() => (onMove ? onMove(page) : onOpen(page))}
              >
                <PagePreview
                  file={file}
                  page={page}
                  box={{ width: 176, height: 228 }}
                  alt={total != null ? `Page ${page} of ${total}` : `Page ${page}`}
                />
                <span className="plan-page-no">{page}</span>
                {onMove ? (
                  <span className="plan-page-action" aria-hidden="true">
                    {kept ? <IconX size={13} /> : <IconReturn size={13} />}
                  </span>
                ) : null}
              </button>

              {/* Only drawn where a click already means something else — see the note on this component. */}
              {onMove ? (
                <button
                  type="button"
                  className="plan-zoom"
                  aria-label={`Look at page ${page} closer`}
                  title="Look closer"
                  onClick={() => onOpen(page)}
                >
                  <IconZoom size={13} />
                </button>
              ) : null}
            </li>
          ))}
          {rest > 0 ? (
            <li className="plan-cell">
              <button
                type="button"
                className="plan-page plan-page-more"
                aria-label={`Preview the remaining ${rest} pages`}
                onClick={() => onOpen(shown[shown.length - 1]! + 1)}
              >
                <span className="small strong">+{rest}</span>
                <span className="tiny faint">more</span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="tiny faint">
          {kept
            ? 'These pages appear once the range can be resolved — `1-z` and `even` need the document’s page count.'
            : 'Nothing is removed yet — click a page on the left, or name the pages in the options.'}
        </p>
      )}
    </section>
  );
}

export function PagePlanPreview({
  rows,
  plan,
  label,
  accept,
  multiple,
  disabled,
  hint,
  onFiles,
  onRemove,
  onRetry,
  onMovePage,
}: {
  rows: BoardRow[];
  plan: PagePlan;
  /** The catalogue's own label for the selection (`Pages to keep`), so the page adds no copy of its own. */
  label: string;
  accept: string;
  multiple: boolean;
  disabled?: boolean;
  hint?: string;
  onFiles: (files: FileList | File[]) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  /**
   * A page clicked in the preview, moved to the other half. Passed only by the tools whose plan has two halves
   * (`PagePlan.halves`), because a page tile in a split's output or a rotate's document does not have a side to change.
   */
  onMovePage?: (page: number) => void;
}) {
  const [openPage, setOpenPage] = useState<number | null>(null);
  const row = rows[0] ?? null;
  // The pages the options actually act on, for the one shape where the output is the whole document: on `rotate`, page
  // 3 of a five-page preview is either one of the pages being turned or one that is being left alone, and the difference
  // matters more than the page's own contents.
  const selected = useMemo(() => new Set(plan.selected), [plan.selected]);

  if (!row) {
    return <Dropzone onFiles={onFiles} accept={accept} multiple={multiple} disabled={disabled} hint={hint} />;
  }

  return (
    <div className="stack">
      {/* The document itself — shared with the order board, which draws the same row about the same file. */}
      <DocumentRow row={row} onRemove={onRemove} onRetry={onRetry} onPreview={() => setOpenPage(1)} />

      <div className="row-between wrap" style={{ gap: 8 }}>
        <span className="label">{label}</span>
        <span className="tiny faint">
          {plan.halves
            ? // A two-sided plan counts both sides rather than naming one: `Kept 6 · Removed 6` is the same fact the
              // option's own sentence states, said where the pages are, and a reader who has just clicked a page needs
              // to see both numbers move — not one number and a list of what is left out.
              `Kept ${plan.halves.kept.length} · Removed ${plan.halves.removed.length}`
            : plan.groups.length > 1
              ? `${plan.groups.length} files`
              : plan.groups[0]?.pages.length
                ? plural(plan.groups[0].pages.length)
                : 'nothing selected yet'}
          {!plan.halves && plan.remaining.length > 0 ? ` · ${describePages(plan.remaining)} left out` : ''}
        </span>
      </div>

      {/*
       * Two sides, when the plan has two: the pages the output keeps and the pages it drops, side by side, with the
       * halves drawn from `plan.halves` rather than from the group — for these tools the group *is* the kept half, and
       * a preview that showed only it would be showing the result without showing the decision.
       */}
      {plan.halves ? (
        <div className="plan-halves">
          <PlanHalf
            side="kept"
            pages={plan.halves.kept}
            file={row.sourceFile}
            total={row.pages}
            onMove={onMovePage}
            onOpen={setOpenPage}
          />
          <PlanHalf
            side="removed"
            pages={plan.halves.removed}
            file={row.sourceFile}
            total={row.pages}
            onMove={onMovePage}
            onOpen={setOpenPage}
          />
        </div>
      ) : null}

      {plan.halves
        ? null
        : plan.groups.map((group, index) => {
            const shown = group.pages.slice(0, PAGES_PER_GROUP);
            const rest = group.pages.length - shown.length;
            return (
              <section className="plan-group" key={`${group.label}-${index}`}>
                <header className="plan-group-head">
                  <span className="plan-group-badge">{plan.groups.length > 1 ? `File ${index + 1}` : 'Output'}</span>
                  <span className="small strong truncate">{group.label}</span>
                  {/*
                   * The resolved pages, and only when that is news: for a literal range the label already says it, and the
                   * header would read `Output · 1-3 · 1–3` (`resolvedPagesNote` in `./plan.ts`). `pages unknown` still shows,
                   * because it is about a group that exists without a page list.
                   */}
                  <span className="tiny faint">
                    {group.pages.length > 0 ? resolvedPagesNote(group.label, group.pages) : 'pages unknown'}
                  </span>
                </header>

                {shown.length > 0 ? (
                  <ul className="plan-pages">
                    {shown.map((page) => (
                      <li key={page}>
                        <button
                          type="button"
                          className="plan-page"
                          data-muted={selected.size > 0 && !selected.has(page)}
                          aria-label={`Preview page ${page}`}
                          onClick={() => setOpenPage(page)}
                        >
                          <PagePreview
                            file={row.sourceFile}
                            page={page}
                            box={{ width: 176, height: 228 }}
                            alt={`Page ${page} of ${row.name}`}
                          />
                          <span className="plan-page-no">{page}</span>
                        </button>
                      </li>
                    ))}
                    {rest > 0 ? (
                      <li>
                        <button
                          type="button"
                          className="plan-page plan-page-more"
                          aria-label={`Preview the remaining ${rest} pages`}
                          onClick={() => setOpenPage(shown[shown.length - 1]! + 1)}
                        >
                          <span className="small strong">+{rest}</span>
                          <span className="tiny faint">more</span>
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="tiny faint">
                    These pages appear once the range can be resolved — `1-z` and `even` need the document’s page count.
                  </p>
                )}
              </section>
            );
          })}

      {/*
       * The title names the *selection* rather than a range: this alert is shared by the rows control (`split`, where
       * the mistake is always a range) and by the page boxes (`extract-pages`, where the mistake is a page the
       * document does not have), and the sentence inside is the refusal's own wording either way.
       */}
      {plan.error ? (
        <Alert tone="warning" title="This selection needs attention">
          <span className="small">{plan.error}</span>
        </Alert>
      ) : null}

      {plan.note ? <p className="tiny faint">{plan.note}</p> : null}

      {row.sourceFile && openPage != null ? (
        <PageLightbox
          file={row.sourceFile}
          name={row.name}
          page={openPage}
          pages={row.pages}
          onPage={(page) => setOpenPage(page)}
          onClose={() => setOpenPage(null)}
        />
      ) : null}
    </div>
  );
}
