import { deflateSync } from 'node:zlib';

/**
 * A minimal, dependency-free PDF writer.
 *
 * Why hand-write PDFs instead of checking binaries into `fixtures/`: a fixture nobody can regenerate is a fixture
 * nobody can trust, and a binary in git is opaque in review. This produces a valid, deterministic document — real
 * page tree, real xref, real font resource — so qpdf, mutool, Ghostscript, and LibreOffice all accept it, and the
 * byte offsets in the cross-reference table are computed rather than copied.
 *
 * Scope: text pages only. That is enough for merge/split/rotate/compress/pdf-to-images fixtures and for the E2E
 * assertion (page count is what those tools change), and it keeps the file small enough to read.
 */

/** One table, and the pages it belongs on. */
export interface TableSpec {
  /** Cell text, row-major. The first row is drawn from the top, like a document's header row. */
  rows: string[][];
  /** Table's bottom-left corner, in points from the page's origin. */
  origin?: [number, number];
  columnWidthPt?: number;
  rowHeightPt?: number;
  /** Draw the grid rules. `false` leaves the columns aligned by whitespace alone. */
  ruled?: boolean;
  /**
   * Pages this table is drawn on, 1-based like every other page reference in this file. Omitted means every page,
   * which is what every fixture before `tables-mixed-a4.pdf` wanted.
   */
  pages?: number[];
}

