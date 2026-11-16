import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { HtmlToPdfOptions } from '@pdftools/contracts/tools';
import { buildQpdfPagesArgs, pythonOrThrow, qpdfOrThrow, sofficeOrThrow } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import {
  type Handler,
  type OutputDescriptor,
  describeRemoteReferences,
  findRemoteReferencesInCss,
  findRemoteReferencesInHtml,
} from '@pdftools/worker-shared';

/**
 * `html-to-pdf` — `docs/07-OFFICE-TO-PDF.md`.
 *
 * LibreOffice renders HTML (Writer/Web), and its **`--convert-to` filter carries no page geometry**: there is no
 * filter-data key for paper size, orientation or margins, so a handler that just shells out produces A4 portrait
 * whatever the caller asked for. The geometry is therefore applied the only way the engine understands — by
 * **injecting a `@page` rule into the HTML before conversion**, which LibreOffice's CSS import honours. Verified
 * against the engine before this was designed around: `@page { size: A4 landscape; margin: 25mm }` moves the output
 * MediaBox from 595.3 × 841.9 to 841.9 × 595.3, and a 40 mm margin puts the first text run at x = 113.5 pt, which is
 * 40 mm.
 *
 * Two consequences of that decision, both deliberate:
 *
 *  1. **The injected rule goes first in `<head>`,** so a document that sets its own `@page` wins by the cascade. A
 *     caller's explicit CSS outranks our default; the option is a default, not an override.
 *  2. **A missing `<meta charset>` is supplied.** The file is read and rewritten as UTF-8; without the meta tag
 *     LibreOffice guesses, and a guess is how perfectly good accents become mojibake in the output.
 *
 * `printBackground: false` is **accepted and reported as unhonoured**, which is a deliberate third decision. The
 * obvious implementation — inject `* { background: transparent !important }` last in the document — was measured and
 * does not work: a red-bodied page produced `1 0 0 rg` in the content stream with the rule and without it, because
 * LibreOffice's Writer/Web import prints page backgrounds unconditionally and the setting that controls it is a
 * document property with no CLI surface. Silently ignoring the flag would make the tool lie about its own output, so
 * the job succeeds and carries `BACKGROUNDS_NOT_SUPPRESSED` — and the golden case asserts that warning, so nobody
 * can remove it by "cleaning up" an option that appears to do nothing.
 *
 * A ZIP bundle is extracted with Python's `zipfile` (there is no `unzip` in this image), with an explicit guard
 * against a member whose path escapes the extraction directory and two bounds read from the archive's own central
 * directory before a byte is written — 2 000 entries and 200 MB expanded, the limits `docs/07-OFFICE-TO-PDF.md` §6
 * documents. The second is the one that matters: a zip bomb is a small upload whose *expansion* is enormous, so a
 * limit checked after extraction is a limit checked too late. Extraction preserves the tree, which is what makes a
 * bundle's *relative* asset paths resolve — the thing a naive "unzip and grab the HTML" loses.
 *
 * **References that are not inside the document are refused rather than resolved.** Measured before the guard was
 * written: `<img src="http://127.0.0.1:9911/x.png">` makes LibreOffice issue a real request during `--convert-to`,
 * so a document that names a URL is a request this service would otherwise make on a stranger's behalf — the
 * request-proxy behaviour `docs/0-SECURITY.md` §7 says does not happen. The same applies to an absolute path: the
 * engine runs inside the job directory as its own user, and `file:///…` or `/etc/…` names a file the caller never
 * uploaded. Both are refused with the reference named, so the caller can host the asset beside the HTML instead of
 * receiving a document with a silent hole where the image should be (`findRemoteReferencesInHtml`).
 *
 * **What a future engine has to keep true.** This tool ships on LibreOffice's HTML import, which has no JavaScript
 * runtime at all, so a `<script>` in a document is inert here by the engine's nature rather than by any setting this
 * handler makes. The plan for this tool once named a Chromium print pipeline, and a Chromium-backed implementation
 * **must** disable scripting explicitly (`page.setJavaScriptEnabled(false)`, or the equivalent for whatever drives it)
 * — plus its own network interception, because a browser fetches what a document asks for far more willingly than
 * this importer does. Two stages are the contract for that swap, and neither is optional: `test:isolation` leg 5
 * (`scripts/ci/isolation.ts`) measures a conversion that produces a PDF with the document's beacon never arriving,
 * and `e2e/browser/script-inert.e2e.ts` shows that same script really firing in a browser and asserts which engine
 * ran the job — so a swap fails there, by name, instead of quietly turning a measured silence into an assumption.
 */

