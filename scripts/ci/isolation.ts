import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAnonymousUse } from '../../e2e/lib/stack-gap';

/**
 * The two properties that make a worker safe to hand a stranger's document to, measured on the running stack.
 *
 *   bun run test:isolation
 *
 * They are not unit-testable and they are not golden cases: one is a property of the *topology* the pools run in, the
 * other of the *image* they run from. Both were false when this harness was written, and both were found by measuring
 * rather than by reading:
 *
 *   - an office worker reached `example.com` (HTTP 200) on the default bridge, while LibreOffice *does* issue a real
 *     request for an `<img src="http://…">` during `--convert-to pdf`. That pair is a request proxy for anyone who can
 *     upload a document, which is the opposite of what `docs/0-SECURITY.md` §7 tells operators;
 *   - a well-formed Basic macro in a valid user profile, invoked through LibreOffice's own `macro:///` URI, produced
 *     a marker file (the first version of this harness asked that question and got a *yes*, having asked it of a
 *     profile LibreOffice had never initialised — see leg 4, which is now about the policy the engine actually runs
 *     with rather than a premise that was simply not true).
 *
 * The legs are deliberately paired, because each half alone can pass for the wrong reason:
 *
 *   1. **No route out.** Every pool fails to fetch `example.com`; the API container succeeds on the same request, so a
 *      stack with no working DNS anywhere cannot be reported as an isolated one.
 *   2. **The renderer would fetch.** A loopback listener inside the office container records the image request when the
 *      fixture is converted *directly by the engine* — the handler bypassed. Without this, leg 3 would be satisfied by
 *      a document that never asked for anything.
 *   3. **The handler refuses instead.** The same fixture through the ordinary API refuses with
 *      `REMOTE_RESOURCES_BLOCKED`, and the listener records nothing new. Loopback is reachable whatever the network
 *      policy is, so this leg fails if the guard is removed even while leg 1 still holds — which is the regression a
 *      network policy cannot catch.
 *   4. **The macro policy the engine runs with, and the fact that it can run one.** An application-scope macro in a
 *      user profile leaves a marker (so nothing here rests on "there is no runtime" — there is one), and the same
 *      profile reports the engine's effective document-macro level, which must stay at the High default (2, unsigned
 *      macros disabled). That pair is what the refusal guard stands in front of: a product decision in front of an
 *      engine whose own policy is a configuration value an image upgrade can move.
 *   5. **A script in an HTML document does not run.** The HTML path's macro question in the form HTML can carry: the
 *      fixture's `<script>` would request a loopback URL if a JavaScript runtime executed it, and the file must still
 *      **convert** — a page with a script tag is ordinary HTML. LibreOffice's HTML import has no JS runtime today,
 *      and this stage's plan for the tool (D2) names Chromium, which does, so this is a property worth measuring
 *      rather than assuming: the request that would appear is the check that fails if a runtime arrives.
 *   6. **The guard refuses *schemes*, not the two it was written for.** `macro:///Standard.Module1.Main` is a URI
 *      this engine resolves and executes (leg 4 runs one), named in an HTML document where an image would be. The
 *      document must be refused, which is the end-to-end half of "every scheme is external" — the unit test is the
 *      other half.
 *   7. **A document's own Basic library, and what the conversion does with it.** Leg 7 hands the engine a document
 *      carrying a real Basic library (`office-to-pdf-document-macro.odt`, in the layout LibreOffice itself writes —
 *      which is how the fixture was built: the engine authored one and the package was read back). The control is
 *      the input: the package really carries the library, the module, and both subs, read from inside the worker.
 *      The measurement is the engine's own `--convert-to pdf`, run against that document **twice** — under the
 *      shipped policy (High) and under a scratch profile lowered to Low — and neither the sub an invocation would
 *      run nor the `dom:load` listener the document names may leave a marker, while the document must still
 *      become a PDF. Both policies, because "the policy is why" is the explanation one run cannot rule out.
 *      What this does **not** establish is stated in the run rather than implied: nothing here shows that this
 *      engine would ever execute a *document's* Basic, because the one invocation route a CLI exposes
 *      (`macro:///`) addresses the **profile** library — leg 4 — and `location=document` is not reachable from a
 *      command line. The claim is "the conversion path runs none of it", not "document Basic cannot run".
 *   8. **The boundary is the network, and all four compose files keep it.** Every pool in every compose file this
 *      repository ships — development, CI, production, and the from-scratch verification override — must join
 *      internal-only networks *when resolved the way Docker resolves them* (`compose config`, anchors and overrides
 *      included), because the file a human reads and the topology a container gets are not the same artifact. And
 *      the second half, which is what makes the first a policy with a measured boundary rather than a claim: the
 *      same image, started by hand outside compose, **does** reach the internet. The isolation is the network
 *      attachment and not the image, so a deployment that starts a pool itself has to reproduce it.
 *
 * The measurements land in `e2e/artifacts/isolation.json`, like every other stage's.
 */

