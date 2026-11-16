import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPdf, countPagesInPdf } from './pdf-writer';
import { buildPng } from './png-writer';
import { buildZip, readZipDirectory } from './zip-writer';

/**
 * Generates the fixtures the golden suites and the E2E test use (`docs/0-TESTING.md` §4).
 *
 * Naming follows the documented convention (`<tool>-<variant>.<ext>`), and the script prints what it wrote with
 * the page count it verified by re-reading the bytes — so a broken writer is caught here rather than inside a
 * failing conversion three steps later.
 *
 *   bun run fixtures
 */
const OUT_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'generated');

interface Fixture {
  name: string;
  spec: Parameters<typeof buildPdf>[0];
  /**
   * A last step that makes the file invalid on purpose, for the fixtures about *refusals*.
   *
   * Kept out of `PdfSpec` deliberately: this writer produces valid documents, and an option to produce a broken one
   * would put that claim in the same place as the claim that its normal output is correct.
   */
  damage?: (bytes: Uint8Array) => Uint8Array;
  /**
   * A property of the written bytes that the fixture's own case depends on, checked here so a fixture that stopped
   * being shaped the way its case assumes fails at the generator rather than inside a conversion.
   *
   * Returns the problem, or `null` when the file is what the case needs. `countPagesInPdf` has already been read by
   * the time this runs, so a fixture can assert about its shape *and* its page count without counting twice.
   */
  check?: (bytes: Uint8Array) => string | null;
}

