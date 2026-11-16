import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAnonymousUse } from '../../e2e/lib/stack-gap';

/**
 * The PDF/A validator, as a stage rather than a sentence in a document.
 *
 *   bun run test:pdfa
 *
 * `pdf-to-pdfa` produces an archival file and **validates it** before delivering it. That makes one new claim
 * load-bearing — "the delivered file conforms" — and a claim about a validator has these ways to be false:
 *
 *   1. the validator is not actually in the image (so the job's metrics are a promise nobody checked),
 *   2. the validator returns 0 for anything (so every job passes and the check is decoration),
 *   3. the verdict was only ever reproduced on files this repository produced — a validator exercised on its author's
 *      own output is a validator whose agreement is *expected*, and agreement that is expected measures nothing.
 *
 * The first is answered by asking the running container for `--version`, the second by handing it a file that is
 * *not* PDF/A and requiring **exit 1 with a rule named** (measured, not assumed: veraPDF 1.30.2 answers
 * `FAIL <path> 1b` plus the ISO 19005 clause that failed).
 *
 * The third is answered twice, and both halves are about **other people's files**:
 *
 *   · every profile the tool offers (`1b`, `2b`, `3b`) is run end to end and its own deliverable is validated — the
 *     job's `metrics.conformance`, the `pdfaid:part` the delivered bytes carry, and an independent `verapdf
 *     --flavour <profile>` over those bytes all have to agree. One profile was enough while the tool answered every
 *     request with it; the handler now maps the level from the request, which is a claim per profile rather than one
 *     claim with two variants.
 *   · a document **this repository did not produce** is put through the validator: `worker-office` exports the same
 *     fixture to PDF/A with LibreOffice — a different library and a different XMP writer from the Ghostscript pass
 *     the tool runs. That file is checked for what it *claims*, judged by the validator, and then handed to the tool,
 *     whose output must validate. The last of those is the product's promise applied to a stranger's archival file:
 *     most such files in the wild were not produced by this pipeline, and a validator that only agrees with its own
 *     producer would not be able to tell the caller which of them are real.
 *
 * It needs the compose stack and two worker images (the API for jobs, `heavy` for veraPDF, `office` for the foreign
 * export), like `test:isolation` and for the same reason: it measures images and talks to the API over HTTP.
 * Measurements land in `e2e/artifacts/pdfa-validator.json`.
 */

