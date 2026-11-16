import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPdf, countPagesInPdf } from './pdf-writer';

/**
 * The fixture `compress`'s **byte** escalation needs: a document over 100 MB with almost no work inside it.
 *
 * `04-COMPRESS.md` §6 says a job above 300 pages **or 100 MB** moves to the heavy pool with a 420 s budget. The page
 * half of that rule has had a case since pass 36 (`compress-large-320p.pdf`, accepted on `pdf-heavy`) and the byte half
 * had none at all — so the boundary a large file crosses was configuration, exactly as the page boundary had been. The
 * two halves need different fixtures and this is the reason: 100 MB of *pages* would make the case a performance test
 * for a routing decision, while 100 MB of *bytes* is what the API actually measures (`stat` on what it received, then
 * `effectiveQueue` on the total). So the document stays two pages and the size is padding — one unreferenced stream
 * object of zeros (`PdfSpec.padFileBytes`), which no reader walks to and no rewrite writes out.
 *
 * Three measurements are taken here rather than assumed, because the whole fixture is unusual enough that "it is a PDF"
 * is worth checking somewhere other than in the writer that made it:
 *
 *   · the file is **over** the threshold (and only just: the assertion is that the overhead outside the payload is
 *     small, not that the total is large by accident);
 *   · the page count is what the case will assert, read back from the bytes that were written;
 *   · **poppler** — a reader that is not the writer — agrees, and Ghostscript's own first pass on it finishes in the
 *     time a two-page document takes and produces a two-page file with the padding gone. That is the claim the fixture
 *     exists to make: the bytes travel, the conversion does not pay for them.
 *
 *   docker compose up -d worker-heavy
 *   bun run fixtures:large
 */

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(ROOT, 'fixtures', 'generated');
const CONTAINER = 'worker-heavy';
const CONTAINER_TMP = '/tmp/large-fixtures';
/** CI starts the heavy pool from `docker-compose.yml`, and a hard-coded service lookup would miss an override. */
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;

const PAGES = 2;
/** The threshold from the document, repeated here so the fixture fails loudly if the padding stops clearing it. */
const THRESHOLD_BYTES = 100 * 1024 * 1024;
/**
 * The payload, deliberately a few MB over the threshold rather than exactly it.
 *
 * `aboveBytes` is a **strict** comparison, so a file of exactly 100 MB would route to `light` and the case would be
 * asserting nothing. 105 MB leaves room for the header, the objects, the xref and the trailer without re-deriving the
 * boundary in a second place.
 */
const PAD_BYTES = 105 * 1024 * 1024;
const NAME = 'compress-over-100mb';

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

