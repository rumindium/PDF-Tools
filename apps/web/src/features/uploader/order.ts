import type { UploadedFile } from '@pdftools/contracts/api';
import { formatBytes } from '../../lib/format';

/**
 * The ordering board's arithmetic — everything the file list needs to answer "what will come out?" without a job.
 *
 * Kept out of the component and out of the page for one reason: this is where the answers can be *wrong* (a reorder
 * that loses an entry, a page count that silently counts only the files whose count is known, a removal that resets
 * the order the user just set), and a pure function is the only shape of this that a test can hold. The component
 * that renders the board owns drag state; the meaning of a move lives here.
 *
 * The list is a list of **ids**, not of rows, because the same document may legitimately appear twice — merging a
 * PDF with itself is a real request — so position is the identity and the id is the value.
 */

/** One row on the board: the file at a position, resolved. */
export interface OrderRow {
  /** Unique per *row*, not per file: `id#2` is the second occurrence of `id`. */
  key: string;
  id: string;
  /** Zero-based position, for the move arithmetic. */
  index: number;
  /** One-based position, for the badge a person reads. */
  position: number;
  /** `undefined` only while a freshly added id has not been reconciled against the upload list yet. */
  file: UploadedFile | undefined;
}

/**
 * Bring an order into line with the files that exist, keeping as much of the user's arrangement as is still true.
 *
 * The naive alternative — "the list changed, rebuild it from the upload order" — is what the page used to do, and it
 * throws away every reorder the moment a second upload finishes or a rejected file is removed. Orders are the one
 * thing on this screen that only the user knows; a file-list event must not be able to undo one.
 *
 * Entries whose file is gone are dropped, entries that are still present keep their position (including duplicates),
 * and files nobody has placed are appended in upload order. The original array is returned when nothing moved, so
 * `setOrder` on an unchanged board does not re-render.
 */
export function reconcileOrder(order: string[], fileIds: string[]): string[] {
  const present = new Set(fileIds);
  const kept = order.filter((id) => present.has(id));
  const placed = new Set(kept);
  const next = [...kept, ...fileIds.filter((id) => !placed.has(id))];
  const unchanged = next.length === order.length && next.every((id, index) => id === order[index]);
  return unchanged ? order : next;
}

/**
 * Move the row at `from` to index `to`, clamping instead of refusing.
 *
 * HTML5 drag-and-drop reports a drop index computed from the *gaps* between rows, and a row dragged past the last
 * gap arrives as `length`. Clamping here means the drop handler does not have to reason about which end it is at.
 */
export function moveRow(order: string[], from: number, to: number): string[] {
  if (from < 0 || from >= order.length) return order;
  const target = Math.max(0, Math.min(order.length - 1, to));
  if (target === from) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}

/** The keyboard path: `Alt+↑/↓` on a focused row. Same rule as a drag, expressed as a step. */
export function moveSelection(order: string[], index: number, delta: number): string[] {
  return moveRow(order, index, index + delta);
}

/**
 * What the board needs to know about one row's upload: the same fields `UploadItem` carries, named here so that the
 * arithmetic stays independent of the component that uploads.
 */
export interface BoardInputItem {
  localId: string;
  name: string;
  sizeBytes: number;
  state: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  error: string | null;
  errorCode: string | null;
  /** The API's file id once the upload finished; `null` while it is still in flight or after it failed. */
  uploadedId: string | null;
  /**
   * The `File` the user chose, carried for the tile's preview (`features/preview/`).
   *
   * The preview draws the bytes the browser already has rather than fetching the uploaded copy, so the thing on the
   * tile is what was picked and not a round-trip through the API; the arithmetic here never reads it, which is why it
   * is allowed to be `null`.
   */
  sourceFile: File | null;
}

/** One row as drawn: an upload, at a position, or waiting for one. */
export interface BoardRow extends Omit<BoardInputItem, 'localId'> {
  key: string;
  /**
   * The upload behind this position, or `null` when there is none: the same document asked for twice is two places
   * and one upload, so the second place has nothing to remove or retry.
   */
  localId: string | null;
  /** One-based place in the order, or `null` for a row that is not part of the order yet. */
  position: number | null;
  pages: number | null;
  encrypted: boolean;
}

/**
 * Pair the list the user chose with the order they arranged, in one row per thing on screen.
 *
 * The two lists are not the same list and cannot be: a file being uploaded has no id to place yet, and a position can
 * exist without an upload behind it (the same document merged twice is one upload asked for twice). Rows in the
 * order come first with their position; everything still in flight or failed follows with no position, because
 * claiming a place in the merge for bytes the API has not accepted would be a lie the submit button then breaks.
 */
