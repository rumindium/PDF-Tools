import type { UploadedFile } from '@pdftools/contracts/api';
import type { CatalogEntry } from '@pdftools/contracts/tools';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconCrop, IconUpload } from '../../components/icons';
import { Alert, Button, Card, Field, TextInput } from '../../components/ui';
import { PageLightbox, PagePreview } from '../preview';
import { pageSizePoints } from '../preview/render';
import { OptionsPanel } from '../tool-shell/options-panel';
import { type BoardRow, DocumentRow, Dropzone } from '../uploader';
import {
  CROP_HANDLES,
  type CropFractions,
  type CropFrame,
  type CropHandle,
  type CropUnits,
  afterDrag,
  clampFractions,
  croppedPages,
  describeCrop,
  equalInsets,
  evenInsets,
  fractionsFromInsets,
  inputStep,
  insetsFromFractions,
  isCropped,
  isWholePage,
  keptArea,
  readInsets,
  toggleCroppedPage,
} from './model';

/**
 * `crop` as a box you draw on the page (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.3, `0-UI-DESIGN.md` §6.4).
 *
 * This was the last option in the product that was still typed as **JSON**: `{ "top": 20, "right": 20, "bottom": 20,
 * "left": 20 }` — four numbers in a text box, for "trim 20 mm off every side", on a screen that could draw the page
 * they describe. It is also the option where being wrong is least visible, because the box goes onto `/CropBox` only:
 * a page cropped 3 mm too far looks like a page.
 *
 * So the page is the control, and the four numbers are a read-out of it:
 *
 *  - **The box is drawn where the value says.** The overlay's geometry *is* the option (`fractionsFromInsets` ⇄
 *    `insetsFromFractions`), so the picture and the numbers cannot disagree — every write, from a drag or from a
 *    keystroke, goes through the model and nothing else writes the key.
 *  - **Eight handles and a body.** An edge moves that edge, a corner moves both of its edges, and the body *moves* the
 *    rectangle without resizing it — the gesture a form cannot express at all, and the reason a drawn box beats four
 *    typed numbers.
 *  - **What will be thrown away is the dark part.** The kept rectangle wears a very large `box-shadow`, so the page
 *    outside it is visibly the part that goes — and the page stays readable through it, because a preview that hid the
 *    content being removed could not be used to decide how much to remove.
 *  - **The keyboard path is the four boxes and the preset chips**, not the pointer: each inset is a labelled input in
 *    the unit the user chose, and a box the engine would *skip* (under `CROP_MIN_KEPT_RATIO` of the page) is drawn and
 *    named rather than silently refused — the sentence under the board quotes the engine's own rule.
 *  - **Which pages the box lands on is decided on the pages themselves.** `pages` used to be reachable only from the
 *    advanced panel, as rows of `From`/`To` boxes forty centimetres below the document they are about. Now every page is
 *    a tile under the drawing: its number navigates the box and its corner control is that page's membership, which is
 *    the same value the rows edit — one option, two renderings, and neither is a second answer (`croppedPages`,
 *    `toggleCroppedPage` in `./model`, and `SelectionDirection`'s third reading in `../tool-shell/page-rows-model`).
 *
 * The page *count* is the API's probe and the page *size* comes from the document itself (`pageSizePoints`), because a
 * percentage of a page is only meaningful against its true shape. A page carrying `/Rotate` is previewed the way a
 * reader will show it, which is also the shape the user is drawing on.
 */

const UNITS: readonly CropUnits[] = ['mm', 'pt', 'percent'];

function readUnits(value: unknown): CropUnits {
  return typeof value === 'string' && (UNITS as readonly string[]).includes(value) ? (value as CropUnits) : 'mm';
}

/** The unit a number is written in, for a label: `20 mm`, `2 %`. */
function unitSuffix(units: CropUnits): string {
  return units === 'percent' ? '%' : units;
}

/**
 * The ladder the quick chips offer, **in the unit the user is working in** — the amounts a person actually trims a
 * document by, converted rather than restated: 5/10/15/20 mm is the same trim whether it is written in millimetres or
 * in points, and the chips are the whole reason a first-time user does not have to know what an inset is.
 *
 * Percent is the one that cannot be converted, and it is not a defect: a percentage *is* per axis, so "5 %" means 5 %
 * of the width and 5 % of the height, and the sentence below says so in those words.
 */
const PRESETS_MM: readonly number[] = [5, 10, 15, 20];
const PRESETS_PERCENT: readonly number[] = [2, 5, 10, 15];

