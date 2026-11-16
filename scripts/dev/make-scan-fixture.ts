import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Build the OCR fixture set: pages that are **pixels, not text**.
 *
 * `bun run fixtures` writes `ocr-scan-eng.pdf`, but that file is produced by `pdf-writer` and therefore contains real
 * text — which makes it useless for proving OCR works. The OCR handler runs with `--skip-text` (an earlier text layer
 * must never be replaced), so on a text fixture it correctly does nothing and the job succeeds with zero recognition.
 * A green light from that test says nothing.
 *
 * So every fixture here is a source PDF from `fixtures:fixtures` **rasterised**: same words, all of them pixels. Only
 * then does "the output contains the words" mean "Tesseract read them off the page".
 *
 * Six files, one round trip, each with a premise the cases depend on and therefore a check here:
 *
 * | Fixture | Built from | The premise a case would be testing instead of the product |
 * |---|---|---|
 * | `ocr-scan-eng-raster.pdf` | `ocr-scan-eng.pdf` @ 300 dpi | the page has **no** text layer (else OCR is skipped) |
 * | `ocr-scan-eng-96dpi.pdf` | the same, @ 96 dpi | the embedded resolution is really 96 — the refusal names it |
 * | `ocr-scan-blank-a4.pdf` | `pdf-to-images-blank-a4.pdf` @ 300 dpi | page 2 really carries no ink, so a page the recogniser cannot read exists |
 * | `ocr-scan-speckle-a4.png` | the 300 dpi raster page + 2 % salt-and-pepper | the noise is really there (a clean image would make the `clean` pair vacuous) |
 * | `ocr-scan-eng.png` | the same page as a PNG @ 300 dpi | the PNG carries a real 300 dpi resolution, so the image input needs no `dpi` |
 * | `ocr-scan-two-p1.png`, `ocr-scan-two-p2.png` | `pdf-to-images-two.pdf`, page 1 and 2 @ 300 dpi | two images are two *different* pages, so a merge that drops one is visible |
 *
 * Ghostscript 300 dpi is deliberate on two counts: the handler *rejects* scans below 120 dpi, so a 72 dpi fixture
 * would test the rejection path instead of the recognition path; and `pdfimages -list` must report a real resolution
 * for the handler's DPI measurement to have anything to measure. The 96 dpi fixture exists for the other half of that
 * rule — it is above the *trigger* for the auto up-sample (200 dpi) and below the *refusal* (120 dpi is what refuses,
 * so 96 is refused and 200 is not) — and the refusal's own message quotes the number, which is why the number is
 * asserted here rather than trusted.
 *
 * The rasterisation, the speckling and every measurement run in the `worker-ocr` container because the engines live
 * there — this repo's dev setup has no Ghostscript on the host, by design.
 *
 *   docker compose up -d worker-ocr
 *   bun run fixtures
 *   bun run fixtures:scan
 */

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED = join(ROOT, 'fixtures', 'generated');
const CONTAINER = 'worker-ocr';
// Every generator in this directory honours the same variable, and the CI matrix passes it: the OCR job starts the
// pool from `docker-compose.ci.yml`, so a script that only ever addressed the dev compose file would report the
// container missing on the one run that matters. This was the only generator that did not read it.
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;

/** The pixels each fixture is written from, and the resolution the fixture is *about*. */
const SOURCES = {
  eng: 'ocr-scan-eng.pdf',
  two: 'pdf-to-images-two.pdf',
  blank: 'pdf-to-images-blank-a4.pdf',
} as const;

/**
 * Fixtures copied back to the host, by container path.
 *
 * `probe` is what this script checks before it hands the file over, in the container's own words: an empty text layer
 * for the rasters, the embedded ppi for the 96 dpi one, and the pixel dimensions for the PNGs.
 */
const OUTPUTS: Array<{ inner: string; name: string; probe: (facts: Facts) => string | null }> = [
  {
    inner: 'eng-raster.pdf',
    name: 'ocr-scan-eng-raster.pdf',
    probe: (facts) => (facts.text === '' ? null : `it still carries text: ${facts.text}`),
  },
  {
    inner: 'eng-96.pdf',
    name: 'ocr-scan-eng-96dpi.pdf',
    probe: (facts) =>
      facts.text === '' && facts.ppi === 96
        ? null
        : `expected 96 ppi and no text layer, read ${facts.ppi} ppi and text [${facts.text}]`,
  },
  {
    inner: 'blank-raster.pdf',
    name: 'ocr-scan-blank-a4.pdf',
    probe: (facts) =>
      facts.text === '' && facts.pages === 3
        ? null
        : `expected 3 pages with no text layer, read ${facts.pages} page(s) and text [${facts.text}]`,
  },
  {
    inner: 'speckle-a4.png',
    name: 'ocr-scan-speckle-a4.png',
    probe: (facts) =>
      realResolution(facts.ppi) && facts.speckle > 0 ? null : `read ${facts.ppi} ppi, speckle ${facts.speckle}`,
  },
  {
    inner: 'eng-page-1.png',
    name: 'ocr-scan-eng.png',
    probe: (facts) =>
      realResolution(facts.ppi) ? null : `read ${facts.ppi} ppi where the image input needs a real one`,
  },
  {
    // `pdftoppm -f N -l N` names its output after the page *number*, not after the range's first page, which is
    // why this is `-1` for page 1 and `-2` for page 2: a script that assumed a counter would copy the wrong page
    // back and every case built on "two images are two different pages" would be asserting one page twice.
    inner: 'two-p1-1.png',
    name: 'ocr-scan-two-p1.png',
    probe: (facts) => (realResolution(facts.ppi) ? null : `read ${facts.ppi} ppi`),
  },
  {
    inner: 'two-p2-2.png',
    name: 'ocr-scan-two-p2.png',
    probe: (facts) => (realResolution(facts.ppi) ? null : `read ${facts.ppi} ppi`),
  },
];

