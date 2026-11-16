import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { config } from '@pdftools/config';
import { escapePostScriptText } from './overlay';
import { run } from './run';

/**
 * The PDF/A output intent — the step that makes `-dPDFA` mean anything.
 *
 * **`gs -dPDFA=1` on its own does not produce a PDF/A file.** It sets the document's XMP to declare
 * `pdfaid:part`, and that is all: the archival *output intent* (an `/OutputIntents` array pointing at an embedded ICC
 * profile with `/S /GTS_PDFA1`) is contributed by a **PostScript preamble the caller has to supply**, the way
 * Ghostscript's own `PDFA_def.ps` does. A file with the XMP and no intent claims conformance it does not have, and
 * nothing in the PDF itself reveals that — the claim and the fact are in different objects.
 *
 * That is why this module exists rather than a couple of flags in the handler, and why it is here in `engines` beside
 * the other argument builders: what Ghostscript needs is engine knowledge, and it is knowledge that is invisible in
 * the command line. Two further details come from the same source and are equally easy to miss:
 *
 *  1. **The preamble must be able to read the ICC profile**, which since Ghostscript 9.50 means an explicit
 *     `--permit-file-read=<profile>` on the command line. Without it the read is refused, the preamble prints that it
 *     aborted, and the job *succeeds* with no intent — the exact silent outcome this module is here to prevent.
 *  2. **The profile it embeds has to be the space the content ends up in.** `forceSrgb` picks sRGB, and the caller's
 *     remaining choice is deliberately kept: the intent is written either way, because PDF/A requires one, and a job
 *     that leaves colours unconverted still has to say which space its intent names.
 */

/** Where the preamble is written inside a job's work directory. Fixed name so a failed job can be inspected. */
export const PDFA_INTENT_FILENAME = 'pdfa-output-intent.ps';

export interface PdfaOutputIntent {
  /** Absolute path of the ICC profile to embed. */
  profilePath: string;
  /** Components in that profile (3 for sRGB, 4 for CMYK) — `/N` in the embedded stream. */
  components: 3 | 4;
  /** The human-readable space name stamped into the intent (`/OutputConditionIdentifier`). */
  conditionIdentifier: string;
}

/**
 * The ICC profiles this build is willing to embed, per colour strategy.
 *
 * `default_cmyk.icc` rather than a print profile: it ships with Ghostscript, it is what a CMYK intent for
 * "leave the colours alone" can honestly name, and a real print pipeline would supply its own. The file names are
 * Ghostscript's, and the directory they live in carries the version (`…/ghostscript/10.05.1/iccprofiles/`), which is
 * why the lookup discovers it rather than hard-coding it.
 */
const PROFILES = {
  rgb: { file: 'srgb.icc', components: 3 as const, conditionIdentifier: 'sRGB' },
  cmyk: { file: 'default_cmyk.icc', components: 4 as const, conditionIdentifier: 'CMYK' },
};

const GHOSTSCRIPT_SHARE = '/usr/share/ghostscript';

/** Every `iccprofiles` directory a Ghostscript installation in this image may keep, newest version first. */
async function iccProfileDirs(): Promise<string[]> {
  const dirs: string[] = [];
  try {
    const versions = (await readdir(GHOSTSCRIPT_SHARE)).sort().reverse();
    for (const version of versions) dirs.push(join(GHOSTSCRIPT_SHARE, version, 'iccprofiles'));
  } catch {
    // No `/usr/share/ghostscript` at all: the configured profile path is then the only answer, and the caller
    // reports the absence rather than guessing.
  }
  dirs.push('/usr/share/color/icc');
  return dirs;
}

/**
 * The profile to embed for a colour strategy, or `null` when none can be found.
 *
 * `ENGINE_GS_ICC_PROFILE` wins when set, so a deployment with its own colour profile does not have to patch an image.
 * Returning `null` rather than falling back to "no intent" is the whole point: the caller fails the job, because a
 * PDF/A file without an output intent is not a PDF/A file.
 */
export async function findPdfaProfile(forceSrgb: boolean): Promise<PdfaOutputIntent | null> {
  const wanted = forceSrgb ? PROFILES.rgb : PROFILES.cmyk;

  const configured = config.engines.ghostscriptIccProfile;
  if (configured) {
    return { ...wanted, profilePath: configured };
  }

  for (const dir of await iccProfileDirs()) {
    for (const name of [wanted.file, forceSrgb ? 'default_rgb.icc' : 'default_cmyk.icc']) {
      const candidate = join(dir, name);
      try {
        await stat(candidate);
        return { ...wanted, profilePath: candidate };
      } catch {
        // Try the next candidate; a profile-less installation is a real state and is reported by the caller.
      }
    }
  }
  return null;
}

