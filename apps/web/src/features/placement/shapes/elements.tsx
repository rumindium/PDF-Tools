import { useState } from 'react';
import { SelectInput, TextInput, ToggleInput } from '../../../components/ui';
import { ApiError, uploadFile } from '../../../lib/api-client';
import type { PlacementAdapter, PlacementItem } from '../adapter';
import { BASE14_FACES, base14Face } from '../base14-metrics';
import { ColourField, CoordInput, FillField, RowField } from '../fields';
import {
  DEFAULT_SIZE_POINTS,
  type DisplayGeometry,
  type ElementKind,
  type PlacementElement,
  type Point,
  elementBox,
  elementSummary,
  newElement,
  pixelsPerPoint,
  placeElement,
  readElements,
  textBaselineDropEm,
  textFace,
} from '../geometry';

/**
 * `edit-pdf` on the placement canvas — the shape the canvas was built for.
 *
 * Everything element-specific lives here: the five kinds, their defaults, how each one is anchored (a text mark at its
 * baseline, a checkbox as a square, a stroke as a point list) and the fields each row offers. The canvas knows none of
 * it, which is what lets `annotate` share it.
 */
export const elementsAdapter: PlacementAdapter = {
  kinds: [
    { id: 'text', label: 'Text' },
    { id: 'shape', label: 'Shape' },
    { id: 'checkbox', label: 'Checkbox' },
    { id: 'image', label: 'Image' },
    { id: 'draw', label: 'Freehand' },
  ],
  noun: 'element',
  // The wrapper is thin on purpose: the element *is* the entry, so the canvas holds the same object the option carries
  // and every field the schema accepted survives a round trip through the editor.
  read: (value) =>
    readElements(value).map((element) => ({
      kind: element.type,
      page: element.page,
      entry: element as unknown as Record<string, unknown>,
    })),
  box: (item) => elementBox(item.entry as PlacementElement),
  move: (item, box) => ({
    ...item,
    entry: placeElement(item.entry as PlacementElement, box) as Record<string, unknown>,
  }),
  create: (kind, page, box) => ({
    kind,
    page,
    entry: newElement(kind as ElementKind, page, box) as Record<string, unknown>,
  }),
  summary: (item) => elementSummary(item.entry as PlacementElement),
  /**
   * `text`, `checkbox` and `draw` are anchored at a point: their size is a font size, a fixed square or the extent of
   * their points, so a drag positions them and the canvas offers no resize handle. `shape` and `image` are real
   * rectangles, which is what a drag draws.
   */
  geometry: (kind) => (kind === 'shape' || kind === 'image' ? 'box' : 'point'),
  defaultSize: (kind) => DEFAULT_SIZE_POINTS[(kind as ElementKind) ?? 'text'] ?? DEFAULT_SIZE_POINTS.text,
  strokeKinds: ['draw'],
  addStrokePoint: (item, at) => {
    const element = item.entry as PlacementElement;
    const points = Array.isArray(element.points) ? (element.points as Point[]) : [];
    return { ...item, entry: { ...element, points: [...points, at] } as Record<string, unknown> };
  },
  overlay: (item, geometry) => <ElementOverlay item={item} geometry={geometry} />,
  /** A text element is the one kind of this shape whose content is a string, so it is the one the page can be typed on. */
  textOf: (item) => {
    const element = item.entry as PlacementElement;
    if (element.type !== 'text') return null;
    return {
      text: typeof element.text === 'string' ? element.text : '',
      size: typeof element.size === 'number' ? element.size : 12,
      color: typeof element.color === 'string' && element.color !== '' ? element.color : '#111111',
      //
      // The face goes with them, because the field the caret is in is measured from the same string the box is
      // (`textWidthPoints`): typing into a box that is 222 units a glyph wide while the words are measured at 191 is
      // the same disagreement the box itself was just cured of, one control later.
      //
      font: textFace(element),
    };
  },
  withText: (item, text) => ({
    ...item,
    entry: { ...(item.entry as PlacementElement), text } as Record<string, unknown>,
  }),
  fields: (item, update, index) => <ElementRowFields item={item} update={update} index={index} />,
};

/** What the canvas draws inside a mark's box: the text as it will be sized, or the stroke's own path. */
function ElementOverlay({ item, geometry }: { item: PlacementItem; geometry: DisplayGeometry }) {
  const element = item.entry as PlacementElement;
  if (element.type === 'text' && typeof element.text === 'string' && element.text !== '') {
    const size = typeof element.size === 'number' ? element.size : 12;
    //
    // The preview is scaled the same way the box is **and drawn in the element's own colour**, which are two halves of
    // one promise: the box was measured from this string with these metrics (`textWidthPoints`), and a red caption
    // previewed in the theme's text colour is a preview of a different page (`--text` was what this used to draw).
    //
    // The third half is the `bottom`, and it is the one that used to be an approximation in the stylesheet: a text box's
    // bottom edge is the **baseline**, so the span hangs below it by half-leading plus descent — the font's own numbers,
    // read from a canvas here (`textBaselineDropEm`) and identical to the one the inline editor is positioned by, which is
    // what makes typing on the page land where the preview said it would.
    //
    return (
      <span
        className="placement-text"
        style={{
          fontSize: Math.max(6, size * pixelsPerPoint(geometry)),
          bottom: `-${textBaselineDropEm()}em`,
          ...(typeof element.color === 'string' && element.color !== '' ? { color: element.color } : {}),
        }}
      >
        {element.text}
      </span>
    );
  }
  if (element.type === 'draw') return <FreehandPreview points={element.points} geometry={geometry} />;
  return null;
}

