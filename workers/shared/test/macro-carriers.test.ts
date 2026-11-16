import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from '../../../scripts/dev/zip-writer';
import { describeMacroCarrier, findMacroCarrier } from '../src/guards/macro-carriers';

/**
 * The detector is the whole control: if it misses a carrier, the macro document is converted as if it were ordinary,
 * and the refusal the product documents never fires. So every test here is one of two shapes — a carrier that must
 * be found, or an *ordinary* document that must not be, because a guard that refuses a document with the word "VBA"
 * in it is a defect of its own.
 */

async function write(bytes: Uint8Array | string, name = 'file.bin'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'macro-guard-'));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

/** A macro-enabled workbook as the format defines it: a `vbaProject.bin` part inside the package. */
function macroWorkbook(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'xl/workbook.xml', content: '<workbook/>' },
    { name: 'xl/vbaProject.bin', content: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  ]);
}

/** The same workbook without the project — the negative control that keeps the case above meaningful. */
function plainWorkbook(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'xl/workbook.xml', content: '<workbook/>' },
    { name: 'xl/worksheets/sheet1.xml', content: '<sheet/>' },
  ]);
}

/** An ODF text document with an embedded Basic library, in the layout LibreOffice writes. */
function macroDocument(): Uint8Array {
  return buildZip([
    { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text' },
    { name: 'content.xml', content: '<office:document-content/>' },
    { name: 'Basic/script-lc.xml', content: '<library:libraries/>' },
    { name: 'Basic/Standard/Module1.xml', content: '<script:module>Sub Main\nEnd Sub</script:module>' },
  ]);
}

/** An OLE2 legacy `.xls`: the compound-file header, a directory name, and the stream a VBA project stores. */
function macroLegacy(): Uint8Array {
  const header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const directory = Buffer.concat([
    Buffer.from('Workbook', 'utf16le'),
    Buffer.alloc(8),
    Buffer.from('VBA', 'utf16le'),
    Buffer.alloc(8),
    Buffer.from('_VBA_PROJECT', 'utf16le'),
  ]);
  return Buffer.concat([header, Buffer.alloc(64), directory, Buffer.alloc(64)]);
}

describe('findMacroCarrier', () => {
  test('finds the VBA project inside an OOXML package', async () => {
    expect(await findMacroCarrier(await write(macroWorkbook(), 'book.xlsm'))).toEqual({
      carrier: 'vbaProject.bin',
      format: 'ooxml',
    });
  });

  test('is silent for the same package without one', async () => {
    expect(await findMacroCarrier(await write(plainWorkbook(), 'book.xlsx'))).toBeNull();
  });

  test('finds an ODF document’s embedded Basic library', async () => {
    const carrier = await findMacroCarrier(await write(macroDocument(), 'letter.odt'));
    expect(carrier?.format).toBe('odf');
    expect(carrier?.carrier).toContain('Basic');
  });

  test('finds a legacy OLE2 document’s VBA stream', async () => {
    expect(await findMacroCarrier(await write(macroLegacy(), 'old.xls'))).toEqual({
      carrier: '_VBA_PROJECT',
      format: 'ole2',
    });
  });

  test('the name and the extension are not evidence', async () => {
    // The whole reason this reads structure: the same bytes under a name that says "macro-free" are still macros, and
    // a name that says "macro" over a macro-free package is not. Upload typing cannot help here — a `.xlsm` and a
    // `.xlsx` are byte-identical at the level magic bytes can see.
    expect(await findMacroCarrier(await write(plainWorkbook(), 'pretending-to-be-macro.xlsm'))).toBeNull();
    expect(await findMacroCarrier(await write(macroWorkbook(), 'pretending-to-be-plain.xlsx'))).not.toBeNull();
  });

  test('a document that merely says the word is not a carrier', async () => {
    // The false positive this detector is written to avoid: `Macros` and `VBA` are ordinary words, and a Word
    // document that discusses them must still convert.
    const document = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:t>Macros in VBA can be dangerous.</w:t>' },
    ]);
    expect(await findMacroCarrier(await write(document, 'notes.docx'))).toBeNull();
  });

  test('a PDF is not an office document and is not scanned as one', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    expect(await findMacroCarrier(await write(pdf, 'file.pdf'))).toBeNull();
  });

  test('the message names the format and the part', () => {
    expect(describeMacroCarrier({ carrier: 'vbaProject.bin', format: 'ooxml' })).toContain('Office document');
    expect(describeMacroCarrier({ carrier: 'Basic/', format: 'odf' })).toContain('OpenDocument');
    expect(describeMacroCarrier({ carrier: '_VBA_PROJECT', format: 'ole2' })).toContain('legacy');
  });
});
