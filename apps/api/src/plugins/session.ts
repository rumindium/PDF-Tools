/**
 * Identity resolution — an account when there is one, an anonymous session when the installation serves them, and a
 * guest when it does not.
 *
 * The browser holds an opaque session id in an HttpOnly cookie; the row in `sessions` is what means anything.
 * When Auth Platform is configured, a Bearer token (forwarded by the web app, never exposed to the browser) wins
 * over the cookie and produces a `user` identity whose plan comes from the entitlement mirror.
 *
 * The third state is new and is the whole of `docs/0-TENANT-FIRST.md` §4: when the installation's anonymous switch
 * is off, a request with no acceptable session resolves as `kind: 'guest'` — no session row is created, no cookie is
 * set, and nothing is written. An anonymous session that already exists keeps resolving as itself, because the
 * switch stops new work rather than withdrawing access to work already done; which of the two may *create* a job is
 * `services/access-policy.ts`'s question, not this module's.
 *
 * Why the cookie is opaque: a real access token with permissions and tenant claims is larger than the 4 KB
 * browser cookie limit, so it would be silently dropped — the failure that made the sibling platforms move tokens
 * server-side. PDF Tools starts from that conclusion instead of rediscovering it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { config } from '@pdftools/config';
import type { AppAccessSnapshot } from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { AppError } from '@pdftools/errors';
import { eq } from 'drizzle-orm';
import type { Context } from 'elysia';
import { appSwitches } from '../services/app-switches';
import { verifyBridge } from '../services/handoff';
import type { OwnerIdentity } from '../services/quota-service';
import { devPlanOverride } from './dev-plan';

function anonIdFromSession(sessionId: string): string {
  return createHash('sha256').update(`${config.session.secret}:${sessionId}`).digest('hex').slice(0, 32);
}

export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${config.session.secret}:${ip}`).digest('hex').slice(0, 32);
}

/**
 * The caller's IP, hashed — when the runtime can produce one.
 *
 * `server.requestIP` accepts only the request object Bun's server owns, and Elysia hands a route its own Request,
 * so this throws for some routes and not others (it threw for every upload, where Elysia keeps the body unparsed
 * and passes a different request wrapper). An IP hash sharpens anonymous quota accounting — it is what stops
 * "clear the cookie, get a new allowance" — but it is never worth failing a request: losing the hash costs the
 * IP-scoped half of that quota, while a 500 costs the user their upload.
 */
function hashedRequestIp(ctx: IdentitySource): string | null {
  try {
    return hashIp(ctx.server?.requestIP(ctx.request)?.address ?? null);
  } catch {
    return null;
  }
}

export interface AuthContext extends Record<string, unknown> {
  identity: OwnerIdentity;
  bearerToken: string | null;
  /** `null` for a guest: there is no session row, which is not the same as a session that could not be found. */
  sessionId: string | null;
}

/**
 * The plan a caller asked to be treated as, when this process is allowed to honour that request.
 *
 * Kept out of the identity union on purpose (see `dev-plan.ts`): `kind: 'anonymous'` still means "no account", and
 * the override rides beside it as `planOverride`, so every reader can tell a paid plan from a granted one.
 */
function planOverrideFor(ctx: IdentitySource) {
  return devPlanOverride(ctx.request, { token: config.session.devPlanToken, env: config.env });
}

/**
 * The parts of Elysia's route context that identity resolution actually reads.
 *
 * This exists instead of the `ctx as never` every caller used to write. That cast made the compiler stop looking,
 * and it was hiding a real bug: two handlers destructured `request` out of the context before calling in, so
 * `ctx.request` was `undefined` — the user-agent line threw, and every *first* upload from a browser that had no
 * session cookie yet answered 500. Naming the four fields makes the requirement part of the type, so a handler
 * that drops one fails `tsc` instead of failing a user.
 */
export interface IdentitySource {
  cookie: Context['cookie'];
  request: Context['request'];
  set: Context['set'];
  server?: Context['server'];
}

