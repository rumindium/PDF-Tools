import { JobFailure } from '@pdftools/errors';
import { runQpdf } from './index';
import type { RunOptions } from './run';

/**
 * What a page-composition tool needs to know about a document *before* it composes anything: where its bookmarks
 * point, and how much of the file each page is responsible for.
 *
 * Both answers come from qpdf's JSON output rather than from a Python pass, and that is a deliberate choice of
 * transport: `merge` needs to **write** an outline (`./outlines.ts`, pikepdf, because qpdf has no outline primitive),
 * but *reading* one is something qpdf already does, with `destpageposfrom1` resolved for us. A second way to read a
 * destination — walking `/Dests`, `/Names` and page objects by hand — is how two tools start disagreeing about where
 * a bookmark lands.
 *
 * The two reads use **different JSON versions on purpose**. `outlines` is a version-2 key and delivers resolved page
 * positions; the object table with stream lengths (`objects`) is a **version-1** key — qpdf 12 refuses it with
 * `json keys "objects" and "objectinfo" are only valid for json version 1`. That is a fact about the engine, measured
 * here rather than inferred, so the two functions do not share a parser.
 *
 * Both reads ask for a **payload-sized stdout budget** (`STDOUT_PAYLOAD_BYTES`). The engine wrapper's default is a
 * 4 KB log tail, and a document's object table is proportional to the document, not to a diagnostic: measured on the
 * fixtures, a six-page file with a 240 kB content stream is already 4 978 bytes of JSON, so `by-size` refused it with
 * "the size of this document's pages could not be measured" while the engine had answered perfectly (defect 123).
 * Truncation is reported rather than silently parsed, so the failure names the reason instead of looking like a
 * malformed document.
 */

/**
 * The most stdout a structured read may capture: 64 MB.
 *
 * Sized against the payload rather than picked round: qpdf's `objects` table runs on the order of a kilobyte per
 * object, so this holds a document of roughly 60 000 objects, and the worker's own memory limit is what actually
 * bounds a job. A larger document fails with the truncation named in the message instead of being misread.
 */
const STDOUT_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** One entry of a document's outline tree, with the page it lands on. */
export interface BookmarkNode {
  title: string;
  /**
   * 1-based page, or `null` when the entry has no destination qpdf could resolve.
   *
   * `null` is a real answer — a bookmark that only opens a subtree renders a title with nowhere to go — and it is kept
   * out of the page arithmetic rather than defaulted to page 1, which would invent a destination.
   */
  page: number | null;
  children: BookmarkNode[];
}

interface RawOutlineNode {
  title?: unknown;
  destpageposfrom1?: unknown;
  kids?: unknown;
}

/**
 * The document's outline, in order.
 *
 * An empty array means the document has no outline — not an error, and the caller is expected to say so to the user
 * (`split --mode by-bookmarks` has nothing to split by). A document qpdf cannot read at all throws instead, because the
 * caller has already counted its pages and a failure here is a genuine one.
 */
export async function readOutline(path: string, opts: Omit<RunOptions, 'engine'>): Promise<BookmarkNode[]> {
  const result = await runQpdf(['--json', '--json-key=outlines', path], {
    ...opts,
    stdoutLimitBytes: STDOUT_PAYLOAD_BYTES,
  });
  if (result.code !== 0) throw bookmarkFailure(result.stderr, result.code, result.stdout);
  const parsed = parseJson<{ outlines?: unknown }>(result.stdout);
  if (!parsed) throw truncatedFailure(result, 'The document’s bookmarks could not be read.');
  return normaliseOutline(parsed.outlines);
}

function normaliseOutline(raw: unknown): BookmarkNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry): BookmarkNode => {
    const node = (entry ?? {}) as RawOutlineNode;
    const page = node.destpageposfrom1;
    return {
      title: typeof node.title === 'string' ? node.title : '',
      page: typeof page === 'number' && Number.isFinite(page) && page >= 1 ? page : null,
      children: normaliseOutline(node.kids),
    };
  });
}

