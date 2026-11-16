import { config } from '@pdftools/config';
import type { AppAccessSnapshot } from '@pdftools/contracts';
import { AppError } from '@pdftools/errors';
import { type IdentitySource, type LinkedSession, linkSessionToUser, userIdFromToken } from '../plugins/session';

/**
 * The Auth Platform handoff, in two steps, shared by both doors (`docs/0-TENANT-FIRST.md` §5).
 *
 * ```text
 *   POST {AUTH}/sso/handoff-bridge { bridge }  → { code }      // the shared-session cookie becomes a one-time code
 *   POST {AUTH}/sso/exchange       { code }    → { accessToken } // and the code becomes a credential
 * ```
 *
 * The two doors differ only in where the first input comes from:
 *
 *  - `POST /api/v1/sso/consume` — a code the workspace put in the URL when it opened this app (the My Apps card);
 *  - `POST /api/v1/sso/probe` — the `auth_session` cookie the browser already holds because the *platform* is signed
 *    in, which is the case a visitor lands in when they signed in at the platform and came back.
 *
 * Why this is a service rather than two copies inside the route handlers: the failure taxonomy below is the part
 * worth getting right, and the two callers need it to mean the same thing. A visitor whose bridge is dead must be
 * told to sign in again whether they arrived by URL or by cookie, and a platform that is merely unreachable must
 * never be reported as "your session ended" — that sentence makes people sign in again for nothing, and it is the
 * sentence an outage would produce thousands of times.
 *
 * Nothing here returns a token to a caller. The access token is used to ask the platform who the caller is and is
 * then dropped: it is never written to a cookie, a response body, or a log line.
 */

/**
 * Why a handoff could not complete. Each value is a different sentence to a user (see the contract's union).
 *
 * `bridge_expired` and `bridge_revoked` are two of those sentences, and telling them apart is the difference between a
 * session that has to be re-linked and a session that **ended**: the platform ties a handle's death to a clock (an
 * hour in a browser that wandered off) or to a sign-out (someone pressed the button, here or on another app), and a
 * caller that could not tell them apart would either resurrect a sign-out or throw away a link nobody ended.
 */
export type HandoffFailure =
  | 'not_configured'
  | 'bridge_expired'
  | 'bridge_revoked'
  | 'platform_unreachable'
  | 'code_rejected';

/** `fetch`, narrowed to what this module uses — so a test can pass a function instead of standing up a platform. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HandoffDeps {
  /**
   * The platform's internal base URL, or `null` when this installation is not connected to one.
   *
   * Passed in rather than read from `config` inside the functions, for the reason `plugins/dev-plan.ts` gives about
   * its own switch: the interesting cases here are the failures, and a failure that can only be produced by
   * unplugging a real service is a failure nobody tests.
   */
  base: string | null;
  fetchImpl?: FetchLike;
  /**
   * The app code this installation asks about — what makes the platform's answer *about this app*.
   *
   * Configurable here rather than read from `config` inline for the same reason `base` is: a test needs to ask about
   * an app the platform does not know, because "the answer named an app nobody recognises" is a failure mode.
   */
  appCode?: string;
}

function depsFromConfig(): HandoffDeps {
  return { base: config.api.authPlatformInternalUrl, appCode: config.api.appCode };
}

/** How long each leg of the handoff may take before it counts as "the platform did not answer". */
const BRIDGE_TIMEOUT_MS = 4000;
const EXCHANGE_TIMEOUT_MS = 5000;

/**
 * Turn the shared-session cookie into a one-time handoff code, **and** the app access that comes with it.
 *
 * The cookie's value **is** the bridge handle — the platform's web app stores an opaque 43-character handle there
 * rather than an access token, because a real token is well past the 4 KB browser cookie limit and gets silently
 * dropped (the failure that made the platform move to handles in the first place).
 *
 * A `401` is the one answer with a meaning of its own: the platform knows this cookie and says it is no longer good.
 * Everything else — a 500, a timeout, a 200 with no `code` in it — is "no usable answer", which is a different thing
 * to tell a user and a different thing to tell an operator.
 *
 * `appRoles`/`appPermissions` ride in the same response because the platform can answer both questions in the round
 * trip it is already making: the bridge identifies the account, and this installation names itself in the request, so
 * "who is this" and "what may they do here" are one call rather than two. A platform too old to know the field simply
 * omits it, which reads as `access: null` — no roles yet, and the next refresh can still find them.
 */
