import type { ReactNode } from 'react';

/**
 * The icon set, as inline SVG — one dependency not taken.
 *
 * Every icon in this app is a 24×24 stroked glyph on `currentColor`, which is four lines of SVG and one shared
 * wrapper. The alternative (an icon package) would mean shipping a few thousand glyphs to use thirty, a bundle
 * decision made by a transitive dependency, and an upgrade path where a redraw of `Lock` silently changes how this
 * app looks. This file is the whole set, so a size or a stroke weight is one edit for all of them.
 *
 * Icons are `aria-hidden` and take their meaning from the text beside them: an icon that is the only label is a
 * glyph with no accessible name, which is how a list of tools becomes a list of shapes to a screen reader.
 */

type IconProps = {
  size?: number;
  strokeWidth?: number;
};

function Svg({ size = 18, strokeWidth = 1.8, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      {children}
    </svg>
  );
}

/* ── Navigation ─────────────────────────────────────────────────────────── */

export function IconHome(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.4 2" />
    </Svg>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19a9 9 0 1 1 16 0" />
      <path d="M12 15.5 16.5 9" />
      <circle cx="12" cy="17" r="1.6" />
    </Svg>
  );
}

export function IconTag(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 13.2 12.8 20.4a2 2 0 0 1-2.8 0l-6.4-6.4a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7.6a2 2 0 0 1 1.4.6l6 6a2 2 0 0 1 0 2.8Z" />
      <circle cx="8" cy="8" r="1.4" />
    </Svg>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </Svg>
  );
}

/** The same arrow the other way — "move this one earlier", which on a page board is toward page 1. */
export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Svg>
  );
}

/* ── Categories ─────────────────────────────────────────────────────────── */

export function IconLayers(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m4 12.5 8 4.3 8-4.3" />
      <path d="m4 16.8 8 4.2 8-4.2" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 0 0-13.7-5.2L3.5 8.5" />
      <path d="M3.5 4v4.5H8" />
      <path d="M4 13a8 8 0 0 0 13.7 5.2l2.8-2.7" />
      <path d="M20.5 20v-4.5H16" />
    </Svg>
  );
}

export function IconZap(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 2.5 5 13.2h6l-1.5 8.3L18.5 10h-6l1-7.5Z" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="10.5" width="16" height="10" rx="2.4" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 14.5v2.5" />
    </Svg>
  );
}

export function IconPen(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20.5h4l10.5-10.5a2.6 2.6 0 0 0-3.7-3.7L4 16.8v3.7Z" />
      <path d="m13.8 7.5 2.7 2.7" />
    </Svg>
  );
}

export function IconFileText(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Svg>
  );
}

export function IconScan(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 12h8" />
    </Svg>
  );
}

/* ── Landing ────────────────────────────────────────────────────────────── */

export function IconSparkles(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9 12 3.5Z" />
      <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
    </Svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20.5c0-3.9 3.4-6.3 7.5-6.3s7.5 2.4 7.5 6.3" />
    </Svg>
  );
}

/* ── Tools ──────────────────────────────────────────────────────────────── */

/**
 * One glyph per tool, so a tool has a face wherever it appears.
 *
 * The category icons above are the fallback, not the answer: eight tools under one heading all wearing the same
 * layers glyph is a column of identical shapes, which is decoration pretending to be navigation. These are small on
 * purpose — they are read at 14–19 px in a list whose labels carry the meaning — and each one names an **operation**
 * (merge, crop, stamp, unlock) rather than a file type, because forty formats cannot be drawn and the label is
 * already saying which way the conversion goes.
 *
 * `toolIcon()` in `components/layout/nav.ts` is the map, and its fallback is the category icon — a tool added to
 * `packages/contracts/tools/catalog.ts` tomorrow appears with a sensible glyph and no edit here.
 */

export function IconMerge(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5.5h4.5L11 12" />
      <path d="M3 18.5h4.5L11 12" />
      <path d="M11 12h2.5" />
      <rect x="13.5" y="7" width="7.5" height="10" rx="2" />
    </Svg>
  );
}

export function IconSplit(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="7.5" height="10" rx="2" />
      <path d="M10.5 12h2" />
      <path d="M12.5 12 17 6.6h4" />
      <path d="M12.5 12 17 17.4h4" />
    </Svg>
  );
}

export function IconPageExtract(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V11.5" />
      <path d="M15.5 3H21v5.5" />
      <path d="M21 3l-8.5 8.5" />
    </Svg>
  );
}

export function IconPageRemove(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="m9.5 12.5 5 5M14.5 12.5l-5 5" />
    </Svg>
  );
}

export function IconReorder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5h9M3.5 12h9M3.5 17.5h9" />
      <path d="M18.5 5.5v13" />
      <path d="m16 8 2.5-2.5L21 8" />
      <path d="m16 16 2.5 2.5L21 16" />
    </Svg>
  );
}