/**
 * Resolve (and if necessary create) the caller's identity.
 *
 * Anonymous sessions are created on demand: the first request that needs an owner mints one, so a visitor can
 * upload without ever seeing a sign-in step.
 */
export async function resolveIdentity(ctx: IdentitySource, bearerToken?: string | null): Promise<AuthContext> {
  const db = getDb();
  // Resolved once per request, and used for exactly one decision: whether to mint a session at all. The switch is
  // deliberately **not** copied onto the context for other readers. It was, for one round of this work, as
  // `AuthContext.allowAnonymous` — and a return site then wrote `allowAnonymous: true` as a literal where it meant
  // "the resolved value", so a legacy anonymous cookie carried `true` into a stack whose operator had switched
  // anonymous use off and its upload was accepted. The guard reads the resolver itself
  // (`services/access-policy.ts`), so there is no copy left to get wrong. The lookup is cached and shared, so the
  // second reader pays a memory read rather than a round trip.
  const allowAnonymous = (await appSwitches().resolve()).allowAnonymous;

  if (bearerToken && config.api.authPlatformUrl) {
    const userId = await userIdFromToken(bearerToken);
    if (userId) {
      const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      const user = rows[0];
      if (user) {
        await db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, user.id));
        return {
          identity: {
            kind: 'user',
            ownerId: user.id,
            anonId: null,
            planId: user.planId as 'free' | 'pro' | 'business',
            userId: user.id,
            tenantId: user.tenantId ?? null,
          },
          bearerToken,
          sessionId: user.id,
        };
      }
    }
    // An unverifiable token is a hard failure rather than a silent downgrade: continuing anonymously would let a
    // caller read a *different* (anonymous) history and wonder why their files vanished.
    throw new AppError('UNAUTHORIZED');
  }

  // A signed-in caller is not offered the dev override even when the switch is on: their plan is the entitlement
  // mirror's answer, and replacing it here would hide the code path the switch exists to test (`dev-plan.ts`).

  const cookieName = config.session.cookieName;
  // Normalised to `string | null` immediately: a cookie value arrives as `unknown`, and letting that spread into
  // the code below is how a missing cookie becomes the literal string "undefined" in a database column.
  const rawCookie = ctx.cookie[cookieName]?.value;
  let sessionId: string | null = typeof rawCookie === 'string' && rawCookie.length > 0 ? rawCookie : null;

  if (sessionId) {
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
    const session = rows[0];
    const usable = Boolean(session && !session.revokedAt && session.expiresAt.getTime() > Date.now());

    // **Is this link still a link?** A linked row answers as the account from here on, and the only thing that could
    // have ended it is a sign-out somewhere else — the browser's shared-session cookie is simply gone, which is also
    // what an hour running out looks like. Asking the platform about the handle this link was made with is what tells
    // the two apart, and it is done *here*, before the identity is answered, because "who is this caller" is the
    // question a stale answer is worst at: a route that resolved the account and unlinked it afterwards would report
    // an avatar for one request after the sign-out (`ISignOutLog`, `migrations/0004`).
    //
    // The extra round trip only happens when there is no cookie and a handle to ask about, which is not the normal
    // case: a signed-in browser sends the cookie on every request.
    if (
      usable &&
      session?.kind === 'user' &&
      session.userId &&
      !sessionPlatformBridge(ctx) &&
      session.platformBridge &&
      (await verifyBridge(session.platformBridge)) === 'revoked'
    ) {
      await endLinkedSession(ctx, session.id);
      // Resolved again rather than patched up in place: whether this browser is now anonymous or a guest is
      // `endLinkedSession`'s decision, and re-reading it is one query against a rule kept in one place. It terminates
      // because the row is anonymous (or gone) by the time it runs.
      return await resolveIdentity(ctx, bearerToken);
    }

    // A session that was linked to an Auth Platform account (`POST /sso/consume`) resolves as that account from
    // then on — no token in the cookie, no token in the browser. The same cookie, the same `anonId`: the link
    // attaches the account to the session rather than replacing it, which is what keeps anything already
    // uploaded visible across the moment of signing in.
    if (usable && session?.kind === 'user' && session.userId) {
      const userRows = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
      const user = userRows[0];
      if (user) {
        await db.update(schema.sessions).set({ lastUsedAt: new Date() }).where(eq(schema.sessions.id, session.id));
        await db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, user.id));
        return {
          identity: {
            kind: 'user',
            ownerId: user.id,
            anonId: null,
            planId: user.planId as 'free' | 'pro' | 'business',
            userId: user.id,
            tenantId: user.tenantId ?? null,
          },
          bearerToken: null,
          sessionId: session.id,
        };
      }
    }

    const valid = usable && session?.kind === 'anonymous';
    if (valid) {
      await db.update(schema.sessions).set({ lastUsedAt: new Date() }).where(eq(schema.sessions.id, sessionId));
      const override = planOverrideFor(ctx);
      return {
        identity: {
          kind: 'anonymous',
          ownerId: session.id,
          anonId: session.anonId ?? session.id,
          planId: 'anonymous',
          userId: null,
          tenantId: null,
          ...(override ? { planOverride: override } : {}),
        },
        bearerToken: null,
        sessionId: session.id,
      };
    }
    sessionId = null;
  }

  // ── No usable session: mint one, or refuse to ───────────────────────────
  // This is the single line that makes the product tenant-first when the switch is off, and it is deliberately a
  // *refusal to create* rather than a deletion of anything: an installation that turns anonymous use off stops
  // minting sessions and stops accepting new work from them, and every request that used to arrive as "a new
  // anonymous session" now arrives as a guest
  // (`docs/0-TENANT-FIRST.md` §4.3). Nothing is written here, so there is no row to clean up afterwards.
  if (!allowAnonymous) {
    return {
      identity: { kind: 'guest', ownerId: null, anonId: null, planId: null, userId: null, tenantId: null },
      bearerToken: null,
      sessionId: null,
    };
  }

  sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + config.session.anonTtlHours * 3600_000);
  await db.insert(schema.sessions).values({
    id: sessionId,
    kind: 'anonymous',
    anonId: anonIdFromSession(sessionId),
    ipHash: hashedRequestIp(ctx),
    userAgent: ctx.request.headers.get('user-agent')?.slice(0, 400) ?? null,
    expiresAt,
  });

  // The header is written directly rather than through `ctx.cookie[name] = {...}`: Elysia's cookie object is a
  // cookie-jar wrapper, and assigning a plain object to it is not the same as emitting a `Set-Cookie`. One
  // attribute list, spelled out, is easier to audit than a chained builder — and `HttpOnly` is the whole reason
  // this session id can be trusted at all.
  ctx.set.headers['Set-Cookie'] = sessionCookie(cookieName, sessionId, config.session.anonTtlHours * 3600);

  const override = planOverrideFor(ctx);
  return {
    identity: {
      kind: 'anonymous',
      ownerId: sessionId,
      anonId: anonIdFromSession(sessionId),
      planId: 'anonymous',
      userId: null,
      tenantId: null,
      ...(override ? { planOverride: override } : {}),
    },
    bearerToken: null,
    sessionId,
  };
}

