/**
 * A stand-in for the one Auth Platform route PDF Tools reads without a credential.
 *
 * `GET /apps/{code}/public` is answered by the platform's `PublicAppController` in the Auth Platform repository
 * (`docs/CROSS-MODULE.md` §2). This process answers the same route with a value the caller chooses, and it exists for
 * a specific reason: the tenant-first profile (`docker-compose.tenant-first.yml`) has to be **deterministic**.
 *
 * Without it, the profile would point at whatever Auth Platform happens to be running on the developer's machine, and
 * the switch it is testing would be whatever an operator last clicked in admin app management. A profile whose
 * subject is decided by the environment is a profile that silently stops testing anything — the failure this whole
 * plan is about (`docs/0-TENANT-FIRST.md` §6). With it, the answer is a value in the compose file, and three states
 * are reachable by changing one variable:
 *
 *   · `answer` + `false` → the profile's default: the platform forbids anonymous use, so the API is tenant-first
 *     **for the platform's reason** rather than for its local `ALLOW_ANONYMOUS` — the production shape, and the leg
 *     that proves the mirror really asks somebody;
 *   · `answer` + `true` → the same stack, anonymous use allowed, which is how the flag-on behaviour is shown to be
 *     preserved rather than merely assumed;
 *   · `offline` → the platform is unreachable, so the mirror falls back to `ALLOW_ANONYMOUS`/`STRICT_MODE`. The
 *     state that decides whether one flapping dependency takes the product down with it.
 *
 * `PLATFORM_STUB_STRICT_MODE=true` is a second axis rather than a fourth mode: it answers the same route with the
 * *other* switch on, which is what puts a stack in the position where the app publishes no page at all. It is
 * published as a pair — strict mode on means `allowAnonymous: false` — because that pairing is the platform's own rule
 * (`App.StrictMode`), and a stub that sent the incoherent pair would be testing the app's defence against a platform
 * that does not exist.
 *
 * Deliberate limitations, so nobody reads more into it than is here:
 *
 *   · It answers **one** app code (`PLATFORM_STUB_APP_CODE`, default `pdf-tools`) and `404`s anything else. A stub
 *     that answered every code would make the app's own "unknown app is not a policy" handling untestable.
 *   · It is read-only and holds no state. A toggle test changes the compose value and recreates the container, which
 *     is slower than a POST and the right speed: the real switch is an operator action, not a request.
 *
 *   bun run scripts/dev/platform-stub.ts          # then: curl localhost:9999/apps/pdf-tools/public
 */

const port = Number(process.env.PLATFORM_STUB_PORT ?? 9999);
const appCode = process.env.PLATFORM_STUB_APP_CODE ?? 'pdf-tools';
const mode = process.env.PLATFORM_STUB_MODE ?? 'answer';
const strictMode = (process.env.PLATFORM_STUB_STRICT_MODE ?? 'false') === 'true';
// The pair, resolved here rather than left to the app under test: strict mode outranks the anonymous switch, and this
// is the same rule `combineAccessFlags` applies on both sides.
const allowAnonymous = (process.env.PLATFORM_STUB_ALLOW_ANONYMOUS ?? 'false') === 'true' && !strictMode;

if (mode !== 'answer' && mode !== 'offline') {
  console.error(`PLATFORM_STUB_MODE must be 'answer' or 'offline', not '${mode}'`);
  process.exit(1);
}

console.log(
  `platform stub on :${port} — mode=${mode} app=${appCode} allowAnonymous=${
    mode === 'offline' ? 'unreachable' : allowAnonymous
  } strictMode=${mode === 'offline' ? 'unreachable' : strictMode}`,
);

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health/live') {
      // Live, not ready: the stub has no dependencies. An `offline` stub is still *up* — it answers the caller with a
      // failure, which is what "the platform is not answering policy questions" looks like from the other side.
      return Response.json({ status: 'ok' });
    }

    const match = /^\/apps\/([^/]+)\/public$/.exec(url.pathname);
    if (!match) {
      return Response.json({ error: 'not_found', error_description: `No route for ${url.pathname}.` }, { status: 404 });
    }

    const requested = decodeURIComponent(match[1] ?? '');

    if (mode === 'offline') {
      console.log(`  ← 503 ${requested} (mode=offline)`);
      return Response.json(
        { error: 'unavailable', error_description: 'The platform is not answering policy questions.' },
        { status: 503 },
      );
    }

    if (requested !== appCode) {
      console.log(`  ← 404 ${requested} (stub answers only '${appCode}')`);
      return Response.json({ error: 'app_not_found' }, { status: 404 });
    }

    console.log(`  ← 200 ${requested} allowAnonymous=${allowAnonymous} strictMode=${strictMode}`);
    return Response.json({
      code: appCode,
      name: 'PDF Tools',
      isEnabled: true,
      isFree: true,
      allowAnonymous,
      strictMode,
    });
  },
});
