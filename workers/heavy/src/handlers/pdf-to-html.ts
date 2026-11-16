import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PdfToHtmlOptions } from '@pdftools/contracts/tools';
import { countPdfPages, runOrThrow, runPdfToHtml, runPdfToText } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import { type Handler, pageBounds } from '@pdftools/worker-shared';

/**
 * `pdf-to-html` — `docs/08-PDF-TO-OFFICE-AND-TEXT.md`.
 *
 * Poppler's `pdftohtml` does the extraction; everything interesting is what this handler does around it, because
 * `pdftohtml`'s output is not a web page anyone would ship:
 *
 *  1. **`reflow` is a real transformation, not a flag.** Poppler has no reflowed mode: even its plain output
 *     positions every text block with `style="position:absolute;top:…;left:…"` over a full-page background raster.
 *     So reflow reads each block's `top`/`left`, re-emits the blocks in reading order, and drops the positioning.
 *     Without that, `mode` would be two names for the same output.
 *  2. **`fixed` keeps what Poppler produced** — the absolute positions, and the page-sized box it already wraps each
 *     page in — with only the source path, the per-page `<style>` blocks and the gray body colour cleaned up.
 *  3. **The page raster is dropped in reflow, and that is reported.** Poppler emits a full-page PNG whenever a page
 *     carries vector graphics it cannot express as HTML, so a reflowed document would otherwise contain a picture of
 *     the page it just reflowed. That can lose a chart drawn as vectors, hence `PAGE_RASTER_DROPPED`.
 *  4. **Images are a choice, not a promise.** `embedImages` (or `singleFile`) inlines them as base64 data URIs;
 *     otherwise they are written into `assets/` inside the archive. Either way the tool returns **one zip**, because
 *     the API resolves every declared output name against the output directory and rejects names containing a path
 *     separator — so an `assets/` directory can only exist *inside* the archive.
 *  5. **A document with no text layer is refused, not converted.** The probe runs before the conversion: a scanned
 *     PDF would otherwise yield an HTML file whose content is a picture of each page, which is worse than an
 *     explanation naming `ocr`.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg']);

interface TextBlock {
  top: number;
  left: number;
  /** The element's original attributes, kept verbatim in `fixed` mode — that is the layout this mode preserves. */
  attributes: string;
  className: string;
  html: string;
}

interface ImageItem {
  attributes: string;
}

type PageItem = { kind: 'text'; block: TextBlock } | { kind: 'image'; image: ImageItem };

