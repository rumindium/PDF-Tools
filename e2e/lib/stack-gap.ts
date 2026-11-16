/**
 * The one way a case stops without a verdict.
 *
 * A case can be unable to run for two reasons, and only one of them is about the product:
 *
 *   · a **fixture** it needs was never generated — the runner already reports that as a gap, since the file is a
 *     prerequisite and its absence is not a defect;
 *   · a **capability the stack does not have** — a setting the case needs the running deployment to be configured with.
 *     The byte half of `compress`'s escalation is the case that made this exist: the API refuses any upload above
 *     `MAX_FILE_SIZE_MB` (50 MB by default), so a job big enough to cross a 100 MB threshold cannot exist on a default
 *     stack at all. That is the *deployment* behaving correctly, and reporting it as a product failure would make a
 *     green suite red on every machine nobody configured — the second-order damage being that a real failure in that
 *     case would be indistinguishable from a misconfigured one.
 *
 * So the harness stops with `STACK_GAP_EXIT_CODE` and a line naming what is missing, and each runner decides: the
 * golden suite prints it among the cases that did not run, and `test:falsify` treats it as a **failed claim** — a claim
 * whose case could not run has not falsified anything, and must never read as a pass.
 */

/** Distinct from 0 (passed) and 1 (failed) so a runner can tell "could not run" from "ran and disagreed". */
export const STACK_GAP_EXIT_CODE = 3;

/** The marker the runners read the reason back out of. */
export const STACK_GAP_MARKER = 'STACK GAP:';

/** Stop the case, naming what the stack is missing and how to give it. */
export function stackGap(reason: string, hint?: string): never {
  console.log(`  · not run — ${STACK_GAP_MARKER} ${reason}`);
  if (hint) console.log(`    ${hint}`);
  process.exit(STACK_GAP_EXIT_CODE);
}

/** The reason out of a harness run's output, or `null` if it was not a gap. */
export function stackGapReason(output: string): string | null {
  for (const line of output.split('\n')) {
    const index = line.indexOf(STACK_GAP_MARKER);
    if (index >= 0) return line.slice(index + STACK_GAP_MARKER.length).trim();
  }
  return null;
}

/**
 * Who this stack thinks a caller with no credential is.
 *
 * `docs/0-TENANT-FIRST.md` §3: `guest` is what a caller resolves to when the installation requires an account, and
 * `anonymous` is a real session. `allowAnonymous` is the resolved switch, reported separately because the two answers
 * are not the same question — an anonymous session on a switched-off installation is `authenticated: true` and
 * read-only, which is the case §4.3 keeps working on purpose.
 */
export interface AnonymousProbe {
  kind: string;
  authenticated: boolean;
  allowAnonymous: boolean;
  /**
   * Whether this installation publishes any page at all (`docs/0-TENANT-FIRST.md` §4.4).
   *
   * A **third position**, not a stronger `allowAnonymous`. That one decides whether a caller with no account may do
   * anything; this one decides whether they may see anything, and a stack can be in either state with the other flag
   * in either position. Reported so a runner can name which one it is looking at: the refusal a visitor gets under
   * strict mode (`reason: 'strict_mode'`) is not the refusal they get with anonymous use off
   * (`reason: 'anonymous_disabled'`), and a stage that could not tell them apart would accept the wrong one.
   */
  strictMode: boolean;
}

/**
 * Ask the stack, without a cookie, what it does with a caller who has none.
 *
 * `base` is the API root (`http://localhost:8080`) or the web container's origin, which proxies `/api`
 * (`http://localhost:5180`) — the route is the same either way, so a browser stage can use the origin it drives.
 *
 * Returns `null` when the stack could not be reached or answered in an unexpected shape. That is deliberately **not**
 * a gap: a stack that is down is a real failure of the run, and reporting it as "this case could not run" would turn
 * the most ordinary misconfiguration into a green-looking exit code.
 */
export async function probeAnonymous(base: string, timeoutMs = 8000): Promise<AnonymousProbe | null> {
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/api/v1/me`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<AnonymousProbe> & { strictMode?: unknown };
    if (typeof body.kind !== 'string' || typeof body.allowAnonymous !== 'boolean') return null;
    return {
      kind: body.kind,
      authenticated: body.authenticated !== false,
      allowAnonymous: body.allowAnonymous,
      // Read as "true only when the stack says so", the same asymmetry `services/app-switches.ts` documents for the
      // platform's answer: a stack old enough not to publish the field cannot be asking for strict mode, and demanding
      // an exact type would turn a missing key into an unusable probe for every stage that shares this helper.
      strictMode: body.strictMode === true,
    };
  } catch {
    return null;
  }
}

/** The reason every anonymous-dependent stage gives on a tenant-first stack, written once. */
export function requiresAccountReason(what: string): string {
  return `${what}, and this stack requires an account (ALLOW_ANONYMOUS=false) — no caller without a session can start work here`;
}

/** The one recipe a reader needs, so the line that appears on their machine is actionable. */
const ANONYMOUS_HINT =
  'this case needs a stack that serves callers with no account: set `ALLOW_ANONYMOUS=true` for it and restart (' +
  'the dev and CI compose files already do), or run the tenant-first cases with `bun run test:tenant-first` ' +
  '(`docs/0-CICD.md` §3.10)';

/**
 * Stop a stage that needs an anonymous session, on a stack that refuses to give it one.
 *
 * This is the difference between a named stop and a wall of red. Every harness in this repository begins as a caller
 * with no account — each runner keeps one `pdft_session` cookie per process and its first request has none — so on a
 * tenant-first stack the golden suite does not fail one case, it fails all of them at their first upload, for a reason
 * that is not a product defect. And a couple of hundred identical failures bury the one that *is* a defect, which is
 * the second-order damage and the reason this helper exists rather than a per-case check.
 *
 * Called once, at the top of a runner, before any work: the stop is then immediate, deterministic and identical in
 * every runner. The stage whose *subject* is the refusal (`scripts/ci/tenant-first.ts`) deliberately does not call it.
 *
 * A stack that never answers returns without stopping — the runner's own first request will report that honestly.
 */
export async function requireAnonymousUse(base: string, what: string): Promise<AnonymousProbe | null> {
  const probe = await probeAnonymous(base);
  if (probe === null) return null;
  if (probe.kind === 'guest' || probe.allowAnonymous === false) {
    stackGap(requiresAccountReason(what), ANONYMOUS_HINT);
  }
  return probe;
}