const FIXTURES: Fixture[] = [
  { name: 'merge-two-a4.pdf', spec: { pages: 2, label: 'Merge fixture A' } },
  { name: 'merge-three-a4.pdf', spec: { pages: 3, label: 'Merge fixture B' } },
  {
    // The merge fixture that *has* an outline, and metadata, and mixed page sizes are covered by pairing it with
    // `rotate-landscape-a4.pdf`. Three top-level entries across two levels: enough to tell "kept" from "flattened"
    // from "dropped" without a fixture whose shape exists only to be counted.
    name: 'bookmark-toc.pdf',
    spec: {
      pages: 3,
      label: 'Bookmark fixture A',
      outline: [
        { title: 'Chapter 1', page: 1, children: [{ title: 'Section 1.1', page: 2 }] },
        { title: 'Chapter 2', page: 3 },
      ],
      docInfo: { title: 'Bookmark fixture A title', author: 'Fixture author' },
      xmp: { creator: 'fixture-xmp-creator' },
    },
  },
  {
    // The second half of the merge outline pair: one top-level entry with no children, so "one parent per input" is
    // distinguishable from "one entry per input".
    name: 'bookmark-annex-a4.pdf',
    spec: {
      pages: 2,
      label: 'Bookmark fixture B',
      outline: [{ title: 'Annex A', page: 1, children: [{ title: 'Annex A note', page: 2 }] }],
    },
  },
  {
    // A PDF whose trailer and cross-reference table are gone: `%PDF` magic bytes so it is typed as a PDF, and no way
    // for a reader to open it. It exists for the one merge claim that is about what a *failure* says — the message must
    // name the position of the offending file rather than the staging path it happens to live at.
    name: 'merge-damaged.pdf',
    spec: { pages: 2, label: 'Merge damaged fixture' },
    // Cut before the cross-reference table, so the document has pages and no way to find them. Deliberately not
    // `buildPdf`'s own option: a writer that can emit an invalid file is a writer whose normal output is suspect.
    damage: (bytes) => bytes.slice(0, Math.floor(bytes.length * 0.6)),
  },
  { name: 'split-twelve-a4.pdf', spec: { pages: 12, label: 'Split fixture' } },
  {
    // Pages of very different weight, for `split --mode by-size`: two 60 kB pages and three 30 kB ones. A document of
    // twelve identical pages packs into one part at any target that is not smaller than a page, so the packing loop
    // would look correct while never having made a decision — this fixture is the one where 0.1 MB forces three parts
    // ([1], [2,3], [4,5]) and a greedy packer that could split a page would produce something else.
    name: 'split-weighted-a4.pdf',
    spec: { pages: 5, label: 'Split weight fixture', padBytesPerPage: [60000, 60000, 30000, 30000, 30000] },
  },
  {
    // Enough pages to cross the engine bridge's default result budget: one decoration result per part, each about
    // 110 bytes, so a 60-part job prints ~6.5 kB where the wrapper's default stdout capture is 4 kB. Nothing about a
    // 12-part split crosses it, which is why the defect this fixture pins down (126) was invisible until a 125-part
    // job reported a warning per part.
    name: 'split-sixty-a4.pdf',
    spec: { pages: 60, label: 'Split part-count fixture' },
  },
  {
    // The same shape, with an outline that spans the boundary of the packed parts: `by-bookmarks` needs a document
    // whose entries are not one per page, and the *decoration* of a part needs entries whose parent lives in another
    // part (the case that proved an off-by-one in the page map — a part carried the next page's bookmark).
    name: 'split-bookmarked-a4.pdf',
    spec: {
      pages: 6,
      label: 'Split bookmarked fixture',
      padBytesPerPage: [40000, 40000, 40000, 40000, 40000, 40000],
      outline: [
        { title: 'Part 1', page: 1, children: [{ title: 'Part 1.1', page: 2 }] },
        { title: 'Part 2', page: 4, children: [{ title: 'Part 2.1', page: 5 }] },
      ],
    },
  },
  { name: 'compress-text-a4.pdf', spec: { pages: 4, label: 'Compress fixture' } },
  {
    // The fixture `compress`'s **escalation** needs, and the reason it is a *page* count rather than a byte count:
    // the catalog routes the job to `heavy` above 300 pages **or** 100 MB, and a 100 MB file would make every run of
    // this suite pay for one threshold — 320 pages of text is a few hundred kilobytes and crosses the other one.
    //
    // 320 rather than 301 so the number in the case reads as "well past the threshold" instead of "exactly one over",
    // and it is verified here rather than assumed: the writer re-reads what it wrote (`countPagesInPdf`) before
    // copying it out, and `packages/contracts/test/registry.test.ts` holds the catalog's own thresholds to the values
    // `04-COMPRESS.md` §6 states, including the strict boundary — 300 pages is *not* escalated, 301 is.
    name: 'compress-large-320p.pdf',
    spec: { pages: 320, label: 'Escalation fixture page' },
  },
  {
    // The fixture the **worker's** re-check needs: 620 pages whose page tree the API's byte scan cannot find.
    //
    // `apps/api/src/shared/pdf-probe.ts` reads two windows of a file — its first 4 KB and its last 512 KB — and falls
    // back to counting `/Type /Page` occurrences when no `/Count` is inside them. 620 pages put the `/Count` past the
    // first window (the root `/Kids` array alone is ~4 KB), and 600 KB of trailing padding — the unreferenced stream
    // object `padFileBytes` writes *after* every object in the graph — puts every page object before the last one.
    // The scan therefore answers `null`, the API routes on "page count unknown" and files the job on the light pool,
    // and only a worker that reads the file itself can put it where its 620 pages say it belongs (defect 153).
    //
    // 620 rather than 320 for a second reason: Free allows 500 pages, so the same document is also one the API
    // accepts *above its plan's page limit* while the count is unknown — measured, and written up in
    // `04-COMPRESS.md` §6, because it is a limit that is skipped rather than raised.
    name: 'compress-hidden-pages-620p.pdf',
    spec: { pages: 620, label: 'Hidden page tree fixture', padFileBytes: 600 * 1024 },
    check: (bytes) => {
      // The two windows are the claim: the scan must see **no** page marker in either of them. Asserted by offset
      // rather than by re-running the scan's regex here, because a second copy of that rule is how the two drift —
      // the case itself asserts the answer it gives (`metrics.claimedInputPages` is 0 for this file).
      const text = Buffer.from(bytes).toString('latin1');
      const head = 4096;
      const tailStartsAt = bytes.length - 512 * 1024;
      const countAt = text.indexOf('/Count');
      const firstPage = text.indexOf('/Type /Page ');
      const lastPage = text.lastIndexOf('/Type /Page ');
      if (countAt < 0 || firstPage < 0 || lastPage < 0) {
        return 'the page tree is not where this fixture expects it (no /Count or no page object found)';
      }
      // Checked first, because for a file this size the two window tests would "pass" against a window the scan cannot
      // actually take: a 500 KB file has one window, not two, and every byte of it is visible to the scan.
      if (tailStartsAt <= head) {
        return `the file is ${bytes.length} bytes, small enough that the scan's two windows meet — every byte of it is readable`;
      }
      if (countAt < head || firstPage < head) {
        return `a page marker is inside the scan's first window (offset ${Math.min(countAt, firstPage)} < ${head})`;
      }
      if (countAt >= tailStartsAt || lastPage >= tailStartsAt) {
        return `a page marker is inside the scan's last window (offset ${Math.max(countAt, lastPage)} >= ${tailStartsAt})`;
      }
      return null;
    },
  },
  {
    //
    // The fixture `redact`'s **byte** verification exists for, and the one shape no other fixture can produce: the value
    // the box is aimed at is drawn on the page, and a second copy of it sits in a stream **nothing reads**, carried as a
    // `<hex>` string. No text layer, no reader and no page content references it, so a rewrite has no reason to remove
    // it and every extraction-based check agrees the value is gone — the case is about the one reading that can see it.
    //
    // Two spellings of the same token, on purpose: `(LEAK9X7)` on the page (which PyMuPDF reads, so it becomes a token
    // the job is allowed to assert the absence of) and `<4C45414B395837>` in the carrier (which only a hex-decoding byte
    // search reads). A job that removes the page copy and leaves the carrier has not removed what the user marked.
    //
    name: 'redact-carrier-hex.pdf',
    spec: {
      pages: 1,
      label: 'Redact carrier fixture',
      texts: [{ text: 'LEAK9X7', x: 72, y: 660, size: 24 }],
      carrier: 'BT /F1 12 Tf 72 300 Td <4C45414B395837> Tj ET',
    },
    check: (bytes) => {
      const text = Buffer.from(bytes).toString('latin1');
      if (!text.includes('<4C45414B395837>')) {
        return 'the carrier stream is not in the bytes, so the leak its case is about does not exist';
      }
      // Exactly **one** literal copy, drawn on the page: the carrier is the same token in the other spelling, and a
      // fixture that spelled it as a literal twice would be a different document from the one the case describes.
      return text.split('(LEAK9X7)').length === 2
        ? null
        : 'the token is not in the bytes exactly once as a literal, drawn on the page';
    },
  },
  { name: 'pages-six-a4.pdf', spec: { pages: 6, label: 'Page operations fixture' } },
  {
    //
    // The document the `redact` browser case aims its box at, and the reason it is a fixture rather than a file someone
    // picked: a redaction that misses its target produces a valid PDF and reports success, so the case cannot decide
    // *where to draw* from anything it can see — the text has to be placed at coordinates the case already knows. The
    // layout is the placement stage's own (`scripts/ci/placement.ts` writes the same two tokens at the same two
    // baselines), which makes the two stages two readings of one document: the stage posts the rectangle, the case
    // drags it, and both read the same words back out of the output.
    //
    // The third run exists for the *reader* rather than for the box, and it is the only one here with a character that
    // has to be escaped: `PAREN(9X7)` is written `(PAREN\(9X7\))`, and a redaction leaves such a run exactly as it
    // found it — so the case can assert text that is unambiguously still in the file and that a byte-shaped search
    // reports as gone (measured: the text is in neither the input's nor the output's bytes).
    name: 'redact-tokens-a4.pdf',
    spec: {
      pages: 1,
      label: 'redact fixture',
      texts: [
        { text: 'REDACT9X7', x: 72, y: 660, size: 24 },
        { text: 'KEEP9X7', x: 72, y: 560, size: 24 },
        { text: 'PAREN(9X7)', x: 72, y: 460, size: 24 },
      ],
    },
    check: (bytes) => {
      const text = Buffer.from(bytes).toString('latin1');
      if (!text.includes('REDACT9X7') || !text.includes('KEEP9X7')) {
        return 'the tokens the browser case aims at are not in the bytes it will upload';
      }
      // Checked in its **escaped** form, and that is the whole point of the fixture: the case's reader claim is about
      // the spelling, so a file that carried the token raw would be a broken PDF that happened to satisfy a search.
      return text.includes('PAREN\\(9X7\\)')
        ? null
        : 'the parenthesis token is not escaped in the bytes, so the reader claim has nothing to read';
    },
  },
  {
    // A document that **arrives numbered**: four pages carrying "Page 1 of 40" in the bottom-centre band, drawn as an
    // ordinary text run rather than as a footer by a library, which is exactly what a scanned-and-reprinted contract
    // looks like. `page-numbers` draws over it, so the tool promises a warning — and the only way to prove the probe
    // reads the band rather than the document is a twin with no such text (`pages-six-a4.pdf`, whose body *does* say
    // "page 1 of 6" but at the top of the page, well outside the band a bottom stamp occupies).
    name: 'numbered-invoices-a4.pdf',
    spec: {
      pages: 4,
      label: 'Pre-numbered invoice fixture',
      texts: [{ x: 262, y: 30, size: 10, text: 'Page 1 of 40' }],
    },
    check: (bytes) => {
      const text = Buffer.from(bytes).toString('latin1');
      return text.includes('Page 1 of 40')
        ? null
        : 'the printed page number this fixture exists for is not in the bytes';
    },
  },
  {
    // Cover + table of contents + ten body pages, for `countFrom` (`12-…` §4): the third page is the first body page, so
    // "the third PDF page displays 1" and "{total} is 10" are both facts about this document rather than about a
    // twelve-page one that happens to exist.
    name: 'cover-toc-body-a4.pdf',
    spec: { pages: 12, label: 'Cover and body fixture' },
  },
  { name: 'rotate-landscape-a4.pdf', spec: { pages: 2, label: 'Rotate fixture', pageSize: [842, 595] } },
  {
    // Four portrait pages that *display* rotated 90°, for `n-up`: composing pages has to bake the rotation into the
    // placement, and a handler that ignores `/Rotate` produces a handout with the page count and the text both right.
    name: 'nup-rotated-a4.pdf',
    spec: { pages: 4, label: 'Rotated layout fixture', rotate: 90 },
  },
  {
    // The ruled flavour of `pdf-to-csv`. The price column is European (`1.234,56`) on purpose: that is the value the
    // `decimalComma` case asserts is parsed to `1234.56`, and a fixture with plain `1234.56` values could not tell a
    // working parser from one that copied the cell through.
    name: 'tables-ruled-a4.pdf',
    spec: {
      pages: 1,
      label: 'Ruled table fixture',
      table: {
        rows: [
          ['Item', 'Qty', 'Price'],
          ['Widget', '10', '1.234,56'],
          ['Gadget', '4', '99,00'],
        ],
      },
    },
  },
  {
    // The same cells with the rules off: nothing but whitespace separates the columns, which is the only way to prove
    // the `stream` path reads alignment rather than lines.
    name: 'tables-stream-a4.pdf',
    spec: {
      pages: 1,
      label: 'Whitespace table fixture',
      table: {
        rows: [
          ['Item', 'Qty', 'Price'],
          ['Widget', '10', '1.234,56'],
          ['Gadget', '4', '99,00'],
        ],
        ruled: false,
      },
    },
  },
  {
    // Two tables that are **not** the same table, on two of four pages, because three options in `08-…` had no fixture
    // that could tell their branches apart:
    //
    //   * `oneSheetPerPage: true` writes one worksheet per page; the default writes one per *table*. On a one-page
    //     single-table document the two branches are the same workbook — measured, byte-identical — so this fixture is
    //     the smallest arrangement where the flag changes the answer (two sheets versus two pages of a four-page file);
    //   * `allTables: false` keeps the **largest** table in the document. With one table in the document the flag is a
    //     no-op, so a case could not tell "kept the largest" from "kept the first" or from "ignored the flag";
    //   * `PAGES_WITHOUT_TABLES` names the pages that had none, which is a statement about pages 2 and 4 only because
    //     tables live on 1 and 3.
    //
    // The two tables differ in size as well as content: the first has five rows, the second three, which is the gap
    // the largest-only rule has to choose across.
    name: 'tables-mixed-a4.pdf',
    spec: {
      pages: 4,
      label: 'Mixed tables fixture',
      tables: [
        {
          pages: [1],
          rows: [
            ['Round', 'Team', 'Score'],
            ['Round 1', 'Alpha', '11'],
            ['Round 1', 'Beta', '12'],
            ['Round 2', 'Alpha', '21'],
            ['Round 2', 'Beta', '22'],
          ],
        },
        {
          pages: [3],
          rows: [
            ['Check', 'Owner', 'Result'],
            ['Sign-off', 'Gamma', 'pass'],
            ['Archive', 'Delta', 'pending'],
          ],
        },
      ],
    },
  },
  { name: 'pdf-to-images-two.pdf', spec: { pages: 2, label: 'Render fixture' } },
  {
    // The one fixture with **embedded raster images**, and both resolutions in one document on purpose.
    //
    // `pdf-to-pdfa` normalises images above 300 dpi and reports how many it touched; a document whose images are all
    // high-resolution cannot tell "reduced the ones above the threshold" from "reduced everything", and one with no
    // image at all cannot tell "nothing was above it" from "nothing was measured". Two images in one file, one at
    // 720 dpi and one at 100, make both mutations of that rule detectable from a single case — and the second image is
    // the *control*: it must survive the pass untouched, which is what `imagesDownsampled: 1` alone says.
    //
    // The resolutions are computed from the boxes rather than stated: `imagePpi` is the same arithmetic `pdfimages`
    // performs, and the `check` below fails the generator if the file it wrote is not the file the case assumes.
    name: 'pdf-to-pdfa-images-a4.pdf',
    spec: {
      pages: 1,
      label: 'Image resolution fixture',
      images: [
        { name: 'ImHigh', width: 1200, height: 1200, tint: [40, 90, 160], box: [72, 460, 120, 120] },
        { name: 'ImLow', width: 200, height: 200, tint: [200, 120, 40], box: [240, 460, 144, 144] },
      ],
    },
    check: (bytes) => {
      const text = Buffer.from(bytes).toString('latin1');
      // Both images present by their own object shape, and both drawn: an XObject that no content stream invokes is
      // not an image a reader reports, so "the file has two images" has to mean both halves.
      const declared = (text.match(/\/Subtype \/Image/g) ?? []).length;
      if (declared !== 2) return `expected 2 image XObjects in the bytes, found ${declared}`;
      const drawn = (text.match(/\/Im(High|Low) Do/g) ?? []).length;
      if (drawn !== 2) return `expected both images to be drawn, found ${drawn} Do operator(s)`;
      return null;
    },
  },
  {
    // Three pages, the middle one empty on purpose — the two halves of `BLANK_PAGES_DETECTED` need one fixture where
    // a page really has no ink and one, next to it in the suite, where every page does. `pages-six-a4.pdf` is the
    // control: same writer, same size, no blank page, so a warning that fires on both is a warning about nothing.
    name: 'pdf-to-images-blank-a4.pdf',
    spec: { pages: 3, label: 'Render fixture', blankPages: [2] },
  },
  { name: 'ocr-scan-eng.pdf', spec: { pages: 1, label: 'OCR fixture' } },
  {
    // Every metadata store a PDF can carry, in one file: a `/Info` dictionary, an XMP packet, and an embedded file.
    // `remove-metadata` has to remove all three by default and keep the ones asked for, and none of that is testable
    // against a fixture that has only the one. The values are distinctive strings on purpose — the golden cases
    // search the output for them by name, so "the author is gone" is proved rather than inferred from a field count.
    name: 'metadata-rich-a4.pdf',
    spec: {
      pages: 3,
      label: 'Metadata fixture',
      docInfo: {
        title: 'Quarterly figures',
        author: 'Dana Scully',
        subject: 'METADATA-DOCINFO-MARKER',
        keywords: 'secret, internal',
        creator: 'Fixture Writer',
      },
      xmp: { creator: 'METADATA-XMP-MARKER' },
      attachment: { name: 'secret-attachment.txt', content: 'PAYLOAD-METADATA-ATTACHMENT\n' },
    },
  },
];

