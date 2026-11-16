import { useRef, useState } from 'react';
import { IconGrip, IconLock } from '../../components/icons';
import { Alert, Button } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { PageChips, PageLightbox, PagePreview, pageStrip } from '../preview';
import type { BoardRow, OrderSegment } from './order';

/**
 * The file board: the inputs, drawn as the pages they are (`docs/0-UI-DESIGN.md` §3.2, `0-FOLDER-STRUCTURE.md` §3).
 *
 * This is one surface instead of three. The page used to draw the uploads in a list (name, progress, remove), the
 * arrangement in a second list (numbered rows, up/down), and a bar of coloured slices claiming where each file would
 * land — for the same files, in three places. A row is a file *and* a position, because for a multi-input job those
 * are the same fact; and it is a **page**, because a list of names cannot answer the one question anybody checks
 * before merging two documents, which is whether the right file is the right way up.
 *
 * So a tile is: the document's own first page, its place in the order, and its facts. Clicking the page opens it
 * larger, at any page the count says exists.
 *
 * Three ways to change the order, on purpose:
 *
 *  - **drag** a tile, for a pointer;
 *  - **↑ / ↓** on a tile, because HTML5 drag-and-drop does not exist on touch devices and a board that can only be
 *    reordered with a mouse is a board half the users cannot reorder;
 *  - **`Alt+↑/↓`** with a tile focused, for the keyboard, without a tab stop per arrow button.
 *
 * The strip underneath is what the order *means*: each input's page span in the concatenation, from the page counts
 * the API probed at upload. It is the only preview of the result that can be drawn before the job runs, and hovering
 * either side lights the other, so a tile and its slice of the output are visibly the same thing.
 *
 * A tile whose bytes this browser cannot draw — an office document, before it is converted — keeps its place, its
 * number and its name, and says so with a glyph. Losing the preview must never mean losing the row.
 *
 * **`Ready` is the card's, not the tile's.** A green badge on every tile said the same thing once per file, which on a
 * twenty-file merge is twenty badges competing with the twenty pages they sit on. The honest place for it is the
 * heading: *the upload is finished and the API accepted it* is a fact about the request, and one badge at the top right
 * of the card states it once (`tools.$toolId.tsx`).
 */
