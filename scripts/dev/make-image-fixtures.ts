import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPng, readPngSize, verifyPngChunks } from './png-writer';

/**
 * Build the image fixtures `images-to-pdf` needs: three real images in three different formats, plus the transparent
 * logo `watermark` needs.
 *
 * PNG is written here (`png-writer.ts`); JPEG and WebP are produced by converting those PNGs **inside
 * `worker-light`**, because both formats need a DCT/Riff encoder that the repository does not have and the light
 * image already does (ImageMagick, libjpeg-turbo, libwebp). That mirrors `make-scan-fixture.ts`, which rasterises
 * the OCR fixture in the container for the same reason: the engines live in the images, not on the host.
 *
 * Mixed formats in one job is the point, not decoration. `images-to-pdf` hands every input to the same ImageMagick
 * call, so a change that works for PNG and silently breaks JPEG is exactly the class of bug this fixture set
 * catches — and the API's type detection reads each file's magic bytes, so a mislabelled fixture fails loudly.
 *
 *   docker compose up -d worker-light
 *   bun run fixtures:images
 *
 * HEIC is the one format with no *real* fixture, and the reason is measured rather than assumed: `heif-enc` in this
 * image reports "No HEVC encoder available" and ImageMagick reports HEIC read-only (`r--`), so nothing here can encode
 * one, and no phone photo is committed. What is generated instead is a HEIC-**branded** container that no decoder can
 * read (`writeHeicBranded`), which is what makes the tenant's reject policy and the undecodable path testable; the gap
 * that leaves — a genuine HEIC decoding to a page — is recorded in `docs/0-E2E-CHECKLIST.md` rather than papered over.
 */

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(ROOT, 'fixtures', 'generated');
const CONTAINER = 'worker-light';
const CONTAINER_TMP = '/tmp/image-fixtures';
/**
 * Which compose file the container belongs to.
 *
 * CI starts the light pool from `docker-compose.ci.yml` (tmpfs database, no web, no other pools), so a hard-coded
 * `docker compose exec` would look for `worker-light` in a project that is not running there — which is exactly how
 * these fixtures came to be generated locally but never in CI.
 */
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;

interface ImageVariant {
  /** Fixture stem, following the documented `<tool>-<variant>` convention. */
  name: string;
  width: number;
  height: number;
  /** Base colour, so the three images are obviously different in a viewer as well as in a page count. */
  tint: [number, number, number];
}

const VARIANTS: ImageVariant[] = [
  { name: 'images-to-pdf-portrait', width: 400, height: 600, tint: [32, 84, 148] },
  { name: 'images-to-pdf-landscape', width: 600, height: 400, tint: [148, 82, 32] },
  { name: 'images-to-pdf-square', width: 500, height: 500, tint: [60, 130, 90] },
];

