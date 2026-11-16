import { config } from '@pdftools/config';
import type { AppAccessSnapshot } from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { eq } from 'drizzle-orm';
import { type AuthContext, type IdentitySource, endLinkedSession } from '../plugins/session';
import { codeFromBridge } from './handoff';

/**
 * What this caller may do **here**, according to the platform that defines the roles.
 *
 * Three questions, one module, because they have to agree:
 *
 *  1. *Now* — a route asks whether the caller holds `pdftools.admin.read` before it answers (`routeAccess`).
 *  2. *Then* — a page load asks what to show, and gets the same snapshot (`/me` publishes it).
 *  3. *Later* — the snapshot is refreshed on a TTL, because the platform is where a grant is made and neither app
 *     can push to the other.
 *
 * Why a snapshot at all. The only credential this app holds for the platform on somebody's behalf is the shared
 * `auth_session` cookie the browser sent with this request (`docs/0-TENANT-FIRST.md` §5). Asking the platform on every
 * request would put a network round trip — and a failure mode — in front of every job; asking never would mean a role
 * change took effect only for whoever signed out and back in. A TTL on the session row is the middle: at most one
 * refresh per session per window, and the last known answer kept when the platform is down, exactly as
 * `services/app-switches.ts` keeps the installation switches.
 *
 * Why the failure direction is "nothing" and not "everything": an empty snapshot has to be the answer for a caller we
 * could not verify, or an outage would open the admin dashboard to the internet. `roles`/`permissions` are therefore
 * never inferred from a missing answer, only from one the platform actually gave.
 */

/** How long a snapshot is believed before the platform is asked again. */
const ACCESS_TTL_MS = 5 * 60 * 1000;

/** The empty answer: a caller with no account, or one whose roles could not be read. */
const NO_ACCESS: AppAccessSnapshot = { roles: [], permissions: [] };

/** Platform call budget for a refresh — the same order as the handoff legs, because it is the same platform. */
const ACCESS_TIMEOUT_MS = 4000;

/**
 * One refresh per session at a time.
 *
 * Two requests arriving together on a session whose snapshot just expired is the normal case (a page load and its
 * first XHR), and without this they would both call the platform with the same cookie. The map is process-local on
 * purpose: a multi-instance deployment makes an extra call, which is cheaper than coordinating a lock for something
 * whose worst case is one duplicated read.
 */
const inFlight = new Map<string, Promise<AppAccessSnapshot>>();

/** Whether a snapshot exists and was taken recently enough to still be believed. */
function isFresh(takenAt: Date | null, now = Date.now()): boolean {
  return takenAt != null && now - takenAt.getTime() < ACCESS_TTL_MS;
}

export function hasPermission(access: AppAccessSnapshot, code: string): boolean {
  return access.permissions.includes(code);
}

/**
 * Normalise a session row's snapshot columns.
 *
 * `null` and `[]` are different states and both are legal: `null` is "never asked" (so ask), `[]` is "the platform
 * answered that this account holds nothing here" (so do not). Collapsing them would send a request to the platform on
 * every page load for every account with no roles — which is every `user` who is not an admin, i.e. almost everybody.
 */
function snapshotFromRow(row: {
  appRoles: string[] | null;
  appPermissions: string[] | null;
}): AppAccessSnapshot | null {
  if (row.appRoles == null || row.appPermissions == null) return null;
  return { roles: row.appRoles, permissions: row.appPermissions };
}

/**
 * The caller's access for this request: the snapshot, refreshed when it is missing or stale.
 *
 * Never throws. A platform that is down leaves the session with what it had — the "keep the last known answer" rule
 * the anonymous switch already follows — and a guest or an anonymous caller skips the whole thing, because there is no
 * account to be granted anything.
 */