function sizeFailure(stderr: string, exitCode: number | undefined, fallback: string): JobFailure {
  return new JobFailure('CONVERSION_FAILED', {
    message: 'The size of this document’s pages could not be measured.',
    engine: 'qpdf',
    ...(exitCode == null ? {} : { exitCode }),
    stderrTail: stderr || fallback.slice(0, 400),
  });
}

/**
 * The same failures, with truncation named when it is the cause.
 *
 * An engine's structured output that was cut in half does not parse, and "could not be measured" for a document qpdf
 * read perfectly is a sentence that sends the reader looking at their file. The capture limit is a property of this
 * build, so it is what the message names.
 */
function truncatedFailure(
  result: { stdoutTruncated: boolean; stderr: string; stdout: string },
  otherwise: string,
): JobFailure {
  if (result.stdoutTruncated) {
    return new JobFailure('CONVERSION_FAILED', {
      message:
        'This document is too large to measure in one pass: the engine’s description of it did not fit in the capture budget.',
      engine: 'qpdf',
      stderrTail: `stdout truncated at ${STDOUT_PAYLOAD_BYTES} bytes`,
    });
  }
  return new JobFailure('CONVERSION_FAILED', {
    message: otherwise,
    engine: 'qpdf',
    stderrTail: result.stderr || result.stdout.slice(0, 400),
  });
}

function bookmarkFailure(stderr: string, exitCode: number | undefined, fallback: string): JobFailure {
  return new JobFailure('CONVERSION_FAILED', {
    message: 'The document’s bookmarks could not be read.',
    engine: 'qpdf',
    ...(exitCode == null ? {} : { exitCode }),
    stderrTail: stderr || fallback.slice(0, 400),
  });
}

/**
 * How many bytes each page is responsible for, in page order.
 *
 * The accounting rule, stated because a "target size" option is worthless without one:
 *
 *  - a page is charged the total `/Length` of **its own content streams**, plus the `/Length` of every image and form
 *    XObject reachable from its `/Resources`;
 *  - an object is charged **once**, to the first page that reaches it — a logo shared by every page of a report is one
 *    object, and counting it once per page would make the last page of a fifty-page document look like the heaviest;
 *  - fonts, the page dictionary itself and the document's own structures are **not** charged. They do not belong to one
 *    page, and qpdf rewrites them on the way out anyway, so including them would be an invented number.
 *
 * So this is a *content* estimate, and the size of a delivered file is not its sum: qpdf deduplicates what the parts
 * share. That gap is why `split --mode by-size` measures the file it actually wrote and shrinks the part when the
 * estimate was wrong (`workers/light/src/handlers/split.ts`) rather than trusting this number.
 */
export async function readPageSizes(path: string, opts: Omit<RunOptions, 'engine'>): Promise<number[]> {
  const { pages, objects } = await readPagesAndObjects(
    path,
    opts,
    'The size of this document’s pages could not be measured.',
  );
  const charged = new Set<string>();
  const sizes: number[] = [];

  for (const entry of pages) {
    const page = (entry ?? {}) as { contents?: unknown; object?: unknown };
    let bytes = 0;
    for (const ref of [...referencesOf(page.contents), ...xobjectsOf(page.object, objects)]) {
      bytes += charge(objects, ref, charged);
    }
    sizes.push(bytes);
  }

  return sizes;
}

/**
 * Each page's `/Rotate`, in document order, with inheritance resolved.
 *
 * `/Rotate` is an **inheritable** attribute: the specification lets it live on the `/Pages` node and applies it to
 * every page below, and files from print pipelines do write it there. A read that only looked at the page dictionary
 * would report zero for those documents — the answer would be "no page is rotated" for a file where every page is,
 * which is worse than a refusal because nothing about it looks wrong. So the walk goes page → parent → its parent,
 * bounded, because a malformed file can make the tree cyclic and a warning is not worth a hung worker.
 *
 * An absent or unreadable value answers `0`, which is the specification's own default.
 */
