import { describe, expect, test } from 'bun:test';
import { TOOLS } from '@pdftools/contracts/tools';
import { removesPages } from '../tool-shell/page-rows-model';
import { coveredCount, describePages, fullyCovered, nextRange, pagePlan, resolvedPagesNote } from './plan';

/**
 * The arithmetic behind a preview that follows the options.
 *
 * These are the answers a person reads before pressing Run — which pages go in which file, and what is left out — so
 * each case below is a claim the preview makes, not an internal detail: a wrong grouping here is a preview that lies
 * about the output.
 */
describe('pagePlan — split by ranges', () => {
  test('one output per row, deduplicated and ascending', () => {
    const plan = pagePlan({
      toolId: 'split',
      values: { mode: 'ranges', ranges: [['1-3'], ['7', '4-5']] },
      pageCount: 8,
    });
    expect(plan.groups.map((group) => group.pages)).toEqual([
      [1, 2, 3],
      [4, 5, 7],
    ]);
    // The labels are the user's own words, which is what makes the preview legible next to the form.
    expect(plan.groups.map((group) => group.label)).toEqual(['1-3', '7, 4-5']);
    expect(plan.remaining).toEqual([6, 8]);
    expect(plan.note).toBe('2 pages in no output.');
    expect(plan.error).toBeNull();
  });

  test('the remaining pages are what no row names, and the note states them', () => {
    const plan = pagePlan({ toolId: 'split', values: { mode: 'ranges', ranges: [['1-5']] }, pageCount: 5 });
    expect(plan.remaining).toEqual([]);
    // Nothing left out means no note: a permanent \"0 pages in no output\" is noise on every correct split.
    expect(plan.note).toBeNull();
  });

  test('a row that reaches past the document keeps the pages that exist', () => {
    // `expandPageSpecs` does not clamp, by design: `split` refuses at the API with the real count, while the tools
    // that stamp pages keep what exists. The preview must not invent page 9 of an 8-page document.
    const plan = pagePlan({ toolId: 'split', values: { mode: 'ranges', ranges: [['1-3'], ['6-z']] }, pageCount: 8 });
    expect(plan.groups[1]!.pages).toEqual([6, 7, 8]);
    expect(plan.remaining).toEqual([4, 5]);
  });

  test('a spec this build refuses is an error, never a silent group', () => {
    const plan = pagePlan({ toolId: 'split', values: { mode: 'ranges', ranges: [['9-5']] }, pageCount: 8 });
    expect(plan.error).toContain('counts backwards');
    expect(plan.groups).toEqual([]);
  });

  test('an empty range list is a state, not an error: it is what a fresh form is', () => {
    const plan = pagePlan({ toolId: 'split', values: { mode: 'ranges' }, pageCount: 6 });
    expect(plan.groups).toEqual([]);
    expect(plan.remaining).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.error).toBeNull();
    expect(plan.note).toBe('Add a range to make an output file.');
  });

  test('mergeOutputs stops being one file per row, and says so', () => {
    const plan = pagePlan({
      toolId: 'split',
      values: { mode: 'ranges', ranges: [['1-3'], ['4-5']], mergeOutputs: true },
      pageCount: 5,
    });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.pages).toEqual([1, 2, 3, 4, 5]);
    expect(plan.note).toContain('merged back into a single file');
  });
});

describe('pagePlan — split by page count and by the file itself', () => {
  test('every N pages is planned the way the worker plans it, short last part included', () => {
    const plan = pagePlan({ toolId: 'split', values: { mode: 'every-n', everyNPages: 3 }, pageCount: 8 });
    expect(plan.groups.map((group) => group.pages)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8],
    ]);
    // "None larger than", not "of 3 pages each": the third file is `7–8`, and the note has to be true of it.
    expect(plan.note).toBe('3 files, none larger than 3 pages.');
  });

  test('by-size and by-bookmarks cannot be planned here, and say that instead of guessing', () => {
    const bySize = pagePlan({ toolId: 'split', values: { mode: 'by-size', bySizeMb: 5 }, pageCount: 8 });
    expect(bySize.groups[0]!.pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bySize.note).toContain('measured weight');

    const byBookmarks = pagePlan({ toolId: 'split', values: { mode: 'by-bookmarks' }, pageCount: 8 });
    expect(byBookmarks.note).toContain('outline');
  });
});

