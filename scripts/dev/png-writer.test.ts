import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { buildPng, readPngSize, verifyPngChunks } from './png-writer';

/**
 * The encoder exists so the image fixtures are generated rather than committed as unexplained binaries, which only
 * holds if a wrong encoder is caught here. `images-to-pdf` would otherwise fail three steps later with an
 * ImageMagick message about a corrupt file and no indication that the fixture was the problem.
 */

function bands(width: number, height: number) {
  return buildPng({
    width,
    height,
    pixel: (x, y) => [Math.round((x / width) * 255), Math.round((y / height) * 255), 64],
  });
}

describe('buildPng', () => {
  test('starts with the PNG signature and carries the size it was given', () => {
    const png = bands(40, 25);
    expect(png.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    expect(readPngSize(png)).toEqual({ width: 40, height: 25 });
  });

  test('every chunk CRC is valid and the stream ends where it should', () => {
    const png = bands(16, 16);
    expect(verifyPngChunks(png)).toEqual({ chunks: 3, ok: true });
    expect(png.subarray(png.length - 8).toString('latin1')).toContain('IEND');
  });

  test('IDAT inflates to one filter byte plus three bytes per pixel, per row', () => {
    const width = 12;
    const height = 7;
    const png = bands(width, height);
    // Chunk layout is fixed: 8 signature + (12 + 13 IHDR) + (12 + len IDAT) + 12 IEND.
    const idatLength = png.readUInt32BE(8 + 12 + 13);
    const idat = png.subarray(8 + 12 + 13 + 8, 8 + 12 + 13 + 8 + idatLength);
    const raw = inflateSync(idat);
    expect(raw.length).toBe(height * (width * 3 + 1));
    expect([...raw.subarray(0, width * 3 + 1)][0]).toBe(0); // filter byte: None
  });

  test('two different specs produce two different files', () => {
    const portrait = bands(20, 40);
    const landscape = bands(40, 20);
    expect(portrait.equals(landscape)).toBe(false);
    expect(readPngSize(portrait)).toEqual({ width: 20, height: 40 });
    expect(readPngSize(landscape)).toEqual({ width: 40, height: 20 });
  });

  test('refuses dimensions that cannot be encoded', () => {
    expect(() => bands(0, 10)).toThrow();
    expect(() => bands(10, 2.5)).toThrow();
  });
});

describe('readPngSize', () => {
  test('returns null for bytes that are not a PNG', () => {
    expect(readPngSize(new TextEncoder().encode('not a png at all'))).toBeNull();
    expect(readPngSize(new Uint8Array(0))).toBeNull();
  });
});

describe('verifyPngChunks', () => {
  test('reports a corrupted payload rather than trusting the file', () => {
    const png = bands(16, 16);
    const tampered = Buffer.from(png);
    tampered.writeUInt8(tampered.readUInt8(25) ^ 0xff, 25); // flip a byte inside IHDR
    expect(verifyPngChunks(tampered).ok).toBe(false);
  });
});
