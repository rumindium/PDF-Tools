import type { OptionsUiField } from '@pdftools/contracts/tools';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { IconArrowRight, IconPlus, IconX } from '../../components/icons';
import { Button, Field, TextInput } from '../../components/ui';
import {
  type PageRow,
  type PageRowsReading,
  type SelectionDirection,
  describeSelection,
  firstBadRow,
  nextFill,
  rowOf,
  rowsFromValue,
  sameRows,
  specsOf,
} from './page-rows-model';

/**
 * A page selection, spelled as rows of boxes — `extract-pages` and `delete-pages`
 * (`docs/02-SPLIT-AND-EXTRACT.md` §3.2, `docs/0-UI-DESIGN.md` §3.2).
 *
 * These two tools take a flat `string[]` that **is the output**: the pages kept, or the pages removed. That reading is
 * what makes this control different from `split`'s `RangeRowsField`, and the difference is the whole design:
 *
 *  - there, one row is one **file**, and `1-3` in one row with `7` in the next is two outputs;
 *  - here, every row is part of the same selection, so a row is one **decision** and the rows are a list. Nothing is
 *    grouped, and `＋ another range in this file` has no meaning.
 *
 * A row is a page (one box) or a range (two), and the hyphen between the two is drawn rather than typed — so `4-`, the
 * state the old single text box could reach and the API has to refuse, is **unrepresentable**. Two buttons add rows,
 * because a selection of many pages is written both ways: `Add page` for one, `Add range` for a span, each arriving
 * with the first pages nobody has named yet (`nextFill`), which is what makes the second click a continuation of the
 * first rather than a blank row.
 *
 * Below them the control states its own arithmetic in the **direction** the field declared — `Keeps 6 of 12 pages.`
 * against `Removes 6 of 12 pages — 6 stay.`, `Crops 3 of 12 pages — the other 9 keep their own crop box.` and `Turns 3
 * of 6 pages — the other 3 keep the rotation they already carry.` — and that sentence is the only place three facts appear:
 * how many pages the selection actually names, that a page was named twice (duplicates collapse silently in every other
 * layer), and the states the worker refuses (`describeSelection` in `./page-rows-model.ts`).
 *
 * The value is the API's flat `string[]` and the boxes are text while they are being typed, for the reason the rest of
 * this panel gives: validating every keystroke flags `z` while someone is typing `z`, and a half-typed value would be
 * refused by the schema. A row the grammar refuses is reported **at that row** (`aria-invalid` on its boxes) and is
 * **not forwarded**, so the preview keeps drawing the last plan that was actually valid.
 *
 * **And the control has a third state, which is not a selection at all.** One tool's selection is only one of the two
 * forms its request can take: `rotate` writes a single angle over a set of pages *or* a map of page → angle, never both
 * (`features/page-rotate/model.ts`), so a mixed arrangement leaves this value empty with nothing for a keystroke to
 * mean. Emptying the boxes there was a control that disappeared in the middle of a session — so a caller that knows the
 * arrangement may pass a `reading`, and the rows are drawn from it instead: the same rows, in the same place, naming the
 * runs of pages that turn one way, with the sentence saying what the list is. Nothing is editable in that state, and
 * that is the honest answer rather than a disabled box.
 */

