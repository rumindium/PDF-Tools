import { combineAccessFlags, config } from '@pdftools/config';
import { childLogger } from '@pdftools/logger';

/**
 * The installation-wide questions: **may a caller with no account use this, and is any of it public?**
 *
 * `docs/0-TENANT-FIRST.md` §3. Both switches live in Auth Platform — columns on the app's admin record, beside
 * `IsFree`, so an operator can flip either without a redeploy. This module is the mirror: it asks once, caches the
 * answer, and falls back to the local `ALLOW_ANONYMOUS` / `STRICT_MODE` values when there is nobody to ask. The
 * order matters and is the whole point of the file:
 *
 * ```text
 *   platform answers        → that answer, cached for `APP_ANONYMOUS_CACHE_SECONDS`      (source: platform)
 *   platform unreachable,
 *   and it answered before  → the last confirmed answer, marked stale                    (source: stale)
 *   platform unreachable,
 *   never answered          → ALLOW_ANONYMOUS / STRICT_MODE                              (source: env)
 * ```
 *
 * **Why one resolver and not two.** It used to answer only the anonymous question, and the second switch was going to
 * be a second module with a second cache. That would have been the same 120 lines twice, and every one of the three
 * properties below is a property of *this* lookup — so the two copies would have drifted in exactly the place the
 * comments exist to protect: which answer wins, how long a failure is believed, and what an unreachable platform
 * means. One request, one cache, one fallback order, and the pairing of the two flags is resolved by
 * `combineAccessFlags` — the same rule the platform applies — rather than by each reader.
 *
 * Three properties are deliberate and each of them is a bug this shape prevents:
 *
 *  1. **"The platform said no" and "the platform said nothing" are different values.** The fetcher returns
 *     `AppSwitchAnswer | null`, never a boolean-with-a-sentinel: an answer means an operator decided something, `null`
 *     means nobody answered. Reading an unreachable platform as "off" would make a network interruption look like a
 *     policy decision, and reading it as "on" would do the opposite — which is why the distinction is in the type
 *     rather than in a comment.
 *  2. **A failure is cached too.** An installation whose platform is down must not pay a failed lookup per request;
 *     the negative result is held for the same window as a positive one, so recovery takes at most one window.
 *  3. **Concurrent callers share one lookup.** Every request resolves this, so without the in-flight deduplication a
 *     burst of traffic arriving on a cold cache would open one HTTP connection per request to ask the same question.
 *
 * The direction of the fallback is downward in the one case that matters: with no platform configured *and* no local
 * value, the answer is "anonymous not allowed" — `ALLOW_ANONYMOUS` defaults to `false`, so the absence of an answer
 * denies rather than permits, exactly like the entitlement mirror's rule in `CROSS-MODULE.md` §9.
 */

export type SwitchSource = 'env' | 'platform' | 'stale';

/** What one lookup produced. `allowAnonymous` already has `strictMode` applied. */
export interface AppSwitchAnswer {
  allowAnonymous: boolean;
  strictMode: boolean;
}

export interface AppSwitches extends AppSwitchAnswer {
  /** Where the answer came from — reported so an operator can tell a policy from a fallback. */
  source: SwitchSource;
  /** Epoch ms of the resolution this answer came from (a cache hit reports the original, not the hit). */
  resolvedAt: number;
}

/**
 * The switches, as the resolver needs them.
 *
 * Everything it touches is a parameter, for the reason `plugins/dev-plan.ts` gives: a rule that can only be exercised
 * by starting a process against a real Auth Platform is a rule nobody tests. `now` and `fetchAppConfig` are
 * injectable so the cache window, the fallback and the stale path are all testable as arithmetic.
 */
export interface SwitchDeps {
  /** The local fallback — `ALLOW_ANONYMOUS`, with `STRICT_MODE` already applied by `config.access`. */
  allowAnonymous: boolean;
  /** The local fallback for the second switch — `STRICT_MODE`. */
  strictMode: boolean;
  /** Internal Auth Platform API base, or `null` when the integration is not configured. */
  platformBase: string | null;
  appCode: string;
  /** How long an answer — including a failure — is trusted. */
  cacheSeconds: number;
  now?: () => number;
  /** `AppSwitchAnswer` = the platform's answer; `null` = no answer (unreachable, wrong shape, non-2xx). */
  fetchAppConfig?: (code: string) => Promise<AppSwitchAnswer | null>;
}

/** How long the platform lookup may take before it counts as "nobody answered". */
const LOOKUP_TIMEOUT_MS = 2500;

/**
 * Ask Auth Platform for the app's admin switches.
 *
 * The endpoint is `GET /apps/{code}/public`, and it is the only Auth Platform route this service calls without a
 * credential — which is the reason it exists as a separate route on the platform's side rather than reusing
 * `/apps/{appId}`: a guest has no token to present, and neither answer is a secret.
 *
 * A wrong `allowAnonymous` is `null`, not a guess. `{"allowAnonymous": "false"}` is a string, and a resolver that
 * coerced it would be deciding a policy question on a type error — the flag governs whether anyone may use this
 * installation, so a shape it cannot read is a question it cannot answer.
 *
 * `strictMode` is read as "true only when the platform says so", which is the one place this fetcher does not demand
 * an exact type. The asymmetry is deliberate: a platform old enough not to send the field cannot be *asking* for
 * strict mode, so the honest reading of its silence is "off" — and the alternative would make an upgrade of the app
 * alone gate every page of a deployment whose platform has never heard of the switch.
 *
 * What it returns is the platform's **raw** pair, and the pairing rule is applied by the resolver rather than here
 * (`lookUp` below). That is the more useful place for it: the rule then holds for every fetcher — this one, an
 * injected one, and a future protocol — and it holds on the paths that do not go through a fetch at all, which is
 * what the stale and fallback branches are. A rule applied in one of three readers is a rule the other two do not
 * have.
 */