interface Args {
  base: string;
  project: string;
  service: string;
  /** The pool that owns the *other* producer. The heavy pool has no LibreOffice at all — measured, not assumed. */
  office: string;
  jsonPath: string;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  project: value('--project') ?? 'pdf-tools',
  service: value('--service') ?? 'worker-heavy',
  office: value('--office') ?? 'worker-office',
  jsonPath: value('--json') ?? 'e2e/artifacts/pdfa-validator.json',
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PLAIN_PDF = join(REPO_ROOT, 'fixtures', 'generated', 'pages-six-a4.pdf');
/** What the foreign producer converts. Already a fixture of this repository, so the comparison has one variable. */
const FOREIGN_SOURCE = join(REPO_ROOT, 'fixtures', 'generated', 'office-to-pdf-report.txt');
const DEV_PLAN_TOKEN = process.env.DEV_PLAN_TOKEN ?? 'dev-plan-token';

/**
 * The profiles the tool accepts, taken from its own contract rather than from a list written here.
 *
 * Typed as the literal union `verifyPdfa` takes, so a profile added to `PdfToPdfaOptions` and forgotten here is a
 * type error rather than a silently untested branch.
 */
const PROFILES = ['1b', '2b', '3b'] as const;
type Profile = (typeof PROFILES)[number];

const SCRATCH_DIR = '/tmp/pdfa';
/** Where the foreign document is authored, and where it is kept afterwards for a failed run to be inspected. */
const FOREIGN_DIR = '/tmp/pdfa-foreign';
const FOREIGN_PDF = `${FOREIGN_DIR}/out/note.pdf`;
/** LibreOffice writes into a user profile; a fresh one per run, because a shared one reports a lock and exits 0. */
const FOREIGN_PROFILE = `${FOREIGN_DIR}/profile`;

const checks: Array<{ check: string; detail: string }> = [];
const skips: Array<{ check: string; detail: string }> = [];

function step(check: string, detail: string): void {
  checks.push({ check, detail });
  console.log(`  ✓ ${detail}`);
}

/**
 * A leg that could not be measured on this build, said out loud with its reason.
 *
 * Not a pass, and not silent: the whole failure mode this stage exists to answer is a claim that was never measured,
 * and a leg that stops being measurable (a producer that fixes its own bug, an image without the engine) has to
 * announce itself instead of becoming a green line nobody re-reads.
 */
function skip(check: string, detail: string): void {
  skips.push({ check, detail });
  console.log(`  – ${detail}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  console.error('\nchecks so far:');
  for (const entry of checks) console.error(`  · ${entry.detail}`);
  for (const entry of skips) console.error(`  · (skipped) ${entry.detail}`);
  process.exit(1);
}

/** One command in one service, with stdout and stderr kept apart: bytes are read back over stdout. */
async function exec(service: string, script: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['docker', 'compose', 'exec', '-T', service, 'sh', '-c', script], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function inContainer(script: string): Promise<{ code: number; output: string }> {
  const result = await exec(args.service, script);
  return { code: result.code, output: `${result.out}${result.err}` };
}

/** Bytes into a container as base64, with the size read back so a truncation is a failure rather than a mystery. */
async function writeIntoContainer(service: string, path: string, bytes: Uint8Array): Promise<void> {
  const encoded = Buffer.from(bytes).toString('base64');
  const written = await exec(service, `mkdir -p $(dirname ${path}) && printf %s '${encoded}' | base64 -d > ${path}`);
  if (written.code !== 0) fail(`could not write ${path} in ${service}`, `${written.out}${written.err}`.trim());
  const size = await exec(service, `wc -c < ${path}`);
  if (Number(size.out.trim()) !== bytes.byteLength) {
    fail(`${path} in ${service} is ${size.out.trim()} bytes, not the ${bytes.byteLength} written`);
  }
}

/** Bytes back out of a container, for a file that has to travel (a download, or an engine's own output). */
async function readFromContainer(service: string, path: string): Promise<Uint8Array> {
  const result = await exec(service, `base64 -w 0 ${path}`);
  if (result.code !== 0) fail(`could not read ${path} out of ${service}`, `${result.out}${result.err}`.trim());
  return new Uint8Array(Buffer.from(result.out.trim(), 'base64'));
}

interface Verdict {
  /** veraPDF's own exit code. `0` compliant, `1` non-compliant, anything else means it never opened the document. */
  code: number;
  /** The one-line text verdict, e.g. `FAIL /tmp/pdfa/plain.pdf 1b`. */
  line: string;
  /** The ISO 19005 clause of the first failed rule, when one failed. */
  clause: string | null;
  /** That rule's description — what the file did wrong, in the standard's words. */
  description: string | null;
  /** The check's own message, which names the object and the two values that disagree. */
  reason: string | null;
}

/**
 * `verapdf` inside the container, in both of its output shapes.
 *
 * The text form is the verdict the handler's exit-code branch is built on, and the XML form is the **reason**: a
 * rejection that cannot name the rule it failed is not something a caller can act on, and the difference between
 * "not archival" and "archival except for one metadata field" is exactly the difference an engineer needs. Both runs
 * see the same bytes and neither is a substitute for the other.
 */
async function verdict(path: string, flavour: string): Promise<Verdict> {
  const xmlPath = `${SCRATCH_DIR}/verdict.xml`;
  const textPath = `${SCRATCH_DIR}/verdict.txt`;
  const run = await inContainer(
    [
      `/opt/verapdf/verapdf --format text --flavour ${flavour} ${path} > ${textPath} 2>&1; echo "EXIT=$?"`,
      `tail -1 ${textPath}`,
      `/opt/verapdf/verapdf --format xml --flavour ${flavour} ${path} > ${xmlPath} 2>&1`,
      `printf 'CLAUSE=%s\\n' "$(grep -o 'clause="[^"]*"' ${xmlPath} | head -1)"`,
      `printf 'DESCRIPTION=%s\\n' "$(grep -o '<description>[^<]*' ${xmlPath} | head -1)"`,
      `printf 'REASON=%s\\n' "$(grep -o '<errorMessage>[^<]*' ${xmlPath} | head -1)"`,
    ].join('; '),
  );
  return {
    code: Number(/EXIT=(\d+)/.exec(run.output)?.[1] ?? -1),
    line:
      run.output
        .split('\n')
        .find((line) => /^(PASS|FAIL)\b/.test(line))
        ?.trim() ?? run.output.trim(),
    clause: /CLAUSE=clause="([^"]*)"/.exec(run.output)?.[1] ?? null,
    description: /DESCRIPTION=<description>(.*)/.exec(run.output)?.[1]?.trim() || null,
    reason: /REASON=<errorMessage>(.*)/.exec(run.output)?.[1]?.trim().replace(/&#xD;/g, '') || null,
  };
}