function FreehandPreview({ points, geometry }: { points: unknown; geometry: DisplayGeometry }) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const perPoint = pixelsPerPoint(geometry);
  const path = points
    .filter((point): point is Point => typeof point === 'object' && point != null && 'x' in point && 'y' in point)
    .map((point) => `${point.x * perPoint},${(geometry.page.heightPt - point.y) * perPoint}`)
    .join(' ');
  return (
    <svg className="placement-stroke" width="100%" height="100%" aria-hidden="true">
      <polyline points={path} fill="none" stroke="#111111" strokeWidth={1.5} />
    </svg>
  );
}

/**
 * The face a text element's row shows and writes — the table's own spelling of what the element carries.
 *
 * An element may hold anything the schema accepts (`font` is a free string), and two of those values are the same font:
 * `times` is Times-Roman, which `POSTSCRIPT_FONTS` says and `base14Face` answers. Showing the *value* would let a
 * control that lists faces sit on a name nobody can find in it, so the row shows the face it resolves to and writes that
 * back — one font, one spelling, in the one control that chooses it.
 */
function faceOption(element: PlacementElement): string {
  const face = textFace(element);
  return base14Face(face) ?? face;
}

/**
 * The values the face control offers, in the order the table holds them.
 *
 * `BASE14_FACES` is not a menu of typefaces the preview likes; it is **every font the overlay can be told to draw**
 * (`POSTSCRIPT_FONTS`, one row each in the generated table), so every choice here is a value the node handler resolves,
 * and the box around it is the engine's own measurement rather than the browser's substitute for one.
 *
 * A value from outside that list is kept as itself rather than replaced: `Symbol`, a chancery face, or a name someone
 * typed into the JSON is a job the handler refuses with `FONT_NOT_FOUND`, and an editor that quietly rewrote it to
 * Helvetica would be lying about the request it is holding. The label is the face's name with its hyphen opened out —
 * `Times-Italic` reads as Times Italic — because these are words on a screen, not PostScript names.
 */
function faceChoices(current: string): Array<{ value: string; label: string }> {
  const faces = BASE14_FACES.map((face) => ({ value: face, label: face.replace(/-/g, ' ') }));
  return faces.some((choice) => choice.value === current) ? faces : [...faces, { value: current, label: current }];
}

