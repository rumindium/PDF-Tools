/**
 * The password-strength policy — `docs/10-PROTECT-AND-UNLOCK.md` §6.
 *
 * A password is the only option in this product whose *value* is the protection: `encrypt` with a long passphrase is a
 * lock, `encrypt` with `1234` is a document with a lock drawn on it. The engine cannot tell the two apart — qpdf writes
 * both, both read back as `R = 6 / AESv3`, and both open with the password the caller typed — so the decision about
 * what this service will put its name on has to live above the engine, and this module is where it is written down.
 *
 * Four properties, each one a choice with a cheaper alternative beside it:
 *
 *  1. **A floor for every plan, the policy on top of it.** Below `PASSWORD_ABSOLUTE_MIN_LENGTH` nothing is accepted,
 *     whatever the plan: that is not a weak password but a typo, and honouring it produces a file whose protection is
 *     zero while every line of the job reports success. Above the floor, the policy applies where the plan asks for it
 *     (`strongPasswordsRequired`), and where it does not the password is accepted *and reported* — see the
 *     `WEAK_PASSWORD_ACCEPTED` warning the handlers raise.
 *  2. **Length is counted in code points, not UTF-16 units.** `'👍'.length === 2`, so a four-emoji password measures 8
 *     through `.length` and 4 through `[...value].length`. The second is the number of characters a person typed, and
 *     it is the one a policy about typing should use; the first would let a 4-symbol password pass an 8-character
 *     minimum, which is the mistake this measurement exists to prevent.
 *  3. **Classes are Unicode-aware.** `\p{Ll}` / `\p{Lu}` / `\p{Nd}` rather than `[a-z]` / `[A-Z]` / `[0-9]`: a password
 *     in Cyrillic or Greek has upper- and lower-case letters, and a policy that counted those as "other" would call such
 *     a password single-class and demand Latin characters from someone who does not use them.
 *  4. **Whitespace counts toward length and establishes no class.** Eight spaces are eight characters and nothing else;
 *     treating a space as a symbol would hand a three-class verdict to `a  b  c `.
 *
 * What this policy cannot see is written here rather than implied by a green tick: it is a **shape** check. `Abcd1234`
 * passes it and sits near the top of every breach list. A dictionary or breach check needs data this service does not
 * ship, and the honest form of that gap is a line in `0-IMPLEMENTATION-STATUS.md` §6 — not a policy that reads as
 * stronger than it is.
 */

/** The four classes a password can draw from, in the order they are reported. */
export type PasswordCharacterClass = 'lower' | 'upper' | 'digit' | 'symbol';

/**
 * The policy's own numbers, as `10-PROTECT-AND-UNLOCK.md` §6 states them: eight characters, three classes.
 *
 * Both numbers are exported as data rather than baked into a regex or a message, because two callers have to agree on
 * them — the API refuses a job and the web form warns *before* the request — and a copy-pasted `{8,}` is how the two
 * sides drift into disagreeing about the product's own rule.
 */
export interface PasswordPolicy {
  minLength: number;
  minClasses: number;
}

export const PASSWORD_STRENGTH_POLICY: PasswordPolicy = { minLength: 8, minClasses: 3 };

/**
 * The length below which no plan accepts a password, whatever the policy says.
 *
 * Four, and it is deliberately not the policy's eight: this is the line between "the caller chose something weak" and
 * "the caller typed a value that is not a password". A caller on a plan without the policy keeps the freedom to choose
 * a password the policy would refuse — and is told what it costs — while nobody, on any plan, gets a `pdf` whose
 * protection is `1`.
 */
export const PASSWORD_ABSOLUTE_MIN_LENGTH = 4;