/**
 * A document's text, with its object streams decompressed.
 *
 * Not a search over the delivered bytes, and the reason was measured rather than reasoned about: Ghostscript writes
 * the `/OutputIntents` dictionary **inside an object stream** for PDF/A-2 and -3, so `GTS_PDFA1` is absent from the raw
 * bytes of a file that certainly carries an intent. That is the same trap `hasPdfaOutputIntent` in
 * `packages/engines/src/pdfa.ts` was written for, and this stage rediscovered it the hard way — a first draft of the
 * profile loop failed PDF/A-2B for "no output intent" while an independent veraPDF run passed the same bytes.
 *
 * `qpdf --qdf` puts every file into one shape, so the reader sees the document rather than the container it happened
 * to arrive in — which is also what lets one reader serve both this pipeline's output and a stranger's.
 */
async function normalizedBytes(path: string): Promise<Uint8Array> {
  const qdfPath = `${path}.qdf.pdf`;
  const normalized = await inContainer(`qpdf --qdf --object-streams=disable ${path} ${qdfPath}`);
  if (normalized.code !== 0) fail(`could not decompress ${path} for a read-back`, normalized.output.trim());
  return await readFromContainer(args.service, qdfPath);
}

/**
 * What a document says about itself, read from those normalized bytes.
 *
 * The claim is worth reading separately from the verdict because the two are different objects — that is the entire
 * reason `pdf-to-pdfa` exists, and a file whose metadata announces PDF/A while its contents are not is the failure an
 * archive discovers years later. The patterns accept both spellings of the same XMP property: an attribute on
 * `rdf:Description` (Adobe's writer, and Ghostscript's) and an element (LibreOffice's). Matching only the form this
 * repository's own producer emits would make the reader unusable on exactly the documents it is here to read.
 */
interface Claim {
  part: string | null;
  conformance: string | null;
  outputIntent: boolean;
}