interface PlainFixture {
  name: string;
  content: string;
}

interface ZipFixture {
  name: string;
  /**
   * Entries for the archives this script composes directly.
   *
   * Optional because three fixtures are whole packages rather than a list of parts — a workbook, a deck and a
   * 2 001-member archive — and building those means calling a helper, not writing out members here.
   */
  entries?: Array<{ name: string; content: string | Uint8Array }>;
  /** A complete archive from a helper (`buildXlsx`, `buildZip`), for the packages above. */
  bytes?: Uint8Array;
  /** Member names the written archive must contain, checked against its own central directory. */
  expectEntries?: string[];
  /** How many members the archive must contain, for the one whose member list is not worth spelling out. */
  expectEntryCount?: number;
}

/**
 * HTML for `html-to-pdf`.
 *
 * The standalone file is deliberately plain: no external stylesheet, no fonts — so a failure in its case is the
 * conversion, not the asset resolution. The bundle is the opposite, and one asset in it is *load-bearing*: the
 * `assets/logo.png` the entry page references by a relative path, because a relative image that resolves becomes an
 * image XObject in the output and one that does not leaves nothing behind. Counting that object is how the case
 * proves the archive was extracted with its tree intact, rather than calling a conversion that dropped every asset
 * a success.
 *
 * An earlier version of this fixture proved the same thing with a stylesheet and `#asset-probe { display: none }`,
 * asserting the hidden text's *absence*. It had to be replaced: LibreOffice's HTML import ignores `display: none` on
 * an inline element — measured, with an inline `<style>` as the control — so the assertion failed for a reason that
 * had nothing to do with asset resolution, and it would have failed identically for a handler that loaded every
 * asset perfectly. A probe has to be something the engine actually honours.
 */