/**
 * The preamble, as PostScript.
 *
 * Adapted from Ghostscript's own `PDFA_def.ps`, which is the reference for this object graph — but written out here
 * rather than consumed from the image, for two reasons that both came from running it: the sample's `/ICCProfile`
 * defaults to `srgb.icc` **in the current directory** (which is the job's work directory, so it never resolves), and
 * the sample derives `/N` from `ColorConversionStrategy`, printing a warning and falling back to `ProcessColorModel`
 * for anything that is not a device space. `/N` here is the profile's own component count, which is a fact rather
 * than an inference.
 *
 * The path is interpolated through `escapePostScriptText` (the same escaper the overlay pipeline uses): inside a
 * PostScript `( … )` literal, a backslash or an unbalanced paren ends the string early, and the failure that follows
 * — a Ghostscript syntax error — names neither the path nor the real cause.
 *
 * The failure branch is not decoration: if the profile cannot be read the program says so and clears the stack rather
 * than raising, because a Ghostscript error would surface as a corrupt output file while the interesting fact — that
 * no intent was written — would not.
 */
/**
 * What a document names, measured rather than assumed — the input to an honest `changes` list.
 *
 * The tool's promise in `docs/09-PDF-A.md` §1 is to "report exactly what had to change", and until this module existed
 * it reported the same three entries for every document: `FONT_EMBEDDED`, `IMAGE_DOWNSAMPLED` and `XMP_REWRITTEN`,
 * regardless of whether the input had a missing font program or an image above 300 dpi. A change list that does not
 * depend on the document is not a report — a text-only file with every font embedded was told that nine images had
 * been reduced from 600 dpi, and a caller reading that has been told something false about their own archive.
 *
 * So both censuses read the document: `pdffonts` for the font programs, `pdfimages -list` for the embedded images'
 * resolution. Both are poppler, both are in the heavy image (and both are in `engineCheckList`, so an image without
 * them fails at boot rather than reporting a guess), and `null` means the reader could not be run at all — which the
 * caller reports instead of substituting a zero for.
 */
export interface FontCensus {
  /** Font references the document names, including repeats across pages. */
  total: number;
  /** Those whose font program is **not** in the file — what the embed pass exists to fix and a validator refuses. */
  notEmbedded: number;
  /** Those a reader has to substitute (`sub=yes`): the family named is not the family that will be used. */
  substituted: number;
}

/**
 * The fonts of a document, read from the file.
 *
 * The column positions are read from the **end** of the row rather than from a header offset, and that is not laziness:
 * `pdffonts` prints the font name as one column, but a name containing a space (or a subset prefix with a space in the
 * family) shifts everything to its right. Counting from the end is the only reading that survives a font name of any
 * shape — and the count is five, not three, because the trailing `object ID` is **two** tokens (number and
 * generation). Getting that off by two was not hypothetical: the first version read the `uni` column as `emb`, which
 * is why a delivered file with every font embedded reported one font without a program, and the golden case that
 * asserts a font was embedded is what caught it.
 */
