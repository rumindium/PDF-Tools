import type { OptionsUiField } from '@pdftools/contracts/tools';
import { isPageRangeToken } from '@pdftools/contracts/tools';
import { useEffect, useRef, useState } from 'react';
import { IconPlus, IconX } from '../../components/icons';
import { Button, Field, TextInput } from '../../components/ui';
import { coveredCount, fullyCovered, nextRange } from '../page-plan/plan';

/**
 * The page ranges of a split: one row per output file, and **two boxes per range**
 * (`0-UI-DESIGN.md` §3.2, `02-SPLIT-AND-EXTRACT.md` §6).
 *
 * This control has been wrong twice in the same way, and both times the fault was the same as the documented grammar's:
 * *it made the user spell something the form could have spelled for them.* It began as a `<textarea>` with one line per
 * output — the right data in the wrong control, where adding an output was a newline and the pages nobody had claimed
 * were invisible. It then became rows, which fixed the first half and left the second: a range was still typed as
 * `1-5`, one keystroke at a time, with a hyphen that is pure syntax — and `4-` was a state the user could reach and the
 * API could not accept. A range is two numbers, so it is now two boxes and a separator the user never types.
 *
 * Three consequences, and the first is the point:
 *
 *  - **`4-` no longer exists.** Empty `to` means *one page* — `from` alone, the join between the boxes being decoration
 *    rather than data — so the half-typed state the old control had to detect and refuse is now unrepresentable. What is
 *    left to validate is a real mistake: a token the grammar does not know (`abc`, `9-5`) or a range that names no page
 *    of this document, and the message names which.
 *  - **Every row still opens with what is left.** `nextRange` writes the first run of pages no row has claimed, and it
 *    arrives split across the boxes (`4` / `12`), because the fill is a range like any other.
 *  - **A row can still hold several ranges**, which the schema allows and the worker reads: `1-3, 7` in one row is one
 *    file holding four pages (`packages/contracts/src/tools/types.ts`, `range-groups`). It is one button inside the row
 *    rather than a syntax the user has to guess, because a control that cannot express it would make the option
 *    unreachable from the browser again — the defect this module was written to close (defect 124).
 *
 * The value is still the API's `string[][]` and the buffers are still text, for the same reason as everywhere else in
 * this panel: validating on every keystroke would flag `z` while someone is typing `z`, and a half-typed value would be
 * rejected by the schema.
 *
 * `pageCount` is the number the API probed at upload, or `null` while that is in flight. The rows work either way — the
 * one thing that changes is what the add button writes (`4`–`8` when the length is known, `4`–`z` when it is not,
 * because the end is the part nobody knows yet).
 */

/** One range: the two boxes, as text. Empty `to` is one page, not a range with a missing end. */
interface Segment {
  from: string;
  to: string;
}

/** A row's segments plus the id React keys it by — positional keys would remount the box the user is typing in. */
interface RangeRow {
  id: number;
  segments: Segment[];
}

