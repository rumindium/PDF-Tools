/**
 * The path reader behind `--expect-json-path`, kept apart from the harness so it can be tested without a stack.
 *
 * It lives here for the reason every assertion mechanism in this repo gets its own tests: a reader that silently
 * returns the wrong node turns **every** data case green, and the failure mode is invisible — the case names a path,
 * the harness finds *something* under it, and the value happens to match because the path resolved to the parent
 * object. `fields[0].value` returning the whole `fields[0]` object would fail loudly; `fields[0].value` returning
 * `fields[0].values` would not.
 *
 * The syntax is deliberately small, because a fixture assertion is not a query language: dotted keys, `[index]` steps,
 * nothing else. Anything more clever belongs in a case's own code, where a reader can see what it does.
 */

/** What a path that does not exist resolves to — distinct from a path that exists and holds `null`. */
export const MISSING = Symbol('missing json path');

/**
 * Read a dotted path with optional `[index]` steps out of a parsed JSON body.
 *
 * Returns {@link MISSING} rather than `undefined` so the caller can tell "there is no such path" from "the path holds
 * null" — the two are different bugs (a renamed key versus a miscalculated value) and a case that cannot say which one
 * happened sends the reader looking in the wrong place.
 *
 * A path segment addressing a *key* only descends into objects: `fields.length` is `MISSING` rather than `6`, because
 * an array's own properties are its implementation rather than its data. A case that wants a count asserts the count
 * the tool reported (`fieldsTotal`, `widgets`), which is the number under test anyway.
 */
export function readJsonPath(body: unknown, path: string): unknown {
  // An empty path resolves to the whole body if the walk is allowed to start there, and that is the one answer that
  // makes every assertion built on it meaningless: `''` would compare the body against whatever the case declared and
  // pass for any case whose expectation happened to be an object. It is a missing path, not a root path.
  if (path === '') return MISSING;
  let current: unknown = body;
  for (const segment of path.split('.')) {
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return MISSING;
    const [, key, indexes] = match;
    if (key) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return MISSING;
      current = (current as Record<string, unknown>)[key];
    }
    for (const index of indexes?.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return MISSING;
      current = current[Number(index)];
    }
  }
  return current === undefined ? MISSING : current;
}

/**
 * Split `<path>=<value>` at the **first** `=`.
 *
 * Corrected after the unit test for this refuted the earlier reasoning, which is the useful part of the story: the
 * first version split at the *last* `=` to protect a value that contains one, and that is exactly backwards for the
 * values that actually occur. `url=https://example.test/?a=1&b=2` and `token=YWJj=` both come out right with the first
 * `=`, and the second one comes out wrong with the last — a base64 value ending in `=` padding was silently truncated
 * to an empty string. A path that contains `=` is the case this cannot serve, and a dotted path with an `=` in a key
 * is not a path a fixture case is going to write.
 *
 * Returns `null` for a pair with no path or no `=`, which the harness reports as a usage error.
 */
export function parseJsonPathPair(raw: string): [string, unknown] | null {
  const split = raw.indexOf('=');
  if (split <= 0) return null;
  const path = raw.slice(0, split);
  const text = raw.slice(split + 1);
  // A bare word that is not valid JSON stays a string; `true`, `2` and `null` arrive as their JSON types, which is
  // what makes `required=true` an assertion about a boolean rather than about the string "true".
  try {
    return [path, JSON.parse(text)];
  } catch {
    return [path, text];
  }
}