export function PageRowsField({
  field,
  value,
  onChange,
  pageCount,
  direction,
  reading,
}: {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  /** The document's length as the API probed it, or `null` while that is in flight. */
  pageCount: number | null;
  /** Which way round these pages are going: kept, removed, acted on, or turned (`OptionsUiField.removes`, `.applies`, `.turns`). */
  direction: SelectionDirection;
  /**
   * The arrangement as a list of runs, while the value this control collects cannot be written — `null` or absent when
   * the boxes are the control (`PageRowsReading`).
   */
  reading?: PageRowsReading | null;
}) {
  const id = `option-${field.key}`;
  const counter = useRef(0);
  const [rows, setRows] = useState<PageRow[]>(() => rowsFromValue(value, counter));
  const [invalid, setInvalid] = useState<{ message: string; rowId: number } | null>(null);
  /**
   * The box a change just happened in, so the caret follows the *value* rather than the component: a row that appeared
   * gets the caret, which is where the next number is going anyway.
   *
   * **State, not a ref, and that is a fix rather than a preference.** It was a ref with an effect keyed on the row
   * count — which works for `Add page` and fails for `Make this a range`, because widening a row focuses a box without
   * changing the count, so the effect never ran and the caret stayed where it was. The dependency has to be the
   * *request*, not a proxy for it (`apps/web/src/features/tool-shell/range-rows.tsx` carries the same fix, for the
   * same knob: `another range in this file`).
   */
  const [focusBox, setFocusBox] = useState<string | null>(null);

  // A tool can reset its options (for example after a completed job); mirror that into the buffers.
  useEffect(() => {
    const next = rowsFromValue(value, counter);
    setRows((current) => (sameRows(current, next) ? current : next));
  }, [value]);

  //
  // By DOM id rather than by a ref — `TextInput` is a plain function component on React 18, so a ref would be dropped
  // before it reached the `<input>` — and keyed on the requested box itself, so *every* change that puts a box on screen
  // gets the caret, not only the ones that change the number of rows.
  //
  useEffect(() => {
    if (focusBox == null) return;
    document.getElementById(`${id}-${focusBox}`)?.focus();
    setFocusBox(null);
  }, [focusBox, id]);

  //
  // **The reading, drawn in the boxes' place.** The control is still here and still says what it is — the label above it
  // and the runs below — but no row can be edited, and the two `Add` buttons are not drawn at all rather than disabled:
  // there is no value a click could write (the worker ignores a selection beside a map), so offering one would be the
  // same lie the empty boxes were. The sentence is the caller's, because only the tool that owns the arrangement knows
  // what the map does to the pages it does not name.
  //
  if (reading) {
    return (
      <Field label={field.label}>
        <div className="page-rows" data-reading="true">
          {reading.rows.map((row) => (
            <div className="page-row" data-reading="true" key={row.spec}>
              <div className="page-row-boxes">
                <span className="page-row-run">{row.spec}</span>
              </div>
              <span className="page-row-note tiny faint">{row.note}</span>
            </div>
          ))}
          <span className="page-rows-summary tiny" data-tone="ok">
            {reading.sentence}
          </span>
        </div>
      </Field>
    );
  }

  const fill = nextFill(rows, pageCount);
  const summary = describeSelection({ rows, pageCount, direction });

  const commit = (next: PageRow[], focus?: string) => {
    setRows(next);
    setFocusBox(focus ?? null);
    const bad = firstBadRow(next);
    if (bad) {
      // Kept on screen *and* kept out of the value: a token the grammar refuses would be refused by the API too, and
      // forwarding it would make the plan draw a selection that cannot run.
      setInvalid(bad);
      return;
    }
    setInvalid(null);
    const nextSpecs = specsOf(next);
    onChange(field.key, nextSpecs.length > 0 ? nextSpecs : undefined);
  };

  const edit = (index: number, patch: Partial<PageRow>) => {
    commit(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const add = (kind: PageRow['kind']) => {
    if (!fill) return;
    counter.current += 1;
    commit([...rows, rowOf(kind, counter.current, fill)], `${counter.current}-from`);
  };

  /** A page row becoming a range in place, rather than being deleted and added again — the boxes are the same decision. */
  const widen = (index: number) => {
    commit(
      rows.map((row, position) => (position === index ? { ...row, kind: 'range' } : row)),
      `${rows[index]!.id}-to`,
    );
  };

  const remove = (index: number) => {
    // Never an empty list: the tool has no selection without at least one row, and an empty form is a worse answer than
    // a form that is waiting for a page number.
    if (rows.length <= 1) return;
    commit(
      rows.filter((_, position) => position !== index),
      // The caret lands on the row that took the removed row's place, or on the last one if that was the last.
      rows[index + 1] != null ? `${rows[index + 1]!.id}-from` : `${rows[index - 1]?.id}-from`,
    );
  };

  const firstBox = `${id}-${rows[0]?.id ?? 0}-from`;
  // Enter finishes a decision and starts the next one, on the box that ends the row: the `To` of a range, the only box
  // of a page. A form with two buttons and no keyboard path would be a form a fast user has to leave.
  const onEnter = (kind: PageRow['kind'], event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add(kind);
  };

  return (
    <Field label={field.label} hint={field.hint} htmlFor={firstBox}>
      <div className="page-rows">
        {rows.map((row, index) => (
          <div className="page-row" key={row.id} data-invalid={invalid?.rowId === row.id ? 'true' : undefined}>
            <span className="page-row-no" aria-hidden="true">
              {index + 1}
            </span>

            <div className="page-row-boxes">
              <TextInput
                id={`${id}-${row.id}-from`}
                className="input range-box"
                value={row.from}
                placeholder="1"
                inputMode="numeric"
                // The visible label names the first box only (`Field`'s `htmlFor`), so each box carries the field's own
                // label plus where it is: a screen reader hears "Pages, row 2 from".
                aria-label={`${field.label}, row ${index + 1} from`}
                aria-invalid={invalid?.rowId === row.id}
                onChange={(event) => edit(index, { from: event.currentTarget.value })}
                onKeyDown={(event) => (row.kind === 'page' ? onEnter('page', event) : undefined)}
              />
              {row.kind === 'range' ? (
                <>
                  <span className="range-pair-dash" aria-hidden="true">
                    –
                  </span>
                  <TextInput
                    id={`${id}-${row.id}-to`}
                    className="input range-box"
                    value={row.to}
                    // Empty means *one page* here too: `4` alone is page 4, so the placeholder names the other end of an
                    // open range rather than a second required number.
                    placeholder="z"
                    inputMode="numeric"
                    aria-label={`${field.label}, row ${index + 1} to`}
                    aria-invalid={invalid?.rowId === row.id}
                    onChange={(event) => edit(index, { to: event.currentTarget.value })}
                    onKeyDown={(event) => onEnter('range', event)}
                  />
                </>
              ) : null}
            </div>

            {/* The one way a page becomes a range without being retyped — faint until the row is hovered or focused. */}
            {row.kind === 'page' ? (
              <button
                type="button"
                className="page-row-widen"
                aria-label={`${field.label}, make row ${index + 1} a range`}
                title="Make this a range"
                onClick={() => widen(index)}
              >
                <IconArrowRight size={12} />
                range
              </button>
            ) : null}

            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove row ${index + 1}`}
              disabled={rows.length <= 1}
              onClick={() => remove(index)}
            >
              <IconX size={14} />
            </Button>
          </div>
        ))}

        <div className="range-row-actions">
          {/*
           * Both buttons stop together, and the reason is the sentence below them: once every page is named, a keep
           * selection is the whole document, a removal is the state the job refuses, and a crop is the same document
           * with a box on each page. Adding a row could only name a page twice.
           */}
          <Button
            size="sm"
            disabled={fill == null}
            title={fill == null ? 'Every page is already named.' : undefined}
            onClick={() => add('page')}
          >
            <IconPlus size={14} />
            Add page
          </Button>
          <Button
            size="sm"
            disabled={fill == null}
            title={fill == null ? 'Every page is already named.' : undefined}
            onClick={() => add('range')}
          >
            <IconPlus size={14} />
            Add range
          </Button>
        </div>

        {/* The sentence, and the row it is about: a red remark beside a row that reports itself valid is half an answer. */}
        <span className="page-rows-summary tiny" data-tone={summary.tone}>
          {summary.sentence}
        </span>
      </div>

      {invalid ? (
        <span className="tiny" style={{ color: 'var(--danger)' }}>
          {invalid.message}
        </span>
      ) : null}
    </Field>
  );
}
