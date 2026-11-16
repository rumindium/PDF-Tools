/**
 * Read what an image file *says about itself*, from its header, without decoding a pixel.
 *
 * The rasterizer's output is the product, and until this module existed nothing in the harness could see it: the
 * golden suite checked page counts, part names and page labels for `pdf-to-images` and never once looked at an image.
 * That made three of the document's claims unassertable — the pixel dimensions at a given dpi, whether `grayscale`
 * really produced one channel, and whether `bw` produced a 1-bit file — and the last of the three was not even true
 * (see `docs/06-PDF-TO-IMAGES.md` §7 and pass 3 of `0-E2E-CHECKLIST.md`).
 *
 * A header parse rather than an image library, for the reasons the whole harness is one: it runs in CI, it must not
 * need a decoder, and every field it reports is a **container** fact — what the file declares, not what a decoder
 * decided. The exceptions are marked `null` instead of guessed at, because an assertion about a value nobody wrote
 * down is a test of the guess.
 *
 * `channels` is the container's own arithmetic: PNG says it through a colour type (with a palette counting as one
 * channel), JPEG through its component count, and WEBP not at all — a lossy or lossless WEBP is always three or four
 * channels by construction, and it reports alpha instead of a count.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
  /** Bits per channel as the container stores it (`1` for a bi-level PNG), or `null` where it does not say. */
  bitDepth: number | null;
  /** Channels the container declares, or `null` where the format has no field for it. */
  channels: number | null;
  /** Whether alpha is carried, or `null` where the header does not say (lossy WEBP). */
  alpha: boolean | null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG colour types, as the count of channels they carry — the field IHDR puts in byte 9. */
const PNG_COLOR_TYPE_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

/** Magic bytes only, for the case where a format is all that is being asserted. */
export function imageFormat(bytes: Uint8Array): ImageFormat | null {
  return readImageHeader(bytes)?.format ?? null;
}

function readPng(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 26) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  // The first chunk must be IHDR, and its four-byte length is at 8: a file that starts with anything else is either
  // truncated or has been extended in a way that puts the dimensions somewhere this reader does not look.
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  if (chunkType !== 'IHDR') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = bytes[25]!;
  const channels = PNG_COLOR_TYPE_CHANNELS[colorType] ?? null;
  return {
    format: 'png',
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24]!,
    channels,
    // Alpha is a colour type, not a flag: 4 is grey+alpha and 6 is RGBA. A `tRNS` chunk can add transparency to a
    // type that has no alpha channel, which is why this reports what the *color type* says and not "no alpha" —
    // `null` would be the honest third answer but the two that matter here (opaque RGB, bi-level grey) are both 0/2.
    alpha: channels === null ? null : colorType === 4 || colorType === 6,
  };
}

/**
 * JPEG, by walking the segment markers to the frame header.
 *
 * The dimensions are **not** at a fixed offset: a JFIF file carries an APP0 segment first, an EXIF file an APP1, and
 * ImageMagick's output can hold either or both. The start-of-frame marker is the only place that says width, height
 * and component count together, and it appears after however many application segments the writer chose — so the walk
 * is the parse, and stopping at the first `SOFn` (skipping the arithmetic-coded and lossless variants that share the
 * prefix) is what makes this work on a file another tool wrote.
 */
function readJpeg(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 >= bytes.length) return null;
      return {
        format: 'jpeg',
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        bitDepth: bytes[offset + 4]!,
        channels: bytes[offset + 9]!,
        alpha: false,
      };
    }
    // A start-of-scan means the entropy-coded data begins, so there is no frame header left to find.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * WEBP, in its three container shapes.
 *
 * `VP8 ` is the lossy bitstream (dimensions in the frame header, 14 bits each, and no alpha in the format at all),
 * `VP8L` is lossless (dimensions implied by 14-bit values minus one, plus an explicit alpha bit), and `VP8X` is the
 * extended container that both of them can sit inside — where the canvas size and the alpha flag live in the wrapper
 * and the actual bitstream is a sub-chunk. The extended case is the one a converter produces, so it is read first.
 */
function readWebp(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 16) return null;
  const fourcc = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WEBP') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = fourcc(12);
  if (chunk === 'VP8X') {
    const flags = bytes[20]!;
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { format: 'webp', width, height, bitDepth: null, channels: null, alpha: (flags & 0x10) !== 0 };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    // Fourteen bits of width-1, fourteen of height-1, one alpha bit and three version bits, little-endian as one
    // 32-bit word: the whole header is four bytes, and reading them as a bit field is what keeps this honest.
    const bits = view.getUint32(21, true);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      bitDepth: null,
      channels: null,
      alpha: ((bits >>> 28) & 1) === 1,
    };
  }
  if (chunk === 'VP8 ') {
    // Three bytes of frame tag, three of start code, then the two dimension fields.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      format: 'webp',
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
      bitDepth: null,
      channels: null,
      alpha: null,
    };
  }
  return null;
}
