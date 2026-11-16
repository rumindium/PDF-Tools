import { describe, expect, test } from 'bun:test';
import { imageFormat, readImageHeader } from './image-inspect';

/**
 * The reader's tests, written around the shapes that would make an image case *pass* for the wrong reason.
 *
 * The failures worth testing are not "it reads a PNG" — that is what the golden cases do with real files — but the
 * near-misses: dimensions that sit at a variable offset (every JPEG with an APP segment), a value with more than one
 * possible location (a WEBP's size in the wrapper or in the bitstream), a colour type that carries alpha without
 * saying so in a flag, and the `null` that must not be confused with a number. A reader that returned `0` for
 * "unknown" would make `--expect-image-bits 0=1` fail loudly and `--expect-image-channels 0=0` pass silently.
 */

function bytesOf(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function png(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  out.push(0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52); // length 13, "IHDR"
  out.push((width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff);
  out.push((height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff);
  out.push(bitDepth, colorType, 0, 0, 0);
  while (out.length < 33) out.push(0);
  return bytesOf(out);
}

/**
 * A JPEG with the frame header *after* an application segment, which is the only arrangement that catches a reader
 * that assumes a fixed offset. `appSegments` also lets a case put EXIF in front, the way a camera file arrives.
 */
function jpeg(width: number, height: number, components: number, appSegments = 1): Uint8Array {
  const out = [0xff, 0xd8];
  for (let index = 0; index < appSegments; index += 1) {
    out.push(0xff, 0xe0 + index, 0x00, 0x10); // APPn, length 16 including itself
    for (let pad = 0; pad < 14; pad += 1) out.push(0x20);
  }
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08); // SOF0, length 17, precision 8
  out.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, components);
  while (out.length < 80) out.push(0);
  return bytesOf(out);
}

function webpChunk(fourcc: string, payload: number[]): Uint8Array {
  const out = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
  const total = 4 + 4 + 8 + payload.length;
  out.push(total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff, (total >> 24) & 0xff);
  out.push(0x57, 0x45, 0x42, 0x50); // "WEBP"
  for (const char of fourcc) out.push(char.charCodeAt(0));
  out.push(
    payload.length & 0xff,
    (payload.length >> 8) & 0xff,
    (payload.length >> 16) & 0xff,
    (payload.length >> 24) & 0xff,
  );
  out.push(...payload);
  return bytesOf(out);
}

function webpExtended(width: number, height: number, alpha: boolean): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return webpChunk('VP8X', [
    alpha ? 0x10 : 0x00,
    0,
    0,
    0,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
}

function webpLossless(width: number, height: number, alpha: boolean): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  return webpChunk('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return webpChunk('VP8 ', [
    0x00,
    0x00,
    0x00, // frame tag
    0x9d,
    0x01,
    0x2a, // start code
    width & 0xff,
    (width >> 8) & 0x3f,
    height & 0xff,
    (height >> 8) & 0x3f,
  ]);
}

describe('readImageHeader', () => {
  test('reads a PNG through IHDR, including the bi-level case that is the point of the module', () => {
    expect(readImageHeader(png(595, 842, 8, 2))).toEqual({
      format: 'png',
      width: 595,
      height: 842,
      bitDepth: 8,
      channels: 3,
      alpha: false,
    });
    // The `bw` assertion: one bit, one channel, no alpha.
    expect(readImageHeader(png(2480, 3509, 1, 0))).toMatchObject({ bitDepth: 1, channels: 1, alpha: false });
    // A palette PNG carries RGB through an index table, so its colour type still counts as one channel.
    expect(readImageHeader(png(10, 10, 4, 3))).toMatchObject({ channels: 1, bitDepth: 4 });
    // Alpha is a colour type: 6 is RGBA and 4 is grey+alpha, and neither is a flag.
    expect(readImageHeader(png(10, 10, 8, 6))).toMatchObject({ channels: 4, alpha: true });
    expect(readImageHeader(png(10, 10, 8, 4))).toMatchObject({ channels: 2, alpha: true });
  });

  test('finds the JPEG frame header past however many application segments precede it', () => {
    expect(readImageHeader(jpeg(2480, 3509, 3, 0))).toMatchObject({
      format: 'jpeg',
      width: 2480,
      height: 3509,
      bitDepth: 8,
      channels: 3,
    });
    // The one that catches a fixed offset: EXIF in front of the frame header.
    expect(readImageHeader(jpeg(595, 842, 1, 2))).toMatchObject({ width: 595, height: 842, channels: 1 });
  });

  test('reads all three WEBP containers, and reports the value each one actually carries', () => {
    expect(readImageHeader(webpExtended(595, 842, false))).toMatchObject({
      format: 'webp',
      width: 595,
      height: 842,
      alpha: false,
    });
    expect(readImageHeader(webpExtended(1240, 1754, true))).toMatchObject({ width: 1240, height: 1754, alpha: true });
    expect(readImageHeader(webpLossless(2480, 3509, false))).toMatchObject({ width: 2480, height: 3509, alpha: false });
    expect(readImageHeader(webpLossy(2480, 3509))).toMatchObject({
      width: 2480,
      height: 3509,
      // A lossy WEBP has no alpha field to read: the format is three-channel by construction. `null` rather than
      // `false`, because \"the container does not say\" and \"the container says no\" are different answers and only one
      // of them is assertable.
      alpha: null,
      channels: null,
      bitDepth: null,
    });
  });

  test('refuses anything whose header it cannot read, rather than answering with a zero', () => {
    expect(readImageHeader(bytesOf([]))).toBeNull();
    expect(readImageHeader(bytesOf([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))).toBeNull();
    // A PNG signature with the wrong first chunk: valid-looking bytes, no dimensions to read.
    const wrongChunk = png(10, 10, 8, 2);
    wrongChunk.set([0x74, 0x52, 0x4e, 0x53], 12); // "tRNS" where IHDR must be
    expect(readImageHeader(wrongChunk)).toBeNull();
    // Truncated before the dimensions.
    expect(readImageHeader(png(10, 10, 8, 2).slice(0, 20))).toBeNull();
    expect(readImageHeader(bytesOf([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  test('answers the format question on its own, for cases that only assert a container', () => {
    expect(imageFormat(png(10, 10, 8, 2))).toBe('png');
    expect(imageFormat(jpeg(10, 10, 3))).toBe('jpeg');
    expect(imageFormat(webpLossless(10, 10, false))).toBe('webp');
    expect(imageFormat(bytesOf([1, 2, 3, 4]))).toBeNull();
  });
});