interface Args {
  base: string;
  project: string;
  probePort: number;
  service: string;
  jsonPath: string;
  skipEngine: boolean;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  project: value('--project') ?? 'pdf-tools',
  probePort: Number(value('--probe-port')) || 9913,
  service: value('--service') ?? 'worker-office',
  jsonPath: value('--json') ?? 'e2e/artifacts/isolation.json',
  // The engine leg converts a fixture with LibreOffice, so it needs the office image; a stack without one can still
  // run the other three, and says which leg it skipped rather than reporting a pass.
  skipEngine: argv.includes('--skip-engine'),
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'html-to-pdf-remote-asset.html');
const SCRIPT_FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'html-to-pdf-script.html');
const MACRO_URI_FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'html-to-pdf-macro-uri.html');
/** A document that really carries Basic, for leg 7 — see the fixture's own comment for the layout and why it is that. */
const DOCUMENT_MACRO_FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'office-to-pdf-document-macro.odt');
const DOCUMENT_MACRO_INVOKED = '/tmp/isolation/document-macro-invoked';
const DOCUMENT_MACRO_ONLOAD = '/tmp/isolation/document-macro-onload';
/** The scratch profiles leg 7 converts with: the image's own policy, and the same engine with document macros allowed. */
const DOCUMENT_MACRO_PROFILE = '/tmp/isolation/shipped-profile';
const DOCUMENT_MACRO_LOOSE_PROFILE = '/tmp/isolation/loose-profile';
const POOLS = ['worker-light', 'worker-office', 'worker-heavy', 'worker-ocr'];
const CONTROL_CONTAINER = 'api';

/**
 * The egress probe, kept as the program it is rather than as the shell string it is usually embedded in.
 *
 * Three legs ask the same question of three different places — every pool through `compose exec`, the API as the
 * positive control, and the same image started by hand outside compose — and a comparison between answers produced
 * by three different probes would be no comparison at all. One request to a name that has to be resolved, and the
 * answer classified: a blocked request raises (no route, or no DNS), a reached one returns a status.
 */
const PYTHON_EGRESS_PROBE = [
  'import urllib.request',
  'try:',
  "    r = urllib.request.urlopen('http://example.com', timeout=8)",
  "    print('REACHED', r.status)",
  'except Exception as e:',
  "    print('BLOCKED', type(e).__name__)",
].join('\n');

/** The same question for images with no python3 — `Dockerfile.api` drops it on purpose. */
const BUN_EGRESS_PROBE =
  'const r = await fetch("http://example.com", { signal: AbortSignal.timeout(8000) })' +
  '.then((r) => console.log("REACHED", r.status)).catch((e) => console.log("BLOCKED", e.name))';

/**
 * The four topologies this repository ships, named by what a human calls them and by the file(s) Docker resolves.
 *
 * `pools` is the number of worker services the file is expected to define: production and development carry all
 * four, the CI stack deliberately runs the light pool alone, and the from-scratch verification file is an *override*
 * on top of the development one. A file that lost its pools entirely would otherwise pass a check that only inspects
 * the pools it finds.
 *
 * Production's required variables are placeholders and are never used to start anything: `compose config`
 * interpolates and resolves, it does not connect, and this leg is about the topology the file describes.
 */
const COMPOSE_TARGETS: Array<{ name: string; files: string[]; pools: number; env?: Record<string, string> }> = [
  { name: 'development', files: ['docker-compose.yml'], pools: POOLS.length },
  { name: 'CI', files: ['docker-compose.ci.yml'], pools: 1 },
  {
    name: 'production',
    files: ['docker-compose.prod.yml'],
    pools: POOLS.length,
    env: {
      DATABASE_URL: 'postgres://unused@unused:5432/unused',
      REDIS_URL: 'redis://unused:6379',
      SESSION_SECRET: 'unused',
      PUBLIC_API_URL: 'https://unused.invalid',
      CORS_ORIGINS: 'https://unused.invalid',
      POSTGRES_PASSWORD: 'unused',
      PUBLIC_HOST: 'unused.invalid',
      ACME_EMAIL: 'unused@unused.invalid',
    },
  },
  {
    name: 'from-scratch verification',
    files: ['docker-compose.yml', 'docker-compose.verify.yml'],
    pools: POOLS.length,
  },
];

const steps: string[] = [];
const results: Array<{ leg: string; status: 'pass' | 'skip'; detail: string }> = [];

function step(leg: string, detail: string): void {
  steps.push(detail);
  results.push({ leg, status: 'pass', detail });
  console.log(`  ✓ ${detail}`);
}