export async function readPageRotations(path: string, opts: Omit<RunOptions, 'engine'>): Promise<number[]> {
  const { pages, objects } = await readPagesAndObjects(path, opts, 'This document’s page rotations could not be read.');
  const rotations: number[] = [];
  for (const entry of pages) {
    const page = (entry ?? {}) as { object?: unknown };
    rotations.push(rotationOf(typeof page.object === 'string' ? page.object : '', objects));
  }
  return rotations;
}

/**
 * The one read both page-table functions are built on: qpdf's page list plus its object table.
 *
 * Shared rather than copied, and not only for brevity: the JSON version and the stdout budget are decisions that were
 * each measured once (version 1 for `objects`, a payload-sized budget after defect 123), and a second copy of this
 * call is a second place for one of them to drift. `what` is the sentence a truncated read produces, because that
 * message is about the caller's question — the sizes of the pages, the rotation of the pages — and a shared generic
 * sentence would send a reader looking in the wrong function.
 */
async function readPagesAndObjects(
  path: string,
  opts: Omit<RunOptions, 'engine'>,
  what: string,
): Promise<{ pages: unknown[]; objects: Record<string, unknown> }> {
  const result = await runQpdf(['--json=1', '--json-key=pages', '--json-key=objects', path], {
    ...opts,
    stdoutLimitBytes: STDOUT_PAYLOAD_BYTES,
  });
  if (result.code !== 0) throw sizeFailure(result.stderr, result.code, result.stdout);
  const parsed = parseJson<{ pages?: unknown; objects?: unknown }>(result.stdout);
  if (!parsed || !Array.isArray(parsed.pages)) throw truncatedFailure(result, what);
  return { pages: parsed.pages, objects: (parsed.objects ?? {}) as Record<string, unknown> };
}

/** The page's own `/Rotate`, or the nearest one up the page tree. */
function rotationOf(pageRef: string, objects: Record<string, unknown>): number {
  let current = pageRef;
  for (let depth = 0; depth < 8; depth += 1) {
    const node = objects[current];
    if (!isDict(node)) return 0;
    const value = resolve(node['/Rotate'], objects);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parent = node['/Parent'];
    if (typeof parent !== 'string' || parent === current) return 0;
    current = parent;
  }
  return 0;
}

/** `["4 0 R"]` → the refs; a bare string is accepted because qpdf writes both shapes. */
function referencesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The XObject refs a page's `/Resources` names.
 *
 * A page inherits `/Resources` from its `/Pages` parent when it has none of its own — the fixture writer relies on
 * that — so a page without one is charged only its content streams. `/Resources` may itself be an indirect object in
 * files from other producers, which is why it is resolved through the object table first.
 */
function xobjectsOf(pageRef: unknown, objects: Record<string, unknown>): string[] {
  if (typeof pageRef !== 'string') return [];
  const page = objects[pageRef];
  if (!isDict(page)) return [];
  const resources = resolve(page['/Resources'], objects);
  if (!isDict(resources)) return [];
  const xobjects = resolve(resources['/XObject'], objects);
  if (!isDict(xobjects)) return [];
  return Object.values(xobjects)
    .map((entry) => asRef(entry))
    .filter((ref) => ref.length > 0);
}

/** The `/Length` of a stream object, or 0 when the object is absent, indirect, or not a stream. */
function charge(objects: Record<string, unknown>, ref: string, charged: Set<string>): number {
  if (ref.length === 0 || charged.has(ref)) return 0;
  charged.add(ref);
  const object = objects[ref];
  if (!isDict(object)) return 0;
  // `/Length` is normally a direct integer, but an indirect one is legal and some producers write it that way.
  const length = resolve(object['/Length'], objects);
  return typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : 0;
}

/** Follow a `"4 0 R"` reference one step; anything else is returned as it is. */
function resolve(value: unknown, objects: Record<string, unknown>): unknown {
  const ref = asRef(value);
  if (ref.length === 0) return value;
  return objects[ref] ?? value;
}

/** `"4 0 R"` → `"4 0 R"`; anything else → `''`, so a direct dictionary is simply not charged. */
function asRef(value: unknown): string {
  if (typeof value === 'string' && /^\d+\s+\d+\s+R$/.test(value)) return value;
  return '';
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