export async function codeFromBridge(
  bridge: string,
  deps: HandoffDeps = depsFromConfig(),
): Promise<{ code: string; access: AppAccessSnapshot | null } | { failure: HandoffFailure }> {
  if (!deps.base) return { failure: 'not_configured' };

  const request = deps.fetchImpl ?? fetch;
  try {
    const response = await request(`${deps.base}/sso/handoff-bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridge, appCode: deps.appCode ?? null }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });

    // 401 carries which kind of "no" this is, in the body: `bridge_revoked` when the session was ended by a sign-out,
    // and the generic `invalid_bridge` when the handle simply ran out of time. Reading the body is the whole reason
    // this branch is not a one-liner — a handle that expired and a handle that was revoked demand opposite responses
    // from the caller, and only the platform can tell them apart.
    if (response.status === 401 || response.status === 403) {
      const refusal = await response
        .json()
        .then((body: { error?: unknown }) => (typeof body?.error === 'string' ? body.error : null))
        .catch(() => null);
      return { failure: refusal === 'bridge_revoked' ? 'bridge_revoked' : 'bridge_expired' };
    }
    if (!response.ok) return { failure: 'platform_unreachable' };

    const body = (await response.json()) as { code?: unknown; appRoles?: unknown; appPermissions?: unknown };
    if (typeof body?.code !== 'string' || body.code.length === 0) return { failure: 'platform_unreachable' };
    return { code: body.code, access: accessFromBridgeBody(body) };
  } catch {
    // A timeout and a refused connection are the same answer to the caller: nobody replied.
    return { failure: 'platform_unreachable' };
  }
}

/**
 * The role snapshot in a handoff answer, or `null` when the platform did not give one.
 *
 * Shapes are filtered here rather than trusted, and both lists must be present: a platform that answered with roles
 * but no permissions (or the reverse) is not half-right — it is a different version of the contract, and guessing the
 * missing half would either grant nothing or grant something nobody defined.
 */
function accessFromBridgeBody(body: { appRoles?: unknown; appPermissions?: unknown }): AppAccessSnapshot | null {
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;

  const roles = strings(body.appRoles);
  const permissions = strings(body.appPermissions);
  if (!roles || !permissions) return null;
  return { roles, permissions };
}

/**
 * Exchange a handoff code for a **session**, not for tokens.
 *
 * The code is single-use and lives 60 seconds; the platform consumes it before issuing anything, so a second
 * caller with the same code gets `code_rejected`. That is a race rather than a state, which is why it is not folded
 * into `bridge_expired`.
 */
export async function linkFromHandoffCode(
  ctx: IdentitySource,
  code: string,
  access: AppAccessSnapshot | null = null,
  deps: HandoffDeps = depsFromConfig(),
): Promise<{ session: LinkedSession } | { failure: HandoffFailure }> {
  if (!deps.base) return { failure: 'not_configured' };

  const request = deps.fetchImpl ?? fetch;
  let accessToken: string | null = null;
  try {
    const response = await request(`${deps.base}/sso/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) return { failure: 'code_rejected' };

    const tokens = (await response.json()) as { accessToken?: unknown };
    if (typeof tokens?.accessToken !== 'string' || tokens.accessToken.length === 0) {
      return { failure: 'platform_unreachable' };
    }
    accessToken = tokens.accessToken;
  } catch {
    return { failure: 'platform_unreachable' };
  }

  // Verified by the platform rather than trusted: `/auth/me` is what proves the token is real, and the mirror row it
  // returns is the local id every job and file row is keyed on. A token that verifies but belongs to no account is
  // `code_rejected`, not a link — there is nobody to link to.
  const userId = await userIdFromToken(accessToken);
  if (!userId) return { failure: 'code_rejected' };

  return { session: await linkSessionToUser(ctx, userId, access) };
}