function evenPresets(units: CropUnits): number[] {
  if (units === 'percent') return [...PRESETS_PERCENT];
  if (units === 'mm') return [...PRESETS_MM];
  return PRESETS_MM.map((mm) => Math.round((mm * 72) / 25.4));
}

/** Millimetres, for the page-size line: the unit people read a paper size in. */
function paperSize(widthPt: number, heightPt: number): string {
  const mm = (points: number) => Math.round((points * 25.4) / 72);
  return `${mm(widthPt)} × ${mm(heightPt)} mm`;
}

export function PageCropPreview({
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
  onFiles: (files: FileList | File[]) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onOptionChange: (key: string, value: unknown) => void;
}) {
  const row = rows[0] ?? null;
  const [openPage, setOpenPage] = useState<number | null>(null);
  /**
   * The page the box is drawn on. One page is a picture of the document and not a per-page plan — the insets apply to
   * every page the selection names, measured on each page's own size — so this picks what is on screen, not what is
   * cropped.
   */
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<CropFrame | null>(null);
  /** The element the pointer is measured against: the *page*, never the stage around it. */
  const surface = useRef<HTMLDivElement>(null);
  const [grabbing, setGrabbing] = useState<CropHandle | null>(null);
  const from = useRef<{
    handle: CropHandle;
    x: number;
    y: number;
    start: CropFractions;
    width: number;
    height: number;
  } | null>(null);

  // The page's own size, from the document. A page whose size cannot be read is a page no box can be drawn on, and the
  // board says that rather than drawing a rectangle against a guess.
  useEffect(() => {
    let cancelled = false;
    setSize(null);
    if (!row?.sourceFile) return;
    void pageSizePoints(row.sourceFile, page).then((measured) => {
      if (!cancelled) setSize(measured);
    });
    return () => {
      cancelled = true;
    };
  }, [row?.sourceFile, page]);

  const units = readUnits(values.units);
  const auto = values.auto === true;
  const insets = useMemo(() => readInsets(values.box), [values.box]);
  /**
   * The box the tool starts from, read from the catalog rather than restated here: the panel seeds the form with it,
   * the handler requires *some* box, and Reset has to mean the same thing in both places.
   */
  const start = useMemo(
    () => readInsets(tool.optionsUi.find((field) => field.control === 'crop-box')?.default),
    [tool],
  );
  const startValue = equalInsets(start);
  const atStart = startValue != null && equalInsets(insets) === startValue;
  // The value as drawn: `readInsets` clamps nothing, so a typed box the engine would skip is still *reported* by the
  // sentence — but the overlay cannot draw a negative rectangle, so the picture uses the clamped reading.
  const typed = useMemo(() => (size ? fractionsFromInsets(insets, units, size) : null), [insets, units, size]);
  const drawn = useMemo(() => (typed ? clampFractions(typed) : null), [typed]);
  const summary = useMemo(
    () => (typed && size ? describeCrop(typed, units, size) : { sentence: '', tone: 'none' as const }),
    [typed, units, size],
  );

  const count = row?.pages ?? files[0]?.pages ?? null;
  /**
   * The pages the box is written onto: `null` is **every page**, which is what an absent `pages` means to the handler —
   * not "none", and not "unknown". The board reads it once here and every rendering below (the scope line, the strip,
   * the note about the page on screen) is derived from it, so the three cannot say different things.
   */
  const cropped = croppedPages(values.pages, count);
  const wholeDocument = cropped == null;
  const croppedCount = wholeDocument ? (count ?? 0) : cropped.length;
  /** The page on screen is outside the selection, so nothing drawn on it is going to be written. */
  const pageOutsideSelection = !wholeDocument && count != null && !isCropped(values.pages, page, count);
  const trimmed = drawn != null && !isWholePage(drawn);

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

  const head = (
    <div className="card-head">
      <span className="card-head-icon" aria-hidden="true">
        <IconUpload size={15} />
      </span>
      <span className="label">Add a document to {title}</span>
      <span className="tiny faint">
        {acceptLabel} · {maxFileMb} MB
      </span>
    </div>
  );

  if (!row) {
    return (
      <div className="tool-single">
        <Card className="card-pad upload-card" data-empty="true">
          <div className="stack">
            {head}
            <Dropzone onFiles={onFiles} accept={accept} multiple={multiple} disabled={disabled} hint={dropHint} />
            {rejectionsAlert}
          </div>
        </Card>
      </div>
    );
  }

  /** One write, always through the model: the board never sets an option key by hand. */
  const write = (next: CropFractions) => {
    if (!size) return;
    onOptionChange('box', insetsFromFractions(clampFractions(next), units, size));
  };

  /**
   * The panel's writes, with the one interception the board owes the user: `units`.
   *
   * The four numbers are a **length**, so changing the unit they are read in has to convert them. The panel writes one
   * key, which is right for every other option here — and for this one it turns "20 mm off every edge" into "20 % off
   * every edge", a crop five times as deep, from a control that looks like a display preference. The fractions are
   * unit-free, so the conversion is the model's own two functions and neither number is ever restated by hand.
   */
  const onPanelChange = (key: string, value: unknown) => {
    if (key !== 'units') {
      onOptionChange(key, value);
      return;
    }
    const next = readUnits(value);
    if (next === units) return;
    onOptionChange('units', next);
    if (!size || auto || !typed) return;
    onOptionChange('box', insetsFromFractions(clampFractions(typed), next, size));
  };

  const begin = (handle: CropHandle) => (event: React.PointerEvent) => {
    // The page element's own measured size is the only place pixels become fractions, so everything below this line is
    // about a page and never about a viewport — and the stage may letterbox it, which is why the stage is not measured.
    const rect = surface.current?.getBoundingClientRect();
    if (!drawn || !rect || rect.width === 0 || rect.height === 0 || locked || auto) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    from.current = { handle, x: event.clientX, y: event.clientY, start: drawn, width: rect.width, height: rect.height };
    setGrabbing(handle);
  };

  const onMove = (event: React.PointerEvent) => {
    const drag = from.current;
    if (!drag) return;
    write(
      afterDrag(drag.start, drag.handle, (event.clientX - drag.x) / drag.width, (event.clientY - drag.y) / drag.height),
    );
  };

  const end = (event: React.PointerEvent) => {
    if (!from.current) return;
    from.current = null;
    setGrabbing(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const boxField = tool.optionsUi.find((field) => field.control === 'crop-box');
  const stepperDisabled = count != null ? page >= count : true;

  //
  // The strip's tiles are the document's own shape too, and for the same reason the big page is: a page drawn into a
  // differently-shaped thumbnail is a picture of a different sheet, and the drawing above the strip is meant to be
  // recognised in it. One ratio for every tile, read from the page currently measured — the document's pages are assumed
  // to agree, which is what the board already assumes when it draws the box in fractions (`4/3` is only the fallback for
  // a page whose size could not be measured).
  const thumbRatio = size && size.widthPt > 0 ? size.heightPt / size.widthPt : 4 / 3;

  const renderBox = size
    ? {
        // A render big enough to read at the size it is displayed, without asking for a canvas nobody needs: the aspect
        // ratio is the page's own, so the element's layout is the page's shape whatever the CSS does with it.
        width: Math.min(1200, Math.round(900)),
        height: Math.max(1, Math.round((900 * size.heightPt) / size.widthPt)),
      }
    : { width: 760, height: 1000 };

  const rect = drawn
    ? {
        left: `${drawn.left * 100}%`,
        top: `${drawn.top * 100}%`,
        width: `${Math.max(0, 1 - drawn.left - drawn.right) * 100}%`,
        height: `${Math.max(0, 1 - drawn.top - drawn.bottom) * 100}%`,
      }
    : null;

  return (
    //
    // Stacked, not split: the picture is where the value is written from, and at two thirds of the page the box being
    // dragged was the smaller half of the screen. Full width, the page is bigger (880 px above) and the filmstrip under
    // it has the room the page *numbers* need to be a control rather than a list (`.tool-split-crop.tool-stacked`).
    <div className="tool-split tool-split-crop tool-stacked">
      <Card className="card-pad upload-card" data-empty="false">
        <div className="stack">
          <div className="card-head">
            <span className="card-head-icon" aria-hidden="true">
              <IconUpload size={15} />
            </span>
            <span className="label">Your document</span>
            <span className="tiny faint">{size ? paperSize(size.widthPt, size.heightPt) : 'page size unknown'}</span>
          </div>
          <DocumentRow row={row} onRemove={onRemove} onRetry={onRetry} onPreview={() => setOpenPage(page)} />
          {rejectionsAlert}

          <span className="tiny faint">
            {auto
              ? 'Auto-crop measures each page by itself, so the page below is a look at the document rather than at a box.'
              : 'Drag inside the page to move the box, or pull an edge or a corner — the four numbers follow. The pale part is what will be thrown away.'}
          </span>
        </div>
      </Card>

      <Card className="card-pad crop-card anim-pop">
        <div className="stack">
          <div className="card-head">
            <span className="card-head-icon" aria-hidden="true">
              <IconCrop size={15} />
            </span>
            <span className="label">{boxField?.label ?? 'Crop box'}</span>
            <span className="row tiny faint" style={{ gap: 6, alignItems: 'center' }}>
              {auto ? (
                <span>Every page, measured by the engine</span>
              ) : count != null && count > 1 ? (
                //
                // Which pages the box is written onto, said in the head — and the one click back to "all of them". The
                // scope belongs next to the page counter rather than in the form below: it is a fact about the document
                // on screen, and it is the difference between "this box" and "this box, on four pages".
                <span className="crop-scope">
                  <span data-tone={wholeDocument ? 'none' : 'changed'}>
                    {wholeDocument ? 'Every page' : `${croppedCount} of ${count} pages`}
                  </span>
                  {wholeDocument ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={locked === true}
                      onClick={() => onOptionChange('pages', undefined)}
                    >
                      Crop all
                    </Button>
                  )}
                </span>
              ) : null}
              {auto ? null : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Draw the box on the previous page"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    ‹
                  </Button>
                  <span>
                    Page {page}
                    {count != null ? ` of ${count}` : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Draw the box on the next page"
                    disabled={stepperDisabled}
                    onClick={() => setPage(page + 1)}
                  >
                    ›
                  </Button>
                </>
              )}
            </span>
          </div>

          <div
            className="crop-stage"
            data-grabbing={grabbing != null ? 'true' : 'false'}
            onPointerMove={onMove}
            onPointerUp={end}
            onPointerCancel={end}
          >
            {/* The page, drawn from the document's own bytes at the document's own shape: the overlay below is
                positioned in percentages of *this* element, so the picture and the value share one geometry. */}
            <div
              className="crop-page"
              ref={surface}
              // The ratio as a *number*, because the stylesheet multiplies the height ceiling by it to work out how wide
              // a page that short may be — which is the only way both limits can be honoured without squashing a page.
              style={size ? ({ '--crop-ratio': size.widthPt / size.heightPt } as React.CSSProperties) : undefined}
            >
              <PagePreview
                file={row.sourceFile}
                page={page}
                box={renderBox}
                alt={`${row.name}, page ${page}, with the crop box drawn on it`}
              />

              {rect && !auto ? (
                <>
                  <div
                    className="crop-box"
                    style={rect}
                    data-grabbing={grabbing === 'box' ? 'true' : 'false'}
                    onPointerDown={begin('box')}
                  >
                    {CROP_HANDLES.map((handle) => (
                      <button
                        key={handle}
                        type="button"
                        className={`crop-handle crop-handle-${handle}`}
                        tabIndex={-1}
                        aria-hidden="true"
                        onPointerDown={begin(handle)}
                      />
                    ))}
                    {/* What the box adds up to, on the box — the one number a person checks while dragging, and the
                        only place the fractions the arithmetic works in ever reaches them. */}
                    <span className="crop-measure" data-tone={trimmed ? 'changed' : 'none'}>
                      {drawn && trimmed
                        ? `${Math.round(keptArea(drawn) * 100)}% of the page kept`
                        : 'Whole page — the pale frame is what goes'}
                    </span>
                  </div>
                </>
              ) : null}

              {auto ? (
                <div className="crop-auto">
                  <span className="small strong">Auto-crop to content</span>
                  <span className="tiny">
                    Every page is measured by the engine and trimmed to its own content box. A box drawn here would be
                    ignored, so there is none — switch auto-crop off to draw one.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={locked === true}
                    onClick={() => onOptionChange('auto', false)}
                  >
                    Draw a box instead
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          {/*
           * The filmstrip: the same `pages` value the advanced rows edit, drawn on the pages it is about.
           *
           * Two gestures per tile, and neither is a second answer to the other. The **page** navigates: a click puts the
           * box on that page, which is what the drawing above is for. The **number** is the membership toggle, with an
           * accessible name that says which way it will move this page, and it writes through `toggleCroppedPage` — the
           * model that knows an empty selection means *every page* and that a one-page document cannot be told to crop
           * nothing (`null` there, which the disabled state here states before the click).
           */}
          {!auto && count != null && count > 1 && row.sourceFile ? (
            // A list rather than a group of divs: the pages of a document are a sequence, and the element that says so
            // is the one a screen reader announces the length of.
            <ul className="crop-strip" aria-label="Pages the crop box is written on">
              {Array.from({ length: count }, (_, index) => index + 1).map((number) => {
                const on = isCropped(values.pages, number, count);
                return (
                  <li
                    key={number}
                    className="crop-strip-tile"
                    data-current={number === page ? 'true' : 'false'}
                    data-cropped={on ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="crop-strip-page"
                      aria-label={`Draw the box on page ${number}`}
                      aria-current={number === page ? 'true' : undefined}
                      onClick={() => setPage(number)}
                    >
                      {/*
                       * The frame around the drawing, and it is what keeps the tile from being one: `PagePreview`
                       * renders `.page-shot` with `position: absolute; inset: 0`, so it fills its nearest positioned
                       * ancestor — the tile — and would draw the page straight over the number below it (found by the
                       * browser case: the click on the toggle hit the picture instead, defect 239).
                       */}
                      <span className="crop-strip-shot">
                        <PagePreview
                          file={row.sourceFile}
                          page={number}
                          box={{ width: 148, height: Math.max(1, Math.round(148 * thumbRatio)) }}
                          alt={`Page ${number}`}
                        />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="crop-strip-toggle"
                      aria-pressed={on}
                      aria-label={on ? `Leave page ${number} out of the crop` : `Crop page ${number} as well`}
                      title={on ? `Page ${number} is cropped` : `Page ${number} keeps its own crop box`}
                      disabled={locked === true || count === 1}
                      onClick={() => {
                        const next = toggleCroppedPage({ value: values.pages, page: number, pageCount: count });
                        if (next !== null) onOptionChange('pages', next);
                      }}
                    >
                      <span aria-hidden="true">{on ? `${number} \u2713` : `${number}`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/* The page on screen is outside the selection: the box is drawn, and nothing is going to be written. */}
          {pageOutsideSelection ? (
            <span className="tiny faint" data-testid="crop-page-outside">
              Page {page} keeps its own crop box — this one is only written onto the {croppedCount} pages marked ✓.{' '}
              <Button
                size="sm"
                variant="ghost"
                disabled={locked === true}
                onClick={() => {
                  const next = toggleCroppedPage({ value: values.pages, page, pageCount: count });
                  if (next !== null) onOptionChange('pages', next);
                }}
              >
                Crop page {page} too
              </Button>
            </span>
          ) : null}

          <span className="crop-summary tiny" data-tone={summary.tone}>
            {size ? summary.sentence : 'Waiting for the page size before the crop can be drawn.'}
          </span>

          {summary.tone === 'blocked' && !auto && size ? (
            <Alert tone="warning" title="This request cannot be sent as it stands">
              <span className="small">
                {isWholePage(typed ?? { top: 0, right: 0, bottom: 0, left: 0 })
                  ? 'Crop needs a box, or auto-crop. Drag an edge inwards, or type an inset below.'
                  : 'The engine skips a crop this small, so the page would come back untouched. Bring the edges outwards.'}
              </span>
            </Alert>
          ) : null}

          <div className="crop-inputs">
            {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
              <Field key={edge} label={edge[0]?.toUpperCase() + edge.slice(1)} htmlFor={`crop-${edge}`}>
                <span className="crop-input">
                  <TextInput
                    id={`crop-${edge}`}
                    type="number"
                    min={0}
                    step={inputStep(units)}
                    disabled={locked === true || !size || auto}
                    value={String(insets[edge])}
                    onChange={(event) => {
                      const parsed = Number.parseFloat(event.currentTarget.value);
                      onOptionChange('box', { ...insets, [edge]: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 });
                    }}
                  />
                  <span className="crop-input-unit" aria-hidden="true">
                    {unitSuffix(units)}
                  </span>
                </span>
              </Field>
            ))}
          </div>

          <div className="crop-presets">
            <span className="tiny strong">Even all round</span>
            {evenPresets(units).map((value) => {
              const active = equalInsets(insets) === value;
              return (
                <button
                  key={value}
                  type="button"
                  className="crop-chip"
                  data-active={active ? 'true' : 'false'}
                  aria-pressed={active}
                  disabled={locked === true || !size || auto}
                  onClick={() => onOptionChange('box', evenInsets(value))}
                >
                  {value} {unitSuffix(units)}
                </button>
              );
            })}
            <button
              type="button"
              className="crop-chip crop-chip-reset"
              aria-pressed={atStart}
              disabled={locked === true || !size || auto || atStart}
              title="Back to the box this tool starts from"
              onClick={() => onOptionChange('box', start)}
            >
              Reset
            </button>
          </div>

          <div className="crop-side">
            <OptionsPanel
              tool={tool}
              values={values}
              onChange={onPanelChange}
              files={files}
              order={order}
              renderFileOrder={false}
              renderPageOrder={false}
              renderPageTurn={false}
              renderCropBox={false}
            />
            <span className="tiny faint">
              {wholeDocument
                ? "The box is measured on each of the document's pages."
                : 'The box is measured on each page it applies to, so a page of a different size is trimmed by the same amounts.'}
            </span>
          </div>
        </div>
      </Card>

      {row.sourceFile && openPage != null ? (
        <PageLightbox
          file={row.sourceFile}
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