async function shell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return docker(['exec', '-T', CONTAINER, 'sh', '-c', script]);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const bytes = buildPdf({ pages: PAGES, label: 'Compress escalation fixture', padFileBytes: PAD_BYTES });
  const outgoing = join(OUT_DIR, `${NAME}.pdf`);
  await writeFile(outgoing, bytes);

  // Read back what a consumer reads: the size on disk, and the page count from the bytes themselves.
  const size = (await stat(outgoing)).size;
  const fileBytes = Buffer.from(await Bun.file(outgoing).arrayBuffer());
  const pages = countPagesInPdf(fileBytes);
  const overhead = size - PAD_BYTES;
  if (size <= THRESHOLD_BYTES) {
    console.error(
      `${NAME}.pdf: ${size} bytes is not above the 100 MB escalation threshold (${THRESHOLD_BYTES}) — the case would route to the light pool and assert nothing`,
    );
    process.exit(1);
  }
  if (overhead < 0 || overhead > 64 * 1024) {
    console.error(
      `${NAME}.pdf: the padding is ${overhead} bytes of overhead away from a ${PAD_BYTES}-byte payload — the file is not shaped the way the case depends on (a large file holding a small document)`,
    );
    process.exit(1);
  }
  if (pages !== PAGES || fileBytes[0] !== 0x25 || fileBytes[1] !== 0x50) {
    console.error(`${NAME}.pdf: the written file reads back as ${pages} page(s), not ${PAGES}`);
    process.exit(1);
  }

  const ps = await docker(['ps', '--status', 'running', '--services']);
  if (!ps.stdout.split('\n').includes(CONTAINER)) {
    console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
    process.exit(1);
  }
  await docker(['exec', '-T', CONTAINER, 'mkdir', '-p', CONTAINER_TMP]);
  const copied = await docker(['cp', outgoing, `${CONTAINER}:${CONTAINER_TMP}/in.pdf`]);
  if (copied.code !== 0) {
    console.error(`${NAME}.pdf: could not copy the fixture into ${CONTAINER} — ${copied.stderr.trim()}`);
    process.exit(1);
  }

  // Poppler first: a page count from a reader that is not the writer. `pdfinfo` reads the page tree, so a padding
  // object of zeros that had been mistaken for structure would show up here rather than inside a failing case.
  const info = await shell(`cd ${CONTAINER_TMP} && pdfinfo in.pdf 2>&1 | sed -n '1,6p;/^Pages/p'`);
  const reported = Number(/^Pages:\s+(\d+)$/m.exec(info.stdout)?.[1] ?? Number.NaN);
  if (info.code !== 0 || reported !== PAGES) {
    console.error(
      `${NAME}.pdf: pdfinfo reports ${Number.isNaN(reported) ? 'nothing' : `${reported} page(s)`}, not ${PAGES}\n${info.stdout}`,
    );
    process.exit(1);
  }

  // Then the engine the tool actually uses, with the same first pass (the `prepress` preset the handler's ladder opens
  // with), timed. Nothing about the routing claim depends on this number; it is here so that "the conversion does not
  // pay for the bytes" is a measurement rather than a sentence in a comment.
  const converted = await shell(
    [
      `cd ${CONTAINER_TMP}`,
      'rm -f out.pdf',
      'start=$(date +%s%N)',
      // One line, because a bare newline is a command separator: the same command wrapped across lines would run as two.
      'gs -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -dQUIET -dPDFSETTINGS=/prepress -dCompatibilityLevel=1.7 -sOutputFile=out.pdf in.pdf',
      'status=$?',
      'end=$(date +%s%N)',
      'echo "status=$status ms=$(( (end - start) / 1000000 ))"',
      'ls -l out.pdf | awk \'{print "out=" $5}\'',
      "pdfinfo out.pdf 2>/dev/null | sed -n '/^Pages/p'",
    ].join('\n'),
  );
  const ms = Number(/ms=(\d+)/.exec(converted.stdout)?.[1] ?? Number.NaN);
  const outBytes = Number(/out=(\d+)/.exec(converted.stdout)?.[1] ?? Number.NaN);
  const outPages = Number(/^Pages:\s+(\d+)$/m.exec(converted.stdout)?.[1] ?? Number.NaN);
  if (!/status=0/.test(converted.stdout) || outPages !== PAGES) {
    console.error(`${NAME}.pdf: the first compression pass did not produce ${PAGES} page(s)\n${converted.stdout}`);
    process.exit(1);
  }
  if (!(outBytes > 0) || outBytes > THRESHOLD_BYTES) {
    console.error(
      `${NAME}.pdf: the rewrite produced ${outBytes} bytes — the padding was supposed to cost the conversion nothing`,
    );
    process.exit(1);
  }

  console.log(`${NAME}.pdf  ${size} bytes  ${pages} page(s)  (${PAD_BYTES} of them padding)`);
  console.log(`  pdfinfo: ${reported} page(s)`);
  console.log(`  first pass: ${ms} ms in, ${outBytes} bytes out, ${outPages} page(s)`);
  console.log(
    `\n${size} bytes is above the 100 MB threshold ${THRESHOLD_BYTES}, and the document inside is ${pages} pages — so a job on this fixture can only be escalated by its **size**, which is what its case asserts.`,
  );
  console.log('\nfixtures:large ok');
}

await main();