export const pdfToHtml: Handler<PdfToHtmlOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to convert.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const pages = await countPdfPages(document.path, runOpts);
  if (pages < 1) {
    throw new JobFailure('INVALID_FILE', { message: 'The document has no pages to convert.' });
  }
  const bounds = pageBounds(options.pages, pages);
  const span = bounds ? ['-f', String(bounds.first), '-l', String(bounds.last)] : [];
  const pagesConverted = bounds ? bounds.last - bounds.first + 1 : pages;
  report({ progress: 15, phase: 'processing', message: 'Looking for a text layer.' });

  // The fail-fast from `docs/08-…` §5: no text layer in the selection means the honest answer is a typed refusal,
  // not an HTML file that is a photograph of the document.
  const probe = await runPdfToText([...span, document.path, '-'], {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 120_000),
  });
  if (probe.stdout.trim().length === 0) {
    throw new JobFailure('UNSUPPORTED_CONTENT', {
      message:
        'This document has no text layer, so an HTML conversion would only be a picture of each page. Run it through the `ocr` tool first, then convert the result.',
      stderrTail: probe.stderr,
    });
  }

  report({ progress: 30, phase: 'processing', message: `Converting ${pagesConverted} page(s).` });

  const htmlDir = await ensure(join(workDir, 'html'));
  const rawPath = join(htmlDir, 'raw.html');
  // Images land beside the HTML, named after the output file (`raw001.png`, …), which is why the engine runs in the
  // HTML directory rather than the job's working directory.
  await runPdfToHtml(
    [...(options.mode === 'fixed' ? ['-c'] : []), '-noframes', '-s', '-enc', 'UTF-8', ...span, document.path, rawPath],
    { ...runOpts, cwd: htmlDir },
  );

  const raw = await readFile(rawPath, 'utf8').catch(() => null);
  if (raw == null) {
    throw new JobFailure('CONVERSION_FAILED', { message: 'The HTML conversion produced no output file.' });
  }

  // ── Post-processing ──────────────────────────────────────────────────────────────────────────────────────────
  const publishDir = await ensure(join(workDir, 'publish'));
  const inline = options.embedImages || options.singleFile;
  const assetsDir = inline ? null : await ensure(join(publishDir, 'assets'));

  const resolved = new Map<string, string>();
  const missingImages = new Set<string>();
  let inlinedImages = 0;
  let assets = 0;

  const rewriteImage = async (name: string): Promise<string> => {
    const cached = resolved.get(name);
    if (cached) return cached;

    const source = join(htmlDir, name);
    const info = await stat(source).catch(() => null);
    if (!info) {
      // A referenced image the converter never wrote is a broken link in the output; report it rather than ship it
      // silently.
      missingImages.add(name);
      return name;
    }

    if (assetsDir) {
      await copyFile(source, join(assetsDir, name));
      assets += 1;
      const src = `assets/${name}`;
      resolved.set(name, src);
      return src;
    }

    const bytes = await readFile(source);
    inlinedImages += 1;
    const src = `data:${mimeFor(name)};base64,${bytes.toString('base64')}`;
    resolved.set(name, src);
    return src;
  };

  const convertedPages = new Set<number>();
  const imageOnlyPages: number[] = [];
  let droppedRasters = 0;

  const rendered = await transformDocument(raw, {
    mode: options.mode,
    responsive: options.responsive,
    title: basename(document.path),
    rewriteImage,
    onPage: (page) => convertedPages.add(page),
    onImageOnlyPage: (page) => imageOnlyPages.push(page),
    onDroppedRaster: () => {
      droppedRasters += 1;
    },
  });

  await writeFile(join(publishDir, 'index.html'), rendered, 'utf8');
  report({ progress: 85, phase: 'finalizing', message: 'Packaging the page.' });

  const entries: string[] = ['index.html'];
  if (assetsDir) {
    for (const file of (await readdir(assetsDir).catch(() => [])).sort()) entries.push(`assets/${file}`);
  }
  // Stored, not deflated: the caller may re-zip it, and the integration tests read the HTML back out of the archive
  // by searching its bytes, which compressing would prevent.
  await runOrThrow('zip', ['-0', '-q', join(outputDir, 'pdf-to-html.zip'), ...entries], {
    cwd: publishDir,
    timeoutMs: Math.min(runOpts.timeoutMs, 120_000),
    engine: 'zip',
  });

  const warnings: Array<{ code: string; detail?: string }> = [];
  if (options.mode === 'fixed') {
    warnings.push({
      code: 'LAYOUT_APPROXIMATE',
      detail:
        'Text is positioned to match the page, so nothing reflows: a copied paragraph carries the original line breaks.',
    });
  }
  if (droppedRasters > 0) {
    warnings.push({
      code: 'PAGE_RASTER_DROPPED',
      detail: `${droppedRasters} page(s) had vector graphics the reader can only return as a picture; reflow drops it, so use the fixed mode if that art matters.`,
    });
  }
  if (imageOnlyPages.length > 0) {
    warnings.push({
      code: 'IMAGE_ONLY_PAGES',
      detail: `Page(s) ${imageOnlyPages.join(', ')} have no text layer; in this output they are only their images.`,
    });
  }
  if (missingImages.size > 0) {
    warnings.push({
      code: 'IMAGES_MISSING',
      detail: `The converter referenced image(s) it did not write: ${[...missingImages].join(', ')}.`,
    });
  }

  const bytes = (await stat(join(outputDir, 'pdf-to-html.zip'))).size;
  return {
    outputs: [{ name: 'pdf-to-html.zip', mime: 'application/zip', primary: true }],
    metrics: {
      pages: convertedPages.size,
      pagesInDocument: pages,
      pagesConverted,
      mode: options.mode,
      images: inlinedImages + assets,
      inlinedImages,
      assets,
      bytes,
    },
    warnings,
    engine: { name: 'pdftohtml' },
  };
};