function skip(leg: string, detail: string): void {
  results.push({ leg, status: 'skip', detail });
  console.log(`  – ${detail}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  console.error('\nresults so far:');
  for (const entry of steps) console.error(`  · ${entry}`);
  process.exit(1);
}

/** One statement inside a container, with both streams merged — the reason is usually on stderr. */
/** One command on the host, with both streams merged — this stage orchestrates Docker and measures the result. */
async function onHost(command: string[], env?: Record<string, string>): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    ...(env ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

/** POSIX single-quoting: the program has quotes of its own, and a half-escaped one-liner is how a probe lies. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One statement inside a container, with both streams merged — the reason is usually on stderr. */
async function inContainer(service: string, script: string, asRoot = false): Promise<{ code: number; output: string }> {
  const command = [
    'docker',
    'compose',
    'exec',
    '-T',
    ...(asRoot ? ['--user', 'root'] : []),
    service,
    'sh',
    '-c',
    script,
  ];
  const proc = Bun.spawn(command, { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

/** Ship bytes into a container as base64: no quoting rules, and the size is read back so a truncation is visible. */
async function writeIntoContainer(service: string, path: string, content: string): Promise<void> {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const written = await inContainer(
    service,
    `mkdir -p $(dirname ${path}) && printf %s '${encoded}' | base64 -d > ${path}`,
  );
  if (written.code !== 0) fail(`could not write ${path} in ${service}`, written.output.trim());
  const size = await inContainer(service, `wc -c < ${path}`);
  if (Number(size.output.trim()) !== Buffer.byteLength(content, 'utf8')) {
    fail(`${path} in ${service} is ${size.output.trim()} bytes, not the ${Buffer.byteLength(content, 'utf8')} written`);
  }
}

/** Ship a binary into a container. Base64 for the same reason text is: no quoting rules to get wrong. */
async function writeBytesIntoContainer(service: string, path: string, bytes: Uint8Array): Promise<void> {
  const encoded = Buffer.from(bytes).toString('base64');
  const written = await inContainer(
    service,
    `mkdir -p $(dirname ${path}) && printf %s '${encoded}' | base64 -d > ${path} && wc -c < ${path}`,
  );
  const size = Number(written.output.trim());
  if (size !== bytes.length) fail(`${path} in ${service} is ${size} bytes, not the ${bytes.length} written`);
}

/**
 * Prepare a user profile the engine will use, and (optionally) lower the document-macro policy inside it.
 *
 * `--terminate_after_init` is the bootstrap: LibreOffice discards anything written into a profile it has never
 * started, which cost this harness a wrong answer once (leg 4's comment). The level is written into
 * `registrymodifications.xcu` — the profile's own configuration overlay — as the `fuse`-merged item the engine
 * reads at startup, and never into the image, because a stage that changed the image's policy would be measuring
 * itself.
 */
async function prepareProfile(service: string, profile: string, documentMacros: 'shipped' | 'low'): Promise<void> {
  await inContainer(
    service,
    `rm -rf ${profile} && timeout 300 soffice --headless --terminate_after_init --norestore --nolockcheck --nologo --nodefault --nofirststartwizard -env:UserInstallation=file://${profile} >/dev/null 2>&1; test -f ${profile}/user/registrymodifications.xcu && echo bootstrapped`,
  ).then((result) => {
    if (!result.output.includes('bootstrapped'))
      fail(`${profile} did not bootstrap in ${service}`, result.output.trim());
  });

  if (documentMacros === 'low') {
    const lowered = await inContainer(service, `python3 /tmp/isolation/lower_policy.py ${profile}`);
    if (!lowered.output.includes('MacroSecurityLevel=0')) {
      fail(`could not lower the document-macro policy in ${profile}`, lowered.output.trim());
    }
  }
}

/**
 * What the engine's own conversion does with a document, using the exact command the handler builds.
 *
 * The filter name matters: `writer_pdf_Export`, not a bare `pdf`, and the load path is the product's — which is the
 * whole point of running it here rather than asserting what the load path does.
 */
async function convertWithEngine(service: string, profile: string, document: string): Promise<string> {
  const converted = await inContainer(
    service,
    [
      'mkdir -p /tmp/isolation/out',
      'rm -f /tmp/isolation/out/*.pdf',
      `timeout 180 soffice --headless --norestore --nolockcheck --nologo --nodefault --nofirststartwizard --invisible -env:UserInstallation=file://${profile} --convert-to pdf:writer_pdf_Export --outdir /tmp/isolation/out ${document}`,
      'ls /tmp/isolation/out',
    ].join(' && '),
  );
  if (!converted.output.includes('.pdf')) fail(`the engine produced no PDF for ${document}`, converted.output.trim());
  return converted.output.trim();
}

/** Whether a file the engine may have written exists inside the container. */
async function markerPresent(service: string, path: string): Promise<boolean> {
  const result = await inContainer(service, `test -f ${path} && echo present || echo absent`);
  return result.output.includes('present');
}

/**
 * Whether a container can reach the public internet, from inside it.
 *
 * `python3` where the image has it, `bun` where it does not — and the API image deliberately does not (a smaller
 * attack surface, `infra/docker/Dockerfile.api`). The control leg would otherwise fail on the *probe* rather than on
 * the property, and a control that cannot run is worse than no control: it would turn "the API cannot reach the
 * internet either" into a reason to skip the leg that matters.
 */
async function reachesInternet(service: string): Promise<{ reached: boolean; detail: string }> {
  const script = [
    'if command -v python3 >/dev/null 2>&1; then',
    `python3 -c ${shellQuote(PYTHON_EGRESS_PROBE)}`,
    'else',
    `bun -e ${shellQuote(BUN_EGRESS_PROBE)}`,
    'fi',
  ].join('\n');
  const result = await inContainer(service, script);
  const line = classifyEgress(result.output);
  if (!line) return { reached: false, detail: `no answer from the probe: ${result.output.trim().slice(0, 160)}` };
  return { reached: line.startsWith('REACHED'), detail: line.trim() };
}

/** The probe's answer, wherever in the merged output it landed — a warning line often comes first. */
function classifyEgress(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('REACHED') || line.startsWith('BLOCKED'));
}

/**
 * The topology Docker would create from a compose file — resolved, not read.
 *
 * `compose config` merges the `-f` files, applies the anchors (`<<: *worker-common`), and fills in the network a
 * service is attached to when it never names one, which is the difference this leg exists for: the production file
 * once had no `networks:` key anywhere while its pools ran with a route to the internet, and every reading of the
 * YAML that stopped at "there is no `internal: true` to argue with" would have agreed with the file.
 */
