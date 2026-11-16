import type { UploadedFile } from '@pdftools/contracts/api';
import type { CatalogEntry } from '@pdftools/contracts/tools';
import { useEffect, useMemo, useState } from 'react';
import { IconGrid, IconUpload } from '../../components/icons';
import { Alert, Button, Card } from '../../components/ui';
import { PageLightbox, PagePreview } from '../preview';
import { pageSizePoints } from '../preview/render';
import { OptionsPanel } from '../tool-shell/options-panel';
import { type BoardRow, DocumentRow, Dropzone } from '../uploader';
import {
  PER_SHEET_CHOICES,
  SHEET_CHOICES,
  type SheetOrientation,
  type SheetPageSize,
  type SheetSizeKey,
  cellFor,
  describeSheets,
  frameFor,
  gridFor,
  gridLabel,
  mmWhole,
  paperMm,
  planSheets,
  readGapMm,
  readOrientation,
  readPageSize,
  readPerSheet,
  stockSize,
} from './model';

/**
 * `n-up` as a sheet you can see (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.4, `0-UI-DESIGN.md` §6.5).
 *
 * This tool's five options describe **a piece of paper**: how many pages go on it, which way round it is, which stock it
 * is, how far apart the pages sit, and whether each cell is framed. Four of the five used to be a dropdown or a number
 * box beside a screen showing nothing, so "6 per sheet, landscape, 12 mm gaps" was something a person had to picture —
 * and the one question the tool exists to answer ("will the pages still be readable?") is a question about a drawing,
 * not about a number.
 *
 * So the sheet is the control, and everything that decides its shape sits under its picture:
 *
 *  - **Every cell is drawn where the engine will put it.** The placement is the worker's own arithmetic
 *    (`./model.ts`, whose tests are the handler's numbers), the page in each cell is rendered from the document's own
 *    bytes, and every other option — stock, gap, frame — redraws this one picture. The preview cannot promise a sheet
 *    the engine will not produce.
 *  - **`perSheet` is five diagrams, not a dropdown.** A number does not tell you that 6 per sheet is two columns of
 *    three; a diagram does, and the diagrams lie down with the orientation so the shape is visible before it is chosen.
 *    Each one is captioned with the cell it would leave **at the stock, orientation and gap on screen now**, which is
 *    the one number a diagram cannot show — and the caption that matters most is the smallest one, because that is the
 *    layout where the pages stop being readable.
 *  - **The stock is five papers, not a `select`.** A4 versus Legal is a different ratio and a different cell, and both
 *    are things this screen can draw; "Sheet size" as five names in a dropdown was the last option of this tool still
 *    asking to be imagined (`pageSize` is the `sheet-paper` control).
 *  - **And the click is the only thing that changes it.** The three shape controls are one control three times over — a
 *    radio in a card — because a pointer that tried a shape on drew a sheet nobody had chosen while the sentence under
 *    it described the run that had been chosen. Each card carries its own picture (a ratio, a grid, a paper lying
 *    down), so there is nothing to try on that the cards do not already show.
 *  - **The empty slots of the last sheet are drawn as empty slots.** They are part of what the output looks like — and
 *    which slot a page lands in is the difference between reading order and a flow layout.
 *  - **What the panel keeps is what the drawing is not.** The gap and the frame are ordinary settings and stay ordinary
 *    controls in the panel beside the document, from the catalog, so their labels are the schema's own.
 *
 * The sentence under the sheet is where the caveats live, and two of them are the job's own warnings said early: a
 * `source` sheet takes the **first** page's size (so a mixed-size document comes out uniform —
 * `SHEET_SIZE_FROM_FIRST_PAGE`), and a run whose sheet count exceeds the plan's page ceiling is refused by the API
 * before it is queued, so the board says it while the user is still choosing.
 */

/** How many sheets the strip under the drawing offers before it stops being a navigation control. */
const STRIP_LIMIT = 10;

/** The pixel box a page is rendered into, per point of its drawn size — a resolution hint, not a size. */
const RENDER_PX_PER_PT = 1.4;

/**
 * The dots a layout diagram is made of, and the sheet strip's numbers, as fixed lists.
 *
 * Not `Array.from({ length })` at the point of use: a key taken from a render index is a key that changes identity when
 * the list is filtered, and both of these lists are cut down at runtime (`slice` by the layout, by the sheet count). A
 * position in a grid is a fact about the grid.
 */