export function RangeRowsField({
  field,
  value,
  onChange,
  pageCount,
}: {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  pageCount: number | null;
}) {
  const id = `option-${field.key}`;
  const counter = useRef(0);
  const [rows, setRows] = useState<RangeRow[]>(() => rowsFromValue(value, counter));
  // The message *and* the row it belongs to: the sentence is about one range, so a row that reports itself valid beside
  // a red sentence about another row is the kind of detail half the users cannot get.
  const [invalid, setInvalid] = useState<{ message: string; rowId: number } | null>(null);
  /**
   * The box a change just happened in, so focus follows the *value* rather than the component: the range that appeared
   * gets the caret, which is where the next number is going anyway.
   *
   * **State, not a ref, and that is a fix rather than a preference.** It was a ref with an effect keyed on the row
   * count, which is true for `Add a range` and false for `another range in this file`: a second range inside an
   * existing row is a box that appears without the count changing, so the effect never ran and the caret stayed in the
   * box the user had already finished with. The dependency has to be the *request*, not a proxy for it
   * (`apps/web/src/features/tool-shell/page-rows.tsx` carries the same fix).
   */
  const [focusBox, setFocusBox] = useState<string | null>(null);

  // A tool can reset its options (for example after a completed job); mirror that into the buffers.
  useEffect(() => {
    const next = rowsFromValue(value, counter);
    setRows((current) => (sameRows(current, next) ? current : next));
  }, [value]);

  //
  // By DOM id rather than by a ref — `TextInput` is a plain function component on React 18, so a ref would be dropped
  // before it reached the `<input>` — and keyed on the requested box itself, so every kind of range that appears gets
  // the caret rather than only the kind that changes the number of rows.
  //
  useEffect(() => {
    if (focusBox == null) return;
    document.getElementById(`${id}-${focusBox}`)?.focus();
    setFocusBox(null);
  }, [focusBox, id]);

  const groups = rows.map((row) => row.segments.map(specOf).filter((spec) => spec !== ''));
  const covered = coveredCount(groups, pageCount);
  const complete = fullyCovered(groups, pageCount);

  const commit = (next: RangeRow[], focus?: string) => {
    setRows(next);
    setFocusBox(focus ?? null);
    const entries = next.map((row) => ({
      rowId: row.id,
      specs: row.segments.map(specOf).filter((spec) => spec !== ''),
    }));
    const parsed = entries.map((entry) => entry.specs).filter((group) => group.length > 0);
    if (parsed.length === 0) {
      setInvalid(null);
      onChange(field.key, undefined);
      return;
    }
    for (const entry of entries) {
      const bad = entry.specs.find((spec) => !isPageRangeToken(spec));
      if (bad) {
        // Kept on screen *and* kept out of the value: a token the grammar refuses would be refused by the API too, and
        // forwarding it would make the plan draw a range that cannot run.
        setInvalid({ message: `"${bad}" is not a page or a page range.`, rowId: entry.rowId });
        return;
      }
    }
    setInvalid(null);
    onChange(field.key, parsed);
  };

  const edit = (rowIndex: number, segmentIndex: number, patch: Partial<Segment>) => {
    commit(
      rows.map((row, index) =>
        index !== rowIndex
          ? row
          : { ...row, segments: row.segments.map((s, i) => (i === segmentIndex ? { ...s, ...patch } : s)) },
      ),
    );
  };

  const addRow = () => {
    const fill = nextRange(groups, pageCount);
    if (fill == null) return;
    counter.current += 1;
    const rowId = counter.current;
    commit([...rows, { id: rowId, segments: [segmentOf(fill)] }], `${rowId}-0-from`);
  };

  const addSegment = (rowIndex: number) => {
    // The new range starts where the ones in this row end, so it continues *this* file rather than repeating a page
    // that is already in it.
    const row = rows[rowIndex]!;
    const names = row.segments.map(specOf).filter((spec) => spec !== '');
    const fill = nextRange([...[names]], pageCount) ?? '';
    commit(
      rows.map((entry, index) =>
        index !== rowIndex ? entry : { ...entry, segments: [...entry.segments, segmentOf(fill)] },
      ),
      `${row.id}-${row.segments.length}-from`,
    );
  };

  const removeSegment = (rowIndex: number, segmentIndex: number) => {
    commit(
      rows.map((row, index) =>
        index !== rowIndex ? row : { ...row, segments: row.segments.filter((_, i) => i !== segmentIndex) },
      ),
    );
  };

  const removeRow = (index: number) => {
    // Never an empty list: the tool has nothing to split without at least one row, and an empty form is a worse answer
    // than a form that says which range produces which file.
    if (rows.length <= 1) return;
    commit(rows.filter((_, position) => position !== index));
  };

  const firstBox = `${id}-${rows[0]?.id ?? 0}-0-from`;

  return (
    <Field label={field.label} hint={field.hint ?? 'One output file per row.'} htmlFor={firstBox}>
      <div className="range-rows">
        {rows.map((row, index) => (
          <div className="range-row" key={row.id}>
            <span className="range-row-no" aria-hidden="true">
              {index + 1}
            </span>

            <div className="range-row-body">
              {row.segments.map((segment, segmentIndex) => (
                <div className="range-pair" key={`${row.id}-${segmentIndex}`}>
                  <TextInput
                    id={`${id}-${row.id}-${segmentIndex}-from`}
                    className="input range-box"
                    value={segment.from}
                    placeholder="1"
                    inputMode="numeric"
                    // The visible label names the first box only (`Field`'s `htmlFor`), so each box carries the field's
                    // own label plus where it is: a screen reader hears "Ranges, output 2 from", and the browser stage
                    // has one unambiguous way to address a box.
                    aria-label={`${field.label}, output ${index + 1} from${segmentIndex > 0 ? ` (${segmentIndex + 1})` : ''}`}
                    aria-invalid={invalid?.rowId === row.id}
                    onChange={(event) => edit(index, segmentIndex, { from: event.currentTarget.value })}
                  />
                  <span className="range-pair-dash" aria-hidden="true">
                    –
                  </span>
                  <TextInput
                    id={`${id}-${row.id}-${segmentIndex}-to`}
                    className="input range-box"
                    value={segment.to}
                    placeholder="z"
                    inputMode="numeric"
                    aria-label={`${field.label}, output ${index + 1} to${segmentIndex > 0 ? ` (${segmentIndex + 1})` : ''}`}
                    aria-invalid={invalid?.rowId === row.id}
                    onChange={(event) => edit(index, segmentIndex, { to: event.currentTarget.value })}
                  />
                  {/* Only where there is something to remove: a row's first range is the row. */}
                  {row.segments.length > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove range ${segmentIndex + 1} from output ${index + 1}`}
                      onClick={() => removeSegment(index, segmentIndex)}
                    >
                      <IconX size={13} />
                    </Button>
                  ) : null}
                </div>
              ))}

              <button type="button" className="range-more" onClick={() => addSegment(index)}>
                <IconPlus size={12} />
                another range in this file
              </button>
            </div>

            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove output ${index + 1}`}
              disabled={rows.length <= 1}
              onClick={() => removeRow(index)}
            >
              <IconX size={14} />
            </Button>
          </div>
        ))}

        <div className="range-row-actions">
          <Button size="sm" onClick={addRow} disabled={complete}>
            <IconPlus size={14} />
            {complete ? 'Every page is in a file' : 'Add a range'}
          </Button>
          {/* The summary is the point of this control: what is covered, and what is not. */}
          <span className="tiny faint">
            {pageCount == null
              ? 'The page count arrives with the upload.'
              : covered === pageCount
                ? `All ${pageCount} pages are in a file.`
                : `${covered} of ${pageCount} pages in ${rows.length === 1 ? 'this file' : 'these files'} · ${
                    pageCount - covered
                  } in no file`}
          </span>
        </div>
      </div>

      {invalid ? (
        <span className="tiny" style={{ color: 'var(--danger)' }}>
          {invalid.message}
        </span>
      ) : null}
    </Field>
  );
}

/** One range as the grammar spells it: `1-5`, `7`, `4-z`. An empty `to` is one page, never a trailing hyphen. */
function specOf(segment: Segment): string {
  const from = segment.from.trim();
  const to = segment.to.trim();
  if (from === '') return '';
  return to === '' ? from : `${from}-${to}`;
}

/** And back: the two boxes a stored spec fills. */
function segmentOf(spec: string): Segment {
  const dash = spec.indexOf('-');
  if (dash <= 0) return { from: spec, to: '' };
  return { from: spec.slice(0, dash), to: spec.slice(dash + 1) };
}

/** The rows a stored value implies, or the one empty row a fresh form starts with. */
function rowsFromValue(value: unknown, counter: { current: number }): RangeRow[] {
  const groups = Array.isArray(value)
    ? (value as unknown[][]).map((group) =>
        Array.isArray(group) ? group.filter((spec): spec is string => typeof spec === 'string' && spec !== '') : [],
      )
    : [];
  const list = groups.length > 0 ? groups : [[]];
  return list.map((group) => {
    counter.current += 1;
    return { id: counter.current, segments: group.length > 0 ? group.map(segmentOf) : [{ from: '', to: '' }] };
  });
}

/** Whitespace-insensitive and order-sensitive, so mirroring a reset never fights the user's own typing. */
function sameRows(left: readonly RangeRow[], right: readonly RangeRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    if (!other || row.segments.length !== other.segments.length) return false;
    return row.segments.every((segment, i) => norm(specOf(segment)) === norm(specOf(other.segments[i]!)));
  });
}

function norm(value: string): string {
  return value.replace(/\s/g, '');
}
