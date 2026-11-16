import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { decodePdfHexStrings, decodePdfLiteralStrings, searchableBytes, suppliedPasswordRole } from './pdf-inspect';

/**
 * The password-role parser, tested against output qpdf actually printed.
 *
 * Each block below is **copied** from a run inside the light image (qpdf 12.2.0, a pikepdf AES-256 file with an empty
 * user password and a known owner password), not paraphrased from documentation. That matters more than usual here,
 * because this parser is the whole basis of the owner-password assertion: a reader that answered `'owner'` to
 * everything would make the reveal check pass on a random string, and a reader that answered `'none'` would fail a
 * correct file — and neither would be visible from the golden suite's own output, since the failure would read as a
 * product defect.
 *
 * The three lines are not interchangeable in the report, and the ordering in the first block is the trap: qpdf prints
 * `Incorrect password supplied` **before** the dictionary it could still read, so a parser looking for the absence of
 * the first line would call a wrong password a successful open.
 */

const OWNER_PASSWORD =
  'R = 6\nP = -1052\nUser password = \nSupplied password is owner password\nextract for accessibility: allowed';
const USER_PASSWORD =
  'R = 6\nP = -1052\nUser password = \nSupplied password is user password\nextract for accessibility: allowed';
const WRONG = 'Incorrect password supplied\nR = 6\nP = -1052\nUser password = \n';
const NOT_ENCRYPTED = 'File is not encrypted\n';

describe('suppliedPasswordRole', () => {
  test('reads the line qpdf prints for the owner password', () => {
    expect(suppliedPasswordRole(OWNER_PASSWORD)).toBe('owner');
  });

  test('separates the owner password from the user password', () => {
    // The failure the assertion is aimed at: a reveal channel that hands back the *user* password passes every
    // shape check, opens the document in poppler, and is not the value that can change the permissions.
    expect(suppliedPasswordRole(USER_PASSWORD)).toBe('user');
  });

  test('reads a wrong password even though the rest of the report is present', () => {
    expect(suppliedPasswordRole(WRONG)).toBe('incorrect');
  });

  test('answers none for a file with no encryption to be keyed to', () => {
    // Not `incorrect`: a plain file has no password to be wrong about, and collapsing the two would report a
    // hypothesis about the reader as a finding about the document.
    expect(suppliedPasswordRole(NOT_ENCRYPTED)).toBe('none');
  });

  test('does not match the role line inside a longer word or a quoted line', () => {
    expect(suppliedPasswordRole('  Supplied password is owner password')).toBe('none');
    expect(suppliedPasswordRole('> Supplied password is owner password')).toBe('none');
  });
});

/**
 * The hex-string reader, against the byte runs `redact` actually wrote.
 *
 * The label below is **copied** out of a redacted document produced by the dev stack (the fixture the browser case
 * uploads, `redact-tokens-a4.pdf`, with a box over its first token): PyMuPDF writes the surviving page label back as
 * this hex string where the fixture carried it as a `(redact fixture — page 1 of 1) Tj` literal. That is the whole
 * reason this reader exists — a search that could not read it reported a page that plainly still had its label as a
 * page that had lost it, which is what made a presence control impossible to write in `redact.e2e.ts`.
 *
 * The rejections are tested beside the reading rather than after it, because the failure mode of a hex reader is not
 * "misses a string" but "decodes a dictionary": `<<` is two angle brackets, and a scan that paired the first one with
 * the next `>` would turn `/Length 33` and a `/Filter` into bytes and search them.
 */
describe('decodePdfHexStrings', () => {
  test('reads the label a redaction wrote back as hex', () => {
    const run = '<726564616374206669787475726520e2809420706167652031206f662031>Tj';
    expect(decodePdfHexStrings(run)).toBe('redact fixture — page 1 of 1');
  });

  test('reads a UTF-16BE string by its byte-order mark', () => {
    // The spec's spelling for text one byte per character cannot hold: `Hi` as two code units, BOM first. Decoded as
    // UTF-8 the same bytes are `\u0000H\u0000i`, which is the reading a reader that ignored the BOM would produce.
    expect(decodePdfHexStrings('<FEFF00480069>Tj')).toBe('Hi');
    expect(decodePdfHexStrings('00480069')).toBe('');
  });

  test('falls back to latin1 when the bytes are not UTF-8', () => {
    // `é` as a single WinAnsi byte: the same character in UTF-8 is two, so a reader that assumed UTF-8 everywhere
    // would drop it and report the run as containing a replacement character.
    expect(decodePdfHexStrings('(caf<E9>) Tj')).toBe('é');
  });

  test('rejects dictionary brackets and runs that are not whole bytes', () => {
    expect(decodePdfHexStrings('<< /Length 33 /Filter /FlateDecode >>')).toBe('');
    expect(decodePdfHexStrings('<< /A <FEFF00480069> >>')).toBe('Hi');
    expect(decodePdfHexStrings('<>')).toBe('');
    expect(decodePdfHexStrings('<414>')).toBe('');
  });
});

