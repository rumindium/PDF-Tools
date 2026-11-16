import { open } from 'node:fs/promises';

/**
 * Does this document carry macros? Answered from the file's **own structure**, not from its name or its MIME.
 *
 * The MIME check it replaces (`MACRO_MIME` in `office-to-pdf`) could not fire, and that was measured rather than
 * suspected: uploads are typed from magic bytes (`apps/api/src/shared/detect-type.ts`), and both `.xlsm` and `.xlsx`
 * are the same ZIP whose directory says `xl/workbook.xml` — so a macro-enabled workbook arrived at the worker as
 * `…spreadsheetml.sheet`, the set of macro MIMEs never matched, and every document the guard was written for went
 * straight to LibreOffice. A control whose value is never in the set it tests is not a control, it is a comment.
 *
 * Three families carry macros, and each announces it in a way that survives compression:
 *
 *   OOXML (`.docm`, `.xlsm`, `.pptm`)  a part named `vbaProject.bin` — and ZIP stores its member *names*
 *                                      uncompressed, so the name is readable without inflating anything.
 *   ODF (`.odt`, `.ods`, `.odp`)       a `Basic/` script library: `Basic/script-lc.xml` and
 *                                      `Basic/<library>/Module<n>.xml` are the layout LibreOffice writes.
 *   OLE2 (`.doc`, `.xls`, `.ppt`)      a compound-file stream named `_VBA_PROJECT`; OLE2 directory names are
 *                                      UTF-16LE, which is why the needle is its encoding rather than its text.
 *
 * `_VBA_PROJECT` specifically, and not the `Macros` or `VBA` storage names: those are ordinary words that appear in
 * the UTF-16 text of a Word document, and a guard that refuses a document because someone typed "VBA" in it would be
 * worse than no guard. The needle is the stream that only a VBA project has.
 *
 * Detection reads structure, never code: the product refuses the *carrier*, and it does not need to know what the
 * macro does. That is deliberate rather than a shortcut — the office image **does** have a Basic runtime (measured:
 * `bun run test:isolation` executes a profile macro and reads the engine's `MacroSecurityLevel`), so the refusal is
 * what makes "macros are not executed" a statement about this service instead of a bet on LibreOffice's
 * configuration (`docs/0-SECURITY.md` §7.2).
 */

export interface MacroCarrier {
  /** What was found, in the format's own vocabulary — the part or stream name, for the message. */
  carrier: string;
  format: 'ooxml' | 'odf' | 'ole2';
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** How much of each end is read. A ZIP central directory is at the tail and an OLE2 directory is early. */
const TAIL_WINDOW = 512 * 1024;
const HEAD_WINDOW = 4 * 1024 * 1024;

/** `_VBA_PROJECT`, as OLE2 stores a directory name. */
const OLE2_VBA_STREAM = Buffer.from('_VBA_PROJECT', 'utf16le');

// The patterns are unanchored on purpose: a name in a ZIP central directory is *preceded* by the header fields that
// describe it, not by a slash, so an anchored pattern matches nothing at all — which is exactly how a detector keeps
// passing its own review while finding nothing. Every needle below is specific enough to stand alone.
/** `Basic/script-lc.xml` — the ODF library container LibreOffice writes when a document has any Basic library. */
const ODF_LIBRARY_CONTAINER = /Basic\/script-lc\.xml/i;
/** `Basic/Standard/Module1.xml`, `Basic/MyLib/Module2.xml` — a module in a named library. */
const ODF_MODULE = /Basic\/[^/]+\/Module\d+\.xml/i;
/** `xl/vbaProject.bin`, `word/vbaProject.bin`, `ppt/vbaProject.bin`. */
const OOXML_PROJECT = /vbaProject\.bin/i;

export async function findMacroCarrier(path: string): Promise<MacroCarrier | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(HEAD_WINDOW);
    const headBytes = (await handle.read(head, 0, HEAD_WINDOW, 0)).bytesRead;
    const start = head.subarray(0, headBytes);

    if (startsWith(start, ZIP_SIGNATURE) || startsWith(start, ZIP_EMPTY_SIGNATURE)) {
      const { size } = await handle.stat();
      const tailLength = Math.min(size, TAIL_WINDOW);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      // Names are the whole evidence, so the scan is over both windows: an archive with a single member keeps its
      // local header (and therefore the name) in the head, where a small file's central directory may not reach.
      const names = `${start.toString('latin1')}\n${tail.toString('latin1')}`;
      if (OOXML_PROJECT.test(names)) return { carrier: 'vbaProject.bin', format: 'ooxml' };
      if (ODF_LIBRARY_CONTAINER.test(names) || ODF_MODULE.test(names)) {
        return { carrier: 'Basic/ (an embedded Basic library)', format: 'odf' };
      }
      return null;
    }

    if (startsWith(start, OLE2_SIGNATURE)) {
      if (start.includes(OLE2_VBA_STREAM)) return { carrier: '_VBA_PROJECT', format: 'ole2' };
      return null;
    }

    return null;
  } finally {
    await handle.close();
  }
}

/** What the refusal says, so the message names the format and the part rather than "this file". */
export function describeMacroCarrier(carrier: MacroCarrier): string {
  const format =
    carrier.format === 'ooxml'
      ? 'an Office document'
      : carrier.format === 'odf'
        ? 'an OpenDocument file'
        : 'a legacy Office document';
  return `${format} carrying macros (${carrier.carrier})`;
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}
