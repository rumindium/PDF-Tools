import { join } from 'node:path';
import type { AnnotateOptions, AnnotationElement } from '@pdftools/contracts/tools';
import {
  ANNOTATION_SUBTYPES,
  type AnnotationMark,
  type AnnotationPage,
  type AnnotationState,
  FLATTEN_ALPHA,
  type MarkBox,
  countPdfPages,
  flattenAnnotations,
  hexToRgbTriplet,
  marksOutsidePage,
  readAnnotations,
  readPageBoxes,
  readSignatureRecord,
  signatureInvalidatedWarning,
  writeAnnotations,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `annotate` — `docs/13-EDIT-AND-ANNOTATE.md` §2.
 *
 * The only tool here that writes **annotation dictionaries** rather than paint, and that is the whole product: a
 * highlight a reviewer can click, read the author of, move or delete, and — because the dictionary carries `/F 4` —
 * print. `edit-pdf` can draw a yellow rectangle in the same place, and the two outputs look identical on screen; only
 * one of them is still a document *about* the text when the reader opens it.
 *
 * Three decisions:
 *
 *  1. **`flatten: false` is the realised branch, and it is the default.** The report says which mechanism ran
 *     (`metrics.flattened`) because the two produce files that look the same and behave differently, and a caller
 *     should never have to guess which one they paid for.
 *  2. **The output is read back before it is returned.** Subtype counts per page are compared against what was
 *     requested, after subtracting what the input already had. A write that quietly dropped marks is the failure this
 *     tool exists to prevent, and the read-back is the only check that sees it: the count of annotations is not
 *     derivable from the request.
 *  3. **Flattening never touches the annotations that were already there.** "Flatten" here is a statement about the
 *     marks this job writes; a document that arrived with someone else's comments keeps them, and the job says so
 *     out loud (`EXISTING_ANNOTATIONS_UNTOUCHED`) rather than letting a caller assume it cleaned the file.
 *  4. **A mark that hangs off the page is reported, not silently written.** `ELEMENT_OFF_PAGE` is the sentence
 *     `13-EDIT-AND-ANNOTATE.md` §3 promises for a rectangle that only *partly* leaves its page — the user's mark is
 *     real and merely larger than the paper — and the job would otherwise report success over a mark nobody can see.
 */

/** `13-EDIT-AND-ANNOTATE.md` §2: 100 annotations per page (the contract caps a whole job at 500). */
const MAX_ANNOTATIONS_PER_PAGE = 100;

/**
 * Side of a note's icon box, in points.
 *
 * A `/Text` annotation's `/Rect` is the icon, not the text — the text lives in `/Contents` and the reader shows it in a
 * popup. 20 pt is the height of a line of body copy, so the icon lands where a reader expects to find it.
 */
const NOTE_ICON_PT = 20;

/** The `/T` for markup that carries no author of its own: the contract gives `note` an author but not highlight. */
const DEFAULT_AUTHOR = 'PDF Tools';

export const annotate: Handler<AnnotateOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to annotate.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to annotate.' });
  }

  const marks = groupByPage(options.annotations, pages);
  // What the caller marked beyond the paper (`docs/13-EDIT-AND-ANNOTATE.md` §3). Counted from the request rather than
  // from the engine's marks because a note's geometry is one icon box and a markup mark's is one rectangle per line —
  // the caller's numbers are what a warning about their coordinates has to be about.
  const boxes = await readPageBoxes(document.path, runOpts);
  const offPage = marksOutsidePage(boxes, options.annotations.map(annotationBox));
  // Read the input's own annotations before writing anything: they are what the "did we add what we promised"
  // comparison is measured against, and what the flatten branch warns about.
  const before = await readAnnotations(document.path, runOpts);
  // A mark — written or burned in — is a change to the file a signature covers. Read here, reported with the result.
  const signature = await readSignatureRecord(document.path, runOpts);

  report({
    progress: 25,
    phase: 'processing',
    message: options.flatten ? 'Burning the marks into the page.' : 'Writing the annotations.',
  });

  const outputPath = join(outputDir, 'annotated.pdf');
  const requested = { highlight: 0, underline: 0, strike: 0, note: 0 };

  if (options.flatten) {
    await flattenAnnotations(document.path, outputPath, marks, workDir, runOpts);
  } else {
    // One author for the whole job so a reader's comment list groups by person rather than by request. The first note
    // that names an author wins, because that is the only author the contract carries.
    const author = options.annotations.find((item) => item.type === 'note')?.author ?? DEFAULT_AUTHOR;
    await writeAnnotations(document.path, outputPath, marks, author, runOpts);
  }

  report({ progress: 80, phase: 'finalizing', message: 'Reading the annotations back.' });

  const after = await readAnnotations(outputPath, runOpts);
  const added = diffAnnotations(before, after);
  for (const page of marks) {
    for (const mark of page.marks) requested[mark.kind] += 1;
  }

  if (options.flatten) {
    // A flattened mark is paint. If the file gained an annotation dictionary, the burn went through the wrong code
    // path — the page content is what was supposed to change.
    const gained = Object.values(added).reduce((total, count) => total + count, 0);
    if (gained !== 0) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: `Flattening added ${gained} annotation(s) instead of drawing them into the page content.`,
      });
    }
  } else {
    for (const [kind, expected] of Object.entries(requested) as Array<[keyof typeof requested, number]>) {
      if (added[kind] < expected) {
        throw new JobFailure('CONVERSION_FAILED', {
          message: `The output contains ${added[kind]} ${kind} annotation(s) but ${expected} were requested.`,
        });
      }
    }
  }

  // Flattening draws dots inside the note's icon box; the text a reader would show in a popup cannot live in a content
  // stream, so a flattened note is its icon and nothing else. Said out loud, because a caller who asked for notes and
  // opened the file to find yellow squares would reasonably call that a bug.
  const noteCount = requested.note;
  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  if (options.flatten && noteCount > 0) {
    warnings.push({
      code: 'NOTE_FLATTENED_AS_ICON',
      detail: `${noteCount} note(s) are drawn as their icon; the note text is in the job's request, not in the output. Leave \`flatten\` off to keep notes a reader can open.`,
    });
  }
  if (options.flatten && before.total > 0) {
    warnings.push({
      code: 'EXISTING_ANNOTATIONS_UNTOUCHED',
      detail: `The document arrived with ${before.total} annotation(s); flattening applies to the marks this job writes, and the existing ones are still editable.`,
    });
  }
  if (offPage.length > 0) {
    warnings.push({
      code: 'ELEMENT_OFF_PAGE',
      detail: `${offPage.length} mark(s) extend past the edge of their page and are not visible there: ${[
        ...new Set(offPage.map((index) => options.annotations[index]!.page)),
      ]
        .sort((a, b) => a - b)
        .map((page) => `page ${page}`)
        .join(', ')}.`,
    });
  }

  // The one invariant every tool in this codebase shares, and the one a mark could plausibly break: nothing about
  // drawing onto a page needs a page added or dropped.
  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Annotating changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  // The print flag is asserted from the file, not from the write. Narrowed to a document that had no annotations of
  // its own: an input carrying someone else's non-printing mark would make the page's `allPrint` false through no
  // fault of this job, and failing that job would be the check lying rather than the write.
  if (!options.flatten && before.total === 0) {
    const unprintable = after.pages.filter((page) => page.subtypes.length > 0 && !page.allPrint);
    if (unprintable.length > 0) {
      throw new JobFailure('CONVERSION_FAILED', {
        message: `Annotations on page ${unprintable[0]!.page} are missing the print flag, so they would be invisible on paper.`,
      });
    }
  }

  return {
    outputs: [{ name: 'annotated.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      pagesAnnotated: marks.length,
      annotations: options.annotations.length,
      // One contract element can carry several rectangles (a drag across three lines is three marks in one element), so
      // the mark count is the number that matches what the file contains.
      marksWritten: Object.values(requested).reduce((total, count) => total + count, 0),
      byType: requested,
      flattened: options.flatten,
      flattenAlpha: options.flatten ? FLATTEN_ALPHA : null,
      annotationsInOutput: after.total,
      annotationsInInput: before.total,
      offPage: offPage.length,
      offPagePages: [...new Set(offPage.map((index) => options.annotations[index]!.page))].sort((a, b) => a - b),
      coordinateSystem: 'pdf-user-space-bottom-left-points',
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
    },
    warnings,
    engine: { name: options.flatten ? 'pikepdf+ghostscript' : 'pikepdf' },
  };
};

