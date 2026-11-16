import { parseJsonLine, runPythonScriptStdin } from './python';
import type { RunOptions } from './run';

/**
 * What `qpdf --empty --pages` cannot carry, and the reason this module exists.
 *
 * Measured, on the output of the merge handler's own command: `--empty` builds a fresh document, so the result has
 * the pages in the right order and **no outline and no metadata at all** — `/Outlines` is absent from the catalog,
 * the `/Info` dictionary is empty, and the XMP packet is gone. That is not a qpdf bug; it is what "assemble a new
 * document" means, and qpdf has no outline primitive to fix it with.
 *
 * So the assembled file is finished here, with pikepdf, in one process:
 *
 *  - the outline is **rebuilt from the sources**, because the merged document's page numbers are a materialisation of
 *    the input order: every source's entries are remapped onto the pages they ended up at, with the offset computed by
 *    summing the page counts of the sources before it;
 *  - `keep` nests each source that has an outline under one level-1 entry **named after the file**, which is what a
 *    reader expects from "merge these three documents" and what makes colliding entry names (`Introduction` in every
 *    input) legible;
 *  - `flatten` lifts every entry, from every source, to one flat list in document order;
 *  - `none` removes the outline, which is what the option says — and so does a `keep`/`flatten` merge in which nothing
 *    was written, because a catalog with an empty `/Outlines` dictionary is a document whose reader shows a Bookmarks
 *    sidebar that opens onto nothing;
 *  - the **first** input's `/Info` and XMP are copied onto the result, so a merge of "the report and its annexes"
 *    keeps the report's title rather than arriving untitled.
 *
 * A destination that cannot be resolved is counted and reported rather than invented: an entry pointing at a page
 * that no longer exists is worse than an entry that is honestly missing, so the count comes back in the result and the
 * handler decides whether to warn.
 */

export type BookmarkMode = 'keep' | 'flatten' | 'none';

export interface MergeSource {
  /** Path on disk, inside the job directory. */
  path: string;
  /** The user-visible file name, used as the `keep` parent title. */
  name: string;
}

export interface DecorateMergedInput {
  /** The assembled document, rewritten in place. */
  input: string;
  output: string;
  /** Sources in merge order — the order is the page map. */
  sources: MergeSource[];
  mode: BookmarkMode;
}

export interface DecorateMergedResult {
  /** Entries written to the outline, at every level. */
  outlineEntries: number;
  /** Entries dropped because their destination could not be mapped into the merged document. */
  unresolved: number;
  /** Sources that contributed at least one entry. */
  sourcesWithOutline: number;
  metadataCopied: boolean;
  /** Present when pikepdf refused the document; the merged file is left as qpdf wrote it. */
  error?: string;
  /** Why the metadata half did not happen, when it did not — the outline can survive a metadata failure and vice versa. */
  metadataError?: string;
}

/**
 * Where a bookmark points, as Python — one copy, embedded in both scripts below.
 *
 * Two decorators now walk the same destinations (the assembler that remaps concatenated inputs, and the one that
 * remaps a page *selection*), and a second hand-written walk of `/Dests`, `/Names` and page objects is exactly how
 * they would start disagreeing about a document neither of them can fully resolve anyway.
 */
const PY_PAGE_INDEX = `
def page_index_in(source_document, destination):
    """The 0-based page a destination points at, or None when it cannot be resolved."""
    target = destination
    if isinstance(target, str):
        # A named destination: resolving it means walking /Names or a /Dests dictionary, which producers write in
        # several incompatible shapes. Reported as unresolved instead of guessed at.
        return None
    if isinstance(target, pikepdf.Array):
        if len(target) == 0:
            return None
        target = target[0]
    if isinstance(target, pikepdf.Dictionary) and "/D" in target:
        target = target["/D"]
        if isinstance(target, pikepdf.Array) and len(target) > 0:
            target = target[0]
    if isinstance(target, (int, float)):
        index = int(target)
        return index if 0 <= index < len(source_document.pages) else None
    objgen = getattr(target, "objgen", None)
    if objgen is None:
        return None
    for index, page in enumerate(source_document.pages):
        if page.obj.objgen == objgen:
            return index
    return None
`;