export function IconRotate(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-3.4-6.5" />
      <path d="M20.5 3.5v5h-5" />
    </Svg>
  );
}

export function IconCrop(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 2.5v15a2 2 0 0 0 2 2h13" />
      <path d="M2.5 6.5h15a2 2 0 0 1 2 2v13" />
    </Svg>
  );
}

export function IconImage(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <circle cx="8.6" cy="9.6" r="1.4" />
      <path d="m4.5 17.5 4.5-4.5 3 3" />
      <path d="m12 14 2.5-2.5 5 5" />
    </Svg>
  );
}

export function IconImageExport(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="8" width="12" height="12" rx="2.4" />
      <path d="m4.8 18 3.2-3.2L11 18" />
      <path d="M17.5 14V4.5" />
      <path d="m14.5 7.5 3-3 3 3" />
    </Svg>
  );
}

export function IconType(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5V4.5h15v2" />
      <path d="M12 4.5v15" />
      <path d="M8.5 19.5h7" />
    </Svg>
  );
}

export function IconCode(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 7.5-4.5 4.5L9 16.5" />
      <path d="m15 7.5 4.5 4.5L15 16.5" />
      <path d="m13.4 5.5-2.8 13" />
    </Svg>
  );
}

export function IconTable(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <path d="M3.5 9.5h17M3.5 14.5h17M10 9.5v10" />
    </Svg>
  );
}

export function IconDocImport(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="M12 10.5v5.5" />
      <path d="m9.8 13.8 2.2 2.2 2.2-2.2" />
    </Svg>
  );
}

export function IconDocExport(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="M12 16v-5.5" />
      <path d="m9.8 13.2 2.2-2.2 2.2 2.2" />
    </Svg>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.6 2.6 2.6 15.4 0 18-2.6-2.6-2.6-15.4 0-18Z" />
    </Svg>
  );
}

export function IconArchive(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3.5" width="18" height="4.5" rx="1.4" />
      <path d="M5 8v11a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8" />
      <path d="M10 12.5h4" />
    </Svg>
  );
}

export function IconCompress(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m14.5 9.5 6-6" />
      <path d="M20.5 9.5v-6h-6" />
      <path d="m9.5 14.5-6 6" />
      <path d="M3.5 14.5v6h6" />
    </Svg>
  );
}

export function IconEraser(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 15.8 14.6 6.2a3 3 0 0 1 4.2 4.2l-7.2 7.2H6.8L5 15.8Z" />
      <path d="M9.5 20.5h10" />
    </Svg>
  );
}

export function IconFastForward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 7 5 5-5 5" />
      <path d="m13 7 5 5-5 5" />
    </Svg>
  );
}

export function IconLockOpen(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="10.5" width="16" height="10" rx="2.4" />
      <path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" />
      <path d="M12 14.5v2.5" />
    </Svg>
  );
}

export function IconKey(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="12" r="3.6" />
      <path d="M11.6 12H21" />
      <path d="M18 12v3.2" />
      <path d="M14.8 12v2.2" />
    </Svg>
  );
}

export function IconStamp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 15V10a2.5 2.5 0 0 1 5 0v5" />
      <rect x="5" y="15" width="14" height="3.4" rx="1.6" />
      <path d="M7.5 20.8h9" />
    </Svg>
  );
}

export function IconHash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 9h15M4.5 15h15" />
      <path d="M10.5 4 8.5 20M16.5 4l-2 16" />
    </Svg>
  );
}

export function IconPanelTop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.4" />
      <path d="M3.5 9.5h17" />
    </Svg>
  );
}

/** Four corner brackets opening outward — "take the screen", on a canvas that can be edited full screen. */
export function IconExpand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 4.5h-5v5" />
      <path d="M14.5 4.5h5v5" />
      <path d="M19.5 14.5v5h-5" />
      <path d="M4.5 14.5v5h5" />
    </Svg>
  );
}

/** The same four corners pointing inward: the way back out of full screen. */
export function IconCollapse(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 9.5h5v-5" />
      <path d="M19.5 9.5h-5v-5" />
      <path d="M19.5 14.5h-5v5" />
      <path d="M4.5 14.5h5v5" />
    </Svg>
  );
}

export function IconHighlighter(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 20.5h14" />
      <path d="M16.5 4.8 8.5 12.8l-.6 3.4 3.4-.6 8-8-2.8-2.8Z" />
    </Svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.4 6.6A8 8 0 0 1 12 6.5c5 0 8.5 5.5 8.5 5.5a15 15 0 0 1-2.6 3.3" />
      <path d="M6.6 8.6A15.4 15.4 0 0 0 3.5 12s3.5 5.5 8.5 5.5a8 8 0 0 0 3.2-.7" />
      <path d="M4 4l16 16" />
    </Svg>
  );
}

export function IconSignature(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 15.5c1.6.8 3-.2 4-2 1-1.9 1.5-4.4 2.6-4.2 1.2.2.5 4 2.2 4.7 1.3.5 2.5-.4 3.2-2" />
      <path d="M4 20h16" />
    </Svg>
  );
}