/**
 * A caller's annotation as its own rectangle, in PDF user space.
 *
 * Every kind has an exact box, which is the difference from `edit-pdf`: markup carries its rectangles and a note's
 * geometry is the icon a reader draws (20 pt at its lower-left), so nothing here is an estimate.
 */
function annotationBox(annotation: AnnotationElement): MarkBox {
  if (annotation.type === 'note') {
    return {
      page: annotation.page,
      xPt: annotation.x,
      yPt: annotation.y,
      widthPt: NOTE_ICON_PT,
      heightPt: NOTE_ICON_PT,
    };
  }
  const xs = annotation.rects.map((rect) => rect.x);
  const ys = annotation.rects.map((rect) => rect.y);
  const rights = annotation.rects.map((rect) => rect.x + rect.width);
  const tops = annotation.rects.map((rect) => rect.y + rect.height);
  // The union, because one element is one mark: a highlight across three lines is reported once if any of its three
  // rectangles leaves the page, which is how the user drew it.
  return {
    page: annotation.page,
    xPt: Math.min(...xs),
    yPt: Math.min(...ys),
    widthPt: Math.max(...rights) - Math.min(...xs),
    heightPt: Math.max(...tops) - Math.min(...ys),
  };
}

/** Marks per page as the engine wants them, refusing a page that does not exist and a page over the cap. */
function groupByPage(annotations: AnnotationElement[], pages: number): AnnotationPage[] {
  const byPage = new Map<number, AnnotationMark[]>();
  for (const annotation of annotations) {
    if (annotation.page > pages) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `An annotation targets page ${annotation.page}, but the document has ${pages}.`,
      });
    }
    const list = byPage.get(annotation.page) ?? [];
    if (annotation.type === 'note') {
      list.push({
        kind: 'note',
        xPt: annotation.x,
        yPt: annotation.y,
        text: annotation.text,
        author: annotation.author,
        iconSizePt: NOTE_ICON_PT,
      });
    } else {
      for (const rect of annotation.rects) {
        list.push({
          kind: annotation.type,
          rect: { xPt: rect.x, yPt: rect.y, widthPt: rect.width, heightPt: rect.height },
          color: hexToRgbTriplet(annotation.color),
        });
      }
    }
    byPage.set(annotation.page, list);
  }
  for (const [page, list] of byPage) {
    if (list.length > MAX_ANNOTATIONS_PER_PAGE) {
      throw new JobFailure('VALIDATION_ERROR', {
        message: `Page ${page} carries ${list.length} annotations; the limit is ${MAX_ANNOTATIONS_PER_PAGE} per page.`,
      });
    }
  }
  return [...byPage.entries()].sort(([a], [b]) => a - b).map(([page, pageMarks]) => ({ page, marks: pageMarks }));
}

/** How many annotations of each subtype the write added, per the two read-backs. */
function diffAnnotations(
  before: AnnotationState,
  after: AnnotationState,
): Record<'highlight' | 'underline' | 'strike' | 'note' | 'other', number> {
  const added = { highlight: 0, underline: 0, strike: 0, note: 0, other: 0 };
  const counts = (state: AnnotationState) => {
    const bySubtype = new Map<string, number>();
    for (const page of state.pages) {
      for (const subtype of page.subtypes) {
        bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);
      }
    }
    return bySubtype;
  };
  const beforeCounts = counts(before);
  for (const [subtype, count] of counts(after)) {
    const delta = count - (beforeCounts.get(subtype) ?? 0);
    if (delta <= 0) continue;
    // Subtype names come from the file, flattened: `/Highlight` and `Highlight` are the same annotation.
    const name = subtype.replace(/^\//, '').toLowerCase();
    const key = (Object.keys(ANNOTATION_SUBTYPES) as Array<keyof typeof ANNOTATION_SUBTYPES>).find(
      (kind) => ANNOTATION_SUBTYPES[kind].replace(/^\//, '').toLowerCase() === name,
    );
    added[key ?? 'other'] += delta;
  }
  return added;
}
