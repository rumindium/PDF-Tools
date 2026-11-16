import type { UploadedFile } from '@pdftools/contracts/api';
import {
  type CatalogEntry,
  type OptionsUiField,
  PASSWORD_STRENGTH_POLICY,
  evaluatePasswordStrength,
  isPageRangeToken,
} from '@pdftools/contracts/tools';
import { Fragment, useEffect, useState } from 'react';
import { Alert, Field, SelectInput, TextArea, TextInput, ToggleInput } from '../../components/ui';
import { uploadFile } from '../../lib/api-client';
import { PlacementField } from '../placement';
import { SignaturePad } from '../signature/pad';
import { JsonField } from './json-field';
// `removesPages` lives with the rows model rather than in this panel, because the tool page needs the same answer: it is
// what says which half of a two-sided preview a page is in (`features/page-plan/index.tsx`). It used to be a copy here,
// and two readings of one rule is how the form and the preview would come to disagree.
import { PageRowsField } from './page-rows';
import { type PageRowsReading, selectionDirection } from './page-rows-model';
import { RangeRowsField } from './range-rows';
import { SegmentedField } from './segmented';

/**
 * The options form, rendered entirely from the catalog (`0-TOOL-REGISTRY.md` §6).
 *
 * No screen in this app knows what `merge` or `ocr` accepts. Each control comes from an `optionsUi` entry that
 * the API derives from the same zod schema it validates with, so the form and the validator cannot drift — the
 * classic bug where the UI offers a value the API rejects becomes structurally impossible.
 *
 * A field may declare `visibleWhen`, which is how dependent options stay readable: `watermark.text` is not shown
 * when the user chose an image watermark, rather than being shown and then ignored.
 *
 * `placement` is the one control that is a *tool* rather than an input: it draws the document's own pages and turns
 * drags into the coordinates no flat control can express (`features/placement/`, `0-UI-DESIGN.md` §5).
 *
 * `signature-pad` is the one control that *produces* its value: every other entry here reads what the user typed or
 * picked, and this one hands them a surface to draw on and uploads the result (`features/signature/`).
 *
 * Two controls here are about *how much is asked at once* rather than about a value. `segmented` draws a choice as
 * cards instead of a dropdown, which is what a choice that re-decides the meaning of the form deserves
 * (`./segmented.tsx`); `page-rows` collects a page selection in rows of `From`/`To` boxes for the tools whose
 * selection is a **set of pages** — the output (`extract-pages`), the removal (`delete-pages`), or the pages a box is
 * written onto (`crop`, `./page-rows.tsx`). Both are declared by the catalog like every other control, and the first
 * one is what tells the second which way round its pages are going: `removes` for the first two tools, `applies` for
 * the third (`./page-rows-model.ts`, `selectionDirection`).
 */

