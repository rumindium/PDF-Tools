import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { IconChevronRight, IconExternal, IconFileText } from '../../components/icons';
import { type PreviewBox, documentPageCount, pagePreview, pageStrip, peekPagePreview, previewKind } from './render';
import { frameFor } from './step';

/** The page set a tile offers, from whatever count the caller has. Re-exported so the board needs one import. */
export { pageStrip };

/**
 * The preview surfaces: a page thumbnail that can stand inside a tile, and the lightbox it opens
 * (`0-UI-DESIGN.md` §3.2, §6).
 *
 * The board used to list files by name and describe the merge with a bar of coloured slices. Both are true and
 * neither is what a person checks before merging: *is this the right document, and is it the right way up?* A list of
 * names cannot answer that, so the file is drawn — its first page, from its own bytes, in the position it will occupy.
 *
 * Two rules keep this from becoming the reason a page is slow:
 *
 *  - **Nothing renders until it is on screen.** Every thumbnail starts with an `IntersectionObserver` and only asks
 *    for a render once the tile is near the viewport, so a fifty-file merge draws the four or five tiles a person is
 *    actually looking at.
 *  - **Nothing renders twice.** `render.ts` caches per `File`, so scrolling away and back, reordering, or opening the
 *    lightbox on a page already drawn costs one lookup.
 */

/** Whether a node is near the viewport — `300px` of margin, so a scroll never lands on a blank tile. */
function useInView<T extends Element>(rootMargin = '300px'): { ref: (node: T | null) => void; inView: boolean } {
  const [node, setNode] = useState<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!node || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (an old browser, or a test environment): draw it rather than leave a permanent skeleton. A
      // preview that never arrives is a worse failure than one drawn slightly early.
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, inView, rootMargin]);

  return { ref: useCallback((next: T | null) => setNode(next), []), inView };
}

/** The state a thumbnail is in, which is three states and not two: pending is drawn as a skeleton, never as a blank. */
export interface PagePreviewState {
  url: string | null;
  error: string | null;
  loading: boolean;
}

/**
 * One page of one file, rendered on demand.
 *
 * `file` is `null` while a thumbnail is off screen, which is how "do not render yet" is expressed — and it is also why
 * this hook is safe to call unconditionally from a component that may not render at all.
 */
