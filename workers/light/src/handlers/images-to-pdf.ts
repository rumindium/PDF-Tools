import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImagesToPdfOptions } from '@pdftools/contracts/tools';
import { buildQpdfPagesArgs, magickOrThrow, qpdfOrThrow, runQpdf } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `images-to-pdf` — `docs/05-IMAGES-TO-PDF.md`.
 *
 * Two engines, one after the other, because each is good at one half: ImageMagick turns *one* image into a
 * *one-page* PDF with exact control over the page box, and qpdf concatenates those documents without re-encoding
 * anything. Asking either engine to do the whole job would mean either a page-size guess (magick decides the box per
 * image) or a re-render (qpdf cannot place images).
 *
 * The physical page is expressed in points at 72 dpi (`-units PixelsPerInch -density 72`), so "A4" in the UI and
 * "595×842" in the command are the same number — a conversion that silently depends on the image's own EXIF
 * resolution is the classic reason a scanned A4 comes out at 96 % and looks wrong when printed.
 *
 * The user's file order is the page order. `order` wins when it names file ids, otherwise the upload order is
 * used, exactly as in `merge`; a support conversation about "the pages came out shuffled" is settled by reading
 * the argument list.
 *
 * Every image is **probed once** (`identify`) before anything is converted, and the four warnings this document
 * promises come out of that probe rather than out of good intentions: the orientation tag that `-auto-orient` is about
 * to apply, the alpha channel a fixed page box is about to composite away, the upscale a fixed page box implies, and
 * the HEIC that had to be transcoded to be placed at all. Before pass 5 the only warning this handler could emit was
 * `PAGE_SIZE_FOLLOWS_IMAGE` — which the document did not mention — while all four of the documented ones were
 * unreachable (defect 139).
 *
 * The probe is also what makes `orientation: auto` mean what the document says. `identify` reports the **stored**
 * dimensions, and a phone photo stores a landscape frame with a rotate-me tag; the dimensions this handler reasons
 * about are therefore the *displayed* ones, and the two differ by exactly the orientation tag.
 */

/** Media boxes in PostScript points (1 pt = 1/72 inch). */
const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 595, height: 842 },
  a3: { width: 842, height: 1191 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
};

const MM_TO_PT = 72 / 25.4;

/**
 * The orientation values that mean "rotate this image before showing it" — EXIF 5–8, and 2/3/4 (mirrored, and
 * upside-down) for the same reason: the *stored* pixel grid is not the frame the user sees.
 *
 * `Undefined` is what ImageMagick reports for an image with no orientation tag at all, which is most of them; it is
 * listed explicitly because a case asserting that a warning is *absent* has to be able to trust this predicate.
 */
const ROTATED_ORIENTATIONS = new Set([
  'TopRight',
  'BottomRight',
  'BottomLeft',
  'LeftTop',
  'RightTop',
  'RightBottom',
  'LeftBottom',
]);

interface ImageProbe {
  /** Stored pixel dimensions, as the engine reports them. */
  width: number;
  height: number;
  /** The EXIF orientation name, or `Undefined`. */
  orientation: string;
  /** Whether the image carries an alpha channel (`srgba`, `graya`…). */
  hasAlpha: boolean;
}

