/**
 * What a drag or a paste is carrying, and whether the tool wants it.
 *
 * Two questions, both of which the browser makes easy to get wrong, and both of which are worth asking before bytes
 * move rather than after the API refuses them:
 *
 *  - a `dragenter`/`dragleave` pair fires for every element the pointer crosses, so "is a file being dragged" has to
 *    be answered from the payload's types;
 *  - a browser reports a `File.type` it inferred from the extension, so a type check can only ever be *advisory* —
 *    the API detects the real type from magic bytes (`0-SECURITY.md` §3). An empty type therefore means "unknown",
 *    not "wrong", and is passed through.
 */

/** Whether a drag is carrying files rather than text, a URL, or a DOM node from this page. */
export function hasFilePayload(types: readonly string[] | undefined): boolean {
  return (types ?? []).some((type) => type.toLowerCase() === 'files');
}

/**
 * The mark a drop carries once the drop zone has taken it.
 *
 * Both the zone and the page listen for the same `drop`, and the page's listener is on `window`: it runs second, and
 * "was this already accepted" cannot be answered from `defaultPrevented` (the page's own handler prevents default as
 * much as the zone's does). A property on the event answers it directly, and it is the difference between a file
 * being added once and being added twice — which looks like a duplicate row, not like a bug in a listener.
 */
interface MarkedDrop extends Event {
  __pdftoolsDropHandled?: boolean;
}

export function markDropHandled(event: Event): void {
  (event as MarkedDrop).__pdftoolsDropHandled = true;
}

export function wasDropHandled(event: Event): boolean {
  return (event as MarkedDrop).__pdftoolsDropHandled === true;
}

/**
 * The MIME entries of an `accept` attribute.
 *
 * Extensions (`.pdf`) are for the native picker and match nothing a `File` object reports, so they are separated out
 * rather than compared against `file.type` — the bug that makes every drag-and-drop of a `.pdf` look unacceptable.
 */
export function mimeTokensFromAccept(accept: string): string[] {
  return accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('/'));
}

/**
 * Extension spellings that mean the same format, so a sentence does not list one file type twice.
 *
 * The `accept` attribute is written for the picker, which wants every extension the platform might report, so it
 * carries `jpg` and `jpeg` side by side. A person told "this tool takes PDF, JPG, JPEG, PNG" reads two formats where
 * there is one.
 */
const ALIASES: Record<string, string> = { jpeg: 'jpg', jpe: 'jpg', tif: 'tiff', htm: 'html', yml: 'yaml' };

/** The extension entries of an `accept` attribute, upper-cased for a sentence: `PDF, JPG, PNG`. */
export function acceptLabel(accept: string): string {
  const extensions = accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith('.'))
    .map((entry) => entry.slice(1))
    .map((extension) => ALIASES[extension] ?? extension)
    .map((extension) => extension.toUpperCase());
  const unique = [...new Set(extensions)];
  if (unique.length > 0) return unique.join(', ');
  const mimes = mimeTokensFromAccept(accept);
  return mimes.length > 0 ? mimes.join(', ') : 'the accepted formats';
}

/**
 * The sentence a wrong file gets, or `null` when it can go ahead.
 *
 * Advisory by design: a `File.type` the browser invented, or one it omitted, is not a verdict. It only refuses a
 * type that is *stated* and *outside* the list, because that is the case where uploading it would spend a round trip
 * to be told `UNSUPPORTED_FILE_TYPE`.
 */
export function typeRejection(file: { name: string; type: string }, accept: string): string | null {
  const type = file.type.trim().toLowerCase();
  if (type === '') return null;
  const tokens = mimeTokensFromAccept(accept);
  if (tokens.length === 0) return null;
  const accepted = tokens.some((token) =>
    token.endsWith('/*') ? type.startsWith(token.slice(0, -1)) : token === type,
  );
  return accepted ? null : `${file.name} — this tool takes ${acceptLabel(accept)} only.`;
}