interface TransformContext {
  mode: PdfToHtmlOptions['mode'];
  responsive: boolean;
  title: string;
  rewriteImage: (name: string) => Promise<string>;
  onPage: (page: number) => void;
  onImageOnlyPage: (page: number) => void;
  onDroppedRaster: () => void;
}

/**
 * Turn Poppler's export into a page worth opening.
 *
 * The rewrite is textual on purpose: the input is one producer's output with a fixed shape — a page comment, an
 * `<a name>` anchor, a `.ftNN` style block, positioned `<p>` blocks and `<img>`s pointing at sibling files — and a
 * DOM parser would add a dependency for what is otherwise a single process call. The shape is pinned by the golden
 * cases, which fail loudly when a reader upgrade changes it; the alternative is a parser that quietly stops matching
 * and returns the input unchanged.
 */
async function transformDocument(raw: string, ctx: TransformContext): Promise<string> {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ?? raw;
  const styleBlocks = collectStyles(/<head[^>]*>([\s\S]*?)<\/head>/i.exec(raw)?.[1] ?? '');

  const pages: string[] = [];
  for (const match of body.matchAll(/<!-- Page (\d+) -->([\s\S]*?)(?=<!-- Page \d+ -->|$)/g)) {
    const pageNumber = Number.parseInt(match[1] ?? '', 10);
    const fragment = match[2] ?? '';
    if (!Number.isFinite(pageNumber)) continue;
    ctx.onPage(pageNumber);

    // The per-page `.ftNN` rules are lifted out of the body so every rule ends up in the one `<style>` in the head.
    styleBlocks.push(...collectStyles(fragment));
    const items = scanPage(fragment.replace(/<style[\s\S]*?<\/style>/gi, ''));

    const rendered: PageItem[] = [];
    for (const item of items) {
      if (item.kind === 'text') {
        rendered.push(item);
        continue;
      }
      const source = /src="([^"]+)"/i.exec(item.image.attributes)?.[1];
      if (!source || !IMAGE_EXTENSIONS.has(extensionOf(source))) continue;
      if (ctx.mode === 'reflow' && /alt="background image"/i.test(item.image.attributes)) {
        ctx.onDroppedRaster();
        continue;
      }
      const src = await ctx.rewriteImage(source);
      rendered.push({
        kind: 'image',
        image: { attributes: item.image.attributes.replace(/src="[^"]*"/i, `src="${src}"`) },
      });
    }

    const texts = rendered.filter((item): item is { kind: 'text'; block: TextBlock } => item.kind === 'text');
    const images = rendered.filter((item): item is { kind: 'image'; image: ImageItem } => item.kind === 'image');
    if (texts.length === 0 && images.length === 0) continue;
    if (texts.length === 0) ctx.onImageOnlyPage(pageNumber);

    if (ctx.mode === 'fixed') {
      // Poppler's own box is dropped in favour of ours, but its inline width/height is the page size and is kept, as
      // are the blocks' absolute positions — that layout is the whole point of this mode.
      const size = /width:\s*([\d.]+)px;\s*height:\s*([\d.]+)px/i.exec(fragment);
      const style = size ? ` style="width:${size[1]}px;height:${size[2]}px"` : '';
      pages.push(
        [
          `<div class="page fixed" id="page-${pageNumber}"${style}>`,
          ...images.map((item) => `<div class="figure">${item.image.attributes}</div>`),
          ...texts.map((item) => `<p${item.block.attributes}>${item.block.html}</p>`),
          '</div>',
        ].join('\n'),
      );
      continue;
    }

    // Reflow: reading order is top-to-bottom, then left-to-right, and the positioning that expressed the page goes
    // with it. Figures are hoisted to the top of their page because Poppler's own order puts them there and a
    // positioned figure cannot be placed in a flow.
    texts.sort((a, b) => a.block.top - b.block.top || a.block.left - b.block.left);
    pages.push(
      [
        `<section class="page" id="page-${pageNumber}">`,
        ...images.map((item) => `<div class="figure">${item.image.attributes}</div>`),
        ...texts.map(
          (item) => `<p${item.block.className ? ` class="${item.block.className}"` : ''}>${item.block.html}</p>`,
        ),
        '</section>',
      ].join('\n'),
    );
  }

  const viewport = ctx.responsive ? '\n<meta name="viewport" content="width=device-width, initial-scale=1"/>' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(ctx.title)}</title>${viewport}
