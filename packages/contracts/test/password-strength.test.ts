import { describe, expect, test } from 'bun:test';
import {
  PASSWORD_ABSOLUTE_MIN_LENGTH,
  PASSWORD_STRENGTH_POLICY,
  evaluatePasswordStrength,
  strongPasswordsRequired,
} from '../src/tools/password-strength';

/**
 * The policy's own tests, written around the four things the module claims about *how* it counts.
 *
 * Every case here is a shape the API, the form and the handler meet for real, and three of them are the reason the
 * implementation is not a `length >= 8 && /[a-z]/ && /[A-Z]/ && /\d/` one-liner:
 *
 *  - **code points**: a four-emoji password is 8 UTF-16 units and 4 characters. Reading `.length` would have accepted
 *    it against an 8-character minimum, and the assertion that says so is the one that fails if anyone "simplifies"
 *    the measurement back to `.length`.
 *  - **Unicode classes**: a Cyrillic password has upper- and lower-case letters. An ASCII regexp calls it single-class
 *    and demands Latin characters from someone who does not use them.
 *  - **whitespace**: eight spaces are eight characters and establish no class. A space is neither a letter, a digit
 *    nor a symbol, so counting it as one would hand three classes to `a  b  c `.
 *
 * The rest are the two numbers from `10-PROTECT-AND-UNLOCK.md` §6, asserted against the exported constants rather than
 * against literals — a policy that has moved should fail in one place, and the tests read the policy they test.
 */

describe('the policy’s numbers', () => {
  test('are the ones the document states', () => {
    // The only place in the test suite where these appear as literals. Everything else compares against the export,
    // so changing the policy is a one-line decision that this test forces someone to make deliberately.
    expect(PASSWORD_STRENGTH_POLICY.minLength).toBe(8);
    expect(PASSWORD_STRENGTH_POLICY.minClasses).toBe(3);
    // The floor is deliberately *not* the policy's length: below it lies "not a password", not "a weak one".
    expect(PASSWORD_ABSOLUTE_MIN_LENGTH).toBe(4);
    expect(PASSWORD_ABSOLUTE_MIN_LENGTH).toBeLessThan(PASSWORD_STRENGTH_POLICY.minLength);
  });
});

describe('evaluatePasswordStrength', () => {
  test('accepts a password that has length and three classes', () => {
    const strength = evaluatePasswordStrength('Abcd1234');
    expect(strength.meetsPolicy).toBe(true);
    expect(strength.belowFloor).toBe(false);
    expect(strength.length).toBe(8);
    expect(strength.classes).toEqual(['lower', 'upper', 'digit']);
    expect(strength.missingClasses).toEqual(['symbol']);
    expect(strength.issues).toEqual([]);
  });

  test('rejects one that is long enough with too few classes, and says which are missing', () => {
    const strength = evaluatePasswordStrength('abcd1234');
    expect(strength.meetsPolicy).toBe(false);
    expect(strength.classes).toEqual(['lower', 'digit']);
    expect(strength.missingClasses).toEqual(['upper', 'symbol']);
    expect(strength.issues.join(' ')).toContain('2 of the four character classes');
  });

  test('rejects one with three classes that is too short', () => {
    const strength = evaluatePasswordStrength('aB3');
    expect(strength.meetsPolicy).toBe(false);
    expect(strength.belowFloor).toBe(true);
    expect(strength.classes).toEqual(['lower', 'upper', 'digit']);
    // The floor is what is reported, not the policy's eight: "3 characters, the floor is 4" is the sentence the
    // caller can act on, and the policy's eight is the one that only matters above it.
    expect(strength.issues).toHaveLength(1);
    expect(strength.issues[0]).toContain(`at least ${PASSWORD_ABSOLUTE_MIN_LENGTH}`);
  });

  test('counts characters, not UTF-16 units — four emoji are four characters', () => {
    const emoji = '🎈🎈🎈🎈';
    expect(emoji.length).toBe(8);
    const strength = evaluatePasswordStrength(emoji);
    expect(strength.length).toBe(4);
    expect(strength.belowFloor).toBe(false);
    expect(strength.meetsPolicy).toBe(false);
    // Four symbols: one class, and the message has to say four rather than eight, because the number is the whole
    // reason this case exists.
    expect(strength.classes).toEqual(['symbol']);
    expect(strength.issues.join(' ')).toContain('4 characters long');
  });

  test('treats non-Latin letters as letters', () => {
    const cyrillic = 'Пароль12';
    const strength = evaluatePasswordStrength(cyrillic);
    expect(strength.classes).toEqual(['lower', 'upper', 'digit']);
    expect(strength.meetsPolicy).toBe(true);

    const greekLower = 'κωδικός1';
    // Lower + digit only — still two classes, so still refused, but for the right reason: an ASCII-only classifier
    // would call this "digit + symbol" and report the same verdict with a message that names the wrong gap.
    expect(evaluatePasswordStrength(greekLower).classes).toEqual(['lower', 'digit']);
  });

  test('counts whitespace toward length and never as a class', () => {
    const spaces = '        ';
    const strength = evaluatePasswordStrength(spaces);
    expect(strength.length).toBe(8);
    expect(strength.classes).toEqual([]);
    expect(strength.meetsPolicy).toBe(false);
    expect(strength.issues.join(' ')).toContain('none');
  });

  test('does not count a digit’s Unicode neighbours as a class they are not', () => {
    // Arabic-Indic digits are `\p{Nd}`, so they count as digits — the same rule as the letters above. A classifier
    // built on `[0-9]` would call this password single-class.
    expect(evaluatePasswordStrength('abcdef١٢').classes).toEqual(['lower', 'digit']);
  });

  test('reports an empty password as below the floor rather than as a special case', () => {
    const strength = evaluatePasswordStrength('');
    expect(strength.length).toBe(0);
    expect(strength.belowFloor).toBe(true);
    expect(strength.classes).toEqual([]);
    expect(strength.meetsPolicy).toBe(false);
    // The handler never calls this with an empty value (`weakPasswordWarnings` skips those), but a function that threw
    // on one would be a landmine for whatever calls it next.
    expect(strength.issues.length).toBeGreaterThan(0);
  });
});

describe('strongPasswordsRequired', () => {
  test('turns on for Business and for an explicit request', () => {
    expect(strongPasswordsRequired('business')).toBe(true);
    expect(strongPasswordsRequired('free', true)).toBe(true);
    expect(strongPasswordsRequired('anonymous', true)).toBe(true);
  });

  test('cannot be turned off by an explicit false on Business', () => {
    // The rule that makes the option safe to expose: a caller may hold themselves to a stricter standard than their
    // plan, and nobody talks their way out of the standard their plan already imposes.
    expect(strongPasswordsRequired('business', false)).toBe(true);
    expect(strongPasswordsRequired('free', false)).toBe(false);
    expect(strongPasswordsRequired('pro')).toBe(false);
  });
});
