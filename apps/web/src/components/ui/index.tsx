import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { BadgeTone } from '../../lib/format';
import { IconInfo } from '../icons';

/**
 * UI primitives (`docs/0-FOLDER-STRUCTURE.md` §3, `components/ui/`).
 *
 * Hand-written rather than generated from a component library because the design is a handful of tokens in
 * `styles/globals.css`: a tool surface needs a button, a card, a field, and a status pill, and a dependency that
 * ships 40 components to use four is weight with no payoff.
 *
 * Everything here is presentation only. A primitive never fetches, never decides an error message, and never
 * knows a tool id.
 */

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  const classes = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Card({
  children,
  className,
  hover = false,
  as = 'section',
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  as?: 'section' | 'article' | 'div';
}) {
  const Tag = as;
  return (
    <Tag className={['card', hover ? 'card-hover' : '', className ?? ''].filter(Boolean).join(' ')}>{children}</Tag>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <div className="strong small">{title}</div> : null}
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />;
}

export function Skeleton({ height = 14, width = '100%' }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="stack-sm">
      <label className="small strong" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <span className="tiny muted">{hint}</span> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="textarea" {...props} />;
}

export function SelectInput({
  options,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string | number | boolean; label: string }>;
}) {
  return (
    <select className="select" {...rest}>
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function ToggleInput({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Set when a separate `<label htmlFor>` names this control — the placement rows do, so their field is reachable. */
  id?: string;
}) {
  return (
    <label className="row small" style={{ gap: 8 }}>
      <input
        id={id}
        type="checkbox"
        className="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * The margin the panel keeps from every edge of the window — the same 16 px its `max-width` reserves (`globals.css`),
 * and the same one the vertical clamp keeps from the top and the bottom.
 */
const PANEL_MARGIN_PX = 16;

/** The gap between the trigger and the panel, which `globals.css` anchors with `calc(100% + 8px)`; the vertical flip has
 * to reproduce it on the side the caller did not choose. */
const PANEL_GAP_PX = 8;

/**
 * The shortest a panel may be squeezed to before the clamp stops squeezing and slides it instead.
 *
 * Measured on the panel itself, at 1440 × 900: a 1 px border, 14 px of padding, a 20 px heading and the 10 px gap under
 * it are **45 px of chrome above the first fact**, and the first fact's row is 20 px plus the 5 px its list gaps it by —
 * 70 px of content, or a 72 px box once the borders are counted. Shorter than that and the panel is a scrollbar with
 * nothing above it: it would be a box that says nothing, drawn in place of a trigger that says everything.
 */
const PANEL_MIN_HEIGHT_PX = 72;

/** A computed length, for the borders an ancestor's clipping box is measured inside of. */
function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The box the panel is allowed to be **drawn** in: the window, less `PANEL_MARGIN_PX`, cut down by every ancestor that
 * clips its own overflow.
 *
 * The window is not the whole answer. The banner is the case that asked the question: it used to carry two blurred blobs
 * drawn outside its own box on purpose, so it clipped them — and the `ⓘ` panel hangs *below* its trigger, which for a
 * trigger at the foot of the banner means outside the banner. Measured at 1440 × 900 before that was fixed, the panel was
 * 340 × 176 at `574, 278` while the clip box ended at 296: the reader saw an 18 px strip of it, and four of the five hit
 * tests inside its own middle answered the page behind it. Nothing else looked wrong, because a clipped panel still has a
 * box, still has a size, and still passes a visibility check. That banner was fixed on both halves — its crop moved into
 * a box of its own (`tool-banner.tsx`), and this walk — but a box that clips is still not the window: measured at
 * 900 × 900, the studio's inspector is `overflow: auto` with 193 px of usable height and holds the panel's head 28 px
 * inside itself, where the panel's own anchor would place it above the column entirely.
 *
 * Two rules the walk follows, both because the browser does:
 *
 * - **A `fixed` ancestor is not clipped by the boxes above it**, so a panel inside one is not either. The full screen
 *   stage is exactly that case: with that mode on, the panel's chain is the bar, then a `position: fixed` stage that
 *   clips 1440 × 836 from `0, 64`, then the studio card — `overflow: hidden`, 1380 × 134 at 1440 × 900 — which is drawn
 *   *under* the stage and therefore cannot cut it. Measured, the region is 1408 × 820 with the rule and 1378 × 132
 *   without it, and the placement is the same either way only because a region 132 px tall cannot hold a 176 px panel
 *   and that axis then falls back to the window. The region is the answer to "where can this be seen", and a box that
 *   cannot clip the panel is not part of the answer.
 * - **The clip is the padding box**, which is why the borders come off the rect.
 *
 * The margin is a parameter because the same walk answers two questions: where the panel may be drawn (`PANEL_MARGIN_PX`,
 * the margin the panel's own `max-width` reserves) and whether the **trigger** is on the screen at all (0, since the 16 px
 * is a promise about the panel and not a condition on the trigger it belongs to).
 */
function visibleRegion(
  anchor: HTMLElement,
  margin = PANEL_MARGIN_PX,
): { left: number; top: number; right: number; bottom: number } {
  const root = document.documentElement;
  const region = {
    left: margin,
    top: margin,
    right: root.clientWidth - margin,
    bottom: root.clientHeight - margin,
  };
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    // `documentElement`'s box *is* the window, which the region already is.
    if (node === root) break;
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const box = node.getBoundingClientRect();
      region.left = Math.max(region.left, box.left + px(style.borderLeftWidth));
      region.right = Math.min(region.right, box.right - px(style.borderRightWidth));
      region.top = Math.max(region.top, box.top + px(style.borderTopWidth));
      region.bottom = Math.min(region.bottom, box.bottom - px(style.borderBottomWidth));
    }
    if (style.position === 'fixed') break;
  }
  return region;
}

/**
 * Facts about the current action, behind a `ⓘ` instead of in a card.
 *
 * The tool page used to spend a whole card above the submit button on output type, pool limits, plan ceilings and
 * retention. All four are worth reading *once*, before the first run, and none of them is worth a fifth of the
 * viewport on every visit — so they moved behind the affordance that means "there is more here", and the space they
 * held went to the thing the page is actually about.
 *
 * It is a button, not a hover target: a tooltip that only exists on hover does not exist on touch, and this is the
 * only way to reach the numbers on a phone. `aria-expanded` plus `aria-haspopup` is the same disclosure the browser's
 * own menus announce, and `Escape` returns focus to the trigger rather than dropping it into the page.
 */
export function InfoTip({
  label,
  children,
  align = 'end',
  side = 'below',
}: {
  /** The accessible name of the trigger — "What this run will do", not "info". */
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
  /**
   * Which way the panel opens. `above` is for a trigger at the foot of a column that scrolls
   * (`features/tool-shell/run-facts.tsx`): the panel is anchored to the trigger either way, and the only thing the
   * direction decides is which side has room — below a trigger at the bottom of a column is the scroll region's own
   * overflow, so the reader would have to scroll after opening the panel to read it. The default, `below`, is the other
   * end of the same question: a trigger riding the top edge of a box that clips its own overflow (the studio bar in full
   * screen) has its room underneath it and none above.
   */
  side?: 'below' | 'above';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDialogElement>(null);

  /**
   * Keep the panel on the screen, whatever edge of its trigger it was anchored to.
   *
   * The trigger's position is the caller's business and there are three of them now: in the banner's meta row, in the
   * middle of a hero, at the left edge of a column of a studio, and after the document chip of the studio bar. A panel
   * anchored by its trailing edge to a trigger 105 px from the left of a 390 px screen starts 199 px off it — measured,
   * and half the panel is a part of it the reader cannot reach (defect 257). So the box is measured before it is painted
   * (`useLayoutEffect`, so nothing is seen moving) and the anchor is rewritten to whatever keeps a 16 px margin on both
   * sides, which is the margin the panel's own `max-width` already reserves.
   *
   * The vertical half of the same question, and the reason this is a function rather than an effect body: a trigger near
   * the foot of the window has room above it and none below, and a panel anchored below it is a panel the reader has to
   * scroll the whole page — or, on a short window, cannot reach at all. `side` stays the caller's preference and is kept
   * whenever the panel fits that way, and the other side is used when it does not.
   *
   * **When neither side can hold the panel, its height is capped instead of its position being overridden**, down to
   * `PANEL_MIN_HEIGHT_PX`, with its content scrolling inside it. The old answer was to slide the panel into the region's
   * own margin, and that is a panel drawn **over the trigger that opened it** — measured at 1440 × 300, the bar's panel
   * at `108` with its trigger at `89 → 119`, and in the inspector's column at 900 × 900 the panel covering its trigger's
   * top 17 px. A disclosure that hides its own trigger is one the pointer can no longer close; a shorter one is read by
   * scrolling, which is what the reader was going to do with it anyway. Only a window too short for even one fact (below
   * 213 px for the bar's trigger) falls back to the slide, and that is the one case where the panel covers it.
   *
   * Both axes are measured against `visibleRegion` rather than against the window, and an axis on which that region
   * **cannot hold the panel at all** falls back to the window's own bounds: an ancestor too small to contain the panel
   * cannot rescue it by moving it, and the panel is left where the reader is already looking rather than dragged
   * somewhere it is clipped exactly the same.
   *
   * Measured in **layout** pixels, and that is defect 258: the panel opens with `pd-pop`, which scales it from 0.96, so a
   * box read through `getBoundingClientRect()` while that animation is still at its start is ~4 % narrow — a 340 px panel
   * measured as 326 leaves the correction 14 px short, and the panel then ends up 4 px from the window's edge rather than
   * the 16 the clamp promises (measured at 390 wide with a trigger anchored by its leading edge, which is the bar's).
   * `offsetWidth`/`offsetLeft` are the box the anchor and the window are being compared in, and `offsetHeight`/`offsetTop`
   * are the same pair turned on their side.
   */
  const place = useCallback(() => {
    const node = panel.current;
    const anchor = wrap.current;
    if (!node || !anchor) return;
    // The previous pass's correction is cleared first: it was computed for the panel's own content in a window that may
    // no longer exist, and measuring with it still applied would give a shifted box to correct from. That includes the
    // height cap, which is the one correction the panel is measured **through** — a capped panel's `offsetHeight` is the
    // cap and not the content, so every derivation has to start from the panel's own height.
    node.style.left = '';
    node.style.right = '';
    node.style.top = '';
    node.style.bottom = '';
    node.style.maxHeight = '';
    // The trigger's own box, which is where both offsets below are measured from (`position: relative` on `.infotip`).
    const anchorBox = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    // Where the stylesheet itself put the panel, given `side` and `align` — the position to correct only if it leaves.
    const naturalLeft = anchorBox.left + node.offsetLeft;
    const naturalTop = anchorBox.top + node.offsetTop;

    // The window's own box, and `clientWidth`/`clientHeight` rather than `innerWidth`/`innerHeight` because the latter
    // pair counts the strip a scrollbar takes: the panel has to fit in the part of the window a reader can see.
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    // …and the part of it that no ancestor clips away, which is the same box when nothing clips.
    const region = visibleRegion(anchor);

    const clampedLeft = Math.min(Math.max(naturalLeft, PANEL_MARGIN_PX), viewportWidth - PANEL_MARGIN_PX - width);
    const targetLeft =
      region.right - region.left >= width
        ? Math.min(Math.max(naturalLeft, region.left), region.right - width)
        : clampedLeft;
    if (Math.round(targetLeft) !== Math.round(naturalLeft)) {
      node.style.left = `${Math.round(targetLeft - anchorBox.left)}px`;
      node.style.right = 'auto';
    }

    const held = region.bottom - region.top >= height;
    const hung = (top: number) => held && top >= region.top && top + height <= region.bottom;
    const below = anchorBox.bottom + PANEL_GAP_PX;
    const above = anchorBox.top - PANEL_GAP_PX - height;
    const preferred = side === 'above' ? above : below;
    const alternate = side === 'above' ? below : above;
    // …and the same two sides asked how much room they have for a panel that is **shorter than it wants to be**. A panel
    // that does not fit its side is not a panel in the wrong place: it is the same panel with less to show, and the one
    // thing it must not do is move onto the trigger it belongs to.
    const roomBelow = region.bottom - below;
    const roomAbove = anchorBox.top - PANEL_GAP_PX - region.top;
    const shorter = (room: number) => Math.min(height, room);
    // A side is worth shortening for while the panel still says something on it — and the side below has one condition
    // more, because a trigger that sits above the region's own head would put the panel outside it rather than under
    // itself.
    const belowUsable = roomBelow >= PANEL_MIN_HEIGHT_PX && below >= region.top;
    const aboveUsable = roomAbove >= PANEL_MIN_HEIGHT_PX;
    let target: number;
    let capped = height;
    if (hung(preferred)) {
      // The caller's own direction, at the panel's own height: nothing to correct.
      target = preferred;
    } else if (hung(alternate)) {
      target = alternate;
    } else if (side === 'above' ? aboveUsable : belowUsable) {
      capped = side === 'above' ? shorter(roomAbove) : shorter(roomBelow);
      target = side === 'above' ? anchorBox.top - PANEL_GAP_PX - capped : below;
    } else if (side === 'above' ? belowUsable : aboveUsable) {
      // The caller's own side cannot hold even one fact, and the other one can: the direction moves rather than the
      // trigger being covered.
      capped = side === 'above' ? shorter(roomBelow) : shorter(roomAbove);
      target = side === 'above' ? below : anchorBox.top - PANEL_GAP_PX - capped;
    } else {
      // Neither side can hold a fact, so the panel keeps its own height and is slid inside the region — or inside the
      // window's own bounds when the region cannot hold it either — with `Math.max` on each clamp because a panel larger
      // than the box holding it has no such position, and its top edge is then the most of it a reader can reach.
      const slideTop = held ? region.top : PANEL_MARGIN_PX;
      const slideBottom = held ? region.bottom : viewportHeight - PANEL_MARGIN_PX;
      target = Math.min(Math.max(preferred, slideTop), Math.max(slideBottom - height, slideTop));
    }
    if (capped < height) node.style.maxHeight = `${Math.round(capped)}px`;
    if (Math.round(target) !== Math.round(naturalTop)) {
      node.style.top = `${Math.round(target - anchorBox.top)}px`;
      node.style.bottom = 'auto';
    }
  }, [side]);

  /**
   * The same placement, derived again because the geometry under it moved — and the moment to notice that a panel with no
   * trigger on the screen is not a disclosure any more.
   *
   * The panel is anchored in the DOM, so it follows its trigger when the page or a column scrolls; what goes stale is the
   * **correction**. Measured in the studio inspector's own column (a 340 × 648 box holding 1823 px of content): the
   * panel is placed inside the box at the open, at `595 → 771`, and scrolling the column 150 px puts it at `745 → 921` —
   * its foot 30 px through the box that clips it, four of five hit tests inside it answering the panel, with the trigger
   * itself 38 px below the box already. Another 150 px moves the trigger out of the box altogether and the panel with it.
   *
   * So a scroll of anything, a resize, and any ancestor's box changing size all run this, and the first thing it asks is
   * whether the trigger is still on the screen: a panel slid to the edge of a region whose trigger has left the reader's
   * view is a panel explaining something nobody can see, and closing it is the honest answer — the reader has scrolled
   * away from it. (The *initial* placement deliberately does not ask that question: the reader has just pressed the
   * trigger, so a panel at a trigger on the window's own edge is one they asked for.)
   */
  const rePlace = useCallback(() => {
    const anchor = wrap.current;
    if (!anchor) return;
    const seen = visibleRegion(anchor, 0);
    const box = anchor.getBoundingClientRect();
    const onScreen = box.left < seen.right && box.right > seen.left && box.top < seen.bottom && box.bottom > seen.top;
    if (!onScreen) {
      setOpen(false);
      return;
    }
    place();
  }, [place]);

  // Before paint, so an unclamped panel is never a frame the reader sees — and the same work again whenever the geometry
  // underneath an open panel changes, which the effect below listens for.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      //
      // **Consumed, not merely answered.** An open disclosure is the innermost thing on the screen, so the `Escape` that
      // closes it must not also be the page's own `Escape`: the placement canvas binds that key on `window` to let go of
      // a selected mark and then to leave full screen (`features/placement/index.tsx`), and its `ⓘ` now lives in the bar
      // that overlay is drawn from — so one press would have closed the panel *and* dropped the mark behind it. Captured,
      // so this runs on the way down the path rather than racing whatever is registered further up it.
      //
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    //
    // **Re-derived whenever the geometry under the panel changes**, and there are three ways that happens. The window is
    // one: the studio bar's `ⓘ` is 341 px from the left at 1440 and 182 px at 390, and the window's height decides whether
    // a panel opens over the fold or under it — without this the anchor decided at the open is kept for a window that no
    // longer exists (measured: a panel opened at 1440 ends its right edge at 522 of a 390 px screen once that window is
    // 390, which is 148 px past the margin the clamp keeps).
    //
    // A **scroll** is the second, and it is the one the clamp's own promise needs: the column that clips the panel is
    // also the thing the reader scrolls, and the trigger rides with the content, so a placement that was inside the box
    // can be 30 px through its edge a wheel turn later. Captured on `window` because a box's own scroll does not bubble,
    // and passive because the re-derivation never prevents anything.
    //
    // An **ancestor's box** is the third, without the window moving at all: a mark added or removed in the studio's one
    // column layout grows the inspector from 814 to 1034 px and the page from 2162 to 2382 (measured), which moves the
    // trigger the panel is anchored to. `ResizeObserver` on the trigger and every ancestor is what sees that — including
    // `body`, whose box is the page's own height, so content landing anywhere above the trigger counts.
    //
    // The third way overlaps the second, and the overlap is worth knowing rather than trusting: growing that column while
    // the page is scrolled past it also makes the browser emit a `scroll` of the **document** — scroll anchoring
    // re-placing content it had already measured, with `scrollY` unchanged at 1262 — which this same listener catches. So
    // a test that only asks "did the panel re-derive" cannot say which one did it. Measured on the served bundle with the
    // other listener taken out, it can: on a page that only duplicates a mark by keyboard, deleting the scroll listener
    // and leaving this observer in place still closes the panel (3/3 runs), and deleting **both** leaves it open (3/3),
    // so the box change carries a leg of its own rather than riding on a scroll that happens to arrive.
    //
    // Coalesced to one derivation per frame, because a wheel turn is dozens of events and each one would otherwise force
    // its own layout.
    //
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        rePlace();
      });
    };
    const observer = new ResizeObserver(schedule);
    for (let node: Element | null = wrap.current; node; node = node.parentElement) observer.observe(node);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
    };
  }, [open, rePlace]);

  return (
    <span className="infotip" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="infotip-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <IconInfo size={17} />
      </button>
      {open ? (
        //
        // A real `<dialog>`, `open` and **not** `showModal`: the element is the right one for "a panel of its own"
        // and brings the role with it, while a *modal* dialog would add the top layer, a backdrop and a focus trap to
        // a popover whose whole design is that it closes when you click anywhere else. `open` also means the browser
        // does not need to be asked twice — the state and the attribute cannot disagree (`open` is rendered from it).
        <dialog ref={panel} className="infotip-panel" open aria-label={label} data-align={align} data-side={side}>
          {children}
        </dialog>
      ) : null}
    </span>
  );
}

/**
 * The two-column list the info panel and the result comparison both use: a term on the left, its value on the right.
 *
 * Its own component because the two places that show facts about a job must not drift into two visual languages — the
 * retention deadline is the same sentence whichever panel quotes it.
 */
export function FactList({ facts }: { facts: Array<[string, ReactNode]> }) {
  return (
    <dl className="facts">
      {facts.map(([term, detail]) => (
        <div key={term} className="facts-row">
          <dt className="small muted">{term}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="stack-sm" style={{ padding: '28px 18px', textAlign: 'center', alignItems: 'center' }}>
      <div className="strong">{title}</div>
      {description ? (
        <div className="small muted" style={{ maxWidth: 460 }}>
          {description}
        </div>
      ) : null}
      {action}
    </div>
  );
}
