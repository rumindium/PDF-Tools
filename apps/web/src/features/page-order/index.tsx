import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import {
  IconArrowLeft,
  IconArrowRight,
  IconGrip,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconReorder,
  IconSwap,
  IconUpload,
} from '../../components/icons';
import { Alert, Button, Card } from '../../components/ui';
import { PageLightbox, PagePreview } from '../preview';
import { type BoardRow, DocumentRow, Dropzone } from '../uploader';
import {
  MAX_COPIES,
  addCopy,
  clearCopies,
  copyCount,
  describeArrangement,
  dropTargetIndex,
  isDocumentOrder,
  moveSlot,
  neighbourIndex,
  optionsPatch,
  outputCount,
  removeCopy,
  slotsFromOptions,
  withReverse,
} from './model';

/**
 * `reorder-pages` as a board of its own pages (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.1, `docs/0-UI-DESIGN.md` §3.3).
 *
 * The tool's whole product is the arrangement of a document's pages, and until this screen existed the form asked for
 * that arrangement **as typed page numbers** — `order` as a permutation, `duplicate` as a list, `reverse` as a switch.
 * Asking somebody to type a permutation of a document they are looking at is the worst input in the catalogue (defect
 * 226): it is a sentence about pages that are already on screen, it has to be complete to be valid at all (the handler
 * refuses an `order` that does not use every page exactly once), and there is no way to read it back to see whether it is
 * the arrangement you meant.
 *
 * So the pages are what is arranged. This screen is one document and one board:
 *
 *  - **The document** (left): the file, its own first page, its facts, and the three things a person does to it. That row
 *    is `DocumentRow`, shared with the plan preview, because it is the same row about the same kind of file.
 *  - **The order** (right, wider): the output sequence, page by page, *in the order it will be written*. A tile is one
 *    page of the source plus the copies that follow it, so the board and the job's output are the same sequence — which
 *    is the only reason a preview of this tool is worth drawing at all.
 *
 * Four ways to arrange, because a board that can only be dragged is a board half the users cannot arrange:
 *
 *  - **drag** a tile onto another, before or after it, with the landing edge drawn on the tile it will land against
 *    (`dropTargetIndex` in `./model.ts` — the off-by-one that removal-first creates, with tests beside it);
 *  - **arrow buttons** on the tile, for touch and for anyone who wants a visible control;
 *  - **`Alt+←/→`** (and `↑/↓`, because the grid is read both ways) with a tile focused, and the caret follows the page it
 *    just moved, so a run of keypresses keeps working;
 *  - the **toolbar**: `Reverse`, `Reset order` and `Remove copies` — the three things a person reaches for that would
 *    otherwise be a hand-built arrangement, and the reason the `reverse` option no longer needs a switch of its own.
 *
 * **Everything below the bits is `./model.ts`** — a pure, tested module: which slots the options mean, what the slots
 * mean as options, the output sequence, the drop arithmetic, and the sentence at the bottom. Nothing here computes an
 * arrangement of its own, so the board, the preview and the payload cannot disagree.
 */

/** The options this board is the *only* editor of: the keys a `page-order` control declared. */
export interface PageOrderPreviewProps {
  rows: BoardRow[];
  values: Record<string, unknown>;
  /** The option keys the catalogue declared with a `page-order` control, e.g. `['order', 'duplicate', 'reverse']`. */
  keys: string[];
  /** The catalogue's own label for the arrangement (`New page order`), so this screen adds no copy of its own. */
  label: string;
  hint?: string;
  /** The tool's title, for the empty state's heading — the one line the plan preview leaves to the tool page. */
  title: string;
  accept: string;
  acceptLabel: string;
  maxFileMb: number;
  dropHint: string;
  multiple: boolean;
  /** Whether the **drop target** refuses a file: the plan preview's own rule (`gated || the file ceiling is reached`). */
  disabled?: boolean;
  /**
   * Whether the **arrangement** is locked, which is a different question with a different answer.
   *
   * The drop target stops accepting the moment this tool's single file is in — one document is all it takes, and
   * `capacityReached` is permanently true for a one-input tool. Reading that as "this run is over" locked the board
   * every time a document arrived: measured in the stack, both toolbar buttons came back `disabled` and no tile could be
   * dragged, so the screen drew an arrangement that could not be arranged. What actually locks the board is the gate:
   * a caller with no account is walked to sign-in before they can arrange anything.
   */
  locked?: boolean;
  rejections: string[];
  onFiles: (files: FileList | File[]) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  /** The options the arrangement means, keyed — written in one call so the form cannot hold a different arrangement. */
  onChange: (patch: Record<string, unknown>) => void;
}