export interface PdfSpec {
  /** Text drawn on every page — makes a merged document's page order visible when a human opens it. */
  label?: string;
  pages: number;
  /** Media box in points. A4 by default. */
  pageSize?: [number, number];
  /**
   * Text at chosen coordinates, in PDF user space (origin lower-left, y is the baseline).
   *
   * The label every page already carries cannot aim a rectangle at anything: a tool that has to remove *specific*
   * content needs the content at a known place, and "known" has to mean the fixture's own numbers rather than a
   * measurement taken afterwards. `page` selects one page; omitting it draws the run on every page, like `label` and
   * `table`. Coordinates are deliberately the contract's convention so a golden case can repeat them verbatim.
   */
  texts?: Array<{ text: string; x: number; y: number; size?: number; page?: number }>;
  /**
   * A `/Rotate` value on every page, in degrees.
   *
   * A page's rotation is a *display* instruction: the box and the content are unchanged. That is why it is worth a
   * fixture — a tool that composes pages has to apply the rotation itself, and one that ignores it produces a
   * document where every rotated page is lying on its side, with the page count and the text exactly right.
   */
  rotate?: number;
  /**
   * Pages that are deliberately **empty** — no label, no rules, no text.
   *
   * A rendered page with no ink is a fact `pdf-to-images` promises to warn about (`BLANK_PAGES_DETECTED`), and it is
   * the one thing no other fixture here can produce: every page written by this module carries a label and two rules,
   * so every page has ink by construction. The measurement the warning makes is exact — "the darkest pixel is pure
   * white" — and a fixture is the only way to arrange that without inventing a threshold.
   *
   * 1-based, like every other page reference in this file.
   */
  blankPages?: number[];
  /**
   * Adds a `/Info` dictionary — one of a PDF's two metadata stores, and the one `remove-metadata` must be able to
   * delete. Values are deliberately distinctive so a test can search for them by name.
   */
  docInfo?: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string };
  /** Adds an uncompressed XMP `/Metadata` stream on the catalog — the second store, written by a different producer. */
  xmp?: { creator: string };
  /**
   * An outline ("bookmarks") tree, with destinations into this document's own pages.
   *
   * A hand-written `/Outlines` tree rather than a pikepdf post-pass, because the fixtures have to be readable in
   * review like every other one here: what `merge` does with an outline is a claim about *titles and nesting*, and a
   * fixture whose outline was produced by a library would make the test's expectation a copy of that library's
   * behaviour. Nesting is written recursively so a two-level fixture is possible; nothing needs three.
   *
   * `page` is 1-based and clamped into the document. An entry with no page lands on page 1, which is what a reader
   * shows for a destination-less bookmark anyway.
   */
  outline?: OutlineEntry[];
  /** Adds an embedded file, so attachment removal is testable rather than assumed. */
  attachment?: { name: string; content: string };
  /**
   * A table drawn on every page.
   *
   * The one fixture shape that cannot be faked with a paragraph: a table extractor's whole job is finding the grid,
   * and `pdf-to-csv` has two paths for that — `lattice` reads drawn rules, `stream` reads nothing but the whitespace
   * between columns. Which is why `ruled: false` is a variant rather than an oversight: the *same* cells, without a
   * single rule, is what proves the whitespace path exists.
   */
  table?: TableSpec;
  /**
   * Several tables, each optionally on its own pages.
   *
   * `table` cannot express what three options in `08-PDF-TO-OFFICE-AND-TEXT.md` are about, because a table drawn on
   * every page is always the *same* table on every page: no document could distinguish "one sheet per table" from
   * "one sheet per page" (`oneSheetPerPage`), and `allTables: false` had nothing to choose between when a document
   * held one table. `tables-mixed-a4.pdf` is the fixture those options ask for — two ruled tables of different sizes
   * on two of four pages, which is also the only arrangement that makes `PAGES_WITHOUT_TABLES` a statement about a
   * page rather than about the whole document.
   */
  tables?: TableSpec[];
  /**
   * Bytes of padding appended as one **unreferenced** stream object, so the *file* is large while the document is not.
   *
   * `compress` escalates above 100 MB or 300 pages (`04-COMPRESS.md` §6), and the two halves need different fixtures:
   * the page half is 320 real pages, and the byte half cannot be pages at all — 100 MB of them would make the case a
   * performance test for a routing decision. What the API measures is the size of the file it received, so the file
   * has to be big; what the *conversion* has to do with it is nothing, so the bytes are placed where nothing looks:
   * a stream no object in the graph references. A reader that walks the document never loads it (and a rewrite by
   * Ghostscript never writes it), while every consumer that measures the input — the upload, the job-size gate, the
   * handler's own `stat` — sees a document of the size the case is about.
   *
   * Zero bytes on purpose: they cannot be mistaken for a second document or for structure, and a stream of them is
   * valid uncompressed data rather than junk appended after `%%EOF`, which some readers tolerate and none promise to.
   *
   * Two fixtures are built this way and both say why in their own generator (`make-large-fixture.ts`).
   */
  padFileBytes?: number;
  /**
   * Bytes of padding to add to each page's content stream, by page, so a fixture can have **pages of different
   * sizes**.
   *
   * `split --mode by-size` is the only tool whose behaviour is about how big a page is, and no other fixture shape can
   * test it: a document of twelve identical pages packs into one part at any target that is not smaller than a page,
   * so the packing loop would appear to work while never being exercised. The padding is a PDF comment (`%…`), which
   * is legal anywhere outside a string and counts toward the stream's own `/Length` — the number the accounting rule
   * reads — while changing nothing about what the page renders.
   */
  padBytesPerPage?: number[];
  /**
   * Raster images, at chosen resolutions — see `ImageSpec`.
   *
   * Sized by their *box*, which is why two images of the same pixel dimensions in different boxes are two different
   * fixtures' worth of fact: the resolution a reader computes is `width / (boxWidthPt / 72)`, and `imagePpi` is the
   * one place that arithmetic lives so a generator can check its own fixture rather than restate the number.
   */
  images?: ImageSpec[];
  /**
   * A stream object that **nothing reads**, referenced from every page's own dictionary under the private key
   * `/PTCarrier`.
   *
   * The shape a redaction's byte search exists for, and the one no other fixture here can produce: a copy of a value
   * that no text layer, no rendered page and no reader references, so a rewrite has no reason to touch it and every
   * extraction-based check agrees the value is gone. Referenced rather than orphaned **on purpose** — `garbage=4` on
   * save drops an object nothing points at, which would take the leak away with the fixture's entire point — and
   * reached from the *page* dictionary rather than from `/Contents`, so nothing a reader renders or extracts contains
   * it.
   *
   * `text` is written verbatim, which is how a fixture puts a value in the file in a spelling only a byte reader can
   * see: `redact-carrier-hex.pdf` carries a token as a `<hex>` string here, next to the same token drawn on the page.
   */
  carrier?: string;
}