/**
 * The literal-string reader, against the byte run the fixture writer actually produced.
 *
 * The first case below is **copied** from `redact-tokens-a4.pdf` and from the redaction of it (both carry the same
 * bytes here): the harness's own writer escapes the brackets, and PyMuPDF leaves that run untouched, so the escaped
 * form is not an edge case but the normal state of any text holding a parenthesis. Each other case names the escape it
 * resolves rather than paraphrasing the spec, because each one fails in a different way: an unread bracket, a nested
 * bracket read too early, an octal byte read as three digits, a continuation read as a line break.
 */
describe('decodePdfLiteralStrings', () => {
  test('reads the escaped brackets a text run with a parenthesis is written with', () => {
    expect(decodePdfLiteralStrings('BT /F1 24 Tf 72 460 Td (PAREN\\(9X7\\)) Tj ET')).toBe('PAREN(9X7)');
  });

  test('counts balanced brackets rather than stopping at the first one', () => {
    // One string whose text is `a(b)c`; a pattern that matched to the first `)` would read `a(b`.
    expect(decodePdfLiteralStrings('(a(b)c) Tj')).toBe('a(b)c');
  });

  test('resolves octal escapes to the byte they stand for', () => {
    expect(decodePdfLiteralStrings('(caf\\351) Tj')).toBe('café');
    expect(decodePdfLiteralStrings('(\\101\\102) Tj')).toBe('AB');
  });

  test('resolves a backslash-newline as a continuation and an escaped backslash as itself', () => {
    expect(decodePdfLiteralStrings('(one\\\ntwo) Tj')).toBe('onetwo');
    expect(decodePdfLiteralStrings('(a\\\\b) Tj')).toBe('a\\b');
    // `\Z` is not an escape the spec defines, and a reader drops the backslash rather than printing it.
    expect(decodePdfLiteralStrings('(a\\Zb) Tj')).toBe('aZb');
  });

  test('contributes nothing for a bracket that never closes', () => {
    // The reason this is a stack and not a scan: compressed image data is full of lone `(` bytes, and a run that
    // swallowed the rest of the file would turn every byte after it into one "string".
    expect(decodePdfLiteralStrings('(unterminated Tj ET Q')).toBe('');
    expect(decodePdfLiteralStrings(') stray close')).toBe('');
  });
});

describe('searchableBytes', () => {
  test('finds a token that exists only as an escaped literal inside an inflated stream', () => {
    // The state a real redaction leaves behind, measured: the run is a literal whose brackets are escaped, so a search
    // for the token's *text* finds nothing while the token is plainly in the document.
    const content = 'BT /F1 24 Tf 72 460 Td (PAREN\\(9X7\\)) Tj ET';
    const body = deflateSync(Buffer.from(content, 'utf8'));
    const bytes = Buffer.concat([
      Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      body,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ]);

    expect(Buffer.from(bytes).toString('latin1')).not.toContain('PAREN(9X7)');
    expect(searchableBytes(bytes)).toContain('PAREN(9X7)');
  });

  test('finds text that exists only as a hex string inside an inflated stream', () => {
    // A page's content stream, deflated the way every engine in this build writes it: the label is in the file and
    // *nowhere* as a literal, so the reading below is the hex path and nothing else.
    const content = 'BT /F1 20 Tf 72 746 TD <726564616374206669787475726520e2809420706167652031206f662031>Tj ET';
    const body = deflateSync(Buffer.from(content, 'utf8'));
    const bytes = Buffer.concat([
      Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      body,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ]);

    expect(Buffer.from(bytes).toString('latin1')).not.toContain('redact fixture');
    expect(searchableBytes(bytes)).toContain('redact fixture — page 1 of 1');
  });
});