export function PageOrderPreview({
  rows,
  values,
  keys,
  label,
  hint,
  title,
  accept,
  acceptLabel,
  maxFileMb,
  dropHint,
  multiple,
  disabled,
  locked,
  rejections,
  onFiles,
  onRemove,
  onRetry,
  onChange,
}: PageOrderPreviewProps) {
  const [openPage, setOpenPage] = useState<number | null>(null);
  const row = rows[0] ?? null;
  const total = row?.pages ?? null;
  const slots = useMemo(() => slotsFromOptions(values, total), [values, total]);

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

  const head = (heading: string) => (
    <div className="card-head">
      <span className="card-head-icon" aria-hidden="true">
        <IconUpload size={15} />
      </span>
      <span className="label">{heading}</span>
      <span className="tiny faint">
        {acceptLabel} · {maxFileMb} MB
      </span>
    </div>
  );

  // Before a document is in there is one card and one action: the pages of a document that does not exist yet cannot be
  // arranged, and the drop target is the only thing on this page that has no alternative.
  if (!row) {
    return (
      <div className="tool-single">
        <Card className="card-pad upload-card" data-empty="true">
          <div className="stack">
            {head(`Add a document to ${title}`)}
            <Dropzone onFiles={onFiles} accept={accept} multiple={multiple} disabled={disabled} hint={dropHint} />
            {rejectionsAlert}
          </div>
        </Card>
      </div>
    );
  }

  return (
    // Stacked, not split: this tool's product is a **row of tiles**, and a row that wraps at two thirds of the page is
    // the one thing this screen may not do — the answer to "what comes after what" is the row itself. The document card
    // is one band on top and the arrangement gets the whole width under it (`.tool-split-board.tool-stacked`).
    <div className="tool-split tool-split-board tool-stacked">
      <Card className="card-pad upload-card" data-empty="false">
        <div className="stack">
          {head('Your document')}
          <DocumentRow row={row} onRemove={onRemove} onRetry={onRetry} onPreview={() => setOpenPage(1)} />
          {rejectionsAlert}
        </div>
      </Card>

      <Card className="card-pad order-card anim-pop">
        <div className="stack">
          <div className="card-head">
            <span className="card-head-icon" aria-hidden="true">
              <IconReorder size={15} />
            </span>
            <span className="label">{label}</span>
            <span className="tiny faint">
              {slots.length} page{slots.length === 1 ? '' : 's'} · {outputCount(slots)} out
            </span>
          </div>

          {hint ? <span className="tiny faint">{hint}</span> : null}

          <OrderToolbar
            slots={slots}
            disabled={locked === true}
            onChange={(next) => onChange(optionsPatch(next, keys))}
          />

          <OrderPages
            slots={slots}
            file={row.sourceFile}
            pages={row.pages}
            disabled={locked === true}
            onChange={(next) => onChange(optionsPatch(next, keys))}
            onOpen={setOpenPage}
          />

          <span className="order-summary tiny" data-tone={isDocumentOrder(slots) ? 'same' : 'changed'}>
            {describeArrangement(slots)}
          </span>
        </div>
      </Card>

      {row.sourceFile && openPage != null ? (
        <PageLightbox
          file={row.sourceFile}
          name={row.name}
          page={openPage}
          pages={row.pages}
          onPage={(page) => setOpenPage(page)}
          onClose={() => setOpenPage(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The three buttons that are not a tile: reverse the document, put it back in its own order, and take every copy off.
 *
 * They exist because each of them is otherwise a hand-built arrangement — reversing twelve pages by hand is eleven
 * drags that mean the same thing — and because the `reverse` option used to be a switch here. It is not a switch any
 * more: it is a button, and the arrangement it produces is written to `order` like every other arrangement, so pressing
 * it and dragging the pages yourself end in the same value (defect 226's whole point).
 */
function OrderToolbar({
  slots,
  disabled,
  onChange,
}: {
  slots: ReturnType<typeof slotsFromOptions>;
  disabled: boolean;
  onChange: (slots: ReturnType<typeof slotsFromOptions>) => void;
}) {
  const copies = copyCount(slots);
  const untouched = isDocumentOrder(slots);

  return (
    <div className="order-actions">
      <Button size="sm" disabled={disabled || slots.length < 2} onClick={() => onChange(withReverse(slots))}>
        <IconSwap size={14} />
        Reverse
      </Button>
      <Button
        size="sm"
        disabled={disabled || untouched}
        onClick={() => onChange([...slots].sort((a, b) => a.page - b.page))}
      >
        <IconRefresh size={14} />
        Reset order
      </Button>
      {copies > 0 ? (
        <Button size="sm" disabled={disabled} onClick={() => onChange(clearCopies(slots))}>
          <IconMinus size={14} />
          Remove {copies} cop{copies === 1 ? 'y' : 'ies'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The pages in output order, and the only editing surface this tool has.
 *
 * A tile is a **slot**: a page of the source, its position in the output, and how many copies follow it. The position
 * plate is the output's numbering and the source page number under it is the document's, because those are two
 * different facts and only one of them is what the person is choosing — `3` in the top-left corner under the plate
 * `1` is page 3 of the file now sitting first.
 *
 * The copy stepper shows the **total** number of times the page appears (`1` by default, `2` once duplicated), not the
 * number of extra copies: "how many times will this page be in the file" is the question somebody adding a copy is
 * asking, and the answer to it is a number they can check against the tile they can see.
 */
function OrderPages({
  slots,
  file,
  pages,
  disabled,
  onChange,
  onOpen,
}: {
  slots: ReturnType<typeof slotsFromOptions>;
  file: File | null;
  pages: number | null;
  disabled: boolean;
  onChange: (slots: ReturnType<typeof slotsFromOptions>) => void;
  onOpen: (page: number) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; side: 'before' | 'after' } | null>(null);
  /** The tile a move just landed on, so the caret follows the **page** rather than staying where the tile used to be. */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  // By DOM id rather than by a ref, because the tile that has to receive the caret is the one the **move** landed on
  // and not the one the button belonged to: after a splice, the element under the pointer is a different tile. State
  // keyed on the request, like the rows control, so it works for a move that changes nothing else on screen.
  useEffect(() => {
    if (focusIndex == null) return;
    document.getElementById(`order-shot-${focusIndex}`)?.focus();
    setFocusIndex(null);
  }, [focusIndex]);

  const commit = (next: ReturnType<typeof slotsFromOptions>, focus?: number) => {
    setFocusIndex(focus ?? null);
    onChange(next);
  };

  const move = (from: number, to: number | null) => {
    if (to == null) return;
    commit(moveSlot(slots, from, to), to);
  };

  /** Which half of a tile the pointer is over — the difference between landing before it and after it. */
  const sideOf = (event: DragEvent<HTMLElement>): 'before' | 'after' => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left + box.width / 2 ? 'before' : 'after';
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLElement>) => {
    if (disabled || !event.altKey) return;
    const direction =
      event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : null;
    if (direction == null) return;
    event.preventDefault();
    move(index, neighbourIndex(index, direction, slots.length));
  };

  const last = slots.length - 1;

  return (
    <ol className="order-pages" aria-label="Output page order">
      {slots.map((slot, index) => {
        const appears = slot.copies + 1;
        return (
          <li className="order-cell" key={`${slot.page}-${index}`}>
            <div
              className="order-tile"
              data-dragging={dragging === index}
              data-over={over?.index === index ? over.side : undefined}
              draggable={!disabled}
              onDragStart={(event) => {
                if (disabled) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without payload, and the index travels with it so a drop can name its
                // source even if this element unmounts mid-drag.
                event.dataTransfer.setData('text/plain', String(index));
                setDragging(index);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(event) => {
                if (disabled || dragging == null || dragging === index) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setOver({ index, side: sideOf(event) });
              }}
              onDrop={(event) => {
                if (disabled) return;
                const from = dragging ?? Number(event.dataTransfer.getData('text/plain'));
                if (!Number.isInteger(from) || from === index) return;
                event.preventDefault();
                move(from, dropTargetIndex(from, index, sideOf(event), slots.length));
                setDragging(null);
                setOver(null);
              }}
            >
              {/*
                The tile's own button, and the tile's keyboard handle. A drag grip that is a `<button>` would be a control
                whose click does nothing; this one already has a click (look at the page), so `Alt`+arrows while it is
                focused is the keyboard's way to move the page without a second, invisible tab stop per tile.
              */}
              <button
                type="button"
                id={`order-shot-${index}`}
                className="order-shot"
                aria-label={`Page ${slot.page} of ${pages ?? '?'}, position ${index + 1} of ${slots.length}${
                  slot.copies > 0 ? `, repeated ${appears} times` : ''
                } — look closer, or hold Alt and press an arrow to move it`}
                title="Look closer"
                onClick={() => onOpen(slot.page)}
                onKeyDown={(event) => onKeyDown(index, event)}
              >
                <PagePreview
                  file={file}
                  page={slot.page}
                  box={{ width: 150, height: 200 }}
                  alt={`Page ${slot.page} of ${pages ?? '?'}`}
                />
                {slot.copies > 0 ? (
                  <span className="order-copies" title={`This page appears ${appears} times`}>
                    ×{appears}
                  </span>
                ) : null}
              </button>

              <span className="order-pos" aria-hidden="true">
                {index + 1}
              </span>
              <span className="order-grip" aria-hidden="true">
                <IconGrip size={13} />
              </span>

              <span className="order-tile-body">
                <span className="order-tile-top">
                  <span className="order-from">
                    page <strong>{slot.page}</strong>
                  </span>
                  <span className="order-copy-step">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`One copy fewer of page ${slot.page}`}
                      disabled={disabled || slot.copies === 0}
                      onClick={() => commit(removeCopy(slots, slot.page), index)}
                    >
                      <IconMinus size={13} />
                    </Button>
                    <span className="order-copy-count" title={`Page ${slot.page} in the output ${appears} times`}>
                      {appears}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`One more copy of page ${slot.page}, right after it`}
                      disabled={disabled || slot.copies >= MAX_COPIES}
                      onClick={() => commit(addCopy(slots, slot.page), index)}
                    >
                      <IconPlus size={13} />
                    </Button>
                  </span>
                </span>
                <span className="order-tile-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move page ${slot.page} earlier in the output`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <IconArrowLeft size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move page ${slot.page} later in the output`}
                    disabled={disabled || index === last}
                    onClick={() => move(index, index + 1)}
                  >
                    <IconArrowRight size={14} />
                  </Button>
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
