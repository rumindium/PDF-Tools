import type { OptionsUiField } from '@pdftools/contracts/tools';
import { useState } from 'react';
import { Field, TextArea } from '../../components/ui';

/**
 * Structural options — `rotate.perPage`, `redact.regions`, `crop.box` — are objects, so no flat
 * control can express them. They get a JSON editor that keeps the *last valid* value: an unparseable draft shows the
 * parse error and leaves the request body alone, instead of sending `"{"` and letting the API reject the whole job.
 *
 * It lives in its own module because two callers now share it: the options panel, for every option whose control is
 * `json`, and the placement canvas, as the escape hatch beside the visual editor. A visual editor that could not be
 * escaped would be a regression for anyone whose element does something the canvas does not draw.
 */
export function JsonField({
  field,
  value,
  onChange,
}: {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  const id = `option-${field.key}`;
  const serialized = value == null ? '' : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(serialized);

  // Re-sync when the value changed from outside (switching tool, applying a preset) but never mid-typing,
  // which would move the caret on every keystroke.
  if (serialized !== synced) {
    setSynced(serialized);
    if (error === null) setDraft(serialized);
  }

  return (
    <Field label={field.label} hint={error ?? field.hint} htmlFor={id}>
      <TextArea
        id={id}
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          if (next.trim() === '') {
            setError(null);
            onChange(field.key, undefined);
            return;
          }
          try {
            onChange(field.key, JSON.parse(next));
            setError(null);
          } catch {
            setError('Not valid JSON yet — the last valid value is what gets submitted.');
          }
        }}
      />
    </Field>
  );
}