function ElementRowFields({
  item,
  update,
  index,
}: {
  item: PlacementItem;
  update: (next: PlacementItem) => void;
  index: number;
}) {
  const element = item.entry as PlacementElement;
  const set = (patch: Record<string, unknown>) =>
    update({ ...item, entry: { ...element, ...patch } as Record<string, unknown> });
  // Every control below is labelled through `htmlFor`, so the ids have to be unique per row and per field.
  const id = (part: string) => `element-${index}-${part}`;

  return (
    <div className="placement-fields">
      <RowField label="Page" htmlFor={id('page')}>
        <CoordInput
          id={id('page')}
          value={element.page}
          min={1}
          onChange={(value) =>
            update({
              ...item,
              page: Math.max(1, Math.round(value)),
              entry: { ...element, page: Math.max(1, Math.round(value)) },
            })
          }
        />
      </RowField>
      <RowField label="x" htmlFor={id('x')}>
        <CoordInput id={id('x')} value={element.x} onChange={(value) => set({ x: value })} />
      </RowField>
      <RowField label="y" htmlFor={id('y')}>
        <CoordInput id={id('y')} value={element.y} onChange={(value) => set({ y: value })} />
      </RowField>

      {element.type === 'text' ? (
        <>
          <RowField label="Text" htmlFor={id('text')} wide>
            <TextInput
              id={id('text')}
              value={typeof element.text === 'string' ? element.text : ''}
              onChange={(event) => set({ text: event.currentTarget.value })}
            />
          </RowField>
          <RowField label="Face" htmlFor={id('face')}>
            <SelectInput
              id={id('face')}
              value={faceOption(element)}
              options={faceChoices(faceOption(element))}
              onChange={(event) => set({ font: event.currentTarget.value })}
            />
          </RowField>
          <RowField label="Size" htmlFor={id('size')}>
            <CoordInput
              id={id('size')}
              value={Number(element.size ?? 12)}
              min={4}
              max={144}
              onChange={(value) => set({ size: value })}
            />
          </RowField>
          <ColourField
            id={id('color')}
            label="Colour"
            value={element.color}
            fallback="#111111"
            onChange={(color) => set({ color })}
          />
          <RowField label="Rotation" htmlFor={id('rotation')}>
            <CoordInput
              id={id('rotation')}
              value={Number(element.rotation ?? 0)}
              onChange={(value) => set({ rotation: value })}
            />
          </RowField>
        </>
      ) : null}

      {element.type === 'shape' ? (
        <>
          <RowField label="Shape" htmlFor={id('shape')}>
            <SelectInput
              id={id('shape')}
              value={String(element.shape ?? 'rect')}
              options={[
                { value: 'rect', label: 'Rectangle' },
                { value: 'ellipse', label: 'Ellipse' },
                { value: 'line', label: 'Line' },
                { value: 'arrow', label: 'Arrow' },
              ]}
              onChange={(event) => set({ shape: event.currentTarget.value })}
            />
          </RowField>
          <RowField label="Width" htmlFor={id('width')}>
            <CoordInput
              id={id('width')}
              value={Number(element.width ?? 0)}
              min={1}
              onChange={(value) => set({ width: value })}
            />
          </RowField>
          <RowField label="Height" htmlFor={id('height')}>
            <CoordInput
              id={id('height')}
              value={Number(element.height ?? 0)}
              min={1}
              onChange={(value) => set({ height: value })}
            />
          </RowField>
          <ColourField
            id={id('stroke')}
            label="Stroke"
            value={element.stroke}
            fallback="#1a73e8"
            onChange={(stroke) => set({ stroke })}
          />
          <RowField label="Width pt" htmlFor={id('strokeWidth')}>
            <CoordInput
              id={id('strokeWidth')}
              value={Number(element.strokeWidth ?? 1)}
              min={0.5}
              max={20}
              onChange={(value) => set({ strokeWidth: value })}
            />
          </RowField>
          <FillField id={id('fill')} value={element.fill} onChange={(fill) => set({ fill })} />
        </>
      ) : null}

      {element.type === 'checkbox' ? (
        <>
          <RowField label="Size" htmlFor={id('size')}>
            <CoordInput
              id={id('size')}
              value={Number(element.size ?? 12)}
              min={4}
              max={40}
              onChange={(value) => set({ size: value })}
            />
          </RowField>
          <ColourField
            id={id('color')}
            label="Colour"
            value={element.color}
            fallback="#111111"
            onChange={(color) => set({ color })}
          />
          <RowField label="Ticked" htmlFor={id('checked')}>
            <ToggleInput
              id={id('checked')}
              label="Ticked"
              checked={element.checked !== false}
              onChange={(checked) => set({ checked })}
            />
          </RowField>
        </>
      ) : null}

      {element.type === 'image' ? (
        <>
          <RowField label="Width" htmlFor={id('width')}>
            <CoordInput
              id={id('width')}
              value={Number(element.width ?? 0)}
              min={1}
              onChange={(value) => set({ width: value })}
            />
          </RowField>
          <RowField label="Height" htmlFor={id('height')}>
            <CoordInput
              id={id('height')}
              value={Number(element.height ?? 0)}
              min={1}
              onChange={(value) => set({ height: value })}
            />
          </RowField>
          <ImageField id={id('image')} fileId={element.fileId} onChange={(fileId) => set({ fileId })} />
        </>
      ) : null}

      {element.type === 'draw' ? (
        <>
          <ColourField
            id={id('color')}
            label="Colour"
            value={element.color}
            fallback="#111111"
            onChange={(color) => set({ color })}
          />
          <RowField label="Width pt" htmlFor={id('strokeWidth')}>
            <CoordInput
              id={id('strokeWidth')}
              value={Number(element.strokeWidth ?? 2)}
              min={0.5}
              max={20}
              onChange={(value) => set({ strokeWidth: value })}
            />
          </RowField>
          <div className="placement-field">
            <span className="tiny faint">Points</span>
            <span className="small">{Array.isArray(element.points) ? element.points.length : 0}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The image an `image` element draws.
 *
 * Uploaded as an `attachment`, which is what `edit-pdf`'s `auxiliaryFiles` declaration (`elements[].fileId`) says the
 * API should resolve: the id stored here is the same file the worker is handed, not a second copy. The name is shown
 * but never stored — it is a display detail, and putting it in the option value would send a field the schema rejects.
 */
function ImageField({
  id,
  fileId,
  onChange,
}: {
  id: string;
  fileId: unknown;
  onChange: (fileId: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentId = typeof fileId === 'string' ? fileId : '';

  return (
    <RowField label="Image" htmlFor={id} wide>
      <input
        id={id}
        type="file"
        accept="image/png,image/jpeg"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          void uploadFile(file, { kind: 'attachment' })
            .then((uploaded) => {
              onChange(uploaded.id);
              setName(uploaded.name ?? file.name);
            })
            .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : String(cause)))
            .finally(() => setBusy(false));
        }}
      />
      {busy ? <span className="tiny faint">Uploading…</span> : null}
      {!busy && currentId !== '' ? <span className="tiny faint">{name ?? `${currentId.slice(0, 8)}…`}</span> : null}
      {!busy && currentId === '' ? (
        <span className="tiny faint">No image chosen — the worker reports FIELD_SKIPPED.</span>
      ) : null}
      {error ? (
        <span className="tiny" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
    </RowField>
  );
}
