import type { ReactNode } from 'react';
import {
  IconEraser,
  IconFileText,
  IconHighlighter,
  IconImage,
  IconLayers,
  IconListChecks,
  IconPen,
  IconPointer,
  IconSignature,
  IconType,
} from '../../components/icons';

/**
 * The canvas's toolbox: one icon per kind, with the name and what it does in a tooltip.
 *
 * Three decisions, and they are all about the same defect — a row of word-buttons that grew with every kind the
 * catalogue declared:
 *
 * 1. **A glyph, not a label.** The rail is 52px wide and vertical, so it costs the drawing a fixed strip instead of a
 *    row that wraps to two lines on a narrow window. The label is not lost: it is the button's accessible name
 *    (`aria-label`) *and* the tooltip, so a pointer, a screen reader and a test all read the same word — which is also
 *    why the e2e can still ask for `Text` by name.
 * 2. **The tooltip carries the sentence, not just the name.** "Shape" is not self-explanatory; "Rectangle, ellipse, line
 *    or arrow — drag on the page to draw it" is. Each kind declares its own (`KIND_HINTS`), and the two are drawn
 *    together on hover and on keyboard focus, which is the only way a tooltip is reachable without a mouse.
 * 3. **`Select` is a tool too.** With a kind always armed, *every* click on the page placed a mark — so selecting what
 *    is already there and looking at it meant arming a kind and risking a stray element. Select is the resting state:
 *    it is what the canvas opens in, it places nothing, and it is what the user goes back to when they are done placing.
 *
 * The glyphs are the app's own icon set (`components/icons.tsx`), keyed by the `kind` id the adapter declares rather
 * than by label, because the id is what the contract spells — a renamed label must not lose its icon.
 */

/** The kind that places nothing: clicking the page selects what is under the pointer, or clears the selection. */
export const SELECT_KIND = '';

/** What one kind's tooltip says after its name. Absent for `select`, whose name is its whole sentence. */
const KIND_HINTS: Record<string, string> = {
  text: 'Click the page to write a caption where it will be read',
  shape: 'Rectangle, ellipse, line or arrow — drag on the page to draw it',
  checkbox: 'A tick box at the contract’s own size — click to place it',
  image: 'Place a PNG or JPEG — choose the file in the panel, then drag it into place',
  draw: 'Freehand: click to add each point, then press Finish stroke',
  signature: 'Place the signature image — pick or draw it in the panel',
  highlight: 'Drag over the words this annotation marks',
  underline: 'Drag over the words this annotation marks',
  strike: 'Drag over the words this annotation marks',
  note: 'Click the page for a sticky note’s anchor',
};

/** The glyph for a kind. A kind this build has no glyph for gets the generic mark rather than no button at all. */
export function toolGlyph(kind: string, size = 19): ReactNode {
  switch (kind) {
    case SELECT_KIND:
      return <IconPointer size={size} />;
    case 'text':
      return <IconType size={size} />;
    case 'shape':
      return <IconLayers size={size} />;
    case 'checkbox':
      return <IconListChecks size={size} />;
    case 'image':
      return <IconImage size={size} />;
    case 'draw':
      return <IconPen size={size} />;
    case 'signature':
      return <IconSignature size={size} />;
    case 'highlight':
      return <IconHighlighter size={size} />;
    case 'underline':
      return <IconType size={size} strokeWidth={2.4} />;
    case 'strike':
      return <IconEraser size={size} />;
    case 'note':
      return <IconFileText size={size} />;
    default:
      return <IconLayers size={size} />;
  }
}

export interface ToolboxTool {
  id: string;
  label: string;
}

/**
 * The rail itself.
 *
 * A `role="toolbar"` with `aria-orientation="vertical"`, and the pressed tool is `aria-pressed` — so the rail is a set
 * of toggles to a screen reader rather than a list of buttons whose effect is invisible. Every button is disabled while a
 * stroke is open: a freehand mark is built up by clicks on the *page*, and switching tools mid-stroke would abandon the
 * one being drawn.
 */
export function PlacementToolbox({
  tools,
  active,
  disabled = false,
  onPick,
  footer,
}: {
  tools: ToolboxTool[];
  active: string;
  disabled?: boolean;
  onPick: (kind: string) => void;
  /** The rail's own tail — the `Finish stroke` action, when one is open. */
  footer?: ReactNode;
}) {
  return (
    <div className="studio-rail" role="toolbar" aria-label="Place a mark" aria-orientation="vertical">
      <RailButton
        kind={SELECT_KIND}
        label="Select"
        hint="Move what is already on the page — click a mark twice to type on it, ⌫ or Delete removes it, ⌘/Ctrl + D duplicates it"
        active={active === SELECT_KIND}
        onPick={onPick}
        disabled={disabled}
      />
      {tools.map((tool) => (
        <RailButton
          key={tool.id}
          kind={tool.id}
          label={tool.label}
          hint={KIND_HINTS[tool.id]}
          active={active === tool.id}
          onPick={onPick}
          disabled={disabled}
        />
      ))}
      {footer ? <div className="studio-rail-foot">{footer}</div> : null}
    </div>
  );
}

function RailButton({
  kind,
  label,
  hint,
  active,
  disabled,
  onPick,
}: {
  kind: string;
  label: string;
  hint?: string;
  active: boolean;
  disabled: boolean;
  onPick: (kind: string) => void;
}) {
  return (
    <button
      type="button"
      className="studio-rail-btn"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onPick(kind)}
    >
      {toolGlyph(kind)}
      {/*
        One tooltip for pointer and keyboard alike, and it is drawn rather than described: `title` would be the
        browser's own and would not appear for a button that is focused but not hovered, which is exactly the reader who
        needs it. `aria-hidden` because the button already carries the name — a tooltip that repeated it into the
        accessibility tree would be the same word twice.
      */}
      <span className="studio-tip" aria-hidden="true">
        <span className="studio-tip-name">{label}</span>
        {hint ? <span className="studio-tip-hint">{hint}</span> : null}
      </span>
    </button>
  );
}
