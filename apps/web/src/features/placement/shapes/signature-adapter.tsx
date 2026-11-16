import { SelectInput } from '../../../components/ui';
import type { PlacementAdapter, PlacementItem } from '../adapter';
import { CoordInput, RowField } from '../fields';
import { type Box, MIN_BOX_POINTS } from '../geometry';
import {
  SIGNATURE_CANVAS_UNITS,
  SIGNATURE_KIND,
  createSignature,
  moveSignature,
  readSignatures,
  signatureBox,
  signatureDefaultSize,
  signatureGeometry,
  signatureSummary,
} from './signature';

/**
 * `sign` on the placement canvas.
 *
 * The canvas itself is unchanged — this is the half that knows what `sign`'s option says. The shape's arithmetic lives
 * in `signature.ts`, kept free of React on purpose: the placement stage imports it and posts the payload this editor
 * writes, so "the box the canvas computed is the box the engine drew the signature in" is asserted against the code
 * the browser runs rather than against a copy of it.
 *
 * The overlay is deliberately a *line* and not a signature. The canvas knows where the image goes; what the image looks
 * like is the user's ink and the engine's placement, and a handwriting-font preview here would be the editor promising
 * a rendering it does not control (`elements.tsx` refuses the same thing for text width, for the same reason).
 */
export const signatureAdapter: PlacementAdapter = {
  kinds: [{ id: SIGNATURE_KIND, label: 'Signature' }],
  noun: 'signature',
  read: readSignatures,
  box: signatureBox,
  move: moveSignature,
  create: (_kind, page, box) => createSignature(page, box),
  summary: signatureSummary,
  // One kind, and it is a rectangle: the size the image is drawn at is the box, so a drag places *and* sizes it.
  geometry: () => signatureGeometry(),
  defaultSize: () => signatureDefaultSize(),
  strokeKinds: [],
  addStrokePoint: (item) => item,
  overlay: (item) => <SignatureLine item={item} />,
  fields: (item, update, index) => <SignatureRowFields item={item} update={update} index={index} />,
};

/** A baseline with a scrawl over it — the shape of the thing, not a preview of the user's ink. */
function SignatureLine({ item }: { item: PlacementItem }) {
  if (item.entry.units === 'percent') return null;
  return (
    <svg
      className="placement-signature"
      width="100%"
      height="100%"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line x1="2" y1="27" x2="98" y2="27" stroke="currentColor" strokeWidth="0.6" opacity="0.45" />
      <path
        d="M6 22 C14 6, 20 24, 28 14 S42 6, 48 16 S60 24, 70 10 S84 8, 94 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.75"
      />
    </svg>
  );
}

function SignatureRowFields({
  item,
  update,
  index,
}: {
  item: PlacementItem;
  update: (next: PlacementItem) => void;
  index: number;
}) {
  const id = (part: string) => `signature-${index}-${part}`;
  const box: Box = signatureBox(item) ?? { x: 0, y: 0, width: 0, height: 0 };
  /**
   * Every number in this row goes through `moveSignature`, never into the entry directly, for the reason the module
   * documents: the entry may be written in millimetres, and a control that wrote points would be silently wrong by a
   * factor of 2.83.
   */
  const setBox = (patch: Partial<Box>) => update(moveSignature(item, { ...box, ...patch }));
  const unit = item.entry.units;

  if (item.entry.units === 'percent') {
    return (
      <div className="placement-fields">
        <span className="tiny" style={{ color: 'var(--warning, #b26a00)' }}>
          This placement is a share of the page ({String(item.entry.x)} %, {String(item.entry.y)} %), which the canvas
          cannot resolve without the page's size. It is kept exactly as typed — edit it in the JSON editor, or switch
          its unit to pt/mm to move it by dragging.
        </span>
      </div>
    );
  }

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
      <RowField label="Unit" htmlFor={id('unit')}>
        <SelectInput
          id={id('unit')}
          value={typeof unit === 'string' ? unit : 'pt'}
          options={SIGNATURE_CANVAS_UNITS.map((candidate) => ({ value: candidate, label: candidate }))}
          onChange={(event) => {
            // Switching the unit *reinterprets* the numbers, it does not rescale them: the box on screen stays where the
            // user put it and the entry is rewritten in the new unit, which is what someone switching pt → mm is asking
            // for. The opposite reading (keep the numbers, move the mark) is what a unit selector everywhere else means,
            // and it would silently teleport a signature off the page.
            const next = event.currentTarget.value as (typeof SIGNATURE_CANVAS_UNITS)[number];
            update(moveSignature({ ...item, entry: { ...item.entry, units: next } }, box));
          }}
        />
      </RowField>
    </div>
  );
}