async function composeTopology(target: {
  name: string;
  files: string[];
  env?: Record<string, string>;
}): Promise<{
  services: Record<string, { networks?: Record<string, unknown> }>;
  networks?: Record<string, { internal?: boolean }>;
}> {
  const files = target.files.flatMap((file) => ['-f', file]);
  const resolved = await onHost(['docker', 'compose', ...files, 'config', '--format', 'json'], target.env);
  if (resolved.code !== 0) {
    fail(
      `\`docker compose ${files.join(' ')} config\` failed for ${target.name}`,
      resolved.output.trim().slice(0, 600),
    );
  }
  try {
    return JSON.parse(resolved.output);
  } catch {
    fail(`could not parse the resolved topology for ${target.name}`, resolved.output.trim().slice(0, 400));
  }
}

/**
 * Lower the document-macro policy inside one scratch profile, and say so on stdout.
 *
 * Written as a file rather than as a shell one-liner because the item it inserts is XML full of quotes, and a stage
 * whose setup line is unreadable is a stage whose setup line is wrong eventually. It edits only the profile handed to
 * it: the image's own policy must stay at the shipped value, or leg 4's reading and this leg's control would be
 * measuring the harness.
 */
const LOWER_POLICY_SCRIPT = `
import sys

path = sys.argv[1] + '/user/registrymodifications.xcu'
item = (
    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
    '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>'
)
text = open(path).read()
if 'MacroSecurityLevel' not in text:
    text = text.replace('</oor:items>', item + '</oor:items>')
    open(path, 'w').write(text)
print('MacroSecurityLevel=0' if 'MacroSecurityLevel' in text else 'MacroSecurityLevel=unchanged')
`;

/** The listener the fetches would arrive at, and the only evidence a fetch happened. */
const PROBE_SCRIPT = `
import http.server, socketserver

LOG = '/tmp/isolation/probe.log'
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' '0d0a2db40000000049454e44ae426082')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(LOG, 'a') as handle:
            handle.write('REQUEST ' + self.path + chr(10))
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(PNG)))
        self.end_headers()
        self.wfile.write(PNG)

    def log_message(self, *ignored):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as server:
    server.serve_forever()
`;

async function probeRequests(service: string): Promise<number> {
  const result = await inContainer(service, 'cat /tmp/isolation/probe.log 2>/dev/null | wc -l');
  return Number(result.output.trim()) || 0;
}

async function startProbe(service: string): Promise<void> {
  await inContainer(service, 'rm -f /tmp/isolation/probe.log');
  await writeIntoContainer(service, '/tmp/isolation/probe.py', PROBE_SCRIPT.replace('PORT', String(args.probePort)));
  const started = await inContainer(
    service,
    'cd /tmp/isolation && nohup python3 probe.py > probe.stdout 2>&1 & sleep 2; echo started',
  );
  if (!started.output.includes('started')) fail(`the probe did not start in ${service}`, started.output.trim());
  // The control the whole leg rests on: a listener that is not proven to record would make "no requests arrived" an
  // assertion about a broken probe.
  const selfCheck = await inContainer(
    service,
    `python3 -c "import urllib.request; print('selfcheck', urllib.request.urlopen('http://127.0.0.1:${args.probePort}/selfcheck.png', timeout=5).status)"`,
  );
  if (!selfCheck.output.includes('selfcheck 200'))
    fail('the probe did not answer its own self-check', selfCheck.output.trim());
  const recorded = await probeRequests(service);
  if (recorded !== 1) fail(`the probe recorded ${recorded} request(s) for its own self-check, expected exactly 1`);
  step('probe', `the loopback listener in ${args.service} answers, and records what it answers (1 self-check request)`);
}

async function stopProbe(service: string): Promise<void> {
  await inContainer(service, 'pkill -f isolation/probe.py 2>/dev/null; rm -f /tmp/isolation/probe.log; echo cleaned');
}

/**
 * Convert the fixture with the engine directly, the handler out of the way.
 *
 * This is the leg that makes the refusal meaningful rather than decorative: it shows the document *would* cause a
 * request, so refusing it is a decision about the product's behaviour and not a statement about a document that never
 * asked for anything.
 */
async function engineWouldFetch(service: string): Promise<number> {
  const html = await Bun.file(FIXTURE).text();
  await writeIntoContainer(service, '/tmp/isolation/remote.html', html);
  const converted = await inContainer(
    service,
    [
      'mkdir -p /tmp/isolation/out /tmp/isolation/profile',
      'rm -f /tmp/isolation/out/*.pdf',
      // One command per line, joined by `&&`: the engine invocation is long enough that splitting it across array
      // entries is how a harness ends up running `mkdir` with the next flag as its argument.
      'soffice --headless --norestore --nolockcheck --nologo --nodefault --nofirststartwizard --invisible -env:UserInstallation=file:///tmp/isolation/profile --convert-to pdf:writer_pdf_Export --outdir /tmp/isolation/out /tmp/isolation/remote.html',
      'ls /tmp/isolation/out',
    ].join(' && '),
  );
  if (!converted.output.includes('.pdf')) fail('the engine produced no PDF for the fixture', converted.output.trim());
  return await probeRequests(service);
}