const HTML_FIXTURES: PlainFixture[] = [
  {
    name: 'html-to-pdf-invoice.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>HTML fixture</title>',
      '<style>body { font-family: Helvetica, Arial, sans-serif; } table { border-collapse: collapse; }',
      'td, th { border: 1px solid #999; padding: 4px 8px; }</style>',
      '</head>',
      '<body>',
      '<h1>HTML PDF FIXTURE MARKER</h1>',
      '<p>This page is plain HTML with no external assets.</p>',
      '<table><tr><th>tool</th><th>queue</th></tr><tr><td>html-to-pdf</td><td>office</td></tr></table>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  },
  {
    // The egress vector, and the only one measured to exist: LibreOffice issues a real request for a remote image
    // while converting this file (`workers/shared/src/guards/remote-references.ts` records the measurement). The
    // reference points at loopback so the fixture is honest about what it is: an address that *would* answer inside
    // the container, which is why the refusal — not the network — has to be what stops it.
    name: 'html-to-pdf-remote-asset.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>HTML fixture with a remote asset</title></head>',
      '<body>',
      '<h1>HTML REMOTE ASSET FIXTURE MARKER</h1>',
      '<img src="http://127.0.0.1:9913/unreachable.png" alt="remote asset">',
      '<p>The image above is named by URL rather than stored with the document.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  },
  {
    // The same vector with no tag to catch it: a stylesheet the renderer resolves *while drawing*. An `@import` and
    // a `background: url(…)` are two different code paths inside the engine's CSS loader, and both are fetches.
    name: 'html-to-pdf-remote-css.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>HTML fixture with a remote stylesheet</title>',
      '<style>',
      '@import url("http://127.0.0.1:9913/imported.css");',
      '.hero { background-image: url(http://127.0.0.1:9913/background.png); }',
      '</style>',
      '</head>',
      '<body>',
      '<h1>HTML REMOTE CSS FIXTURE MARKER</h1>',
      '<p class="hero">The stylesheet above names two resources that are not in this document.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  },
  {
    // A *scheme* rather than a URL. `macro:///Standard.Module1.Main` is a URI LibreOffice resolves and executes —
    // measured (`test:isolation` leg 4 runs a profile macro through one) — so the guard has to refuse every scheme
    // rather than the two it was written for. This fixture is the end-to-end half of that sentence.
    name: 'html-to-pdf-macro-uri.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>HTML fixture naming a macro URI</title></head>',
      '<body>',
      '<h1>HTML MACRO URI FIXTURE MARKER</h1>',
      '<img src="macro:///Standard.Module1.Main" alt="not an image">',
      '<p>The reference above is a URI scheme this engine knows how to run.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  },
  {
    // The HTML path's macro question, expressed as the thing HTML can actually carry: a script. LibreOffice's HTML
    // import has no JavaScript runtime today, and D2's plan for this tool names Chromium, which does — so "a script
    // in a document does not run" is a property worth measuring, not assuming. The script's only evidence is a
    // request to the loopback listener in `test:isolation`, which is the check that would fail if a runtime appeared.
    // The `data:` image and the hyperlink in the same file are the negative controls: both are ordinary HTML and must
    // convert, so a guard that grew a scheme test it regrets fails here as well.
    name: 'html-to-pdf-script.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>HTML fixture with a script</title></head>',
      '<body>',
      '<h1>HTML SCRIPT FIXTURE MARKER</h1>',
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==" alt="inline">',
      '<p><a href="https://example.com/docs">A hyperlink is not a fetch</a></p>',
      '<script>',
      '  // If a JavaScript runtime ever executes documents in this pool, this request is what records it.',
      '  var probe = new Image();',
      '  probe.src = "http://127.0.0.1:9913/script-executed.png";',
      '  document.title = "SCRIPT EXECUTED";',
      '</script>',
      '<noscript>No script runtime ran this page.</noscript>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  },
];

/**
 * One worksheet of `buildXlsx`, as an inline-string grid — the writer's shape, not a spreadsheet's.
 *
 * `rows` and `columns` are what give the fixture its **pagination**, which is the whole point of it: a sheet that
 * fits on one page cannot tell a handler that fits each sheet to a page from one that does not.
 */
interface SheetSpec {
  name: string;
  marker: string;
  rows: number;
  columns: number;
}

/**
 * A workbook the engine can open, with several **named** sheets — the fixture the office options are measured on.
 *
 * Three sheets and not one, because the options this tool exposes are about *selection* and *fitting*: a
 * `pageRange` case needs a document whose pages cover more than one sheet (the engine's `PageRange` is a page range,
 * proved by asking a three-sheet workbook for page 3 and reading back sheet 2's marker), and a `fitToPage` case
 * needs a sheet that would otherwise spill onto a second page. Each sheet carries its own marker in `A1` and is
 * eight columns wide, so it paginates to two pages at LibreOffice's default scale: six pages for the workbook,
 * three when each sheet is fitted to one.
 *
 * Per-sheet markers are load-bearing rather than decorative. "Which sheet came out" is not a page count — a range
 * that silently kept the wrong sheet still produces a plausible file — and it is not a title either: the assertion is
 * `expectText` for the sheet that must be there and `expectAbsentText` for the ones that must not.
 *
 * The shape settled after one wrong guess. A sheet whose columns are narrow enough to fit the page paginates
 * *horizontally*, which puts a sheet's second page beside its first and makes "page 3 is sheet 2" a coincidence of
 * the fixture's own column widths: measured — 45 rows × 8 columns gave four pages in the order Alpha, Beta,
 * Gamma, Gamma. **Tall and narrow** (150 rows × 3 columns) paginates downwards only, so the map is arithmetic —
 * pages 1–3 are Alpha, 4–6 Beta, 7–9 Gamma, nine pages in all — and the four-page case below names page 4 because
 * that is Beta's first page.
 */
function buildXlsx(sheets: SheetSpec[]): Uint8Array {
  const sheetXml = (sheet: SheetSpec): string => {
    const rows: string[] = [`<row r="1"><c r="A1" t="inlineStr"><is><t>${sheet.marker}</t></is></c></row>`];
    for (let row = 2; row <= sheet.rows; row += 1) {
      const cells: string[] = [];
      for (let column = 0; column < sheet.columns; column += 1) {
        const ref = `${String.fromCharCode(65 + column)}${row}`;
        cells.push(
          `<c r="${ref}" t="inlineStr"><is><t>${sheet.name.toLowerCase()} row ${row} column ${column + 1} padding</t></is></c>`,
        );
      }
      rows.push(`<row r="${row}">${cells.join('')}</row>`);
    }
    return [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      `<sheetData>${rows.join('')}</sheetData>`,
      '</worksheet>',
      '',
    ].join('\n');
  };

  return buildZip([
    {
      name: '[Content_Types].xml',
      content: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ...sheets.map(
          (_sheet, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        ),
        '</Types>',
        '',
      ].join('\n'),
    },
    {
      // Package relationship first: without it LibreOffice answers "source file could not be loaded" for any
      // hand-built workbook, which is how the macro fixture failed before this was added.
      name: '_rels/.rels',
      content: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
        '</Relationships>',
        '',
      ].join('\n'),
    },
    {
      name: 'xl/workbook.xml',
      content: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        `<sheets>${sheets
          .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
          .join('')}</sheets>`,
        '</workbook>',
        '',
      ].join('\n'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        ...sheets.map(
          (_sheet, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        ),
        '</Relationships>',
        '',
      ].join('\n'),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(sheet),
    })),
  ]);
}

/**
 * A presentation with a sheet of **speaker notes** attached to its first slide.
 *
 * ODF rather than OOXML, and that is a measurement rather than a preference: notes in a hand-built `.pptx` need a
 * notes *master* with the placeholders LibreOffice's own notes page is laid out from, and the export aborts
 * (`impl_store … 0xc10`) when the deck has notes and no usable master. An `.odp` carries its notes inside
 * `content.xml` as a `presentation:notes` element of the page, and the engine takes them from there: two slides plus
 * one notes page produce four PDF pages with `ExportNotesPages`, and two without it.
 */
function buildOdpWithNotes(slides: Array<{ marker: string; notes?: string }>): Uint8Array {
  const page = ({ marker, notes }: { marker: string; notes?: string }, index: number): string =>
    [
      `<draw:page draw:name="page${index + 1}" draw:style-name="dp1" draw:master-page-name="Default">`,
      '<draw:frame presentation:style-name="pr1" draw:layer="layout" svg:width="24cm" svg:height="3cm" svg:x="2cm" svg:y="2cm" presentation:class="title">',
      `<draw:text-box><text:p>${marker}</text:p></draw:text-box></draw:frame>`,
      notes
        ? `<presentation:notes draw:style-name="dp2"><draw:frame presentation:style-name="pr1" draw:layer="layout" svg:width="24cm" svg:height="3cm" svg:x="2cm" svg:y="2cm" presentation:class="notes"><draw:text-box><text:p>${notes}</text:p></draw:text-box></draw:frame></presentation:notes>`
        : '',
      '</draw:page>',
    ].join('');

  return buildZip([
    { name: 'mimetype', content: 'application/vnd.oasis.opendocument.presentation' },
    {
      name: 'META-INF/manifest.xml',
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">',
        '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>',
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
        '</manifest:manifest>',
        '',
      ].join('\n'),
    },
    {
      name: 'content.xml',
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<office:document-content',
        ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
        ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
        ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
        ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
        ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
        ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
        ' office:version="1.2">',
        '<office:automatic-styles>',
        '<style:style style:name="dp1" style:family="drawing-page"/>',
        '<style:style style:name="dp2" style:family="drawing-page"/>',
        '<style:style style:name="pr1" style:family="presentation"><style:graphic-properties draw:fill="none"/></style:style>',
        '</office:automatic-styles>',
        '<office:body><office:presentation>',
        ...slides.map((slide, index) => page(slide, index)),
        '</office:presentation></office:body>',
        '</office:document-content>',
        '',
      ].join('\n'),
    },
  ]);
}

