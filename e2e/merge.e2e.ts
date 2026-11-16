import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPdf, countPagesInPdf } from '../scripts/dev/pdf-writer';
// Page order is asserted on content, and qpdf compresses streams when it writes, so the labels are read out of the
// inflated streams rather than off the raw bytes — see `lib/pdf-inspect.ts` for why that distinction cost a
// debugging session.
import {
  decodedPdfText as decodedStreams,
  mediaBoxes,
  readAnnotationState,
  readFormFields,
  readOutlineAndInfo,
  readPdfHealth,
  repoRootFrom,
  searchableBytes,
} from './lib/pdf-inspect';

/**
 * Merge, end to end, against a running stack.
 *
 *   docker compose up -d postgres redis api worker-light
 *   bun run e2e:merge
 *   # or against any target:
 *   bun run e2e/merge.e2e.ts --base http://localhost:8080
 *
 * `docs/01-MERGE.md` §8 is this file's acceptance list, and each case below is one of its lines. What makes them
 * real tests rather than smoke checks:
 *
 *  1. the inputs are generated or read from the fixture directory, so the expected page count, outline and metadata
 *     are known by construction and not read back from anything the server said;
 *  2. every job is followed through QUEUED → PROCESSING → COMPLETED, which exercises the queue, the worker claim, the
 *     checksum verification, and the completion transition;
 *  3. the **downloaded bytes** are parsed and their page count, page order, page boxes, outline and metadata checked
 *     independently of the API's own report — a job that says "5 pages" while serving a truncated file, a document
 *     whose bookmarks were silently dropped, or a merge that normalised A3 down to A4 all pass a response-level
 *     assertion and fail here;
 *  4. the two refusals (a damaged file, an encrypted one) are asserted on the *sentence the user reads*, because a
 *     correct status code with a staging path in it is a leak, not a message.
 *
 * Exits non-zero with a readable reason on the first failed assertion.
 */

interface Args {
  base: string;
  timeoutSeconds: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const baseIndex = argv.indexOf('--base');
  const timeoutIndex = argv.indexOf('--timeout');
  return {
    base: (baseIndex >= 0 ? argv[baseIndex + 1] : undefined) ?? process.env.BASE_URL ?? 'http://localhost:8080',
    timeoutSeconds: Number(timeoutIndex >= 0 ? argv[timeoutIndex + 1] : undefined) || 90,
  };
}

/**
 * The fixture writer stamps every page with `"<label> — page N of M"`, so the label sequence of a merged document is a
 * page-level statement about order: not "file A came first" but "this is A's page 1, then A's page 2, then B's page 1".
 * Nothing shorter would catch a merge that swapped two pages *within* one input.
 */
function fixturePageLabels(bytes: Uint8Array | Buffer): string[] {
  return [...decodedStreams(bytes).matchAll(/\(([^()]+? \u2014 page \d+ of \d+)\)\s*Tj/g)].map((match) => match[1]!);
}

const args = parseArgs();
const api = args.base.replace(/\/$/, '');
// The container bridge in `readPdfHealth` and `readOutlineAndInfo` spawns `docker compose` from the repository root,
// so it is passed in rather than guessed from the harness's own directory — and it has to be the host's own spelling
// of that path: `fileURLToPath` via `repoRootFrom`, because `URL.pathname` is `/D:/…` on Windows and a cwd that does
// not exist kills every spawn with ENOENT (`repoRootFrom` documents the hang that produced this).
const REPO_ROOT = repoRootFrom(new URL('..', import.meta.url));

let cookie: string | null = null;
const steps: string[] = [];