interface Session {
  cookie: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

function newSession(): Session {
  const session: Session = {
    cookie: '',
    async call(path, init = {}) {
      const headers = new Headers(init.headers);
      if (session.cookie) headers.set('cookie', session.cookie);
      const response = await fetch(`${args.base}${path}`, { ...init, headers, redirect: 'manual' });
      for (const header of response.headers.getSetCookie?.() ?? []) {
        const pair = header.split(';')[0];
        if (pair?.startsWith('pdft_session=')) session.cookie = pair;
      }
      return response;
    },
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await session.call(path, init);
      const text = await response.text();
      if (!response.ok) fail(`${path} returned ${response.status}`, text.slice(0, 400));
      return JSON.parse(text) as T;
    },
  };
  return session;
}

async function upload(session: Session, path: string, name: string): Promise<string> {
  const body = new FormData();
  body.append('file', new Blob([await Bun.file(path).arrayBuffer()], { type: 'text/html' }), name);
  const response = await session.call('/api/v1/files', { method: 'POST', body });
  const text = await response.text();
  if (response.status !== 201) fail(`uploading ${name} returned ${response.status}`, text.slice(0, 400));
  return (JSON.parse(text) as { id: string }).id;
}

/**
 * Submit a fixture the ordinary way and read what the product said about it.
 *
 * One session per call, because that is what a caller does — and `html-to-pdf` is the tool whose options are all
 * defaults here, so the legs differ in the document rather than in the request.
 */
async function submitFixture(
  fixture = FIXTURE,
  name = 'html-to-pdf-remote-asset.html',
): Promise<{ status: string; code: string | null; message: string }> {
  const session = newSession();
  await session.json('/api/v1/me');
  const fileId = await upload(session, fixture, name);
  const created = await session.json<{ id: string }>('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'html-to-pdf', files: [fileId], options: { pageSize: 'a4' } }),
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await session.json<{
      status: string;
      error?: { code: string; message: string };
    }>(`/api/v1/jobs/${created.id}`);
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(job.status)) {
      return { status: job.status, code: job.error?.code ?? null, message: job.error?.message ?? '' };
    }
    await Bun.sleep(500);
  }
  fail('the job did not finish within 120s');
}