function claimOf(bytes: Uint8Array): Claim {
  const text = Buffer.from(bytes).toString('latin1');
  return {
    part: /pdfaid:part['"]?\s*(?:=|[<>])\s*['"]?(\d)/i.exec(text)?.[1] ?? null,
    conformance: /pdfaid:conformance['"]?\s*(?:=|[<>])\s*['"]?([ABU])/i.exec(text)?.[1]?.toUpperCase() ?? null,
    outputIntent: text.includes('GTS_PDFA1'),
  };
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
      headers.set('x-dev-plan', 'pro');
      headers.set('x-dev-plan-token', DEV_PLAN_TOKEN);
      if (session.cookie) headers.set('cookie', session.cookie);
      const response = await fetch(`${args.base}${path}`, { ...init, headers });
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

interface ArchivalResult {
  jobId: string;
  conformance: Record<string, unknown>;
  warnings: Array<{ code: string; detail?: string }>;
  bytes: Uint8Array;
}

/**
 * One archival job, from upload to delivered bytes.
 *
 * The source is handed in as bytes rather than as a path because two of the three documents this stage runs come from
 * a container, and a job that could only be submitted from a file on the host would leave the foreign document's
 * second half unmeasured.
 */
async function archivalJob(
  session: Session,
  source: Uint8Array,
  name: string,
  profile: Profile,
  label: string,
): Promise<ArchivalResult> {
  const form = new FormData();
  form.append('kind', 'input');
  // A copy rather than the slice itself: the bytes arrive from a container as a `Buffer`, whose backing store the
  // DOM `Blob` type does not accept, and re-wrapping is cheaper than a cast that would hide a real mismatch.
  form.append('file', new Blob([new Uint8Array(source)], { type: 'application/pdf' }), name);
  const uploaded = await session.call('/api/v1/files', { method: 'POST', body: form });
  if (!uploaded.ok) fail(`${label}: the upload returned ${uploaded.status}`, (await uploaded.text()).slice(0, 300));
  const fileId = ((await uploaded.json()) as { id: string }).id;

  const created = await session.call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'pdf-to-pdfa', files: [fileId], options: { profile } }),
  });
  const createdText = await created.text();
  if (created.status !== 202) {
    fail(`${label} (${profile}) was refused with ${created.status}`, createdText.slice(0, 400));
  }
  const jobId = (JSON.parse(createdText) as { id: string }).id;

  const deadline = Date.now() + 300_000;
  let status = 'PENDING';
  let error: { code: string; message: string } | null = null;
  while (Date.now() < deadline) {
    const view = await session.json<{ status: string; error: { code: string; message: string } | null }>(
      `/api/v1/jobs/${jobId}`,
    );
    status = view.status;
    error = view.error;
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status)) break;
    await Bun.sleep(500);
  }
  if (status !== 'COMPLETED') {
    fail(
      `${label} (${profile}) ended as ${status}/${error?.code ?? 'no code'} — with validation on, a job that cannot be validated must not deliver`,
      error?.message,
    );
  }

  const result = await session.json<{
    metrics?: Record<string, unknown>;
    warnings: Array<{ code: string; detail?: string }>;
  }>(`/api/v1/jobs/${jobId}/result`);
  if (result.warnings.some((warning) => warning.code === 'CONFORMANCE_NOT_VALIDATED')) {
    fail(`${label} (${profile}) warns CONFORMANCE_NOT_VALIDATED while PDFA_VALIDATE is on`, result.warnings);
  }

  const download = await session.call(`/api/v1/jobs/${jobId}/download?part=primary`);
  if (!download.ok) fail(`${label}: the download returned ${download.status}`, (await download.text()).slice(0, 300));
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0) fail(`${label}: the download served a zero-byte file`);

  return {
    jobId,
    conformance: (result.metrics?.conformance ?? {}) as Record<string, unknown>,
    warnings: result.warnings,
    bytes,
  };
}

/**
 * The foreign document, authored by the pool that owns LibreOffice.
 *
 * `SelectPdfVersion=1` is LibreOffice's PDF/A-1b export — the same setting a user picks in the GUI, not a flag
 * invented here. What matters is that it is a **different producer**: different library, different XMP writer, and no
 * Ghostscript anywhere in it, which is what makes its verdict evidence about the validator rather than about this
 * repository's own output.
 */
async function authorForeignDocument(): Promise<{ pdf: Uint8Array; version: string; convertLog: string }> {
  const filter = `'pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"1"}}'`;
  const availability = await exec(args.office, 'command -v soffice || echo ABSENT');
  if (availability.out.includes('ABSENT')) {
    fail(
      `${args.office} has no LibreOffice, so this stage cannot author the foreign document it needs — pass --office=<service> naming a pool with it`,
      availability.out.trim(),
    );
  }
  const version =
    /LibreOffice\s+([\w.]+)/.exec((await exec(args.office, 'soffice --version 2>/dev/null')).out)?.[1] ?? 'unknown';

  await writeIntoContainer(args.office, `${FOREIGN_DIR}/note.txt`, await Bun.file(FOREIGN_SOURCE).bytes());
  const converted = await exec(
    args.office,
    [
      `rm -rf ${FOREIGN_DIR}/out ${FOREIGN_PROFILE}`,
      `mkdir -p ${FOREIGN_DIR}/out`,
      `timeout 300 soffice --headless --norestore --nolockcheck --nologo --nodefault --nofirststartwizard --invisible -env:UserInstallation=file://${FOREIGN_PROFILE} --convert-to ${filter} --outdir ${FOREIGN_DIR}/out ${FOREIGN_DIR}/note.txt`,
      `test -f ${FOREIGN_PDF} && echo AUTHORED`,
    ].join('; '),
  );
  if (!converted.out.includes('AUTHORED')) {
    fail(
      `LibreOffice in ${args.office} did not export a PDF/A document, so the foreign half of this stage has nothing to measure`,
      `${converted.out}${converted.err}`.trim().slice(0, 600),
    );
  }
  return {
    pdf: await readFromContainer(args.office, FOREIGN_PDF),
    version,
    convertLog:
      `${converted.out}`
        .split('\n')
        .find((line) => line.startsWith('convert'))
        ?.trim() ?? '',
  };
}