const ZIP_FIXTURES: ZipFixture[] = [
  {
    // The workbook the office options are measured on: three named sheets, each three columns wide and 150 rows
    // tall, so it paginates **downwards only** to nine pages of A4 — three per sheet, in sheet order — and to three
    // when each sheet is fitted to one page.
    name: 'office-to-pdf-sheets.xlsx',
    bytes: buildXlsx([
      { name: 'Alpha', marker: 'ALPHA SHEET MARKER', rows: 150, columns: 3 },
      { name: 'Beta', marker: 'BETA SHEET MARKER', rows: 150, columns: 3 },
      { name: 'Gamma', marker: 'GAMMA SHEET MARKER', rows: 150, columns: 3 },
    ]),
    expectEntries: [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ],
  },
  {
    // A deck with speaker notes on its first slide, for the `slideNotes` option. Two slides and one notes page: two
    // PDF pages without the option, four with it (the notes page follows its slide).
    name: 'office-to-pdf-notes.odp',
    bytes: buildOdpWithNotes([
      { marker: 'ODP SLIDE ONE MARKER', notes: 'ODP SPEAKER NOTES MARKER' },
      { marker: 'ODP SLIDE TWO MARKER' },
    ]),
    expectEntries: ['mimetype', 'META-INF/manifest.xml', 'content.xml'],
  },
  {
    // An archive whose **entry count** is past the 2 000 limit of docs/07-OFFICE-TO-PDF.md §6, proved by its own
    // directory rather than by its contents: a bundle guard that only looked at the entry page's assets would let
    // this through, and 2 001 tiny members are a real shape (a site export's asset tree) rather than a contrived one.
    name: 'html-to-pdf-bundle-too-many-entries.zip',
    bytes: buildZip([
      {
        name: 'index.html',
        content: '<!doctype html><html><body><h1>HTML BUNDLE MARKER</h1></body></html>\n',
      },
      ...Array.from({ length: 2000 }, (_unused, index) => ({
        name: `assets/part-${String(index).padStart(4, '0')}.txt`,
        content: `asset ${index}\n`,
      })),
    ]),
    // 2 001 members: the entry page plus the 2 000 that put it past the documented limit.
    expectEntryCount: 2001,
  },
  {
    name: 'html-to-pdf-bundle.zip',
    entries: [
      {
        name: 'index.html',
        content: [
          '<!doctype html>',
          '<html lang="en">',
          '<head><meta charset="utf-8"><link rel="stylesheet" href="assets/site.css"></head>',
          '<body>',
          '<h1>HTML BUNDLE MARKER</h1>',
          '<img src="assets/logo.png" alt="bundle asset">',
          '<p>The image above is a separate file inside this archive.</p>',
          '</body>',
          '</html>',
          '',
        ].join('\n'),
      },
      {
        name: 'assets/site.css',
        content: ['body { font-family: Helvetica, Arial, sans-serif; }', ''].join('\n'),
      },
      {
        // A flat two-tone band, the same encoder `images-to-pdf` uses: 119 bytes of real PNG, so the fixture stays
        // readable in review and the image that has to survive the round trip is genuinely present.
        name: 'assets/logo.png',
        content: buildPng({
          width: 48,
          height: 48,
          // Two vertical bands, so the embedded asset is visibly an image rather than a grey box.
          pixel: (x, _y) => (x < 24 ? [200, 30, 30] : [30, 30, 200]),
        }),
      },
    ],
  },
  {
    // The path only an archive can reach: a reference that appears *after* extraction. The handler scans the prepared
    // tree — the CSS beside the page, not just the page — and this fixture is the case that says so, because a scan
    // limited to the entry document would convert this bundle and quietly fetch the import while rendering it.
    name: 'html-to-pdf-bundle-remote-css.zip',
    entries: [
      {
        name: 'index.html',
        content: [
          '<!doctype html>',
          '<html lang="en">',
          '<head><meta charset="utf-8"><link rel="stylesheet" href="styles/site.css"></head>',
          '<body>',
          '<h1>HTML BUNDLE REMOTE CSS MARKER</h1>',
          '<img src="assets/logo.png" alt="bundle asset">',
          '</body>',
          '</html>',
          '',
        ].join('\n'),
      },
      {
        // Relative itself, so the page loads it — and it is what names the remote resource, which is why the scan
        // has to walk the extracted tree rather than only the entry document.
        name: 'styles/site.css',
        content: [
          '@import url("http://127.0.0.1:9913/bundle-import.css");',
          'body { font-family: Helvetica, Arial, sans-serif; }',
          '',
        ].join('\n'),
      },
      {
        name: 'assets/logo.png',
        content: buildPng({
          width: 48,
          height: 48,
          pixel: (x, _y) => (x < 24 ? [20, 120, 80] : [200, 200, 40]),
        }),
      },
    ],
  },
  {
    // A macro-enabled workbook as the format defines one, and **loadable by the engine**: the `macroEnabled` main
    // content type, a `bin` part type, the `vbaProject` relationship, and the `xl/vbaProject.bin` part it names.
    // Verified by converting it inside the pool — LibreOffice opens it and produces a PDF, so the guard is the only
    // thing standing between this document and a conversion. The `.bin` carries an OLE2 header and nothing else:
    // the guard refuses the *carrier*, not the code, and this repository has no VBA compiler to put a project in it.
    // That is the limit of the fixture, and it is the level the guard works at.
    name: 'office-to-pdf-macro.xlsm',
    entries: [
      {
        name: '[Content_Types].xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
          '<Default Extension="xml" ContentType="application/xml"/>',
          '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>',
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>',
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
          '</Types>',
          '',
        ].join('\n'),
      },
      {
        // The package-level relationship, and the reason this fixture took three attempts. Without it LibreOffice
        // answers "source file could not be loaded" for *any* hand-built workbook — the first version therefore
        // failed with `CONVERSION_FAILED` instead of converting, which would have hidden the very regression the case
        // exists to catch (remove the guard and the job must **complete**, or the claim is reading the wrong failure).
        name: '_rels/.rels',
        content: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
          '</Relationships>',
          '',
        ].join('\n'),
      },
      {
        // A workbook the engine can actually open, so that removing the guard leaves a *completed* conversion.
        name: 'xl/workbook.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
          ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>',
          '</workbook>',
          '',
        ].join('\n'),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
          '<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>',
          '</Relationships>',
          '',
        ].join('\n'),
      },
      {
        // The OLE2 compound-file header, which is what a real `vbaProject.bin` starts with.
        name: 'xl/vbaProject.bin',
        content: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
          '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MACRO FIXTURE MARKER</t></is></c></row></sheetData>',
          '</worksheet>',
          '',
        ].join('\n'),
      },
    ],
  },
  {
    // The same claim in the other container family: an ODF text document with an embedded Basic library, in the
    // layout LibreOffice writes. Two families rather than one because the detector has three branches and a refusal
    // that only ever fires for `vbaProject.bin` would leave the ODF and OLE2 branches unproven end to end.
    name: 'office-to-pdf-macro.odt',
    entries: [
      { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text' },
      {
        name: 'META-INF/manifest.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">',
          '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>',
          '<manifest:file-entry manifest:full-path="Basic/Standard/Module1.xml" manifest:media-type="text/xml"/>',
          '</manifest:manifest>',
          '',
        ].join('\n'),
      },
      {
        name: 'content.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
          ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">',
          '<office:body><office:text><text:p>MACRO FIXTURE MARKER</text:p></office:text></office:body>',
          '</office:document-content>',
          '',
        ].join('\n'),
      },
      {
        name: 'Basic/script-lc.xml',
        content: '<library:libraries xmlns:library="http://openoffice.org/2000/library"/>',
      },
      {
        name: 'Basic/Standard/Module1.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">',
          'Sub Main',
          '  Dim n As Integer',
          '  n = Freefile',
          '  Open "/tmp/macro-ran" For Output As #n',
          '  Close #n',
          'End Sub',
          '</script:module>',
          '',
        ].join('\n'),
      },
    ],
  },
  {
    // A document that carries a **runnable** Basic library, in the layout LibreOffice itself writes — learned by
    // having the engine author one and reading the package back rather than by guessing: `Basic/script-lc.xml`
    // lists the library with **no** xlink href, a `Basic/<lib>/script-lb.xml` descriptor names the modules, each
    // module is `Basic/<lib>/<Module>.xml`, and every Basic entry is declared `text/xml` in the manifest.
    //
    // Two subs, because the question has two halves and one marker cannot tell them apart: `Fire` is what an
    // explicit script invocation runs, and `OnLoadHook` is what the document's own `dom:load` listener names. The
    // listener is bound in `content.xml` exactly as ODF 1.2 spells it. `test:isolation` measures which of the two
    // paths actually reaches the code (see leg 7 in `scripts/ci/isolation.ts`) — the binding is the thing under
    // test, so it is written the way the specification says and not the way an engine is assumed to read it.
    //
    // Every observable is a side effect the stage can see from outside the engine: a marker file in the stage's own
    // scratch directory, and a request to the loopback listener it already runs in this container.
    name: 'office-to-pdf-document-macro.odt',
    entries: [
      { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text' },
      {
        name: 'META-INF/manifest.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">',
          '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>',
          '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="META-INF/manifest.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="Basic/script-lc.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="Basic/Standard/script-lb.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="Basic/Standard/LoadHook.xml" manifest:media-type="text/xml"/>',
          '</manifest:manifest>',
          '',
        ].join('\n'),
      },
      {
        name: 'content.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-content',
          ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
          ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
          ' xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"',
          ' office:version="1.3">',
          '<office:scripts>',
          '<office:event-listeners>',
          '<office:event-listener office:event-name="dom:load" script:language="ooo:Basic" script:macro-name="Standard.LoadHook.OnLoadHook"/>',
          '</office:event-listeners>',
          '</office:scripts>',
          '<office:body><office:text><text:p>DOCUMENT MACRO FIXTURE MARKER</text:p></office:text></office:body>',
          '</office:document-content>',
          '',
        ].join('\n'),
      },
      {
        name: 'styles.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3">',
          '<office:styles/>',
          '</office:document-styles>',
          '',
        ].join('\n'),
      },
      {
        name: 'Basic/script-lc.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">',
          '<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">',
          ' <library:library library:name="Standard" library:link="false"/>',
          '</library:libraries>',
          '',
        ].join('\n'),
      },
      {
        name: 'Basic/Standard/script-lb.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">',
          '<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">',
          ' <library:element library:name="LoadHook"/>',
          '</library:library>',
          '',
        ].join('\n'),
      },
      {
        name: 'Basic/Standard/LoadHook.xml',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">',
          '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="LoadHook" script:language="StarBasic">Sub Fire',
          '  Dim n As Integer',
          '  n = Freefile',
          '  Open "/tmp/isolation/document-macro-invoked" For Output As #n',
          '  Print #n, "an explicit invocation ran the document\u2019s own Basic"',
          '  Close #n',
          'End Sub',
          'Sub OnLoadHook',
          '  Dim n As Integer',
          '  n = Freefile',
          '  Open "/tmp/isolation/document-macro-onload" For Output As #n',
          '  Print #n, "the document\u2019s load listener ran"',
          '  Close #n',
          'End Sub</script:module>',
          '',
        ].join('\n'),
      },
    ],
  },
];

