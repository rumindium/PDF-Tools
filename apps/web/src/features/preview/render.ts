//
// The **legacy** build, deliberately (`legacy/build/pdf.mjs`). pdf.js 5+ uses `Uint8Array.prototype.toHex`,
// `fromHex` and `toBase64`, which landed in Chrome 140 and are absent from every engine before it — the failure is
// an `UnknownErrorException: n.toHex is not a function` thrown from the worker for a perfectly valid document, i.e.
// the preview silently degrades to a placeholder on a browser that would otherwise run this app fine. The legacy
// build is pdf.js's own answer (same API, same worker protocol, polyfills included for exactly this), and the cost is
// a slightly larger chunk for the users who need it. Found by measuring in a Chrome 130 renderer, not by reading.
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Page previews, rendered in the browser (`0-UI-DESIGN.md` §3.2/§6).
 *
 * **Why this is the one renderer that is allowed not to be the engines'.** The placement canvas argues the opposite
 * case for itself and is right to (`features/placement/index.tsx`): there the render *is the coordinate space*, so a
 * second pipeline that drew a page a millimetre off would put every mark in the wrong place. Nothing here is measured
 * against the image. A board thumbnail answers "which file is this, and which way up is it", and a lightbox answers
 * "is this the page I meant to include" — questions whose answers do not change with sub-pixel fidelity, and whose
 * cost, if they were asked as jobs, would be a queue entry, a quota unit and a row in the user's history **per file**.
 *
 * So: the same bytes the user picked, decoded by the browser, at the resolution of the thing showing it. The pages
 * that feed a *job* still come from the engines, and the result panel still shows the engine's own output.
 *
 * Three properties this module keeps, because each one is a way a preview feature becomes a page-breaker:
 *
 *  - **Nothing loads until a thumbnail is asked for.** `pdfjs-dist` is a dynamic import, so the tool page's first
 *    paint does not carry a PDF engine, and a page that never previews anything never pays for one.
 *  - **The worker is a same-origin asset** (`new URL(…, import.meta.url)`), which is what keeps the production CSP
 *    (`script-src 'self'`, so `worker-src` falls back to it) satisfied. A `blob:` worker — the usual shortcut — would
 *    be blocked there and work in dev.
 *  - **Every render is cached per `File` object** (`WeakMap`), and only three draw at once. A fifty-file merge would
 *    otherwise start fifty canvases at the first paint and re-render page one on every reorder.
 */

export type PreviewKind = 'pdf' | 'image' | 'other';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp']);

/** What this module can draw for a file: a PDF's pages, the image itself, or nothing (an icon stands in). */
export function previewKind(file: { name: string; type: string }): PreviewKind {
  const type = file.type.trim().toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  // The browser's own `type` is a claim; the extension is the second opinion, and it is the one that is right when a
  // file picker hands back an empty type.
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'other';
}

/**
 * The scale that fits a page into a box, without ever enlarging past `max`.
 *
 * Above 1 it would be sharpening a thumbnail into a blur; below the floor it would be asking for a canvas no browser
 * will paint. A page with no usable box (a broken `/MediaBox`, which the API's probe tolerates because qpdf repairs
 * it) falls back to 1 rather than to `NaN`, because `NaN` reaches `canvas.width` and throws inside pdf.js.
 */
export function fitScale(width: number, height: number, boxWidth: number, boxHeight: number, max = 3): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const scale = Math.min(boxWidth / width, boxHeight / height);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(max, Math.max(0.05, scale));
}

/**
 * Which pages a tile offers as chips, and how many it is not showing.
 *
 * The count comes from the API's probe, so this is `null` for anything the API could not count (an office document
 * before conversion). One chip labelled "1" is still worth drawing: it is the way into the preview, and a tile whose
 * only affordance is a thumbnail that happens to be clickable is a tile nobody clicks.
 */
export function pageStrip(total: number | null | undefined, limit = 4): { pages: number[]; more: number } {
  if (total == null || total < 1) return { pages: [1], more: 0 };
  const pages = Array.from({ length: Math.min(total, limit) }, (_, index) => index + 1);
  return { pages, more: Math.max(0, total - pages.length) };
}

export interface PreviewBox {
  width: number;
  height: number;
}

/** Tiles and strips are drawn at a fixed box; the lightbox asks for a larger one for the same page. */
export type PreviewTarget = { file: File; page: number; box: PreviewBox };

type PdfLibrary = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let library: Promise<PdfLibrary> | undefined;

function loadLibrary(): Promise<PdfLibrary> {
  library ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    // Same-origin, hashed and served by the app's own nginx/Caddy — see the header comment for why not a blob. The
    // server also has to label it as JavaScript: a module script with the wrong MIME type is refused outright, and
    // nginx's stock `mime.types` has no `.mjs` entry (`infra/nginx/default.conf.template`).
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
    return pdfjs;
  });
  return library;
}

/** Parsed documents, keyed by the `File` the user chose, so a re-render never re-parses. */
const documents = new WeakMap<File, Promise<PDFDocumentProxy>>();
/** Rendered data URLs, keyed by file and then by `page@widthxheight`. */
const rendered = new WeakMap<File, Map<string, Promise<string>>>();
/**
 * The same keys again, holding only the ones that *finished*.
 *
 * `rendered` is enough to avoid working twice, and not enough to avoid *flickering*: a cached promise still resolves a
 * microtask later, so asking for a page the cache already holds would render one frame of "loading" before the image
 * appeared. `peekPagePreview` is the synchronous answer to "do I already have this page", which is what lets a
 * stepper show the next page in the same commit it was asked for instead of flashing a spinner at a page it has.
 */