export function usePagePreview(file: File | null, page: number, box: PreviewBox): PagePreviewState {
  const [state, setState] = useState<PagePreviewState>({ url: null, error: null, loading: false });
  // The box is reduced to its two numbers here rather than depended on by identity: a caller writing `box={{…}}`
  // inline would otherwise re-render every page on every parent render.
  const { width, height } = box;
  //
  // The file the frame on screen was drawn from. It is what distinguishes the two reasons `url` has to change — a
  // **different page of the same document** (keep the old frame up, it is the same paper) from a **different
  // document** (the old frame is a lie and must go). Held in a ref because it is the answer to a question the effect
  // asks while deciding, not something the render reads. The rule itself is `step.ts`, where it is a pure function.
  const shown = useRef<File | null>(null);

  useEffect(() => {
    if (!file) {
      shown.current = null;
      setState({ url: null, error: null, loading: false });
      return;
    }

    const target = { file, page, box: { width, height } };
    // Already drawn? Then there is nothing to wait for, and no loading frame to render: this is the common case on a
    // second visit to a page, on a reorder, and on every step back through a document that was paged through once.
    const cached = peekPagePreview(target);
    const previous = shown.current;
    shown.current = file;
    setState((current) => frameFor({ current: current.url, file, shownFile: previous, cached }));
    if (cached) return;

    let cancelled = false;
    pagePreview(target).then(
      (url) => {
        if (!cancelled) setState({ url, error: null, loading: false });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({ url: null, error: cause instanceof Error ? cause.message : String(cause), loading: false });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file, page, width, height]);

  return state;
}

/**
 * A page, drawn. Falls back to a glyph rather than an empty frame.
 *
 * The fallback matters more than it looks: an office document has no pages to draw *before* it is converted, and a
 * blank rectangle where a document should be reads as a bug. A file glyph and the file's name in the alt text is the
 * honest answer to "what is this tile?" for the one class of input this cannot draw.
 */
export function PagePreview({
  file,
  page = 1,
  box,
  alt,
  empty,
}: {
  file: File | null;
  page?: number;
  box: PreviewBox;
  /** The accessible name — the file's name and what is being shown, not "preview". */
  alt: string;
  /** What to draw when there is nothing to render (a non-page input). */
  empty?: ReactNode;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const couldDraw = file != null && previewKind(file) !== 'other';
  const state = usePagePreview(couldDraw && inView ? file : null, page, box);

  return (
    <span
      className="page-shot"
      ref={ref}
      data-state={state.url ? 'ready' : state.error ? 'error' : 'loading'}
      // Busy is the *only* state that needs a loader rather than a skeleton: a frame is up, it belongs to this
      // document, and it is about to be replaced.
      data-busy={state.loading && state.url ? 'true' : 'false'}
      aria-busy={state.loading}
    >
      {state.url ? <img src={state.url} alt={alt} draggable={false} /> : null}
      {!state.url && !state.error ? <span className="page-shot-skeleton" aria-hidden="true" /> : null}
      {state.loading && state.url ? (
        <span className="page-shot-busy" aria-hidden="true">
          <span className="spinner" />
        </span>
      ) : null}
      {state.error || !couldDraw ? (
        <span className="page-shot-empty" aria-hidden="true">
          {empty ?? <IconFileText size={22} />}
        </span>
      ) : null}
    </span>
  );
}

/** Page chips for a tile: the way into the lightbox at a specific page, and a count worth reading. */
export function PageChips({
  pages,
  more,
  total,
  onOpen,
}: {
  pages: number[];
  more: number;
  total: number | null;
  onOpen: (page: number) => void;
}) {
  if (total == null || total < 1) return null;
  return (
    <span className="page-chips">
      {pages.map((page) => (
        <button
          key={page}
          type="button"
          className="page-chip"
          onClick={() => onOpen(page)}
          aria-label={`Preview page ${page}`}
        >
          {page}
        </button>
      ))}
      {more > 0 ? (
        <button
          type="button"
          className="page-chip page-chip-more"
          onClick={() => onOpen(pages[pages.length - 1]! + 1)}
          aria-label={`Preview the remaining ${more} pages`}
        >
          +{more}
        </button>
      ) : null}
    </span>
  );
}

/**
 * The lightbox: one page of one input, large enough to read.
 *
 * Deliberately *not* an `<iframe>` on the file's URL. The preview has to work before a job exists — that is the whole
 * point of previewing inputs — and the only URL an uploaded file has is behind the session; an iframe would also be
 * governed by the production `frame-ancestors 'none'`, so a viewer that worked in dev would be a blank panel in
 * production. Drawing the page from the same bytes the browser already holds has neither problem.
 *
 * The panel is a real `<dialog open>` — the same element the `ⓘ` popover uses, and for the same reason: it is the
 * element for "a surface of its own", and the browser brings the role with it rather than a hand-written
 * `role="dialog"` that a linter (rightly) asks to be this element instead. It is opened with `open` and **not**
 * `showModal()`: this one is not a form that must be answered before anything else, and the modal top layer would
 * bring a `::backdrop` and a UA border to restyle around the app's own scrim for no behaviour the scrim, the locked
 * page scroll and `Escape` do not already give.
 *
 * Focus moves into the panel, `Escape` closes it, and the arrow keys step pages, because a page-stepper that cannot
 * be driven from the keyboard is a page-stepper for a mouse.
 */
export function PageLightbox({
  file,
  name,
  page,
  pages,
  onPage,
  onClose,
}: {
  file: File;
  name: string;
  page: number;
  /** The count from the API's probe, or `null`; the lightbox asks the document itself when it is `null`. */
  pages: number | null;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [count, setCount] = useState<number | null>(pages);

  useEffect(() => setCount(pages), [pages]);

  // A count the probe did not give (an office document, a probe that failed) is worth asking the file for: the
  // counter is the only thing on this screen that says how much document there is.
  useEffect(() => {
    if (pages != null && pages > 0) return;
    let cancelled = false;
    void documentPageCount(file).then((total) => {
      if (!cancelled && total != null) setCount(total);
    });
    return () => {
      cancelled = true;
    };
  }, [file, pages]);

  useEffect(() => {
    panel.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      onPage(page + (event.key === 'ArrowRight' ? 1 : -1));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [page, onPage, onClose]);

  const total = count ?? null;
  const atStart = page <= 1;
  const atEnd = total != null ? page >= total : false;

  return (
    <div className="lightbox">
      {/*
        The scrim is a real `<button>`: clicking it closes the preview, and a `<div>` with an `onClick` is a control
        that only exists for a mouse. It is the panel's sibling rather than its parent, so a click inside the panel
        never reaches it and the panel needs no `stopPropagation` of its own.
      */}
      <button type="button" className="lightbox-backdrop" aria-label="Close preview" onClick={onClose} />
      <dialog
        className="lightbox-panel"
        open
        aria-label={`${name} — page ${page}${total != null ? ` of ${total}` : ''}`}
        tabIndex={-1}
        ref={panel}
      >
        <div className="lightbox-head">
          <span className="stack-sm" style={{ gap: 1, minWidth: 0 }}>
            <span className="small strong truncate" title={name}>
              {name}
            </span>
            <span className="tiny faint">
              Page {page}
              {total != null ? ` of ${total}` : ''}
            </span>
          </span>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Previous page"
              disabled={atStart}
              onClick={() => onPage(page - 1)}
            >
              {/* The icon primitive takes a size and a stroke, not a style: a mirrored chevron is a wrapper here. */}
              <span className="flip-x">
                <IconChevronRight size={16} />
              </span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Next page"
              disabled={atEnd}
              onClick={() => onPage(page + 1)}
            >
              <IconChevronRight size={16} />
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="lightbox-body">
          <PagePreview file={file} page={page} box={{ width: 900, height: 1150 }} alt={`${name}, page ${page}`} />
        </div>

        {previewKind(file) !== 'pdf' ? null : (
          <span className="tiny faint lightbox-foot">
            <IconExternal size={13} /> Arrow keys step through the pages · Esc closes
          </span>
        )}
      </dialog>
    </div>
  );
}
