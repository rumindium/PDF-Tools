import { describe, expect, test } from 'bun:test';
import {
  SECRET_PLACEHOLDER,
  extractSecrets,
  mergeSecrets,
  redactSecrets,
  requireTool,
  secretKeysFor,
  secretStashTtlSeconds,
  secretViolations,
} from '../src/tools/index';

/**
 * The secret round trip (`packages/contracts/src/tools/secrets.ts`).
 *
 * What is being tested here is not arithmetic — it is that the two halves cannot disagree. Redaction is what the
 * API writes down and merging is what the worker reads back, and a bug in either one is invisible at both ends: the
 * row looks clean, the job runs, and the engine is handed `[secret]` as the password of a document nobody can open.
 * So the pairs below assert the round trip *and* the direction that matters most — that redaction cannot leave a
 * value behind, whatever shape the options arrive in.
 */

const encrypt = requireTool('encrypt');
const restrict = requireTool('restrict');
const merge = requireTool('merge');

describe('the declaration', () => {
  test('a tool with no password declares nothing', () => {
    expect(secretKeysFor(merge)).toEqual([]);
    expect(secretKeysFor(encrypt)).toEqual(['userPassword', 'ownerPassword']);
  });
});

describe('extractSecrets', () => {
  test('takes only the declared keys, and only the ones present', () => {
    const secrets = extractSecrets(encrypt, {
      userPassword: 'open-sesame',
      ownerPassword: 'owner-secret',
      encryption: 'aes-128',
    });
    expect(secrets).toEqual({ userPassword: 'open-sesame', ownerPassword: 'owner-secret' });

    // `ownerPassword` absent is the documented, normal case: the engine generates one and says so in a warning.
    expect(extractSecrets(encrypt, { userPassword: 'open-sesame' })).toEqual({ userPassword: 'open-sesame' });
    expect(extractSecrets(encrypt, {})).toEqual({});
  });

  test('a value that is already the placeholder is not a secret', () => {
    // Re-extracting from a persisted record must yield nothing rather than stashing the marker and handing it to an
    // engine as a password. This is the property that makes the scrub script and the audit safe to run repeatedly.
    expect(extractSecrets(encrypt, { userPassword: SECRET_PLACEHOLDER })).toEqual({});
  });

  test('a declared key holding a non-string is a catalog mistake and says so', () => {
    // Declaring `permissions` a secret would be a bug in the catalog, not a runtime condition to tolerate: the test
    // above asserts no tool does it, so this path is a safety net. It throws rather than ignoring the key, because
    // silently dropping it would leave a non-secret value persisted while the declaration claimed otherwise.
    expect(() => extractSecrets(encrypt, { userPassword: 42 })).toThrow(/declared as a secret but holds a number/);
  });
});

describe('redactSecrets', () => {
  test('replaces every declared value and leaves everything else byte-identical', () => {
    const options = {
      userPassword: 'open-sesame',
      encryption: 'aes-128',
      permissions: { print: true },
      notes: 'keep me',
    };
    const redacted = redactSecrets(encrypt, options);
    expect(redacted.userPassword).toBe(SECRET_PLACEHOLDER);
    expect(redacted.encryption).toBe('aes-128');
    expect(redacted.notes).toBe('keep me');
    // The input is not mutated: the API keeps using the real options to build the request it hands to the engine.
    expect(options.userPassword).toBe('open-sesame');
  });

  test('adds no key that was not there', () => {
    // \"Absent\" and \"present but empty\" mean different things to `EncryptOptions`' refine — the refine is satisfied
    // by *either* password, so inventing an absent one as a placeholder would change which branch the engine takes.
    const redacted = redactSecrets(encrypt, { userPassword: 'open-sesame' });
    expect(Object.keys(redacted)).toEqual(['userPassword']);
    expect('ownerPassword' in redacted).toBe(false);
  });

  test('nothing a well-formed set of options can carry survives it', () => {
    // The direction that matters: whatever else is in the object, `secretViolations` finds nothing. Restrict is the
    // one whose secret is *required* by the UI, so it is the case where a missed key would be most visible.
    const redacted = redactSecrets(restrict, { ownerPassword: 'owner-secret', encryption: 'aes-256' });
    expect(secretViolations(restrict, redacted)).toEqual([]);
    expect(secretViolations(encrypt, redactSecrets(encrypt, { ownerPassword: 'owner-secret' }))).toEqual([]);
  });

  test('reports the keys still in the clear, which is the whole audit vocabulary', () => {
    expect(secretViolations(encrypt, { userPassword: 'open-sesame', ownerPassword: 'owner-secret' })).toEqual([
      'userPassword',
      'ownerPassword',
    ]);
    expect(secretViolations(encrypt, { userPassword: SECRET_PLACEHOLDER })).toEqual([]);
    // A key that is simply absent is not a violation — most jobs have no password at all.
    expect(secretViolations(encrypt, { encryption: 'aes-256' })).toEqual([]);
    expect(secretViolations(merge, { anything: 'at all' })).toEqual([]);
  });
});

describe('mergeSecrets', () => {
  test('the round trip returns exactly what went in', () => {
    const original = { userPassword: 'open-sesame', ownerPassword: 'owner-secret', encryption: 'aes-256' };
    const redacted = redactSecrets(encrypt, original);
    const merged = mergeSecrets(encrypt, redacted, extractSecrets(encrypt, original));
    expect(merged).toEqual(original);
    expect(secretViolations(encrypt, merged)).toEqual(['userPassword', 'ownerPassword']);
  });

  test('an empty stash changes nothing, including the placeholder it leaves behind', () => {
    // This is why the worker must refuse to run without a stash rather than merging whatever it finds: an empty
    // stash is not an error, it is the state that would hand `[secret]` to the engine as a password.
    const redacted = redactSecrets(encrypt, { userPassword: 'open-sesame' });
    expect(mergeSecrets(encrypt, redacted, {})).toEqual(redacted);
    expect(mergeSecrets(encrypt, redacted, {})).toHaveProperty('userPassword', SECRET_PLACEHOLDER);
  });

  test('a stashed key the payload never had is added, and one it did have is overwritten', () => {
    expect(mergeSecrets(encrypt, { encryption: 'aes-256' }, { ownerPassword: 'owner-secret' })).toEqual({
      encryption: 'aes-256',
      ownerPassword: 'owner-secret',
    });
    expect(mergeSecrets(encrypt, { userPassword: SECRET_PLACEHOLDER }, { userPassword: 'fresh' })).toEqual({
      userPassword: 'fresh',
    });
  });
});

describe('secretStashTtlSeconds', () => {
  test('covers every attempt of the job, with room for a slow claim', () => {
    // 120 s budget, 2 attempts, plus the margin: the stash must outlive the last attempt, because a retry re-reads
    // it rather than being handed a new one.
    expect(secretStashTtlSeconds(120, 2)).toBe(120 * 2 + 300);
    expect(secretStashTtlSeconds(420, 3)).toBe(420 * 3 + 300);
  });

  test('is bounded at both ends, so nothing is held forever and nothing expires mid-first-attempt', () => {
    expect(secretStashTtlSeconds(1, 1)).toBe(301);
    expect(secretStashTtlSeconds(0, 1)).toBe(300);
    expect(secretStashTtlSeconds(100_000, 10)).toBe(86_400);
    // A nonsensical attempt count cannot shorten the TTL below the single-attempt case.
    expect(secretStashTtlSeconds(60, 0)).toBe(360);
  });
});