/**
 * Verify a Bearer token against Auth Platform's JWKS and return the local user id.
 *
 * Signature verification is delegated to the platform (`/auth/me`) rather than re-implemented: PDF Tools must
 * never be the component that decides whether a platform token is valid, and a network round trip per request is
 * acceptable because the web app sends this only when it has a session to forward.
 */
export async function userIdFromToken(token: string): Promise<string | null> {
  const base = config.api.authPlatformInternalUrl;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const profile = (await res.json()) as {
      id?: string;
      sub?: string;
      tenantId?: string;
      email?: string;
      firstName?: string;
      lastName?: string;
    };
    const authUserId = profile.id ?? profile.sub;
    if (!authUserId) return null;

    // Assembled here rather than read from a `displayName` field the platform does not send: `/auth/me` answers with
    // the parts of a name, and the mirror is what shows a name in the account page.
    const displayName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || null;
    const tenantId = profile.tenantId ?? null;

    // Link or create the local mirror row so jobs can carry a real user id and tenant.
    const db = getDb();
    const existing = (await db.select().from(schema.users).where(eq(schema.users.authUserId, authUserId)).limit(1))[0];
    if (existing) {
      // A row mirrored before the platform reported a tenant (or before this code asked for a name) is not
      // re-created — `jobs.owner_id` and every usage row point at its id. It is filled in, so the first handoff
      // after the platform started answering completes the record instead of leaving it blank for its lifetime.
      if (existing.tenantId !== tenantId || existing.displayName !== displayName) {
        await db
          .update(schema.users)
          .set({ tenantId, displayName, email: profile.email ?? existing.email })
          .where(eq(schema.users.id, existing.id));
      }
      return existing.id;
    }

    const id = randomUUID();
    await db
      .insert(schema.users)
      .values({
        id,
        authUserId,
        tenantId,
        email: profile.email ?? '',
        displayName,
        planId: 'free',
      })
      .onConflictDoNothing();
    return id;
  } catch {
    return null;
  }
}

