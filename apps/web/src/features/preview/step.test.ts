import { describe, expect, test } from 'bun:test';
import { frameFor } from './step';

/**
 * The rule that decides whether stepping through a preview blinks.
 *
 * This is the part of the lightbox that can be measured without a compositor: the browser stage would assert the same
 * three answers by watching a real page change, and until it exists this is what keeps the rule true. What it cannot
 * cover is the *rendering* (that the kept frame is really what the user sees dimmed under the loader) — that is an
 * observation for `e2e/browser/`, and it is named as a gap in `0-IMPLEMENTATION-STATUS.md`.
 */
describe('frameFor', () => {
  const alpha = new File([new Uint8Array([1])], 'alpha.pdf', { type: 'application/pdf' });
  const beta = new File([new Uint8Array([2])], 'beta.pdf', { type: 'application/pdf' });
  const pageOne = 'data:image/webp;base64,ONE';

  test('a page already drawn appears with no loading state at all', () => {
    // The stepper asks for a page it has: `loading: true` here would flash a loader at a page that is, in effect,
    // already on screen — the same blink, quietly reintroduced on the way back.
    expect(frameFor({ current: pageOne, file: alpha, shownFile: alpha, cached: 'data:image/webp;base64,TWO' })).toEqual(
      { url: 'data:image/webp;base64,TWO', error: null, loading: false },
    );
  });

  test('a different page of the same document keeps the frame, under a loader', () => {
    // This is the fix. The frame that is up is out of date, and the honest way to say so is a loader over it — not an
    // empty rectangle for one commit and the page for the next.
    expect(frameFor({ current: pageOne, file: alpha, shownFile: alpha, cached: null })).toEqual({
      url: pageOne,
      error: null,
      loading: true,
    });
  });

  test('a different document clears the frame', () => {
    // The old page is a picture of a file the user is no longer looking at. Keeping it would be a lie told confidently.
    expect(frameFor({ current: pageOne, file: beta, shownFile: alpha, cached: null })).toEqual({
      url: null,
      error: null,
      loading: true,
    });
  });

  test('no frame on screen is not the same as a frame to keep', () => {
    // The first page of a document nobody has drawn: there is nothing to hold, so the skeleton is the right state.
    expect(frameFor({ current: null, file: alpha, shownFile: null, cached: null })).toEqual({
      url: null,
      error: null,
      loading: true,
    });
    // …and a ref that says "this file" with no url behind it is still nothing to keep.
    expect(frameFor({ current: null, file: alpha, shownFile: alpha, cached: null })).toEqual({
      url: null,
      error: null,
      loading: true,
    });
  });
});