interface Facts {
  pages: number;
  text: string;
  ppi: number;
  speckle: number;
}

/**
 * Whether a PNG really carries a page resolution, within the rounding the format forces.
 *
 * A PNG stores its resolution in pixels per **metre**, so 300 dpi (11 811 px/m) reads back as 299.xx and PIL floors
 * it to 299 — the fixture is right and an `=== 300` check would reject it. What the cases need is a resolution high
 * enough that neither rule fires: the refusal at 120 dpi and the auto up-sample below 200.
 */
function realResolution(ppi: number): boolean {
  return ppi >= 290 && ppi <= 300;
}

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

/**
 * The container-side script: build, then measure, then print one line per file.
 *
 * Everything a case depends on is measured *inside* the container because that is where the cases run — a fixture
 * whose resolution is only checked by the tool that reads it on the host would be asserting a different file from the
 * one the worker sees. `pdfimages -list` is the same reader the handler uses to decide whether to refuse.
 */
const INNER = `
set -e
cd /tmp/scan-fixture
mkdir -p out
# Ghostscript and fontconfig both want a writable cache; without one every render prints "Fontconfig error: No writable
# cache directories" to stderr, and the summary this script prints is the part of its output worth reading.
export HOME=/tmp

gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfimage24 -r300 -sOutputFile=out/eng-raster.pdf src-eng.pdf
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfimage24 -r96  -sOutputFile=out/eng-96.pdf src-eng.pdf
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfimage24 -r300 -sOutputFile=out/blank-raster.pdf src-blank.pdf
pdftoppm -png -r 300 -f 1 -l 1 src-eng.pdf  out/eng-page
pdftoppm -png -r 300 -f 1 -l 1 src-two.pdf  out/two-p1
pdftoppm -png -r 300 -f 2 -l 2 src-two.pdf  out/two-p2

python3 - <<'PY'
from PIL import Image
import random

# Salt and pepper over 2% of the pixels of the 300 dpi page. The seed is fixed because the fixture *is* an assertion
# premise: the noisy twin of the clean scan is what the \`clean\` case compares against, and a fixture that changes
# between runs would make that case flaky in the direction of passing.
#
# The ratio is measured rather than picked, against the **job's own pipeline** (the page is embedded by the handler's
# img2pdf bridge and recognised with \`--deskew --rotate-pages\`, which re-rasterises the page):
#
#   1%  the recogniser reads the page correctly with and without \`--clean\` — nothing to assert
#   2%  without \`--clean\` it reads "page tof" where the page says "page 1 of 1"; with it, exactly the page
#   3%  without \`--clean\` "page 1 of 1 oo" — still the right phrase, so the pair stops being separable
#   5%  without \`--clean\` nothing at all is read, which is a *refusal*, not a comparison
#
# 2% is therefore the only ratio where both halves are true and different. Repeating the 2% run gave byte-identical
# text, so the case is deterministic until an engine upgrade changes it — which is the signal a case exists to give.
random.seed(10)
img = Image.open('out/eng-page-1.png').convert('RGB')
px = img.load()
w, h = img.size
count = 0
for _ in range(int(w * h * 0.02)):
    x, y = random.randrange(w), random.randrange(h)
    px[x, y] = (0, 0, 0) if random.random() < 0.5 else (255, 255, 255)
    count += 1
# Written with the page's own resolution, not a default: an image input that arrives with no DPI is refused, and a
# fixture that could only be used together with the \`dpi\` option would be testing the fallback in every case.
img.save('out/speckle-a4.png', dpi=(300, 300))
print(f"speckle:{count}")
PY

probe() {
  file="$1"
  pages=$(qpdf --show-npages "out/$file")
  text=$(pdftotext "out/$file" - 2>/dev/null | tr -d '[:space:]' || true)
  ppi=$(pdfimages -list "out/$file" | awk 'NR>2 {print $13; exit}')
  echo "probe:$file pages:$pages text:[$text] ppi:$ppi"
}
probe eng-raster.pdf
probe eng-96.pdf
probe blank-raster.pdf

python3 - <<'PY'
from PIL import Image
for name in ('eng-page-1.png', 'two-p1-1.png', 'two-p2-2.png', 'speckle-a4.png'):
    with Image.open(f'out/{name}') as img:
        dpi = img.info.get('dpi', (0, 0))[0]
        print(f"png:{name} ppi:{dpi} size:{img.size[0]}x{img.size[1]}")
PY
`;