/**
 * Paper sizes in millimetres, portrait order — and **explicit dimensions, not the CSS `@page` size keywords**.
 *
 * Every part of that was measured against the engine rather than assumed, and each measurement removed a spelling
 * that looked correct:
 *
 *   * `@page { size: A3 }` is valid CSS and LibreOffice ignores the size — `A3` and `A3 portrait` both produced A4
 *     (595.3 × 841.9), while `297mm 420mm` produced A3 (841.9 × 1190.6). `A4` only appeared to work because A4 is
 *     the engine's default, which is exactly the false positive that would have shipped a page-size option wired to
 *     nothing. Letter (`215.9mm 279.4mm` → 612 × 792) and legal (`215.9mm 355.6mm` → 612 × 1008) are honoured the
 *     same way.
 *   * `@page { size: A3 landscape }` yields A4 **landscape** (841.9 × 595.3): the orientation keyword is applied
 *     while the size is still discarded. Silent wrong paper, right way round.
 *   * `@page { size: 210mm 297mm landscape }` — the natural way to write "A4 landscape" — is *invalid* CSS:
 *     `<page-size> || <orientation>` only accepts the keyword form, so the whole declaration is dropped and the
 *     output is A4 portrait. The orientation is therefore expressed by **swapping the two lengths**, which is the
 *     `size: <length>{1,2}` form the grammar does allow.
 */
const PAGE_SIZE_MM: Record<string, [number, number]> = {
  a4: [210, 297],
  a3: [297, 420],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
};

/** The paper sizes the option enum names, in points — used for the post-conversion check. */
const PAGE_SIZE_PT: Record<string, [number, number]> = {
  a4: [595.276, 841.89],
  a3: [841.89, 1190.551],
  letter: [612, 792],
  legal: [612, 1008],
};

/** Tolerance for the geometry check: LibreOffice's own A4 is 595.304 where the standard figure is 595.276. */
const GEOMETRY_TOLERANCE_PT = 3;