export async function callerAccess(ctx: IdentitySource, auth: AuthContext): Promise<AppAccessSnapshot> {
  // A keyed API caller authenticates with a token rather than a session cookie, so there is no row to snapshot on:
  // its roles are asked for directly, with the token that proves who it is. Nothing is stored, because a token does
  // not outlive the request and a cached answer keyed on a bearer string is a credential in a log line waiting to
  // happen.
  if (auth.bearerToken) return accessFromToken(auth.bearerToken);

  if (auth.identity.kind !== 'user' || !auth.sessionId) return NO_ACCESS;
  // Captured rather than re-read: TypeScript loses the narrowing inside the promise callbacks below, and a `string |
  // null` session id reaching a query is how a role lookup would silently bind `null` and return nothing.
  const sessionId = auth.sessionId;

  const db = getDb();
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
  const session = rows[0];
  if (!session) return NO_ACCESS;

  const snapshot = snapshotFromRow(session);
  if (snapshot && isFresh(session.appAccessAt)) return snapshot;

  // Which handle to ask about: the cookie the browser just sent, or — when there is none — the handle this link was
  // made with. The second one matters more than it looks: a sign-out deletes the cookie, and a deleted cookie is
  // indistinguishable from one that lapsed, so the row's own copy is the only way "they signed out" can still reach
  // this session (`packages/db/migrations/0004_session_platform_bridge.sql`).
  const handle = ctx.cookie[config.api.platformCookieName]?.value ?? session.platformBridge ?? null;
  if (typeof handle !== 'string' || handle.length === 0) return snapshot ?? NO_ACCESS;

  const pending = inFlight.get(sessionId);
  if (pending) return pending;

  const refresh = refreshSessionAccess(ctx, sessionId, handle, snapshot).finally(() => {
    inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, refresh);
  return refresh;
}

/**
 * Ask the platform again and write the answer onto the session row.
 *
 * The refresh reuses the handoff rather than a route of its own: `handoff-bridge` already answers both halves of the
 * question (who is behind this cookie, and what may they do in the app named in the request), and a second endpoint
 * would be a second failure taxonomy to keep in step. The one-time code it also mints is spent only in the flow that
 * needs it — the probe and the sign-in callback — and an unused 60-second key is cheaper than a second contract.
 */
async function refreshSessionAccess(
  ctx: IdentitySource,
  sessionId: string,
  bridge: string,
  fallback: AppAccessSnapshot | null,
): Promise<AppAccessSnapshot> {
  const minted = await codeFromBridge(bridge);
  if ('failure' in minted) {
    // The two "no"s are answered differently, and that is the whole reason the platform distinguishes them:
    //
    //  - **Revoked** — the account signed out (here, at the workspace, or on another app). The link is over, not
    //    stale: the row must stop answering as that account on this request, or the next page load would still show
    //    an avatar over a session somebody ended.
    //  - **Expired** — the handle's own hour ran out. The platform has forgotten a session nobody ended, so the last
    //    known answer is kept and the next read asks again rather than serving a grant that may have been withdrawn.
    if (minted.failure === 'bridge_revoked') {
      await endLinkedSession(ctx, sessionId);
      return NO_ACCESS;
    }
    if (minted.failure === 'bridge_expired') await forgetAccess(sessionId);
    return fallback ?? NO_ACCESS;
  }

  if (!minted.access) return fallback ?? NO_ACCESS;

  try {
    await getDb()
      .update(schema.sessions)
      .set({
        appRoles: minted.access.roles,
        appPermissions: minted.access.permissions,
        appAccessAt: new Date(),
      })
      .where(eq(schema.sessions.id, sessionId));
  } catch {
    // A failed write is not a failed answer: the caller gets the roles the platform just gave, and the next request
    // will try to store them again. Failing the request here would turn a database hiccup into a 500 on `/me`.
  }
  return minted.access;
}

/** Forget the snapshot so the next read asks the platform (`null` means "never asked", not "holds nothing"). */
async function forgetAccess(sessionId: string): Promise<void> {
  try {
    await getDb()
      .update(schema.sessions)
      .set({ appRoles: null, appPermissions: null, appAccessAt: null })
      .where(eq(schema.sessions.id, sessionId));
  } catch {
    // Nothing to do: the row will be refreshed or sign out on its own schedule.
  }
}

/**
 * A keyed caller's access, read from the platform with the token that identifies it.
 *
 * `GET /apps/{code}/roles/me` is the platform's answer to exactly this question, and it is the one route here that
 * carries the token — never to the browser, never to a log line. Any failure is `NO_ACCESS`, for the reason the module
 * header gives: a gate that opens when the identity provider is unreachable is not a gate.
 */
async function accessFromToken(token: string): Promise<AppAccessSnapshot> {
  const base = config.api.authPlatformInternalUrl;
  if (!base) return NO_ACCESS;

  try {
    const response = await fetch(`${base}/apps/${encodeURIComponent(config.api.appCode)}/roles/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
    });
    if (!response.ok) return NO_ACCESS;

    const body = (await response.json()) as { roles?: unknown; permissions?: unknown };
    const roles = Array.isArray(body.roles)
      ? body.roles
          .map((r) => (typeof r === 'string' ? r : (r as { name?: string })?.name))
          .filter((n): n is string => typeof n === 'string')
      : [];
    const permissions = Array.isArray(body.permissions)
      ? body.permissions
          .map((p) => (typeof p === 'string' ? p : (p as { code?: string })?.code))
          .filter((c): c is string => typeof c === 'string')
      : [];
    return { roles, permissions };
  } catch {
    return NO_ACCESS;
  }
}
