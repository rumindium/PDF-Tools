import { spawn } from 'node:child_process';
import { repoRootFrom } from './pdf-inspect';

/**
 * Rendering a page, for the assertions that are about *where* something landed.
 *
 * Every other check in this harness reads structure — page objects, page counts, dictionaries, extracted text — and
 * structure cannot see placement. Content painted on top of the wrong page, or off the page, or mirrored, still
 * extracts, still counts as a page, and still contains every byte an assertion looks for. That is why the `n-up`
 * rotation bug passed its own suite while producing sheets with one page in four outside the printable area, and why
 * the status document has carried "no renderer in the harness" as a gap since placement work started.
 *
 * The renderer is Poppler, already in the light worker image, invoked through the same `docker compose exec` bridge
 * the text checks use. Output is `-gray` PGM (`P5`): one byte per pixel, 0 = black, no decoder needed on this side.
 *
 * **The spawn is `node:child_process`'s, not `Bun.spawn`'s, and that is a measured requirement rather than a style.**
 * The browser stage calls this reader too — a signature is placed *somewhere*, and only a render can say whether it
 * landed in the box the canvas drew — and Playwright runs its workers under Node even when the command was `bun run
 * test:browser`: measured in a worker, `typeof Bun` is `undefined`, so the spawn threw, the catch below returned
 * `null`, and a case failed with "no renderer is reachable" on a stack that was up. `node:child_process` is implemented
 * by Bun as well, so one spelling serves both runners — the same conversion `pdfPageTexts` already records.
 *
 * **At 72 dpi one pixel is one point**, which is what makes a region expressible in points: the caller passes the same
 * coordinates the job was given, and the mapping is an integer round trip plus the vertical flip between PDF user
 * space (origin bottom-left) and a raster (origin top-left). Two roundings of at most half a pixel are the only
 * inexactness in the comparison, which is why the thresholds below are shares of a region rather than a pixel count.
 */

const DPI = 72;
const REPO_ROOT = repoRootFrom(new URL('../..', import.meta.url));

export interface RenderedPage {
  widthPx: number;
  heightPx: number;
  /** One byte per pixel, row-major, origin top-left. */
  pixels: Uint8Array;
}

/** A rectangle in PDF points, with the page it belongs to. */
export interface Region {
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

/**
 * Parse the harness's `page,x,y,w,h` region syntax. Returned as a failure rather than a throw: a badly spelled
 * region is a mistake in the case, and the message should say which case.
 */
export function parseRegion(spec: string): Region | null {
  const parts = spec.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return null;
  const [page, xPt, yPt, widthPt, heightPt] = parts as [number, number, number, number, number];
  if (page < 1 || widthPt <= 0 || heightPt <= 0) return null;
  return { page, xPt, yPt, widthPt, heightPt };
}

/** Render one page of a PDF to grayscale, or `null` where there is no renderer to ask. */
export async function renderPageGray(bytes: Uint8Array, page: number): Promise<RenderedPage | null> {
  let pgm: Uint8Array;
  try {
    const proc = spawn(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'worker-light',
        'pdftoppm',
        '-gray',
        '-r',
        String(DPI),
        '-f',
        String(page),
        '-l',
        String(page),
        // `-singlefile` **and no output prefix**: Poppler writes to stdout only when the prefix is omitted, and
        // without `-singlefile` it appends the page number to whatever prefix it was given — a bare `-` prefix is a
        // *filename*, so the obvious `… - -` silently writes `-1.pgm` inside the container and returns nothing.
        '-singlefile',
        '-',
      ],
      { cwd: REPO_ROOT },
    );
    // Both pipes are drained rather than one being closed: a child that fills the other one's buffer blocks forever.
    proc.stderr.resume();
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // The document goes in on stdin, and the write has to be *ended*: Poppler blocks on a pipe that stays open.
    // A spawn that never starts emits an `error` event and, under Bun, no `close` at all — the await races the
    // two, so a renderer that cannot start answers `null` instead of hanging the suite (`repoRootFrom` in
    // `pdf-inspect.ts` documents the Windows ENOENT that used to make this the live path on every render).
    proc.stdin.on('error', () => {});
    proc.stdin.end(bytes);
    const code = await new Promise<number | null>((resolve) => {
      proc.on('error', () => resolve(null));
      proc.on('close', resolve);
    });
    if (code !== 0) return null;
    pgm = new Uint8Array(Buffer.concat(chunks));
  } catch {
    return null;
  }
  return parsePgm(pgm);
}

