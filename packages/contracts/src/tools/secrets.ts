import type { ToolDefinition } from './types';

/**
 * Option values that must never be written down — `docs/0-SECURITY.md` §5 and
 * `docs/10-PROTECT-AND-UNLOCK.md` §3.
 *
 * A password is unlike every other option: the job row outlives the request that carried it. `jobs.options` is a
 * JSONB column, the history endpoint reads it, a backup copies it, and retention keeps it for as long as the row
 * lives — days after the result it belongs to has been deleted. So the rule here is not "log it carefully" but
 * "do not write it down":
 *
 * ```text
 *   API   validation.options ──► redactSecrets() ──► jobs.options      (placeholder)
 *                            └──► extractSecrets() ─► Redis, TTL = the job's own budget (purged when it ends)
 *   worker                     ◄── readJobSecrets() ─ mergeSecrets() ──► the handler
 * ```
 *
 * Three properties keep that from rotting:
 *
 *  1. The **catalog** declares which keys are secret, and `registry.test.ts` refuses a tool whose `password`
 *     control is not declared — or a declaration with no option behind it. The declaration cannot drift from the
 *     form the user was shown.
 *  2. Redaction is an operation on a whole options object, not a flag a call site passes. There is no path that
 *     persists `validation.options`; it persists `redactSecrets(…)`, which cannot return the secret.
 *  3. The placeholder is an ordinary **value**, so the question "does any row hold a declared secret that is not
 *     the placeholder?" can be asked without knowing what the secret was. That is what the harness's
 *     durable-record check and `scripts/ops/scrub-job-secrets.ts` do — including for rows written before this
 *     module existed.
 *
 * What it does not cover, deliberately: a secret typed into an option that is *not* declared (nothing can tell a
 * password from a filename there), and the placeholder itself used as a password — a caller whose real password is
 * the literal string `[secret]` collides with the marker, which is harmless here (the value survives redaction and
 * reaches the handler unchanged) but means such a row cannot be told apart from a redacted one.
 */
export const SECRET_PLACEHOLDER = '[secret]';

/** The keys this tool declares as secret. Empty for every tool that takes no password. */
export function secretKeysFor(def: Pick<ToolDefinition, 'secrets'>): readonly string[] {
  return def.secrets ?? [];
}

/**
 * The real values of the declared secret keys, ready to be stashed.
 *
 * The value must be a string: a declared secret that holds a number or an object is a catalog mistake (the key is
 * not a password), and it is caught here rather than after the value has been written down — the registry test
 * asserts no tool does this, so this throw is a safety net rather than a path anyone should reach.
 *
 * A value that is already the placeholder is skipped: re-extracting from a redacted record must yield nothing
 * rather than stashing the marker and handing it to an engine as a password.
 */
export function extractSecrets(
  def: Pick<ToolDefinition, 'secrets'>,
  options: Record<string, unknown>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const key of secretKeysFor(def)) {
    const value = options[key];
    if (value == null) continue;
    if (typeof value !== 'string') {
      throw new Error(`Option "${key}" is declared as a secret but holds a ${typeof value}.`);
    }
    if (value === SECRET_PLACEHOLDER) continue;
    secrets[key] = value;
  }
  return secrets;
}

/**
 * The options as they may be persisted: every declared secret replaced by the placeholder.
 *
 * Shallow on purpose. Every declared secret is a top-level option (asserted by the registry test), and a deep clone
 * would imply this function guards nested keys too — it does not, and the assertion is what makes that true.
 */
export function redactSecrets(
  def: Pick<ToolDefinition, 'secrets'>,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...options };
  for (const key of secretKeysFor(def)) {
    if (redacted[key] != null) redacted[key] = SECRET_PLACEHOLDER;
  }
  return redacted;
}

/**
 * The inverse, used by the worker: put the stashed values back before anything reads the options.
 *
 * A key that was never provided is untouched rather than set to `undefined`, so a job that fills only `userPassword`
 * still looks exactly like a job that fills only `userPassword` — `Object.keys` is what the handlers' option
 * handling and the `encrypt` engine both walk.
 */
export function mergeSecrets(
  def: Pick<ToolDefinition, 'secrets'>,
  options: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...options };
  for (const key of secretKeysFor(def)) {
    const value = secrets[key];
    if (value != null) merged[key] = value;
  }
  return merged;
}

/**
 * Declared secret keys in this object whose value is *not* the placeholder — i.e. values in the clear.
 *
 * This is the audit's whole vocabulary, and its virtue is that it needs no knowledge of the secret: any object that
 * claims to be a persistable record of options can be checked against the catalog that produced it.
 */
export function secretViolations(def: Pick<ToolDefinition, 'secrets'>, options: Record<string, unknown>): string[] {
  return secretKeysFor(def).filter((key) => {
    const value = options[key];
    if (value == null) return false;
    return !(typeof value === 'string' && value === SECRET_PLACEHOLDER);
  });
}

/** How long a stashed secret may live, given the job's own budget and the retry budget. */
export function secretStashTtlSeconds(timeoutSeconds: number, maxAttempts: number): number {
  // Generous enough to outlive every attempt of this job with room for a slow claim, and bounded so a job that is
  // never claimed leaves nothing behind: a stash with no TTL is exactly the leak this design exists to avoid.
  return Math.min(86_400, Math.max(120, timeoutSeconds * Math.max(1, maxAttempts) + 300));
}

/** Exported for callers that only have a tool id and need the declaration. */
export type SecretBearingTool = Pick<ToolDefinition, 'secrets'>;