/**
 * A raster image, drawn into a box measured in points.
 *
 * The node that makes a fixture able to say something about **resolution**: the pixel size and the box it is drawn
 * into together fix the ppi a reader reports, so one document can carry an image `pdfimages` calls 720 dpi next to one
 * it calls 100. `pdf-to-pdfa` normalises images above 300 dpi and reports how many it touched
 * (`09-PDF-A.md` §4), and neither half of that is testable without a document whose images have different
 * resolutions — a fixture whose images are all high-resolution cannot tell "reduced the ones above the threshold"
 * from "reduced everything", and one with no images at all cannot tell "measured nothing" from "measured zero".
 *
 * Written as a Flate-compressed RGB XObject rather than as an embedded PNG: the writer already has `/Length`-based
 * stream emission, and a raw samples array needs no PNG encoder, no filter reconstruction and no second file format
 * in a module whose whole point is being readable in review.
 */
export interface ImageSpec {
  /** Pixel dimensions. */
  width: number;
  height: number;
  /** Uniform colour, so the image is obviously an image in a viewer and deflates to almost nothing. */
  tint: [number, number, number];
  /** Where it is drawn: `[x, y, widthPt, heightPt]` from the page's origin. This, not the pixel size, is the scale. */
  box: [number, number, number, number];
  /** 1-based page selector; omitted means every page. */
  page?: number;
  /** A label for the object name in the page's resources, so a fixture's two images are distinguishable by name. */
  name?: string;
}

/** The uniform-colour RGB samples of an image, in the row-major order PDF's `/DeviceRGB` expects. */
function rgbSamples(spec: ImageSpec): Uint8Array {
  const samples = new Uint8Array(spec.width * spec.height * 3);
  for (let pixel = 0; pixel < spec.width * spec.height; pixel += 1) {
    samples[pixel * 3] = spec.tint[0];
    samples[pixel * 3 + 1] = spec.tint[1];
    samples[pixel * 3 + 2] = spec.tint[2];
  }
  return samples;
}

/** The resolution `pdfimages -list` will report for an image: pixels over the box's size in inches. */
export function imagePpi(spec: ImageSpec): number {
  return Math.round(spec.width / (spec.box[2] / 72));
}

export interface OutlineEntry {
  title: string;
  /** 1-based destination page. */
  page?: number;
  children?: OutlineEntry[];
}

const encoder = new TextEncoder();