export interface LinkedSession {
  sessionId: string;
  userId: string;
  tenantId: string | null;
  displayName: string | null;
  planId: string;
  /** What the platform said this link may do, as a snapshot (`services/app-access.ts`). */
  access: AppAccessSnapshot;
}

/**
 * Move one anonymous session's rows onto the account that just signed in on it.
 *
 * Deliberately one helper rather than three inline updates: every table that answers "whose is this" has to move
 * together, and a table missed here is a half-adopted session — history that shows a job but not the file it was
 * built from, or a job the caller can open but cannot list.
 *
 * `anon_id` is left in place on every row. It is the record of how the work arrived, it is what the aggregate
 * anonymous counters read, and clearing it would delete the only trace that the account had used the tool before
 * signing in.
 */
async function adoptAnonymousWork(
  sessionId: string,
  anonId: string | null,
  userId: string,
  tenantId: string | null,
): Promise<void> {
  const db = getDb();
  const owner = { ownerId: userId, ownerKind: 'user' as const, userId, tenantId };
  await db.update(schema.jobs).set(owner).where(eq(schema.jobs.ownerId, sessionId));
  await db.update(schema.files).set(owner).where(eq(schema.files.ownerId, sessionId));
  // Usage rows have no `owner_id`: they are read back by `user_id` once there is an account, so the column the
  // usage view filters on is the one that has to be written.
  if (anonId) {
    await db.update(schema.usageRecords).set({ userId, tenantId }).where(eq(schema.usageRecords.anonId, anonId));
  }
}

/**
 * Attach an Auth Platform account to the caller's session, keeping the session itself.
 *
 * This is the whole of "no second login": the app never holds a platform token, it holds a session row that now
 * *means* an account. Two consequences worth being explicit about, because both are deliberate:
 *
 *  - **Work already done under the anonymous session is adopted by the account.** Job and file rows are keyed by
 *    `owner_id`, so switching the identity to the account without moving them would empty the caller's history at
 *    the exact moment they signed in — the "my files vanished" failure the token path already guards against. The
 *    rows are re-owned here instead, and the `anon_id` stays on them as the record of where they came from.
 *    Nothing is leaked by doing that: the browser session *was* the boundary, and the caller signing in is the
 *    caller holding the cookie.
 *  - **A caller with no session gets one now.** A visitor who lands on the handoff URL in a fresh browser has
 *    never uploaded anything, but they still need a row for the cookie to point at — otherwise the next request
 *    would mint an anonymous session and silently undo the link.
 */