const finished = new WeakMap<File, Map<string, string>>();

/** The cache key for one target: the page, and the pixel box it was drawn into. */
function previewKey(target: PreviewTarget): string {
  return `${target.page}@${Math.round(target.box.width)}x${Math.round(target.box.height)}`;
}

/**
 * A page already drawn, if it is — synchronously, so a caller can skip the loading state entirely.
 *
 * Returns `null` for anything still in flight, which is the honest answer: the caller then shows the previous frame
 * with a loader over it, rather than guessing that a render is about to arrive.
 */
export function peekPagePreview(target: PreviewTarget): string | null {
  return finished.get(target.file)?.get(previewKey(target)) ?? null;
}
/** Object URLs for image inputs, created once per file. */
const imageUrls = new WeakMap<File, string>();

async function openDocument(file: File): Promise<PDFDocumentProxy> {
  const cached = documents.get(file);
  if (cached) return cached;
  const pending = loadLibrary()
    .then(async (pdfjs) => pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise)
    // A failed parse is not cached: a transient failure should be retryable by looking at the tile again, and a
    // rejected promise left in the map would hand the same failure to every later attempt.
    .catch((cause: unknown) => {
      documents.delete(file);
      throw cause;
    });
  documents.set(file, pending);
  return pending;
}

/**
 * Three canvases at a time.
 *
 * pdf.js serialises its own rendering, but each finished page paints on the main thread, and fifty of those in one
 * commit is a frozen page. A slot per render keeps the board responsive while the queue drains behind it.
 */
const SLOTS = 3;
let running = 0;
const waiting: Array<() => void> = [];

function slot(): Promise<void> {
  if (running < SLOTS) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

async function draw(file: File, pageNumber: number, box: PreviewBox): Promise<string> {
  const kind = previewKind(file);
  if (kind === 'image') {
    const existing = imageUrls.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    imageUrls.set(file, url);
    return url;
  }
  if (kind === 'other') throw new Error('This file type has no page preview.');

  const document_ = await openDocument(file);
  // Clamped rather than refused: the count came from the API's probe, and a page the probe over-counted should land
  // on the last real page instead of failing the tile.
  const target = Math.min(Math.max(1, Math.round(pageNumber)), document_.numPages);
  const page = await document_.getPage(target);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: fitScale(base.width, base.height, box.width, box.height) });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw a page preview.');

  await slot();
  try {
    // `background` paints the page rather than leaving it transparent — a PDF page has no colour of its own, and a
    // transparent thumbnail reads as a hole on a dark theme.
    await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  } finally {
    releaseSlot();
  }
  return canvas.toDataURL('image/webp', 0.82);
}

/** A page of a file as a `data:` URL, or an object URL for an image input. Cached; safe to call on every render. */
export function pagePreview(target: PreviewTarget): Promise<string> {
  const key = previewKey(target);
  let perFile = rendered.get(target.file);
  if (!perFile) {
    perFile = new Map();
    rendered.set(target.file, perFile);
  }
  const cached = perFile.get(key);
  if (cached) return cached;
  const pending = draw(target.file, target.page, target.box).then((url) => {
    let done = finished.get(target.file);
    if (!done) {
      done = new Map();
      finished.set(target.file, done);
    }
    done.set(key, url);
    return url;
  });
  perFile.set(key, pending);
  // A failure is not remembered: the next look at this tile should try again, and `peek` must never hand back a page
  // that was never drawn.
  pending.catch(() => perFile.delete(key));
  return pending;
}

/** How many pages a file has, for the lightbox's counter — `null` when it is not a PDF. */
export async function documentPageCount(file: File): Promise<number | null> {
  if (previewKind(file) !== 'pdf') return null;
  try {
    return (await openDocument(file)).numPages;
  } catch {
    return null;
  }
}

/**
 * One page's size **in PDF points**, as the browser laid it out — `null` for anything that is not a page at all.
 *
 * This is the number a canvas that *measures against the page* needs, and it is exact rather than estimated: pdf.js's
 * viewport at `scale: 1` is user space times one, i.e. points, **with the page's own rotation applied** — so a page
 * carrying `/Rotate 90` reports the size a person sees, not the size in its `/MediaBox`. The crop board (`§6.4`) is
 * the first caller: its overlay is positioned in percentages of the page it draws, and those percentages are only
 * meaningful against the page's true shape.
 *
 * The alternative — measuring the rendered `<img>` — would be a feedback loop between the layout and the value, and
 * would come out wrong on exactly the pages where it matters (a rotated scan, a document whose pages are not all one
 * size). So the size comes from the document and the *layout* follows it.
 */
export async function pageSizePoints(
  file: File,
  pageNumber: number,
): Promise<{ widthPt: number; heightPt: number } | null> {
  if (previewKind(file) !== 'pdf') return null;
  try {
    const document_ = await openDocument(file);
    const target = Math.min(Math.max(1, Math.round(pageNumber)), document_.numPages);
    const page = await document_.getPage(target);
    const viewport = page.getViewport({ scale: 1 });
    const widthPt = viewport.width;
    const heightPt = viewport.height;
    if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt) || widthPt <= 0 || heightPt <= 0) return null;
    return { widthPt, heightPt };
  } catch {
    // A page that cannot be measured is a preview that cannot draw a box around anything — the board says so rather
    // than drawing a rectangle against a guess.
    return null;
  }
}