const CHOICE_CELLS = Array.from({ length: 16 }, (_, index) => index + 1);
const STRIP_NUMBERS = Array.from({ length: STRIP_LIMIT }, (_, index) => index + 1);

/**
 * A stock's name as a chip says it: shorter than the sentence's phrasing (`SHEET_LABELS` reads "the original page",
 * which is a clause, not a control's name) and still the document's own words.
 */
const STOCK_NAMES: Record<SheetSizeKey, string> = {
  source: 'Original page',
  a4: 'A4',
  a3: 'A3',
  letter: 'Letter',
  legal: 'Legal',
};

/** The paper's ratio when the document has not been measured yet: the ISO one, which is what most documents are. */
const ASSUMED_RATIO = 1 / Math.SQRT2;

/**
 * **The click is the only thing that changes the sheet, and that is now the whole rule.**
 *
 * This board used to have a third control beside the click and the keyboard: a shape **probed** by a pointer, drawn for
 * as long as the pointer rested on its card and withdrawn when it left, with a badge in the head saying which shape was
 * on screen and that a click would apply it. `ShapeProbe` was the type of that state — a union naming the option, so a
 * third probe could not be added without a compile error — and it was the honest way to write the state, because the
 * *idea* was the problem rather than its implementation:
 *
 *  - **The screen ended up saying two things at once.** Resting on `A3` drew A3 paper while the sentence under it went
 *    on describing the A4 run (measured in the browser: head `297 × 420 mm`, summary `6 pages → 3 sheets of A4 portrait`),
 *    which is the one thing this board may not do — its whole argument is that the drawing and the numbers agree.
 *  - **The cards are close enough that crossing one is an ordinary movement.** The orientation was exempted from the
 *    probe for exactly that reason (`Portrait` beside `Landscape`, defect 241), and the stock row and the layout row are
 *    the same control twice more: five chips in a row, five diagrams in a row.
 *  - **Every shape card already draws itself.** A stock chip is drawn at its own paper's ratio, a layout card is the
 *    grid it stands for, an orientation card is the paper lying down — the picture a probe would add is on the card
 *    already, which is the opposite of the case that justified probing when it was introduced.
 *
 * So the two registers this screen has are "what you chose" and "what you will get", and a shape nobody has chosen is
 * neither. The `probe` state, the badge and the `data-probe` attribute are gone with it; a shape changes when its radio
 * does.
 */