export async function linkSessionToUser(
  ctx: IdentitySource,
  userId: string,
  access: AppAccessSnapshot | null = null,
): Promise<LinkedSession> {
  const db = getDb();
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new AppError('UNAUTHORIZED', 'The platform account could not be mirrored locally.');

  const cookieName = config.session.cookieName;
  const rawCookie = ctx.cookie[cookieName]?.value;
  const cookieSessionId = typeof rawCookie === 'string' && rawCookie.length > 0 ? rawCookie : null;
  const existing = cookieSessionId
    ? (await db.select().from(schema.sessions).where(eq(schema.sessions.id, cookieSessionId)).limit(1))[0]
    : undefined;

  // A revoked or expired cookie is not a session to upgrade — mint a fresh row instead, so a link can never
  // resurrect one that was deliberately ended.
  const reusable = existing && !existing.revokedAt && existing.expiresAt.getTime() > Date.now();
  const sessionId = reusable ? existing.id : randomUUID();
  const ttlHours = config.session.anonTtlHours;

  // The snapshot is written with the link and **overwritten with the answer of this link**, including with `null`:
  // a cookie that signs in as somebody else must not keep reading the previous account's roles, and `null` is the
  // state that makes the next read ask the platform rather than believe a stale list. Both argument orders matter
  // here — `access` is what the platform said *about this sign-in*.
  const snapshot = access ?? null;

  // The handle the browser presented, kept beside the link (migration 0004). It is what lets this session still be
  // asked about after the cookie is gone: without it, "the platform signed us out" and "the hour ran out" are the
  // same observation from here, and the two demand opposite answers.
  const platformBridge = sessionPlatformBridge(ctx);

  if (reusable) {
    await db
      .update(schema.sessions)
      .set({
        kind: 'user',
        userId: user.id,
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
        appRoles: snapshot?.roles ?? null,
        appPermissions: snapshot?.permissions ?? null,
        appAccessAt: snapshot ? new Date() : null,
        // Only overwritten when this link actually presented one: a re-link by URL code (no cookie involved) must not
        // erase the handle an earlier cookie left, which is the only handle this row will ever have to ask about.
        ...(platformBridge ? { platformBridge } : {}),
      })
      .where(eq(schema.sessions.id, sessionId));
  } else {
    await db.insert(schema.sessions).values({
      id: sessionId,
      kind: 'user',
      userId: user.id,
      anonId: anonIdFromSession(sessionId),
      ipHash: hashedRequestIp(ctx),
      userAgent: ctx.request.headers.get('user-agent')?.slice(0, 400) ?? null,
      expiresAt: new Date(Date.now() + ttlHours * 3600_000),
      appRoles: snapshot?.roles ?? null,
      appPermissions: snapshot?.permissions ?? null,
      appAccessAt: snapshot ? new Date() : null,
      platformBridge,
    });
  }

  // Adopt whatever the anonymous session owned. Ordered before the cookie is re-emitted so a caller cannot see a
  // linked identity whose history is still on the old owner.
  if (reusable) await adoptAnonymousWork(sessionId, existing.anonId ?? null, user.id, user.tenantId ?? null);

  await db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, user.id));
  // Always re-emitted, not only for the fresh row: it is what makes the link stick for a caller whose cookie
  // pointed at a session this endpoint just replaced.
  ctx.set.headers['Set-Cookie'] = sessionCookie(cookieName, sessionId, ttlHours * 3600);

  return {
    sessionId,
    userId: user.id,
    tenantId: user.tenantId ?? null,
    displayName: user.displayName ?? null,
    planId: user.planId,
    access: snapshot ?? { roles: [], permissions: [] },
  };
}