/** The two formats ImageMagick is asked to write, with the arguments that make each one deterministic. */
const CONVERSIONS: Array<{ ext: string; args: string[]; accepts: (bytes: Buffer) => boolean }> = [
  {
    ext: 'jpg',
    args: ['-quality', '85', '-sampling-factor', '4:2:0'],
    // SOI … EOI. A truncated JPEG is the classic silent ImageMagick failure.
    accepts: (bytes) =>
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9,
  },
  {
    ext: 'webp',
    args: ['-quality', '85'],
    accepts: (bytes) =>
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  },
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

/** `magick` inside the container, returning stdout and the exit code. */
async function magick(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return docker(['exec', '-T', CONTAINER, 'magick', ...args]);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const ps = await docker(['ps', '--status', 'running', '--services']);
  if (!ps.stdout.split('\n').includes(CONTAINER)) {
    console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
    process.exit(1);
  }

  await docker(['exec', '-T', CONTAINER, 'mkdir', '-p', CONTAINER_TMP]);

  let failures = 0;

  for (const variant of VARIANTS) {
    // A flat gradient plus a solid corner block: flat enough to deflate to a few kilobytes, and asymmetric enough
    // that orientation detection has something real to read.
    const png = buildPng({
      width: variant.width,
      height: variant.height,
      pixel: (x, y) => {
        const inCorner = x < variant.width / 4 && y < variant.height / 4;
        if (inCorner) return [250, 250, 250];
        const shade = Math.round((x / variant.width) * 60);
        return [
          Math.min(255, variant.tint[0] + shade),
          Math.min(255, variant.tint[1] + shade),
          Math.min(255, variant.tint[2] + shade),
        ];
      },
    });

    const pngPath = join(OUT_DIR, `${variant.name}.png`);
    await writeFile(pngPath, png);
    const size = readPngSize(png);
    const chunks = verifyPngChunks(png);
    if (!chunks.ok || size?.width !== variant.width || size.height !== variant.height) {
      console.error(`${variant.name}.png failed its own verification: ${JSON.stringify({ size, chunks })}`);
      failures += 1;
      continue;
    }
    console.log(`${variant.name}.png  ${png.length} bytes  ${size.width}×${size.height}  ${chunks.chunks} chunks`);

    const copied = await docker(['cp', pngPath, `${CONTAINER}:${CONTAINER_TMP}/${variant.name}.png`]);
    if (copied.code !== 0) {
      console.error(`could not copy ${variant.name}.png into ${CONTAINER}: ${copied.stderr.trim()}`);
      failures += 1;
      continue;
    }

    for (const conversion of CONVERSIONS) {
      const target = `${variant.name}.${conversion.ext}`;
      const converted = await magick([
        `${CONTAINER_TMP}/${variant.name}.png`,
        ...conversion.args,
        `${CONTAINER_TMP}/${target}`,
      ]);
      if (converted.code !== 0) {
        console.error(`  ${target}: ImageMagick failed — ${converted.stderr.trim().split('\n').pop()}`);
        failures += 1;
        continue;
      }

      // What the engine says it wrote, read back from the file it wrote — not from the arguments we passed.
      const probe = await magick(['identify', '-format', '%m %w %h', `${CONTAINER_TMP}/${target}`]);
      const outPath = join(OUT_DIR, target);
      const copiedOut = await docker(['cp', `${CONTAINER}:${CONTAINER_TMP}/${target}`, outPath]);
      if (copiedOut.code !== 0) {
        console.error(`  ${target}: could not copy the result back out — ${copiedOut.stderr.trim()}`);
        failures += 1;
        continue;
      }

      const bytes = Buffer.from(await Bun.file(outPath).arrayBuffer());
      const headerOk = conversion.accepts(bytes);
      const described = probe.stdout.trim();
      const matches = described === `${conversion.ext === 'jpg' ? 'JPEG' : 'WEBP'} ${variant.width} ${variant.height}`;
      if (!headerOk || probe.code !== 0 || !matches) {
        console.error(
          `  ${target}: verification failed — header ${headerOk ? 'ok' : 'wrong'}, identify said "${described}"`,
        );
        failures += 1;
        continue;
      }
      console.log(`  ${target}  ${bytes.length} bytes  ${described}`);
    }
  }

  failures += await writeWatermarkLogo();
  failures += await writeWatermarkImageCaps();
  failures += await writeSignatureInk();
  failures += await writeOversizeSignature();
  failures += await writeOversizeElementImage();
  failures += await writeExifOrientation();
  failures += await writeTiffs();
  failures += await writeHeicBranded();

  console.log('');
  console.log('HEIC: no *real* HEIC is generated — `heif-enc` in this image reports "No HEVC encoder available", so');
  console.log(
    '      there is no way to encode one here. What is generated is a HEIC-*branded* container that no decoder',
  );
  console.log('      can read, which is what makes the reject policy and the undecodable path testable.');
  console.log(`\nfixtures:images ${failures === 0 ? 'ok' : `FAILED (${failures})`}`);
  if (failures > 0) process.exitCode = 1;
}

/**
 * The transparent logo `watermark` stamps.
 *
 * Transparency is the whole point of this fixture: an image watermark that loses its alpha channel paints a solid
 * rectangle over the page, which is the failure a viewer — not a page count — shows you. So the fixture must
 * genuinely carry alpha (a `PNG32` disc on a transparent background, not a white square), and both facts are read
 * back from the bytes the engine wrote: the channel set says `srgba`, and the alpha channel's minimum is zero.
 *
 * Generated by the engine rather than by `png-writer.ts` because that writer is RGB-only (colour type 2) on
 * purpose: adding an alpha branch there to produce one fixture would mean a second encoder path whose own bugs are
 * untested. ImageMagick already has to exist in this image for `images-to-pdf`.
 */
async function writeWatermarkLogo(): Promise<number> {
  const name = 'watermark-logo';
  const target = `${CONTAINER_TMP}/${name}.png`;
  const drawn = await magick([
    '-size',
    '400x400',
    'xc:none',
    '-fill',
    '#1d4ed8',
    '-draw',
    'circle 200,200 200,60',
    `PNG32:${target}`,
  ]);
  if (drawn.code !== 0) {
    console.error(`${name}.png: ImageMagick failed — ${drawn.stderr.trim().split('\n').pop()}`);
    return 1;
  }

  const probe = await magick(['identify', '-format', '%m %w %h %[channels]', target]);
  const reported = probe.stdout.trim();
  const outgoing = join(OUT_DIR, `${name}.png`);
  const copied = await docker(['cp', `${CONTAINER}:${target}`, outgoing]);
  if (copied.code !== 0) {
    console.error(`${name}.png: could not copy the result back out — ${copied.stderr.trim()}`);
    return 1;
  }

  // Two readings, each from the side that can make it honestly: the alpha facts come from the engine inside the
  // container (its `identify`), and the copy that CI will upload is checked on the host without an engine — a real
  // PNG of the right dimensions, so a truncated `docker cp` cannot pass as a fixture.
  //
  // Asked for separately: ImageMagick's `%[channels]` prints its own depth alongside the set (`srgba 4.0`), so
  // combining the two into one format string puts a number where the alpha was expected.
  const verify = await magick(['identify', '-format', '%[channels]|%[fx:minima.a]', target]);
  const [channels, minAlpha] = verify.stdout.trim().split('|');
  const bytes = Buffer.from(await Bun.file(outgoing).arrayBuffer());
  const size = readPngSize(bytes);
  const chunks = verifyPngChunks(bytes);

  if (!channels?.includes('srgba') || minAlpha?.trim() !== '0' || reported !== 'PNG 400 400 srgba 4.0') {
    console.error(`${name}.png: verification failed — ${reported}, channels ${channels}, minimum alpha ${minAlpha}`);
    return 1;
  }
  if (!chunks.ok || size?.width !== 400 || size.height !== 400) {
    console.error(`${name}.png: the copied fixture is not a 400×400 PNG — ${JSON.stringify({ size, chunks })}`);
    return 1;
  }
  console.log(`${name}.png  ${bytes.length} bytes  ${reported}  fully transparent pixels present`);
  return 0;
}

/**
 * The two images `11-WATERMARK.md` §6 caps: one over the **downsample** threshold and one over the **refusal** one.
 *
 * They are two files rather than one because the two caps are two behaviours — a 4 200 px logo is reduced to 4 000
 * and reported `IMAGE_LARGE`, an 8 200 px one is refused outright — and the interesting failure is an implementation
 * that applies the reduction *before* the refusal check, which collapses "too large to accept" into "quietly
 * shrunk". Only the second fixture can tell those apart, and only if it survives the first cap's own check.
 *
 * Both are **thin rather than square**, and the reason is cost: what matters to each rule is the longest axis, while a
 * 4 200×4 200 bitmap is 52 MB of raw RGB for the worker to hold. 4 200×600 exercises the horizontal axis at 7.5 MB
 * and 8 200×8 exercises the refusal at 200 KB, which keeps these cases inside a suite that runs on every push.
 *
 * Written by `png-writer.ts` on the host, like the oversize single-image fixtures above and for the same reason: no
 * engine is needed to make a flat-coloured PNG, so `fixtures:images` does not have to reach into a container for these.
 */
async function writeWatermarkImageCaps(): Promise<number> {
  const cases: Array<{ name: string; width: number; height: number }> = [
    { name: 'watermark-logo-large', width: 4200, height: 600 },
    { name: 'watermark-logo-huge', width: 8200, height: 8 },
  ];
  let failures = 0;
  for (const spec of cases) {
    const png = buildPng({
      width: spec.width,
      height: spec.height,
      // A diagonal ramp, so the file is a picture rather than a solid block — a flat fill is exactly the input whose
      // resize is invisible, and this fixture exists to be *seen* being resized.
      pixel: (x, y) => [(20 + (((x + y) / 8) % 200)) | 0, 60 + ((y % 160) | 0), 200 - (((x / 12) % 150) | 0)],
    });
    const outgoing = join(OUT_DIR, `${spec.name}.png`);
    await writeFile(outgoing, png);

    const size = readPngSize(png);
    const chunks = verifyPngChunks(png);
    if (!chunks.ok || size?.width !== spec.width || size.height !== spec.height) {
      console.error(`${spec.name}.png: not a ${spec.width}×${spec.height} PNG — ${JSON.stringify({ size, chunks })}`);
      failures += 1;
      continue;
    }
    if (png.length > 8 * 1024 * 1024) {
      console.error(`${spec.name}.png: ${png.length} bytes — over the byte cap the watermark enforces`);
      failures += 1;
      continue;
    }
    console.log(`${spec.name}.png  ${png.length} bytes  ${spec.width}×${spec.height}`);
  }
  return failures;
}

/**
 * The signature `sign` stamps: a handwritten-looking stroke on a fully transparent canvas.
 *
 * Two facts about it are deliberate, and both are about what the golden case can then *prove*:
 *
 *  1. **The ink is confined to the canvas's upper three quarters, and it is thick.** `sign` places a bitmap with its
 *     aspect ratio kept (`fit: 'contain'`), so this 600×220 canvas in a 200×150 box occupies a 200×73 band centred in
 *     the box — rows 35–165 of the canvas land at ~357–400 pt, where a **stretched** placement would put the same ink
 *     at ~337–426 pt. That difference is the containment assertion: the case proves ink in 378–398 and blank in
 *     342–354 and 404–422, and neither blank region can be blank under a stretch. The stroke is deliberately thick
 *     (10 px → ~3.3 pt once fitted) so a 20 pt-tall region holds well over the 2 % the harness asks for; a hairline
 *     curve crossing a region diagonally is a flaky assertion, not a stronger one.
 *  2. **Transparency is real, and is verified as such.** The canvas is `PNG32` on `xc:none`, and the copy CI uploads
 *     is checked on the host for its channel set and its alpha range — the same two readings `watermark-logo.png`
 *     gets, for the same reason: an opaque white rectangle where a signature should be is invisible to every
 *     structural assertion.
 *
 * Drawn by the engine rather than by `png-writer.ts` because that writer is RGB-only (colour type 2) on purpose;
 * adding an alpha branch for one fixture would mean a second encoder whose own bugs are untested.
 */
async function writeSignatureInk(): Promise<number> {
  const name = 'signature-ink';
  const target = `${CONTAINER_TMP}/${name}.png`;
  const drawn = await magick([
    '-size',
    '600x220',
    'xc:none',
    '-stroke',
    '#101a3a',
    '-strokewidth',
    '10',
    '-fill',
    'none',
    '-draw',
    "path 'M 30,72 C 70,40 120,38 165,62 C 210,88 250,92 300,62 C 350,32 400,38 450,70 C 490,92 530,80 570,50'",
    '-stroke',
    '#101a3a',
    '-strokewidth',
    '5',
    '-draw',
    "path 'M 60,150 C 180,162 320,162 460,142 C 500,136 530,132 560,126'",
    `PNG32:${target}`,
  ]);
  if (drawn.code !== 0) {
    console.error(`${name}.png: ImageMagick failed — ${drawn.stderr.trim().split('\n').pop()}`);
    return 1;
  }

  const probe = await magick(['identify', '-format', '%m %w %h %[channels]', target]);
  const reported = probe.stdout.trim();
  const outgoing = join(OUT_DIR, `${name}.png`);
  const copied = await docker(['cp', `${CONTAINER}:${target}`, outgoing]);
  if (copied.code !== 0) {
    console.error(`${name}.png: could not copy the result back out — ${copied.stderr.trim()}`);
    return 1;
  }

  const verify = await magick(['identify', '-format', '%[channels]|%[fx:minima.a]', target]);
  const [channels, minAlpha] = verify.stdout.trim().split('|');
  const bytes = Buffer.from(await Bun.file(outgoing).arrayBuffer());
  const size = readPngSize(bytes);
  const chunks = verifyPngChunks(bytes);

  if (!channels?.includes('srgba') || minAlpha?.trim() !== '0' || reported !== 'PNG 600 220 srgba 4.0') {
    console.error(`${name}.png: verification failed — ${reported}, channels ${channels}, minimum alpha ${minAlpha}`);
    return 1;
  }
  if (!chunks.ok || size?.width !== 600 || size.height !== 220) {
    console.error(`${name}.png: the copied fixture is not a 600×220 PNG — ${JSON.stringify({ size, chunks })}`);
    return 1;
  }
  console.log(`${name}.png  ${bytes.length} bytes  ${reported}  fully transparent pixels present`);
  return 0;
}

/**
 * A signature image that breaks exactly one of `14-SIGN-AND-FORMS.md` §6's two caps: **4 100 px wide, and well under
 * 4 MB**.
 *
 * That combination is the point. The handler refuses oversized images twice — the uploaded file's size against 4 MB,
 * and what the engine opened against 4 000 px on either axis — and a fixture that broke both would only ever prove the
 * first check ran. Gradient rather than noise so it deflates to a few kilobytes, which the verification asserts
 * directly: if this fixture ever grew past 4 MB the case would silently become a test of the byte cap.
 */
async function writeOversizeSignature(): Promise<number> {
  const name = 'signature-oversize';
  const png = buildPng({
    width: 4100,
    height: 8,
    pixel: (x, y) => [(40 + (x / 4100) * 180) | 0, 60 + y * 8, 140],
  });
  const outgoing = join(OUT_DIR, `${name}.png`);
  await writeFile(outgoing, png);

  const size = readPngSize(png);
  const chunks = verifyPngChunks(png);
  if (!chunks.ok || size?.width !== 4100 || size.height !== 8) {
    console.error(`${name}.png: not a 4100×8 PNG — ${JSON.stringify({ size, chunks })}`);
    return 1;
  }
  if (png.length > 4 * 1024 * 1024) {
    console.error(`${name}.png: ${png.length} bytes — the fixture has outgrown the byte cap it is meant to avoid`);
    return 1;
  }
  console.log(`${name}.png  ${png.length} bytes  4100×8  over the pixel cap and under the byte cap`);
  return 0;
}

/**
 * An image element's file over `13-EDIT-AND-ANNOTATE.md` §6's 4 MB ceiling for `edit-pdf` — the cap that document
 * promised and no code enforced (measured in pass 9, where a 3.1 MB element image was accepted).
 *
 * **Noise, not a gradient**, and the pixel count is chosen from the *compressed* size rather than the raw one: a
 * gradient this large deflates to a few kilobytes (`signature-oversize.png` is 4 100 px wide and 2.8 KB), so a
 * gradient fixture would sit under the byte cap it exists to break. `signature-oversize.png` stays as it is for the
 * same reason it was built — it is the fixture for the *pixel* cap, which is the other half of §6's image rules.
 *
 * The generator is a seeded xorshift rather than a random one, so two runs produce the same file and a failure is
 * reproducible.
 */
async function writeOversizeElementImage(): Promise<number> {
  const name = 'element-image-oversize';
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const png = buildPng({
    width: 1200,
    height: 1200,
    pixel: () => {
      const value = next();
      return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
    },
  });
  const outgoing = join(OUT_DIR, `${name}.png`);
  await writeFile(outgoing, png);

  const size = readPngSize(png);
  const chunks = verifyPngChunks(png);
  if (!chunks.ok || size?.width !== 1200 || size.height !== 1200) {
    console.error(`${name}.png: not a 1200×1200 PNG — ${JSON.stringify({ size, chunks })}`);
    return 1;
  }
  if (png.length <= 4 * 1024 * 1024) {
    console.error(`${name}.png: ${png.length} bytes — the fixture does not break the 4 MB cap it is meant to break`);
    return 1;
  }
  console.log(`${name}.png  ${png.length} bytes  1200×1200  over the 4 MB element-image cap`);
  return 0;
}

/**
 * The EXIF-orientation pair: one JPEG whose frame is rotated by its own tag, and the same pixels without a tag.
 *
 * `images-to-pdf` promises that EXIF orientation is applied (`docs/05-IMAGES-TO-PDF.md` §2/§7) and passes `-auto-orient`
 * to honour it — but nothing in the suite had ever fed it an image that carries a tag, so "the rotation was applied" was
 * unmeasured. The pair is the assertion, in both directions: the tagged file must come out 600×400 on a `fit` page (the
 * displayed frame), and its untagged twin must come out 400×600 (the stored one).
 *
 * The tag is written **byte by byte on the host** rather than with ImageMagick's `-orient`, and that is a measurement
 * rather than a preference: `magick in.png -orient RightTop out.jpg` writes no orientation tag at all — `identify`
 * reports `Undefined` on its own output — so a fixture made that way would test nothing while looking like it did. The
 * APP1 segment is a minimal little-endian TIFF header with one IFD entry (`0x0112`, SHORT, value 6 = "rotate 90 CW"),
 * inserted after the SOI marker, and the container's own reader is asked to confirm it before the fixture is kept.
 */
async function writeExifOrientation(): Promise<number> {
  const name = 'images-to-pdf-exif-6';
  const source = join(OUT_DIR, 'images-to-pdf-portrait.jpg');

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await Bun.file(source).arrayBuffer());
  } catch {
    console.error(`${name}.jpg: ${source} is missing, so there is nothing to tag`);
    return 1;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    console.error(`${name}.jpg: the source is not a JPEG (SOI marker missing)`);
    return 1;
  }

  const tiff = Buffer.concat([
    Buffer.from('II', 'latin1'),
    Buffer.from([0x2a, 0x00]),
    Buffer.from([0x08, 0x00, 0x00, 0x00]),
  ]);
  const ifd = Buffer.concat([
    Buffer.from([0x01, 0x00]),
    Buffer.from([0x12, 0x01, 0x03, 0x00]),
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x06, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff, ifd]);
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);

  const outgoing = join(OUT_DIR, `${name}.jpg`);
  await writeFile(outgoing, Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]));

  const copied = await docker(['cp', outgoing, `${CONTAINER}:${CONTAINER_TMP}/${name}.jpg`]);
  if (copied.code !== 0) {
    console.error(`${name}.jpg: could not copy into ${CONTAINER}: ${copied.stderr.trim()}`);
    return 1;
  }

  // Two readings, both from the engine that will read it in production: the tag is there and the engine names it, and
  // the stored grid is the untagged fixture's own 400×600 (so the *page* difference in the case comes from the tag and
  // from nothing else).
  const probe = await magick(['identify', '-format', '%w %h %[orientation]', `${CONTAINER_TMP}/${name}.jpg`]);
  const described = probe.stdout.trim();
  if (described !== '400 600 RightTop') {
    console.error(`${name}.jpg: the injected tag did not survive — identify says "${described}"`);
    return 1;
  }
  console.log(`${name}.jpg  ${segment.length} bytes of APP1 added  stored 400×600  orientation RightTop`);
  return 0;
}

