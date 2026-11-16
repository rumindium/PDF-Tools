import { ToggleInput } from '../../../components/ui';
import type { PlacementAdapter, PlacementItem } from '../adapter';
import { CoordInput, RowField, hexOr } from '../fields';
import { type Box, MIN_BOX_POINTS } from '../geometry';
import {
  REDACTION_KIND,
  createRedaction,
  displayFill,
  moveRedaction,
  readRedactions,
  redactionBox,
  redactionDefaultSize,
  redactionGeometry,
  redactionSummary,
} from './redactions';

/**
 * `redact` on the placement canvas.
 *
 * The canvas itself is unchanged — this is the half that knows what `redact`'s option says. The shape's logic lives in
 * `redactions.ts`, kept free of React on purpose: the placement stage imports it and posts the payload this editor
 * writes, so "the box the canvas drew is the box whose content the engine removed" is asserted against the same code
 * the user's browser runs rather than against a copy of it.
 *
 * This is the shape where a wrong box cannot be noticed by looking at the output: a redaction that misses its target
 * still produces a valid PDF, still reports success, and is a document that leaks what it was meant to remove. The
 * overlay below is therefore a solid bar rather than a tint, and the row above it is the reason the JSON editor is no
 * longer the only way to aim one.
 */
export const redactionsAdapter: PlacementAdapter = {
  kinds: [{ id: REDACTION_KIND, label: 'Redaction box' }],
  noun: 'region',
  read: readRedactions,
  box: redactionBox,
  move: moveRedaction,
  create: (_kind, page, box) => createRedaction(page, box),
  summary: redactionSummary,
  // One kind, and it is a rectangle: a drag places *and* sizes it, exactly like a signature.
  geometry: () => redactionGeometry(),
  defaultSize: () => redactionDefaultSize(),
  strokeKinds: [],
  addStrokePoint: (item) => item,
  overlay: (item) => <RedactionBar item={item} />,
  fields: (item, update, index) => <RedactionRowFields item={item} update={update} index={index} />,
};

/** The bar the user is aiming: opaque enough to read as "this goes", and the region's own fill when it has one. */
function RedactionBar({ item }: { item: PlacementItem }) {
  return (
    <span className="placement-swatch" style={{ background: displayFill(item), opacity: 0.82 }} aria-hidden="true" />
  );
}

function RedactionRowFields({
  item,
  update,
  index,
}: {
  item: PlacementItem;
  update: (next: PlacementItem) => void;
  index: number;
}) {
  const id = (part: string) => `redaction-${index}-${part}`;
  const box: Box = redactionBox(item) ?? { x: 0, y: 0, width: 0, height: 0 };
  /**
   * Every number in this row goes through `moveRedaction`, never into the entry directly.
   *
   * That is what keeps a multi-rectangle region reachable — the numbers describe the union box, and writing them moves
   * or scales all of the region's rectangles together, the same operation a drag performs.
   */
  const setBox = (patch: Partial<Box>) => update(moveRedaction(item, { ...box, ...patch }));
  const fill = item.entry.fill;

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

      {/*
        The per-page fill is optional, and "unset" is a value the schema distinguishes from black: it is what lets the
        job-wide `Fill colour` reach every page a region does not override. So the toggle writes the field and the
        toggle off *deletes* it — a colour input alone could never express the difference, and `null` is not a value
        this schema accepts.
      */}
      <RowField label="Page fill" htmlFor={id('fill')}>
        <span className="row" style={{ gap: 8, alignItems: 'center' }}>
          <ToggleInput
            label="Override"
            checked={typeof fill === 'string'}
            onChange={(next) => {
              if (next) {
                update({ ...item, entry: { ...item.entry, fill: '#000000' } });
                return;
              }
              const { fill: _dropped, ...rest } = item.entry;
              update({ ...item, entry: rest });
            }}
          />
          {typeof fill === 'string' ? (
            <>
              <input
                id={id('fill')}
                type="color"
                value={hexOr(fill, '#000000')}
                onChange={(event) => update({ ...item, entry: { ...item.entry, fill: event.currentTarget.value } })}
              />
              <span className="tiny faint">{hexOr(fill, '#000000')}</span>
            </>
          ) : (
            <span className="tiny faint">unset — the job-wide Fill colour applies</span>
          )}
        </span>
      </RowField>
    </div>
  );
}