export function FilesBoard({
  rows,
  segments,
  label,
  hint,
  reorderable = true,
  disabled,
  onReorder,
  onRemove,
  onRetry,
}: {
  rows: BoardRow[];
  segments: OrderSegment[];
  /** The catalogue's own label for the order control (`Merge order`), so the page adds no copy of its own. */
  label: string;
  hint?: string;
  /**
   * Whether this tool's request carries the arrangement at all.
   *
   * The catalogue decides (`file-order`); a board that offered a drag for a tool whose schema takes the files as an
   * unordered set would be offering to change something the API never reads.
   */
  reorderable?: boolean;
  disabled?: boolean;
  /** Indices into the order, which for a tile on the board is `position - 1`. */
  onReorder: (from: number, to: number) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  // Which file is open, and at which page. Held here rather than in the page because the lightbox belongs to the
  // board: it is one tile, opened.
  const [preview, setPreview] = useState<{ key: string; page: number } | null>(null);
  //
  // Which tile is being dragged is kept in a ref as well as in state, and the ref is the one the handlers decide with.
  // A drag is one interaction spread over several events, and the events that read this (`dragover`, `drop`) can fire
  // before React has committed the `dragstart` update — a stale `null` there is a drop that silently does nothing. The
  // state stays because the *rendering* should follow a re-render like any other (the lifted tile, the gap marker); the
  // ref is what makes the interaction correct rather than merely usually-right.
  const draggingRef = useRef<string | null>(null);

  if (rows.length === 0) return null;

  const placed = rows.filter((row) => row.position != null).length;
  const openRow = preview ? rows.find((row) => row.key === preview.key) : undefined;

  const dragIndex = (row: BoardRow): number | null => (row.position == null ? null : row.position - 1);

  const commit = (from: BoardRow, to: BoardRow) => {
    const fromIndex = dragIndex(from);
    const toIndex = dragIndex(to);
    if (fromIndex == null || toIndex == null) return;
    onReorder(fromIndex, toIndex);
  };

  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <span className="label">{label}</span>
        <span className="tiny faint">
          {disabled
            ? 'Add files to set the order.'
            : reorderable
              ? (hint ?? 'Drag a tile, or use ↑ ↓, to set the order.')
              : 'Add as many files as this tool takes.'}
        </span>
      </div>

      <ul className="board-grid">
        {rows.map((row) => {
          const draggable = reorderable && !disabled && row.position != null;
          const strip = pageStrip(row.pages);
          const shot = (
            <PagePreview
              file={row.sourceFile}
              page={1}
              box={{ width: 260, height: 340 }}
              alt={row.sourceFile ? `First page of ${row.name}` : `${row.name} — no page preview for this file type`}
            />
          );
          const overlays = (
            <>
              {/*
                The number is only drawn where it *means* something. For a tool whose request does not carry an
                arrangement (`reorderable` false) the files are an unordered set, and a `1` on the only tile would be
                claiming a position that nothing reads — the same reason the arrows and the grip are absent.
              */}
              {reorderable ? (
                row.position != null ? (
                  <span className="board-tile-pos">{row.position}</span>
                ) : (
                  <span className="board-tile-pos" data-unplaced="true">
                    ·
                  </span>
                )
              ) : null}
              {reorderable ? (
                <span className="board-tile-grip" aria-hidden="true">
                  <IconGrip size={15} />
                </span>
              ) : null}
              {row.encrypted ? (
                <span className="board-tile-lock">
                  <IconLock size={12} /> Locked
                </span>
              ) : null}
              {row.state !== 'done' ? (
                <span className="board-tile-state" data-state={row.state}>
                  {row.state === 'uploading' ? `${row.progress}%` : row.state === 'pending' ? 'Waiting…' : 'Failed'}
                </span>
              ) : null}
            </>
          );

          return (
            <li
              key={row.key}
              className="board-tile"
              // The tile itself is the keyboard handle: a drag handle that is a `<button>` would be a control whose
              // click does nothing, which is worse for a screen reader than a tile that says what it does.
              tabIndex={row.position != null ? 0 : -1}
              aria-label={
                !reorderable
                  ? row.name
                  : row.position != null
                    ? `Position ${row.position} of ${placed} — ${row.name}`
                    : `${row.name} — not in the order yet`
              }
              data-state={row.state}
              data-dragging={draggingKey === row.key}
              data-over={overKey === row.key && draggingKey !== row.key}
              data-highlight={highlightKey === row.key}
              data-unplaced={row.position == null}
              draggable={draggable}
              onMouseEnter={() => setHighlightKey(row.key)}
              onMouseLeave={() => setHighlightKey(null)}
              onDragStart={(event) => {
                if (!draggable) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without payload, and the key travels so a drop can name its source
                // even if this element unmounts mid-drag.
                event.dataTransfer.setData('text/plain', row.key);
                draggingRef.current = row.key;
                setDraggingKey(row.key);
              }}
              onDragEnd={() => {
                draggingRef.current = null;
                setDraggingKey(null);
                setOverKey(null);
              }}
              onDragOver={(event) => {
                if (draggingRef.current == null || disabled || row.position == null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setOverKey(row.key);
              }}
              onDrop={(event) => {
                // `getData` is readable here (the payload is only hidden during `dragover`), so it is the fallback if
                // the ref were ever lost mid-interaction — a drop that lands is worth more than a strict invariant.
                const sourceKey = draggingRef.current ?? event.dataTransfer.getData('text/plain');
                if (!sourceKey) return;
                event.preventDefault();
                const source = rows.find((entry) => entry.key === sourceKey);
                if (source) commit(source, row);
                draggingRef.current = null;
                setDraggingKey(null);
                setOverKey(null);
              }}
              onKeyDown={(event) => {
                if (row.position == null || !event.altKey) return;
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                onReorder(row.position - 1, row.position - 1 + (event.key === 'ArrowUp' ? -1 : 1));
              }}
            >
              {row.sourceFile ? (
                <button
                  type="button"
                  className="board-shot"
                  aria-label={`Preview ${row.name}`}
                  onClick={() => setPreview({ key: row.key, page: 1 })}
                >
                  {shot}
                  {overlays}
                </button>
              ) : (
                <span className="board-shot">
                  {shot}
                  {overlays}
                </span>
              )}

              <div className="board-tile-body">
                <span className="small strong truncate" title={row.name}>
                  {row.name}
                </span>
                <span className="tiny faint">
                  {row.pages != null ? `${row.pages} page${row.pages === 1 ? '' : 's'}` : 'pages unknown'} ·{' '}
                  {formatBytes(row.sizeBytes)}
                </span>

                {row.state === 'error' ? (
                  <Alert tone="danger">
                    <span className="tiny">{row.error ?? 'The upload failed.'}</span>
                    {row.errorCode ? <span className="mono tiny"> {row.errorCode}</span> : null}
                  </Alert>
                ) : row.state === 'done' ? null : (
                  <div className="bar" data-state="running">
                    <span style={{ width: `${row.state === 'pending' ? 4 : row.progress}%` }} />
                  </div>
                )}

                <div className="row-between" style={{ gap: 6 }}>
                  <PageChips
                    pages={strip.pages}
                    more={strip.more}
                    total={row.pages}
                    onOpen={(page) => {
                      if (row.sourceFile) setPreview({ key: row.key, page });
                    }}
                  />

                  <span className="row" style={{ gap: 2 }}>
                    {row.state === 'error' && row.localId ? (
                      <Button size="sm" onClick={() => onRetry(row.localId!)}>
                        Retry
                      </Button>
                    ) : null}

                    {reorderable && row.position != null && !disabled ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Move ${row.name} earlier`}
                          disabled={row.position === 1}
                          onClick={() => onReorder(row.position! - 1, row.position! - 2)}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Move ${row.name} later`}
                          disabled={row.position === placed}
                          onClick={() => onReorder(row.position! - 1, row.position!)}
                        >
                          ↓
                        </Button>
                      </>
                    ) : null}

                    {row.localId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${row.name}`}
                        onClick={() => onRemove(row.localId!)}
                      >
                        ✕
                      </Button>
                    ) : null}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {reorderable && segments.length > 1 ? (
        <div className="order-strip">
          <div
            className="order-strip-bar"
            role="img"
            aria-label={`Order: ${segments.map((segment) => segment.name).join(', then ')}`}
          >
            {segments.map((segment, index) => (
              <span
                key={segment.key}
                className="order-segment"
                data-tone={index % 5}
                data-dim={highlightKey != null && highlightKey !== segment.key}
                title={`${index + 1}. ${segment.name}${
                  segment.startPage != null ? ` — pages ${segment.startPage}–${segment.endPage}` : ' — length unknown'
                }`}
                onMouseEnter={() => setHighlightKey(segment.key)}
                onMouseLeave={() => setHighlightKey(null)}
              >
                <span className="order-segment-range">
                  {segment.startPage != null ? `${segment.startPage}–${segment.endPage}` : '?'}
                </span>
              </span>
            ))}
          </div>
          <div className="row-between wrap" style={{ gap: 8 }}>
            <span className="tiny faint">Where each file lands, in order</span>
            <span className="tiny faint">
              {/* A page count the API could not probe is shown as unknown rather than counted as zero. */}
              {segments.every((segment) => segment.pages != null)
                ? `${segments.reduce((total, segment) => total + (segment.pages ?? 0), 0)} pages in total`
                : 'some inputs have no page count yet'}
            </span>
          </div>
        </div>
      ) : null}

      {openRow?.sourceFile ? (
        <PageLightbox
          file={openRow.sourceFile}
          name={openRow.name}
          page={preview!.page}
          pages={openRow.pages}
          onPage={(page) => {
            // Clamped here so a held arrow key at either end is a no-op rather than a second clamp to the same page.
            const total = openRow.pages;
            const next = total != null ? Math.min(Math.max(1, page), total) : Math.max(1, page);
            setPreview({ key: openRow.key, page: next });
          }}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
