import { describe, expect, test } from 'bun:test';
import type { UploadedFile } from '@pdftools/contracts/api';
import {
  type BoardInputItem,
  averageSegmentPages,
  boardRows,
  describeOrder,
  moveRow,
  moveSelection,
  orderSegments,
  reconcileOrder,
  segmentWeight,
  summarizeOrder,
} from './order';

/**
 * The board's arithmetic, tested where it can be wrong.
 *
 * Every case below is something the screen does during ordinary use — a second upload landing, a file removed, a row
 * dragged to the end, `Alt+↑` on the first row, merging the same file twice — rather than a tour of the signatures.
 */

function file(id: string, pages: number | null, bytes = 1024): UploadedFile {
  return {
    id,
    name: `${id}.pdf`,
    detectedType: 'application/pdf',
    sizeBytes: bytes,
    pages,
    encrypted: false,
    checksumSha256: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const A = file('a', 12, 2 * 1024 * 1024);
const B = file('b', 8, 1024 * 1024);
const C = file('c', 4, 512 * 1024);

describe('reconcileOrder', () => {
  test('a file that arrives late is appended, and the arrangement already made survives', () => {
    // The user merged b before a; then c finishes uploading. Rebuilding from the upload list would silently undo the
    // swap, which is the defect this function exists to prevent.
    expect(reconcileOrder(['b', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });

  test('a removed file leaves the order without disturbing the rest', () => {
    expect(reconcileOrder(['c', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('merging the same file twice keeps both occurrences', () => {
    expect(reconcileOrder(['a', 'a'], ['a', 'b'])).toEqual(['a', 'a', 'b']);
    expect(reconcileOrder(['b', 'a', 'a'], ['a', 'b'])).toEqual(['b', 'a', 'a']);
  });

  test('an order that is already right is returned by identity, so no state update happens', () => {
    const order = ['a', 'b'];
    expect(reconcileOrder(order, ['a', 'b'])).toBe(order);
  });

  test('an empty order is filled from the upload list', () => {
    expect(reconcileOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('moveRow', () => {
  test('a row moves to the index it was dropped on', () => {
    expect(moveRow(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  test('the first gap and the last gap both work', () => {
    expect(moveRow(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveRow(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a']);
  });

  test('a drop past the end clamps rather than dropping the row', () => {
    expect(moveRow(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(moveRow(['a', 'b', 'c'], 1, -5)).toEqual(['b', 'a', 'c']);
  });

  test('no movement returns the same array', () => {
    const order = ['a', 'b', 'c'];
    expect(moveRow(order, 1, 1)).toBe(order);
    expect(moveRow(order, 9, 0)).toBe(order);
  });
});

describe('moveSelection', () => {
  test('Alt+↓ and Alt+↑ step one place', () => {
    expect(moveSelection(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveSelection(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  });

  test('stepping off either end does nothing', () => {
    const order = ['a', 'b'];
    expect(moveSelection(order, 0, -1)).toBe(order);
    expect(moveSelection(order, 1, 1)).toBe(order);
  });
});

describe('boardRows', () => {
  const done = (id: string, localId = `u-${id}`): BoardInputItem => ({
    localId,
    name: `${id}.pdf`,
    sizeBytes: 1024,
    state: 'done',
    progress: 100,
    error: null,
    errorCode: null,
    uploadedId: id,
    sourceFile: null,
  });

  test('a placed file carries its position and the numbers the API probed', () => {
    const rows = boardRows([done('a'), done('b')], ['b', 'a'], [A, B]);
    expect(rows.map((row) => [row.position, row.name, row.pages, row.encrypted])).toEqual([
      [1, 'b.pdf', 8, false],
      [2, 'a.pdf', 12, false],
    ]);
  });

  test('bytes still moving have no position and come after the ones that do', () => {
    const uploading: BoardInputItem = {
      localId: 'u-new',
      name: 'new.pdf',
      sizeBytes: 2048,
      state: 'uploading',
      progress: 40,
      error: null,
      errorCode: null,
      uploadedId: null,
      sourceFile: null,
    };
    const rows = boardRows([done('a'), uploading], ['a'], [A]);
    expect(rows.map((row) => [row.position, row.name, row.localId])).toEqual([
      [1, 'a.pdf', 'u-a'],
      [null, 'new.pdf', 'u-new'],
    ]);
  });

  test('a failed upload stays on the board, unplaced, with its reason', () => {
    const failed: BoardInputItem = {
      localId: 'u-bad',
      name: 'bad.pdf',
      sizeBytes: 10,
      state: 'error',
      progress: 0,
      error: 'The upload failed.',
      errorCode: 'UNSUPPORTED_FILE_TYPE',
      uploadedId: null,
      sourceFile: null,
    };
    const rows = boardRows([failed], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBeNull();
    expect(rows[0]!.errorCode).toBe('UNSUPPORTED_FILE_TYPE');
  });

  test('the same file twice is two positions and one upload', () => {
    const rows = boardRows([done('a')], ['a', 'a'], [A]);
    expect(rows.map((row) => [row.position, row.key, row.localId, row.pages])).toEqual([
      [1, 'a#1', 'u-a', 12],
      [2, 'a#2', null, 12],
    ]);
  });

  test('every position of a doubled file previews the bytes that were picked', () => {
    const picked = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' });
    const rows = boardRows([{ ...done('a'), sourceFile: picked }], ['a', 'a'], [A]);
    // Two places, one upload — and the second tile is not the one that goes blank, which is what looking up the file
    // by the upload behind the position would have done.
    expect(rows.map((row) => row.sourceFile === picked)).toEqual([true, true]);
  });

  test('a file still uploading keeps its page, because the preview is drawn from what was picked', () => {
    const picked = new File([new Uint8Array([1])], 'early.pdf', { type: 'application/pdf' });
    const uploading: BoardInputItem = {
      localId: 'u-early',
      name: 'early.pdf',
      sizeBytes: 1,
      state: 'uploading',
      progress: 20,
      error: null,
      errorCode: null,
      uploadedId: null,
      sourceFile: picked,
    };
    const rows = boardRows([uploading], [], []);
    expect(rows[0]!.sourceFile === picked).toBe(true);
  });

  test('every row in the order is drawn, even before the upload list catches up', () => {
    const rows = boardRows([], ['a', 'b'], [A, B]);
    expect(rows.map((row) => [row.position, row.name, row.state])).toEqual([
      [1, 'a.pdf', 'done'],
      [2, 'b.pdf', 'done'],
    ]);
  });

  test('an encrypted input is flagged so the page can say it needs unlocking first', () => {
    const locked = { ...A, id: 'locked', encrypted: true };
    expect(boardRows([done('locked')], ['locked'], [locked])[0]!.encrypted).toBe(true);
  });
});

describe('summarizeOrder', () => {
  test('pages and bytes are counted over the visible order', () => {
    expect(summarizeOrder(['a', 'b', 'c'], [A, B, C])).toEqual({
      files: 3,
      pages: 24,
      bytes: 2 * 1024 * 1024 + 1024 * 1024 + 512 * 1024,
      pagesKnown: true,
    });
  });

  test('one input the API could not probe makes the page count a partial sum, and says so', () => {
    const docx = file('d', null, 4096);
    const summary = summarizeOrder(['a', 'd'], [A, docx]);
    expect(summary.pages).toBe(12);
    expect(summary.pagesKnown).toBe(false);
  });

  test('an id with no file behind it is not counted', () => {
    expect(summarizeOrder(['a', 'ghost'], [A])).toEqual({
      files: 1,
      pages: 12,
      bytes: 2 * 1024 * 1024,
      pagesKnown: true,
    });
  });
});

describe('describeOrder', () => {
  test('reads as the merge documentation promises', () => {
    expect(describeOrder(summarizeOrder(['a', 'b', 'c'], [A, B, C]))).toBe('3 files · 24 pages · 3.5 MB');
  });

  test('a single file is written as one', () => {
    expect(describeOrder({ files: 1, pages: 1, bytes: 1024, pagesKnown: true })).toBe('1 file · 1 page · 1.0 KB');
  });

  test('a partial page count is marked as a floor', () => {
    expect(describeOrder({ files: 2, pages: 12, bytes: 0, pagesKnown: false })).toBe('2 files · 12+ pages');
  });

  test('nothing selected is empty rather than zero-pages', () => {
    expect(describeOrder({ files: 0, pages: 0, bytes: 0, pagesKnown: true })).toBe('0 files');
  });
});

describe('orderSegments', () => {
  test('each input is given the page range it will occupy', () => {
    expect(orderSegments(['a', 'b', 'c'], [A, B, C])).toEqual([
      { key: 'a#1', id: 'a', name: 'a.pdf', pages: 12, startPage: 1, endPage: 12 },
      { key: 'b#1', id: 'b', name: 'b.pdf', pages: 8, startPage: 13, endPage: 20 },
      { key: 'c#1', id: 'c', name: 'c.pdf', pages: 4, startPage: 21, endPage: 24 },
    ]);
  });

  test('the order is the ranges: reversing the list reverses the pages', () => {
    const reversed = orderSegments(['c', 'b', 'a'], [A, B, C]);
    expect(reversed.map((segment) => [segment.startPage, segment.endPage])).toEqual([
      [1, 4],
      [5, 12],
      [13, 24],
    ]);
  });

  test('an unprobed input keeps its place without being given a range', () => {
    const docx = file('d', null, 4096);
    const segments = orderSegments(['a', 'd', 'c'], [A, docx, C]);
    expect(segments).toEqual([
      { key: 'a#1', id: 'a', name: 'a.pdf', pages: 12, startPage: 1, endPage: 12 },
      { key: 'd#1', id: 'd', name: 'd.pdf', pages: null, startPage: null, endPage: null },
      { key: 'c#1', id: 'c', name: 'c.pdf', pages: 4, startPage: 13, endPage: 16 },
    ]);
  });

  test('two occurrences of one file are two segments with two ranges', () => {
    const segments = orderSegments(['a', 'a'], [A]);
    expect(segments.map((segment) => segment.key)).toEqual(['a#1', 'a#2']);
    expect(segments.map((segment) => [segment.startPage, segment.endPage])).toEqual([
      [1, 12],
      [13, 24],
    ]);
  });

  test('a file with no pages at all contributes no range instead of a zero-page one', () => {
    const empty = file('e', 0, 10);
    expect(orderSegments(['e'], [empty])[0]!.startPage).toBeNull();
  });
});

describe('segment width', () => {
  test('width is pages', () => {
    const segments = orderSegments(['a', 'b'], [A, B]);
    expect(segmentWeight(segments[0]!, averageSegmentPages(segments))).toBe(12);
  });

  test('an unknown length borrows the average rather than vanishing', () => {
    const docx = file('d', null, 4096);
    const segments = orderSegments(['a', 'd'], [A, docx]);
    const average = averageSegmentPages(segments);
    expect(average).toBe(12);
    expect(segmentWeight(segments[1]!, average)).toBe(12);
  });

  test('with nothing counted at all, every segment still gets room', () => {
    const docx = file('d', null, 4096);
    const segments = orderSegments(['d'], [docx]);
    expect(segmentWeight(segments[0]!, averageSegmentPages(segments))).toBe(1);
  });
});