/**
 * What became of a handle: still a session, ended by a sign-out, simply gone, or nobody asked.
 *
 * `gone` and `unreachable` are deliberately not one value: the first is the platform's answer that an hour ran out,
 * the second is no answer at all, and the caller keeps its link in both cases — but only one of them is a fact.
 */
export type BridgeState = 'valid' | 'revoked' | 'gone' | 'unreachable';

/**
 * Ask the platform about a handle the browser is no longer carrying.
 *
 * This is what makes a sign-out that happened *elsewhere* land here. The browser's shared-session cookie disappears for
 * two reasons — somebody ended the session, or its hour ran out — and from this app the two look identical. The
 * handle kept on the session row (`packages/db/migrations/0004_session_platform_bridge.sql`) is what turns that into a
 * question the platform can answer, and a revoked answer is the only one that ends the link.
 *
 * A `403`/`401`/`500`/timeout all read the same way on purpose: nothing was learned, so nothing changes. Signing
 * somebody out because a platform hiccuped is the failure this whole taxonomy exists to avoid.
 */
export async function verifyBridge(handle: string, deps: HandoffDeps = depsFromConfig()): Promise<BridgeState> {
  if (!deps.base) return 'unreachable';

  const request = deps.fetchImpl ?? fetch;
  try {
    const response = await request(`${deps.base}/sso/bridge/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridge: handle }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!response.ok) return 'unreachable';

    const body = (await response.json()) as { valid?: unknown; revoked?: unknown };
    if (body?.revoked === true) return 'revoked';
    return body?.valid === true ? 'valid' : 'gone';
  } catch {
    return 'unreachable';
  }
}

/**
 * End the shared session at the platform, by the handle the browser is holding.
 *
 * This is what makes signing out *here* mean signing out everywhere: the platform records the moment, which is what
 * stops the workspace's own tab from minting a fresh handle out of the tokens it still has, and every other app on
 * this browser finds a handle that answers `revoked` rather than merely missing.
 *
 * Best-effort by design, and it reports which of the two happened rather than throwing: the caller's own session has
 * to end either way (this installation can always end its own link), and a platform that did not answer must not
 * leave someone signed in here because a remote call failed.
 */
export async function revokeBridge(
  bridge: string,
  deps: HandoffDeps = depsFromConfig(),
): Promise<'revoked' | 'unreachable' | 'not_configured'> {
  if (!deps.base) return 'not_configured';

  const request = deps.fetchImpl ?? fetch;
  try {
    const response = await request(`${deps.base}/sso/bridge/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridge }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    return response.ok ? 'revoked' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * The failure a screen should say, from the perspective of the two doors.
 *
 * Kept as a function rather than inlined at each call site because the mapping is the product decision: `consume`
 * was already documented as answering `UNAUTHORIZED` for anything that did not work, and the probe answers with a
 * reason instead — and doing that translation twice is how the two doors would drift into telling a user two
 * different stories about the same outage.
 */
export function consumeFailure(failure: HandoffFailure): AppError {
  switch (failure) {
    case 'not_configured':
      return new AppError('FORBIDDEN', 'Auth Platform integration is not configured on this installation.');
    case 'platform_unreachable':
      // Deliberately an existing code rather than a new `UPSTREAM_*`: nothing branches on it. The sign-in callback
      // shows the message and offers the same retry for every failure, and a code nobody reads is a code that drifts
      // away from its meaning (the pass reviews deleted five of them for exactly that). The message is where the
      // distinction lives, and it is the distinction the user needs: the workspace did not answer, which is not the
      // same as your session having ended.
      return new AppError('INTERNAL_ERROR', 'The workspace did not answer. Try again in a moment.');
    case 'bridge_expired':
      // Only the probe reaches this one, and only through a cookie rather than a URL code.
      return new AppError('UNAUTHORIZED', 'The shared session is no longer active. Sign in again.');
    case 'bridge_revoked':
      // Same status, different sentence: this one was a sign-out, not a clock.
      return new AppError('UNAUTHORIZED', 'This session was signed out. Sign in again.');
    case 'code_rejected':
      return new AppError('UNAUTHORIZED', 'The handoff code is invalid or expired.');
  }
}