export function platformFetcher(base: string | null) {
  return async (code: string): Promise<AppSwitchAnswer | null> => {
    if (!base) return null;
    try {
      const response = await fetch(`${base}/apps/${encodeURIComponent(code)}/public`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { allowAnonymous?: unknown; strictMode?: unknown; isEnabled?: unknown };
      if (typeof body?.allowAnonymous !== 'boolean') return null;
      // A disabled app has no switch to honour: the platform stopped serving it, and reading `allowAnonymous` off a
      // row nobody can reach would report a policy that is not in force. `isEnabled` itself is not this module's
      // gate — access to the app is decided by the platform and by app-scoped permissions.
      if (body.isEnabled === false) return null;
      return { allowAnonymous: body.allowAnonymous, strictMode: body.strictMode === true };
    } catch {
      return null;
    }
  };
}

export interface AppSwitchesResolver {
  resolve(): Promise<AppSwitches>;
  /** The last resolved answer, or `null` before the first resolution. Never performs I/O. */
  peek(): AppSwitches | null;
}

export function createAppSwitches(deps: SwitchDeps): AppSwitchesResolver {
  const now = deps.now ?? (() => Date.now());
  const fetchAppConfig = deps.fetchAppConfig ?? platformFetcher(deps.platformBase);
  const log = childLogger({ component: 'app-switches' });

  let cached: AppSwitches | null = null;
  let confirmed: { answer: AppSwitchAnswer; resolvedAt: number } | null = null;
  let inFlight: Promise<AppSwitches> | null = null;

  async function lookUp(): Promise<AppSwitches> {
    const at = now();
    const answered = await fetchAppConfig(deps.appCode);

    if (answered !== null) {
      // The one rule that pairs the two flags (`packages/config/src/env.ts`, the same function the platform applies
      // before it publishes them). Applying it here rather than trusting each answer means no path to a caller can
      // produce the incoherent pair — a product reporting that it serves visitors while its every page asks for a
      // sign-in, or a stale answer from a platform that sends both flags raw.
      const paired: AppSwitchAnswer = {
        allowAnonymous: combineAccessFlags(answered),
        strictMode: answered.strictMode,
      };
      cached = { ...paired, source: 'platform', resolvedAt: at };
      confirmed = { answer: paired, resolvedAt: at };
      return cached;
    }

    if (confirmed) {
      // Stale rather than the local value: the platform did answer at some point, and a confirmed policy outlives a
      // momentary outage. Reverting to `ALLOW_ANONYMOUS` here would silently *widen* access the moment the platform
      // hiccups, which is the one direction a fallback must never move.
      cached = { ...confirmed.answer, source: 'stale', resolvedAt: at };
      return cached;
    }

    cached = {
      // Through the same rule, for the same reason: the two local variables can be set incoherently by hand, and an
      // operator who sets `STRICT_MODE=true` beside `ALLOW_ANONYMOUS=true` is asking for the stricter one.
      allowAnonymous: combineAccessFlags({ allowAnonymous: deps.allowAnonymous, strictMode: deps.strictMode }),
      strictMode: deps.strictMode,
      source: 'env',
      resolvedAt: at,
    };
    return cached;
  }

  return {
    async resolve(): Promise<AppSwitches> {
      const at = now();
      if (cached && at - cached.resolvedAt < deps.cacheSeconds * 1000) return cached;

      if (!inFlight) {
        inFlight = lookUp()
          .then((answer) => {
            if (answer.source !== 'platform') {
              // Logged because it is the one state an operator cannot see from the outside: everything works, and
              // the value in force is a fallback rather than the policy they set in the admin UI.
              log.info(
                {
                  source: answer.source,
                  allowAnonymous: answer.allowAnonymous,
                  strictMode: answer.strictMode,
                  appCode: deps.appCode,
                },
                'app switches resolved without a platform answer',
              );
            }
            return answer;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return await inFlight;
    },
    peek: () => cached,
  };
}

/**
 * The process-wide resolver.
 *
 * Lazy rather than module-level, because building it reads `config`, and a module that does real work at import
 * time is a module that breaks a unit test that only wanted one of its pure functions.
 */
let singleton: AppSwitchesResolver | null = null;

export function appSwitches(): AppSwitchesResolver {
  singleton ??= createAppSwitches({
    allowAnonymous: config.access.allowAnonymous,
    strictMode: config.access.strictMode,
    platformBase: config.api.authPlatformInternalUrl,
    appCode: config.api.appCode,
    cacheSeconds: config.access.switchCacheSeconds,
  });
  return singleton;
}

/** Test seam: drop the process-wide resolver so a test can rebuild it against different configuration. */
export function resetAppSwitches(): void {
  singleton = null;
}
