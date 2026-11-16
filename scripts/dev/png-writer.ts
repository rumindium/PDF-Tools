import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder, for the same reason `pdf-writer.ts` exists: the fixtures have to be *generated* by us, or
 * they become binaries somebody copied into the repository once and nobody can explain afterwards.
 *
 * Why hand-rolled rather than a dependency: `images-to-pdf` needs real image bytes (magic bytes the API's
 * detection layer reads, dimensions ImageMagick measures), and PNG is the one image format that can be written in
 * ~100 lines — it is a signature, three chunks, and zlib, all of which `node:zlib` already provides. JPEG and
 * WebP cannot be, which is why those are produced by converting this output inside the worker image (see
 * `make-image-fixtures.ts`).
 *
 * The images are deliberately flat-coloured bands: they compress to a few kilobytes each, they are obviously
 * different from one another in a PDF viewer, and the dimensions are asymmetric per variant so `orientation: auto`
 * has something real to detect.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour type 2 — truecolour RGB, 8 bits per channel, no alpha. */
const COLOUR_TYPE_RGB = 2;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export interface PngSpec {
  width: number;
  height: number;
  /** Colour of pixel `(x, y)`; the caller decides, so one encoder can produce several distinct fixtures. */
  pixel: (x: number, y: number) => [number, number, number];
}

export function buildPng(spec: PngSpec): Buffer {
  const { width, height, pixel } = spec;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`invalid PNG dimensions ${width}x${height}`);
  }

  // One filter byte per row (0 = None) followed by RGB triplets. Filtering exists to help the compressor; flat
  // bands already deflate to almost nothing, so paying for a filter pass here would buy nothing.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = COLOUR_TYPE_RGB;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Width and height from the IHDR chunk. Used by the fixture script to prove what it wrote, not what it intended. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Every chunk's stored CRC, checked against the bytes — an encoder bug is caught here, not by ImageMagick. */
export function verifyPngChunks(bytes: Uint8Array): { chunks: number; ok: boolean } {
  const buffer = Buffer.from(bytes);
  let offset = 8;
  let chunks = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const body = buffer.subarray(offset + 4, offset + 8 + length);
    const stored = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(body) !== stored) return { chunks, ok: false };
    chunks += 1;
    offset += 12 + length;
    if (buffer.subarray(offset - 8, offset - 4).toString('latin1') === 'IEND') break;
  }
  return { chunks, ok: chunks >= 3 };
}