export interface OptionsPanelProps {
  tool: CatalogEntry;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  files: UploadedFile[];
  order: string[];
  /**
   * Whether this panel draws a `file-order` control itself.
   *
   * The tool page passes `false`: the order is edited on the file board, where the files actually are, and a second
   * copy of the same list a few centimetres lower is a second place to reorder and one more chance for the two to
   * disagree about which order is the submitted one. The catalogue still owns the field — its label and hint are what
   * the board is titled with — and the value is still submitted from here.
   */
  renderFileOrder?: boolean;
  /**
   * Whether this panel draws the `page-order` keys itself.
   *
   * Same argument as `file-order`, one step further: those keys (`order`, `duplicate`, `reverse`) are the arrangement of
   * the pages the tool already draws, so the board *is* the editor and this panel has nothing to add. The tool page passes
   * `false` and renders the board; the panel's own branch is what a caller that renders it without one gets — a sentence
   * saying where the arrangement is edited, rather than three fields that would be a second, typed way to say the same
   * thing (defect 226).
   */
  renderPageOrder?: boolean;
  /**
   * Whether this panel draws the `page-turn` keys itself — `rotate`'s `angle` and `perPage`.
   *
   * The rotate screen passes `false` and renders its own board, because the two keys are one fact about pages the page
   * already draws. Unlike `page-order` there *is* something left for this panel to render on that screen — the `pages`
   * field, which is the target of the board's buttons rather than an angle — so the panel is drawn with this flag and the
   * board around it.
   */
  renderPageTurn?: boolean;
  /**
   * Whether this panel draws the `crop-box` field itself — `crop`'s `box`.
   *
   * The crop screen passes `false`: the four insets are the rectangle the page above is wearing, and a form beside it
   * would be a second place to say the same thing in the syntax the board exists to remove. Everything else on that
   * tool — `auto`, `units`, `pages` — stays here, so this panel is drawn with the flag and the board around it.
   */
  renderCropBox?: boolean;
  /**
   * Whether this panel draws the `sheet-grid` fields — `n-up`'s `perSheet` and `orientation`.
   *
   * The sheet screen passes `false`: the drawing is a grid of pages and the orientation is which way round the paper
   * is, so both are drawn as diagrams beside it rather than as two names that describe a picture nobody can see. The
   * tool's other three options (`pageSize`, `gap`, `border`) stay here, and the drawing follows all five.
   */
  renderSheetGrid?: boolean;
  /**
   * The arrangement a `page-rows` control should **read** rather than collect (`PageRowsReading`), when the value that
   * control writes is not the form the request is in — `null` for the ordinary case, where the boxes are the control.
   *
   * It is a panel-level prop rather than a per-field one because a tool has at most one selection field: `rotate`'s mixed
   * arrangement is a `perPage` map, and a map is not something rows of boxes can hold (`./page-rows.tsx`).
   */
  pageRowsReading?: PageRowsReading | null;
  /**
   * Whether this panel draws the `sheet-paper` field — `n-up`'s `pageSize`.
   *
   * The sheet screen passes `false`, and the field it holds moved out of this panel for the reason `sheet-grid` did:
   * "Sheet size" was a `select` of five names on a screen that draws the sheet. The stock is what the paper's ratio is
   * (so a diagram can show it) and what decides the cell each page gets (so the board captions every layout with it), and
   * those two facts are why it belongs beside the drawing rather than in a form. A caller that renders this panel on its
   * own still gets the field as a `select` — this flag is what the sheet screen turns off.
   */
  renderSheetPaper?: boolean;
  /**
   * Whether this panel draws the `placement` field — `edit-pdf`'s `elements`, `annotate`'s `annotations`, `sign`'s
   * `placements`.
   *
   * The placement screens pass `false`, and this is the one of these flags that is about **size** rather than about a
   * second way of saying the same thing: the canvas is a full-width stage with a toolbox, a drawing and an inspector, and
   * a form that drew it inside itself would be a card inside a card with a scrollbar of its own. The tool page renders
   * the field as the studio's first column and hands this panel the studio's inspector instead, where the rest of the
   * tool's options arrive (`features/placement/index.tsx`, `PlacementFieldProps.children`).
   */
  renderPlacement?: boolean;
}

