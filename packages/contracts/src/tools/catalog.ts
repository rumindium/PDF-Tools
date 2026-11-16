import * as O from './options';
import type { ToolDefinition } from './types';

/**
 * The tool catalog — `docs/0-TOOL-REGISTRY.md` §3.
 *
 * One definition per tool id. The API validates against it, the queue routes by its `queue`/`escalate` fields,
 * and the web app renders its catalog and forms from it. Adding a tool means adding one entry here plus one
 * worker handler — not edits in four places.
 *
 * `enabled` reflects what this build can actually run: a tool whose handler is not written yet is still listed
 * (so the UI can show "coming soon" honestly) but the API refuses to create a job for it.
 */

export const CATALOG_VERSION = 1;

const PDF = { accepts: ['application/pdf'], extensions: ['.pdf'], minFiles: 1, maxFiles: 1, maxFileMb: 300 };
const IMAGES = {
  accepts: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/tiff'],
  extensions: ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tiff', '.tif'],
  minFiles: 1,
  maxFiles: 100,
  maxFileMb: 100,
};
const OFFICE = {
  accepts: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'text/plain',
    'text/csv',
  ],
  extensions: ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.txt', '.csv'],
  minFiles: 1,
  maxFiles: 10,
  maxFileMb: 100,
};

export const TOOLS: ToolDefinition[] = [
  {
    id: 'merge',
    category: 'organize',
    queue: 'light',
    // 420 s on the heavy pool, per `01-MERGE.md` §7 — the escalation exists because the job is bigger, so the
    // budget grows with it.
    escalate: { queue: 'heavy', abovePages: 1000, aboveFiles: 20, timeoutSeconds: 420 },
    title: 'Merge PDF',
    summary: 'Combine several PDFs into one document, in the order you choose.',
    input: { ...PDF, minFiles: 2, maxFiles: 50 },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.MergeOptions,
    limits: { timeoutSeconds: 180, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      {
        key: 'bookmarks',
        control: 'select',
        label: 'Bookmarks',
        default: 'keep',
        choices: [
          { value: 'keep', label: 'Keep bookmarks' },
          { value: 'flatten', label: 'Flatten into one outline' },
          { value: 'none', label: 'Remove bookmarks' },
        ],
      },
      {
        key: 'order',
        control: 'file-order',
        label: 'Merge order',
        hint: 'Drag to reorder; the list order is the output order.',
      },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'split',
    category: 'organize',
    queue: 'light',
    title: 'Split PDF',
    summary: 'Break one document into several files, by range, page count, size, or bookmarks.',
    input: { ...PDF, maxFileMb: 300 },
    output: { kind: 'zip', mime: 'application/zip', archive: true },
    options: O.SplitOptions,
    limits: { timeoutSeconds: 180, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      {
        key: 'mode',
        control: 'select',
        label: 'Split by',
        default: 'ranges',
        choices: [
          { value: 'ranges', label: 'Page ranges' },
          { value: 'every-n', label: 'Every N pages' },
          { value: 'by-size', label: 'Target size' },
          { value: 'by-bookmarks', label: 'Bookmarks' },
        ],
      },
      {
        key: 'ranges',
        // One line per output: `ranges` is `string[][]`, and the flat `pages` control cannot express that. It used to
        // be declared as `pages`, which sent `["1-3", "4-8"]` to a schema that wants `[["1-3"], ["4-8"]]` — the
        // default mode of this tool was unusable from the browser and every golden case passed anyway, because the
        // cases post the nested shape themselves (`packages/contracts/src/tools/types.ts`, `range-groups`).
        control: 'range-groups',
        label: 'Ranges',
        // One row per output file, and the hint describes the control the form actually draws: two boxes per range, whose
        // empty second box means one page (`range-rows.tsx`). It used to teach the **typed** syntax — "1-3 in the first
        // and 4-z in the next" — which the boxes made true only by accident: the hyphen is drawn between them, so a hint
        // that spells it is describing a keystroke nobody makes any more, and `4-z` as *two* boxes is `4` and `z` with no
        // hyphen anywhere. A hint is prose about a control, and when the control changes the prose has to move with it or
        // the panel is teaching the previous version.
        hint: 'One output file per row. Each range is its first and last page — leave the last box empty for a single page. Several ranges in one row go into the same file.',
        visibleWhen: { mode: ['ranges'] },
      },
      {
        key: 'everyNPages',
        control: 'number',
        label: 'Pages per file',
        default: 10,
        min: 1,
        max: 500,
        visibleWhen: { mode: ['every-n'] },
      },
      {
        key: 'bySizeMb',
        control: 'number',
        label: 'Target MB',
        default: 5,
        min: 0.1,
        max: 500,
        unit: 'MB',
        visibleWhen: { mode: ['by-size'] },
      },
      {
        key: 'byBookmarks',
        control: 'select',
        label: 'Bookmark level',
        default: 'level1',
        choices: [
          { value: 'level1', label: 'Top level' },
          { value: 'level2', label: 'Two levels' },
          { value: 'all', label: 'Every bookmark' },
        ],
        visibleWhen: { mode: ['by-bookmarks'] },
      },
      { key: 'mergeOutputs', control: 'toggle', label: 'Also return one merged copy', default: false, advanced: true },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'extract-pages',
    category: 'organize',
    queue: 'light',
    title: 'Extract pages',
    summary: 'Keep the pages you need and drop the rest.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.ExtractPagesOptions,
    limits: { timeoutSeconds: 120, memoryMb: 1024, maxPages: 0 },
    //
    // The choice comes **first**, and it is the whole reason this form reads in the right order: `mode` decides what
    // the pages below it mean, so asking for the pages first is asking a question whose answer changes meaning. Both
    // field labels are its words — `Pages to keep` / `Pages to remove` are the two positions, and the rows control
    // beneath is named neutrally (`Pages`) because its meaning is now the choice above it (`types.ts`, `removes`).
    //
    optionsUi: [
      {
        key: 'mode',
        control: 'segmented',
        label: 'Where the pages go',
        default: 'include',
        choices: [
          {
            value: 'include',
            label: 'Pages to keep',
            icon: 'page-keep',
            note: 'The output is exactly the pages you name.',
          },
          {
            value: 'exclude',
            label: 'Pages to remove',
            icon: 'page-remove',
            note: 'The output is every page you did not name.',
          },
        ],
      },
      {
        key: 'pages',
        control: 'page-rows',
        label: 'Pages',
        hint: 'A page is one box; a range is two. Add as many as you need.',
        removes: { key: 'mode', when: ['exclude'] },
      },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'delete-pages',
    category: 'organize',
    queue: 'light',
    title: 'Remove pages',
    summary: 'Delete unwanted pages from a document.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.DeletePagesOptions,
    limits: { timeoutSeconds: 120, memoryMb: 1024, maxPages: 0 },
    // The same rows as `extract-pages`, one decision shorter: this tool's option *is* the removal, so there is no
    // choice above it and the direction is stated on the field (`removes: true`).
    optionsUi: [
      {
        key: 'pages',
        control: 'page-rows',
        label: 'Pages to remove',
        hint: 'A page is one box; a range is two. Add as many as you need.',
        removes: true,
      },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'reorder-pages',
    category: 'organize',
    queue: 'light',
    title: 'Organize pages',
    summary: 'Reorder, duplicate, or reverse pages.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.ReorderPagesOptions,
    limits: { timeoutSeconds: 120, memoryMb: 1024, maxPages: 0 },
    //
    // All three options are owned by one board, and all three therefore declare the same control (`page-order`): the
    // value of `order` *is* the arrangement of the pages drawn above, and `duplicate`/`reverse` are the two other ways
    // of saying the same thing about that arrangement. Two text boxes asking for page numbers were how this form used to
    // work — and asking a person to type a **permutation** of a document they are looking at is the worst input in the
    // whole catalogue (defect 226). The labels are still read: the options panel draws them as the sentence pointing at
    // the board when it is rendered without one (`renderPageOrder`), and the registry test requires a control per key.
    //
    optionsUi: [
      {
        key: 'order',
        control: 'page-order',
        label: 'New page order',
        hint: 'Drag a page to move it, or use its arrow buttons.',
      },
      {
        key: 'duplicate',
        control: 'page-order',
        label: 'Duplicate these pages',
        hint: 'Use the ⊕ on a page to keep a second copy of it right after the original.',
      },
      {
        key: 'reverse',
        control: 'page-order',
        label: 'Reverse the document',
        hint: 'Sends the pages back to front — the same as moving every one of them by hand.',
        default: false,
      },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'rotate',
    category: 'organize',
    queue: 'light',
    title: 'Rotate PDF',
    summary: 'Turn pages upright, all of them or just the ones you pick.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.RotateOptions,
    limits: { timeoutSeconds: 120, memoryMb: 1024, maxPages: 0 },
    //
    // `angle` and `perPage` are one fact — which way each page comes out — and both are owned by the board that draws the
    // pages (`page-turn`): three buttons for the whole document (or the selection), `⟳`/`⟲` on a tile for one page.
    // What was here before was a dropdown, a range box and a **JSON box** for a map of page → angle, on the one tool whose
    // entire product is an orientation — so the part of the request that says "page 3 the other way round" was written by
    // hand, at a document the screen had already drawn.
    //
    // **`angle` has no `default` here, and it is the only field in this catalogue without one.** `default: 90` is what
    // the *schema* does with an empty request, and it was also what the board drew the moment a file arrived: every page
    // a quarter turn before the user had asked for anything, which is a rotation nobody chose, applied to a document
    // nobody had described yet. So the form starts with nothing named, the board draws the pages as they are, and the
    // request is refused until a page turns — `tools.$toolId.tsx` holds up the Run button's half of that, and the
    // board's summary says why. Nothing else here bends the rule `initialOptionValues` states (a default *is* the API's
    // default) — this is the one field where drawing the default would be a promise the screen has no business making.
    //
    // `pages` is **rows of boxes** rather than a typed range, and that is not one of the angles: it is the set of pages
    // that turn — the target the toolbar acts on *and* the pages a tile's number writes when a page is switched off
    // (`toggleTurn`), so the boxes are the same value as the drawing above them rather than a second control that can
    // disagree with it. `turns` is what tells that control which of its readings this is, so its sentence counts pages
    // that turn and not pages kept, removed or cropped (`types.ts`).
    //
    optionsUi: [
      {
        key: 'angle',
        control: 'page-turn',
        label: 'Rotation',
        hint: 'Every page turns this much clockwise — or turn one page on its own with ⟳ beside it.',
        choices: [
          { value: 90, label: '90° clockwise' },
          { value: 180, label: '180°' },
          { value: 270, label: '90° counter-clockwise' },
        ],
      },
      {
        key: 'pages',
        control: 'page-rows',
        label: 'Pages that turn',
        hint: 'A page is one box; a range is two. Add as many as you need — leave empty and every page turns.',
        turns: true,
      },
      {
        key: 'perPage',
        control: 'page-turn',
        label: 'Per-page angles',
        hint: 'Set page by page; a page the board leaves alone keeps the /Rotate it already carries.',
        advanced: true,
      },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'crop',
    category: 'organize',
    queue: 'light',
    title: 'Crop PDF',
    summary: 'Trim margins or crop to the visible content.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.CropOptions,
    limits: { timeoutSeconds: 150, memoryMb: 1024, maxPages: 0 },
    //
    // `box` is the board's (`crop-box`): four insets from the page's edges, which a drag on the page writes directly.
    // It was the last **JSON editor** in the product, and the argument is the one every board in this category makes —
    // the value is about a page this screen can draw, and `{"top":20,"right":20,"bottom":20,"left":20}` is a sentence
    // about a document the user is looking at. `units` stays an ordinary select beside it, because which unit the four
    // numbers are in is a question with its own answer, and `auto` stays a toggle: it *replaces* the box rather than
    // configuring it, and the board reads it to decide which face to draw.
    //
    optionsUi: [
      { key: 'auto', control: 'toggle', label: 'Auto-crop to content', default: false },
      {
        key: 'box',
        control: 'crop-box',
        label: 'Crop box',
        hint: 'Drag the edges on the page, or type the insets below.',
        //
        // A **default box**, and it is not a convenience: the handler refuses a request with neither `auto` nor `box`
        // (`VALIDATION_ERROR`), so a board that opened on "nothing trimmed" would be showing a form whose Run button
        // produces an error the user has no way to read. 10 mm off every edge is a crop that visibly does something, is
        // obviously adjustable by dragging, and is undoable because the crop is written to `/CropBox` only. The board's
        // chips and Reset write this same value, so "back to the start" means one thing.
        default: { top: 10, right: 10, bottom: 10, left: 10 },
        visibleWhen: { auto: [false] },
      },

      //
      // **The selection is rows of boxes, and it is the third direction of that control.** The tool applies one box to
      // many pages, so the selection is neither an output (`extract-pages`) nor a removal (`delete-pages`) — it is the
      // set the crop is written onto, and `applies` is what makes the sentence say so (`types.ts`). The other half of
      // that reading is the empty case: no rows is **every page**, not an empty selection, and both the hint and the
      // control say it rather than leaving it to be inferred from the handler.
      {
        key: 'pages',
        control: 'page-rows',
        label: 'Pages to crop',
        hint: 'Leave empty to crop every page',
        advanced: true,
        applies: true,
      },
      {
        key: 'units',
        control: 'select',
        label: 'Units',
        default: 'mm',
        choices: [
          { value: 'mm', label: 'Millimetres' },
          { value: 'pt', label: 'Points' },
          { value: 'percent', label: 'Percent' },
        ],
        visibleWhen: { auto: [false] },
      },
    ],
    phase: 5,
    // Enabled with a handler and golden cases: the crop is written to /CropBox only, so the MediaBox and every
    // content stream survive — the cases assert both boxes, which is the difference between a real crop and a no-op.
    enabled: true,
  },
  {
    id: 'n-up',
    category: 'organize',
    queue: 'light',
    title: 'Pages per sheet',
    summary: 'Print multiple pages on one sheet — handy for handouts.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.NUpOptions,
    limits: { timeoutSeconds: 150, memoryMb: 1024, maxPages: 0 },
    //
    // `perSheet`, `orientation` and `pageSize` are the board's: the first two are `sheet-grid`, because neither survives
    // being a name without a picture — "6 per sheet" is two columns of three, and the orientation is which way those
    // columns lie — and the stock is `sheet-paper`, because a dropdown of five paper names on a screen that draws the
    // paper was the same mistake one option further out. They keep their `choices`, because the choices are what the
    // board draws as diagrams and a label is still the catalog's own. The other two options stay ordinary controls
    // beside the picture: the gap and the frame are settings of the sheet rather than facts about its shape, and every
    // one of the five still redraws it on the spot.
    //
    optionsUi: [
      {
        key: 'perSheet',
        control: 'sheet-grid',
        label: 'Pages per sheet',
        default: 2,
        choices: [2, 4, 6, 9, 16].map((n) => ({ value: n, label: `${n} per sheet` })),
      },
      {
        key: 'orientation',
        control: 'sheet-grid',
        label: 'Orientation',
        default: 'portrait',
        choices: [
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
      },
      { key: 'gap', control: 'number', label: 'Gap', default: 3, min: 0, max: 20, unit: 'mm' },
      {
        key: 'pageSize',
        control: 'sheet-paper',
        label: 'Sheet size',
        default: 'a4',
        choices: [
          { value: 'source', label: 'Follow the original page' },
          { value: 'a4', label: 'A4' },
          { value: 'a3', label: 'A3' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
        ],
      },
      { key: 'border', control: 'toggle', label: 'Frame each page', default: false, advanced: true },
    ],
    phase: 5,
    // Enabled with a handler and golden cases. Sheets are composed by placing each source page as a Form XObject:
    // every n-up engine (pdftk, pdfjam, pdfcpu) is absent from this image, and this route keeps the output vector, so
    // the text is still extractable and asserted.
    enabled: true,
  },
  {
    id: 'images-to-pdf',
    category: 'convert',
    queue: 'light',
    title: 'Images to PDF',
    summary: 'Turn JPG, PNG, WEBP, HEIC, or TIFF files into one PDF.',
    input: { ...IMAGES },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.ImagesToPdfOptions,
    limits: { timeoutSeconds: 300, memoryMb: 1536, maxPages: 0 },
    optionsUi: [
      {
        key: 'pageSize',
        control: 'select',
        label: 'Page size',
        default: 'fit',
        choices: [
          { value: 'fit', label: 'Fit the image' },
          { value: 'a4', label: 'A4' },
          { value: 'a3', label: 'A3' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
        ],
      },
      { key: 'margin', control: 'number', label: 'Margin', default: 0, min: 0, max: 50, unit: 'mm' },
      {
        key: 'orientation',
        control: 'select',
        label: 'Orientation',
        default: 'auto',
        choices: [
          { value: 'auto', label: 'Auto — follow each image' },
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
        visibleWhen: { pageSize: ['a3', 'a4', 'letter', 'legal'] },
      },
      { key: 'order', control: 'file-order', label: 'Image order' },
      {
        key: 'fit',
        control: 'select',
        label: 'Scaling',
        default: 'contain',
        choices: [
          { value: 'contain', label: 'Contain (fit inside)' },
          { value: 'cover', label: 'Cover (fill the page)' },
          { value: 'stretch', label: 'Stretch' },
        ],
        visibleWhen: { pageSize: ['a4', 'a3', 'letter', 'legal'] },
        advanced: true,
      },
      {
        key: 'heicFallback',
        control: 'select',
        label: 'Unreadable HEIC files',
        default: 'convert',
        hint: 'HEIC decoding is slower than the rest.',
        choices: [
          { value: 'convert', label: 'Convert them anyway (slower)' },
          { value: 'reject', label: 'Reject them' },
        ],
        advanced: true,
      },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'pdf-to-images',
    category: 'convert',
    queue: 'light',
    title: 'PDF to images',
    summary: 'Export pages as JPG, PNG, or WEBP at the resolution you choose.',
    input: { ...PDF },
    output: { kind: 'image-zip', mime: 'application/zip', archive: true },
    options: O.PdfToImagesOptions,
    limits: { timeoutSeconds: 300, memoryMb: 2048, maxPages: 0 },
    optionsUi: [
      {
        key: 'format',
        control: 'select',
        label: 'Format',
        default: 'jpg',
        choices: [
          { value: 'jpg', label: 'JPG' },
          { value: 'png', label: 'PNG' },
          { value: 'webp', label: 'WEBP' },
        ],
      },
      {
        key: 'dpi',
        control: 'select',
        label: 'Resolution',
        default: 150,
        choices: [
          { value: 72, label: '72 dpi — preview' },
          { value: 150, label: '150 dpi — screen' },
          { value: 300, label: '300 dpi — print' },
          { value: 600, label: '600 dpi — archival' },
        ],
      },
      { key: 'pages', control: 'pages', label: 'Pages', hint: 'Leave empty to export every page' },
      {
        key: 'colorMode',
        control: 'select',
        label: 'Colour',
        default: 'color',
        choices: [
          { value: 'color', label: 'Colour' },
          { value: 'grayscale', label: 'Grayscale' },
          { value: 'bw', label: 'Black & white' },
        ],
      },
      {
        key: 'quality',
        control: 'number',
        label: 'JPEG quality',
        default: 85,
        min: 1,
        max: 100,
        visibleWhen: { format: ['jpg', 'webp'] },
        advanced: true,
      },
      // The `zipSingle` toggle stood here. Its hint said "A one-page PDF comes back as a ZIP unless this is on", and
      // the product did the opposite in both positions: the runtime packs an archive only for a multi-output job, so a
      // one-page export is served as the image itself whatever the toggle says (defect 128, pass 3). A control whose
      // two positions do the same thing is a promise in the UI that nothing keeps, so it is gone rather than
      // implemented — making the hinted default true would take three layers producing a one-entry archive.
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'pdf-to-text',
    category: 'convert',
    queue: 'light',
    title: 'PDF to text',
    summary: 'Pull the text out of a document, one page break at a time.',
    input: { ...PDF },
    output: { kind: 'text', mime: 'text/plain' },
    options: O.PdfToTextOptions,
    limits: { timeoutSeconds: 180, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      { key: 'pages', control: 'pages', label: 'Pages' },
      {
        key: 'layout',
        control: 'select',
        label: 'Layout',
        default: 'plain',
        choices: [
          { value: 'plain', label: 'Plain reading order' },
          { value: 'preserve', label: 'Preserve spacing' },
        ],
      },
      { key: 'ocrFallback', control: 'toggle', label: 'Run OCR on scanned pages', default: false, advanced: true },
    ],
    phase: 4,
    enabled: true,
  },
  {
    id: 'pdf-to-html',
    category: 'convert',
    queue: 'heavy',
    title: 'PDF to HTML',
    summary: 'Convert a document to a web page, with images alongside it.',
    input: { ...PDF },
    output: { kind: 'html', mime: 'application/zip', archive: true },
    options: O.PdfToHtmlOptions,
    limits: { timeoutSeconds: 300, memoryMb: 2048, maxPages: 0 },
    optionsUi: [
      {
        key: 'mode',
        control: 'select',
        label: 'Conversion mode',
        default: 'reflow',
        choices: [
          { value: 'reflow', label: 'Reflow — semantic HTML' },
          { value: 'fixed', label: 'Fixed — keep the page layout' },
        ],
      },
      { key: 'embedImages', control: 'toggle', label: 'Embed images', default: true },
      {
        key: 'singleFile',
        control: 'toggle',
        label: 'Pack it into one HTML file',
        default: false,
        hint: 'Images are inlined rather than written alongside it.',
        advanced: true,
      },
      {
        key: 'responsive',
        control: 'toggle',
        label: 'Responsive layout',
        default: true,
        visibleWhen: { mode: ['reflow'] },
        advanced: true,
      },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
    ],
    phase: 5,
    // Enabled with a handler and three golden cases. `reflow` is built from Poppler's positioned blocks rather than
    // being a reader mode, and the page raster it emits is dropped in that mode (reported as PAGE_RASTER_DROPPED) —
    // see the handler and docs/08-PDF-TO-OFFICE-AND-TEXT.md.
    enabled: true,
  },
  {
    id: 'pdf-to-csv',
    category: 'convert',
    queue: 'heavy',
    title: 'PDF to CSV',
    summary: 'Extract tables from a document into spreadsheets.',
    input: { ...PDF },
    output: { kind: 'csv', mime: 'text/csv' },
    options: O.PdfToCsvOptions,
    limits: { timeoutSeconds: 300, memoryMb: 2048, maxPages: 0 },
    optionsUi: [
      {
        key: 'tableStrategy',
        control: 'select',
        label: 'Table detection',
        default: 'auto',
        choices: [
          { value: 'auto', label: 'Automatic' },
          { value: 'ruled', label: 'Ruled tables' },
          { value: 'stream', label: 'Whitespace-aligned tables' },
        ],
      },
      {
        key: 'delimiter',
        control: 'select',
        label: 'Column separator',
        default: ',',
        choices: [
          { value: ',', label: 'Comma — 1,234' },
          { value: ';', label: 'Semicolon — 1;234' },
          { value: '\t', label: 'Tab' },
        ],
      },
      { key: 'headerRow', control: 'toggle', label: 'First row is a heading', default: true },
      {
        key: 'allTables',
        control: 'toggle',
        label: 'Extract every table',
        default: true,
        // "in the document", not "per page": the handler keeps one table — the largest, measured by rows × columns
        // across everything `camelot` found — and a hint promising one per page would describe a filter nobody wrote.
        // Found in pass 8 by measuring the flag on a two-table, four-page fixture (`tables-mixed-a4.pdf`), which is
        // also what made the branch testable at all.
        hint: 'Off keeps only the largest table in the document.',
        advanced: true,
      },
      { key: 'decimalComma', control: 'toggle', label: 'Numbers use a decimal comma', default: false, advanced: true },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
    ],
    phase: 5,
    // Enabled with a handler, four golden cases and the ruled/whitespace fixtures. Camelot is in the heavy image for
    // exactly this tool (`docs/08-…` §4); note that `headerRow: false` cannot be honoured — see the handler.
    enabled: true,
  },
  {
    id: 'office-to-pdf',
    category: 'convert',
    queue: 'office',
    title: 'Office to PDF',
    summary: 'Convert DOCX, XLSX, PPTX, ODF, TXT, or CSV into PDF.',
    input: { ...OFFICE },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.OfficeToPdfOptions,
    limits: { timeoutSeconds: 300, memoryMb: 1536, maxPages: 0 },
    optionsUi: [
      // The orientation control that used to sit here was removed rather than repaired: `IsLandscape` changes nothing
      // in any of the three export filters this tool uses (measured — identical portrait output for a spreadsheet, a
      // text document and a deck), so a dropdown that returned the same file either way was a lie in the toolbar.
      // See `docs/07-OFFICE-TO-PDF.md` §2.
      { key: 'fitToPage', control: 'toggle', label: 'Fit each sheet to one page', default: true },
      { key: 'pageRange', control: 'text', label: 'Pages', hint: 'e.g. 1-3 or 1,4', advanced: true },
      { key: 'slideNotes', control: 'toggle', label: 'Include speaker notes', default: false },
    ],
    phase: 4,
    enabled: true,
  },
  {
    id: 'html-to-pdf',
    category: 'convert',
    queue: 'office',
    title: 'HTML to PDF',
    summary: 'Render a web page or an HTML file to PDF.',
    input: {
      accepts: ['text/html', 'application/zip'],
      extensions: ['.html', '.htm', '.zip'],
      minFiles: 1,
      maxFiles: 10,
      maxFileMb: 50,
    },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.HtmlToPdfOptions,
    limits: { timeoutSeconds: 240, memoryMb: 1536, maxPages: 0 },
    optionsUi: [
      {
        key: 'pageSize',
        control: 'select',
        label: 'Page size',
        default: 'a4',
        choices: [
          { value: 'a4', label: 'A4' },
          { value: 'a3', label: 'A3' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
        ],
      },
      { key: 'landscape', control: 'toggle', label: 'Landscape', default: false },
      { key: 'marginMm', control: 'number', label: 'Margin', default: 12, min: 0, max: 50, unit: 'mm' },
      { key: 'printBackground', control: 'toggle', label: 'Print background colours', default: true, advanced: true },
    ],
    phase: 4,
    // Enabled with a handler and two golden cases. LibreOffice's export filter carries no page geometry, so the
    // @page rule is injected into the HTML before conversion — see the handler and docs/07-OFFICE-TO-PDF.md.
    enabled: true,
  },
  {
    id: 'pdf-to-office',
    category: 'convert',
    // `heavy`, not `office`, and the reason is the engines rather than the family: all three reconstruction paths live
    // there — pdf2docx + python-docx (docx), Camelot + openpyxl (xlsx) and PyMuPDF + python-pptx (pptx). The office
    // pool keeps LibreOffice, which is what the *reverse* direction (`office-to-pdf`) needs, and duplicating ~350 MB
    // of Python wheels into a second image to keep the queue tidy would be the wrong trade.
    queue: 'heavy',
    title: 'PDF to Office',
    summary: 'Reconstruct an editable Word, Excel, or PowerPoint file from a PDF.',
    input: { ...PDF },
    output: {
      kind: 'office',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    options: O.PdfToOfficeOptions,
    limits: { timeoutSeconds: 420, memoryMb: 2048, maxPages: 0 },
    optionsUi: [
      {
        key: 'target',
        control: 'select',
        label: 'Output format',
        choices: [
          { value: 'docx', label: 'Word (.docx)' },
          { value: 'xlsx', label: 'Excel (.xlsx)' },
          { value: 'pptx', label: 'PowerPoint (.pptx)' },
        ],
      },
      {
        key: 'keepLayout',
        control: 'toggle',
        label: 'Keep the original layout',
        default: true,
        visibleWhen: { target: ['docx'] },
        hint: 'Off gives flowing paragraphs rather than positioned text.',
      },
      {
        key: 'detectTables',
        control: 'toggle',
        label: 'Rebuild tables',
        default: true,
        visibleWhen: { target: ['docx', 'xlsx'] },
        hint: 'Off writes the text as paragraphs, or as one column per page.',
      },
      {
        key: 'oneSheetPerPage',
        control: 'toggle',
        label: 'One sheet per page',
        default: false,
        visibleWhen: { target: ['xlsx'] },
        advanced: true,
      },
      {
        key: 'imageQuality',
        control: 'number',
        label: 'Slide image quality',
        default: 85,
        min: 1,
        max: 100,
        visibleWhen: { target: ['pptx'] },
        advanced: true,
      },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
    ],
    phase: 5,
    // Enabled with all three branches: pdf2docx (layout, tables), Camelot + openpyxl (sheets), PyMuPDF + python-pptx
    // (a page image per slide with editable text boxes on top). See the handler for what each option actually does.
    enabled: true,
  },
  {
    id: 'pdf-to-pdfa',
    category: 'convert',
    queue: 'heavy',
    title: 'PDF to PDF/A',
    summary: 'Convert a document to the archival standard, with a conformance check.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.PdfToPdfaOptions,
    limits: { timeoutSeconds: 420, memoryMb: 3072, maxPages: 0 },
    optionsUi: [
      {
        key: 'profile',
        control: 'select',
        label: 'Profile',
        default: '2b',
        choices: [
          { value: '2b', label: 'PDF/A-2b (recommended)' },
          { value: '1b', label: 'PDF/A-1b (strictest)' },
          { value: '3b', label: 'PDF/A-3b (allows attachments)' },
        ],
        // The comparison `09-PDF-A.md` §2 prints "as shown in the UI", and the reason it is attached to this field
        // rather than left in the page: what separates the three profiles is not their names but transparency,
        // encryption and which ISO part each is based on, and a radio label cannot carry three columns. The rows are
        // the document's own table, and the unit test beside the registry asserts they stay aligned with `choices`.
        comparison: {
          columns: ['Profile', 'Based on', 'Transparency', 'Encryption', 'Best for'],
          rows: [
            [
              'PDF/A-1b',
              'PDF 1.4',
              'forbidden (flattened)',
              'forbidden',
              'long-term archives where strictness matters more than fidelity',
            ],
            [
              'PDF/A-2b',
              'PDF 1.7 (ISO 19005-2)',
              'allowed',
              'forbidden',
              'modern archives, contracts, invoices — the default',
            ],
            [
              'PDF/A-3b',
              'PDF 1.7 (ISO 19005-3)',
              'allowed',
              'forbidden',
              'archives that must reference embedded files (e.g. XML invoice data)',
            ],
          ],
        },
      },
      {
        key: 'embedAllFonts',
        control: 'toggle',
        label: 'Embed every font',
        default: true,
        hint: 'PDF/A requires it; it can increase the file size.',
        advanced: true,
      },
      { key: 'forceSrgb', control: 'toggle', label: 'Convert colour to sRGB', default: true, advanced: true },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'compress',
    category: 'optimize',
    queue: 'light',
    // Thresholds and budget from `04-COMPRESS.md` §6: above 300 pages or 100 MB the job moves to `heavy` with the
    // same recipe and 420 s. The catalog previously said 500 pages / 60 MB, which contradicted the one document
    // that defines them.
    escalate: { queue: 'heavy', abovePages: 300, aboveBytes: 100 * 1024 * 1024, timeoutSeconds: 420 },
    title: 'Compress PDF',
    summary: 'Reduce file size while keeping the document readable.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.CompressOptions,
    limits: { timeoutSeconds: 300, memoryMb: 2048, maxPages: 0 },
    optionsUi: [
      {
        key: 'preset',
        control: 'select',
        label: 'Compression level',
        default: 'recommended',
        choices: [
          { value: 'light', label: 'Light — best quality' },
          { value: 'recommended', label: 'Recommended' },
          { value: 'extreme', label: 'Extreme — smallest file' },
          { value: 'custom', label: 'Custom' },
        ],
      },
      {
        key: 'targetSizeMb',
        control: 'number',
        label: 'Aim for this size',
        min: 0.05,
        max: 500,
        step: 0.5,
        unit: 'MB',
        hint: 'Leave empty to compress as far as the level allows.',
        visibleWhen: { preset: ['custom'] },
      },
      { key: 'dpi', control: 'number', label: 'Image resolution', default: 150, min: 36, max: 300, unit: 'dpi' },
      { key: 'imageQuality', control: 'number', label: 'Image quality', default: 70, min: 10, max: 100 },
      { key: 'stripMetadata', control: 'toggle', label: 'Remove metadata', default: true, advanced: true },
      { key: 'linearize', control: 'toggle', label: 'Optimise for web viewing', default: true, advanced: true },
    ],
    phase: 3,
    // Enabled once `test:golden` could assert it: the handler is shared with the heavy pool (its escalation
    // target), and the case checks the page count survives the rewrite. It was disabled while `merge` and this tool
    // were the two that escalated into a pool holding `NOT_IMPLEMENTED` stubs for them.
    enabled: true,
  },
  {
    id: 'remove-metadata',
    category: 'optimize',
    queue: 'light',
    title: 'Remove metadata',
    summary: 'Strip author, software, and document properties before sharing.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.RemoveMetadataOptions,
    limits: { timeoutSeconds: 90, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      {
        key: 'keep',
        control: 'text',
        label: 'Metadata to keep',
        hint: 'xmp, docinfo, attachments — comma-separated; empty removes all three',
      },
    ],
    phase: 4,
    enabled: true,
  },
  {
    id: 'linearize',
    category: 'optimize',
    queue: 'light',
    title: 'Linearize PDF',
    summary: 'Restructure a PDF so the first page opens before the rest downloads.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.LinearizeOptions,
    limits: { timeoutSeconds: 150, memoryMb: 1024, maxPages: 0 },
    optionsUi: [{ key: 'optimizeImages', control: 'toggle', label: 'Also optimise images', default: false }],
    phase: 4,
    enabled: true,
  },
  {
    id: 'encrypt',
    category: 'security',
    queue: 'light',
    title: 'Protect PDF',
    summary: 'Add a password and choose what readers may do with the document.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.EncryptOptions,
    // Declared, not inferred from the `password` controls below: what this list means is "never written down", and
    // a control that merely *looks* like a password field would then be a security decision made by the UI. The
    // registry test asserts the two agree, so the declaration still cannot drift from the form.
    secrets: ['userPassword', 'ownerPassword'],
    // The two passwords this tool *chooses*, and so the two the strength policy judges (`password-strength.ts`). The
    // owner password is judged only when the caller supplies one: a value this service generated is 24 base64url
    // characters, which cannot fail a policy about length and classes.
    setsPasswords: ['userPassword', 'ownerPassword'],
    limits: { timeoutSeconds: 120, memoryMb: 512, maxPages: 0 },
    optionsUi: [
      {
        key: 'userPassword',
        control: 'password',
        label: 'Password to open',
        hint: 'Required by anyone opening the file.',
      },
      {
        key: 'ownerPassword',
        control: 'password',
        label: 'Owner password',
        hint: 'Needed later to change permissions. Generated for you if left empty.',
        advanced: true,
      },
      {
        key: 'encryption',
        control: 'select',
        label: 'Encryption',
        default: 'aes-256',
        choices: [
          { value: 'aes-256', label: 'AES-256 (recommended)' },
          { value: 'aes-128', label: 'AES-128 (older readers)' },
          { value: 'rc4-128', label: 'RC4-128 (legacy readers — broken cipher)' },
        ],
        hint: 'RC4 is cryptographically broken and is offered only for readers that cannot do better. It is also the only revision where denying accessibility extraction is honoured rather than ignored.',
        advanced: true,
      },
      {
        key: 'permissions',
        // `json`, not `text`, and the difference is the whole option: `PermissionFlags` is an **object**, so the
        // free-text control rendered it as an empty box and submitted whatever was typed as a string — one more
        // instance of the failure `range-groups` was added for (`./types.ts`), for a shape nobody had checked:
        // `Expected object, received string` on a job the form itself had built. The two tools that share this option
        // now share its control as well, which is what the registry test asserts rather than hopes.
        control: 'json',
        label: 'Permissions',
        hint: 'JSON flags: print, printHighRes, copy, modify, annotate, fillForms, assemble, accessibility.',
        advanced: true,
      },
      {
        key: 'requireStrongPasswords',
        control: 'toggle',
        label: 'Require a strong password',
        hint: 'On by default for Business, and always enforced when you turn it on: at least 8 characters using 3 of lowercase, uppercase, digits and symbols. Weak passwords are accepted on plans without it, and the job says so.',
        advanced: true,
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'restrict',
    category: 'security',
    queue: 'light',
    title: 'Restrict permissions',
    summary: 'Leave the PDF openable but block printing, copying, or editing.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.RestrictOptions,
    // Same declaration as `encrypt`, and it has to be repeated here rather than shared: these are two different
    // option objects, and a shared constant is one careless edit away from declaring a key a tool does not have.
    secrets: ['ownerPassword'],
    // One password this tool chooses, and so one the strength policy judges. `restrict` sets an *empty* user
    // password on purpose (the file must open freely — that is the tool's whole promise), so there is nothing to judge
    // there and no key to list.
    setsPasswords: ['ownerPassword'],
    limits: { timeoutSeconds: 120, memoryMb: 512, maxPages: 0 },
    optionsUi: [
      {
        key: 'ownerPassword',
        control: 'password',
        label: 'Owner password',
        hint: 'At least 6 characters. Needed to change these limits later.',
      },
      {
        key: 'encryption',
        control: 'select',
        label: 'Encryption',
        default: 'aes-256',
        choices: [
          { value: 'aes-256', label: 'AES-256 (recommended)' },
          { value: 'aes-128', label: 'AES-128 (older readers)' },
          { value: 'rc4-128', label: 'RC4-128 (legacy readers — broken cipher)' },
        ],
        hint: 'RC4 is cryptographically broken and is offered only for readers that cannot do better. It is also the only revision where denying accessibility extraction is honoured rather than ignored.',
      },
      {
        key: 'permissions',
        control: 'json',
        label: 'Permissions',
        hint: 'JSON flags: print, printHighRes, copy, modify, annotate, fillForms, assemble, accessibility.',
        advanced: true,
      },
      {
        key: 'requireStrongPasswords',
        control: 'toggle',
        label: 'Require a strong password',
        hint: 'On by default for Business, and always enforced when you turn it on. Without it a short owner password is still accepted, and the job says so.',
        advanced: true,
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'unlock',
    category: 'security',
    queue: 'light',
    title: 'Unlock PDF',
    summary: 'Remove a password you already know so the document opens freely.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.UnlockOptions,
    secrets: ['password'],
    limits: { timeoutSeconds: 90, memoryMb: 512, maxPages: 0 },
    // Six a minute for one identity, against the 60 every request pays: this is the one tool in the catalogue that
    // takes a guess at somebody else's password, so it is the one place where the limit is about *what the caller is
    // doing* rather than about load. Six still leaves a batch — five documents and a retry — and a bucket refilled
    // continuously, so a caller who waits is not made to wait for a window edge. `docs/16-ACCOUNTS-QUOTA-AND-HISTORY.md`
    // §3 carries the number next to the plan quotas it sits beside.
    rateLimit: { perMinute: 6 },
    optionsUi: [{ key: 'password', control: 'password', label: 'Current password' }],
    phase: 5,
    enabled: true,
  },
  {
    id: 'watermark',
    category: 'edit',
    queue: 'light',
    title: 'Watermark',
    summary: 'Stamp text or an image across the pages, tiled or placed where you want.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.WatermarkOptions,
    limits: { timeoutSeconds: 150, memoryMb: 1024, maxPages: 0 },
    // The image kind names an existing upload by id, so the API has to pull that upload into the job as well —
    // without this the handler receives a PDF and an id it has no way to open.
    auxiliaryFiles: [{ option: 'imageFileId', label: 'Watermark image', accepts: ['image/png', 'image/jpeg'] }],
    optionsUi: [
      {
        key: 'kind',
        control: 'select',
        label: 'Watermark type',
        default: 'text',
        choices: [
          { value: 'text', label: 'Text' },
          { value: 'image', label: 'Image' },
        ],
      },
      {
        key: 'text',
        control: 'text',
        label: 'Watermark text',
        default: 'CONFIDENTIAL',
        visibleWhen: { kind: ['text'] },
      },
      { key: 'opacity', control: 'number', label: 'Opacity', default: 0.25, min: 0.02, max: 1, step: 0.01 },
      { key: 'fontSize', control: 'number', label: 'Size', default: 48, min: 6, max: 200, unit: 'pt' },
      { key: 'rotation', control: 'number', label: 'Rotation', default: -45, min: -90, max: 90, unit: '°' },
      {
        key: 'position',
        control: 'select',
        label: 'Placement',
        default: 'center',
        choices: [
          { value: 'center', label: 'Centre' },
          { value: 'top-left', label: 'Top left' },
          { value: 'top-right', label: 'Top right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'tile', label: 'Tiled across the page' },
        ],
      },
      {
        key: 'imageFileId',
        control: 'upload',
        label: 'Watermark image',
        hint: 'PNG or JPEG. Transparency is kept.',
        visibleWhen: { kind: ['image'] },
      },
      {
        key: 'scalePercent',
        control: 'number',
        label: 'Image width',
        default: 100,
        min: 10,
        max: 100,
        unit: '% of page width',
        visibleWhen: { kind: ['image'] },
      },
      {
        key: 'font',
        control: 'text',
        label: 'Font',
        default: 'Helvetica',
        visibleWhen: { kind: ['text'] },
        advanced: true,
      },
      { key: 'color', control: 'text', label: 'Colour', default: '#9aa0a6', advanced: true },
      {
        key: 'tile',
        control: 'json',
        label: 'Tile spacing',
        hint: 'JSON { x, y } gaps for tiled placement.',
        visibleWhen: { position: ['tile'] },
        advanced: true,
      },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
      { key: 'skipFirstPage', control: 'toggle', label: 'Leave the first page unmarked', default: false },
      { key: 'underContent', control: 'toggle', label: 'Draw behind the content', default: false, advanced: true },
    ],
    phase: 3,
    enabled: true,
  },
  {
    id: 'page-numbers',
    category: 'edit',
    queue: 'light',
    title: 'Page numbers',
    summary: 'Add page numbering with the format and position you prefer.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.PageNumberOptions,
    limits: { timeoutSeconds: 150, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      {
        key: 'position',
        control: 'select',
        label: 'Position',
        default: 'bottom-center',
        choices: [
          { value: 'bottom-center', label: 'Bottom centre' },
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'top-center', label: 'Top centre' },
          { value: 'top-right', label: 'Top right' },
          { value: 'top-left', label: 'Top left' },
        ],
      },
      {
        key: 'format',
        control: 'select',
        label: 'Format',
        default: 'n-of-total',
        choices: [
          { value: 'n', label: '1' },
          { value: 'n-of-total', label: '1 of 20' },
          { value: 'page-n', label: 'Page 1' },
          { value: 'page-n-of-total', label: 'Page 1 of 20' },
        ],
      },
      { key: 'startAt', control: 'number', label: 'Start at', default: 1, min: 1, max: 100000 },
      {
        key: 'countFrom',
        control: 'number',
        label: 'Number the document from page',
        min: 1,
        max: 100000,
        hint: 'Leave empty to number from page 1. Set it to 3 and the third page of the document is “1” — covers and tables of contents stay unnumbered.',
        advanced: true,
      },
      {
        key: 'color',
        control: 'text',
        label: 'Colour',
        default: '#333333',
        hint: 'Hex, e.g. #333333. Grey by default, so the stamp reads as an annotation rather than as part of the page.',
        advanced: true,
      },
      { key: 'skipFirstPage', control: 'toggle', label: 'Leave the first page unnumbered', default: false },
      {
        key: 'bates',
        control: 'json',
        label: 'Bates numbering',
        hint: 'Replaces the format above: { "prefix": "INV", "digits": 6, "startAt": 142 } prints INV000142. For legal discovery.',
        advanced: true,
      },
      { key: 'font', control: 'text', label: 'Font', default: 'Helvetica', advanced: true },
      {
        key: 'fontSize',
        control: 'number',
        label: 'Font size',
        default: 10,
        min: 6,
        max: 36,
        unit: 'pt',
        advanced: true,
      },
      {
        key: 'marginMm',
        control: 'number',
        label: 'Distance from edge',
        default: 12,
        min: 2,
        max: 40,
        unit: 'mm',
        advanced: true,
      },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
    ],
    phase: 3,
    // Enabled with a handler and golden cases: the overlay pipeline it uses is shared with `header-footer` and
    // `watermark`, all three now exercised against the stack.
    enabled: true,
  },
  {
    id: 'header-footer',
    category: 'edit',
    queue: 'light',
    title: 'Header & footer',
    summary: 'Add running headers and footers with dates, titles, and page numbers.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.HeaderFooterOptions,
    limits: { timeoutSeconds: 150, memoryMb: 1024, maxPages: 0 },
    auxiliaryFiles: [{ option: 'logoFileId', label: 'Logo image', accepts: ['image/png', 'image/jpeg'] }],
    optionsUi: [
      {
        key: 'header',
        control: 'json',
        label: 'Header',
        hint: 'JSON { left, center, right, fontSize, color, rule }. Use {page}, {total}, {date}, {time}, {filename} in the text.',
      },
      { key: 'footer', control: 'json', label: 'Footer', hint: 'Same shape as the header.' },
      {
        key: 'differentFirstPage',
        control: 'json',
        label: 'First page bands',
        hint: 'JSON { header, footer } used on page 1 instead of the bands above — a cover sheet gets its own header, or none. A band you leave out is a band page 1 does not carry.',
        advanced: true,
      },
      { key: 'skipFirstPage', control: 'toggle', label: 'Skip the first page', default: false },
      { key: 'marginMm', control: 'number', label: 'Distance from the edge', default: 12, min: 5, max: 40, unit: 'mm' },
      {
        key: 'logoFileId',
        control: 'upload',
        label: 'Logo',
        hint: 'PNG or JPEG, placed in the header. Transparency is kept.',
      },
      {
        key: 'logoPosition',
        control: 'select',
        label: 'Logo side',
        default: 'left',
        choices: [
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ],
        visibleWhen: { logoFileId: ['*'] },
      },
      {
        key: 'logoHeightMm',
        control: 'number',
        label: 'Logo height',
        default: 8,
        min: 4,
        max: 40,
        unit: 'mm',
        visibleWhen: { logoFileId: ['*'] },
      },
      {
        key: 'logoOpacity',
        control: 'number',
        label: 'Logo opacity',
        default: 1,
        min: 0.02,
        max: 1,
        step: 0.01,
        hint: '1 is solid. Lower values fade the logo only — the header text stays at full strength.',
        visibleWhen: { logoFileId: ['*'] },
      },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'edit-pdf',
    category: 'edit',
    queue: 'light',
    title: 'Edit PDF',
    summary: 'Place text, images, shapes, checkboxes, or freehand marks on the page.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.EditPdfOptions,
    // Image elements name their file *inside* the array rather than at the top level, which is the one declaration
    // shape that does not fit `auxiliaryFiles`' flat `option` key (`docs/13-EDIT-AND-ANNOTATE.md` §2). The `[]` in the
    // option is how the API's resolver is told to walk `elements` and collect each element's file id — see
    // `ToolAuxiliaryFile` and `loadAuxiliaryFiles`.
    auxiliaryFiles: [
      { option: 'elements[].fileId', label: 'Image element files', accepts: ['image/png', 'image/jpeg'] },
    ],
    limits: { timeoutSeconds: 240, memoryMb: 1536, maxPages: 0 },
    optionsUi: [
      {
        key: 'elements',
        control: 'placement',
        label: 'Elements',
        hint: 'Click the page to place an element, drag it to move it, drag its corner to resize it. Positions are in PDF points from the page’s bottom-left corner (x right, y up) — the canvas does the flip, and every number stays editable for exact placement.',
        // The page image is a `pdf-to-images` job over the same file the caller is about to edit: the API cannot render
        // (`0-FOLDER-STRUCTURE.md` §2), and a second rendering path inside the web app is the divergence this project
        // keeps refusing to add. The kinds are the five shapes `EditElement` accepts.
        placement: {
          shape: 'edit-elements',
          renderTool: 'pdf-to-images',
          dpi: 96,
          kinds: ['text', 'shape', 'checkbox', 'image', 'draw'],
        },
      },
      {
        key: 'flatten',
        control: 'toggle',
        label: 'Flatten into the page',
        default: true,
        hint: 'The marks are drawn into the page content, so they are permanent. Turning this off is reported as a warning: there is no separate editable layer, and `annotate` is the tool for marks a reader can move.',
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'annotate',
    category: 'edit',
    queue: 'light',
    title: 'Highlight & annotate',
    summary: 'Highlight, underline, strike through, or leave notes on the document.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.AnnotateOptions,
    limits: { timeoutSeconds: 180, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      {
        key: 'annotations',
        control: 'placement',
        label: 'Annotations',
        hint: 'Drag a box over the text to mark it, or click to drop a note. Markup carries its own rectangles in the mark; positions are in PDF points from the page’s bottom-left corner (x right, y up) — the canvas does the flip, and every rectangle stays editable in the list.',
        // The same canvas as `edit-pdf` with a different entry shape: `annotations` groups boxes in `rects` and a note
        // is a single point. `note` is placed by a click because a `/Text` annotation's geometry is one 20 pt icon
        // box anchored at its lower-left — the text lives in `/Contents`, not in the rectangle.
        placement: {
          shape: 'annotations',
          renderTool: 'pdf-to-images',
          dpi: 96,
          kinds: ['highlight', 'underline', 'strike', 'note'],
        },
      },
      {
        key: 'flatten',
        control: 'toggle',
        label: 'Flatten into the page',
        default: false,
        advanced: true,
        hint: 'The marks become part of the page instead of annotations: they cannot be selected, moved or deleted, and a note becomes its icon. Leave this off for highlights a reviewer can work with.',
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'redact',
    category: 'edit',
    queue: 'heavy',
    title: 'Redact',
    summary: 'Permanently remove content under the areas you mark, and verify it is gone.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.RedactOptions,
    limits: { timeoutSeconds: 300, memoryMb: 2048, maxPages: 0 },
    optionsUi: [
      {
        // The placement canvas (`13-EDIT-AND-ANNOTATE.md` §5), on the tool where a box in the wrong place is not a
        // misplaced decoration but a value the document still leaks: `redact`'s rectangles were JSON until the
        // eighty-second pass, and a payload that reads correctly while the box misses its target is exactly the
        // failure this control exists to remove.
        key: 'regions',
        control: 'placement',
        label: 'Regions',
        hint: 'Draw a box over what has to go; drag it to move it, drag its corner to resize it. Positions are in PDF points from the page’s bottom-left corner (x right, y up) — the canvas does the flip, and every rectangle stays editable in the list. Up to 20 rectangles a page and 200 in the job.',
        placement: {
          shape: 'redactions',
          renderTool: 'pdf-to-images',
          dpi: 96,
          kinds: ['box'],
        },
      },
      { key: 'fill', control: 'text', label: 'Fill colour', default: '#000000' },
      {
        key: 'removeContent',
        control: 'toggle',
        label: 'Remove the content underneath',
        default: true,
        hint: 'Off paints the boxes without removing anything: the text stays extractable and the job says so.',
      },
      {
        key: 'removeMetadata',
        control: 'toggle',
        label: 'Remove the document metadata',
        default: true,
        hint: 'The title, author and XMP fields often name what is being redacted.',
      },
      {
        key: 'removeAttachments',
        control: 'toggle',
        label: 'Remove embedded attachments',
        default: true,
      },
      {
        key: 'scrubAnnotations',
        control: 'toggle',
        label: 'Delete annotations inside the marked areas',
        default: true,
        hint: 'A sticky note over a redacted value still shows it; the job counts what it deleted.',
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'sign',
    category: 'document',
    queue: 'heavy',
    title: 'Sign PDF',
    // The tool page renders this as its description, and it is where the honesty requirement lands in the UI: a user
    // who believes they have a cryptographically signed contract has been misled, and the API's
    // `NOT_A_DIGITAL_SIGNATURE` warning — which every successful job carries — arrives too late to prevent that.
    summary:
      'Draw, type, or upload a signature and place it on the document. This is a visible signature with the signer, reason and time recorded in the document metadata — not a digital certificate.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.SignOptions,
    limits: { timeoutSeconds: 240, memoryMb: 1536, maxPages: 0 },
    // A drawn signature is a browser canvas exported to PNG, and an uploaded one is the same kind of file, so both
    // image kinds name an existing upload that the API has to pull into the job as an attachment.
    auxiliaryFiles: [{ option: 'imageFileId', label: 'Signature image', accepts: ['image/png', 'image/jpeg'] }],
    optionsUi: [
      {
        key: 'kind',
        control: 'select',
        label: 'Signature type',
        default: 'typed',
        choices: [
          { value: 'typed', label: 'Typed' },
          { value: 'drawn', label: 'Drawn (canvas export)' },
          { value: 'image', label: 'Uploaded image' },
        ],
      },
      {
        key: 'signature',
        control: 'text',
        label: 'Name to sign',
        hint: 'Rendered in a handwriting-style face.',
        visibleWhen: { kind: ['typed'] },
      },
      {
        key: 'font',
        control: 'select',
        label: 'Signature face',
        default: 'script',
        choices: [
          { value: 'script', label: 'Script' },
          { value: 'serif', label: 'Serif' },
          { value: 'sans', label: 'Sans' },
        ],
        visibleWhen: { kind: ['typed'] },
      },
      {
        // The pad rather than a plain file input, because `kind: 'drawn'` had no way to be drawn: the option
        // described a browser canvas export and the only control that existed made the user produce one somewhere
        // else. Both paths stay in one control so the option is still a single file id — drawing uploads what the
        // pad exported, and the file input beside it is for someone who already has a PNG.
        key: 'imageFileId',
        control: 'signature-pad',
        label: 'Signature',
        hint: 'Draw it above, or upload a PNG — either way it is uploaded and pulled into the job as an attachment. Transparency is kept.',
        visibleWhen: { kind: ['drawn', 'image'] },
      },
      {
        // The placement canvas (`13-EDIT-AND-ANNOTATE.md` §5), on the tool whose coordinates were the reason it
        // exists: `sign`'s `fields` is the one option a user is most likely to get wrong in JSON, because a
        // signature belongs in a specific corner of a specific page and nothing about `{"x":40,"y":60}` says which.
        key: 'fields',
        control: 'placement',
        label: 'Where it goes',
        placement: {
          shape: 'signature',
          renderTool: 'pdf-to-images',
          dpi: 96,
          kinds: ['signature'],
        },
        hint: 'Drag on the page to place the signature, or type the numbers — the canvas writes the same `fields` array the JSON editor does.',
      },
      { key: 'signerName', control: 'text', label: 'Signer name', advanced: true },
      { key: 'signerEmail', control: 'text', label: 'Signer email', advanced: true },
      { key: 'reason', control: 'text', label: 'Reason', default: 'Signed with PDF Tools' },
      { key: 'location', control: 'text', label: 'Location', advanced: true },
      {
        key: 'date',
        control: 'text',
        label: 'Signing date',
        hint: 'ISO 8601. Defaults to now.',
        advanced: true,
      },
      { key: 'showDateStamp', control: 'toggle', label: 'Print the date', default: true },
      { key: 'showSignerName', control: 'toggle', label: 'Print the signer name', default: false },
      { key: 'borderColor', control: 'text', label: 'Border colour', hint: '#rrggbb', advanced: true },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'fill-form',
    category: 'document',
    queue: 'heavy',
    title: 'Fill forms',
    summary: 'Fill in form fields and optionally flatten them so they cannot be changed.',
    input: { ...PDF },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.FillFormOptions,
    limits: { timeoutSeconds: 240, memoryMb: 1536, maxPages: 0 },
    optionsUi: [
      {
        key: 'fields',
        control: 'json',
        label: 'Field values',
        hint: 'JSON map of field name to value, e.g. { "name": "Ada", "agree": true }.',
      },
      { key: 'flatten', control: 'toggle', label: 'Lock the fields after filling', default: true },
      {
        key: 'flattenMode',
        control: 'select',
        label: 'Which fields to lock',
        default: 'filled',
        choices: [
          { value: 'filled', label: 'Only the fields I filled' },
          { value: 'all', label: 'Every field, filled or empty' },
        ],
        visibleWhen: { flatten: [true] },
        advanced: true,
        hint: 'Every value is baked into the page either way, so nobody can change what was filled in. “Only the fields I filled” leaves the empty ones for the next person to complete; “Every field” removes them so the form is finished, and drops an empty field that cannot be drawn at all.',
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'extract-fields',
    category: 'document',
    queue: 'light',
    title: 'Extract form fields',
    summary: 'Read a form’s field names, types, and current values out as JSON or CSV.',
    input: { ...PDF },
    output: { kind: 'json', mime: 'application/json' },
    options: O.ExtractFieldsOptions,
    limits: { timeoutSeconds: 90, memoryMb: 1024, maxPages: 0 },
    optionsUi: [
      { key: 'includeValues', control: 'toggle', label: 'Include values', default: true },
      {
        key: 'format',
        control: 'select',
        label: 'Output format',
        default: 'json',
        choices: [
          { value: 'json', label: 'JSON' },
          { value: 'csv', label: 'CSV' },
        ],
      },
    ],
    phase: 5,
    enabled: true,
  },
  {
    id: 'ocr',
    category: 'ocr',
    queue: 'ocr',
    title: 'OCR',
    summary: 'Make a scan searchable, or pull its text out.',
    input: {
      // No HEIF, and that is a change rather than an omission: the pool has no decoder for it (img2pdf and Pillow as
      // the image ships them both refuse it), so a `.heic` upload used to be accepted here and then failed inside the
      // worker with a message about a file it could not read. `images-to-pdf` transcodes HEIC — it runs ImageMagick,
      // which this pool deliberately does not — so the refusal names that tool instead of accepting the file.
      accepts: ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'],
      extensions: ['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.tif'],
      minFiles: 1,
      maxFiles: 20,
      maxFileMb: 200,
    },
    output: { kind: 'pdf', mime: 'application/pdf' },
    options: O.OcrOptions,
    limits: { timeoutSeconds: 900, memoryMb: 3072, maxPages: 0 },
    optionsUi: [
      { key: 'languages', control: 'text', label: 'Languages', hint: 'e.g. eng, ind — up to three' },
      {
        key: 'preset',
        control: 'select',
        label: 'Speed vs accuracy',
        default: 'balanced',
        choices: [
          { value: 'fast', label: 'Fast' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'accurate', label: 'Accurate (slowest)' },
        ],
      },
      {
        key: 'outputMode',
        control: 'select',
        label: 'Output',
        default: 'searchable-pdf',
        choices: [
          { value: 'searchable-pdf', label: 'Searchable PDF' },
          { value: 'text-only', label: 'Text file only' },
          { value: 'pdf-and-text', label: 'PDF plus a text file' },
        ],
      },
      { key: 'deskew', control: 'toggle', label: 'Straighten skewed scans', default: true },
      { key: 'pages', control: 'pages', label: 'Pages', advanced: true },
      {
        key: 'sidecar',
        control: 'toggle',
        label: 'Also give me the text as a file',
        default: false,
        hint: 'Adds a .txt sidecar next to the searchable PDF.',
        advanced: true,
      },
      {
        key: 'dpi',
        control: 'number',
        label: 'Recognition resolution',
        min: 200,
        max: 600,
        unit: 'dpi',
        hint: 'Leave empty to use the scan’s own resolution. An image that carries none needs this.',
        advanced: true,
      },
      {
        key: 'clean',
        control: 'toggle',
        label: 'Clean up scan artifacts',
        default: false,
        hint: 'Despeckles before recognition — helps faxes, costs time on clean scans.',
        advanced: true,
      },
    ],
    phase: 6,
    enabled: true,
  },
];

export const TOOLS_BY_ID: ReadonlyMap<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.id, t]));

export function getTool(id: string): ToolDefinition | undefined {
  return TOOLS_BY_ID.get(id);
}

export function requireTool(id: string): ToolDefinition {
  const def = TOOLS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown tool: ${id}`);
  return def;
}

export function toolsByCategory(): Record<string, ToolDefinition[]> {
  const out: Record<string, ToolDefinition[]> = {};
  for (const tool of TOOLS) {
    const list = out[tool.category];
    if (list) list.push(tool);
    else out[tool.category] = [tool];
  }
  return out;
}

/** MIME type accepted by a tool, matched on the detected (not declared) type. */
export function acceptsType(def: ToolDefinition, detectedType: string): boolean {
  return def.input.accepts.includes(detectedType);
}
