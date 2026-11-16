import { PageRangeError, expandPageSpecs } from '@pdftools/contracts/tools';
import { JobFailure } from '@pdftools/errors';

/**
 * Page selection, as a job sees it: the product's grammar, in the worker's error type.
 *
 * The grammar and its expansion live in `@pdftools/contracts/tools` (`page-ranges.ts`) because the API schema and the
 * web form parse the same strings — a second parser here, or a second regex there, is how three layers start
 * disagreeing about what `1-3,7` means. This module's whole job is the transport: a `PageRangeError` carries the
 * sentence the user should read, and a job has to refuse with `VALIDATION_ERROR` rather than with a crash.
 */

/**
 * Expand `["1-3", "7"]` into `[1, 2, 3, 7]`.
 *
 * `pageCount` is needed by `N-z`, `even` and `odd` and ignored by everything else, so a caller that has already
 * counted its pages passes them and a caller that has not is not forced to make a second pass to accept `1-3`.
 */
export function expandRanges(ranges: string[], pageCount?: number): number[] {
  try {
    return expandPageSpecs(ranges, pageCount);
  } catch (error) {
    if (error instanceof PageRangeError) {
      throw new JobFailure('VALIDATION_ERROR', { message: error.message });
    }
    throw error;
  }
}

/**
 * The page window a selection maps to, for engines that take only a first and a last page.
 *
 * A non-contiguous selection (`1,4,5`) cannot be expressed to `pdftotext` or `pdftohtml`, so the window is the span
 * from the first to the last selected page and the caller's metrics say so. Extracting *fewer* pages than the user
 * asked for would be worse than being generous, so the span is deliberately inclusive.
 */
export function pageBounds(selection: string[] | undefined, pageCount: number): { first: number; last: number } | null {
  if (!selection || selection.length === 0) return null;
  const pages = expandRanges(selection, pageCount).filter((page) => page >= 1 && page <= pageCount);
  if (pages.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: 'No page in this document matches that selection.',
    });
  }
  return { first: Math.min(...pages), last: Math.max(...pages) };
}