/** Defaults straight from the catalog, so "unchanged" means "the API's own default". */
export function initialOptionValues(tool: CatalogEntry | null): Record<string, unknown> {
  if (!tool) return {};
  const values: Record<string, unknown> = {};
  for (const field of tool.optionsUi) {
    if (field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}

export function OptionsPanel({
  tool,
  values,
  onChange,
  files,
  order,
  renderFileOrder = true,
  renderPageOrder = true,
  renderPageTurn = true,
  renderCropBox = true,
  renderSheetGrid = true,
  renderSheetPaper = true,
  renderPlacement = true,
  pageRowsReading = null,
}: OptionsPanelProps) {
  const visible = tool.optionsUi
    .filter((field) => isVisible(field, values))
    .filter((field) => renderFileOrder || field.control !== 'file-order')
    .filter((field) => renderPageOrder || field.control !== 'page-order')
    .filter((field) => renderPageTurn || field.control !== 'page-turn')
    .filter((field) => renderCropBox || field.control !== 'crop-box')
    .filter((field) => renderSheetGrid || field.control !== 'sheet-grid')
    .filter((field) => renderSheetPaper || field.control !== 'sheet-paper')
    .filter((field) => renderPlacement || field.control !== 'placement');
  const primary = visible.filter((field) => !field.advanced);
  const advanced = visible.filter((field) => field.advanced);
  // What an `upload` control should offer, per field: the tool declares its attachments, so the file picker's
  // `accept` list comes from the same declaration the API checks the upload against.
  const acceptsFor = (key: string): string[] =>
    tool.auxiliaryFiles?.find((entry) => entry.option === key)?.accepts ?? [];

  if (visible.length === 0) {
    return <p className="small muted">This tool has no options — submit it and it does the only sensible thing.</p>;
  }

  return (
    <div className="stack">
      {primary.map((field) => (
        <Fragment key={field.key}>
          <OptionControl
            field={field}
            value={values[field.key]}
            values={values}
            onChange={onChange}
            files={files}
            order={order}
            accepts={acceptsFor(field.key)}
            judged={tool.setsPasswords.includes(field.key)}
            pageRowsReading={pageRowsReading}
          />
          {field.comparison ? <ComparisonTable comparison={field.comparison} /> : null}
        </Fragment>
      ))}

      {advanced.length > 0 ? (
        <details>
          <summary className="small strong" style={{ cursor: 'pointer' }}>
            Advanced options ({advanced.length})
          </summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {advanced.map((field) => (
              <Fragment key={field.key}>
                <OptionControl
                  field={field}
                  value={values[field.key]}
                  values={values}
                  onChange={onChange}
                  files={files}
                  order={order}
                  accepts={acceptsFor(field.key)}
                  judged={tool.setsPasswords.includes(field.key)}
                  pageRowsReading={pageRowsReading}
                />
                {field.comparison ? <ComparisonTable comparison={field.comparison} /> : null}
              </Fragment>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * A choice's consequences, as a table beneath its control (`OptionsUiField.comparison`).
 *
 * Presentational and static: the values here are the same ones the server sends in the field's own `choices`, so the
 * table cannot offer a profile the schema rejects. It exists because a radio button can only carry a label — "PDF/A-1b
 * (strictest)" says nothing about transparency, encryption or what the profile is based on, and those are the three
 * facts that decide which one a caller wants.
 */
function ComparisonTable({ comparison }: { comparison: NonNullable<OptionsUiField['comparison']> }) {
  const lastColumn = comparison.columns.length - 1;
  return (
    // The minimum width is what keeps the table readable rather than merely present: the prose column ("best for")
    // is the longest cell in the row and the one a browser squeezes first, and a table whose last column wraps to one
    // word per line is a table nobody reads. Below that width the wrapper scrolls sideways instead of compressing.
    <div style={{ overflowX: 'auto' }}>
      <table className="table small" style={{ minWidth: 560 }}>
        <thead>
          <tr>
            {comparison.columns.map((column, index) => (
              <th key={column} style={index < lastColumn ? { whiteSpace: 'nowrap' } : undefined}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row, index) => (
            <tr key={row[0] ?? index}>
              {row.map((cell, cellIndex) => (
                <td
                  key={comparison.columns[cellIndex] ?? cellIndex}
                  style={cellIndex < lastColumn ? { whiteSpace: 'nowrap' } : undefined}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the policy says about the password typed so far — the same verdict the API will reach.
 *
 * Rendered from `evaluatePasswordStrength`, imported from the contracts package rather than re-implemented here: the
 * form and the API must agree about what "8 characters" and "3 classes" mean, and two implementations of the same rule
 * is precisely how a form comes to accept something the server then refuses. Nothing here blocks submission — the
 * verdict is information; the refusal is the API's, and it carries the reasons as data (`WEAK_PASSWORD`'s `issues`).
 *
 * The wording is deliberately about what is *missing* rather than a score out of four: a user who is one class short
 * can act on "add a digit", and cannot act on "strength: 60 %".
 */
function PasswordStrengthNote({ value }: { value: unknown }) {
  const password = typeof value === 'string' ? value : '';
  if (password === '') {
    return (
      <span className="tiny muted">
        {PASSWORD_STRENGTH_POLICY.minLength}+ characters using at least {PASSWORD_STRENGTH_POLICY.minClasses} of:
        lowercase, uppercase, digits, symbols.
      </span>
    );
  }

  const strength = evaluatePasswordStrength(password);
  if (strength.meetsPolicy) {
    return <span className="tiny muted">Meets the strength policy.</span>;
  }

  return (
    <span className="tiny muted">
      {strength.length} character{strength.length === 1 ? '' : 's'} · {strength.classes.length} of 4 classes — a
      password on a plan without the policy is accepted, and the job will say it is weak.
    </span>
  );
}

function isVisible(field: OptionsUiField, values: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  return Object.entries(field.visibleWhen).every(([key, allowed]) => {
    const current = values[key];
    // `'*'` asks a different question than the enumerated values do: not "is it one of these" but "has the user
    // chosen anything at all". That is the only gate an option depending on an *upload* can have, because a file id
    // cannot be listed in advance — a logo's size and side are meaningless until there is a logo.
    if (allowed.includes('*')) return current != null && String(current).trim() !== '';
    return allowed.some((candidate) => String(candidate) === String(current));
  });
}

function OptionControl({
  field,
  value,
  values,
  onChange,
  files,
  order,
  accepts,
  judged,
  pageRowsReading,
}: {
  field: OptionsUiField;
  value: unknown;
  /**
   * The whole form, for the one control that has to read a **sibling** rather than itself.
   *
   * `page-rows` states its own arithmetic in the direction `removes` names, and that direction is another field's
   * value (`extract-pages`'s `mode`). Passing the form down is cheaper and more honest than teaching the control to
   * find its sibling: `optionsUi` already declares which key it is, so nothing is guessed from a choice list.
   */
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  files: UploadedFile[];
  order: string[];
  /** MIME families an `upload` control should offer; empty means "no declared attachment for this option". */
  accepts: string[];
  /**
   * Whether the strength policy judges this field — i.e. whether the tool *chooses* it (`CatalogEntry.setsPasswords`).
   *
   * The distinction is the whole point of the flag: a password field the user must type the document's *current*
   * password into (`unlock`) gets no verdict, because telling someone their colleague's password is weak while they
   * are trying to open a file is noise, and the policy does not apply to a value nobody here is choosing.
   */
  judged: boolean;
  /**
   * The reading a `page-rows` control shows instead of its boxes, for the one caller whose value is in its other form.
   *
   * Passed through this control rather than read here because the panel does not know the arrangement: only the tool
   * whose board draws the pages does (`OptionsPanelProps.pageRowsReading`).
   */
  pageRowsReading: PageRowsReading | null;
}) {
  const id = `option-${field.key}`;

  switch (field.control) {
    case 'toggle':
      return (
        <ToggleInput label={field.label} checked={value === true} onChange={(next) => onChange(field.key, next)} />
      );

    case 'segmented':
      return <SegmentedField field={field} value={value} onChange={onChange} />;

    // `sheet-paper` is a `select` whenever the board is not there to draw it: the control's name says *where* it is
    // edited, and a caller that renders this panel without the sheet screen gets the field it always had rather than a
    // sentence pointing at a row that does not exist. Sharing the branch is what keeps the value's type — the `choices`
    // lookup below yields the catalogue's own value, and a hand-written `<select>` here would have sent a string.
    case 'sheet-paper':
    case 'select':
      return (
        <Field label={field.label} hint={field.hint} htmlFor={id}>
          <SelectInput
            id={id}
            value={String(value ?? '')}
            options={field.choices ?? []}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              const match = (field.choices ?? []).find((choice) => String(choice.value) === raw);
              // Keep the catalog's own type: a numeric enum sent as a string is exactly the drift the registry
              // exists to prevent.
              onChange(field.key, match ? match.value : raw);
            }}
          />
        </Field>
      );

    case 'number':
      return (
        <Field label={field.label} hint={field.hint ?? unitHint(field)} htmlFor={id}>
          <TextInput
            id={id}
            type="number"
            inputMode="decimal"
            value={value == null ? '' : String(value)}
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              if (raw === '') {
                onChange(field.key, undefined);
                return;
              }
              const parsed = Number(raw);
              onChange(field.key, Number.isFinite(parsed) ? parsed : undefined);
            }}
          />
        </Field>
      );

    case 'password':
      return (
        <Field label={field.label} hint={field.hint} htmlFor={id}>
          <TextInput
            id={id}
            type="password"
            autoComplete="off"
            value={value == null ? '' : String(value)}
            onChange={(event) => onChange(field.key, event.currentTarget.value)}
          />
          {judged ? <PasswordStrengthNote value={value} /> : null}
        </Field>
      );

    case 'file-order':
      // The order is edited on the file board, where the files are (`renderFileOrder={false}` on the tool page). This
      // branch is what a caller that renders the panel *without* that board gets: a sentence pointing at the control
      // instead of a field that silently does not exist. `files` and `order` are still read here for their types —
      // the value the panel submits is unchanged either way.
      return (
        <Field label={field.label} hint={field.hint ?? 'The order here is the order in the output.'}>
          <span className="small muted">
            {order.length > 0 ? `${order.length} of ${files.length} files placed. ` : ''}
            The file list above is the order — drag a row to change it.
          </span>
        </Field>
      );

    case 'page-order':
      // `reorder-pages`' whole option surface, and it is arranged on the pages themselves rather than here
      // (`features/page-order/`). This branch is what a caller without that board gets: one sentence per key saying where
      // the arrangement is edited, which is the label and hint the catalogue already wrote. It is *not* a form — the
      // three keys are one arrangement, and the thing that used to be here was a text box asking for a permutation.
      return (
        <Field label={field.label} hint={field.hint ?? 'Arranged on the pages above.'}>
          <span className="small muted">The order of the pages above is the order in the output.</span>
        </Field>
      );

    case 'crop-box':
      // `crop`'s `box`, drawn on the page rather than typed here (`features/page-crop/`). What used to be in this branch
      // was the last **JSON editor** in the product — `{ "top": 20, "right": 20 }` for "20 mm off every side" — and the
      // pointer sentence is what a caller that renders this panel without the board gets, rather than a text box that
      // would be a second, differently-spelled way to say the same four numbers.
      return (
        <Field label={field.label} hint={field.hint ?? 'Drawn on the page above.'}>
          <span className="small muted">The crop is the box on the page above — drag its edges.</span>
        </Field>
      );

    case 'sheet-grid':
      // `n-up`'s `perSheet` and `orientation`, drawn as diagrams beside the sheet (`features/page-sheets/`). A `select`
      // can hold either of them and that is exactly the problem: "6 per sheet" is a picture of two columns of three and
      // the orientation decides which way it lies, so the board shows both and this panel gets out of the way.
      return (
        <Field label={field.label} hint={field.hint ?? 'Chosen beside the sheet.'}>
          <span className="small muted">The sheet to the right is this layout — the diagram beside it changes it.</span>
        </Field>
      );

    case 'page-turn':
      // `rotate`'s angles, which are turned on the pages themselves (`features/page-rotate/`). This branch is what a
      // caller without that board gets: the option's own label and hint, and where the value is set — never a box asking
      // for a map of page → angle, which is what this control was invented to replace.
      return (
        <Field label={field.label} hint={field.hint ?? 'Turned on the pages themselves.'}>
          <span className="small muted">The pages below are drawn the way they will come out.</span>
        </Field>
      );

    case 'pages':
      return <PagesField field={field} value={value} onChange={onChange} />;

    case 'page-rows':
      return (
        <PageRowsField
          field={field}
          value={value}
          onChange={onChange}
          pageCount={pageCountOf(files)}
          direction={selectionDirection(field, values)}
          reading={pageRowsReading}
        />
      );

    case 'range-groups':
      // The row control needs the document's length: it is what turns "the pages nobody has claimed" from a sentence in
      // the hint into the number the next row arrives with. One input is the only case this option has.
      return <RangeRowsField field={field} value={value} onChange={onChange} pageCount={pageCountOf(files)} />;

    case 'upload':
      return <UploadField field={field} value={value} onChange={onChange} accepts={accepts} />;

    case 'json':
      return <JsonField field={field} value={value} onChange={onChange} />;

    case 'placement':
      // The editor needs the documents themselves, because its preview is a real `pdf-to-images` job over the same
      // file the caller is about to edit — not a second rendering path inside the browser.
      return <PlacementField field={field} value={value} onChange={onChange} files={files} />;

    case 'signature-pad':
      // The one control that produces its value instead of reading one: `sign`'s `kind: 'drawn'` was unreachable until
      // there was somewhere to draw. It uploads through the same path `upload` uses, so what the job receives is still
      // an attachment id and not a second kind of input (`features/signature/pad.tsx`).
      return <SignaturePad field={field} value={value} onChange={onChange} accepts={accepts} />;

    // `text` (and anything the registry adds that this panel does not yet know) falls through to the free-text
    // control, which is the safest default: it sends exactly what the user typed and nothing else.
    default:
      return (
        <Field label={field.label} hint={field.hint} htmlFor={id}>
          {field.key.toLowerCase().includes('json') ? (
            <TextArea
              id={id}
              value={value == null ? '' : String(value)}
              onChange={(event) => onChange(field.key, event.currentTarget.value)}
            />
          ) : (
            <TextInput
              id={id}
              value={value == null ? '' : String(value)}
              onChange={(event) => onChange(field.key, event.currentTarget.value)}
            />
          )}
        </Field>
      );
  }
}

/**
 * An upload that belongs to an option rather than to the job's document list — a watermark image today.
 *
 * The option's value is a file id, so the control uploads on pick and stores the id the API returns: the user never
 * sees or types a uuid, which is the difference between a feature and a puzzle. The upload is declared
 * `kind: 'attachment'`, and the API resolves that id back into the job's inputs (`ToolAuxiliaryFile`) — the same file
 * it will be verified and staged from, not a second copy.
 *
 * The id is what is persisted, but the file's name is what is shown, so the field keeps the name locally: it is a
 * display detail, and putting it in the option value would send something the schema does not accept.
 */
function UploadField({
  field,
  value,
  onChange,
  accepts,
}: {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  accepts: string[];
}) {
  const id = `option-${field.key}`;
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = value == null || value === '' ? null : String(value);

  async function pick(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadFile(file, { kind: 'attachment' });
      onChange(field.key, uploaded.id);
      setName(uploaded.name ?? file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field label={field.label} hint={field.hint} htmlFor={id}>
      <input
        id={id}
        type="file"
        accept={accepts.length > 0 ? accepts.join(',') : undefined}
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void pick(file);
        }}
      />
      {busy ? <p className="small muted">Uploading…</p> : null}
      {current && !busy ? (
        <p className="small muted">
          {name ? `${name} — ` : ''}
          {current.slice(0, 8)}…
        </p>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Upload failed">
          <span className="small">{error}</span>
        </Alert>
      ) : null}
    </Field>
  );
}

/** The document's length as the API probed it — `null` while that is in flight, or with more than one input. */
function pageCountOf(files: UploadedFile[]): number | null {
  return files.length === 1 ? (files[0]?.pages ?? null) : null;
}

function unitHint(field: OptionsUiField): string | undefined {
  if (field.min == null && field.max == null) return field.unit ? `In ${field.unit}.` : undefined;
  const range = `${field.min ?? '—'}–${field.max ?? '—'}`;
  return field.unit ? `${range} ${field.unit}.` : `Between ${range}.`;
}

/**
 * Page selection.
 *
 * The text the user types ("1-5, 9" or "4") is kept as text while they type and only converted to the API's
 * `["1-5","9"]` form when it parses. Validating on every keystroke would flag `1-` as an error mid-word, and
 * submitting a raw string would be rejected by the schema — so the buffer and the parsed value are separate.
 */
function PagesField({
  field,
  value,
  onChange,
}: {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  const [text, setText] = useState(() => (Array.isArray(value) ? (value as string[]).join(', ') : ''));
  const [invalid, setInvalid] = useState<string | null>(null);

  //
  // A tool can write this option without the user typing (a board that draws the pages, a reset after a job), so the
  // buffer mirrors what the value says — **including when it says nothing**. That second half was missing: the effect
  // only ever copied an array in, so when the value went back to `undefined` — which is the option's own "every page",
  // and what a board writes when the selection no longer narrows anything — the box kept the text it last held and named
  // pages the request did not carry. It runs on `value` alone, so a half-typed token the grammar refuses (`1-`) leaves
  // the buffer where it is: nothing was written, so there is nothing to mirror.
  //
  useEffect(() => {
    if (Array.isArray(value)) {
      const joined = (value as string[]).join(', ');
      setText((current) => (current.replace(/\s/g, '') === joined.replace(/\s/g, '') ? current : joined));
      return;
    }
    if (value == null) setText((current) => (current === '' ? current : ''));
  }, [value]);

  const id = `option-${field.key}`;

  return (
    <Field label={field.label} hint={field.hint ?? 'Use pages and ranges, e.g. 1-5, 9, 12-14, 20-z, odd.'} htmlFor={id}>
      <TextInput
        id={id}
        value={text}
        placeholder="1-5, 9"
        aria-invalid={invalid != null}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setText(raw);
          const parts = raw
            .split(/[,\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
          if (parts.length === 0) {
            setInvalid(null);
            onChange(field.key, undefined);
            return;
          }
          const bad = parts.find((part) => !isPageRangeToken(part));
          if (bad) {
            setInvalid(`"${bad}" is not a page or a page range.`);
            return;
          }
          setInvalid(null);
          onChange(field.key, parts);
        }}
      />
      {invalid ? (
        <span className="tiny" style={{ color: 'var(--danger)' }}>
          {invalid}
        </span>
      ) : null}
    </Field>
  );
}

/*
 * `split`'s `ranges` — one output file per row — is `RangeRowsField` (`./range-rows.tsx`), a control in its own right:
 * it adds and removes rows, fills each new row with the pages nobody has claimed yet, and states how much of the
 * document is in a file. The distinction from `PagesField` above is the whole point: there, `1-3, 7` is *one*
 * selection of four pages; here, `1-3` in one row and `7` in the next is **two output files**, and `1-3, 7` in one row
 * is one file holding four pages. A single text field cannot express either reading, which is why the option was
 * unreachable from the browser until a control existed for it (defect 124, `docs/02-SPLIT-AND-EXTRACT.md` §2).
 */