<style>
${dedupe(styleBlocks).join('\n')}
html, body { background: #f5f5f5; margin: 0; }
body { padding: 16px; }
.container { margin: 0 auto; max-width: 960px; }
.container.wide { margin: 0; max-width: none; }
.page { background: #ffffff; margin: 0 auto 16px; overflow: hidden; }
.page.fixed { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
body.reflow section.page { box-shadow: none; padding: 24px; }
body.reflow p { margin: 0 0 0.6em; }
body.reflow .figure img { max-width: 100%; height: auto; }
</style>
</head>
<body class="${ctx.mode}">
<div class="container${ctx.responsive ? '' : ' wide'}">
${pages.join('\n')}
</div>
</body>
</html>
`;
}

/**
 * Walk a page fragment and return its images and text blocks in document order.
 *
 * Hand-rolled rather than one big regex: `<img>` is self-closing and `<p>` is not, and a pattern that tries to match
 * both at once swallows the following paragraph's text when a converter ever emits an `<img>` without the slash.
 */
function scanPage(fragment: string): PageItem[] {
  const items: PageItem[] = [];
  const tags = /<(img|p)\b([^>]*)>/gi;
  for (let match = tags.exec(fragment); match !== null; match = tags.exec(fragment)) {
    const tag = (match[1] ?? '').toLowerCase();
    const attributes = match[2] ?? '';
    if (tag === 'img') {
      items.push({ kind: 'image', image: { attributes } });
      continue;
    }
    const close = fragment.indexOf('</p>', tags.lastIndex);
    const html = close === -1 ? '' : fragment.slice(tags.lastIndex, close).trim();
    tags.lastIndex = close === -1 ? fragment.length : close + 4;
    // An empty paragraph is Poppler's way of separating blocks; it carries no content.
    if (html.length === 0) continue;
    items.push({
      kind: 'text',
      block: {
        top: numericStyle(attributes, 'top'),
        left: numericStyle(attributes, 'left'),
        attributes,
        className: /class="([^"]+)"/i.exec(attributes)?.[1] ?? '',
        html,
      },
    });
  }
  return items;
}

function collectStyles(fragment: string): string[] {
  const blocks: string[] = [];
  for (const match of fragment.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    // Poppler wraps every stylesheet in an HTML comment, which is not valid CSS.
    const css = (match[1] ?? '').replace(/<!--/g, '').replace(/-->/g, '').trim();
    if (css.length > 0) blocks.push(css);
  }
  return blocks;
}

function numericStyle(attributes: string, property: 'top' | 'left'): number {
  const style = /style="([^"]*)"/i.exec(attributes)?.[1] ?? '';
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(-?[\\d.]+)px`, 'i').exec(style);
  return match ? Number.parseFloat(match[1]!) : 0;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function mimeFor(name: string): string {
  switch (extensionOf(name)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/png';
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function ensure(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}