/**
 * A multi-frame TIFF and a single-frame one.
 *
 * The multi-frame file is the one that makes `docs/05-IMAGES-TO-PDF.md` §2 checkable: "multi-frame TIFF contributes one
 * page per frame" is a claim about pages *and their order*, so the three frames have three different sizes — 120×90,
 * 90×120 and 60×60 — and each becomes a page of its own size at 72 dpi. The single-frame twin is the format-coverage
 * case that does not depend on the frame walk.
 *
 * Written by the engine, like the JPEG/WEBP conversions: libtiff is in the image and is not on the host, and a TIFF
 * hand-written by this script would be a second encoder nobody tests.
 */
async function writeTiffs(): Promise<number> {
  let failures = 0;

  const frames = await magick([
    '-size',
    '120x90',
    'xc:#2b4f7a',
    '-size',
    '90x120',
    'xc:#7a3f2b',
    '-size',
    '60x60',
    'xc:#3f7a52',
    `${CONTAINER_TMP}/images-to-pdf-frames.tiff`,
  ]);
  if (frames.code !== 0) {
    console.error(`images-to-pdf-frames.tiff: ImageMagick failed — ${frames.stderr.trim().split('\n').pop()}`);
    return 1;
  }

  const single = await magick(['-size', '100x100', 'xc:#444444', `${CONTAINER_TMP}/images-to-pdf-single.tiff`]);
  if (single.code !== 0) {
    console.error(`images-to-pdf-single.tiff: ImageMagick failed — ${single.stderr.trim().split('\n').pop()}`);
    return 1;
  }

  const expectations: Array<[string, string]> = [
    ['images-to-pdf-frames.tiff', '0:120:90|1:90:120|2:60:60'],
    ['images-to-pdf-single.tiff', '0:100:100'],
  ];

  for (const [name, expected] of expectations) {
    const probe = await magick(['identify', '-format', '%s:%w:%h|', `${CONTAINER_TMP}/${name}`]);
    const described = probe.stdout.trim().replace(/\|$/, '');
    if (described !== expected) {
      console.error(`${name}: expected frames ${expected}, identify says "${described}"`);
      failures += 1;
      continue;
    }

    const outgoing = join(OUT_DIR, name);
    const copied = await docker(['cp', `${CONTAINER}:${CONTAINER_TMP}/${name}`, outgoing]);
    if (copied.code !== 0) {
      console.error(`${name}: could not copy the result back out — ${copied.stderr.trim()}`);
      failures += 1;
      continue;
    }

    // The API detects the type from the bytes and the magic is the TIFF header, so a fixture the uploader would refuse
    // is a fixture that proves nothing about this tool: asserted on the copy CI uploads, not in the container.
    const bytes = Buffer.from(await Bun.file(outgoing).arrayBuffer());
    const magic = bytes.subarray(0, 4).toString('latin1');
    if (magic !== 'II*\u0000' && magic !== 'MM\u0000*') {
      console.error(`${name}: the copied fixture has no TIFF magic (${JSON.stringify(magic)})`);
      failures += 1;
      continue;
    }
    console.log(`${name}  ${bytes.length} bytes  ${described.split('|').length} frame(s)  ${described}`);
  }

  return failures;
}