export const htmlToPdf: Handler<HtmlToPdfOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const warnings: Array<{ code: string; detail?: string }> = [];
  const outputs: OutputDescriptor[] = [];
  let engineStderr = '';

  // Inside `workDir`, for the reason `office-to-pdf` documents: only `input/`, `work/`, `tmp/`, `home/` and `output/`
  // are cleaned up, so a profile left at `jobDir/` accumulates on the shared volume forever.
  const profileDir = join(workDir, 'lo-profile');
  await mkdir(profileDir, { recursive: true });
  const preparedDir = join(workDir, 'prepared');
  await mkdir(preparedDir, { recursive: true });
  const convertDir = join(workDir, 'converted');
  await mkdir(convertDir, { recursive: true });

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const entries: string[] = [];
  for (const [index, file] of files.entries()) {
    report({
      progress: 10 + Math.round((index / files.length) * 50),
      phase: 'processing',
      message: `Preparing ${index + 1} of ${files.length}.`,
    });
    entries.push(await prepare(file.path, file.kind ?? '', join(preparedDir, `source-${index}`), options, runOpts));
  }

  // The prepared copies are what the engine is handed, so this is the last point at which a reference can be refused
  // before a fetch would be attempted — and it covers the inline styles and the extracted stylesheets of a bundle,
  // not only the entry document.
  const blocked = await collectRemoteReferences(entries);
  if (blocked.length > 0) {
    throw new JobFailure('REMOTE_RESOURCES_BLOCKED', { message: describeRemoteReferences(blocked) });
  }

  for (const [index, entry] of entries.entries()) {
    report({
      progress: 60 + Math.round((index / entries.length) * 25),
      phase: 'processing',
      message: `Rendering ${index + 1} of ${entries.length}.`,
    });
    const result = await sofficeOrThrow(
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        '--invisible',
        `-env:UserInstallation=file://${profileDir}`,
        // Named explicitly: `writer_pdf_Export` is also what a plain `.html` gets by extension, but naming the filter
        // is what keeps a `.zip`-adjacent or extension-less input from being routed to a different importer.
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        convertDir,
        entry,
      ],
      runOpts,
    );
    engineStderr = result.stderr || engineStderr;
  }

  const produced = (await readdir(convertDir)).filter((name) => name.toLowerCase().endsWith('.pdf')).sort();
  if (produced.length === 0) {
    // `soffice` exits 0 while reporting failure on stderr, so the exit code is not the signal — the reason
    // `office-to-pdf`'s defect 26 is documented. The engine's message is attached rather than used as the trigger,
    // because a warning on stderr (LibreOffice warns about the missing JRE here) must not fail a job whose output is
    // on disk.
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'LibreOffice produced no PDF output from the HTML.',
      ...(engineStderr ? { stderrTail: engineStderr } : {}),
    });
  }

  const target = join(outputDir, 'rendered.pdf');
  if (produced.length === 1) {
    await rename(join(convertDir, produced[0]!), target);
  } else {
    // One `--pages` group holding every file, through the builder shared with `merge`: repeating the flag per input
    // is the mistake that made a two-file conversion produce nothing in `office-to-pdf`.
    await qpdfOrThrow(
      buildQpdfPagesArgs(
        produced.map((file) => ({ path: join(convertDir, file) })),
        target,
      ),
      runOpts,
    );
  }
  outputs.push({ name: 'rendered.pdf', mime: 'application/pdf', primary: true });

  report({ progress: 90, phase: 'processing', message: 'Checking the page geometry.' });
  const geometry = await readGeometry(target, runOpts);
  const expected = PAGE_SIZE_PT[options.pageSize]!;
  const wanted: [number, number] = options.landscape ? [expected[1], expected[0]] : expected;
  if (geometry) {
    const [width, height] = geometry;
    if (Math.abs(width - wanted[0]) > GEOMETRY_TOLERANCE_PT || Math.abs(height - wanted[1]) > GEOMETRY_TOLERANCE_PT) {
      // A warning rather than a failure: a document that sets its own `@page` legitimately overrides the injected
      // default, and refusing that job would be refusing something the user asked for. It is reported because the
      // alternative — silently returning A4 for a `landscape: true` job — is the failure this check exists for.
      warnings.push({
        code: 'PAGE_SIZE_NOT_APPLIED',
        detail: `The first page is ${width.toFixed(1)} × ${height.toFixed(1)} pt, not the requested ${wanted[0]} × ${wanted[1]} pt. The document's own @page rule takes precedence over the injected one.`,
      });
    }
  } else {
    warnings.push({
      code: 'PAGE_SIZE_UNVERIFIED',
      detail: 'The output page size could not be read back, so the requested paper size is unconfirmed.',
    });
  }

  if (!options.printBackground) {
    warnings.push({
      code: 'BACKGROUNDS_NOT_SUPPRESSED',
      detail:
        'LibreOffice prints CSS backgrounds unconditionally, and this build has no second renderer, so the output keeps them. Nothing was removed; the flag is accepted so a caller migrating from another tool does not have to change its request.',
    });
  }

  report({ progress: 97, phase: 'finalizing' });
  return {
    outputs,
    metrics: {
      sourceFiles: files.length,
      // Named for what happened rather than what was asked: the flag cannot suppress them on this engine.
      backgroundsSuppressed: false,
      pageSize: options.pageSize,
      landscape: options.landscape,
      marginMm: options.marginMm,
      firstPage: geometry ? { widthPt: geometry[0], heightPt: geometry[1] } : null,
    },
    warnings,
    engine: { name: 'libreoffice' },
  };
};