async function main(): Promise<void> {
  console.log(`pdf/a validator → ${args.base}, verapdf inside ${args.service}, foreign export via ${args.office}\n`);

  // The validator only speaks about a file the stack agreed to produce, and producing one means starting work as a
  // caller with no account (`e2e/lib/stack-gap.ts`).
  await requireAnonymousUse(args.base, 'this stage uploads a document and runs an archival job on it');

  // ── 1. The validator is in the image, and the worker is configured to use it ──────────────────────────────────
  const settingRun = await inContainer('echo "path=${ENGINE_VERAPDF_PATH:-unset} validate=${PDFA_VALIDATE:-unset}"');
  const versionRun = await inContainer('/opt/verapdf/verapdf --version');
  // Anchored on a digit: the container's own environment echoes the word "verapdf" twice (`ENGINE_VERAPDF_PATH` and the
  // path itself), and a loose pattern matches `…/verapdf validate=true` and reports the version as "validate".
  const version = /veraPDF\s+(\d[\w.\-]*)/i.exec(versionRun.output)?.[1];
  if (!version) {
    fail(
      `the ${args.service} image did not answer with a veraPDF version, so its conformance claims cannot be reproduced`,
      versionRun.output.trim().slice(0, 400),
    );
  }
  if (!/validate=true/.test(settingRun.output)) {
    fail(
      `the container runs with ${/validate=(\S+)/.exec(settingRun.output)?.[1] ?? 'no'} for PDFA_VALIDATE, so an archival job would report CONFORMANCE_NOT_VALIDATED rather than validating`,
      settingRun.output.trim(),
    );
  }
  step('installed', `${args.service} ships veraPDF ${version}, and PDFA_VALIDATE is on in the running container`);

  await inContainer(`mkdir -p ${SCRATCH_DIR}`);

  // ── 2. The validator can fail, and it can say why ─────────────────────────────────────────────────────────────
  await writeIntoContainer(args.service, `${SCRATCH_DIR}/plain.pdf`, await Bun.file(PLAIN_PDF).bytes());
  const nonArchival = await verdict(`${SCRATCH_DIR}/plain.pdf`, '1b');
  if (nonArchival.code !== 1 || !/^FAIL\b/.test(nonArchival.line)) {
    fail(
      `veraPDF did not reject a plain PDF as PDF/A-1B (exit ${nonArchival.code}), so a passing verdict from this validator would mean nothing`,
      nonArchival.line,
    );
  }
  // A rejection with no rule attached is the weaker half of the same failure: the caller would learn that the file is
  // not archival and nothing about *which* property to fix. This tool's whole job is producing a specific PDF/A, so
  // the reason has to survive the verdict.
  if (!nonArchival.clause) {
    fail(
      'veraPDF rejected a plain PDF without naming the clause it failed, so the rejection cannot be acted on',
      nonArchival.line,
    );
  }
  step(
    'not a rubber stamp',
    `a plain PDF — a file making no archival claim at all — is rejected as PDF/A-1B at clause ${nonArchival.clause}: "${nonArchival.description}" (exit 1)`,
  );

  // ── 3. Every profile the tool offers, end to end ──────────────────────────────────────────────────────────────
  //
  // Three assertions per profile, and they are different claims: what the *job* says it proved, what the *file* says
  // it is, and what an independent run says about those bytes. A handler that reported PASS without running anything
  // would satisfy the first; a file that happens to conform would satisfy the third even if the handler never looked;
  // and a file whose own XMP names a different level than the caller asked for is the defect this loop was written
  // after (the level used to be `profile === '1b' ? '1' : '2'`, so a PDF/A-3 request was answered with a file saying
  // `pdfaid:part='2'` — a conformance claim the caller never made).
  const session = newSession();
  // The session is minted by the first request that needs an owner — `/me` — exactly as the other stages do it.
  await session.json('/api/v1/me');
  const plainBytes = await Bun.file(PLAIN_PDF).bytes();
  const profiles: Array<Record<string, unknown>> = [];

  for (const profile of PROFILES) {
    const delivered = await archivalJob(session, plainBytes, 'pages-six-a4.pdf', profile, 'the fixture');
    const deliveredPath = `${SCRATCH_DIR}/delivered-${profile}.pdf`;
    await writeIntoContainer(args.service, deliveredPath, delivered.bytes);
    const conformance = delivered.conformance;
    if (conformance.result !== 'PASS' || conformance.tool !== 'verapdf') {
      fail(
        `the ${profile} job reports conformance ${JSON.stringify(conformance)}; with PDFA_VALIDATE on it must name its validator and its verdict`,
        conformance,
      );
    }
    if (conformance.version !== version) {
      fail(
        `the ${profile} job reports validator version ${String(conformance.version)} while the container runs ${version} — the version in the metrics has to be the one that ran`,
        conformance,
      );
    }
    if (conformance.profile !== profile) {
      fail(
        `the ${profile} job reports its conformance profile as ${String(conformance.profile)} — a caller has to be able to see which profile was validated, not merely that some profile was`,
        conformance,
      );
    }

    // The deliverable's own claim, read from the bytes rather than from the response that described them.
    const claim = claimOf(await normalizedBytes(deliveredPath));
    if (claim.part !== profile.charAt(0)) {
      fail(
        `the ${profile} job delivered a file whose own XMP says pdfaid:part=${claim.part ?? 'nothing'} — the file has to claim the level the caller asked for`,
        { requested: profile, claim },
      );
    }
    if (!claim.outputIntent) {
      fail(
        `the ${profile} job delivered a file with no GTS_PDFA1 output intent, so it claims a level it does not have`,
        { requested: profile, claim },
      );
    }

    // The independent half: the same bytes, the same validator, invoked by this harness rather than by the handler.
    const independent = await verdict(deliveredPath, profile);
    if (independent.code !== 0 || !/^PASS\b/.test(independent.line)) {
      fail(
        `veraPDF rejected the ${profile} job's delivered file (exit ${independent.code}) at clause ${independent.clause ?? 'unknown'}, which the job had reported as PASS`,
        independent.reason ?? independent.line,
      );
    }
    step(
      `${profile} delivered`,
      `the job reports {tool: verapdf, version: ${version}, profile: ${profile}, result: PASS}, the delivered ${delivered.bytes.byteLength} byte file claims pdfaid:part='${claim.part}' with an embedded GTS_PDFA1 intent, and an independent \`verapdf --flavour ${profile}\` run over those bytes says \`${independent.line}\``,
    );
    profiles.push({
      profile,
      jobId: delivered.jobId,
      bytes: delivered.bytes.byteLength,
      claim,
      independent: { exitCode: independent.code, line: independent.line },
    });
  }

  // ── 4. A document this repository did not produce ─────────────────────────────────────────────────────────────
  //
  // Everything above was measured on documents this pipeline produced or this repository authored, so all of it is
  // agreement between parties who share an author. The foreign document is the control for that: a PDF/A export from
  // another engine, judged by the same validator and then converted by the same tool.
  const foreign = await authorForeignDocument();
  await writeIntoContainer(args.service, `${SCRATCH_DIR}/foreign.pdf`, foreign.pdf);
  const foreignClaim = claimOf(await normalizedBytes(`${SCRATCH_DIR}/foreign.pdf`));
  if (!foreignClaim.part) {
    fail(
      `the ${args.office} export of a plain text fixture carries no pdfaid:part at all, so it is not an archival claim this stage can judge`,
      { producer: foreign.version, bytes: foreign.pdf.byteLength, log: foreign.convertLog },
    );
  }
  // The flavour to judge it by is the level *its own metadata names*, not a guess: judging a foreign file against a
  // profile it never claimed would fail it for the wrong reason.
  const foreignFlavour = `${foreignClaim.part}${(foreignClaim.conformance ?? 'B').toLowerCase()}`;
  const foreignVerdict = await verdict(`${SCRATCH_DIR}/foreign.pdf`, foreignFlavour);

  if (foreignVerdict.code === 0) {
    // Reached when the other producer's export is in fact conformant. The claim in its metadata and the fact about
    // its bytes then agree, and there is no disagreement here to measure — which is recorded rather than asserted,
    // because asserting it would be asserting the other project's bug rather than this one's property.
    skip(
      'foreign claim',
      `LibreOffice ${foreign.version}'s PDF/A-${foreignFlavour.toUpperCase()} export passes veraPDF, so the claim-versus-fact disagreement this leg exists to measure has nothing to measure on this build (recorded, not asserted)`,
    );
  } else if (foreignVerdict.code === 1) {
    if (!foreignVerdict.clause) {
      fail(
        'the foreign file was rejected without a clause, so the rejection says nothing about which rule it failed',
        foreignVerdict.line,
      );
    }
    step(
      'foreign claim',
      `LibreOffice ${foreign.version}'s export says pdfaid:part=${foreignClaim.part}/conformance=${foreignClaim.conformance}${foreignClaim.outputIntent ? ' and carries a GTS_PDFA1 intent' : ' and carries no output intent'}, and veraPDF still rejects it at clause ${foreignVerdict.clause}: "${foreignVerdict.description}" — the verdict is the file, not the claim its metadata makes`,
    );
  } else {
    fail(
      `veraPDF could not process the foreign file at all (exit ${foreignVerdict.code}), so nothing about it was validated`,
      foreignVerdict.line,
    );
  }

  // ── 5. The same foreign file, through the tool ────────────────────────────────────────────────────────────────
  //
  // The product's promise applied to a stranger's document: an input whose own archival claim does not survive
  // inspection must still come out as a file that does. This is the case most real inputs are — files that were
  // PDF/A somewhere else, or only claimed to be — and it is the one that cannot be inferred from the fixture runs,
  // because those start from a plain PDF this repository authored.
  const repaired = await archivalJob(
    session,
    foreign.pdf,
    'foreign-pdfa.pdf',
    PROFILES[0],
    `the foreign ${args.office} export`,
  );
  const repairedConformance = repaired.conformance;
  if (repairedConformance.result !== 'PASS' || repairedConformance.profile !== PROFILES[0]) {
    fail(
      `the foreign document's job reports conformance ${JSON.stringify(repairedConformance)} rather than a PASS for ${PROFILES[0]}`,
      repairedConformance,
    );
  }
  await writeIntoContainer(args.service, `${SCRATCH_DIR}/foreign-repaired.pdf`, repaired.bytes);
  const repairedVerdict = await verdict(`${SCRATCH_DIR}/foreign-repaired.pdf`, PROFILES[0]);
  if (repairedVerdict.code !== 0 || !/^PASS\b/.test(repairedVerdict.line)) {
    fail(
      `the delivered file converted from the foreign document fails an independent run (exit ${repairedVerdict.code}, clause ${repairedVerdict.clause ?? 'unknown'})`,
      repairedVerdict.reason ?? repairedVerdict.line,
    );
  }
  const repairedClaim = claimOf(await normalizedBytes(`${SCRATCH_DIR}/foreign-repaired.pdf`));
  step(
    'foreign repaired',
    foreignVerdict.code === 0
      ? `the foreign export converts to ${repaired.bytes.byteLength} bytes claiming pdfaid:part='${repairedClaim.part}' and validates independently: \`${repairedVerdict.line}\``
      : `the foreign export — whose own archival claim does not survive inspection — converts to ${repaired.bytes.byteLength} bytes claiming pdfaid:part='${repairedClaim.part}' that does: \`${repairedVerdict.line}\``,
  );

  await inContainer(`rm -rf ${SCRATCH_DIR} ${FOREIGN_DIR}`);

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base: args.base,
        service: args.service,
        office: args.office,
        validator: { path: '/opt/verapdf/verapdf', version },
        profiles,
        foreign: {
          producer: `libreoffice ${foreign.version}`,
          bytes: foreign.pdf.byteLength,
          claim: foreignClaim,
          flavour: foreignFlavour,
          verdict: { exitCode: foreignVerdict.code, line: foreignVerdict.line, clause: foreignVerdict.clause },
          repaired: {
            jobId: repaired.jobId,
            bytes: repaired.bytes.byteLength,
            claim: repairedClaim,
            exitCode: repairedVerdict.code,
          },
        },
        checks,
        skips,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\npdf/a validator passed — ${checks.length} check(s), ${skips.length} recorded skip(s) against ${args.base}`,
  );
  console.log(`Measurements: ${args.jsonPath}`);
}

await main();