/** PDF strings are parenthesised; the only characters that must be escaped are the delimiters and the escape. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(
  label: string,
  pageIndex: number,
  total: number,
  width: number,
  height: number,
  tables: TableSpec[],
  texts: PdfSpec['texts'],
  images: Array<{ spec: ImageSpec; name: string }>,
): string {
  const text = escapeText(`${label} — page ${pageIndex + 1} of ${total}`);
  const lines = [
    'BT',
    '/F1 20 Tf',
    `72 ${Math.round(height - 96)} Td`,
    `(${text}) Tj`,
    'ET',
    '0.5 w',
    `72 ${Math.round(height - 120)} m 72 ${Math.round(height - 200)} l S`,
    `${Math.round(width - 72)} ${Math.round(height - 120)} m ${Math.round(width - 72)} ${Math.round(height - 200)} l S`,
  ];
  for (const run of texts ?? []) {
    if (run.page != null && run.page !== pageIndex + 1) continue;
    lines.push('BT', `/F1 ${run.size ?? 12} Tf`, `${run.x} ${run.y} Td`, `(${escapeText(run.text)}) Tj`, 'ET');
  }
  for (const table of tables) {
    if (table.pages != null && !table.pages.includes(pageIndex + 1)) continue;
    lines.push(...tableOperators(table, width));
  }
  for (const { spec, name } of images) {
    if (spec.page != null && spec.page !== pageIndex + 1) continue;
    // `cm` maps the unit square onto the box, and it is the only place the image is scaled: the object itself keeps
    // its pixel dimensions, which is what leaves the resolution a fact about the file rather than about the page it
    // happens to be on.
    lines.push('q', `${spec.box[2]} 0 0 ${spec.box[3]} ${spec.box[0]} ${spec.box[1]} cm`, `/${name} Do`, 'Q');
  }
  return lines.join('\n');
}

/**
 * The table's own operators: cell text, and the grid when it is ruled.
 *
 * Cell padding is deliberate — a `stream` extractor needs the columns separated by real space, and text that touched
 * its column boundary would be read as one cell by every reader that ever existed.
 */
function tableOperators(table: TableSpec, pageWidth: number): string[] {
  const rows = table.rows;
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length === 0 || columns === 0) return [];

  const columnWidth = table.columnWidthPt ?? 140;
  const rowHeight = table.rowHeightPt ?? 24;
  const [originX, originY] = table.origin ?? [72, 420];
  const tableWidth = columnWidth * columns;
  const tableHeight = rowHeight * rows.length;
  const operators: string[] = [];

  for (const [rowIndex, row] of rows.entries()) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const cell = row[columnIndex];
      if (cell == null || cell.length === 0) continue;
      const x = originX + columnIndex * columnWidth + 6;
      // Rows are drawn downwards from the table's top edge, which is where a header row belongs.
      const y = originY + tableHeight - (rowIndex + 1) * rowHeight + 8;
      const font = rowIndex === 0 ? '/F1 10 Tf' : '/F1 9 Tf';
      operators.push('BT', font, `${Math.round(x)} ${Math.round(y)} Td`, `(${escapeText(cell)}) Tj`, 'ET');
    }
  }

  if (table.ruled !== false) {
    operators.push('0.6 w', '0.35 G');
    for (let row = 0; row <= rows.length; row += 1) {
      const y = originY + tableHeight - row * rowHeight;
      operators.push(`${originX} ${Math.round(y)} m ${Math.round(originX + tableWidth)} ${Math.round(y)} l S`);
    }
    for (let column = 0; column <= columns; column += 1) {
      const x = originX + column * columnWidth;
      operators.push(`${Math.round(x)} ${originY} m ${Math.round(x)} ${Math.round(originY + tableHeight)} l S`);
    }
    operators.push('0 G');
  }

  // A table that runs past the page is a fixture bug, not a discovery: fail loudly here rather than leave a test to
  // notice that half the rows are missing.
  if (originX + tableWidth > pageWidth - 36 || originY < 60) {
    throw new Error('the fixture table does not fit on the page');
  }

  return operators;
}

/**
 * Build a document.
 *
 * Object layout, fixed so the xref can be computed in one pass:
 *
 *   1  catalog
 *   2  page tree
 *   3… pages, in pairs (page object, content stream)
 *   N  font (shared by every page)
 */
