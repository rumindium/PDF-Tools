import { describe, expect, test } from 'bun:test';
import {
  PERMISSION_TABLE,
  type SecurityPermissions,
  assertPasswordTransportable,
  assertPermissionsCoherent,
  buildPermissionValues,
  encryptionSettings,
  generateOwnerPassword,
  isAes,
  parseEncryptionReport,
  permissionWarnings,
} from '../src/security';

/**
 * The encryption engine's decisions, at the level they can be tested without a container.
 *
 * The reports below are **captured output**, not invented: they are what `qpdf --show-encryption` printed inside the
 * light worker image (qpdf 12.2.0) for three files — one encrypted AES-256 with a user password, one restricted with
 * an empty user password, and one plain. The parser is the piece a qpdf upgrade would break, and the captured text is
 * what makes the test notice.
 */

const AES256_REPORT = `R = 6
P = -1340
User password = 
extract for accessibility: allowed
extract for any purpose: not allowed
print low resolution: allowed
print high resolution: not allowed
modify document assembly: not allowed
modify forms: not allowed
modify annotations: not allowed
modify other: not allowed
modify anything: not allowed
stream encryption method: AESv3
string encryption method: AESv3
file encryption method: AESv3`;

const RESTRICTED_REPORT = `R = 6
P = -3388
User password = 
Supplied password is user password
extract for accessibility: allowed
extract for any purpose: not allowed
print low resolution: allowed
print high resolution: not allowed
modify document assembly: not allowed
modify forms: not allowed
modify annotations: not allowed
modify other: not allowed
modify anything: not allowed
stream encryption method: AESv3
string encryption method: AESv3
file encryption method: AESv3`;

const EVERYTHING_ALLOWED_REPORT = `R = 4
P = 0
extract for accessibility: allowed
extract for any purpose: allowed
print low resolution: allowed
print high resolution: allowed
modify document assembly: allowed
modify forms: allowed
modify annotations: allowed
modify other: allowed
modify anything: allowed
stream encryption method: AESv2`;

const DEFAULTS: SecurityPermissions = {
  print: true,
  printHighRes: false,
  copy: false,
  modify: false,
  annotate: true,
  fillForms: true,
  assemble: false,
  accessibility: true,
};

describe('permission mapping', () => {
  test('every contract flag has exactly one pikepdf field and one qpdf line', () => {
    expect(PERMISSION_TABLE).toHaveLength(8);
    const flags = PERMISSION_TABLE.map((entry) => entry.flag).sort();
    expect(flags).toEqual(Object.keys(DEFAULTS).sort());
    // No two flags may share a field or a line: a duplicate would be a mapping that silently overwrites one of them.
    expect(new Set(PERMISSION_TABLE.map((entry) => entry.pikepdf)).size).toBe(8);
    expect(new Set(PERMISSION_TABLE.map((entry) => entry.qpdfLine)).size).toBe(8);
  });

  test('each flag lands on the pikepdf field the qpdf line names it by', () => {
    const values = buildPermissionValues({ ...DEFAULTS, copy: true, assemble: true });
    expect(values).toEqual({
      accessibility: true,
      extract: true,
      modify_annotation: true,
      modify_assembly: true,
      modify_form: true,
      modify_other: false,
      print_lowres: true,
      print_highres: false,
    });
  });

  test('the parser reads the eight flags out of a real report, and nothing else', () => {
    const parsed = parseEncryptionReport(AES256_REPORT);
    expect(parsed.revision).toBe(6);
    expect(parsed.method).toBe('AESv3');
    expect(parsed.permissions).toEqual({
      accessibility: true,
      copy: false,
      print: true,
      printHighRes: false,
      modify: false,
      annotate: false,
      fillForms: false,
      assemble: false,
    });
  });

  test('a report with no permission lines yields unknowns, not denials', () => {
    // `modify anything` is the aggregate bit and is deliberately not a flag; a report that named nothing must not be
    // read as "everything denied", which would let a job claim a restriction it did not apply.
    const parsed = parseEncryptionReport('R = 6\nstream encryption method: AESv3');
    expect(parsed.permissions).toEqual({});
    expect(parsed.revision).toBe(6);
  });

  test('a restricted file is not mistaken for a password-protected one', () => {
    // "Supplied password is user password" appears whenever the user password is empty — including when the caller
    // supplied none at all — so it must not be what decides whether a password is needed. The flag is what decides.
    const parsed = parseEncryptionReport(RESTRICTED_REPORT);
    expect(parsed.permissions.copy).toBe(false);
    expect(parsed.permissions.accessibility).toBe(true);
    expect(RESTRICTED_REPORT).toContain('Supplied password is user password');
    expect(AES256_REPORT).not.toContain('Supplied password is user password');
  });

  test('the AES-128 report is read as its own revision, not rounded up to 256', () => {
    const parsed = parseEncryptionReport(EVERYTHING_ALLOWED_REPORT);
    expect(parsed.revision).toBe(4);
    expect(parsed.method).toBe('AESv2');
    expect(Object.values(parsed.permissions).every((allowed) => allowed)).toBe(true);
  });
});

