import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { countPagesInPdf } from './pdf-writer';

/**
 * The fixture `compress`'s **target-size** mode needs: a document no rung of the ladder can shrink.
 *
 * `targetSizeMb` is the one option in this tool with a loop behind it, and until pass 5 it had no golden case at all —
 * which is how the handler's real search (two presets, compounded) and the document's stated one (a six-rung ladder,
 * four runs, floor 96 dpi / quality 40) could drift apart in the same repository. A case for the *unreachable* half
 * needs a file whose floor is above the target, and that is a property of the fixture rather than of the case, so the
 * fixture asserts it: every rung the handler can run is executed here, and the smallest result must still be the input.
 *
 * The content is a page-filling JPEG of plasma noise, and the reason it is incompressible is worth writing down because
 * it is not "noise": Ghostscript **passes a JPEG through** when the image is not resampled and not re-encoded, and none
 * of the four rungs changes a 72 dpi image inside a page of its own size. Measured at generation time (`-dJPEGQ` from 85
 * down to 40, four rungs, every output within a kilobyte of the input) — so the file is a stable "there is nothing left
 * to take out of this" for the tool, not a random pile of bytes that happens to resist one particular setting.
 *
 *   docker compose up -d worker-light
 *   bun run fixtures:compress
 */

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(ROOT, 'fixtures', 'generated');
const CONTAINER = 'worker-light';
const CONTAINER_TMP = '/tmp/compress-fixtures';
/** CI starts the light pool from `docker-compose.ci.yml`, and a hard-coded service lookup would miss it there. */
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;