export function PageSheetsPreview({
  tool,
  rows,
  values,
  title,
  accept,
  acceptLabel,
  maxFileMb,
  dropHint,
  multiple,
  disabled,
  locked,
  rejections,
  files,
  order,
  planMaxPages,
  onFiles,
  onRemove,
  onRetry,
  onOptionChange,
}: {
  tool: CatalogEntry;
  rows: BoardRow[];
  values: Record<string, unknown>;
  title: string;
  accept: string;
  acceptLabel: string;
  maxFileMb: number;
  dropHint: string;
  multiple: boolean;
  disabled?: boolean;
  locked?: boolean;
  rejections: string[];
  files: UploadedFile[];
  order: string[];
  /** The plan's output-page ceiling, which the API enforces before queueing. `null` when it is not known. */
  planMaxPages: number | null;
  onFiles: (files: FileList | File[]) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onOptionChange: (key: string, value: unknown) => void;
}) {
  const row = rows[0] ?? null;
  const file = row?.sourceFile ?? null;
  const [openPage, setOpenPage] = useState<number | null>(null);
  /** Which sheet is on screen. One sheet is a view of the run, not an option: every sheet is the same layout. */
  const [sheet, setSheet] = useState(1);
  /**
   * The pages whose size has been measured, and the ones that could not be.
   *
   * Probed **lazily, for what is being drawn**: page one (because a `source` sheet is its size) and the pages of the
   * sheet on screen. Measuring every page of a three-hundred-page document to draw sixteen of them would be work nobody
   * asked for, and a page whose size is unknown takes the first page's shape with the sentence admitting it.
   */
  const [sizes, setSizes] = useState<Map<number, SheetPageSize | null>>(new Map());

  const perSheet = readPerSheet(values.perSheet);
  const orientation = readOrientation(values.orientation);
  const pageSize = readPageSize(values.pageSize);
  const gapMm = readGapMm(values.gap);
  const border = values.border === true;
  const count = row?.pages ?? files[0]?.pages ?? null;

  const sheetCount = count != null ? Math.max(1, Math.ceil(count / perSheet)) : 1;
  const shown = Math.min(Math.max(1, sheet), Math.max(1, sheetCount));
  // The pages to measure follow the layout on screen: a page whose size was never asked for would otherwise be drawn at
  // the first page's shape for no reason.
  const visiblePages = useMemo(() => {
    const first = (shown - 1) * perSheet + 1;
    return Array.from({ length: perSheet }, (_, index) => first + index).filter(
      (page) => count == null || page <= count,
    );
  }, [shown, perSheet, count]);

  // The page one probe is separate from the visible sheet's: `source` needs it before any sheet can be sized, and it is
  // the fallback every unmeasured page is drawn at.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    const wanted = [...new Set([1, ...visiblePages])].filter((page) => !sizes.has(page));
    if (wanted.length === 0) return;
    void Promise.all(wanted.map(async (page) => [page, await pageSizePoints(file, page)] as const)).then((measured) => {
      if (cancelled) return;
      setSizes((current) => {
        const next = new Map(current);
        for (const [page, size] of measured) next.set(page, size);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [file, visiblePages, sizes]);

  const firstPage = sizes.get(1) ?? null;
  const pages = useMemo(
    () => Array.from({ length: count ?? 0 }, (_, index) => sizes.get(index + 1) ?? null),
    [count, sizes],
  );
  const unmeasured = visiblePages.filter((page) => sizes.has(page) && sizes.get(page) == null).length;

  /**
   * The paper, computed once for the screen rather than read off the plan.
   *
   * A `null` plan (the gap leaving no room, or a `source` sheet waiting for the first page) still knows what paper it is
   * talking about, and the shape controls need that: they caption *every* layout, including the ones that are not the
   * current one, and they draw the stock chips at the paper's own ratio before anything is chosen.
   */
  const sheetFrame = useMemo(() => frameFor(pageSize, orientation, firstPage), [pageSize, orientation, firstPage]);
  /** The sheet the options describe — the only shape on screen, because nothing here is drawn before it is chosen. */
  const plan = useMemo(
    () =>
      planSheets({
        pages,
        fallback: firstPage,
        perSheet,
        pageSize,
        orientation,
        gapMm,
      }),
    [pages, firstPage, perSheet, pageSize, orientation, gapMm],
  );
  const verdict = useMemo(
    () =>
      describeSheets(plan, {
        pageCount: count,
        pageSize,
        orientation,
        gapMm,
        border,
        unmeasured,
        planMaxPages,
      }),
    [plan, count, pageSize, orientation, gapMm, border, unmeasured, planMaxPages],
  );

  const rejectionsAlert =
    rejections.length > 0 ? (
      <Alert tone="warning" title="That file was not added">
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {rejections.map((message) => (
            <li key={message} className="small">
              {message}
            </li>
          ))}
        </ul>
      </Alert>
    ) : null;

  if (!row) {
    return (
      <div className="tool-single">
        <Card className="card-pad upload-card" data-empty="true">
          <div className="stack">
            <div className="card-head">
              <span className="card-head-icon" aria-hidden="true">
                <IconUpload size={15} />
              </span>
              <span className="label">Add a document to {title}</span>
              <span className="tiny faint">
                {acceptLabel} · {maxFileMb} MB
              </span>
            </div>
            <Dropzone onFiles={onFiles} accept={accept} multiple={multiple} disabled={disabled} hint={dropHint} />
            {rejectionsAlert}
          </div>
        </Card>
      </div>
    );
  }

  const current = plan?.layout[shown - 1] ?? null;
  const frame = plan?.frame ?? sheetFrame;
  /** Points as a percentage of the sheet, which is what the drawing is positioned in. */
  const pctX = (points: number) => (frame ? `${(points / frame.widthPt) * 100}%` : '0%');
  const pctY = (points: number) => (frame ? `${(points / frame.heightPt) * 100}%` : '0%');

  const orientationField = tool.optionsUi.find((field) => field.key === 'orientation');
  const perSheetField = tool.optionsUi.find((field) => field.key === 'perSheet');
  const pageSizeField = tool.optionsUi.find((field) => field.key === 'pageSize');

  // Which pages of the document this sheet carries — the question the drawing answers visually and this line answers
  // in numbers, since a sixteen-cell sheet is a lot of counting.
  const rangeFirst = (shown - 1) * perSheet + 1;
  const rangeLast = count != null ? Math.min(count, shown * perSheet) : null;
  const emptySlots = count != null ? sheetCount * perSheet - count : 0;
  const elsewhere = sheetCount > STRIP_LIMIT ? sheetCount - STRIP_LIMIT : 0;

  return (
    <div className="tool-split tool-split-sheets">
      <Card className="card-pad upload-card" data-empty="false">
        <div className="stack">
          <div className="card-head">
            <span className="card-head-icon" aria-hidden="true">
              <IconUpload size={15} />
            </span>
            <span className="label">Your document</span>
            <span className="tiny faint">{firstPage ? paperMm(firstPage) : 'page size unknown'}</span>
          </div>
          <DocumentRow row={row} onRemove={onRemove} onRetry={onRetry} onPreview={() => setOpenPage(1)} />
          {rejectionsAlert}

          {/* What is left of this tool's options once the sheet's own shape is drawn beside the sheet: the gap and the
              frame, whose labels are the catalog's and whose values the drawing follows on the spot. */}
          <div className="sheet-settings">
            <OptionsPanel
              tool={tool}
              values={values}
              onChange={onOptionChange}
              files={files}
              order={order}
              renderFileOrder={false}
              renderPageOrder={false}
              renderPageTurn={false}
              renderCropBox={false}
              renderSheetGrid={false}
              renderSheetPaper={false}
            />
          </div>
        </div>
      </Card>

      <Card className="card-pad sheet-card anim-pop">
        <div className="stack">
          <div className="card-head">
            <span className="card-head-icon" aria-hidden="true">
              <IconGrid size={15} />
            </span>
            <span className="label">
              Sheet {shown}
              {count != null ? ` of ${sheetCount}` : ''}
            </span>{' '}
            <span className="row tiny faint" style={{ gap: 6, alignItems: 'center' }}>
              {' '}
              {count != null && rangeLast != null ? (
                <span>{rangeFirst === rangeLast ? `page ${rangeFirst}` : `pages ${rangeFirst}–${rangeLast}`}</span>
              ) : (
                <span>pages until the document is read</span>
              )}
              {plan ? <span>· {gridLabel(plan.grid)} grid</span> : null}
              {frame ? <span>· {paperMm(frame)}</span> : <span>· waiting for the page size…</span>}
            </span>
          </div>

          <div className="sheet-stage">
            {frame && current ? (
              <div
                className="sheet-paper"
                // The ratio as a number, so the stylesheet can turn the height ceiling into the width it implies — the
                // same reason the crop board does it this way, and it matters more here where the sheet may be either
                // way round (`0-UI-DESIGN.md` §6.4).
                style={{ '--sheet-ratio': frame.widthPt / frame.heightPt } as React.CSSProperties}
                data-sheet={shown}
              >
                {current.slots.map((slot) => (
                  <div
                    // A slot's identity is where it is on the paper, not its position in this array: the two are the same
                    // list today and the coordinate is the one that survives a change to how the list is built.
                    key={`${slot.cell.leftPt}:${slot.cell.topPt}`}
                    className="sheet-slot"
                    data-page={slot.page ?? ''}
                    data-empty={slot.page == null ? 'true' : 'false'}
                    data-framed={border ? 'true' : 'false'}
                    style={{
                      left: pctX(slot.cell.leftPt),
                      top: pctY(slot.cell.topPt),
                      width: pctX(slot.cell.widthPt),
                      height: pctY(slot.cell.heightPt),
                    }}
                  />
                ))}

                {current.slots.map((slot) =>
                  slot.page != null && slot.draw ? (
                    <button
                      key={`page-${slot.page}`}
                      type="button"
                      className="sheet-page"
                      aria-label={`Look closer at page ${slot.page}`}
                      title="Look closer"
                      style={{
                        left: pctX(slot.draw.leftPt),
                        top: pctY(slot.draw.topPt),
                        width: pctX(slot.draw.widthPt),
                        height: pctY(slot.draw.heightPt),
                      }}
                      onClick={() => setOpenPage(slot.page)}
                    >
                      <PagePreview
                        file={file}
                        page={slot.page}
                        box={{
                          width: Math.max(1, Math.round(slot.draw.widthPt * RENDER_PX_PER_PT)),
                          height: Math.max(1, Math.round(slot.draw.heightPt * RENDER_PX_PER_PT)),
                        }}
                        alt={`${row.name}, page ${slot.page}, in its cell on sheet ${shown}`}
                      />
                      <span className="sheet-page-no" aria-hidden="true">
                        {slot.page}
                      </span>
                    </button>
                  ) : null,
                )}
              </div>
            ) : (
              <div className="sheet-empty">
                <span className="small strong">The sheet cannot be drawn yet</span>
                <span className="tiny">
                  {pageSize === 'source'
                    ? 'A sheet that follows the original page needs the first page measured, which happens as soon as the preview loads.'
                    : 'The gap leaves no room for a cell on this sheet.'}
                </span>
              </div>
            )}
          </div>

          {/* The sheets of the run, navigated rather than listed: the arrows and the chips are one control, because a
              run long enough to need `+n more` is a run where stepping is how a person looks at it. */}
          {sheetCount > 1 ? (
            <div className="sheet-nav">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Show the previous sheet"
                disabled={shown <= 1}
                onClick={() => setSheet(shown - 1)}
              >
                ‹
              </Button>
              <div className="sheet-strip" role="radiogroup" aria-label="Sheets in this run">
                {STRIP_NUMBERS.slice(0, Math.min(sheetCount, STRIP_LIMIT)).map((number) => (
                  <label key={number} className="sheet-chip" data-active={number === shown ? 'true' : 'false'}>
                    <input
                      type="radio"
                      className="sheet-choice-input"
                      name="sheet-strip"
                      value={number}
                      checked={number === shown}
                      onChange={() => setSheet(number)}
                    />
                    <span
                      className="sheet-chip-paper"
                      aria-hidden="true"
                      style={
                        frame ? ({ '--sheet-ratio': frame.widthPt / frame.heightPt } as React.CSSProperties) : undefined
                      }
                    />
                    <span className="sheet-chip-no">
                      {number}
                      <span className="visually-hidden"> of {sheetCount}</span>
                    </span>
                  </label>
                ))}
                {elsewhere > 0 ? <span className="tiny faint">+{elsewhere} more</span> : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Show the next sheet"
                disabled={shown >= sheetCount}
                onClick={() => setSheet(shown + 1)}
              >
                ›
              </Button>
            </div>
          ) : null}

          {/* The three options that shape the paper, under its picture, in the order they narrow the choice down: which
              sheet (the stock), which way round (the orientation), and how many pages share it (the layout) — with the
              cell each layout would leave, at this stock and gap, on its own card. */}
          <div className="sheet-shape">
            <div className="sheet-group">
              <span className="small strong">{pageSizeField?.label ?? 'Sheet size'}</span>
              <div
                className="sheet-choices"
                role="radiogroup"
                aria-label={pageSizeField?.label ?? 'Sheet size'}
                data-testid="sheet-papers"
              >
                {SHEET_CHOICES.map((key) => {
                  // The chip's own shape: a named stock's ratio, or the measured first page for `source` (and the ISO
                  // ratio until it is measured, which is what most documents are).
                  const stock = stockSize(key);
                  const size = stock ?? firstPage;
                  const ratio = size ? size.widthPt / size.heightPt : ASSUMED_RATIO;
                  const note = size ? paperMm(size) : 'your page';
                  const active = key === pageSize;
                  return (
                    <label
                      key={key}
                      className="sheet-choice sheet-choice-stock"
                      data-active={active ? 'true' : 'false'}
                      data-stock={key}
                    >
                      <input
                        type="radio"
                        className="sheet-choice-input"
                        name="option-pageSize"
                        value={key}
                        checked={active}
                        disabled={locked === true}
                        aria-label={`${STOCK_NAMES[key]} — ${note}`}
                        onChange={() => onOptionChange('pageSize', key)}
                      />
                      <span
                        className="sheet-choice-paper"
                        aria-hidden="true"
                        style={{ '--stock-ratio': ratio } as React.CSSProperties}
                      />
                      <span className="sheet-choice-label">{STOCK_NAMES[key]}</span>
                      <span className="sheet-choice-note">{note}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="sheet-group">
              <span className="small strong">{orientationField?.label ?? 'Orientation'}</span>
              <div className="sheet-choices" role="radiogroup" aria-label={orientationField?.label ?? 'Orientation'}>
                {(['portrait', 'landscape'] as const).map((value) => (
                  <label
                    key={value}
                    className="sheet-choice sheet-choice-orientation"
                    data-active={orientation === value ? 'true' : 'false'}
                    // The card is what is clicked — the input inside it is a real radio a keyboard can reach and a pointer
                    // cannot, which is the same pair the layout cards are built from, and the click is the only thing on
                    // this board that changes the sheet (`the rule at the top of the file`).
                    data-orientation-choice={value}
                  >
                    <input
                      type="radio"
                      className="sheet-choice-input"
                      name="option-orientation"
                      value={value}
                      checked={orientation === value}
                      disabled={locked === true}
                      onChange={() => onOptionChange('orientation', value)}
                    />
                    <span className="sheet-choice-paper" data-orientation={value} aria-hidden="true" />
                    <span className="sheet-choice-label">
                      {value === 'portrait' ? 'Portrait' : 'Landscape'}
                      <span className="visually-hidden"> sheet</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="sheet-group">
              <span className="small strong">{perSheetField?.label ?? 'Pages per sheet'}</span>
              <div
                className="sheet-choices"
                role="radiogroup"
                aria-label={perSheetField?.label ?? 'Pages per sheet'}
                data-testid="sheet-layouts"
              >
                {PER_SHEET_CHOICES.map((value) => {
                  const shape = gridFor(value, orientation);
                  const cell = sheetFrame ? cellFor(sheetFrame, value, orientation, gapMm) : null;
                  const active = value === perSheet;
                  return (
                    // The `<label>` wraps the input, so the whole card is the hit target while the input stays the control.
                    // Real `<input type="radio">`s, as the panel's own segmented control does: the arrow keys move between
                    // the five layouts and the group is announced as one, which two buttons wearing `aria-pressed` would
                    // both have to re-implement.
                    <label
                      key={value}
                      className="sheet-choice"
                      data-active={active ? 'true' : 'false'}
                      data-per-sheet={value}
                    >
                      <input
                        type="radio"
                        className="sheet-choice-input"
                        name="option-perSheet"
                        value={value}
                        checked={active}
                        disabled={locked === true}
                        aria-label={
                          cell
                            ? `${value} per sheet, ${shape ? gridLabel(shape) : ''} grid, each page ${mmWhole(cell.widthPt)} by ${mmWhole(cell.heightPt)} millimetres`
                            : `${value} per sheet, ${shape ? gridLabel(shape) : ''} grid, no room for a page`
                        }
                        onChange={() => {
                          setSheet(1);
                          onOptionChange('perSheet', value);
                        }}
                      />
                      <span
                        className="sheet-choice-grid"
                        aria-hidden="true"
                        style={{
                          gridTemplateColumns: `repeat(${shape?.[0] ?? 1}, 1fr)`,
                          gridTemplateRows: `repeat(${shape?.[1] ?? 1}, 1fr)`,
                        }}
                      >
                        {CHOICE_CELLS.slice(0, value).map((cellNumber) => (
                          <span key={cellNumber} className="sheet-choice-cell" />
                        ))}
                      </span>
                      <span className="sheet-choice-label">
                        {value}
                        <span className="visually-hidden"> per sheet</span>
                      </span>
                      {/* What this layout leaves to a page, at the stock and gap currently on screen: the caption the
                          old dropdown could not give, and the answer to "will this still be readable". */}
                      <span className="sheet-choice-note">
                        {cell ? `${mmWhole(cell.widthPt)}×${mmWhole(cell.heightPt)}` : 'no room'}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* The gap's own four picks, beside the layouts they change; the panel's number box takes any value in range. */}
            <div className="sheet-group sheet-group-gap">
              <span className="small strong">Gap</span>
              <div className="sheet-gaps">
                {[0, 3, 6, 12].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="sheet-chip-gap"
                    data-active={gapMm === value ? 'true' : 'false'}
                    // The visible text is a length and nothing else — `12 mm` beside a heading the screen reader cannot
                    // attach to it — so the name says what the number sets. Same argument as `rotate`'s angle buttons.
                    aria-label={`Gap ${value === 0 ? 'none' : `${value} mm`}`}
                    aria-pressed={gapMm === value}
                    disabled={locked === true}
                    onClick={() => onOptionChange('gap', value)}
                  >
                    {value === 0 ? 'none' : `${value} mm`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <span className="sheet-summary tiny" data-tone={verdict.tone}>
            {verdict.sentence}
            {emptySlots > 0
              ? ` ${emptySlots} slot${emptySlots === 1 ? '' : 's'} on sheet ${sheetCount} stay empty.`
              : ''}
          </span>

          {verdict.tone === 'blocked' ? (
            <Alert tone="warning" title="This run would be refused">
              <span className="small">
                Split the document first, or raise the pages per sheet so it fits your plan.
              </span>
            </Alert>
          ) : null}
        </div>
      </Card>

      {file && openPage != null ? (
        <PageLightbox
          file={file}
          name={row.name}
          page={openPage}
          pages={row.pages}
          onPage={(next) => setOpenPage(next)}
          onClose={() => setOpenPage(null)}
        />
      ) : null}
    </div>
  );
}
