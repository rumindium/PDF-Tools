import { TextInput } from '../../../components/ui';
import type { PlacementAdapter, PlacementItem } from '../adapter';
import { ColourField, CoordInput, RowField } from '../fields';
import { type Box, MIN_BOX_POINTS } from '../geometry';
import {
  MARKUP_DISPLAY_COLOURS,
  annotationBox,
  annotationDefaultSize,
  annotationGeometry,
  annotationSummary,
  createAnnotation,
  displayColour,
  moveAnnotation,
  readAnnotations,
} from './annotations';

/**
 * `annotate` on the placement canvas.
 *
 * The canvas itself is unchanged — this is the half that knows what `annotate`'s option says. The shape's logic lives in
 * `annotations.ts`, kept free of React on purpose: the placement stage imports it and posts the payload this editor
 * writes, so "the box the canvas computed is the box the engine painted" is asserted against the same code the user's
 * browser runs rather than against a copy of it.
 */
export const annotationsAdapter: PlacementAdapter = {
  // Labels for the kinds the catalog declares. The catalog decides *which* kinds exist; this decides what to call them,
  // because "Strike-through" is a UI word and `strike` is the schema's.
  kinds: [
    { id: 'highlight', label: 'Highlight' },
    { id: 'underline', label: 'Underline' },
    { id: 'strike', label: 'Strike-through' },
    { id: 'note', label: 'Note' },
  ],
  noun: 'annotation',
  read: readAnnotations,
  box: annotationBox,
  move: moveAnnotation,
  create: createAnnotation,
  summary: annotationSummary,
  geometry: annotationGeometry,
  defaultSize: annotationDefaultSize,
  // Nothing in this contract grows by clicking: a markup mark is one drag, a note is one click.
  strokeKinds: [],
  addStrokePoint: (item) => item,
  /**
   * A mark is painted in the colour it will be drawn in, at less than full strength: the point of the canvas is seeing
   * *where* the mark lands, and an opaque highlight would hide the text it is meant to sit over. An untouched mark shows
   * the contract's own default colour, which is a display value — nothing is written to the option until the user picks.
   */
  overlay: (item) => <MarkSwatch item={item} />,
  fields: (item, update, index) => <AnnotationRowFields item={item} update={update} index={index} />,
};

function MarkSwatch({ item }: { item: PlacementItem }) {
  if (item.kind === 'note') {
    return (
      <span className="placement-note" style={{ background: displayColour(item) }} aria-hidden="true">
        i
      </span>
    );
  }
  return (
    <span
      className="placement-swatch"
      style={{ background: displayColour(item), opacity: item.kind === 'highlight' ? 0.45 : 0.9 }}
      aria-hidden="true"
    />
  );
}

function AnnotationRowFields({
  item,
  update,
  index,
}: {
  item: PlacementItem;
  update: (next: PlacementItem) => void;
  index: number;
}) {
  const id = (part: string) => `annotation-${index}-${part}`;
  const box: Box = annotationBox(item) ?? { x: 0, y: 0, width: 0, height: 0 };
  /**
   * Every number in this row goes through `moveAnnotation`, never into the entry directly.
   *
   * That is what keeps a multi-rectangle mark reachable: the numbers describe the union box, and writing them moves or
   * scales all of the mark's rectangles together — the same operation a drag performs, so the two paths cannot disagree.
   */
  const setBox = (patch: Partial<Box>) => update(moveAnnotation(item, { ...box, ...patch }));
  const set = (patch: Record<string, unknown>) => update({ ...item, entry: { ...item.entry, ...patch } });
  const isNote = item.kind === 'note';
  const colour = item.entry.color;
  const fallback = MARKUP_DISPLAY_COLOURS[item.kind] ?? '#ffe066';

  return (
    <div className="placement-fields">
      <RowField label="Page" htmlFor={id('page')}>
        <CoordInput
          id={id('page')}
          value={item.page}
          min={1}
          onChange={(value) => update({ ...item, page: Math.max(1, Math.round(value)) })}
        />
      </RowField>
      <RowField label="x" htmlFor={id('x')}>
        <CoordInput id={id('x')} value={box.x} onChange={(value) => setBox({ x: value })} />
      </RowField>
      <RowField label="y" htmlFor={id('y')}>
        <CoordInput id={id('y')} value={box.y} onChange={(value) => setBox({ y: value })} />
      </RowField>

      {isNote ? (
        <RowField label="Note text" htmlFor={id('text')} wide>
          <TextInput
            id={id('text')}
            value={typeof item.entry.text === 'string' ? item.entry.text : ''}
            onChange={(event) => set({ text: event.currentTarget.value })}
          />
        </RowField>
      ) : (
        <>
          <RowField label="Width" htmlFor={id('width')}>
            <CoordInput
              id={id('width')}
              value={box.width}
              min={MIN_BOX_POINTS}
              onChange={(value) => setBox({ width: value })}
            />
          </RowField>
          <RowField label="Height" htmlFor={id('height')}>
            <CoordInput
              id={id('height')}
              value={box.height}
              min={MIN_BOX_POINTS}
              onChange={(value) => setBox({ height: value })}
            />
          </RowField>
          <ColourField
            id={id('color')}
            label="Colour"
            value={colour}
            fallback={fallback}
            note={colour === undefined ? `unset — the job uses its own default (${fallback})` : undefined}
            onChange={(color) => set({ color })}
          />
        </>
      )}

      {isNote && typeof item.entry.text === 'string' && item.entry.text.trim() === '' ? (
        <span className="tiny" style={{ color: 'var(--warning, #b26a00)' }}>
          An empty note opens to nothing — type the text a reader should see.
        </span>
      ) : null}
    </div>
  );
}