describe('pagePlan — the same option key, three meanings', () => {
  test('rotate keeps every page: the selection says which pages the option acts on', () => {
    const plan = pagePlan({ toolId: 'rotate', values: { pages: ['1-2'] }, pageCount: 5 });
    expect(plan.groups[0]!.pages).toEqual([1, 2, 3, 4, 5]);
    expect(plan.selected).toEqual([1, 2]);
    expect(plan.note).toBe('The other 3 pages stay as they are.');
  });

  test('extract-pages keeps only the selection', () => {
    const plan = pagePlan({ toolId: 'extract-pages', values: { pages: ['1-2'], mode: 'include' }, pageCount: 5 });
    expect(plan.groups[0]!.pages).toEqual([1, 2]);
    expect(plan.remaining).toEqual([3, 4, 5]);
  });

  test('delete-pages keeps the rest — the same key read backwards', () => {
    const plan = pagePlan({ toolId: 'delete-pages', values: { pages: ['1-2'] }, pageCount: 5 });
    expect(plan.groups[0]!.pages).toEqual([3, 4, 5]);
    expect(plan.remaining).toEqual([1, 2]);
  });

  test('extract-pages in exclude mode reads like delete-pages', () => {
    const plan = pagePlan({ toolId: 'extract-pages', values: { pages: ['1-2'], mode: 'exclude' }, pageCount: 5 });
    expect(plan.groups[0]!.pages).toEqual([3, 4, 5]);
  });

  test('a page the document does not have is refused, in the worker’s own words', () => {
    //
    // `extract-pages` checks this **before** it looks at `mode` (`workers/light/src/handlers/pages.ts`), so both
    // directions are refused — and the preview says which page and how long the document is, because that is what the
    // refusal will say and the count is the part the user cannot see. Without this the plan drew `Output · 99` over a
    // rectangle where page 99 would have been, and the mistake only arrived after pressing Run.
    //
    const kept = pagePlan({ toolId: 'extract-pages', values: { pages: ['2', '99'], mode: 'include' }, pageCount: 12 });
    expect(kept.error).toBe('This document has 12 pages; page 99 does not exist.');
    expect(kept.groups).toEqual([]);

    const removed = pagePlan({ toolId: 'extract-pages', values: { pages: ['99'], mode: 'exclude' }, pageCount: 12 });
    expect(removed.error).toBe('This document has 12 pages; page 99 does not exist.');

    // The other side of the same rule, which is why it is named per tool rather than derived from the output shape:
    // `delete-pages` subtracts nothing for a page that does not exist, so the plan draws the whole document and says so
    // by leaving the named pages out of the output it drew.
    const trimmed = pagePlan({ toolId: 'delete-pages', values: { pages: ['99'] }, pageCount: 12 });
    expect(trimmed.error).toBeNull();
    expect(trimmed.groups[0]!.pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('a removal that takes every page is refused, like the worker refuses it', () => {
    // Both directions of the same guard: `delete-pages` and `extract-pages` in `exclude` mode fail the job with these
    // words (`workers/light/src/handlers/pages.ts`). The preview used to draw one output holding **no pages**, and the
    // group header printed `pages unknown` for it — a sentence about a count that has not arrived, which reads as
    // "wait for the upload" and is not what happened here.
    const every = ['1-z'];
    expect(pagePlan({ toolId: 'delete-pages', values: { pages: every }, pageCount: 6 }).error).toBe(
      'Removing those pages would leave an empty document.',
    );
    expect(pagePlan({ toolId: 'extract-pages', values: { pages: every, mode: 'exclude' }, pageCount: 6 }).error).toBe(
      'Removing those pages would leave an empty document.',
    );
    // One page short of it is a perfectly good removal, which is what keeps this an assertion about the empty case
    // rather than about the guard firing at all.
    expect(pagePlan({ toolId: 'delete-pages', values: { pages: ['1-5'] }, pageCount: 6 }).error).toBeNull();
  });

  test('no selection means every page, which is what the API does with it', () => {
    const plan = pagePlan({ toolId: 'pdf-to-images', values: {}, pageCount: 4 });
    expect(plan.groups[0]!.pages).toEqual([1, 2, 3, 4]);
    expect(plan.groups[0]!.label).toBe('Every page');
    expect(plan.remaining).toEqual([]);
    expect(plan.note).toBeNull();
  });
});

describe('pagePlan — before the page count is known', () => {
  test('the specs that need the count are not expanded from a guess', () => {
    const plan = pagePlan({ toolId: 'split', values: { mode: 'ranges', ranges: [['1-z']] }, pageCount: null });
    // The group is still there, with its own label: dropping the row would make the preview disagree with the form about
    // how many outputs the user has asked for, and inventing a page count would draw pages that may not exist.
    expect(plan.groups.map((group) => group.label)).toEqual(['1-z']);
    expect(plan.groups[0]!.pages).toEqual([]);
    expect(plan.note).toContain('Waiting for the page count');
    expect(plan.error).toBeNull();
  });

  test('the specs that carry their own numbers still resolve', () => {
    const plan = pagePlan({ toolId: 'split', values: { mode: 'ranges', ranges: [['1-3']] }, pageCount: null });
    expect(plan.groups[0]!.pages).toEqual([1, 2, 3]);
    expect(plan.note).toContain('Waiting for the page count');
  });
});

describe('nextRange — what the add button writes', () => {
  test('the first gap after the rows, as one range', () => {
    expect(nextRange([['1-5']], 12)).toBe('6-12');
    expect(nextRange([['1-5'], ['7-8']], 12)).toBe('6');
    expect(nextRange([['1-5'], ['6-8']], 12)).toBe('9-12');
  });

  test('an empty list starts at 1 and runs to the end', () => {
    // The count is known, so the offer is explicit — `1-12`, the pages this document actually has.
    expect(nextRange([], 12)).toBe('1-12');
  });

  test('everything covered means nothing to add', () => {
    expect(nextRange([['1-12']], 12)).toBeNull();
    expect(nextRange([['1-6'], ['7-12']], 12)).toBeNull();
  });

  test('without a page count the offer is `N-z`, because the end is what is unknown', () => {
    expect(nextRange([['1-5']], null)).toBe('6-z');
    expect(nextRange([], null)).toBe('1-z');
  });

  test('a half-typed row does not stop the button, and does not hide the pages the other rows cover', () => {
    // `4-` is refused by the grammar, so that row contributes nothing; the offer continues after `1-3` rather than
    // starting over, which is what the user is in the middle of doing.
    expect(nextRange([['1-3'], ['4-']], 12)).toBe('4-12');
  });

  test('a row that reaches the end covers what it says, so the offer is the gap around it', () => {
    expect(nextRange([['5-z']], 8)).toBe('1-4');
  });
});

/**
 * The two sides a click moves a page between.
 *
 * These are the assertions that keep `delete-pages`' preview honest, because that tool is the one where guessing the
 * direction inverts the result: its option names the pages that **go**, so the pages it names are the ones the removed
 * half shows and the ones they are not are the output. A plan that read the value the other way round would draw a
 * perfect preview of the opposite job.
 */
describe('the two halves', () => {
  test('they partition the document, and the option names the removal side', () => {
    const plan = pagePlan({ toolId: 'delete-pages', values: { pages: ['2', '5-6'] }, pageCount: 7 });
    expect(plan.selection).toBe('removes');
    expect(plan.halves).toEqual({ kept: [1, 3, 4, 7], removed: [2, 5, 6] });
    // Every page exactly once, in both directions — the invariant the click relies on, because a page that is in neither
    // half could not be moved back.
    expect([...plan.halves!.kept, ...plan.halves!.removed].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The kept half is the output, which for this tool is `groups[0]` — stated here so the renderer never has to
    // assume it.
    expect(plan.groups[0]!.pages).toEqual(plan.halves!.kept);
  });

  test('`extract-pages` reads the same key the other way round, with the same halves', () => {
    const include = pagePlan({
      toolId: 'extract-pages',
      values: { mode: 'include', pages: ['2', '5-6'] },
      pageCount: 7,
    });
    expect(include.selection).toBe('keeps');
    expect(include.halves).toEqual({ kept: [2, 5, 6], removed: [1, 3, 4, 7] });
    const exclude = pagePlan({
      toolId: 'extract-pages',
      values: { mode: 'exclude', pages: ['2', '5-6'] },
      pageCount: 7,
    });
    expect(exclude.selection).toBe('removes');
    // The mirror of the include case, page for page: same value, opposite meaning.
    expect(exclude.halves).toEqual({ kept: [1, 3, 4, 7], removed: [2, 5, 6] });
  });

  test('an empty selection is the whole document kept, and nothing removed', () => {
    // The API's reading of an absent selection is "every page", so the removed half is empty rather than absent — the
    // section is drawn and says the fact, which is what tells a user their first click will do something.
    const plan = pagePlan({ toolId: 'delete-pages', values: {}, pageCount: 4 });
    expect(plan.halves).toEqual({ kept: [1, 2, 3, 4], removed: [] });
  });

  test('a tool with one side has no halves to draw', () => {
    // `rotate` names pages too, and its output is still every page: there is no second side, so no click can create one.
    expect(pagePlan({ toolId: 'rotate-pages', values: { pages: ['2'] }, pageCount: 4 }).halves).toBeNull();
    // A split's groups are outputs of their own — one file each — so its pages have no side either.
    expect(
      pagePlan({ toolId: 'split', values: { mode: 'ranges', ranges: [['1-2']] }, pageCount: 4 }).halves,
    ).toBeNull();
    // And before the count arrives, neither does a removal: which pages stay is the count's answer.
    expect(pagePlan({ toolId: 'delete-pages', values: { pages: ['2'] }, pageCount: null }).halves).toBeNull();
  });

  test('a removal that would empty the document draws no halves at all', () => {
    const plan = pagePlan({ toolId: 'delete-pages', values: { pages: ['1-z'] }, pageCount: 3 });
    expect(plan.error).toBe('Removing those pages would leave an empty document.');
    // The refusal is not a plan with two empty sides: there is nothing to draw, only something to say.
    expect(plan.halves).toBeNull();
  });
});

/**
 * The rule the direction is derived from, checked against the catalogue that declares it.
 *
 * `pagePlan` reads the direction out of `SHAPES` + `values.mode`, and the panel reads the *same* direction out of the
 * catalog's `removes` field — two spellings of one rule, which is exactly the shape of defect that survives review. This
 * walks the real catalogue: for every tool with a rows control, the plan's answer and the field's answer must agree, for
 * every value of the sibling the field names. A tool added with a `removes` rule the plan does not know about fails
 * here rather than in front of a user.
 */
describe('the direction, against the catalogue', () => {
  const rowsTools = TOOLS.flatMap((tool) =>
    (tool.optionsUi ?? [])
      .filter((field) => field.control === 'page-rows' || field.control === 'pages')
      .map((field) => ({ tool, field })),
  );

  test('every page-selecting control is covered by this check', () => {
    // Not an accident of the catalogue: if a tool gains a `page-rows` control and this list stops matching, the check
    // below silently stops testing it.
    expect(rowsTools.map(({ tool, field }) => `${tool.id}.${field.key}`)).toEqual([
      // The two page controls that decide an output's page list — the ones with two sides to draw.
      'extract-pages.pages',
      'delete-pages.pages',
      // The rest select pages to *act* on, with the whole document as the output: the stampers and the exporters. They
      // are in this list because they are read by the same check, and it asserts the answer is "no sides" rather than
      // skipping them. `reorder-pages` used to be here twice and is not any more — see the test below.
      'rotate.pages',
      'crop.pages',
      'pdf-to-images.pages',
      'pdf-to-text.pages',
      'pdf-to-html.pages',
      'pdf-to-csv.pages',
      'pdf-to-office.pages',
      'watermark.pages',
      'page-numbers.pages',
      'header-footer.pages',
      'ocr.pages',
    ]);
  });

  test('arranging is not selecting, and this list says so', () => {
    // `reorder-pages` reads every page of its document and chooses none of them: its three options are one arrangement,
    // declared as `page-order` controls and written by the board that draws the pages (`features/page-order/`). They are
    // not `pages` controls, so no page-selection check applies to them — and the assertion that says that is this one,
    // because the list above is exactly where the old reading ("the order is a page selection") used to live.
    expect((TOOLS.find((tool) => tool.id === 'reorder-pages')?.optionsUi ?? []).map((field) => field.control)).toEqual([
      'page-order',
      'page-order',
      'page-order',
    ]);
  });

  test('the plan and the control read the same value the same way', () => {
    for (const { tool, field } of rowsTools) {
      // The values to try: each option the `removes` rule names, plus a value-none-of-them state.
      const rule = field.removes;
      const modes = rule && rule !== true ? [...rule.when, 'something-else'] : [undefined];
      for (const mode of modes) {
        const values: Record<string, unknown> = { [field.key]: ['2'], pages: ['2'] };
        if (rule && rule !== true) values[rule.key] = mode;
        const fromField = removesPages(field, values);
        const fromPlan = pagePlan({ toolId: tool.id, values, pageCount: 5 }).selection;
        // `null` (no sides at all) is not the same claim as `'keeps'`; only a two-sided tool can be pinned this way.
        if (fromPlan == null) {
          expect(fromField).toBe(false);
          continue;
        }
        expect(`${tool.id} ${field.key} ${String(mode)}`).toBe(`${tool.id} ${field.key} ${String(mode)}`);
        expect(fromPlan === 'removes').toBe(fromField);
      }
    }
  });
});

describe('coverage and labels', () => {
  test('covered pages are counted against the document, and totality is its own question', () => {
    expect(coveredCount([['1-5']], 12)).toBe(5);
    expect(fullyCovered([['1-5']], 12)).toBe(false);
    expect(fullyCovered([['1-12']], 12)).toBe(true);
    // Before the count is known, nothing can be claimed to be complete.
    expect(fullyCovered([['1-z']], null)).toBe(false);
  });

  test('describePages writes the same shape the composition strip does', () => {
    expect(describePages([1, 2, 3, 4, 5])).toBe('1–5');
    expect(describePages([3])).toBe('3');
    expect(describePages([1, 2, 3, 7, 9, 10, 11])).toBe('1–3, 7, 9–11');
    expect(describePages([])).toBe('—');
  });

  test('the resolved-page note is hidden only when the label already says it', () => {
    // A literal range: the label *is* the answer, so the header does not print it twice (`Output · 1-3 · 1–3`).
    expect(resolvedPagesNote('1-3', [1, 2, 3])).toBeNull();
    expect(resolvedPagesNote('1–3', [1, 2, 3])).toBeNull();
    expect(resolvedPagesNote('1-3, 7', [1, 2, 3, 7])).toBeNull();
    expect(resolvedPagesNote('12', [12])).toBeNull();

    // A spec that had to be resolved: the label is what was asked for, the pages are what it turned out to be.
    expect(resolvedPagesNote('4-z', [4, 5, 6])).toBe('4–6');
    expect(resolvedPagesNote('even', [2, 4, 6])).toBe('2, 4, 6');
    expect(resolvedPagesNote('Every page', [1, 2])).toBe('1–2');

    // Prose labels are never the page list, so they always carry the note.
    expect(resolvedPagesNote('Pack by weight', [1, 2, 3])).toBe('1–3');
    expect(resolvedPagesNote('Follow the outline', [4, 5])).toBe('4–5');

    // Nearly equal is not equal: a label that folds to the same text but names other pages still shows them.
    expect(resolvedPagesNote('1-4', [1, 2, 3])).toBe('1–3');

    // No pages yet is not a note saying nothing — it is a group with no answer, which the caller words itself.
    expect(resolvedPagesNote('1-3', [])).toBeNull();
  });
});
