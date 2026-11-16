/**
 * Sign-out, in both directions, measured against two running stacks.
 *
 * ```text
 *   bun run test:sso-signout -- --email you@example.test --password '…'
 *   # or, for the credentials this stage knows by name:
 *   SSO_SMOKE_EMAIL=… SSO_SMOKE_PASSWORD=… bun run test:sso-signout
 * ```
 *
 * ## What is being measured
 *
 * The request that made this stage exist was \"logging in is shared, so logging out has to be shared too\" — and that
 * sentence hides four separate claims, each of which can be false on its own:
 *
 *   1. **Signing out here ends the shared session.** The app revokes the handle the browser holds, the platform
 *      reports it `revoked` rather than merely missing, and the app's own link is gone.
 *   2. **The workspace tab cannot undo it.** The tab still holds an access token and a refresh token; both were minted
 *      before the sign-out, and both must be refused — otherwise the tab re-mints the cookie seconds later and
 *      everyone is signed back in (`ISignOutLog` in the Auth Platform).
 *   3. **Signing out there ends this app's link.** The platform deletes the cookie, which is indistinguishable from
 *      an hour running out — so the app asks about the handle it kept, and a `revoked` answer ends the link on the
 *      next request rather than at the end of a refresh window.
 *   4. **Signing in again works.** A rule that invalidates old credentials is one line away from locking everybody
 *      out, so the last check is the recovery: a fresh login links the app again.
 *
 * ## Why this cannot be asserted without the platform
 *
 * Every one of the four is a statement about *two* systems, and three of them are about what a *second* copy of a
 * credential can no longer do. A test with a fake platform would prove that this app posts to the right URL; it would
 * prove nothing about the moment being recorded where the tokens are minted. The stage therefore needs a real pair of
 * stacks and a real account, and it says so — `STACK GAP:` with the recipe — rather than passing on a machine that
 * does not have them.
 *
 * Measurements land in `e2e/artifacts/sso-signout.json`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stackGap } from '../../e2e/lib/stack-gap';

interface Args {
  /** The app under test: its API root, or the web container's origin, which proxies `/api`. */
  base: string;
  /** The platform's web app — the origin that holds the shared cookie and answers `DELETE /api/auth/session`. */
  auth: string;
  /** The platform's API — where tokens are minted and refused. */
  authApi: string;
  jsonPath: string;
  email: string | undefined;
  password: string | undefined;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  auth: (value('--auth') ?? process.env.AUTH_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  authApi: (value('--auth-api') ?? process.env.AUTH_API_URL ?? 'http://localhost:5100').replace(/\/$/, ''),
  jsonPath: value('--json') ?? 'e2e/artifacts/sso-signout.json',
  email: value('--email') ?? process.env.SSO_SMOKE_EMAIL,
  password: value('--password') ?? process.env.SSO_SMOKE_PASSWORD,
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

interface Check {
  check: string;
  detail: string;
}

const checks: Check[] = [];

function step(check: string, detail: string): void {
  checks.push({ check, detail });
  console.log(`  ✓ ${detail}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

// ─── HTTP, with one cookie jar for a browser that spans two origins ──────────

/**
 * A jar keyed by cookie name, the way a browser scopes them by host — both stacks run on `localhost`, so the names
 * are the only thing that distinguishes them, and pretending otherwise would hide the case this stage is here for.
 */
type Jar = Map<string, string>;

async function call(
  url: string,
  jar: Jar,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; jar: Jar }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (jar.size > 0) headers.set('cookie', [...jar].map(([name, v]) => `${name}=${v}`).join('; '));
  let body: BodyInit | null | undefined = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }

  const response = await fetch(url, { ...init, headers, body, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const equals = pair?.indexOf('=') ?? -1;
    if (!pair || equals <= 0) continue;
    const name = pair.slice(0, equals);
    const cookieValue = pair.slice(equals + 1);
    // `Max-Age=0` is how both stacks delete one; keeping an empty value would send `name=` forever.
    if (cookieValue.length === 0) jar.delete(name);
    else jar.set(name, cookieValue);
  }

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    fail(`${url} returned ${response.status} with a body that is not JSON`, text.slice(0, 400));
  }
  return { status: response.status, body: parsed, jar };
}

/** The app's own session cookie, by whichever name the stack runs with. */
const APP_COOKIE = 'pdft_session';
const PLATFORM_COOKIE = 'auth_session';

/**
 * Wait out the second a sign-out was recorded in, then sign in.
 *
 * A credential issued in the same second as a sign-out is refused on purpose (`SignOutLog.Predates` in the Auth
 * Platform, where that direction was measured rather than assumed), and `iat` carries no finer grain. A person cannot
 * sign out and sign back in inside one second; this stage can, and without the wait the *recovery* claim would be
 * measuring that race instead of a sign-in.
 */
async function signInAfterSignOut(jar: Jar): Promise<{ accessToken: string; refreshToken: string }> {
  await Bun.sleep(1100);
  return await signIn(jar);
}

/** Log in at the platform and mint the shared cookie the way its own web app does. */
async function signIn(jar: Jar): Promise<{ accessToken: string; refreshToken: string }> {
  const login = await call(`${args.authApi}/auth/login`, new Map(), {
    method: 'POST',
    json: { email: args.email, password: args.password },
  });
  if (login.status !== 200) {
    fail(`POST /auth/login answered ${login.status}`, login.body);
  }
  const tokens = login.body.tokens as { accessToken?: string; refreshToken?: string } | undefined;
  if (!tokens?.accessToken || !tokens.refreshToken) fail('the login answer carried no tokens', login.body);

  const minted = await call(`${args.auth}/api/auth/session`, jar, {
    method: 'POST',
    json: { accessToken: tokens.accessToken },
  });
  if (minted.status !== 200 || !jar.has(PLATFORM_COOKIE)) {
    fail(`the shared-session cookie was not minted (${minted.status})`, minted.body);
  }
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

async function main(): Promise<void> {
  if (!args.email || !args.password) {
    stackGap(
      'no account to sign in with, and every claim in this stage is about two credential stores talking to each other',
      `pass \`--email\`/\`--password\` (or set \`SSO_SMOKE_EMAIL\`/\`SSO_SMOKE_PASSWORD\`) for an account on the platform at ${args.authApi}, and start both stacks: \`docker compose up -d\` in this repository and in Auth-Platform`,
    );
  }

  const jar: Jar = new Map();
  console.log(`sign-out, both directions → app ${args.base} · platform ${args.auth}\n`);

  // ── 1. A session that is genuinely shared ─────────────────────────────────
  const first = await signIn(jar);

  const probe = await call(`${args.base}/api/v1/sso/probe`, jar, { method: 'POST', json: {} });
  if (probe.status !== 200 || probe.body.linked !== true) {
    fail(`POST /sso/probe did not link an account (${probe.status})`, probe.body);
  }
  step(
    'signing in at the platform signs this app in',
    `POST /sso/probe → linked as ${String(probe.body.userId).slice(0, 8)}… without asking the person to sign in here`,
  );

  const beforeSignOut = await call(`${args.base}/api/v1/me`, jar);
  if (beforeSignOut.body.kind !== 'user')
    fail(`GET /me answered kind=${String(beforeSignOut.body.kind)}`, beforeSignOut.body);
  const handle = jar.get(PLATFORM_COOKIE);
  if (!handle) fail('the shared cookie vanished before the sign-out it is supposed to carry');

  // ── 2. Sign out here ─────────────────────────────────────────────────────
  const signedOut = await call(`${args.base}/api/v1/sso/sign-out`, jar, { method: 'POST', json: {} });
  if (signedOut.body.signedOut !== true) fail('POST /sso/sign-out did not report a sign-out', signedOut.body);
  if (signedOut.body.platform !== 'revoked') {
    fail(
      `the sign-out reported platform=${String(signedOut.body.platform)} — this app did not end the workspace session`,
      signedOut.body,
    );
  }
  step(
    'signing out here ends the workspace session',
    `POST /sso/sign-out → { signedOut: true, platform: "revoked" } (the link here is gone too: GET /me is ${String((await call(`${args.base}/api/v1/me`, jar)).body.kind)})`,
  );

  // ── 3. The handle is revoked, not merely missing ──────────────────────────
  const verified = await call(`${args.authApi}/sso/bridge/verify`, new Map(), {
    method: 'POST',
    json: { bridge: handle },
  });
  if (verified.body.revoked !== true) {
    fail(
      'the platform did not record the revocation — a handle that is merely missing reads as a lapsed hour, and this stage cannot tell a sign-out from one',
      verified.body,
    );
  }
  step(
    'the platform says "ended", not "lapsed"',
    'POST /sso/bridge/verify → { valid: false, revoked: true } — the answer every app branches on',
  );

  // ── 4. Neither credential from before the sign-out can come back ─────────
  const remint = await call(`${args.authApi}/sso/bridge`, new Map(), {
    method: 'POST',
    headers: { authorization: `Bearer ${first.accessToken}` },
    json: {},
  });
  if (remint.status !== 401) {
    fail(
      `the access token minted a new shared-session handle after the sign-out (${remint.status}) — the workspace tab's own polling would sign everyone back in`,
      remint.body,
    );
  }
  step(
    'the workspace tab cannot re-mint what was signed out',
    `POST /sso/bridge with the pre-sign-out access token → 401 ${String(remint.body.error)}`,
  );

  const rotate = await call(`${args.authApi}/auth/token/refresh`, new Map(), {
    method: 'POST',
    json: { refreshToken: first.refreshToken },
  });
  if (rotate.status !== 401) {
    fail(
      `the refresh token still rotates after the sign-out (${rotate.status}) — a session that can renew itself was not signed out`,
      rotate.body,
    );
  }
  step('and neither can its refresh token', 'POST /auth/token/refresh with the pre-sign-out refresh token → 401');

  // ── 5. Signing out there ends this app's link ────────────────────────────
  jar.clear();
  await signInAfterSignOut(jar);
  const relink = await call(`${args.base}/api/v1/sso/probe`, jar, { method: 'POST', json: {} });
  if (relink.body.linked !== true)
    fail('the app would not link again, so the second direction cannot be measured', relink.body);

  const platformSignOut = await call(`${args.auth}/api/auth/session`, jar, { method: 'DELETE' });
  if (platformSignOut.status !== 200)
    fail(`DELETE /api/auth/session answered ${platformSignOut.status}`, platformSignOut.body);

  const afterPlatformSignOut = await call(`${args.base}/api/v1/me`, jar);
  if (afterPlatformSignOut.body.kind === 'user') {
    fail(
      'the app still answers as the account after the platform signed itself out — the deleted cookie was read as a lapsed hour, which is the case this stage exists for',
      afterPlatformSignOut.body,
    );
  }
  step(
    'signing out at the platform signs this app out',
    `GET /me after DELETE /api/auth/session → kind=${String(afterPlatformSignOut.body.kind)} (the link ended on the next request, not on a timer)`,
  );

  // ── 6. Recovery: the rule must not lock anybody out ──────────────────────
  jar.delete(APP_COOKIE);
  await signInAfterSignOut(jar);
  const afterSignIn = await call(`${args.base}/api/v1/sso/probe`, jar, { method: 'POST', json: {} });
  if (afterSignIn.body.linked !== true) {
    fail(
      'a fresh sign-in could not link the app — the sign-out rule outlived the session it was meant to end',
      afterSignIn.body,
    );
  }
  step(
    'a fresh sign-in still works',
    'POST /sso/probe after signing in again → linked, so nothing about a sign-out outlives it',
  );

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify({ measuredAt: new Date().toISOString(), app: args.base, platform: args.auth, checks }, null, 2)}\n`,
  );

  console.log(`\nsign-out holds in both directions — ${checks.length} check(s)`);
  console.log(`Measurements: ${args.jsonPath}`);
  process.exit(0);
}

main().catch((cause: unknown) => {
  console.error('\n✗ the stage threw', cause);
  process.exit(1);
});