/**
 * Every reference in the prepared documents (and in the stylesheets beside them) that the renderer would have to
 * fetch, in one list.
 *
 * Reading the *prepared* files rather than the uploads is deliberate: a bundle is only extracted here, so this is
 * the first moment its `assets/` directory and its relative paths exist to be judged, and the prepared copy is
 * exactly the byte sequence the engine receives.
 */
async function collectRemoteReferences(entries: string[]): Promise<ReturnType<typeof findRemoteReferencesInHtml>> {
  const found: ReturnType<typeof findRemoteReferencesInHtml> = [];
  for (const entry of entries) {
    found.push(...findRemoteReferencesInHtml(await readFile(entry, 'utf8').catch(() => '')));
    // The whole extracted tree, not just the entry's own directory: a bundle's stylesheet is as likely to live in
    // `styles/` as beside the page, and a `url(http://…)` inside it is the same fetch as one in an attribute.
    for (const file of await listFiles(dirname(entry))) {
      if (!/\.css$/i.test(file)) continue;
      const css = await readFile(join(dirname(entry), file), 'utf8').catch(() => '');
      found.push(...findRemoteReferencesInCss(css, basename(file)));
    }
  }
  return found;
}

/** Every file under `root`, as paths relative to it. Bounded by the extraction directory, which the handler owns. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(path)) files.push(join(entry.name, nested));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

/**
 * One input file, turned into an HTML file that carries the requested geometry.
 *
 * The `@page` rule is injected at the **start** of `<head>` so the document's own rule wins; when there is no `<head>`
 * the block goes at the very top, because a browser and LibreOffice both accept a `<style>` before `</head>`/`<body>`
 * content and neither accepts a `@page` rule that appears after the content it describes.
 */
async function prepare(
  path: string,
  kind: string,
  targetDir: string,
  options: HtmlToPdfOptions,
  runOpts: Parameters<typeof pythonOrThrow>[2],
): Promise<string> {
  const isZip = kind.includes('zip') || path.toLowerCase().endsWith('.zip');
  let source = path;
  let name = basename(path);

  if (isZip) {
    await mkdir(targetDir, { recursive: true });
    const result = await pythonOrThrow(EXTRACT_SCRIPT, { zip: path, dest: targetDir }, runOpts);
    const parsed = parseLastLine(result.stdout) as { entries?: string[]; error?: string };
    if (parsed.error) {
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message: `The bundle could not be extracted: ${parsed.error}`,
      });
    }
    const htmlEntries = (parsed.entries ?? []).filter((entry) => /\.html?$/i.test(entry));
    if (htmlEntries.length === 0) {
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message: 'The bundle contains no HTML file. Include an `index.html` beside its assets.',
      });
    }
    // `index.html` at the shallowest depth wins, then the shallowest, then alphabetical — a bundle with a landing
    // page and several chapters has an unambiguous entry point, and one without still gets a deterministic choice.
    const chosen = htmlEntries.sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0]!;
    source = join(targetDir, chosen);
    name = basename(chosen);
  }

  const html = await readFile(source, 'utf8');
  const prepared = join(targetDir, name);
  await mkdir(targetDir, { recursive: true });
  // The geometry is carried in the file, not in the process: a worker runs several jobs concurrently, so anything
  // shared between calls here would hand one job's paper size to another.
  await writeFile(prepared, inject(html, options), 'utf8');
  return prepared;
}

/** Lower sorts first: an `index.html` is preferred, then the fewest directories, then the shortest name. */
function score(entry: string): number {
  const depth = entry.split('/').length - 1;
  const isIndex = /(^|\/)index\.html?$/i.test(entry) ? 0 : 1;
  return isIndex * 100 + depth;
}