/**
 * A HEIC-**branded** container that no decoder can read, for the two paths that can be checked without a HEIC decoder.
 *
 * A real HEIC cannot be produced in this image and pretending otherwise is what this file has always refused to do:
 * `heif-enc` is present but reports "No HEVC encoder available" (measured), ImageMagick reports the format read-only
 * (`r--`, no encoder), and no phone photo is committed here. So the fixture is an ISO base-media container with the
 * `ftyp` box and the `heic` brand that `apps/api/src/shared/detect-type.ts` keys on, followed by an `mdat` box of bytes
 * that are not image data.
 *
 * It therefore proves exactly two things, both of them real: the API detects the file as `image/heic` (so the request is
 * accepted and reaches the handler), and `heicFallback: 'reject'` refuses it **before any engine runs** while the default
 * policy reports a decode failure instead of a blank page. What remains unproven is written down in
 * `docs/0-E2E-CHECKLIST.md`: that a genuine HEIC decodes to a page.
 */
async function writeHeicBranded(): Promise<number> {
  const name = 'images-to-pdf-heic-branded';
  const ftypPayload = Buffer.concat([
    Buffer.from('heic', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('mif1heic', 'latin1'),
  ]);
  const ftyp = Buffer.concat([
    Buffer.from([
      (ftypPayload.length + 8) >> 24,
      (ftypPayload.length + 8) >> 16,
      (ftypPayload.length + 8) >> 8,
      ftypPayload.length + 8,
    ]),
    Buffer.from('ftyp', 'latin1'),
    ftypPayload,
  ]);
  const junk = Buffer.from('not image data — a HEIC-branded container with no codestream in it', 'latin1');
  const mdat = Buffer.concat([
    Buffer.from([(junk.length + 8) >> 24, (junk.length + 8) >> 16, (junk.length + 8) >> 8, junk.length + 8]),
    Buffer.from('mdat', 'latin1'),
    junk,
  ]);

  const bytes = Buffer.concat([ftyp, mdat]);
  const outgoing = join(OUT_DIR, `${name}.heic`);
  await writeFile(outgoing, bytes);

  // The signature the API reads, asserted here so a rename or a copy that mangles the file is a fixture failure rather
  // than a mysterious "the tool does not accept that file type" in a case.
  if (bytes.subarray(4, 12).toString('latin1') !== 'ftypheic') {
    console.error(`${name}.heic: the brand bytes are ${JSON.stringify(bytes.subarray(4, 12).toString('latin1'))}`);
    return 1;
  }

  const copied = await docker(['cp', outgoing, `${CONTAINER}:${CONTAINER_TMP}/${name}.heic`]);
  if (copied.code !== 0) {
    console.error(`${name}.heic: could not copy into ${CONTAINER}: ${copied.stderr.trim()}`);
    return 1;
  }

  // And the honest half: nothing in this image can decode it, which is what the two cases assert.
  const probe = await magick(['identify', `${CONTAINER_TMP}/${name}.heic`]);
  if (probe.code === 0) {
    console.error(`${name}.heic: identify decoded it, so it is not the undecodable fixture this case needs`);
    return 1;
  }
  console.log(
    `${name}.heic  ${bytes.length} bytes  ftyp/heic brand  undecodable: ${probe.stderr.trim().split('\n').pop()}`,
  );
  return 0;
}

await main();