export const imagesToPdf: Handler<ImagesToPdfOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  if (files.length === 0) {
    throw new JobFailure('VALIDATION_ERROR', { message: 'Add at least one image.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const ordered = options.order?.length
    ? [...files].sort((a, b) => {
        const ai = options.order!.indexOf(a.id);
        const bi = options.order!.indexOf(b.id);
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
      })
    : [...files];

  // The tenant's HEIC policy is answered **before any engine is asked to decode anything**. It used to be checked in
  // the failure branch, which made `reject` a policy about a failure rather than a policy about a file: the job still
  // ran the conversion, and a HEIC that decoded fine was accepted under a rule that forbids transcoding it (defect
  // 139). Both halves of the input's identity are consulted, because neither is complete on its own: the extension is
  // what a user sees, and the detected type is what the bytes are — a photo named `.jpg` that is really HEIC has to
  // obey the same policy, and the payload now carries the type for exactly this (see `packages/queue/src/runtime.ts`).
  if (options.heicFallback === 'reject') {
    const heic = ordered.find(isHeic);
    if (heic) {
      throw new JobFailure('UNSUPPORTED_CONTENT', {
        message: `"${heic.name}" is a HEIC image and this job is configured to reject them rather than transcode. Re-save it as JPEG, or allow conversion.`,
      });
    }
  }

  const pagesDir = join(workDir, 'pages');
  await mkdir(pagesDir, { recursive: true });

  const marginPt = Math.round(options.margin * MM_TO_PT);
  const fixed = options.pageSize !== 'fit' ? PAGE_SIZES[options.pageSize] : null;
  const pagePaths: string[] = [];
  const collected = new WarningCollector();

  for (const [index, file] of ordered.entries()) {
    report({
      progress: 8 + Math.round((index / ordered.length) * 70),
      phase: 'processing',
      message: `Placing image ${index + 1} of ${ordered.length}.`,
    });

    const target = join(pagesDir, `page-${String(index + 1).padStart(4, '0')}.pdf`);
    const args: string[] = [file.path, '-auto-orient', '-units', 'PixelsPerInch', '-density', '72'];

    const heic = isHeic(file);
    // One probe for four decisions: the page box `orientation: auto` needs, the upscale check, the alpha the output
    // will or will not carry, and the orientation tag `-auto-orient` is about to bake in. A probe that fails is not
    // fatal on its own — the conversion below reports the engine's own error, with the HEIC case given a specific
    // message — so a `null` here only means the warnings that depend on it are not claimed.
    const probe = await probeImage(file.path, runOpts).catch(() => null);

    if (probe) {
      if (ROTATED_ORIENTATIONS.has(probe.orientation)) {
        collected.add(
          'EXIF_ORIENTATION_APPLIED',
          `${file.name} carries the orientation tag "${probe.orientation}", which was applied so the page is upright.`,
        );
      }
      // Only for a fixed page box. With `fit` the page *is* the image, and the alpha survives — measured: the delivered
      // page renders `srgba` with a fully transparent corner, because ImageMagick writes a soft mask beside the JPEG.
      if (probe.hasAlpha && fixed) {
        collected.add('ALPHA_FLATTENED', `Transparency in ${file.name} was composited onto white for the page box.`);
      }
    }

    if (!fixed) {
      // `fit`: the page takes the image's own proportions, so only the margin is expressed.
      if (marginPt > 0) args.push('-bordercolor', 'white', '-border', String(marginPt));
      args.push('-compress', 'jpeg', '-quality', '92');
    } else {
      // Orientation `auto` follows the image — and the *displayed* image, which for a rotated EXIF tag is the transpose
      // of what the engine reports: a phone photo stored 4032×3024 with orientation 6 is a portrait photo, and
      // choosing a sheet from the stored numbers would give it a landscape one it does not fill.
      const observed = displayOrientation(probe);
      const box = resolveBox(fixed, options.orientation, observed);
      const content = {
        width: Math.max(1, box.width - marginPt * 2),
        height: Math.max(1, box.height - marginPt * 2),
      };

      if (options.fit === 'cover') {
        args.push('-resize', `${content.width}x${content.height}^`);
      } else if (options.fit === 'stretch') {
        args.push('-resize', `${content.width}x${content.height}!`);
      } else {
        args.push('-resize', `${content.width}x${content.height}`);
      }

      // The document's promise about a small image on a large page: it is upscaled, and the UI offers "use fit
      // instead". `contain` and `cover` both scale up to fill what they can; only `stretch` is a different promise, and
      // it is asked for explicitly.
      if (probe && options.fit !== 'stretch') {
        const scale = Math.min(content.width / probe.width, content.height / probe.height);
        if (scale > 1) {
          collected.add(
            'IMAGE_UPSCALED',
            `${file.name} is ${probe.width}×${probe.height} px and was enlarged to fill a ${options.pageSize} page.`,
          );
        }
      }

      // The extent is what fixes the page box: without it magick writes a PDF the size of the pixels, not the
      // size of the sheet, and the margin disappears.
      args.push('-background', 'white', '-gravity', 'center', '-extent', `${content.width}x${content.height}`);
      if (marginPt > 0) args.push('-bordercolor', 'white', '-border', String(marginPt));
      args.push('-compress', 'jpeg', '-quality', '92');
    }

    args.push(target);

    try {
      await magickOrThrow(args, runOpts);
    } catch (error) {
      // HEIC is the one format whose support depends on the image's delegate set rather than on ImageMagick
      // itself, so the failure gets a specific, actionable message instead of a generic conversion error.
      if (heic) {
        throw new JobFailure('UNSUPPORTED_CONTENT', {
          message:
            'The HEIC image could not be decoded on this installation. Re-save the photo as JPEG, or submit it with the HEIC policy set to reject to refuse it before conversion.',
          stderrTail: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    if (heic) {
      collected.add('HEIC_TRANSCODED', `${file.name} was decoded by libheif and re-encoded as part of the page.`);
    }

    pagePaths.push(target);
  }

  report({ progress: 84, phase: 'processing', message: 'Assembling the document.' });

  const outputPath = join(outputDir, 'images.pdf');
  // One *document* per input image, concatenated with every one of its pages. The range is deliberately omitted rather
  // than set to `1`: a multi-frame TIFF produces a multi-page intermediate in that single magick call, and asking qpdf
  // for page 1 of it dropped the other frames — the tool reported one page for a four-frame scan while every count in
  // the job agreed with itself (defect 140). `buildQpdfPagesArgs`' default is `1-z`, which is all of them.
  await qpdfOrThrow(
    buildQpdfPagesArgs(
      pagePaths.map((page) => ({ path: page })),
      outputPath,
    ),
    runOpts,
  );

  // The one plan ceiling that has to live in a handler, and not because of where it was written: this tool's inputs are
  // images, so the runtime's page re-check has no PDF to read and the produced document is the first page count the job
  // has. `planMaxPages` is the plan's ceiling (`limits.maxPages` is the tool's, `0` for every tool in the registry, which
  // is why this comparison never ran — defect 154).
  const outputPages = await countPdfPages(outputPath, runOpts);
  if (limits.planMaxPages > 0 && outputPages != null && outputPages > limits.planMaxPages) {
    throw new JobFailure('PAGE_LIMIT_EXCEEDED_JOB', {
      message: `This job produced ${outputPages} pages, above this plan's limit of ${limits.planMaxPages}.`,
    });
  }

  if (options.pageSize === 'fit') {
    collected.add(
      'PAGE_SIZE_FOLLOWS_IMAGE',
      'No page size was chosen, so each page takes the proportions of its image.',
    );
  }

  report({ progress: 92, phase: 'finalizing' });

  return {
    outputs: [{ name: 'images.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      inputImages: ordered.length,
      outputPages,
      pageSize: options.pageSize,
      fit: options.fit,
      marginMm: options.margin,
    },
    warnings: collected.list(),
    engine: { name: 'imagemagick' },
  };
};

/**
 * The documented warnings, keyed so each code is reported **once** however many images raised it.
 *
 * A forty-photo job produces one sentence about alpha, not forty: the warning is about what the job did, and the
 * detail names the files it applies to. Deduplicating here rather than at the call site is what keeps a handler that
 * grows a fifth warning from quietly turning into a warning list nobody reads.
 */
class WarningCollector {
  private readonly byCode = new Map<string, { code: string; files: string[]; detail: string }>();

  add(code: string, detail: string): void {
    const existing = this.byCode.get(code);
    if (existing) {
      if (existing.files.length < 3) existing.files.push(detail);
      return;
    }
    this.byCode.set(code, { code, files: [detail], detail });
  }

  list(): Array<{ code: string; detail: string }> {
    return [...this.byCode.values()].map((entry) => ({
      code: entry.code,
      detail: entry.files.length === 1 ? entry.detail : `${entry.files.length} images: ${entry.files.join(' ')}`,
    }));
  }
}

/** Whether this input is a HEIC/HEIF — by what the bytes are (`detectedType`) or by what the user called it. */
function isHeic(file: { name: string; detectedType?: string }): boolean {
  const name = file.name.toLowerCase();
  const type = (file.detectedType ?? '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif');
}

/**
 * One `identify` for dimensions, orientation and channels.
 *
 * Cheap by design: the engine is already going to read every pixel, and this reads only the header, which is what makes
 * it affordable to ask before converting rather than after.
 */
async function probeImage(path: string, runOpts: Parameters<typeof runQpdf>[1]): Promise<ImageProbe | null> {
  // `%[channels]` prints its depth beside the set (`srgba 4.0`), which is why it is last: the alpha test is a substring
  // and the number after it belongs to a different question.
  const result = await magickOrThrow(['identify', '-format', '%w|%h|%[orientation]|%[channels]', path], {
    ...runOpts,
    timeoutMs: Math.min(runOpts.timeoutMs, 20_000),
  });
  const [widthRaw, heightRaw, orientationRaw, channelsRaw] = result.stdout.trim().split('|');
  const width = Number.parseInt(widthRaw ?? '', 10);
  const height = Number.parseInt(heightRaw ?? '', 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  // The channel *set* is the first token (`srgba 4.0`, `srgb  4.0`) and the alpha channel is the trailing `a` of it. A
  // `\ba\b` test against the whole string was the first version of this line and it never matched inside `srgba` — a word
  // boundary requires a non-word character on both sides — so the warning it fed could not fire at all (defect 142).
  const channelSet = (channelsRaw ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  return {
    width,
    height,
    orientation: (orientationRaw ?? 'Undefined').trim(),
    hasAlpha: channelSet.endsWith('a'),
  };
}

/** Portrait/landscape as the page will *show* it, from the stored grid and the orientation tag. */
function displayOrientation(probe: ImageProbe | null): 'portrait' | 'landscape' {
  if (!probe) return 'portrait';
  const rotated = ROTATED_ORIENTATIONS.has(probe.orientation);
  const width = rotated ? probe.height : probe.width;
  const height = rotated ? probe.width : probe.height;
  return width > height ? 'landscape' : 'portrait';
}

function resolveBox(
  size: { width: number; height: number },
  orientation: 'auto' | 'portrait' | 'landscape',
  observed: 'portrait' | 'landscape',
): { width: number; height: number } {
  const effective = orientation === 'auto' ? observed : orientation;
  if (effective === 'landscape') {
    return size.width > size.height ? size : { width: size.height, height: size.width };
  }
  return size.width < size.height ? size : { width: size.height, height: size.width };
}

async function countPdfPages(path: string, runOpts: Parameters<typeof runQpdf>[1]): Promise<number | null> {
  const result = await runQpdf(['--show-npages', path], { ...runOpts, timeoutMs: 30_000 });
  if (result.code !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}