/**
 * A binary PGM (`P5`) header plus its pixels.
 *
 * The header is parsed as whitespace-separated tokens rather than by assuming three newlines, because Poppler writes a
 * comment line (`# …`) into it and the comment's own text can contain anything. The pixel block begins after exactly
 * one whitespace byte past the maximum value, which is the only part of the format that is positional.
 */
function parsePgm(pgm: Uint8Array): RenderedPage | null {
  let index = 0;
  const tokens: number[] = [];

  const skipBlanks = () => {
    while (index < pgm.length) {
      const byte = pgm[index]!;
      if (byte === 0x23) {
        // `#` — a comment runs to the end of the line and is not part of the header.
        while (index < pgm.length && pgm[index] !== 0x0a) index += 1;
        continue;
      }
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
        index += 1;
        continue;
      }
      return;
    }
  };

  // The magic is the *characters* `P5`, not a number — reading the header as four integers fails on the first byte,
  // which is exactly the shape of mistake that makes a renderer look unavailable when it is working fine.
  skipBlanks();
  if (pgm[index] !== 0x50 || pgm[index + 1] !== 0x35) return null;
  index += 2;

  while (tokens.length < 3 && index < pgm.length) {
    skipBlanks();
    let value = 0;
    let digits = 0;
    while (index < pgm.length && pgm[index]! >= 0x30 && pgm[index]! <= 0x39) {
      value = value * 10 + (pgm[index]! - 0x30);
      index += 1;
      digits += 1;
    }
    if (digits === 0) return null;
    tokens.push(value);
  }
  // Width, height, maxval; then a single whitespace byte before the pixels.
  if (tokens.length < 3) return null;
  const [widthPx, heightPx, maxValue] = tokens as [number, number, number];
  if (maxValue !== 255 || widthPx <= 0 || heightPx <= 0) return null;
  index += 1;

  const pixels = pgm.subarray(index, index + widthPx * heightPx);
  if (pixels.length < widthPx * heightPx) return null;
  return { widthPx, heightPx, pixels: pixels.slice() };
}

/**
 * How much of a region is ink: pixels darker than 200/255, as a share of the region's pixels.
 *
 * A share rather than a count, because the two callers ask opposite questions of it — "is there something here" and
 * "is there nothing here" — and neither wants to know how many pixels a 1 pt line covers at 72 dpi (it is
 * resolution-dependent and would make the assertion a measurement of the renderer).
 */
export function inkShare(page: RenderedPage, region: Region): { share: number; dark: number; total: number } {
  const pageHeightPt = page.heightPx / (DPI / 72);
  const scale = DPI / 72;

  const left = clamp(Math.round(region.xPt * scale), 0, page.widthPx);
  const right = clamp(Math.round((region.xPt + region.widthPt) * scale), 0, page.widthPx);
  // The vertical flip: the region's top edge in points is measured from the page's bottom, and the raster's row 0 is
  // the page's top.
  const top = clamp(Math.round((pageHeightPt - (region.yPt + region.heightPt)) * scale), 0, page.heightPx);
  const bottom = clamp(Math.round((pageHeightPt - region.yPt) * scale), 0, page.heightPx);

  let dark = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      total += 1;
      if (page.pixels[row * page.widthPx + column]! < 200) dark += 1;
    }
  }
  return { share: total === 0 ? 0 : dark / total, dark, total };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