export function IconFormField(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="6" width="17" height="12" rx="2.4" />
      <path d="M12 9.5v5" />
      <path d="M10.2 9.5h3.6M10.2 14.5h3.6" />
    </Svg>
  );
}

export function IconListChecks(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3.5 6.2 1.3 1.3L7.3 4.8" />
      <path d="m3.5 11.6 1.3 1.3 2.5-2.7" />
      <path d="m3.5 17 1.3 1.3 2.5-2.7" />
      <path d="M10.5 6h10M10.5 11.4h10M10.5 16.8h10" />
    </Svg>
  );
}

/* ── Interaction affordances ───────────────────────────────────────────── */

/** The drag handle's dotted grip, and the one glyph that says "this row moves" without a word. */
export function IconGrip(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="6" r="1.1" />
      <circle cx="15" cy="6" r="1.1" />
      <circle cx="9" cy="12" r="1.1" />
      <circle cx="15" cy="12" r="1.1" />
      <circle cx="9" cy="18" r="1.1" />
      <circle cx="15" cy="18" r="1.1" />
    </Svg>
  );
}

/**
 * The canvas toolbox's resting tool (`features/placement/toolbox.tsx`): the cursor that places nothing.
 *
 * A tool rail that only offered kinds would arm a kind permanently, so every click on the page placed a mark — this is
 * the state that selects instead, and it is the one an editor has to have.
 */
export function IconPointer(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5 18.5 11l-5.3 1.3L10.4 18z" />
    </Svg>
  );
}

/**
 * The options card's own glyph, and the file card's: a control panel, a page going up.
 *
 * They are the two halves of a tool page — *what goes in* and *what it will do* — and each heads its card, so the pair
 * reads as the same shape of thing rather than as a heading and a form.
 */
export function IconSliders(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h9M17 17h3" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="15" cy="17" r="2" />
    </Svg>
  );
}

/**
 * The two controls the range rows add: one more output, one fewer.
 *
 * They are here rather than as a `+`/`✕` character because the remove button sits beside a numeric row label, and a
 * text glyph set at the same size as a number reads as part of the value.
 */
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  );
}

/** The `＋`'s opposite, drawn at the same weight: one copy fewer of a page (`features/page-order/`). */
export function IconMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 12h13" />
    </Svg>
  );
}

/**
 * Two arrows passing each other — "reverse the order".
 *
 * Distinct from `IconRefresh` on purpose: refresh means *do it again to the same thing*, and reversing the pages of a
 * document is the opposite of repeating it. A button that reversed the document under a circular arrow would be the one
 * affordance in this app whose glyph suggests a no-op.
 */
export function IconSwap(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 5.5h12.5" />
      <path d="m16.5 2.5 3 3-3 3" />
      <path d="M17 18.5H4.5" />
      <path d="m7.5 21.5-3-3 3-3" />
    </Svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  );
}

/**
 * A magnifier over a page: "look at this one larger".
 *
 * It exists because a page tile in a plan preview now **does something** (a click moves the page between the kept and the
 * removed half), so looking at a page has to be a second, explicitly labelled affordance rather than the thing a click
 * does. Two actions on one tile, and the destructive one is not allowed to be the unlabelled one.
 */
export function IconZoom(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4 20 20" />
      <path d="M8.4 10.8h4.8M10.8 8.4v4.8" />
    </Svg>
  );
}

/** A page coming back — the action on a page in the **removed** half: "keep this one after all". */
/**
 * The canvas history's two arrows (`features/placement/index.tsx`): a curved arrow that turns back, and its mirror.
 *
 * They are mirror images on purpose — a pair of `‹ ›` would read as navigation, and this pair sits three controls away
 * from the page's own `‹ ›`, which is exactly the confusion an editor cannot afford mid-placement.
 */
export function IconUndo(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H9" />
      <path d="M7.5 4.5 3.5 9l4 4.5" />
    </Svg>
  );
}

export function IconRedo(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H15" />
      <path d="M16.5 4.5 20.5 9l-4 4.5" />
    </Svg>
  );
}

export function IconReturn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 5.5 5 10l4.5 4.5" />
      <path d="M5 10h8.2a5.3 5.3 0 0 1 5.3 5.3V19" />
    </Svg>
  );
}

/** The `ⓘ` that opens a panel of facts — the affordance that replaced a card nobody read. */
export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.4" />
      <circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** "This opens somewhere other than here" — used by anything that navigates away. */
export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 4.5h6v6" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14.6v4.9H4.5V6h4.9" />
    </Svg>
  );
}

/** Two stacks side by side — the result compared with what went in. */
export function IconCompare(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.2" y="4.6" width="7.4" height="14.8" rx="1.6" />
      <rect x="13.4" y="4.6" width="7.4" height="14.8" rx="1.6" />
      <path d="M6.4 9h1M16.6 9h1" />
    </Svg>
  );
}