describe('permission coherence', () => {
  test('high-resolution printing without printing is refused', () => {
    // Measured: written either way, the file reads back "print low resolution: allowed, print high resolution:
    // allowed" — so the caller who asked to deny printing gets a fully printable document.
    expect(() => assertPermissionsCoherent({ ...DEFAULTS, print: false, printHighRes: true })).toThrow(
      /fully printable/,
    );
  });

  test('denying both kinds of printing is fine, and so is allowing both', () => {
    expect(() => assertPermissionsCoherent({ ...DEFAULTS, print: false, printHighRes: false })).not.toThrow();
    expect(() => assertPermissionsCoherent({ ...DEFAULTS, print: true, printHighRes: true })).not.toThrow();
  });

  test('filling forms without commenting is allowed, because the bits are independent', () => {
    // Corrects `10-PROTECT-AND-UNLOCK.md` §2, which lists this pair as rejected. That rule is true of qpdf's *CLI*
    // (`--modify=form` implies assembly) and false of the format: the flags are separate bits, and a file written with
    // them reads back as "modify forms: allowed, modify annotations: not allowed".
    expect(() => assertPermissionsCoherent({ ...DEFAULTS, annotate: false, fillForms: true })).not.toThrow();
  });

  test('the accessibility flag is reported as ineffective rather than obeyed silently', () => {
    expect(permissionWarnings(DEFAULTS, 'aes-256')).toEqual([]);
    const warnings = permissionWarnings({ ...DEFAULTS, accessibility: false }, 'aes-256');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('ACCESSIBILITY_FLAG_IGNORED');
    expect(warnings[0]!.detail).toMatch(/allows it/);
    // Both AES revisions drop it, and neither is a special case in the code: the question is "is this AES".
    expect(permissionWarnings({ ...DEFAULTS, accessibility: false }, 'aes-128')).toHaveLength(1);
  });

  test('the accessibility flag is not reported on the revision that honours it', () => {
    // The whole reason `rc4-128` is in the contract: on it the flag works, so warning about it there would be a
    // false statement — and the golden suite asserts the file's own "extract for accessibility: not allowed".
    const warnings = permissionWarnings({ ...DEFAULTS, accessibility: false }, 'rc4-128');
    expect(warnings.map((w) => w.code)).toEqual(['LEGACY_ENCRYPTION']);
  });

  test('choosing the legacy cipher is warned about, because the problem there is the cipher', () => {
    const warnings = permissionWarnings(DEFAULTS, 'rc4-128');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('LEGACY_ENCRYPTION');
    expect(warnings[0]!.detail).toMatch(/broken/);
  });
});

describe('password transport', () => {
  test('a line break is refused, because both transports keep only the first line', () => {
    expect(() => assertPasswordTransportable('ab\ncd', 'userPassword')).toThrow(/line break/);
    expect(() => assertPasswordTransportable('ab\rcd', 'userPassword')).toThrow(/\r|\n|line break/);
  });

  test('spaces and tabs are kept, so they are not rejected', () => {
    // Measured through a password file: "  pad  " opens a file keyed to "  pad  ", and "  pad" does not.
    expect(() => assertPasswordTransportable('  pad  ', 'password')).not.toThrow();
    expect(() => assertPasswordTransportable('a\tb', 'password')).not.toThrow();
    expect(() => assertPasswordTransportable('k7Qm-2fLs-A9xT-Vb1Z', 'password')).not.toThrow();
  });
});

describe('options', () => {
  test('AES-256 is revision 6 and AES-128 is revision 4, both AES', () => {
    expect(encryptionSettings('aes-256')).toEqual({ revision: 6, aes: true });
    expect(encryptionSettings('aes-128')).toEqual({ revision: 4, aes: true });
  });

  test('RC4-128 is revision 3 with the AES flag off, which is what makes the flag meaningful', () => {
    expect(encryptionSettings('rc4-128')).toEqual({ revision: 3, aes: false });
    expect(isAes('rc4-128')).toBe(false);
    expect(isAes('aes-128')).toBe(true);
    expect(isAes('aes-256')).toBe(true);
  });

  test('a generated owner password is 24 URL-safe characters and does not repeat', () => {
    const first = generateOwnerPassword();
    expect(first).toHaveLength(24);
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(new Set(Array.from({ length: 50 }, () => generateOwnerPassword())).size).toBe(50);
  });
});