// Nothing inside this script may contain a backtick: it is a template literal, and one in a comment terminates it.
// That is not a style note — it has cost two debugging sessions.
const DECORATE_SCRIPT = `${PY_PAGE_INDEX}
import json, sys
import pikepdf

payload = json.load(sys.stdin)

def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)

try:
    merged = pikepdf.open(payload["input"])
except Exception as exc:
    fail("the assembled document could not be reopened for decoration: %s" % exc)

mode = payload["mode"]
entries = 0
unresolved = 0
sources_with_outline = 0

# Page identity in the merged document is positional: the sources were concatenated in this order, so the page a
# source-local destination ends up on is its own index plus the pages of everything before it.
merged_pages = [page.obj.objgen for page in merged.pages]
offsets = []
cursor = 0
source_docs = []
for source in payload["sources"]:
    try:
        document = pikepdf.open(source["path"])
    except Exception:
        document = None
    source_docs.append((source, document, cursor))
    if document is not None:
        cursor += len(document.pages)
    offsets.append(cursor)

def build(source_document, destination_page, top_level, with_children=True):
    """Turn one source entry into a merged entry, remapping the pages it points at.

    with_children=False is the flatten path: the entry becomes a leaf in the merged outline and its own children are
    appended separately by the caller. Without the flag the child walk here rebuilds the subtree *and* the caller
    lifts the same children again — the first version did exactly that and produced a flattened outline in which
    every nested entry appeared twice.
    """
    global entries, unresolved
    page = page_index_in(source_document, top_level.destination)
    if page is None:
        unresolved += 1
        return None
    merged_page = merged.pages[destination_page + page]
    item = pikepdf.OutlineItem(top_level.title, pikepdf.Array([merged_page.obj, pikepdf.Name("/Fit")]))
    entries += 1
    if with_children:
        for child in top_level.children:
            made = build(source_document, destination_page, child)
            if made is not None:
                item.children.append(made)
    return item

def source_page(start):
    """The merged page a source begins on: where a keep-mode parent entry points when it is clicked."""
    return merged.pages[min(start, len(merged.pages) - 1)]

with merged.open_outline() as outline:
    outline.root = []
    if mode != "none":
        for (source, document, start) in source_docs:
            if document is None:
                continue
            try:
                source_root = document.open_outline().root
            except Exception:
                continue
            if len(source_root) == 0:
                continue
            if mode == "flatten":
                # One flat list: the source's own nesting is lifted, which is the whole of what "flatten" means here.
                appended = 0
                stack = list(source_root)
                while stack:
                    entry = stack.pop(0)
                    made = build(document, start, entry, with_children=False)
                    if made is not None:
                        outline.root.append(made)
                        appended += 1
                    # Pre-order, so the flattened list reads in document order: an entry immediately followed by the
                    # entries nested under it in the source.
                    stack = list(entry.children) + stack
                if appended > 0:
                    sources_with_outline += 1
            else:
                page = source_page(start)
                parent = pikepdf.OutlineItem(source["name"], pikepdf.Array([page.obj, pikepdf.Name("/Fit")]))
                for entry in source_root:
                    made = build(document, start, entry)
                    if made is not None:
                        parent.children.append(made)
                if len(parent.children) > 0:
                    outline.root.append(parent)
                    sources_with_outline += 1

# An empty outline is not the same as no outline: a reader that finds the dictionary reports a bookmarks sidebar
# which opens onto nothing. This is not only the none mode's case — keep and flatten over inputs that carry no outline
# at all land here with zero entries too, which is exactly what merging two plain documents is. The catalog is
# rewritten from the count rather than from the mode for that reason.
if entries == 0 and "/Outlines" in merged.Root:
    del merged.Root["/Outlines"]

metadata_copied = False
metadata_error = None
try:
    first = pikepdf.open(payload["sources"][0]["path"])
    for key, value in first.docinfo.items():
        # Plain strings, not the source's objects: an object from another document cannot be assigned into this one,
        # and pikepdf's own error for that is what made the first version of this report "copied: false" while
        # leaving the merge looking successful.
        merged.docinfo[key] = str(value)
    if "/Metadata" in first.Root:
        # copy_foreign is a method on Pdf, not a module function: it is the destination document that knows where the
        # copied object has to be renumbered. Reached through the wrong name first, and the AttributeError was
        # swallowed by this block's own except — which is why the failure is now reported in the result.
        merged.Root["/Metadata"] = merged.copy_foreign(first.Root["/Metadata"])
    metadata_copied = True
    first.close()
except Exception as exc:
    metadata_error = str(exc)

try:
    merged.save(payload["output"])
except Exception as exc:
    fail("the decorated document could not be written: %s" % exc)

print(json.dumps({
    "outlineEntries": entries,
    "unresolved": unresolved,
    "sourcesWithOutline": sources_with_outline,
    "metadataCopied": metadata_copied,
    "metadataError": metadata_error,
}))
`;

