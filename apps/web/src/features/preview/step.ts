import type { PagePreviewState } from './index';

/**
 * What the frame on screen should become when the requested page changes.
 *
 * Pulled out of the hook as a pure function for one reason: this is the rule that decides whether a person stepping
 * through a preview sees a **blink** or a **loader**, and a rule that only exists inside a `useEffect` can only be
 * observed by watching it happen. It is three answers, and each one is a case somebody noticed:
 *
 *  - **Already drawn** (`cached`) → the page appears, no loading state at all. A cached page still resolves a
 *    microtask later, so returning `loading: true` here would flash a loader at a page that was on screen a moment
 *    ago — the `peekPagePreview` call exists to make this answer synchronous.
 *  - **Same document, new page** → the previous frame *stays* under a loader. This is the fix: clearing it here cost
 *    two visual changes per step (to nothing, then to the page), and the empty one is the state that reads as a fault.
 *  - **A different document** → the previous frame is cleared. The same paper argument does not apply: the old page is
 *    a picture of a file the user is no longer looking at, and leaving it up under a loader would be a lie told
 *    confidently.
 *
 * `shownFile` is the file the frame on screen was drawn from, which is what makes the second and third cases
 * distinguishable at all — `file` alone cannot say whether the change was the page or the document.
 */
export function frameFor({
  current,
  file,
  shownFile,
  cached,
}: {
  /** The frame on screen now. */
  current: string | null;
  /** The document being asked for — never `null`, because "no file" is not a frame decision. */
  file: File;
  /** The document the frame on screen belongs to, or `null` if there is no frame. */
  shownFile: File | null;
  /** A page already drawn for exactly this document, page and box, if there is one. */
  cached: string | null;
}): PagePreviewState {
  if (cached) return { url: cached, error: null, loading: false };
  const sameDocument = shownFile === file && current != null;
  return { url: sameDocument ? current : null, error: null, loading: true };
}