/**
 * Inputs that are not PDFs, so the office pool has something real to convert.
 *
 * `office-to-pdf` takes DOCX/XLSX/PPTX/ODT/TXT/CSV, and the plain-text two need no archive writer: they reach
 * exactly the same LibreOffice code path as a `.docx` does, while keeping this script dependency-free. The
 * detection layer accepts them on their bytes — a `.txt` and a `.csv` are distinguished by how many separators
 * the first line carries, never by the name they were uploaded under.
 */
const PLAIN_FIXTURES: PlainFixture[] = [
  {
    name: 'office-to-pdf-report.txt',
    content: [
      'PDF Tools — office conversion fixture',
      '',
      'This file is plain text. LibreOffice turns it into a PDF through the same',
      'path a .docx takes, which is what makes it a useful fixture: it exercises',
      'the office worker without requiring a DOCX writer in this repository.',
      '',
      'Expected: at least one page, and no part of this text lost.',
      '',
    ].join('\n'),
  },
  {
    name: 'office-to-pdf-table.csv',
    content: [
      'tool,queue,phase',
      'merge,light,3',
      'office-to-pdf,office,4',
      'pdf-to-pdfa,heavy,5',
      'ocr,ocr,6',
      '',
    ].join('\n'),
  },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const written: string[] = [];
  for (const fixture of FIXTURES) {
    const built = buildPdf(fixture.spec);
    const bytes = fixture.damage ? fixture.damage(built) : built;
    const path = join(OUT_DIR, fixture.name);
    await writeFile(path, bytes);
    const pages = countPagesInPdf(bytes);
    const expected = fixture.spec.pages;
    const problem = fixture.check?.(bytes) ?? null;
    written.push(
      `${fixture.name.padEnd(28)} ${String(bytes.length).padStart(7)} bytes  ${pages} page(s)${
        pages === expected ? '' : ` — MISMATCH (expected ${expected})`
      }${problem == null ? '' : ` — SHAPE WRONG: ${problem}`}`,
    );
    if (pages !== expected || problem != null) process.exitCode = 1;
  }
  for (const fixture of [...PLAIN_FIXTURES, ...HTML_FIXTURES]) {
    const path = join(OUT_DIR, fixture.name);
    await writeFile(path, fixture.content, 'utf8');
    written.push(`${fixture.name.padEnd(28)} ${String(fixture.content.length).padStart(7)} bytes  plain text`);
  }
  for (const fixture of ZIP_FIXTURES) {
    const bytes = fixture.bytes ?? buildZip(fixture.entries ?? []);
    const path = join(OUT_DIR, fixture.name);
    await writeFile(path, bytes);
    // Read back through the central directory: a written-but-unreadable archive is the failure this catches, and
    // the count is checked against what was put in rather than merely printed.
    const directory = readZipDirectory(bytes);
    const actual = directory.map((entry) => entry.name).sort();
    const expected = (fixture.expectEntries ?? fixture.entries?.map((entry) => entry.name) ?? []).sort();
    const ok =
      fixture.expectEntryCount != null
        ? directory.length === fixture.expectEntryCount
        : expected.length > 0 && JSON.stringify(expected) === JSON.stringify(actual);
    const expectation = fixture.expectEntryCount != null ? `${fixture.expectEntryCount} entries` : expected.join(', ');
    written.push(
      `${fixture.name.padEnd(28)} ${String(bytes.length).padStart(7)} bytes  ${directory.length} entr${
        directory.length === 1 ? 'y' : 'ies'
      }${ok ? '' : ` — MISMATCH (expected ${expectation})`}`,
    );
    if (!ok) process.exitCode = 1;
  }

  console.log(`fixtures written to ${OUT_DIR}\n`);
  console.log(written.join('\n'));
}

await main();
