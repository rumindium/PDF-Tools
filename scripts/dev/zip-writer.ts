/**
 * A minimal, dependency-free ZIP writer — the archive half of the fixture writers.
 *
 * `html-to-pdf` accepts a ZIP bundle (an `index.html` plus its assets), and a fixture that cannot be regenerated is
 * a fixture nobody can trust, so the archive is written here rather than checked in as a binary. Entries are stored
 * uncompressed: the point of the fixture is that the *structure* is real (local headers, a central directory, valid
 * CRCs), not that it saves space, and a stored entry is the only kind this writer can produce without a deflate
 * implementation — which is the correct trade for a fixture, and is why the reader in `e2e/lib/pdf-inspect.ts` can
 * count entries by their local-file-header signature.
 *
 * Layout, exactly as the format defines it:
 *
 *   [local file header][data]…            per entry
 *   [central directory header]…           per entry, after all data
 *   [end of central directory]
 *
 * The CRC32 table is the standard reflected polynomial (0xEDB88320), the same one `png-writer.ts` uses for chunk
 * checksums — written out again rather than shared because a fixture writer should not depend on the image writer's
 * internals, and twelve lines is cheaper than an import that couples the two formats.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** Text is encoded as UTF-8; bytes are stored as given, for an asset that is not text (a PNG, for instance). */
  content: string | Uint8Array;
}

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

/** `PK\x01\x02` — the central directory header signature. */
const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/** MS-DOS date/time, as the format stores it. Fixed, so the same input always produces the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) * 512 + 1 * 32 + 1;

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const crc = crc32(data);
    const localOffset = offset;

    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // method 0 = stored
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true); // compressed size
    view.setUint32(22, data.length, true); // uncompressed size
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // extra length
    header.set(name, 30);
    push(header);
    push(data);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true); // central directory header
    directoryView.setUint16(4, 20, true); // version made by
    directoryView.setUint16(6, 20, true); // version needed
    directoryView.setUint16(8, 0, true);
    directoryView.setUint16(10, 0, true);
    directoryView.setUint16(12, DOS_TIME, true);
    directoryView.setUint16(14, DOS_DATE, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, data.length, true);
    directoryView.setUint32(24, data.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint16(30, 0, true); // extra
    directoryView.setUint16(32, 0, true); // comment
    directoryView.setUint16(34, 0, true); // disk
    directoryView.setUint16(36, 0, true); // internal attributes
    directoryView.setUint32(38, 0, true); // external attributes
    directoryView.setUint32(42, localOffset, true);
    directory.set(name, 46);
    central.push(directory);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const directory of central) {
    push(directory);
    centralSize += directory.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);
  push(end);

  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

/** Entry names and stored CRCs, read back from the central directory — the writer's own self-check. */
export function readZipDirectory(bytes: Uint8Array): Array<{ name: string; crc: number; size: number }> {
  const buffer = Buffer.from(bytes);
  const entries: Array<{ name: string; crc: number; size: number }> = [];
  // The central-directory signature, walked by name length so a file *named* `PK\x01\x02` cannot be mistaken for a
  // record — the same reason the reader in `e2e/lib/pdf-inspect.ts` slices streams by their declared length.
  let cursor = buffer.indexOf(CENTRAL_SIGNATURE);
  while (cursor >= 0 && cursor + 46 <= buffer.length) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entries.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      crc: buffer.readUInt32LE(cursor + 16),
      size: buffer.readUInt32LE(cursor + 24),
    });
    cursor = buffer.indexOf(CENTRAL_SIGNATURE, cursor + 46 + nameLength + extraLength + commentLength);
  }
  return entries;
}