export async function censusFonts(path: string, opts: { cwd: string; timeoutMs?: number }): Promise<FontCensus | null> {
  const result = await run('pdffonts', [path], {
    engine: 'pdffonts',
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  if (result.code !== 0) return null;
  return parseFontCensus(result.stdout);
}

/**
 * The census of a `pdffonts` table, split out from the run so the reading is testable without an engine.
 *
 * A parser beside the command is the shape this repository uses for engine output everywhere else (`parseJsonLine`),
 * and it is the only part of the census a unit test can hold: the columns are positional, the table carries a header
 * and a rule under it, and a font family with a space in its name shifts every column that follows.
 */
export function parseFontCensus(stdout: string): FontCensus {
  const census: FontCensus = { total: 0, notEmbedded: 0, substituted: 0 };
  for (const line of stdout.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 5) continue;
    // A data row ends in `object ID` — the object number and its generation, both integers. Requiring them is what
    // separates a row from the header and the rule under it, and it is also what makes the offset from the end right:
    // `emb`, `sub`, `uni` are the three columns immediately before those two.
    if (!/^\d+$/.test(cells[cells.length - 1]!) || !/^\d+$/.test(cells[cells.length - 2]!)) continue;
    const embedded = cells[cells.length - 5];
    const substituted = cells[cells.length - 4];
    if (embedded !== 'yes' && embedded !== 'no') continue;
    census.total += 1;
    if (embedded === 'no') census.notEmbedded += 1;
    if (substituted === 'yes') census.substituted += 1;
  }
  return census;
}

export interface ImageCensus {
  /** Embedded raster images in the document. */
  total: number;
  /** Those whose horizontal or vertical resolution is above `dpi` — what the normalising pass actually reduces. */
  aboveDpi: number;
  /** The highest resolution in the document, or 0 when there is no image. Reported so "above 300 dpi" has a number. */
  maxDpi: number;
}

/**
 * The images of a document, and how many are above the resolution the pipeline normalises to.
 *
 * `pdfimages -list` reports x/y ppi per image and these are the last two numeric columns before `size` and `ratio`,
 * which is why the parse counts from the end — the same reason as `censusFonts`, and the same shape OCR's
 * `measureDpi` uses (`workers/ocr/src/handlers/ocr.ts`).
 *
 * The threshold is inclusive of "the pass will touch it" rather than "the pass should touch it": the Ghostscript pass
 * is given `-d*ImageDownsampleThreshold=1.0`, so an image above 300 dpi **is** reduced and one at or below it is not.
 * Without that flag Ghostscript's default 1.5 threshold would leave a 400 dpi image alone while this census counted it
 * as downsampled — a report that disagrees with the engine, which is the same class of defect as the fixed list this
 * module replaced.
 */
export async function censusImages(
  path: string,
  opts: { cwd: string; timeoutMs?: number; dpi?: number },
): Promise<ImageCensus | null> {
  const dpi = opts.dpi ?? 300;
  const result = await run('pdfimages', ['-list', path], {
    engine: 'pdfimages',
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  if (result.code !== 0) return null;
  return parseImageCensus(result.stdout, dpi);
}

/** The census of a `pdfimages -list` table against a threshold, split out for the same reason `parseFontCensus` is. */
export function parseImageCensus(stdout: string, dpi = 300): ImageCensus {
  const census: ImageCensus = { total: 0, aboveDpi: 0, maxDpi: 0 };
  for (const line of stdout.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 6) continue;
    // A data row starts with the page number and the image number, both integers; the header starts with `page` and
    // the rule with `---`. Anything else is a warning line the tool printed alongside its table.
    if (!/^\d+$/.test(cells[0]!) || !/^\d+$/.test(cells[1]!)) continue;
    const xPpi = Number.parseFloat(cells[cells.length - 4] ?? '');
    const yPpi = Number.parseFloat(cells[cells.length - 3] ?? '');
    if (!Number.isFinite(xPpi) || !Number.isFinite(yPpi)) continue;
    census.total += 1;
    const highest = Math.max(xPpi, yPpi);
    census.maxDpi = Math.max(census.maxDpi, highest);
    if (highest > dpi) census.aboveDpi += 1;
  }
  return census;
}

/**
 * Whether the file really carries the intent the preamble asked for.
 *
 * The preamble can fail while the job succeeds — twice over, and neither failure sets an exit code:
 *
 *  1. Ghostscript refuses to read a file it was not explicitly permitted to read, so the preamble prints its
 *     message and clears the stack, leaving a document with the XMP claim and no intent.
 *  2. At PDF/A-2 and PDF/A-3, `pdfwrite` refuses device-independent colour outright — `cannot guarantee creating a
 *     conformant PDF/A-2 file with device-independent colour … reverting to normal output` — and processes each page
 *     in normal mode. Measured: the intent and the `pdfaid` claim still land, so the file stays archival, but the
 *     conversion the caller asked for did not happen.
 *
 * Both are only visible in the file, which is why this reads one. It searches the raw bytes **and** the inflated object
 * streams, and that is not defensive coding: PDF/A-1 is PDF 1.4, where object streams do not exist and the intent is
 * plain bytes, while PDF/A-2 and -3 are PDF 1.7 and Ghostscript compresses the intent dictionary into a
 * `/Type /ObjStm` stream. A raw-byte search therefore reports exactly the files this tool exists to produce as missing
 * their intent — which is how the golden suite first read a correct PDF/A-2 output as a defect.
 *
 * Three facts are required rather than one because each is a separate part of the same object: the intent's subtype
 * (`/S /GTS_PDFA1`), the embedded profile stream (`/DestOutputProfile`), and the catalog entry that makes it the
 * document's intent (`/OutputIntents`).
 */
export function hasPdfaOutputIntent(bytes: Uint8Array): boolean {
  const raw = Buffer.from(bytes).toString('latin1');
  const haystack = [raw, ...inflatedStreams(raw)].join('\n');
  return (
    haystack.includes('GTS_PDFA1') && haystack.includes('DestOutputProfile') && haystack.includes('/OutputIntents')
  );
}

/**
 * The `pdfaid:part` the file's own XMP declares, read out of the bytes — or `null` when it declares none.
 *
 * The second half of the same claim `hasPdfaOutputIntent` covers, and the half a byte scan is most likely to miss: an
 * archival file's identification lives in the XMP packet, which for PDF/A-2 and -3 sits in a compressed object stream.
 * Searching the raw bytes alone therefore reports a correct PDF/A-2 as unidentified — the same trap, in the same
 * file, as the one the intent check was written for, which is why both searches share `inflatedStreams`.
 *
 * What it does **not** do is decide which levels are acceptable: it returns the digit it found so the caller can
 * compare it with the level it asked for, because "this file declares PDF/A-2" and "this file declares the PDF/A-2 I
 * requested" are different sentences and only the second one is the promise (`-dPDFA` mapping bug: a request for
 * PDF/A-3 was once answered by a file whose own XMP said `part='2'`).
 */
export function readPdfaClaim(bytes: Uint8Array): { part: string; conformance: string | null } | null {
  const raw = Buffer.from(bytes).toString('latin1');
  const haystack = [raw, ...inflatedStreams(raw)].join('\n');
  // Both spellings of the same property: an attribute on `rdf:Description` (Ghostscript's writer, and Adobe's) and an
  // element (LibreOffice's) — the reader is used on other people's files too (`docs/09-PDF-A.md` §4.1).
  const part = /pdfaid:part['"]?\s*(?:=|[<>])\s*['"]?(\d)/i.exec(haystack)?.[1];
  if (!part) return null;
  const conformance = /pdfaid:conformance['"]?\s*(?:=|[<>])\s*['"]?([ABU])/i.exec(haystack)?.[1]?.toUpperCase() ?? null;
  return { part, conformance };
}

/**
 * Every Flate-compressed stream body in the file, inflated.
 *
 * Bodies are delimited by `stream`/`endstream`, and each body is tried at three lengths because the newline before
 * `endstream` is excluded from `/Length` while deflate refuses a stray trailing byte. `/Length` is deliberately not
 * used: Ghostscript writes it as an indirect reference (`/Length 8 0 R`), so there is no usable number in the
 * dictionary this walks. The marker regex is built per call rather than shared, because a global regex carries
 * `lastIndex` between calls and this loop can exit early.
 */
function inflatedStreams(raw: string): string[] {
  const out: string[] = [];
  const marker = /\bstream\r?\n/g;

  let match = marker.exec(raw);
  while (match) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;

    const body = Buffer.from(raw.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    for (const length of [body.length, body.length - 1, body.length - 2]) {
      if (length <= 0) continue;
      try {
        out.push(inflateSync(body.subarray(0, length)).toString('latin1'));
        break;
      } catch {
        // Try one byte shorter; a body that never inflates contributes nothing.
      }
    }

    marker.lastIndex = end + 'endstream'.length;
    match = marker.exec(raw);
  }

  return out;
}

export function buildPdfaOutputIntent(intent: PdfaOutputIntent): string {
  return `%!
% Written per job by pdf-tools (packages/engines/src/pdfa.ts). The PDF/A output intent.
/ICCProfile (${escapePostScriptText(intent.profilePath)}) def
[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark
[{icc_PDFA} << /N ${intent.components} >> /PUT pdfmark
[{icc_PDFA} {ICCProfile (r) file} stopped
  {
    cleartomark
    (PDF/A: the ICC profile could not be read, so no output intent was written.\\n) print
  }
  {
    /PUT pdfmark
  }
ifelse
[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark
[{OutputIntent_PDFA} <<
  /Type /OutputIntent
  /S /GTS_PDFA1
  /DestOutputProfile {icc_PDFA}
  /OutputConditionIdentifier (${escapePostScriptText(intent.conditionIdentifier)})
>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark
`;
}