async function main(): Promise<void> {
  console.log(`isolation → ${args.base}, probe on 127.0.0.1:${args.probePort} inside ${args.service}\n`);

  // Every assertion here is about one caller's rows being invisible to another, and the callers are anonymous
  // sessions (`e2e/lib/stack-gap.ts`).
  await requireAnonymousUse(args.base, 'this stage isolates anonymous sessions from each other');

  // ── 1. No route out of the pools, with the API as the control ─────────────────────────────────────────────────
  const control = await reachesInternet(CONTROL_CONTAINER);
  if (!control.reached) {
    fail(
      `the control container (${CONTROL_CONTAINER}) could not reach the internet either, so this run cannot tell isolation from a stack with no egress at all`,
      control.detail,
    );
  }
  step('egress', `${CONTROL_CONTAINER} reaches http://example.com (${control.detail}) — the control this leg needs`);

  for (const pool of POOLS) {
    const reach = await reachesInternet(pool);
    if (reach.reached) {
      fail(
        `${pool} reached the internet (${reach.detail}). The pool that runs a stranger's document must not have a route out — see the networks block in docker-compose.yml`,
      );
    }
    step('egress', `${pool} cannot fetch http://example.com (${reach.detail})`);
  }

  // ── 2 & 3. The renderer would fetch; the handler refuses instead ──────────────────────────────────────────────
  await startProbe(args.service);

  if (args.skipEngine) {
    skip('engine', 'the engine leg was skipped (--skip-engine), so the refusal is asserted without its control');
  } else {
    const fetched = await engineWouldFetch(args.service);
    if (fetched < 2) {
      fail(
        `LibreOffice did not request the fixture's image (${fetched} request(s) seen, including the self-check). Either this engine no longer fetches remote references — in which case the refusal guards a vector that closed — or the probe stopped observing`,
      );
    }
    step(
      'engine',
      `the engine requests the document's remote image when handed it directly (${fetched} request(s) recorded)`,
    );
  }

  const before = await probeRequests(args.service);
  const outcome = await submitFixture();
  const after = await probeRequests(args.service);
  if (outcome.status !== 'FAILED' || outcome.code !== 'REMOTE_RESOURCES_BLOCKED') {
    fail(
      `the job ended as ${outcome.status}/${outcome.code ?? 'no code'}; the fixture names a URL, so the handler must refuse it with REMOTE_RESOURCES_BLOCKED`,
      outcome.message,
    );
  }
  if (after !== before) {
    fail(`the conversion fetched ${after - before} resource(s) even though the job was refused`, {
      before,
      after,
      message: outcome.message,
    });
  }
  step(
    'refusal',
    `the same document through the API is refused (${outcome.code}) and the listener records nothing (${after} request(s), unchanged)`,
  );

  // ── 4. The engine can run a macro, and the policy that governs document macros ───────────────────────────────
  //
  // Written after the first version of this leg got a *wrong* answer and said so loudly: it asked "does a profile
  // macro leave a marker?" of a profile LibreOffice had not initialised yet, got "no", and concluded there was no
  // macro runtime. A Basic library written before the engine's first start is discarded, and the marker appears the
  // moment the profile has been bootstrapped — so the premise was false and is now asserted from the other side.
  const marker = '/tmp/isolation/macro-ran';
  const levelFile = '/tmp/isolation/macro-level.txt';
  const libraryXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">',
    '<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">',
    ' <library:element library:name="Module1"/>',
    ' <library:element library:name="Report"/>',
    '</library:library>',
    '',
  ].join('\n');
  // Two modules, one Sub each: a module with a Basic error in it is not reported anywhere — the engine exits 0 and
  // the macro is simply "not found", which looks exactly like a security decision. A run was lost to that.
  const moduleXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">',
    '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">Sub Main',
    '  Dim n As Integer',
    '  n = Freefile',
    `  Open "${marker}" For Output As #n`,
    '  Print #n, "basic ran"',
    '  Close #n',
    'End Sub',
    '</script:module>',
    '',
  ].join('\n');
  // The engine's own answer to "what is the document-macro policy here", read through the configuration API rather
  // than from a file: the level is a value LibreOffice resolves, and reading the registry XML would measure our
  // understanding of its layout instead.
  const reportXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">',
    '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Report" script:language="StarBasic">Sub Main',
    '  Dim oProvider As Object, oConfig As Object, n As Integer',
    '  oProvider = createUnoService("com.sun.star.configuration.ConfigurationProvider")',
    '  Dim aArgs(0) As New com.sun.star.beans.PropertyValue',
    '  aArgs(0).Name = "nodepath"',
    '  aArgs(0).Value = "/org.openoffice.Office.Common/Security/Scripting"',
    '  oConfig = oProvider.createInstanceWithArguments("com.sun.star.configuration.ConfigurationAccess", aArgs())',
    '  n = Freefile',
    `  Open "${levelFile}" For Output As #n`,
    '  Print #n, oConfig.getPropertyValue("MacroSecurityLevel")',
    '  Close #n',
    'End Sub',
    '</script:module>',
    '',
  ].join('\n');
  await inContainer(args.service, `rm -f ${marker} ${levelFile}`);
  // The bootstrap has to come before the library: see the note above this leg.
  await inContainer(
    args.service,
    'timeout 180 soffice --headless --terminate_after_init --norestore --nolockcheck --nologo --nodefault --nofirststartwizard -env:UserInstallation=file:///tmp/isolation/profile >/dev/null 2>&1; echo initialised',
  );
  await writeIntoContainer(
    args.service,
    '/tmp/isolation/profile/user/basic/script.xlc',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">',
      '<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">',
      ' <library:library library:name="Standard" xlink:href="$(user)/basic/Standard/script.xlb/" xlink:type="simple" library:link="false"/>',
      '</library:libraries>',
      '',
    ].join('\n'),
  );
  await writeIntoContainer(args.service, '/tmp/isolation/profile/user/basic/Standard/script.xlb', libraryXml);
  await writeIntoContainer(args.service, '/tmp/isolation/profile/user/basic/Standard/Module1.xba', moduleXml);
  await writeIntoContainer(args.service, '/tmp/isolation/profile/user/basic/Standard/Report.xba', reportXml);
  const invoked = await inContainer(
    args.service,
    `timeout 120 soffice --headless --norestore --nolockcheck --nologo --nodefault --nofirststartwizard --invisible -env:UserInstallation=file:///tmp/isolation/profile "macro:///Standard.Module1.Main" >/dev/null 2>&1; ls -l ${marker} 2>&1`,
  );
  if (invoked.output.includes('No such file')) {
    fail(
      'the office image did not execute a Basic macro from a valid user profile. Nothing here rests on that being impossible, but the measurement below does: a level reported by a runtime that cannot run anything would be a number about a dead configuration',
      invoked.output.trim().slice(0, 400),
    );
  }
  step(
    'macros',
    `the office image executes Basic from a user profile (${marker} written) — so "macros cannot run" is not what this build relies on`,
  );

  const levelRun = await inContainer(
    args.service,
    `timeout 120 soffice --headless --norestore --nolockcheck --nologo --nodefault --nofirststartwizard --invisible -env:UserInstallation=file:///tmp/isolation/profile "macro:///Standard.Report.Main" >/dev/null 2>&1; cat ${levelFile} 2>/dev/null`,
  );
  const level = Number(levelRun.output.trim());
  if (!Number.isFinite(level) || level < 2) {
    fail(
      `the engine's document-macro policy is ${levelRun.output.trim() || 'unreadable'}, and this build expects High (2) or stricter: below it, an unsigned macro in a document is executable, which is the policy the refusal guard stands in front of — and the guard is one code path, while this is the engine's own floor`.trim(),
    );
  }
  step(
    'macros',
    `the engine's own document-macro policy is MacroSecurityLevel=${level} (High: unsigned document macros disabled)`,
  );

  // ── 5. A script in an HTML document does not run ─────────────────────────────────────────────────────────────
  //
  // The HTML path's version of the macro question, and the one a Chromium-backed converter would answer differently:
  // the fixture's script requests a loopback URL, so an executed runtime shows up as a request that arrives here. The
  // assertion is the *pair* — the job must complete (a page with a script tag is ordinary HTML, and refusing it would
  // be a bug of its own) and the listener must record nothing new.
  const beforeScript = await probeRequests(args.service);
  const scripted = await submitFixture(SCRIPT_FIXTURE, 'html-to-pdf-script.html');
  const afterScript = await probeRequests(args.service);
  if (scripted.status !== 'COMPLETED') {
    fail(
      `the script fixture ended as ${scripted.status}/${scripted.code ?? 'no code'}; a page carrying a <script> is ordinary HTML, so this document must convert`,
      scripted.message,
    );
  }
  if (afterScript !== beforeScript) {
    fail(
      `the conversion requested ${afterScript - beforeScript} resource(s) from the script it carries — a JavaScript runtime executed the document`,
      { before: beforeScript, after: afterScript },
    );
  }
  step(
    'scripts',
    `a document carrying a <script> converts (${scripted.status}) and its beacon never arrives (${afterScript} request(s), unchanged) — no JavaScript runtime ran it, and \`bun run test:browser\` shows the same script firing in a real browser, which is what makes this silence a fact about the engine rather than about the file`,
  );

  // ── 6. The guard refuses schemes, not URLs ──────────────────────────────────────────────────────────────────
  //
  // Leg 4 already proved this image executes `macro:///Standard.Module1.Main`. The fixture names exactly that URI where
  // an image would be, and the job must be refused before an engine sees it — which is why the guard treats *any*
  // scheme as external rather than `http`/`https` alone.
  const macroUri = await submitFixture(MACRO_URI_FIXTURE, 'html-to-pdf-macro-uri.html');
  if (macroUri.status !== 'FAILED' || macroUri.code !== 'REMOTE_RESOURCES_BLOCKED') {
    fail(
      `the macro-URI document ended as ${macroUri.status}/${macroUri.code ?? 'no code'}; a URI scheme this engine can execute must be refused with REMOTE_RESOURCES_BLOCKED`,
      macroUri.message,
    );
  }
  step(
    'schemes',
    `a document naming a runnable URI scheme (macro:///…) is refused (${macroUri.code}) rather than resolved — the guard rejects every scheme, and leg 4 is the reason it must`,
  );

  // ── 7. A document's own Basic library, and what the conversion does with it ───────────────────────────────
  //
  // Not "is there a macro runtime" — leg 4 settled that, and leg 6 shows the engine executes the very URI the guard
  // refuses. Narrower, and more useful: does the **conversion path** run code the document carries? The document is
  // converted twice, because one run cannot tell "the policy stopped it" from "the load path never ran it": under
  // the image's shipped policy (High), and under a scratch profile lowered to Low. What survives both is the floor.
  //
  // The control is the *input*, and it exists because the first shape of this leg answered a question it had not
  // earned: it asked "did nothing run?" of a fixture it had never shown to carry runnable code, and said no. The
  // fixture is read back out of the container now — library, module and both subs — so a package that lost its Basic
  // is a failure here rather than an argument for safety.
  if (args.skipEngine) {
    skip('document-macros', 'the document-macro leg was skipped (--skip-engine), so neither half was measured');
  } else {
    await writeBytesIntoContainer(
      args.service,
      '/tmp/isolation/document-macro.odt',
      await Bun.file(DOCUMENT_MACRO_FIXTURE).bytes(),
    );
    await writeIntoContainer(args.service, '/tmp/isolation/lower_policy.py', LOWER_POLICY_SCRIPT);
    await prepareProfile(args.service, DOCUMENT_MACRO_PROFILE, 'shipped');
    await prepareProfile(args.service, DOCUMENT_MACRO_LOOSE_PROFILE, 'low');

    const packaged = await inContainer(
      args.service,
      `python3 -c ${shellQuote(
        [
          'import zipfile',
          "z = zipfile.ZipFile('/tmp/isolation/document-macro.odt')",
          "basic = [n for n in z.namelist() if n.startswith('Basic/')]",
          "modules = [n for n in basic if n.endswith('.xml') and 'script-' not in n]",
          "code = z.read(modules[0]).decode() if modules else ''",
          "subs = [name for name in ('Fire', 'OnLoadHook') if ('Sub ' + name) in code]",
          "print('basic=' + str(len(basic)) + ' module=' + (modules[0] if modules else 'none') + ' subs=' + ','.join(subs))",
        ].join('\n'),
      )}`,
    );
    const carried = packaged.output.match(/basic=(\d+) module=(\S+) subs=(\S*)/);
    if (!carried || carried[2] === 'none' || carried[3] !== 'Fire,OnLoadHook') {
      fail(
        'the fixture does not carry the Basic library this leg is about, so "nothing ran" would be a statement about an empty document',
        packaged.output.trim().slice(0, 400),
      );
    }
    step(
      'document-macros',
      `the fixture really carries document Basic (${carried[1]} package entr(ies), module ${carried[2]}, subs ${carried[3]}) — the control this measurement needs`,
    );

    // The measurement, run twice for the reason above: the engine's own conversion command, unchanged, against the
    // same document, differing only in the policy its scratch profile carries.
    for (const policy of ['the shipped policy', 'a policy lowered to Low'] as const) {
      const profile = policy === 'the shipped policy' ? DOCUMENT_MACRO_PROFILE : DOCUMENT_MACRO_LOOSE_PROFILE;
      await inContainer(args.service, `rm -f ${DOCUMENT_MACRO_INVOKED} ${DOCUMENT_MACRO_ONLOAD}`);
      const converted = await convertWithEngine(args.service, profile, '/tmp/isolation/document-macro.odt');
      const ranInvoked = await markerPresent(args.service, DOCUMENT_MACRO_INVOKED);
      const ranOnLoad = await markerPresent(args.service, DOCUMENT_MACRO_ONLOAD);
      if (ranInvoked || ranOnLoad) {
        fail(
          `the conversion executed the document's own Basic under ${policy} (sub=${ranInvoked}, load listener=${ranOnLoad}): the conversion path runs document code`,
          converted,
        );
      }
      step(
        'document-macros',
        `\`--convert-to pdf\` on that document under ${policy}: neither the sub nor the \`dom:load\` listener it names ran, and it still converted (${converted.split('\n').pop()})`,
      );
    }

    // And the half this stage cannot decide, said out loud instead of implied by a pass: nothing here shows the
    // engine would execute a *document's* code, only that its conversion does not. The CLI's only invocation route
    // (`macro:///`, leg 4) addresses the profile library, and `location=document` has no command-line form.
    skip(
      'document-macros',
      'not measured, and not implied either: whether this engine would run a document\u2019s Basic if it were asked to — ' +
        'the one invocation route a CLI exposes addresses the profile library (leg 4), so the claim here is "the ' +
        'conversion path runs none of it", not "document Basic cannot run"',
    );
  }

  // ── 8. The boundary is the network, and every compose file here keeps it ──────────────────────────────────
  //
  // Leg 1 measures the stack that is running; this leg measures the *policy*, in the two places it can quietly stop
  // being true: a compose file that does not say it, and a container started without one. The first half resolves
  // each file the way Docker resolves it, because the file a human reads is not the topology a container gets — the
  // production file had no `networks:` key anywhere while its pools ran with a route to the internet, and only
  // `compose config` shows that: it merges anchors, applies overrides, and fills in the network a service never names.
  for (const target of COMPOSE_TARGETS) {
    const resolved = await composeTopology(target);
    const networks = resolved.networks ?? {};
    const internal = new Set(
      Object.entries(networks)
        .filter(([, network]) => network.internal === true)
        .map(([name]) => name),
    );
    const pools = Object.keys(resolved.services).filter((service) => service.startsWith('worker-'));
    if (pools.length !== target.pools) {
      fail(
        `the ${target.name} topology defines ${pools.length} pool(s) (${pools.join(', ') || 'none'}), not the ${target.pools} this stage expects`,
      );
    }
    if (internal.size === 0) {
      fail(
        `the ${target.name} topology declares no internal network, so its pools have a route out by definition`,
        Object.keys(networks).join(', '),
      );
    }
    const exposed = pools.filter((pool) => {
      const attached = Object.keys(resolved.services[pool]?.networks ?? {});
      return attached.length === 0 || attached.some((name) => !internal.has(name));
    });
    if (exposed.length > 0) {
      fail(
        `the ${target.name} topology puts ${exposed.join(', ')} on a network with a route out — an engine that can reach the network can be used as a request proxy`,
        JSON.stringify(networks, null, 2),
      );
    }
    step(
      'topology',
      `the ${target.name} topology resolves with ${pools.length} pool(s) on internal-only networks (${[...internal].join(', ')})`,
    );
  }

  // The second half, and what makes the first a measurement rather than a preference: the isolation is the *network
  // attachment*, not the image. Same image, same probe, started by hand — the way a deployment that does not use
  // these compose files, or a developer running one container, would start it.
  const poolContainer = (await onHost(['docker', 'compose', 'ps', '-q', args.service])).output.trim().split('\n')[0];
  if (!poolContainer) fail(`no running container for ${args.service}, so the boundary cannot be measured`);
  const image = (await onHost(['docker', 'inspect', '-f', '{{.Config.Image}}', poolContainer])).output.trim();
  const attached = (
    await onHost([
      'docker',
      'inspect',
      '-f',
      '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{end}}',
      poolContainer,
    ])
  ).output
    .split(/\s+/)
    .filter(Boolean);
  const isolatedNetwork = attached.find((name) => name.endsWith('_isolated'));
  if (!isolatedNetwork)
    fail(`${args.service} is not attached to an isolated network (${attached.join(', ') || 'none'})`);
  const handStarted = async (network?: string): Promise<string | undefined> => {
    const run = await onHost([
      'docker',
      'run',
      '--rm',
      ...(network ? ['--network', network] : []),
      '--entrypoint',
      'python3',
      image,
      '-c',
      PYTHON_EGRESS_PROBE,
    ]);
    return classifyEgress(run.output);
  };
  const outside = await handStarted();
  const inside = await handStarted(isolatedNetwork);
  if (!outside?.startsWith('REACHED')) {
    fail(
      `the same image started outside compose did not reach http://example.com (${outside ?? 'no answer'}), so this leg cannot separate the network from the host: ${CONTROL_CONTAINER} reaching it is what gives the differential its meaning`,
    );
  }
  if (!inside?.startsWith('BLOCKED')) {
    fail(`${image} attached to ${isolatedNetwork} answered ${inside ?? 'nothing'} — that network is not isolating`);
  }
  step(
    'boundary',
    `the same image (${image}) with the same probe: on ${isolatedNetwork} it is ${inside}, started by hand on Docker's default bridge it says ${outside} — the isolation is the network, not the image`,
  );

  await stopProbe(args.service);

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base: args.base,
        service: args.service,
        probePort: args.probePort,
        results,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nisolation passed — ${steps.length} check(s) against ${args.base}`);
  console.log(`Measurements: ${args.jsonPath}`);
}

await main();