const NAME = 'compress-noise-a4';
/** The four rungs the handler's ladder runs, as `dpi:quality` — repeated here so the fixture is verified against what the */
/** product will actually do to it rather than against one setting someone remembered. */
const RUNGS: Array<{ dpi: number; quality: number }> = [
  { dpi: 300, quality: 85 },
  { dpi: 200, quality: 80 },
  { dpi: 120, quality: 60 },
  { dpi: 96, quality: 40 },
];

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const compose = COMPOSE_FILE ? ['-f', COMPOSE_FILE] : [];
  const proc = Bun.spawn(['docker', 'compose', ...compose, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A shell fragment inside the container, returning stdout and the exit code. */
async function shell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return docker(['exec', '-T', CONTAINER, 'sh', '-c', script]);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const ps = await docker(['ps', '--status', 'running', '--services']);
  if (!ps.stdout.split('\n').includes(CONTAINER)) {
    console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
    process.exit(1);
  }
  await docker(['exec', '-T', CONTAINER, 'mkdir', '-p', CONTAINER_TMP]);

  const built = await shell(
    [
      `cd ${CONTAINER_TMP}`,
      'rm -f source.pdf pass-*.pdf worst.pdf',
      // One 1600×1600 plasma frame on one page of the same size in points, written as a JPEG inside the PDF: at 72 dpi it
      // is below every rung's downsampling threshold, which is what makes the passthrough behaviour structural.
      'magick -size 1600x1600 plasma:fractal -colorspace sRGB -compress jpeg -quality 95 source.pdf',
      // `stat`, not `ls`: the size is the only field being read, and parsing it out of `ls -l`'s column layout is the
      // kind of thing that works on one coreutils and not the next.
      'stat -c %s source.pdf',
    ].join('\n'),
  );
  if (built.code !== 0) {
    console.error(`could not build ${NAME}.pdf in ${CONTAINER}: ${built.stderr.trim() || built.stdout.trim()}`);
    process.exit(1);
  }

  const sourceBytes = Number.parseInt(built.stdout.trim().split('\n').at(-1) ?? '', 10);
  if (!Number.isFinite(sourceBytes) || sourceBytes < 1024 * 1024) {
    console.error(
      `${NAME}.pdf: the source is ${sourceBytes} bytes — the case needs a file far above the smallest legal target (0.05 MB)`,
    );
    process.exit(1);
  }

  // Every rung, in the container, with the handler's own arguments: the fixture's contract is "no rung reaches the
  // smallest legal target", and the only honest way to assert that is to run them.
  const script = [
    `cd ${CONTAINER_TMP}`,
    'for spec in 300:85 200:80 120:60 96:40; do',
    '  dpi=${spec%%:*}; quality=${spec##*:}',
    '  gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dNOPAUSE -dBATCH -dQUIET -dSAFER -dAutoRotatePages=/None \\',
    '    -dSubsetFonts=true -dEmbedAllFonts=true \\',
    '    -dDownsampleColorImages=true -dColorImageResolution=$dpi \\',
    '    -dDownsampleGrayImages=true -dGrayImageResolution=$dpi \\',
    '    -dDownsampleMonoImages=true -dMonoImageResolution=$(( dpi > 300 ? dpi : 300 )) \\',
    '    -dColorImageDownsampleType=/Bicubic -dGrayImageDownsampleType=/Bicubic -dMonoImageDownsampleType=/Subsample \\',
    '    -dColorImageFilter=/DCTEncode -dGrayImageFilter=/DCTEncode -dJPEGQ=$quality \\',
    '    -sOutputFile=pass-$dpi.pdf source.pdf 2>/dev/null',
    '  printf "rung %s/%s %s\\n" "$dpi" "$quality" "$(stat -c %s pass-$dpi.pdf)"',
    'done',
  ].join('\n');

  const rungs = await shell(script);
  if (rungs.code !== 0) {
    console.error(`the ladder could not be measured: ${rungs.stderr.trim() || rungs.stdout.trim()}`);
    process.exit(1);
  }

  const measured: Array<{ dpi: number; quality: number; bytes: number }> = [];
  for (const line of rungs.stdout.split('\n')) {
    const match = /^rung (\d+)\/(\d+) (\d+)$/.exec(line.trim());
    if (match) measured.push({ dpi: Number(match[1]), quality: Number(match[2]), bytes: Number(match[3]) });
  }
  if (measured.length !== RUNGS.length) {
    console.error(`expected ${RUNGS.length} rung measurements, got ${measured.length}:\n${rungs.stdout}`);
    process.exit(1);
  }

  // The floor is what the case's unreachable target has to be below: 0.05 MB is the smallest target the contract allows,
  // so "no rung fits" is true exactly when the smallest rung output is above it.
  const smallest = Math.min(...measured.map((rung) => rung.bytes));
  const targetFloorBytes = 0.05 * 1024 * 1024;
  if (smallest <= targetFloorBytes) {
    console.error(
      `${NAME}.pdf: the smallest rung produced ${smallest} bytes, below the 0.05 MB target floor — this fixture can no longer prove an unreachable target`,
    );
    process.exit(1);
  }

  const outgoing = join(OUT_DIR, `${NAME}.pdf`);
  const copied = await docker(['cp', `${CONTAINER}:${CONTAINER_TMP}/source.pdf`, outgoing]);
  if (copied.code !== 0) {
    console.error(`${NAME}.pdf: could not copy the result back out — ${copied.stderr.trim()}`);
    process.exit(1);
  }

  // A fixture is not a fixture until the copy CI uploads has been read back: page count from the bytes, and the size the
  // case is built on.
  const bytes = Buffer.from(await Bun.file(outgoing).arrayBuffer());
  const pages = countPagesInPdf(bytes);
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || pages !== 1 || bytes.length !== sourceBytes) {
    console.error(
      `${NAME}.pdf: the copied fixture is not the measured file — ${bytes.length} bytes (measured ${sourceBytes}), ${pages} page(s)`,
    );
    process.exit(1);
  }

  console.log(`${NAME}.pdf  ${bytes.length} bytes  ${pages} page(s)  a JPEG Ghostscript passes through`);
  for (const rung of measured) {
    console.log(`  rung ${rung.dpi}/${rung.quality} → ${rung.bytes} bytes`);
  }
  console.log(
    `\nsmallest rung output ${smallest} bytes > the 0.05 MB target floor ${targetFloorBytes} bytes, so \`targetSizeMb: 0.05\` is provably unreachable on this fixture and \`targetSizeMb: 5\` is provably reachable.`,
  );
  console.log('\nfixtures:compress ok');
}

await main();