function step(message: string): void {
  steps.push(message);
  console.log(`  ✓ ${message}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n  ✗ ${message}`);
  if (detail !== undefined)
    console.error(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
  console.error(`\ncompleted steps:\n${steps.map((s) => `  · ${s}`).join('\n')}`);
  process.exit(1);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${api}${path}`, { ...init, headers, redirect: 'manual' });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const value of setCookie) {
    const pair = value.split(';')[0];
    if (pair?.startsWith('pdft_session=')) cookie = pair;
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  const text = await response.text();
  if (!response.ok) {
    fail(`${init?.method ?? 'GET'} ${path} returned ${response.status}`, text.slice(0, 800));
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function upload(name: string, bytes: Uint8Array, type = 'application/pdf'): Promise<string> {
  const form = new FormData();
  form.append('kind', 'input');
  // A fresh `ArrayBuffer` copy rather than the view: `File` takes `BlobPart`, and a `Uint8Array` over a possibly
  // shared buffer is not one. Copying a few kilobytes of fixture costs nothing and keeps the cast out of the test.
  form.append('file', new File([bytes.slice().buffer as ArrayBuffer], name, { type }));

  const response = await call('/api/v1/files', { method: 'POST', body: form });
  const text = await response.text();
  if (response.status !== 201) {
    fail(`uploading ${name} returned ${response.status}`, text.slice(0, 800));
  }
  const body = JSON.parse(text) as { id: string; detectedType: string; pages: number | null };
  if (body.detectedType !== 'application/pdf' && type === 'application/pdf') {
    fail(`the API detected ${body.detectedType} for ${name}; the fixture is not being read as a PDF`);
  }
  return body.id;
}

/** A fixture from `fixtures/generated`, so the case is about bytes on disk rather than a rebuild of them. */
async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(REPO_ROOT, 'fixtures', 'generated', name)));
}

interface JobView {
  id: string;
  status: string;
  progress: number;
  phase: string;
  queue: string;
  output: { bytes: number; pages: number | null; parts: number; name: string } | null;
  error: { code: string; message: string } | null;
  warnings: Array<{ code: string; detail?: string }>;
  // The list/detail view carries warnings but not metrics; `/result` is where the handler's numbers are read from.
  metrics?: Record<string, unknown>;
  downloadUrl?: string;
}

interface ResultView {
  parts: Array<{ name: string; bytes: number }>;
  metrics: Record<string, unknown>;
  warnings: Array<{ code: string; detail?: string }>;
}

/**
 * Follow a job to a terminal state. Failures are returned rather than thrown when the case is *about* a failure — the
 * refusal cases assert on the sentence, so exiting here would hide the thing under test.
 */
async function waitForJob(jobId: string, expect: 'completed' | 'failure' = 'completed'): Promise<JobView> {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let last: JobView | null = null;
  let lastPhase = '';

  while (Date.now() < deadline) {
    const job = await json<JobView>(`/api/v1/jobs/${jobId}`);
    last = job;

    const label = `${job.status}/${job.phase} ${job.progress}%`;
    if (label !== lastPhase) {
      console.log(`    · ${label}`);
      lastPhase = label;
    }

    const terminal = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(job.status);
    if (expect === 'failure') {
      if (terminal) return job;
    } else if (job.status === 'COMPLETED') {
      return job;
    } else if (terminal) {
      fail(`the job ended as ${job.status}`, job.error ?? job);
    }
    await Bun.sleep(400);
  }

  fail(`the job did not reach ${expect} within ${args.timeoutSeconds}s`, last);
}

/**
 * Every entry in a job's own directory on the shared volume, read from the API container so the answer does not depend
 * on which pool claimed the job. `null` means the directory is not there at all, which is also a purged answer.
 */
async function jobDirEntries(jobId: string): Promise<string[] | null> {
  const proc = Bun.spawn(
    [
      'docker',
      'compose',
      'exec',
      '-T',
      'api',
      'sh',
      '-lc',
      `ls -a /var/lib/pdf-tools/jobs/${jobId} 2>/dev/null || echo __MISSING__`,
    ],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'ignore' },
  );
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '.' && line !== '..');
  if (lines.length === 1 && lines[0] === '__MISSING__') return null;
  return lines;
}

/** Submit a merge and wait for it. The order is always sent explicitly, exactly as the UI does. */
async function merge(
  files: string[],
  options: Record<string, unknown> = {},
  order?: string[],
): Promise<{
  created: { id: string; status: string; queue: string; eventsUrl: string; estimatedSeconds: number | null };
  job: JobView;
  result: ResultView;
  bytes: Buffer;
}> {
  const created = await json<{
    id: string;
    status: string;
    queue: string;
    eventsUrl: string;
    estimatedSeconds: number | null;
  }>('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files, options: { order: order ?? files, ...options } }),
  });
  if (created.status !== 'QUEUED') fail(`expected the job to start as QUEUED, got ${created.status}`);
  if (!created.eventsUrl) fail('the job response carries no eventsUrl, which the UI streams progress from');
  const job = await waitForJob(created.id);
  const result = await json<ResultView>(`/api/v1/jobs/${job.id}/result`);

  const download = await call(`/api/v1/jobs/${job.id}/download`);
  if (!download.ok) fail(`download returned ${download.status}`);
  if (download.headers.get('content-type') !== 'application/pdf') {
    fail(`download served ${download.headers.get('content-type')} instead of application/pdf`);
  }
  const disposition = download.headers.get('content-disposition') ?? '';
  if (!disposition.includes('attachment')) fail('the download is missing an attachment disposition', disposition);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.length === 0) fail('the downloaded file is empty');
  if (result.parts.length !== 1) fail(`expected one part, got ${result.parts.length}`);
  if (result.parts[0]!.bytes !== bytes.length) {
    fail(`/result reports ${result.parts[0]!.bytes} bytes but the download served ${bytes.length}`);
  }

  return { created, job, result, bytes };
}

/**
 * Read a job's SSE stream to the end, as the browser does.
 *
 * The stream closes itself once a terminal event is sent, so reading the body to completion terminates. A job that
 * finished before the stream opened is replayed from the persisted events, which is also the case worth having: the
 * status each event carries has to be right in the replay too, and that is the path a page reload takes.
 */
async function streamEvents(jobId: string): Promise<{
  events: Array<{ status?: string; progress?: number; phase?: string; message?: string }>;
  eventNames: string[];
}> {
  const response = await call(`/api/v1/jobs/${jobId}/events`, { headers: { accept: 'text/event-stream' } });
  if (!response.ok) fail(`the events stream returned ${response.status}`, await response.text());
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    fail(`the events endpoint served ${contentType || '(no content type)'} instead of text/event-stream`);
  }
  const body = await response.text();
  const events: Array<{ status?: string; progress?: number; phase?: string; message?: string }> = [];
  const eventNames: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('event:')) eventNames.push(line.slice(6).trim());
    if (!line.startsWith('data:')) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()) as { status?: string; progress?: number });
    } catch {
      fail(`an event line is not JSON: ${line.slice(0, 200)}`);
    }
  }
  return { events, eventNames };
}

/** The three readers that must agree on a document's page objects, and the dangling-reference check with them. */
async function assertStructure(bytes: Uint8Array, label: string): Promise<void> {
  const structure = await readPdfHealth(bytes, REPO_ROOT);
  const readers: Array<[string, number | null]> = [
    ['a byte scan', structure.objects],
    ['an object walk', structure.parserObjects],
    ['the page tree', structure.tree],
  ];
  const known = readers.filter((entry): entry is [string, number] => entry[1] != null);
  const reference = known[0];
  if (!reference) {
    step(`${label}: no reader was reachable, so the page-object/tree invariant was not checked`);
    return;
  }
  const disagreeing = known.find(([, count]) => count !== reference[1]);
  if (disagreeing) {
    fail(`${label}: ${disagreeing[0]} counts ${disagreeing[1]} page(s) where ${reference[0]} counts ${reference[1]}`, {
      orphanPages: structure.orphanPages,
      readers: Object.fromEntries(known),
    });
  }
  if (structure.orphanPages && structure.orphanPages.length > 0) {
    fail(`${label}: the file holds page object(s) its tree does not list: ${structure.orphanPages.join(', ')}`);
  }
  if (structure.danglingFields || structure.danglingAnnotations) {
    fail(
      `${label}: ${structure.danglingFields ?? 0} form field(s) and ${structure.danglingAnnotations ?? 0} annotation(s) point at a page the tree does not have`,
      { fields: structure.danglingFields, annotations: structure.danglingAnnotations },
    );
  }
}

async function main() {
  console.log(`pdf-tools merge E2E → ${api}\n`);

  // ── Reachability and health ────────────────────────────────────────────────
  const health = await json<{ status: string; checks: { pools: Record<string, { workers: number }> } }>('/health');
  if (health.status !== 'ok') fail(`/health reports "${health.status}"`, health);
  step(
    `api healthy (${Object.entries(health.checks.pools)
      .map(([pool, info]) => `${pool}:${info.workers}`)
      .join(' ')})`,
  );

  if ((health.checks.pools.light?.workers ?? 0) === 0) {
    fail('no worker is registered for the light pool, so a merge could never complete. Start worker-light.');
  }

  // ── Catalog ────────────────────────────────────────────────────────────────
  const catalog = await json<{
    catalogVersion: number;
    tools: Array<{ id: string; enabled: boolean; available: boolean }>;
  }>('/api/v1/tools');
  const mergeEntry = catalog.tools.find((tool) => tool.id === 'merge');
  if (!mergeEntry) fail('merge is missing from the catalog');
  if (!mergeEntry.enabled) fail('merge is disabled in this build');
  if (!mergeEntry.available) fail('merge is not available on this anonymous plan');
  step(`catalog v${catalog.catalogVersion} lists merge as enabled and available`);

  // ── 1. Order, structure, and the delivered bytes ───────────────────────────
  // Generated here rather than taken from disk, so the expected totals are known by construction.
  const first = buildPdf({ pages: 2, label: 'Merge fixture A' });
  const second = buildPdf({ pages: 3, label: 'Merge fixture B' });
  const expectedPages = countPagesInPdf(first) + countPagesInPdf(second);

  const fileA = await upload('merge-two-a4.pdf', first);
  const fileB = await upload('merge-three-a4.pdf', second);
  step(`uploaded 2 generated fixtures (${expectedPages} pages total) with detected type application/pdf`);

  const forward = await merge([fileA, fileB], { bookmarks: 'keep' });
  const reportedPages = forward.job.output?.pages ?? null;
  if (reportedPages !== expectedPages) {
    fail(`the API reported ${reportedPages} pages but the inputs have ${expectedPages}`);
  }
  const actualPages = countPagesInPdf(forward.bytes);
  if (actualPages !== expectedPages) {
    fail(
      `the downloaded PDF has ${actualPages} pages, expected ${expectedPages}`,
      'an API that reports success while serving a truncated document is exactly what this check exists for',
    );
  }
  step(`downloaded ${forward.bytes.length} bytes and counted ${actualPages} pages in the file itself`);
  await assertStructure(forward.bytes, 'order case');

  const labels = fixturePageLabels(forward.bytes);
  const expectedLabels = [
    'Merge fixture A \u2014 page 1 of 2',
    'Merge fixture A \u2014 page 2 of 2',
    'Merge fixture B \u2014 page 1 of 3',
    'Merge fixture B \u2014 page 2 of 3',
    'Merge fixture B \u2014 page 3 of 3',
  ];
  if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
    fail(
      `the delivered pages read ${JSON.stringify(labels)}`,
      `expected ${JSON.stringify(expectedLabels)} — read from the file's own page text, not from a byte offset`,
    );
  }
  step('all five page labels, in order, read out of the delivered file');

  if (forward.result.metrics.inputPages !== expectedPages) {
    fail(
      `the job reported inputPages=${String(forward.result.metrics.inputPages)}; the handler checks the output against this number`,
      forward.result.metrics,
    );
  }
  if (forward.result.metrics.outputPages !== expectedPages) {
    fail(`the job reported outputPages=${String(forward.result.metrics.outputPages)}`, forward.result.metrics);
  }
  step(`the job reports inputPages and outputPages both ${expectedPages}, read from the files`);

  // Inputs with no outline have nothing to approximate, so a bookmark warning here would be a false alarm — the same
  // failure as a silent drop, told the other way round.
  const falseBookmarkWarning = forward.job.warnings.find((warning) => warning.code.startsWith('BOOKMARK'));
  if (falseBookmarkWarning) {
    fail('a merge of documents without outlines warned about bookmarks', falseBookmarkWarning);
  }
  step('no bookmark warning for inputs that carry no outline');

  // Neither input has an outline, so the output must not have an `/Outlines` dictionary either: a catalog that holds
  // an empty outline tree is a document whose reader shows a Bookmarks sidebar that opens onto nothing, and the job
  // has nothing to report about it. Asserted rather than assumed because opening an outline context in pikepdf is
  // enough to create the dictionary.
  const plainOutline = await readOutlineAndInfo(forward.bytes, { repoRoot: REPO_ROOT });
  if (!plainOutline) fail('no container was reachable to read the outline of the plain merge');
  if (plainOutline.hasOutlines) {
    fail('a keep merge of documents that carry no outline left an /Outlines dictionary behind', plainOutline);
  }
  step('a merge of outline-less inputs carries no /Outlines dictionary (not an empty one)');

  // ── 1b. The job's own directory: inputs and scratch gone, the output kept ──
  const leftovers = await jobDirEntries(forward.job.id);
  if (leftovers === null) fail('the completed job has no directory on the shared volume at all');
  const unexpected = leftovers.filter((entry) => entry !== 'output');
  if (unexpected.length > 0) {
    fail(`the completed job left ${unexpected.join(', ')} behind; only the output should outlive it`, leftovers);
  }
  step(`the completed job kept ${leftovers.join(', ')} and removed input, work, tmp and home`);

  // ── 1c. The progress stream the UI actually watches ───────────────────────
  // The polls above read the job row; the browser watches `GET /jobs/:id/events`. Two things can only be seen
  // from the stream itself: whether a progress line is stamped with the status the job had at that moment (the
  // snapshot taken when the stream opened is not that), and whether the bar ever steps backwards. Both were wrong
  // and neither is visible in the row — the client applies `status` from every event it receives.
  const watched = await json<{ id: string }>('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tool: 'merge',
      files: [fileA, fileB],
      options: { order: [fileA, fileB], bookmarks: 'keep' },
    }),
  });
  const streamed = await streamEvents(watched.id);
  if (streamed.events.length === 0) fail('the events stream carried no event at all');
  if (!(streamed.eventNames.length > 0)) fail('the events stream carried no named event');

  // The order a status may move in: forward only. `EXPIRED` is left out because a job that expires was never claimed.
  const RANK: Record<string, number> = { QUEUED: 0, PROCESSING: 1, COMPLETED: 2, FAILED: 2, CANCELLED: 2 };
  let rank = -1;
  let progress = -1;
  for (const event of streamed.events) {
    const status = event.status ?? '';
    if (!(status in RANK)) continue;
    const next = RANK[status]!;
    if (next < rank) {
      fail(
        `the stream reports ${status} after a later status (${JSON.stringify(streamed.events.map((e) => `${e.status}:${e.progress ?? '-'}`))})`,
        'the client applies this field, so a job that is processing shows "Queued" again',
      );
    }
    rank = next;
    if (event.progress != null) {
      if (event.progress < progress) {
        fail(
          `the stream steps progress back from ${progress}% to ${event.progress}%`,
          'a bar that goes backwards reads as a restart',
        );
      }
      progress = event.progress;
    }
  }
  if (rank !== 2) {
    fail(`the stream never reached a terminal status (last was rank ${rank})`, streamed.events);
  }
  step(
    `the progress stream is monotonic in status and percentage and ends COMPLETED (${streamed.events.length} events)`,
  );

  // ── 2. bookmarks=keep: one file-named parent per input, nesting preserved ──
  const toc = await fixture('bookmark-toc.pdf');
  const annex = await fixture('bookmark-annex-a4.pdf');
  const tocId = await upload('bookmark-toc.pdf', toc);
  const annexId = await upload('bookmark-annex-a4.pdf', annex);

  const kept = await merge([tocId, annexId], { bookmarks: 'keep' });
  const outline = await readOutlineAndInfo(kept.bytes, { repoRoot: REPO_ROOT });
  if (!outline) fail('no container was reachable to read the outline, so nothing was verified');

  if (!outline.hasOutlines) fail('bookmarks=keep produced a document with no /Outlines dictionary at all');
  const tops = outline.entries;
  if (tops.length !== 2) {
    fail(`expected one top-level entry per input (2), got ${tops.length}`, tops);
  }
  if (tops[0]?.title !== 'bookmark-toc.pdf' || tops[1]?.title !== 'bookmark-annex-a4.pdf') {
    fail(
      'the top-level entries are not named after their input files',
      tops.map((entry) => entry.title),
    );
  }
  if (tops[0]?.children.length !== 2 || tops[0]?.children[0]?.children.length !== 1) {
    fail('the first input lost its nesting: Chapter 1 → Section 1.1 and Chapter 2 were expected', tops[0]);
  }
  // The annex fixture's own outline is `Annex A → Annex A note`, so the kept form is the file-named parent, then the
  // source's entry, then its child: three levels, and the nesting *below* the parent is the source's, untouched.
  if (tops[1]?.children.length !== 1 || tops[1]?.children[0]?.title !== 'Annex A') {
    fail('the second input lost its entry', tops[1]);
  }
  if (tops[1]?.children[0]?.children.length !== 1 || tops[1]?.children[0]?.children[0]?.title !== 'Annex A note') {
    fail('the second input lost the entry nested inside its own outline', tops[1]);
  }
  // Destinations are the part a naive rebuild gets wrong: the annex starts at page 4 of the merged document, and an
  // entry that still points at page 1 would open the wrong document's page while looking perfectly bookmark-shaped.
  const annexParent = tops[1]!;
  if (
    annexParent.page !== 4 ||
    annexParent.children[0]?.page !== 4 ||
    annexParent.children[0]?.children[0]?.page !== 5
  ) {
    fail('the second input bookmarks were not remapped onto their merged pages', annexParent);
  }
  step(`bookmarks=keep: 2 file-named parents, ${outline.total} entries, destinations remapped to pages 1–5`);

  if (kept.result.metrics.sourcesWithOutline !== 2) {
    fail(`sourcesWithOutline=${String(kept.result.metrics.sourcesWithOutline)}, expected 2`, kept.result.metrics);
  }
  if (kept.result.metrics.metadataCopied !== true) {
    fail('the job reports that the first input metadata was not copied', kept.result.metrics);
  }
  if (outline.docinfo['/Title'] !== 'Bookmark fixture A title') {
    fail(`the merged document's /Info title is ${outline.docinfo['/Title'] ?? '(absent)'}`);
  }
  if (!searchableBytes(kept.bytes).includes('fixture-xmp-creator')) {
    fail('the merged document carries no XMP packet from the first input');
  }
  step('the first input /Info title and XMP packet are on the merged document');

  const keptBoxes = mediaBoxes(kept.bytes);
  if (keptBoxes.length !== 5) fail(`read ${keptBoxes.length} page boxes, expected 5`, keptBoxes);
  step('every page carries its own /MediaBox (5 of 5 read)');

  // ── 2b. A merge is not a flatten: the input's form fields and its non-widget annotations are still there ──
  // The claim is in §7 and no other check in this file can see it: a field is a dictionary no page content references,
  // so the page count, the text of every page and every byte search all pass on a document whose `/AcroForm` was
  // detached. The fixture is a five-field form (a text box, a checkbox, a choice, a radio group built as one field
  // with two kid widgets, and a signature field) plus one highlight that is not a widget.
  const form = await fixture('form-five-fields-a4.pdf');
  const formId = await upload('form-five-fields-a4.pdf', form);
  const sourceFields = await readFormFields(form, { repoRoot: REPO_ROOT });
  if (!sourceFields) fail('no container was reachable to read the fixture\u2019s own fields');
  if (sourceFields.names.length !== 5 || sourceFields.widgets !== 6) {
    fail('the fixture is not the five-field form this case is about', sourceFields);
  }

  const withForm = await merge([formId, fileB], { bookmarks: 'keep' });
  const mergedFields = await readFormFields(withForm.bytes, { repoRoot: REPO_ROOT });
  if (!mergedFields) fail('no container was reachable to read the merged document\u2019s fields');
  if (!mergedFields.hasAcroForm) fail('the merged document has no /AcroForm at all', mergedFields);
  if (JSON.stringify(mergedFields.names) !== JSON.stringify(sourceFields.names)) {
    fail('the merged document\u2019s fields differ from the input\u2019s', {
      source: sourceFields.names,
      merged: mergedFields.names,
    });
  }
  if (mergedFields.widgets !== 6) {
    fail(`the merged document has ${mergedFields.widgets} widget(s) where the input has 6`, mergedFields);
  }
  step('the merged document still carries all 5 fields (6 widgets), read from its /AcroForm');

  const mergedMarks = await readAnnotationState(withForm.bytes, { repoRoot: REPO_ROOT });
  if (!mergedMarks) fail('no container was reachable to read the merged document\u2019s annotations');
  if (mergedMarks.total !== 7) {
    fail(`the merged document has ${mergedMarks.total} annotation(s); the input has 7 (6 widgets and a highlight)`);
  }
  if (!mergedMarks.pages[0]?.subtypes.includes('Highlight')) {
    fail('the highlight that is not a widget did not survive the merge', mergedMarks.pages[0]);
  }
  step('the non-widget highlight is still on page 1 and every mark still prints');

  // ── 3. bookmarks=flatten: one flat list, in document order ────────────────
  const flat = await merge([tocId, annexId], { bookmarks: 'flatten' });
  const flatOutline = await readOutlineAndInfo(flat.bytes, { repoRoot: REPO_ROOT });
  if (!flatOutline) fail('no container was reachable to read the flattened outline');
  if (!flatOutline.hasOutlines) fail('bookmarks=flatten produced a document with no /Outlines dictionary');
  const flatTitles = flatOutline.entries.map((entry) => entry.title);
  const expectedFlat = ['Chapter 1', 'Section 1.1', 'Chapter 2', 'Annex A', 'Annex A note'];
  if (JSON.stringify(flatTitles) !== JSON.stringify(expectedFlat)) {
    fail(`flatten produced ${JSON.stringify(flatTitles)}`, `expected ${JSON.stringify(expectedFlat)}`);
  }
  if (flatOutline.entries.some((entry) => entry.children.length > 0)) {
    fail('flatten left nesting in the outline', flatOutline.entries);
  }
  step('bookmarks=flatten: 5 entries, flat, in document order');

  // ── 4. bookmarks=none: no outline, metadata still carried ─────────────────
  const stripped = await merge([tocId, annexId], { bookmarks: 'none' });
  const strippedOutline = await readOutlineAndInfo(stripped.bytes, { repoRoot: REPO_ROOT });
  if (!strippedOutline) fail('no container was reachable to read the stripped document');
  if (strippedOutline.hasOutlines)
    fail('bookmarks=none left an /Outlines dictionary in the catalog', strippedOutline.entries);
  step('bookmarks=none: the catalog has no /Outlines');

  // ── 5. The `order` option is the merge order ──────────────────────────────
  const reversed = await merge([fileA, fileB], { bookmarks: 'keep' }, [fileB, fileA]);
  const reversedLabels = fixturePageLabels(reversed.bytes);
  const expectedReversed = [
    'Merge fixture B \u2014 page 1 of 3',
    'Merge fixture B \u2014 page 2 of 3',
    'Merge fixture B \u2014 page 3 of 3',
    'Merge fixture A \u2014 page 1 of 2',
    'Merge fixture A \u2014 page 2 of 2',
  ];
  if (JSON.stringify(reversedLabels) !== JSON.stringify(expectedReversed)) {
    fail(`the reversed merge reads ${JSON.stringify(reversedLabels)}`, `expected ${JSON.stringify(expectedReversed)}`);
  }
  step('an explicit order reverses the delivered pages, page 1 carrying the original last file\u2019s first page');

  // ── 6. Mixed page sizes are preserved, not normalised ─────────────────────
  const landscape = await fixture('rotate-landscape-a4.pdf');
  const landscapeId = await upload('rotate-landscape-a4.pdf', landscape);
  const mixed = await merge([landscapeId, tocId], { bookmarks: 'keep' });
  const mixedBoxes = mediaBoxes(mixed.bytes);
  const expectedBoxes = [
    { width: 842, height: 595 },
    { width: 842, height: 595 },
    { width: 595, height: 842 },
    { width: 595, height: 842 },
    { width: 595, height: 842 },
  ];
  if (JSON.stringify(mixedBoxes) !== JSON.stringify(expectedBoxes)) {
    fail(
      `page boxes came out as ${JSON.stringify(mixedBoxes)}`,
      'a merge that normalised sizes to one format passes every page-count check',
    );
  }
  step('mixed A4-landscape + A4-portrait inputs keep their original /MediaBox per page');

  const mixedOutline = await readOutlineAndInfo(mixed.bytes, { repoRoot: REPO_ROOT });
  if (mixedOutline?.entries[0]?.title !== 'bookmark-toc.pdf' || mixedOutline.entries[0]?.page !== 3) {
    fail('the bookmark of the second file in the order was not remapped past the first file pages', mixedOutline);
  }
  step('bookmarks stay correct when the offset comes from a different-sized document');

  // ── 7. A damaged input: refused, and named by position ────────────────────
  const damagedId = await upload('merge-damaged.pdf', await fixture('merge-damaged.pdf'));
  const damagedResponse = await call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files: [tocId, damagedId], options: { bookmarks: 'keep' } }),
  });
  if (damagedResponse.status !== 202) {
    fail(`expected the damaged-file job to be accepted and fail in the worker, got ${damagedResponse.status}`);
  }
  const damagedJob = (await damagedResponse.json()) as { id: string };
  const failedView = await waitForJob(damagedJob.id, 'failure');
  if (failedView.status !== 'FAILED') fail(`expected FAILED, got ${failedView.status}`, failedView);
  if (failedView.error?.code !== 'CONVERSION_FAILED') {
    fail(`a damaged input failed as ${String(failedView.error?.code)}, expected CONVERSION_FAILED`, failedView.error);
  }
  const message = failedView.error?.message ?? '';
  if (!message.includes('file 2 of 2') || !message.includes('merge-damaged.pdf')) {
    fail(`the failure does not name the position and the file: ${message}`);
  }
  // The staging path is what qpdf prints, and it is what a passthrough of its stderr would hand the user. The sentence
  // has to name the file the user chose, so neither the numeric staging prefix nor any root of the server's disk may
  // appear in it — `<work>`, `/var/lib/…`, `/tmp/…` or `input/002__`.
  const leak = /<work>|<staging>|<tmp>|\/var\/lib|\/tmp\/|(?:^|\s|[^(])input\/\d+__/.exec(message);
  if (leak) fail(`the failure leaks a server path (${leak[0].trim()}): ${message}`);
  step(`a damaged input fails with a position and no path: "${message}"`);

  // The failed job's directory is emptied rather than left holding the inputs of a job nobody can retry: a document
  // that was refused would otherwise sit on the volume until its TTL, and "staging purged" is a claim about disk.
  const failedLeftovers = await jobDirEntries(damagedJob.id);
  if (failedLeftovers === null) fail('the failed job has no directory on the shared volume at all');
  if (failedLeftovers.length > 0) {
    fail(`the failed job left ${failedLeftovers.join(', ')} behind; a terminal failure keeps nothing`, failedLeftovers);
  }
  step('the failed job left nothing behind — no input, no scratch, no output');

  // ── 8. An encrypted input is refused before any work ──────────────────────
  const encryptedId = await upload('protected-aes256-a4.pdf', await fixture('protected-aes256-a4.pdf'));
  const encryptedResponse = await call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files: [tocId, encryptedId], options: { bookmarks: 'keep' } }),
  });
  const encryptedBody = (await encryptedResponse.json()) as { error?: { code?: string }; code?: string };
  if (encryptedResponse.status !== 422) {
    fail(`an encrypted input returned ${encryptedResponse.status}, expected 422`, encryptedBody);
  }
  if ((encryptedBody.error?.code ?? encryptedBody.code) !== 'ENCRYPTED_INPUT') {
    fail('an encrypted input was refused with the wrong code', encryptedBody);
  }
  step('an encrypted input is refused with 422 ENCRYPTED_INPUT, before any worker runs');

  // ── 9. Above 20 files the job is routed to the `heavy` pool, and the whole 42 pages still arrive ──
  // The smallest honest escalation test: `aboveFiles: 20`, so 21 inputs is the first number that moves. The inputs are
  // one file repeated, exactly as the golden suite does it — the pool routing is about the count the job claims.
  //
  // Asserted as the **queue name** (`pdf-heavy`), which is what this field carries: the `heavy` pool id is published
  // under its own name elsewhere (`/health` → `checks.pools`, the catalog's per-tool `queue`), while the jobs table's
  // column, the BullMQ key and the job's own record all spell the queue `pdf-heavy`. This suite asserted the pool id
  // until the golden harness started reading the same field back from the job — the two answers disagreed, and this
  // line is what made the disagreement visible in the merge suite too.
  const escalated = await merge(
    Array.from({ length: 21 }, () => fileA),
    { bookmarks: 'keep' },
  );
  if (escalated.created.queue !== 'pdf-heavy') {
    fail(`21 files were routed to ${escalated.created.queue}, expected the pdf-heavy queue`, escalated.created);
  }
  const escalatedPages = countPagesInPdf(escalated.bytes);
  if (escalatedPages !== 42) {
    fail(`the escalated merge has ${escalatedPages} pages, expected 42 (21 inputs × 2)`);
  }
  if (escalated.result.metrics.inputPages !== 42) {
    fail(
      `the escalated job reported inputPages=${String(escalated.result.metrics.inputPages)}`,
      escalated.result.metrics,
    );
  }
  step('21 files route to the heavy pool and all 42 pages arrive, counted in the delivered file');

  // ── 10. The file-count ceiling is a request-level refusal ───────────────────
  const fiftyOne = Array.from({ length: 51 }, () => fileA);
  const overResponse = await call('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files: fiftyOne, options: {} }),
  });
  const overBody = (await overResponse.text()).slice(0, 400);
  if (overResponse.status !== 422) {
    fail(`51 files returned ${overResponse.status}, expected 422`, overBody);
  }
  if (!/2–50|2-50/.test(overBody)) {
    fail('the refusal does not say what the accepted range is', overBody);
  }
  step('51 files is refused with 422 naming the accepted range, not silently truncated');

  console.log(`\nmerge E2E passed — ${steps.length} checks against ${api}`);
}

await main();