/**
 * Finish an assembled merge: rebuild the outline, carry the first input's metadata.
 *
 * The payload goes in on **stdin**, through the same bridge the password-carrying scripts use, even though nothing
 * here is a secret: the payload contains every source path in the job, and `/proc/<pid>/cmdline` is readable by the
 * sibling jobs running as the same user. One transport for both is easier to keep right than two.
 *
 * Throws nothing: a decoration failure is reported in `error` so the handler can ship the merged document with a
 * warning instead of failing a job whose pages are already correct.
 */
export async function decorateMergedDocument(
  input: DecorateMergedInput,
  opts: Omit<RunOptions, 'engine'>,
): Promise<DecorateMergedResult> {
  const empty: DecorateMergedResult = {
    outlineEntries: 0,
    unresolved: 0,
    sourcesWithOutline: 0,
    metadataCopied: false,
  };
  try {
    const result = await runPythonScriptStdin(DECORATE_SCRIPT, input, opts);
    const parsed = parseJsonLine<Partial<DecorateMergedResult> & { error?: string }>(result.stdout);
    if (!parsed) return { ...empty, error: 'the Python bridge printed nothing readable' };
    if (parsed.error) return { ...empty, error: parsed.error };
    return {
      outlineEntries: parsed.outlineEntries ?? 0,
      unresolved: parsed.unresolved ?? 0,
      sourcesWithOutline: parsed.sourcesWithOutline ?? 0,
      metadataCopied: parsed.metadataCopied ?? false,
      ...(parsed.metadataError ? { metadataError: parsed.metadataError } : {}),
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One output file, and the pages of one source it was built from.
 *
 * A *selection* rather than a concatenation, which is why this is not `DecorateMergedInput` with one source: the
 * page map here is `pages[i] -> i`, not `offset + page`, and a part of a document is exactly that. `split` is the
 * caller — every mode of it, since all four plans end as explicit page lists.
 */
export interface PageSelection {
  /** The document the pages were taken from. */
  source: string;
  /** The part qpdf built, rewritten in place. */
  output: string;
  /** The source's 1-based pages that make up this output, in output order. */
  pages: number[];
}

export interface PageSelectionResult {
  /** Entries written to this part's outline, at every level. */
  outlineEntries: number;
  /** Entries whose page is not in this part, or whose destination cannot be resolved. */
  unresolved: number;
  metadataCopied: boolean;
  /** Present when pikepdf refused this part; it is left as qpdf wrote it. */
  error?: string;
  metadataError?: string;
}

/**
 * Also measured, not assumed: `qpdf --empty --pages` builds a **new** document, so a split part has no `/Outlines`
 * and an empty `/Info` — the same fact `merge` was fixed for (defect 117), in the tool that hands the user the most
 * files. A three-part split of a bookmarked report produced three parts whose readers showed no bookmarks and an
 * untitled window, while `docs/02-SPLIT-AND-EXTRACT.md` §7 said "bookmarks preserved per part by default".
 *
 * All of a job's parts are decorated in **one** interpreter, because the alternative is one pikepdf import per part
 * and a 200-part split would spend a minute in `import pikepdf`. The work per part is tiny; the start-up is not.
 */
const SELECTION_SCRIPT = `${PY_PAGE_INDEX}
import json, os, sys
import pikepdf

payload = json.load(sys.stdin)

def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)

results = []

for job in payload["selections"]:
    result = {"outlineEntries": 0, "unresolved": 0, "metadataCopied": False, "error": None, "metadataError": None}
    results.append(result)

    try:
        source = pikepdf.open(job["source"])
    except Exception as exc:
        result["error"] = "the source document could not be reopened for decoration: %s" % exc
        continue

    try:
        part = pikepdf.open(job["output"])
    except Exception as exc:
        result["error"] = "the split part could not be reopened for decoration: %s" % exc
        source.close()
        continue

    # Where each source page landed in this part, keyed by **0-based** index because that is what page_index_in
    # returns: the payload's pages are 1-based, and the first version of this compared the two directly. The
    # off-by-one was invisible in a two-part split whose parts each happened to contain one entry — it showed up as
    # a part carrying the *next* page's bookmark, which reads as a plausible outline until you check a title.
    #
    # setdefault keeps the first: a page that appears twice in a selection (a deliberately duplicated cover, say)
    # has two destinations, and a bookmark pointing at it belongs at the first of them rather than the last.
    position = {}
    for index, page in enumerate(job["pages"]):
        position.setdefault(int(page) - 1, index)

    def build_into(entries, destination_list):
        """Remap one level of source entries into this part.

        A dropped entry hands its kept children to the same list it was going to be appended to, so a selection
        that starts at page 4 does not lose the sections of a chapter that begins on page 3: what the reader
        loses is the entry whose own page is not here, never its subtree. When the dropped entry was a parent,
        its kept children surface at the level above it, which in a split is the part's root.
        """
        for entry in entries:
            page = page_index_in(source, entry.destination)
            item = None
            if page is None:
                result["unresolved"] += 1
            elif page not in position:
                result["unresolved"] += 1
            else:
                target = part.pages[position[page]]
                item = pikepdf.OutlineItem(entry.title, pikepdf.Array([target.obj, pikepdf.Name("/Fit")]))
                result["outlineEntries"] += 1
                destination_list.append(item)
            build_into(entry.children, item.children if item is not None else destination_list)

    try:
        source_root = source.open_outline().root
    except Exception:
        source_root = []

    if len(source_root) > 0:
        with part.open_outline() as outline:
            outline.root = []
            build_into(source_root, outline.root)

    # Same rule as the merge decorator: a part whose outline is empty must carry no outline *dictionary*, because a
    # reader that finds one shows a Bookmarks sidebar opening onto nothing.
    if result["outlineEntries"] == 0 and "/Outlines" in part.Root:
        del part.Root["/Outlines"]

    try:
        for key, value in source.docinfo.items():
            part.docinfo[key] = str(value)
        if "/Metadata" in source.Root:
            part.Root["/Metadata"] = part.copy_foreign(source.Root["/Metadata"])
        result["metadataCopied"] = True
    except Exception as exc:
        result["metadataError"] = str(exc)

    # Written beside the part and moved onto it: pikepdf refuses to save over the file it has open, and a save that
    # dies half way must not leave the user with a truncated part in place of a good one.
    staged = job["output"] + ".decorated"
    try:
        part.save(staged)
        part.close()
        os.replace(staged, job["output"])
    except Exception as exc:
        result["error"] = "the decorated part could not be written: %s" % exc
    source.close()

print(json.dumps({"results": results}))
`;

/**
 * Give a set of split parts back what qpdf dropped: the bookmarks that fall inside each part, remapped onto that
 * part's own page numbers, and the source's metadata.
 *
 * A decoration failure is reported per part rather than thrown, so the handler can ship parts whose pages are already
 * correct with a warning instead of failing a job whose output a user can perfectly well open. The same policy as
 * `decorateMergedDocument`.
 */
export async function decoratePageSelections(
  selections: PageSelection[],
  opts: Omit<RunOptions, 'engine'>,
): Promise<PageSelectionResult[]> {
  const blank = (): PageSelectionResult => ({ outlineEntries: 0, unresolved: 0, metadataCopied: false });
  if (selections.length === 0) return [];

  try {
    const result = await runPythonScriptStdin(SELECTION_SCRIPT, { selections }, opts);
    const parsed = parseJsonLine<{ results?: Array<Partial<PageSelectionResult>> } & { error?: string }>(result.stdout);
    if (!parsed) {
      return selections.map(() => ({ ...blank(), error: 'the Python bridge printed nothing readable' }));
    }
    if (parsed.error) return selections.map(() => ({ ...blank(), error: parsed.error }));
    return selections.map((_, index) => {
      const entry = parsed.results?.[index];
      if (!entry) return { ...blank(), error: 'the Python bridge returned no result for this part' };
      return {
        outlineEntries: entry.outlineEntries ?? 0,
        unresolved: entry.unresolved ?? 0,
        metadataCopied: entry.metadataCopied ?? false,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.metadataError ? { metadataError: entry.metadataError } : {}),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return selections.map(() => ({ ...blank(), error: message }));
  }
}