export function buildPdf(spec: PdfSpec): Uint8Array {
  const pageCount = Math.max(1, Math.floor(spec.pages));
  const [width, height] = spec.pageSize ?? [595, 842];
  const label = spec.label ?? 'PDF Tools fixture';

  const fontNumber = 3 + pageCount * 2;
  const objects: string[] = [];

  // Images are laid out immediately after the font, before the page loop, because a page's content stream and its
  // resource dictionary both have to *name* an object whose number is only decided once the layout is known. The
  // alternative — allocating them after the pages, where the metadata objects live — means either a second pass over
  // the pages or a page that references a number nothing occupies.
  const images = (spec.images ?? []).map((image, index) => ({ spec: image, name: image.name ?? `Im${index + 1}` }));
  const imageNumbers = images.map((_, index) => fontNumber + 1 + index);
  /** Deferred so a fixture with no image pays nothing: the samples are several MB before they are deflated. */
  const imageBytes = new Map<number, Uint8Array>();
  for (const [index, { spec: image }] of images.entries()) {
    const samples = rgbSamples(image);
    const number = imageNumbers[index]!;
    const compressed = deflateSync(samples);
    objects[number] =
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream`;
    imageBytes.set(number, new Uint8Array(compressed));
  }

  // Allocated before the page loop so a page can name it, exactly like the images above — and it is the first object
  // after the font and the images, which keeps every existing fixture's object numbers where they were.
  const carrierNumber = spec.carrier != null ? fontNumber + 1 + images.length : null;

  const kids: string[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    kids.push(`${3 + index * 2} 0 R`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;

  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    const padding = spec.padBytesPerPage?.[index] ?? 0;
    const blank = spec.blankPages?.includes(index + 1) ?? false;
    const body = blank
      ? ''
      : contentStream(
          label,
          index,
          pageCount,
          width,
          height,
          [...(spec.table ? [spec.table] : []), ...(spec.tables ?? [])],
          spec.texts,
          images,
        ) +
        // One comment line: the first characters after `%` to the newline are ignored by every reader, and the bytes
        // are part of the stream's `/Length`, which is the whole point of the option.
        (padding > 0 ? `\n%${'p'.repeat(Math.max(0, padding - 2))}` : '');

    const rotation = spec.rotate ? ` /Rotate ${((spec.rotate % 360) + 360) % 360}` : '';
    // Every image is named in every page's resources, whatever page it is *drawn* on: a resource dictionary is a
    // lookup table, and giving a page only the images its own content stream uses would make the fixture's structure
    // depend on the same `page` selector the assertion is about.
    const xobjects =
      images.length > 0
        ? ` /XObject << ${images.map((image, index) => `/${image.name} ${imageNumbers[index]} 0 R`).join(' ')} >>`
        : '';
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${rotation} ` +
      `/Resources << /Font << /F1 ${fontNumber} 0 R >>${xobjects} >> /Contents ${contentNumber} 0 R` +
      `${carrierNumber != null ? ` /PTCarrier ${carrierNumber} 0 R` : ''} >>`;
    objects[contentNumber] = `<< /Length ${encoder.encode(body).length} >>\nstream\n${body}\nendstream`;
  }

  objects[fontNumber] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  // Optional metadata objects, allocated after the font (and after any image) so every existing object number keeps
  // its meaning. The catalog and trailer are written last because they have to name numbers that only exist once
  // these are laid out.
  let nextNumber = fontNumber + 1 + images.length;
  if (spec.carrier != null) {
    const body = spec.carrier;
    objects[nextNumber] = `<< /Length ${encoder.encode(body).length} >>\nstream\n${body}\nendstream`;
    nextNumber += 1;
  }
  let infoNumber: number | null = null;
  if (spec.docInfo) {
    const fields: Array<[string, string | undefined]> = [
      ['Title', spec.docInfo.title],
      ['Author', spec.docInfo.author],
      ['Subject', spec.docInfo.subject],
      ['Keywords', spec.docInfo.keywords],
      ['Creator', spec.docInfo.creator],
    ];
    const body = fields
      .filter(([, value]) => value != null)
      .map(([key, value]) => `/${key} (${escapeText(value!)})`)
      .join(' ');
    infoNumber = nextNumber;
    nextNumber += 1;
    objects[infoNumber] = `<< ${body} >>`;
  }

  let xmpNumber: number | null = null;
  if (spec.xmp) {
    // A real XMP packet, with the identifying namespace and a creator a test can search for. Left uncompressed on
    // purpose: the point of the fixture is that the metadata is *findable*, and an inflated packet would hide the
    // difference between "removed" and "compressed".
    const xmp = [
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      `   <dc:creator><rdf:Seq><rdf:li>${spec.xmp.creator}</rdf:li></rdf:Seq></dc:creator>`,
      '  </rdf:Description>',
      ' </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n');
    xmpNumber = nextNumber;
    nextNumber += 1;
    objects[xmpNumber] =
      `<< /Type /Metadata /Subtype /XML /Length ${encoder.encode(xmp).length} >>\nstream\n${xmp}\nendstream`;
  }

  let fileSpecNumber: number | null = null;
  if (spec.attachment) {
    const payload = spec.attachment.content;
    const embeddedNumber = nextNumber;
    nextNumber += 1;
    objects[embeddedNumber] =
      `<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length ${encoder.encode(payload).length} >>\n` +
      `stream\n${payload}\nendstream`;
    fileSpecNumber = nextNumber;
    nextNumber += 1;
    objects[fileSpecNumber] =
      `<< /Type /Filespec /F (${escapeText(spec.attachment.name)}) ` +
      `/UF (${escapeText(spec.attachment.name)}) /EF << /F ${embeddedNumber} 0 R >> >>`;
  }

  /**
   * The one object whose payload is raw bytes rather than text — see `padFileBytes`.
   *
   * Held apart from `objects` because that array is `string[]` and the payload is deliberately not a string: building
   * 100 MB of it as one would allocate it twice (once as characters, once as UTF-8), which is the opposite of the
   * point of writing it here rather than into a checked-in binary.
   */
  const rawPayloads = new Map<number, number>();
  if (spec.padFileBytes != null) {
    const padBytes = Math.floor(spec.padFileBytes);
    if (padBytes < 1) throw new Error('padFileBytes must be a positive byte count');
    const paddingNumber = nextNumber;
    nextNumber += 1;
    rawPayloads.set(paddingNumber, padBytes);
    objects[paddingNumber] =
      `<< /Type /EmbeddedFile /Subtype /application#2Foctet-stream /Length ${padBytes} >>\nstream`;
  }

  let outlineRootNumber: number | null = null;
  if (spec.outline && spec.outline.length > 0) {
    outlineRootNumber = nextNumber;
    nextNumber += 1;

    // Numbers and parents in one pre-order pass, so an item can name its children (which come after it in the file)
    // without a second walk: `Map` preserves insertion order, so this doubles as the emission order below.
    const numbering = new Map<OutlineEntry, number>();
    const parents = new Map<OutlineEntry, number>();
    // Sibling groups by parent object number, because an outline is a *linked list* and not a tree: a reader walks
    // `/First` and then `/Next`, so an item that names no sibling silently ends the level. The first version of this
    // writer emitted `/First`/`/Last` only, and a two-chapter fixture read back as one chapter.
    const groups = new Map<number, OutlineEntry[]>();
    const allocate = (entries: OutlineEntry[], parent: number) => {
      groups.set(parent, entries);
      for (const entry of entries) {
        numbering.set(entry, nextNumber);
        parents.set(entry, parent);
        nextNumber += 1;
        allocate(entry.children ?? [], numbering.get(entry)!);
      }
    };
    allocate(spec.outline, outlineRootNumber);

    const descendants = (entry: OutlineEntry): number =>
      (entry.children ?? []).reduce((total, child) => total + 1 + descendants(child), 0);
    const pageRef = (entry: OutlineEntry) => {
      const page = Math.min(Math.max(1, Math.floor(entry.page ?? 1)), pageCount);
      return `${3 + (page - 1) * 2} 0 R`;
    };

    for (const [entry, number] of numbering) {
      const kids = entry.children ?? [];
      // `/Count` positive means the item is open, and it counts the descendants a viewer would show.
      const kidsClause =
        kids.length > 0
          ? ` /First ${numbering.get(kids[0]!)} 0 R /Last ${numbering.get(kids[kids.length - 1]!)} 0 R` +
            ` /Count ${descendants(entry)}`
          : '';
      const siblings = groups.get(parents.get(entry)!) ?? [];
      const position = siblings.indexOf(entry);
      const prev = position > 0 ? ` /Prev ${numbering.get(siblings[position - 1]!)} 0 R` : '';
      const next =
        position >= 0 && position < siblings.length - 1 ? ` /Next ${numbering.get(siblings[position + 1]!)} 0 R` : '';
      objects[number] =
        `<< /Title (${escapeText(entry.title)}) /Parent ${parents.get(entry)!} 0 R ` +
        `/Dest [${pageRef(entry)} /Fit]${prev}${next}${kidsClause} >>`;
    }

    const tops = spec.outline;
    objects[outlineRootNumber] =
      `<< /Type /Outlines /First ${numbering.get(tops[0]!)} 0 R ` +
      `/Last ${numbering.get(tops[tops.length - 1]!)} 0 R /Count ${numbering.size} >>`;
  }

  const catalogExtras = [
    xmpNumber != null ? `/Metadata ${xmpNumber} 0 R` : '',
    outlineRootNumber != null ? `/Outlines ${outlineRootNumber} 0 R` : '',
    fileSpecNumber != null && spec.attachment
      ? `/Names << /EmbeddedFiles << /Names [(${escapeText(spec.attachment.name)}) ${fileSpecNumber} 0 R] >> >>`
      : '',
  ]
    .filter((entry) => entry.length > 0)
    .join(' ');
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${catalogExtras ? ` ${catalogExtras}` : ''} >>`;

  const total = nextNumber - 1;
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const push = (text: string) => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    offset += bytes.length;
  };

  const pushBytes = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  push('%PDF-1.7\n');
  // A binary comment marks the file as binary for tools that sniff the first line.
  push('%\xE2\xE3\xCF\xD3\n');

  const offsets: number[] = [];
  for (let number = 1; number <= total; number += 1) {
    offsets[number] = offset;
    // An image's payload is real bytes (deflated samples) and the padded fixture's is a run of zeros; both are
    // emitted the same way, which is why the branch is "is there a payload" rather than "is this an image".
    const image = imageBytes.get(number);
    if (image != null) {
      push(`${number} 0 obj\n${objects[number]!}\n`);
      pushBytes(image);
      push('\nendstream\nendobj\n');
      continue;
    }
    const payload = rawPayloads.get(number);
    if (payload == null) {
      push(`${number} 0 obj\n${objects[number]!}\nendobj\n`);
      continue;
    }
    // The header, then the raw bytes, then the stream's own terminator. The bytes are zero-filled rather than built
    // from a template: 100 MB of them is one allocation here and no work at all for anything that reads the file.
    push(`${number} 0 obj\n${objects[number]!}\n`);
    pushBytes(new Uint8Array(payload));
    push('\nendstream\nendobj\n');
  }

  const xrefOffset = offset;
  push(`xref\n0 ${total + 1}\n`);
  push('0000000000 65535 f \n');
  for (let number = 1; number <= total; number += 1) {
    push(`${String(offsets[number]!).padStart(10, '0')} 00000 n \n`);
  }
  const info = infoNumber != null ? ` /Info ${infoNumber} 0 R` : '';
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R${info} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

/**
 * Count pages by reading the document, not by trusting a metadata field.
 *
 * `/Type /Page` with a word boundary excludes `/Type /Pages` (the tree node), which is the mistake that makes a
 * naive count report one page too many. Used by the E2E test as an independent check of what the API reported.
 */
export function countPagesInPdf(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![s])/g);
  return matches?.length ?? 0;
}