/** One class, the pattern that recognises it, and the word used in an issue message. */
const CLASS_TESTS: ReadonlyArray<{ name: PasswordCharacterClass; pattern: RegExp; label: string }> = [
  { name: 'lower', pattern: /\p{Ll}/u, label: 'a lowercase letter' },
  { name: 'upper', pattern: /\p{Lu}/u, label: 'an uppercase letter' },
  { name: 'digit', pattern: /\p{Nd}/u, label: 'a digit' },
  // A symbol is anything that is neither a letter, a number, nor whitespace — the definition the class is *for*: a
  // character with no alphabetic or numeric identity to guess from. `\p{L}` and `\p{N}` are the complements that make
  // this work outside ASCII (a Greek full stop, an em dash, a currency mark all count).
  { name: 'symbol', pattern: /[^\p{L}\p{N}\s]/u, label: 'a symbol' },
];

/** What a policy evaluation found. */
export interface PasswordStrength {
  /** Code points, not UTF-16 units — property 2 above. */
  length: number;
  /** Every class present, in `CLASS_TESTS` order. */
  classes: PasswordCharacterClass[];
  /** The classes the policy asks for and this password does not have. */
  missingClasses: PasswordCharacterClass[];
  /** True below `PASSWORD_ABSOLUTE_MIN_LENGTH` — refused on every plan. */
  belowFloor: boolean;
  /** True when length and classes both satisfy the policy. A caller may still be refused by their plan's own rule. */
  meetsPolicy: boolean;
  /** Why it failed, in words a human can act on. Empty when `meetsPolicy` is true. */
  issues: string[];
}

/**
 * Measure one password against the policy.
 *
 * Pure and total: no configuration, no identity, no I/O. That is what lets the same function answer three questions
 * that must not disagree — whether the API refuses the job, what the job warns about when it does not, and what the
 * form tells the user before they press anything.
 */
export function evaluatePasswordStrength(password: string): PasswordStrength {
  const characters = [...password];
  const length = characters.length;
  const classes = CLASS_TESTS.filter((entry) => entry.pattern.test(password)).map((entry) => entry.name);
  const missingClasses = CLASS_TESTS.filter((entry) => !classes.includes(entry.name)).map((entry) => entry.name);

  const belowFloor = length < PASSWORD_ABSOLUTE_MIN_LENGTH;
  const tooShort = length < PASSWORD_STRENGTH_POLICY.minLength;
  const tooFewClasses = classes.length < PASSWORD_STRENGTH_POLICY.minClasses;
  const meetsPolicy = !tooShort && !tooFewClasses;

  const issues: string[] = [];
  if (belowFloor) {
    issues.push(
      `the password is ${length} character${length === 1 ? '' : 's'} long; at least ${PASSWORD_ABSOLUTE_MIN_LENGTH} are required for any document to be protected by one`,
    );
  } else if (tooShort) {
    issues.push(
      `the password is ${length} characters long and the policy requires at least ${PASSWORD_STRENGTH_POLICY.minLength}`,
    );
  }
  if (tooFewClasses) {
    const present = classes.length > 0 ? classes.join(', ') : 'none';
    issues.push(
      `it uses ${classes.length} of the four character classes (${present}) and the policy requires at least ${PASSWORD_STRENGTH_POLICY.minClasses} of: ${CLASS_TESTS.map((entry) => entry.label).join(', ')}`,
    );
  }

  return { length, classes, missingClasses, belowFloor, meetsPolicy, issues };
}

/**
 * Whether a caller's plan requires the policy for the passwords they are setting.
 *
 * Two inputs, and the asymmetry between them is the whole rule: `plan === 'business'` turns it on, and an explicit
 * `true` turns it on as well — but `explicit: false` cannot turn it *off*. A caller may hold themselves to a stricter
 * rule than their plan does; nobody talks their way out of the rule their plan already imposes. That is what makes the
 * option safe to expose in a form (`10-PROTECT-AND-UNLOCK.md` §3): the worst a caller can do with it is make their own
 * password requirements harder.
 *
 * `unlock` is deliberately not a caller of this function, and §6 says why: it is handed a password that already exists
 * on someone else's document. Refusing to open a file because its owner once chose `1234` would punish the person
 * holding the document rather than the person who made it weak.
 */
export function strongPasswordsRequired(plan: string, explicit?: boolean): boolean {
  return explicit === true || plan === 'business';
}