/** The injected rules, as described in the header comment. Pure: the same HTML and options always give the same file. */
function inject(html: string, options: HtmlToPdfOptions): string {
  const [short, long] = PAGE_SIZE_MM[options.pageSize] ?? PAGE_SIZE_MM.a4!;
  const size = options.landscape ? `${long}mm ${short}mm` : `${short}mm ${long}mm`;
  const geometry = [
    '<style data-pdftools="page">',
    `@page { size: ${size}; margin: ${options.marginMm}mm; }`,
    '</style>',
  ].join('');
  const charset = /<meta[^>]+charset/i.test(html) ? '' : '<meta charset="utf-8">';
  const opening = charset + geometry;
  // Only the geometry is injected. There is deliberately no background rule here: it was measured to have no effect
  // on this engine (see the file header), and a rule that does nothing is worse than no rule — it reads as a feature
  // in review and leaves a real gap in the product.
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (match) => match + opening) : `${opening}${html}`;
}

/** The first page's `MediaBox`, read with pikepdf — the engine check for the geometry options. */
async function readGeometry(
  path: string,
  runOpts: Parameters<typeof pythonOrThrow>[2],
): Promise<[number, number] | null> {
  const result = await pythonOrThrow(GEOMETRY_SCRIPT, { input: path }, runOpts).catch(() => null);
  if (!result) return null;
  const parsed = parseLastLine(result.stdout) as { width?: number; height?: number };
  return typeof parsed.width === 'number' && typeof parsed.height === 'number' ? [parsed.width, parsed.height] : null;
}

/** The last line of stdout, parsed — engine warnings are free to occupy the lines above it. */
function parseLastLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new JobFailure('CONVERSION_FAILED', {
      message: 'The helper step did not report its result as JSON.',
      stderrTail: stdout.slice(-400),
    });
  }
}

const EXTRACT_SCRIPT = `
import json, os, sys, zipfile

# The two bounds are the archive half of the input limits in docs/07-OFFICE-TO-PDF.md §6, and they are enforced
# against the archive's own declarations *before* anything is written: a zip bomb is a small upload whose expanded
# size is enormous, so a limit applied after extraction is a limit applied too late. file_size is the uncompressed
# size the central directory advertises, which is what a bomb lies about in the opposite direction (it under-declares
# in the local header, but this reads the central directory).
MAX_ENTRIES = 2000
MAX_EXPANDED_BYTES = 200 * 1024 * 1024

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
dest = payload['dest']
entries = []
try:
    with zipfile.ZipFile(payload['zip']) as archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES:
            print(json.dumps({'error': 'the archive holds %d entries; the limit is %d' % (len(members), MAX_ENTRIES)}))
            sys.exit(0)
        declared = sum(info.file_size for info in members)
        if declared > MAX_EXPANDED_BYTES:
            print(json.dumps({'error': 'the archive expands to %d bytes; the limit is %d' % (declared, MAX_EXPANDED_BYTES)}))
            sys.exit(0)
        for info in members:
            target = os.path.realpath(os.path.join(dest, info.filename))
            root = os.path.realpath(dest) + os.sep
            # A member named ../../etc/passwd is the classic archive escape; refusing it here is cheaper than
            # auditing every later path join.
            if not target.startswith(root):
                print(json.dumps({'error': 'the archive contains a path outside the extraction directory: ' + info.filename}))
                sys.exit(0)
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(info) as source, open(target, 'wb') as handle:
                handle.write(source.read())
            entries.append(info.filename)
    print(json.dumps({'entries': entries}))
except Exception as failure:
    print(json.dumps({'error': str(failure)}))
`;

const GEOMETRY_SCRIPT = `
import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
pdf = pikepdf.open(payload['input'])
box = [float(value) for value in pdf.pages[0].MediaBox]
print(json.dumps({'width': box[2] - box[0], 'height': box[3] - box[1], 'pages': len(pdf.pages)}))
`;
