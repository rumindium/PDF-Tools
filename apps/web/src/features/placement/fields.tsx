import type { ReactNode } from 'react';
import { Field, TextInput, ToggleInput } from '../../components/ui';

/**
 * The controls a placement row is built from, shared by every shape (`0-UI-DESIGN.md` §6.1).
 *
 * They live here rather than in the canvas because the *row* is the shape's business — a highlight has a colour and a
 * text element has a font size — while the way a number is typed is not: every one of these edits a value the engine
 * reads, so they all behave the same way.
 */

/**
 * One labelled field of a mark.
 *
 * `Field` — the shared primitive — is what renders the label, so the association is an `htmlFor`/`id` pair rather than
 * a `<label>` wrapped around a component: the same shape the options panel uses, and the reason a click on any label
 * here focuses its own input.
 */
export function RowField({
  label,
  htmlFor,
  wide = false,
  children,
}: {
  label: string;
  htmlFor: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? 'placement-field placement-field-wide' : 'placement-field'}>
      <Field label={label} htmlFor={htmlFor}>
        {children}
      </Field>
    </div>
  );
}

/**
 * One number of a placement, typed.
 *
 * The canvas writes these and the user can overwrite them, in both directions: a drag that lands at 41.8 pt is
 * *displayed* as 41.8 and can be replaced with 42, which is the difference between a preview and a placement tool.
 * An emptied field keeps the previous number rather than writing `0`, because a half-cleared input is a moment in
 * typing, not a request to move the mark to the page's corner.
 */
export function CoordInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 0.5,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <TextInput
      id={id}
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      value={Number.isFinite(value) ? String(Math.round(value * 100) / 100) : ''}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        if (raw === '') return;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return;
        onChange(parsed);
      }}
    />
  );
}

/** A colour swatch plus its hex, for the kinds whose contract carries one. */
export function ColourField({
  id,
  label,
  value,
  fallback,
  note,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  /** The colour shown when the option is unset — the contract's own default for the kind. */
  fallback: string;
  /** An optional line under the swatch, for when the display value is not what gets sent. */
  note?: string;
  onChange: (value: string) => void;
}) {
  const current = hexOr(value, fallback);
  return (
    <RowField label={label} htmlFor={id}>
      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
        <input id={id} type="color" value={current} onChange={(event) => onChange(event.currentTarget.value)} />
        <span className="tiny faint">{current}</span>
      </span>
      {note ? <span className="tiny faint">{note}</span> : null}
    </RowField>
  );
}

/** A nullable colour: `fill: null` is a shape with no interior, which is not the same as black. */
export function FillField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (value: string | null) => void;
}) {
  const on = typeof value === 'string';
  return (
    <RowField label="Fill" htmlFor={id}>
      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
        <ToggleInput label="On" checked={on} onChange={(next) => onChange(next ? '#ffd54f' : null)} />
        {on ? (
          <input
            id={id}
            type="color"
            value={hexOr(value, '#ffd54f')}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        ) : null}
      </span>
    </RowField>
  );
}

export function hexOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}