export function boardRows(items: BoardInputItem[], order: string[], files: UploadedFile[]): BoardRow[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const claimed = new Set<string>();
  const seen = new Map<string, number>();
  const rows: BoardRow[] = [];

  order.forEach((id, index) => {
    const occurrence = (seen.get(id) ?? 0) + 1;
    seen.set(id, occurrence);
    const file = byId.get(id);
    // The upload behind a position is claimed once: a second occurrence of the same id is a second place for the
    // same bytes, not the same upload drawn twice.
    const source = items.find((entry) => entry.uploadedId === id);
    const item = occurrence === 1 ? source : undefined;
    if (item) claimed.add(item.localId);
    rows.push({
      key: `${id}#${occurrence}`,
      position: index + 1,
      localId: item?.localId ?? null,
      uploadedId: id,
      name: item?.name ?? file?.name ?? id,
      sizeBytes: item?.sizeBytes ?? file?.sizeBytes ?? 0,
      state: item?.state ?? 'done',
      progress: item?.progress ?? 100,
      error: item?.error ?? null,
      errorCode: item?.errorCode ?? null,
      pages: file?.pages ?? null,
      encrypted: file?.encrypted ?? false,
      // A duplicate row previews the same bytes as the first: one `File`, two places.
      sourceFile: source?.sourceFile ?? null,
    });
  });

  for (const item of items) {
    if (claimed.has(item.localId)) continue;
    const file = item.uploadedId ? byId.get(item.uploadedId) : undefined;
    rows.push({
      ...item,
      key: item.localId,
      position: null,
      pages: file?.pages ?? null,
      encrypted: file?.encrypted ?? false,
    });
  }

  return rows;
}

export interface OrderSummary {
  files: number;
  /** Sum over the rows whose page count is known. */
  pages: number;
  bytes: number;
  /**
   * Whether *every* row's page count is known.
   *
   * A sum of the known counts presented as the total is the kind of number that is right today and wrong the moment
   * a tool takes an input the API cannot probe (office documents carry no page count until they are converted), so
   * the caller is told which of the two it is holding instead of being handed a total to trust.
   */
  pagesKnown: boolean;
}

export function summarizeOrder(order: string[], files: UploadedFile[]): OrderSummary {
  const byId = new Map(files.map((file) => [file.id, file]));
  let pages = 0;
  let bytes = 0;
  let pagesKnown = true;
  let count = 0;
  for (const id of order) {
    const file = byId.get(id);
    if (!file) continue;
    count += 1;
    bytes += file.sizeBytes;
    if (file.pages == null) pagesKnown = false;
    else pages += file.pages;
  }
  return { files: count, pages, bytes, pagesKnown };
}

/**
 * The summary line under the board — "3 files · 84 pages · 12.4 MB" (`docs/01-MERGE.md` §6, `0-UI-DESIGN.md` §3.2).
 *
 * A count of one is written as a count of one; the plural forms are here rather than at the call site because this
 * sentence appears twice on the page (board and run card) and two spellings of it would read as two different facts.
 */
export function describeOrder(summary: OrderSummary): string {
  const parts = [`${summary.files} file${summary.files === 1 ? '' : 's'}`];
  if (summary.files > 0) {
    // `≥` rather than a bare number: a partial sum shown as a total is a claim the page cannot keep.
    const pages = summary.pagesKnown ? `${summary.pages}` : `${summary.pages}+`;
    parts.push(`${pages} page${summary.pages === 1 && summary.pagesKnown ? '' : 's'}`);
  }
  if (summary.bytes > 0) parts.push(formatBytes(summary.bytes));
  return parts.join(' · ');
}

/** One input's slice of the output, which is what the composition strip draws. */
export interface OrderSegment {
  key: string;
  id: string;
  name: string;
  pages: number | null;
  /** First page this input contributes to the merged document, or `null` when the count is unknown. */
  startPage: number | null;
  endPage: number | null;
}

/**
 * Where each input lands in the output — the merge, previewed from the page counts the API probed at upload.
 *
 * This is the only preview of the result that can be drawn *before* the job runs, and it is drawn from the server's
 * own numbers rather than from a client-side parse of the files: a strip that disagreed with the delivered document
 * would be worse than no strip.
 */
export function orderSegments(order: string[], files: UploadedFile[]): OrderSegment[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const seen = new Map<string, number>();
  const segments: OrderSegment[] = [];
  let cursor = 1;
  for (const id of order) {
    const file = byId.get(id);
    if (!file) continue;
    const occurrence = (seen.get(id) ?? 0) + 1;
    seen.set(id, occurrence);
    const pages = file.pages;
    const known = pages != null && pages > 0;
    segments.push({
      key: `${id}#${occurrence}`,
      id,
      name: file.name,
      pages: known ? pages : null,
      startPage: known ? cursor : null,
      endPage: known ? cursor + pages - 1 : null,
    });
    if (known) cursor += pages;
  }
  return segments;
}

/**
 * How much room a segment gets in the strip, relative to the others.
 *
 * An input whose length is unknown still has to occupy something — a zero-width segment is an input that looks like
 * it will not be merged — so it is given the weight of one page and marked as unknown by the caller's styling rather
 * than by its absence.
 */
export function segmentWeight(segment: OrderSegment, averagePages: number): number {
  if (segment.pages != null && segment.pages > 0) return segment.pages;
  return averagePages > 0 ? averagePages : 1;
}

/** Mean pages per input, used as the fallback width for inputs the API could not count. */
export function averageSegmentPages(segments: OrderSegment[]): number {
  const known = segments.filter((segment) => segment.pages != null && segment.pages > 0);
  if (known.length === 0) return 0;
  return known.reduce((total, segment) => total + (segment.pages ?? 0), 0) / known.length;
}