/**
 * The two ways to end a session's link to an account (`POST /api/v1/sso/sign-out`), and how to choose between them.
 *
 * The choice is not a taste: **what this browser becomes should be exactly what this installation would have given it
 * as a stranger.**
 *
 *  - An installation that serves visitors (`revertSessionToAnonymous`) already has an identity for a caller with no
 *    account, and it is the one this browser held before signing in — the same row, the same `anon_id`, the same
 *    hourly allowance. Revoking instead would hand a fresh quota bucket to anyone who pressed Sign out, i.e. a way to
 *    reset a limit that exists to stop exactly that.
 *  - An installation that requires an account (`revokeLinkedSession`) has no such floor. A row flipped back to
 *    anonymous would resolve as a read-only anonymous session — an identity that cannot start anything, on a screen
 *    with no way to say so — which is the state §4.3 documents for a session that *predates* the switch, not one a
 *    person asks for. Revoked, the caller resolves as a `guest` and the sign-in gate does its job.
 *
 * Neither path hands back work the account adopted. `jobs` and `files` rows were re-owned when the account signed in
 * (`adoptAnonymousWork`), and un-adopting them would make an account's own history follow a cookie around: whoever
 * held it next would read jobs the account ran. Signing out is about who this browser is from now on, not about
 * undoing what the account already did.
 */
export async function revertSessionToAnonymous(sessionId: string): Promise<void> {
  await getDb()
    .update(schema.sessions)
    .set({
      kind: 'anonymous',
      userId: null,
      // The snapshot goes with the account: an anonymous session holding `admin` would be a browser that signed out
      // and kept the menu — and the refresh would never ask again, because a snapshot that exists and is fresh is
      // exactly what stops it asking.
      appRoles: null,
      appPermissions: null,
      appAccessAt: null,
      // So does the handle: it is a credential for the session that just ended, and holding on to it would let this
      // anonymous session keep asking the platform questions on the departed account's behalf.
      platformBridge: null,
    })
    .where(eq(schema.sessions.id, sessionId));
}

/**
 * End a link because it is over — whichever way this installation answers that (`revertSessionToAnonymous` and
 * `revokeLinkedSession` above spell out the choice).
 *
 * Extracted so the two places that end a session for *this* reason cannot drift apart: the sign-out route, where a
 * person asked for it, and the access refresh, where the platform answered `bridge_revoked` — a sign-out that happened
 * somewhere else and has to land here.
 */
export async function endLinkedSession(ctx: IdentitySource, sessionId: string): Promise<'anonymous' | 'revoked'> {
  if ((await appSwitches().resolve()).allowAnonymous) {
    await revertSessionToAnonymous(sessionId);
    return 'anonymous';
  }

  await revokeLinkedSession(sessionId);
  clearSessionCookie(ctx);
  return 'revoked';
}

/**
 * The shared-session handle this browser presented, or `null`.
 *
 * Read from the platform's cookie by the name this installation is configured with (`AUTH_PLATFORM_SESSION_COOKIE`),
 * because the value in it **is** the handle — the platform's web app stores an opaque 43-character string there rather
 * than a token (`services/handoff.ts`).
 */
export function sessionPlatformBridge(ctx: IdentitySource): string | null {
  const value = ctx.cookie[config.api.platformCookieName]?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function revokeLinkedSession(sessionId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export function clearSessionCookie(ctx: IdentitySource): void {
  // An expired `Set-Cookie` is the only reliable way to remove one; deleting the value would leave the browser
  // sending an empty cookie forever.
  ctx.set.headers['Set-Cookie'] = sessionCookie(config.session.cookieName, '', 0);
}

/**
 * Build the `Set-Cookie` value for the anonymous session.
 *
 * `SameSite=Lax` is deliberate: the app and the API share an origin, so `Strict` would buy nothing and would break
 * the redirect back from the Auth Platform handoff. `Secure` is set when the process is not in development, so a
 * production deployment can never accidentally ship a cookie a proxy could read in the clear.
 */
function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.env !== 'development' && config.env !== 'test') attributes.push('Secure');
  return `${name}=${value}; ${attributes.join('; ')}`;
}
