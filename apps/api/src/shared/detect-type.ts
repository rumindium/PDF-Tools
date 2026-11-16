/**
 * Type detection from content, never from the client's `Content-Type` or the file extension
 * (spec §48 #3, `0-SECURITY.md` §3).
 *
 * The office family is a ZIP container, so detection looks *inside* the archive for the parts that identify the
 * document type. That is a heuristic, but it is the same one every converter uses, and it is dramatically safer
 * than trusting a name — a `.docx` that is really an executable is a classic upload attack.
 */

export interface DetectedType {
  mime: string;
  /** Extension we would give the file on disk (always our own, never the user's). */
  ext: string;
  /** Coarse family used by the acceptance check. */
  family: 'pdf' | 'image' | 'office' | 'html' | 'zip' | 'unknown';
}

const UNKNOWN: DetectedType = { mime: 'application/octet-stream', ext: '.bin', family: 'unknown' };

export async function detectType(path: string): Promise<DetectedType> {
  const file = Bun.file(path);
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  const buf = Buffer.from(head);

  // ── Images ────────────────────────────────────────────────────────────────
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png', family: 'image' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg', family: 'image' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp', family: 'image' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'II*\u0000' || buf.subarray(0, 4).toString('ascii') === 'MM\u0000*') {
    return { mime: 'image/tiff', ext: '.tiff', family: 'image' };
  }
  if (buf.subarray(4, 12).toString('ascii').includes('ftyp')) {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand.startsWith('hei') || brand.startsWith('mif1') || brand.startsWith('msf1')) {
      return { mime: 'image/heic', ext: '.heic', family: 'image' };
    }
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { mime: 'application/pdf', ext: '.pdf', family: 'pdf' };
  }

  // ── HTML (plain text starting with a document marker) ─────────────────────
  const asText = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (asText.startsWith('<!doctype html') || asText.startsWith('<html') || asText.startsWith('<?xml')) {
    return { mime: 'text/html', ext: '.html', family: 'html' };
  }

  // ── OOXML / ODF / plain archive ───────────────────────────────────────────
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const haystack = await readZipDirectoryNames(path);
    if (haystack.includes('word/document.xml')) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: '.docx',
        family: 'office',
      };
    }
    if (haystack.includes('xl/workbook.xml')) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: '.xlsx',
        family: 'office',
      };
    }
    if (haystack.includes('ppt/presentation.xml')) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ext: '.pptx',
        family: 'office',
      };
    }
    if (haystack.includes('mimetype') && haystack.includes('opendocument')) {
      return { mime: 'application/vnd.oasis.opendocument.text', ext: '.odt', family: 'office' };
    }
    return { mime: 'application/zip', ext: '.zip', family: 'zip' };
  }

  // ── Legacy OLE2 Office ────────────────────────────────────────────────────
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    const text = buf.toString('latin1');
    if (text.includes('WordDocument')) return { mime: 'application/msword', ext: '.doc', family: 'office' };
    if (text.includes('Workbook') || text.includes('Book')) {
      return { mime: 'application/vnd.ms-excel', ext: '.xls', family: 'office' };
    }
    if (text.includes('PowerPoint')) return { mime: 'application/vnd.ms-powerpoint', ext: '.ppt', family: 'office' };
    return UNKNOWN;
  }

  // ── Plain text and CSV ────────────────────────────────────────────────────
  if (looksLikeText(buf)) {
    const text = buf.toString('utf8');
    const firstLine = text.split('\n', 1)[0] ?? '';
    const separators = (firstLine.match(/[,;\t|]/g) ?? []).length;
    if (separators >= 2) return { mime: 'text/csv', ext: '.csv', family: 'office' };
    return { mime: 'text/plain', ext: '.txt', family: 'office' };
  }

  return UNKNOWN;
}

/** Scan the archive's central directory names (they are stored uncompressed). */
async function readZipDirectoryNames(path: string): Promise<string> {
  const size = Bun.file(path).size;
  const window = Math.min(size, 256 * 1024);
  const tail = new Uint8Array(
    await Bun.file(path)
      .slice(size - window)
      .arrayBuffer(),
  );
  return Buffer.from(tail).toString('latin1');
}

function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let printable = 0;
  for (const byte of buf) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 160) printable += 1;
  }
  return printable / buf.length > 0.95;
}