async function main() {
  await mkdir(GENERATED, { recursive: true });

  for (const [key, file] of Object.entries(SOURCES)) {
    if (!(await stat(join(GENERATED, file)).catch(() => null))) {
      console.error(`missing ${file} — run \`bun run fixtures\` first`);
      process.exit(1);
    }
    void key;
  }

  const ps = await docker(['ps', '--status', 'running', '--services']);
  if (!ps.stdout.split('\n').includes(CONTAINER)) {
    console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
    process.exit(1);
  }

  // `docker cp` will not create the destination directory, and a freshly recreated container has no /tmp/scan-fixture
  // — so the directory is made first. Without this the script only ever ran on a container some earlier run had
  // already primed, which is the same "passes because of what is left on disk" failure the fixture suites were built
  // to catch, one layer up.
  const madeDir = await docker(['exec', '-T', CONTAINER, 'mkdir', '-p', '/tmp/scan-fixture']);
  if (madeDir.code !== 0) {
    console.error(`could not create /tmp/scan-fixture in ${CONTAINER}: ${madeDir.stderr.trim()}`);
    process.exit(1);
  }

  for (const [key, file] of Object.entries(SOURCES)) {
    const copied = await docker(['cp', join(GENERATED, file), `${CONTAINER}:/tmp/scan-fixture/src-${key}.pdf`]);
    if (copied.code !== 0) {
      console.error(`could not copy ${file} into ${CONTAINER}: ${copied.stderr.trim()}`);
      process.exit(1);
    }
  }

  const built = await docker(['exec', '-T', CONTAINER, 'sh', '-c', INNER]);
  if (built.code !== 0) {
    console.error(`the fixture build failed in ${CONTAINER}:\n${built.stderr.trim()}`);
    process.exit(1);
  }

  // One `Facts` per fixture, read out of the container's own output rather than from the flags this script passed.
  const facts = new Map<string, Facts>();
  for (const line of built.stdout.split('\n')) {
    const probe = /^probe:(\S+) pages:(\d+) text:\[(.*)\] ppi:(\S+)/.exec(line.trim());
    if (probe) {
      facts.set(probe[1]!, {
        pages: Number(probe[2]),
        text: probe[3]!,
        ppi: Number(probe[4]),
        speckle: 0,
      });
      continue;
    }
    const png = /^png:(\S+) ppi:(\d+)/.exec(line.trim());
    if (png) {
      const entry = facts.get(png[1]!) ?? { pages: 1, text: '', ppi: 0, speckle: 0 };
      entry.ppi = Number(png[2]);
      facts.set(png[1]!, entry);
    }
    // The speckle count is printed *before* the PNG measurements (it is the step that writes the file), so this
    // branch creates the entry it lands on rather than assuming the `png:` line has already filled it in.
    const speckle = /^speckle:(\d+)/.exec(line.trim());
    if (speckle) {
      const entry = facts.get('speckle-a4.png') ?? { pages: 1, text: '', ppi: 0, speckle: 0 };
      entry.speckle = Number(speckle[1]);
      facts.set('speckle-a4.png', entry);
    }
  }

  const failures: string[] = [];
  for (const output of OUTPUTS) {
    const entry = facts.get(output.inner);
    if (!entry) {
      failures.push(`${output.name}: no measurement came back for ${output.inner}`);
      continue;
    }
    const complaint = output.probe(entry);
    if (complaint) failures.push(`${output.name}: ${complaint}`);

    const copied = await docker([
      'cp',
      `${CONTAINER}:/tmp/scan-fixture/out/${output.inner}`,
      join(GENERATED, output.name),
    ]);
    if (copied.code !== 0) {
      failures.push(`${output.name}: could not be copied back (${copied.stderr.trim()})`);
      continue;
    }
    const bytes = (await stat(join(GENERATED, output.name))).size;
    const detail = output.name.endsWith('.png')
      ? `${entry.ppi} ppi${entry.speckle > 0 ? `, ${entry.speckle} speckled pixels` : ''}`
      : `${entry.pages} page(s), ${entry.ppi} ppi, ${entry.text === '' ? 'no text layer' : `TEXT PRESENT: ${entry.text}`}`;
    console.log(`${output.name}  ${bytes} bytes  ${detail}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.map((line) => `  · ${line}`).join('\n')}`);
    console.error('\na fixture whose premise is wrong makes its case hollow, so none of these were kept as good');
    process.exitCode = 1;
  }
}

await main();
