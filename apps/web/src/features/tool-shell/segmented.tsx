import type { OptionsUiField } from '@pdftools/contracts/tools';
import { IconCheck } from '../../components/icons';
import { Field } from '../../components/ui';
import { choiceGlyph } from './choice-glyph';

/**
 * A choice rendered as cards rather than behind a dropdown — `extract-pages`'s direction
 * (`OptionsUiField.control = 'segmented'`, `docs/0-UI-DESIGN.md` §3.2).
 *
 * The difference from `select` is not decoration. A dropdown hides its alternatives behind a click and shows the
 * chosen one as a word; both of those are wrong for a choice that **re-decides the meaning of everything below it**.
 * On `extract-pages`, "Pages to keep" against "Pages to remove" is the first thing on the screen and the thing that
 * turns the same page list into either the output or what the output leaves out — so both alternatives are visible at
 * once, each with its own glyph and its own line of consequence, and the one that is chosen is the one that looks
 * chosen.
 *
 * Real `<input type="radio">`s under the cards, visually hidden: arrow keys move between them and the group is
 * announced as a group, which is a keyboard path and a screen-reader answer that two `<button>`s wearing
 * `aria-pressed` would both have to re-implement.
 *
 * The value is the catalog's own `choices[].value`, passed through untouched — including its type — for the reason
 * every control in this panel does: a numeric enum sent as a string is exactly the drift the registry prevents.
 */
export function SegmentedField({
  field,
  value,
  onChange,
}: {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  const name = `option-${field.key}`;
  const current = String(value ?? '');
  const choices = field.choices ?? [];

  return (
    <Field label={field.label} hint={field.hint}>
      {/* `role="radiogroup"` on the wrapper: the native inputs are visually hidden, and without it the group has no
          accessible name of its own beyond the label it is drawn under. */}
      <div className="segmented" role="radiogroup" aria-label={field.label}>
        {choices.map((choice) => {
          const active = String(choice.value) === current;
          const Glyph = choiceGlyph(choice.icon);
          return (
            // The `<label>` wraps the input, so the whole card is the hit target while the input stays the control.
            <label className="segmented-card" key={String(choice.value)} data-active={active ? 'true' : 'false'}>
              <input
                type="radio"
                className="segmented-input"
                name={name}
                value={String(choice.value)}
                checked={active}
                onChange={() => onChange(field.key, choice.value)}
              />
              {Glyph ? (
                <span className="segmented-glyph" aria-hidden="true">
                  <Glyph size={17} />
                </span>
              ) : null}
              <span className="segmented-body">
                <span className="small strong">{choice.label}</span>
                {choice.note ? <span className="tiny faint">{choice.note}</span> : null}
              </span>
              <span className="segmented-check" aria-hidden="true">
                {active ? <IconCheck size={13} /> : null}
              </span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}
