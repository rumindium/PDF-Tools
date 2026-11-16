import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Box,
  type DisplayGeometry,
  type PlacementElement,
  boxFromDisplay,
  pageSizeFromPixels,
  placeElement,
} from '../../apps/web/src/features/placement/geometry';
// The annotate shape's own logic, imported rather than copied: the point of this leg is that the payload the canvas
// posts is the payload the engine reads, so re-spelling the entry here would test this file instead of the editor.
import { createAnnotation } from '../../apps/web/src/features/placement/shapes/annotations';
import { createRedaction } from '../../apps/web/src/features/placement/shapes/redactions';
import { createSignature, moveSignature, unitToPoints } from '../../apps/web/src/features/placement/shapes/signature';
import { firstPageMediaBox, readAnnotationGeometry, searchableBytes } from '../../e2e/lib/pdf-inspect';
import { type RenderedPage, inkShare, parseRegion, renderPageGray } from '../../e2e/lib/render';
import { requireAnonymousUse } from '../../e2e/lib/stack-gap';
import { buildPdf } from '../dev/pdf-writer';

/**
 * The placement canvas, measured rather than eyeballed.
 *
 *   bun run test:placement
 *
 * The tools whose options carry coordinates are positioned in PDF user space, and the UI for them is a canvas that draws
 * the document's own pages and turns a drag into those coordinates. That makes the canvas's arithmetic **load-bearing
 * in a way no unit test can finish proving**: a sign, a scale or an origin error still produces a valid job, a valid
 * PDF, and a mark somewhere other than where the user put it. The geometry has unit tests
 * (`apps/web/src/features/placement/geometry.test.ts`, and one suite per shape) and they pin the directions; this stage
 * asks the engines whether the answer was right, which is the only thing that can.
 *
 * It imports the **shipped** functions rather than re-implementing them, so what is verified is what the browser runs.
 * Seven claims, each one true in the code and false in the world in its own way:
 *
 *   1. the control is declared and reachable — the whole UI is catalog-driven, so a `placement` field naming a tool
 *      that does not exist, is disabled, or is gated would be an editor nobody can open;
 *   2. the preview a canvas asks for is one PNG of the page it asked for, labelled with that page (the canvas finds its
 *      part by that label — a renderer that stopped writing `pages` would show page 1 for page 5);
 *   3. the image's pixels, read through `pageSizeFromPixels`, are the document's own page size. Every drag is converted
 *      with `72 / dpi`, so this is the assumption the entire canvas rests on;
 *   4. a drag lands where it was drawn: the mark appears in the 10 pt band above the expected `y` and **not** in the
 *      vertical mirror of it, which is exactly where an unflipped conversion puts it. And `placeElement`'s 10 pt nudge
 *      (the arrow keys) moves the mark by 10 pt, leaving the band it came from empty;
 *   5. the *other* shape's drag lands where it was drawn too — `annotate`'s highlight, whose claim cannot be read as ink
 *      (a highlight is 219/255 in a grayscale render, above the threshold every ink check uses) and so is read as the
 *      four numbers a reader will use: the file's own `/Rect`, on the page the canvas was showing, with `/QuadPoints`
 *      and `/F 4` beside it;
 *   6. the *third* shape's two units are one box — `sign`'s millimetre entry, written by the same `moveSignature` the
 *      row's unit selector calls, inks the page where its points twin does and not 2.83× further out. This is the one
 *      shape whose numbers have a unit, so it is the one shape where a wrong number is still a valid job: the engine
 *      reads `units` and converts, the canvas does not convert twice, and only a render can tell those apart.
 *   7. the *fourth* shape's box removes what is under it and **only** that — `redact`'s canvas, where a wrong box is
 *      the most dangerous success in this build: the job completes, the file is valid, and the value the user marked is
 *      still inside it. Absence cannot be read as ink, so the leg writes a document whose own numbers place two tokens,
 *      aims the drawn box at the first, and reads the output for the absence of one and the presence of the other.
 *      Both readings go through `searchableBytes`, which reads the file's `<hex>` strings as well as its literals: the
 *      page label survives the rewrite in exactly that spelling, so it is asserted beside the token — an absence is
 *      worth what the reader's eye for a *surviving* string is worth, and nothing more.
 *
 * The signature leg is why this stage exists. "The ink is where I aimed" is checkable by one assertion, but it is the pair —
 * ink *there*, none *there* — that distinguishes a correct flip from an inverted one, and no structural assertion (page
 * count, extracted text, byte search) can tell them apart.
 *
 * It needs the compose stack, the light image (the renderer and `pdftoppm`) and — for the signature and redaction legs,
 * whose handlers live there — the heavy image as well: the preview is a `pdf-to-images` job on the light pool, and
 * neither `sign` nor `redact` is.
 * Measurements land in `e2e/artifacts/placement.json`.
 */

interface Args {
  base: string;
  jsonPath: string;
  timeoutSeconds: number;
}

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const args: Args = {
  base: (value('--base') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  jsonPath: value('--json') ?? 'e2e/artifacts/placement.json',
  timeoutSeconds: Number(value('--timeout') ?? 180),
};

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const FIXTURE = join(REPO_ROOT, 'fixtures', 'generated', 'pages-six-a4.pdf');
const DEV_PLAN_TOKEN = process.env.DEV_PLAN_TOKEN ?? 'dev-plan-token';

/** The element `edit-pdf` is asked to draw: a word with no descenders, big enough to measure ink in a 10 pt band. */
const TEXT = 'PLACEMENT9X7';
const FONT_SIZE = 24;

const checks: Array<{ check: string; detail: string }> = [];
const measurements: Record<string, unknown> = {};

function step(check: string, detail: string): void {
  checks.push({ check, detail });
  console.log(`  ✓ ${detail}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) {
    console.error(`  ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
  }
  if (checks.length > 0) console.error(`\nreached:\n${checks.map((entry) => `  · ${entry.detail}`).join('\n')}`);
  process.exit(1);
}

let cookie = '';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  // `edit-pdf` is a Pro tool, and the preview it renders is not: the canvas asks for the render as the same caller, so
  // the stage has to be Pro for the *right* reason rather than borrowing entitlement from `pdf-to-images`.
  headers.set('x-dev-plan', 'pro');
  headers.set('x-dev-plan-token', DEV_PLAN_TOKEN);
  const response = await fetch(`${args.base}${path}`, { ...init, headers, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    if (pair?.startsWith('pdft_session=')) cookie = pair;
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  const text = await response.text();
  if (!response.ok) fail(`${init?.method ?? 'GET'} ${path} returned ${response.status}`, text.slice(0, 600));
  return (text ? JSON.parse(text) : undefined) as T;
}

interface OptionsUiFieldView {
  key: string;
  control: string;
  placement?: { shape: string; renderTool: string; dpi: number; kinds: string[] };
}

interface CatalogToolView {
  id: string;
  enabled: boolean;
  available: boolean;
  optionsUi: OptionsUiFieldView[];
}

interface JobView {
  id: string;
  status: string;
  error: { code: string; message: string } | null;
  metrics?: Record<string, unknown>;
}

async function uploadBytes(
  bytes: Uint8Array,
  name: string,
  mime = 'application/pdf',
): Promise<{ id: string; pages: number | null }> {
  // Copied into a plain `ArrayBuffer`-backed view: the writer types its output as `Uint8Array<ArrayBufferLike>`, which
  // `File` will not take, and a copy of a few kilobytes is cheaper than a cast that hides where the bytes came from.
  const form = new FormData();
  form.append('kind', 'input');
  form.append('file', new File([new Uint8Array(bytes)], name, { type: mime }));
  const response = await call('/api/v1/files', { method: 'POST', body: form });
  const text = await response.text();
  if (response.status !== 201) fail(`uploading ${name} returned ${response.status}`, text.slice(0, 600));
  return JSON.parse(text) as { id: string; pages: number | null };
}

async function upload(path: string, mime = 'application/pdf'): Promise<{ id: string; pages: number | null }> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return uploadBytes(bytes, path.split('/').pop() ?? 'document.pdf', mime);
}

async function waitForJob(jobId: string): Promise<JobView> {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let last: JobView | null = null;
  while (Date.now() < deadline) {
    const job = await json<JobView>(`/api/v1/jobs/${jobId}`);
    last = job;
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') return job;
    await Bun.sleep(400);
  }
  fail(`the job did not finish within ${args.timeoutSeconds}s`, last);
}

async function download(jobId: string, part: number): Promise<Uint8Array> {
  const response = await call(`/api/v1/jobs/${jobId}/download?part=${part}`);
  if (!response.ok) fail(`downloading part ${part} of ${jobId} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A PNG's own pixel size, read from the IHDR chunk.
 *
 * Not through an image library: the question is what the file *says* its size is, and a decoder that resizes on load
 * would answer a different one. Width and height are two big-endian uint32s at a fixed offset in the first chunk, which
 * is a property of the format rather than of any encoder.
 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const [index, byte] of signature.entries()) {
    if (bytes[index] !== byte) fail('the preview part is not a PNG', [...bytes.slice(0, 12)]);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** How many pixels a region gained (positive) or lost (negative) between two renders of the same page. */
function delta(before: RenderedPage, after: RenderedPage, region: string): { added: number; region: string } {
  const parsed = parseRegion(region);
  if (!parsed) fail(`"${region}" is not a page,x,y,w,h region`);
  if (before.widthPx !== after.widthPx || before.heightPx !== after.heightPx) {
    fail('the two renders have different sizes, so a pixel comparison would be meaningless', {
      before: [before.widthPx, before.heightPx],
      after: [after.widthPx, after.heightPx],
    });
  }
  return { added: inkShare(after, parsed).dark - inkShare(before, parsed).dark, region };
}

const round = (value: number): number => Math.round(value * 10) / 10;

async function main(): Promise<void> {
  console.log(`placement → ${args.base}, the canvas arithmetic against the engines\n`);

  // The arithmetic is checked against real outputs, which means uploading a fixture and running a job
  // (`e2e/lib/stack-gap.ts`).
  await requireAnonymousUse(args.base, 'this stage uploads a fixture before it can place anything on it');

  // ── 1. The control, as the browser would receive it ────────────────────────
  const catalog = await json<{ tools: CatalogToolView[] }>('/api/v1/tools');
  const tool = catalog.tools.find((entry) => entry.id === 'edit-pdf');
  if (!tool) fail('the catalog does not list edit-pdf');
  const field = tool.optionsUi.find((entry) => entry.key === 'elements');
  if (!field) fail('edit-pdf has no elements option in its optionsUi');
  if (field.control !== 'placement') {
    fail(`edit-pdf's elements control is "${field.control}", so the canvas is not reachable from the catalog`, field);
  }
  const placement = field.placement;
  if (!placement) fail('the placement control carries no placement metadata');

  const renderTool = catalog.tools.find((entry) => entry.id === placement.renderTool);
  if (!renderTool) fail(`the placement control names "${placement.renderTool}", which is not in the catalog`);
  if (!renderTool.enabled || !renderTool.available) {
    fail(`the render tool "${placement.renderTool}" is listed but not usable on this stack`);
  }
  if (!(placement.dpi >= 36 && placement.dpi <= 600)) {
    fail(`the declared dpi ${placement.dpi} is outside the range the renderer accepts (36–600)`);
  }
  if (placement.kinds.length !== 5) {
    fail(`the toolbar declares ${placement.kinds.length} kinds; edit-pdf's schema has 5`);
  }
  step(
    'the control',
    `edit-pdf.elements is a placement canvas: renders with ${placement.renderTool} at ${placement.dpi} dpi, ${placement.kinds.join('/')} — and that tool is enabled`,
  );

  // ── 2. The preview job the canvas creates, with its parameters ─────────────
  const fixtureBytes = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
  const document = await upload(FIXTURE);
  const page = 1;
  const renderJob = await json<JobView>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      tool: placement.renderTool,
      files: [document.id],
      options: { format: 'png', dpi: placement.dpi, colorMode: 'color', pages: [String(page)] },
      retainMinutes: 30,
    }),
    headers: { 'content-type': 'application/json' },
  });
  const finishedRender = await waitForJob(renderJob.id);
  if (finishedRender.status !== 'COMPLETED') {
    fail(`the preview job ended ${finishedRender.status}`, finishedRender.error);
  }

  const result = await json<{ parts: Array<{ name: string; mime: string; bytes: number; pages?: number[] }> }>(
    `/api/v1/jobs/${renderJob.id}/result`,
  );
  if (result.parts.length !== 1) {
    fail(`the preview returned ${result.parts.length} parts where the canvas expects one page's image`, result.parts);
  }
  const part = result.parts[0]!;
  if (part.mime !== 'image/png') fail(`the preview part is ${part.mime}, not image/png`);
  if (!(part.pages ?? []).includes(page)) {
    fail(`the only part does not declare page ${page}, so the canvas could not find it by page`, part);
  }
  const previewBytes = await download(renderJob.id, 0);
  const pixels = pngSize(previewBytes);
  step(
    'one page, one image, labelled',
    `the preview is a single PNG part for page ${page} — ${part.name}, ${part.bytes} bytes, declaring pages [${(part.pages ?? []).join(', ')}]`,
  );

  // ── 3. The pixels are the page, which is what every drag is converted through ──
  const geometryPage = pageSizeFromPixels(pixels, placement.dpi);
  const real = firstPageMediaBox(fixtureBytes);
  if (!real) fail('the fixture has no readable /MediaBox, so there is nothing to compare the preview against');
  const sizeError = Math.max(
    Math.abs(geometryPage.widthPt - real.width),
    Math.abs(geometryPage.heightPt - real.height),
  );
  if (sizeError > 1) {
    fail(
      `the rendered image implies a ${round(geometryPage.widthPt)}×${round(geometryPage.heightPt)} pt page, but the document's own /MediaBox is ${round(real.width)}×${round(real.height)} pt — ${round(sizeError)} pt apart, so every drag is scaled wrong`,
    );
  }
  step(
    'the pixels are the page',
    `${pixels.width}×${pixels.height} px at ${placement.dpi} dpi → ${round(geometryPage.widthPt)}×${round(geometryPage.heightPt)} pt, which is the document's own /MediaBox (${round(real.width)}×${round(real.height)} pt) to within ${round(sizeError)} pt`,
  );

  // ── 4. A drag on the canvas becomes the coordinates the engines paint at ───
  // The canvas measures in CSS pixels (scale 1: the image's own pixels) and converts with the declared dpi — the same
  // numbers, through the same function, as a real drag.
  const geometry: DisplayGeometry = { scale: 1, dpi: placement.dpi, page: geometryPage };
  // Deliberately in the **lower** half of the page, so the flip is decided by the assertions below rather than by the
  // page's symmetry.
  const drag = { left: 80, top: 700, width: 240, height: 40 };
  const dragged: Box = boxFromDisplay(drag, geometry);
  if (dragged.y > geometryPage.heightPt / 2) {
    fail('the fixture for this stage is wrong: a drag in the lower half of the canvas came out in the upper half', {
      y: dragged.y,
      pageHeightPt: geometryPage.heightPt,
    });
  }

  const first: PlacementElement = {
    type: 'text',
    page,
    x: dragged.x,
    y: dragged.y,
    text: TEXT,
    font: 'Helvetica',
    size: FONT_SIZE,
    color: '#000000',
    rotation: 0,
  };
  // The arrow-key path: the same element 10 pt higher and to the right, so both marks are in one job and one render.
  const nudged: PlacementElement = {
    ...placeElement(first, { ...dragged, x: dragged.x + 250, y: dragged.y + 10 }),
    text: TEXT,
  };
  if (nudged.y - first.y !== 10 || nudged.x - first.x !== 250) {
    fail('placeElement did not move the element by the delta it was given', { before: first, after: nudged });
  }

  const editJob = await json<JobView>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      tool: 'edit-pdf',
      files: [document.id],
      options: { elements: [first, nudged], flatten: true },
    }),
    headers: { 'content-type': 'application/json' },
  });
  const finishedEdit = await waitForJob(editJob.id);
  if (finishedEdit.status !== 'COMPLETED') fail(`edit-pdf ended ${finishedEdit.status}`, finishedEdit.error);
  const editedBytes = await download(editJob.id, 0);

  const before = await renderPageGray(fixtureBytes, page);
  const after = await renderPageGray(editedBytes, page);
  if (!before || !after) fail('no renderer is reachable, so placement cannot be measured');

  // A 10 pt band sitting on each mark's baseline: the glyphs start exactly there and rise, so ink in this band is ink at
  // the requested `y` and not merely somewhere on the same page.
  const markBand = `1,${round(first.x)},${round(first.y)},${round(FONT_SIZE * 2)},10`;
  const nudgedBand = `1,${round(nudged.x)},${round(nudged.y)},${round(FONT_SIZE * 2)},10`;
  // Where an unflipped conversion would have put them: the mirror of the band about the page's mid-height.
  const mirrored = round(geometryPage.heightPt - first.y - 10);
  const mirroredBand = `1,${round(first.x)},${mirrored},${round(FONT_SIZE * 2)},10`;
  // Where the nudged mark would be if the arrow keys had been ignored.
  const abandoned = `1,${round(nudged.x)},${round(first.y)},${round(FONT_SIZE * 2)},10`;

  const marks = delta(before, after, markBand);
  const mirrors = delta(before, after, mirroredBand);
  const nudges = delta(before, after, nudgedBand);
  const abandonedBand = delta(before, after, abandoned);

  const minInk = 40;
  if (marks.added < minInk) {
    fail(
      `the mark is not where the drag put it: ${marks.added} new dark pixel(s) in ${markBand} (expected at least ${minInk})`,
      { dragged, band: markBand },
    );
  }
  if (nudges.added < minInk) {
    fail(`the nudged mark is not where placeElement put it: ${nudges.added} new dark pixel(s) in ${nudgedBand}`);
  }
  if (mirrors.added > 1) {
    fail(
      `the vertical flip is inverted: ${mirrors.added} new dark pixel(s) at the mirrored y (${mirrored} pt) — the canvas put the mark on the wrong half of the page`,
    );
  }
  if (abandonedBand.added > 1) {
    fail(`the arrow-key nudge was ignored: ${abandonedBand.added} new dark pixel(s) at the y the mark came from`);
  }

  step(
    'a drag lands where it was drawn',
    `${marks.added} new dark pixel(s) in the 10 pt band at the requested y=${round(first.y)} pt in ${markBand}, and ${mirrors.added} at the vertical mirror (y=${mirrored} pt) — so the flip is decided, not assumed`,
  );
  step(
    'the keyboard moves the mark by points',
    `+250 pt right and +10 pt up: ${nudges.added} new dark pixel(s) in the band above the new y, ${abandonedBand.added} where the mark came from`,
  );

  measurements.draggedBox = dragged;
  measurements.mirroredYPt = mirrored;
  measurements.ink = {
    markBand: marks.added,
    nudgedBand: nudges.added,
    mirroredBand: mirrors.added,
    abandonedBand: abandonedBand.added,
  };
  measurements.preview = { pixels, page: geometryPage, mediaBox: real };

  // ── 5. The same canvas, the other shape: annotate's marks are dictionaries, not paint ─────────────────
  // `annotate`'s marks cannot be measured as ink: a highlight reads at 219/255 in a grayscale render, above the
  // harness's 200 threshold (`0-TESTING.md` §5), so the same claim has to be read from the file instead. What is
  // compared is the four numbers the reader will use — `/Rect` — against the box the canvas computed from a drag.
  const annotateTool = catalog.tools.find((entry) => entry.id === 'annotate');
  const annotationsField = annotateTool?.optionsUi.find((entry) => entry.key === 'annotations');
  if (!annotationsField) fail('annotate has no annotations option in its optionsUi');
  if (annotationsField.control !== 'placement') {
    fail(
      `annotate's annotations control is "${annotationsField.control}", so its canvas is not reachable from the catalog`,
      annotationsField,
    );
  }
  const annotationPlacement = annotationsField.placement;
  if (!annotationPlacement) fail('the annotations control carries no placement metadata');
  if (annotationPlacement.shape !== 'annotations') {
    fail(`the annotations control declares shape "${annotationPlacement.shape}"`, annotationPlacement);
  }
  if (annotationPlacement.renderTool !== placement.renderTool) {
    fail('the two placement controls render their pages with different tools, so one canvas cannot serve both');
  }
  step(
    'the control, second shape',
    `annotate.annotations is the same canvas with shape "${annotationPlacement.shape}": renders with ${annotationPlacement.renderTool} at ${annotationPlacement.dpi} dpi, ${annotationPlacement.kinds.join('/')}`,
  );

  // Page 2 on purpose: the canvas's page picker has to travel with the mark, and a mark that landed on page 1 would be
  // indistinguishable from one whose page number was dropped.
  const markPage = 2;
  const highlightDrag = { left: 120, top: 620, width: 300, height: 28 };
  const highlightBox = boxFromDisplay(highlightDrag, geometry);
  if (highlightBox.y + highlightBox.height > geometryPage.heightPt / 2) {
    fail('the fixture for this stage is wrong: a drag in the lower half came out in the upper half', {
      box: highlightBox,
      pageHeightPt: geometryPage.heightPt,
    });
  }
  const mark = createAnnotation('highlight', markPage, highlightBox);

  const annotateJob = await json<JobView>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      tool: 'annotate',
      files: [document.id],
      options: { annotations: [mark.entry], flatten: false },
    }),
    headers: { 'content-type': 'application/json' },
  });
  const finishedAnnotate = await waitForJob(annotateJob.id);
  if (finishedAnnotate.status !== 'COMPLETED') {
    fail(`annotate ended ${finishedAnnotate.status}`, finishedAnnotate.error);
  }
  const annotatedBytes = await download(annotateJob.id, 0);

  const annotations = await readAnnotationGeometry(annotatedBytes, { repoRoot: REPO_ROOT });
  if (!annotations) {
    fail('no pikepdf container is reachable, so the mark cannot be read back — failing rather than skipping');
  }
  const onPage = annotations.filter((entry) => entry.page === markPage);
  if (onPage.length !== 1) {
    fail(`page ${markPage} carries ${onPage.length} annotation(s) where the canvas placed one`, annotations);
  }
  const placed = onPage[0]!;
  const [llx, lly, urx, ury] = placed.rect;
  const expected = {
    x0: highlightBox.x,
    y0: highlightBox.y,
    x1: highlightBox.x + highlightBox.width,
    y1: highlightBox.y + highlightBox.height,
  };
  const rectError = Math.max(
    Math.abs(llx - expected.x0),
    Math.abs(lly - expected.y0),
    Math.abs(urx - expected.x1),
    Math.abs(ury - expected.y1),
  );
  if (rectError > 0.5) {
    fail(
      `the mark is not where the drag put it: the file's /Rect is [${llx}, ${lly}, ${urx}, ${ury}] where the canvas asked for [${round(expected.x0)}, ${round(expected.y0)}, ${round(expected.x1)}, ${round(expected.y1)}]`,
      { drag: highlightDrag, box: highlightBox, placed },
    );
  }
  // The mirror, again: an unflipped conversion would put the rect's `y0` at the page height minus the box's top.
  const mirroredY = geometryPage.heightPt - highlightBox.y - highlightBox.height;
  if (Math.abs(lly - mirroredY) <= 1) {
    fail(`the vertical flip is inverted: the rect's y0 (${round(lly)}) is the mirror of the requested y`);
  }
  if (placed.subtype.toLowerCase() !== 'highlight') {
    fail(`the mark came back as /${placed.subtype}, not a Highlight`);
  }
  if (placed.quadPoints < 1) fail('the mark carries no /QuadPoints, so a reader cannot align it to text');
  if (!placed.hasPrintFlag) fail('the mark does not carry /F 4, so it would not print');
  step(
    'a drag lands where it was drawn, read out of the file',
    `the canvas's box ${round(highlightBox.x)}, ${round(highlightBox.y)} → /Rect [${round(llx)}, ${round(lly)}, ${round(urx)}, ${round(ury)}] on page ${placed.page} (within ${round(rectError)} pt), ${placed.quadPoints} quad(s), /F 4 set, and not the mirror at y=${round(mirroredY)}`,
  );

  measurements.highlight = {
    drag: highlightDrag,
    box: highlightBox,
    page: placed.page,
    subtype: placed.subtype,
    rect: placed.rect,
    rectError: round(rectError),
    mirroredY: round(mirroredY),
  };

  // ── 6. The third shape: `sign` — the canvas's millimetre entry is the same box as its points one ───────────────
  // This shape is the only one whose numbers carry a unit, which makes it the only one where the canvas and the engine
  // can disagree *quietly*: both convert, and the failure mode of a double conversion or a skipped one is a signature
  // in the wrong place on a valid page — still a signature, still a completed job.
  const signTool = catalog.tools.find((entry) => entry.id === 'sign');
  if (!signTool) fail('the catalog does not list sign');
  const signFields = signTool.optionsUi.find((entry) => entry.key === 'fields');
  if (!signFields) fail('sign has no fields option in its optionsUi');
  if (signFields.control !== 'placement') {
    fail(
      `sign's fields control is "${signFields.control}", so its canvas is not reachable from the catalog`,
      signFields,
    );
  }
  const signPlacement = signFields.placement;
  if (!signPlacement) fail('the sign fields control carries no placement metadata');
  if (signPlacement.shape !== 'signature') {
    fail(`the sign fields control declares shape "${signPlacement.shape}"`, signPlacement);
  }
  if (signPlacement.kinds.length !== 1 || signPlacement.kinds[0] !== 'signature') {
    fail(`the sign canvas declares the kinds [${signPlacement.kinds.join(', ')}]; the schema has one`, signPlacement);
  }
  if (signPlacement.renderTool !== placement.renderTool) {
    fail('the sign canvas renders its pages with a different tool, so one canvas no longer serves all three shapes');
  }
  step(
    'the control, third shape',
    `sign.fields is the same canvas with shape "${signPlacement.shape}": renders with ${signPlacement.renderTool} at ${signPlacement.dpi} dpi, kinds ${signPlacement.kinds.join('/')}, and it is the one placement the JSON editor used to be the only way to fill`,
  );

  // Two drags, one box apart, expressed the two ways the canvas can express a box. The millimetre entry is built the
  // way the row's unit selector builds it — `units` switched, then moved — so the conversion under test is the shipped
  // one and not a re-derivation here.
  const signDrag = { left: 80, top: 700, width: 240, height: 40 };
  const ptBox = boxFromDisplay(signDrag, geometry);
  const mmBox: Box = { ...ptBox, x: ptBox.x + 260 };
  const ptEntry = createSignature(page, ptBox);
  const mmEntry = moveSignature(
    { kind: 'signature', page, entry: { page, x: 0, y: 0, w: 1, h: 1, units: 'mm' } },
    mmBox,
  );
  if (mmEntry.entry.units !== 'mm') fail('the canvas did not keep the entry in millimetres', mmEntry.entry);
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    const written = unitToPoints(mmEntry.entry[key] as number, 'mm');
    const asked = key === 'w' ? mmBox.width : key === 'h' ? mmBox.height : mmBox[key];
    if (Math.abs(written - asked) > 0.05) {
      fail(
        `the canvas wrote ${mmEntry.entry[key]} mm for ${key}, which is ${round(written)} pt where the drag asked for ${round(asked)} pt`,
        mmEntry.entry,
      );
    }
  }
  if (ptEntry.entry.units !== 'pt') fail('a new signature is not written in points', ptEntry.entry);

  const inkPath = join(REPO_ROOT, 'fixtures', 'generated', 'signature-ink.png');
  const ink = await upload(inkPath, 'image/png');
  const signJob = await json<JobView>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      tool: 'sign',
      // The image is named by the option, not listed as a document: `files` is the user's document list, and the API
      // resolves `auxiliaryFiles` declarations out of the options (`job-service.ts`). Passing it in both places is
      // how this leg first failed — "Sign PDF takes between 1 and 1 files".
      files: [document.id],
      options: {
        kind: 'image',
        imageFileId: ink.id,
        // One entry per unit, in one job and one render, so the pair is measured under identical conditions.
        fields: [ptEntry.entry, mmEntry.entry],
        // The date line and the signer's name are text, and text would be ink of its own inside the box: turned off so
        // every dark pixel counted below came from the bitmap and its placement.
        showDateStamp: false,
        showSignerName: false,
      },
    }),
    headers: { 'content-type': 'application/json' },
  });
  const finishedSign = await waitForJob(signJob.id);
  if (finishedSign.status !== 'COMPLETED') fail(`sign ended ${finishedSign.status}`, finishedSign.error);
  const signedBytes = await download(signJob.id, 0);

  const beforeSign = await renderPageGray(fixtureBytes, page);
  const afterSign = await renderPageGray(signedBytes, page);
  if (!beforeSign || !afterSign) fail('no renderer is reachable, so the signature placement cannot be measured');

  const boxOf = (box: Box) => `1,${round(box.x)},${round(box.y)},${round(box.width)},${round(box.height)}`;
  // Where an unflipped conversion of the same drag would have put the box: the mirror about the page's mid-height.
  const mirrorOf = (box: Box) =>
    `1,${round(box.x)},${round(geometryPage.heightPt - box.y - box.height)},${round(box.width)},${round(box.height)}`;

  const ptInk = delta(beforeSign, afterSign, boxOf(ptBox));
  const mmInk = delta(beforeSign, afterSign, boxOf(mmBox));
  const ptMirror = delta(beforeSign, afterSign, mirrorOf(ptBox));
  const mmMirror = delta(beforeSign, afterSign, mirrorOf(mmBox));

  // The threshold is `edit-pdf`'s, and it is deliberately not tuned per shape: 40 dark pixels is a mark, and a mark is
  // what both the typed and the drawn signature put inside their box.
  if (ptInk.added < minInk) {
    fail(
      `the signature is not in the box the canvas wrote for it: ${ptInk.added} new dark pixel(s) in ${boxOf(ptBox)}`,
      {
        drag: signDrag,
        box: ptBox,
        entry: ptEntry.entry,
      },
    );
  }
  if (mmInk.added < minInk) {
    fail(
      `the millimetre entry did not ink the page where its points twin did: ${mmInk.added} new dark pixel(s) in ${boxOf(mmBox)} — a skipped conversion puts it 2.83× further out, and a doubled one brings it back to the origin`,
      { box: mmBox, entry: mmEntry.entry },
    );
  }
  if (ptMirror.added > 1 || mmMirror.added > 1) {
    fail(
      `the vertical flip is inverted for sign: ${ptMirror.added} new dark pixel(s) at the points mirror and ${mmMirror.added} at the millimetre one`,
    );
  }
  step(
    'the two units are one box',
    `the points entry (${round(ptBox.x)}, ${round(ptBox.y)} pt) and the millimetre one written from the same drag (${mmEntry.entry.x} × ${mmEntry.entry.y} mm) each inked their own box — ${ptInk.added} and ${mmInk.added} new dark pixel(s) — with ${ptMirror.added} / ${mmMirror.added} at the vertical mirrors`,
  );

  measurements.sign = {
    drag: signDrag,
    points: { box: ptBox, entry: ptEntry.entry, ink: ptInk.added, mirror: ptMirror.added },
    millimetres: { box: mmBox, entry: mmEntry.entry, ink: mmInk.added, mirror: mmMirror.added },
  };

  // ── 7. The fourth shape: `redact` — the drawn box removes its token and leaves the one outside it ─────────────
  // The other three shapes can be read as ink or as a dictionary. A redaction can only be read as **absence paired
  // with presence**: the box is right if the token under it is gone *and* the token it was not aimed at is still
  // there. Either half alone passes for a job that did nothing (the removal is vacuous) or for a job that over-removed
  // (the whole page went), which is why both are asserted.
  const redactTool = catalog.tools.find((entry) => entry.id === 'redact');
  if (!redactTool) fail('the catalog does not list redact');
  const regionsField = redactTool.optionsUi.find((entry) => entry.key === 'regions');
  if (!regionsField) fail('redact has no regions option in its optionsUi');
  if (regionsField.control !== 'placement') {
    fail(
      `redact's regions control is "${regionsField.control}", so redaction boxes are still typed as JSON rather than drawn`,
      regionsField,
    );
  }
  const redactPlacement = regionsField.placement;
  if (!redactPlacement) fail('the regions control carries no placement metadata');
  if (redactPlacement.shape !== 'redactions') {
    fail(`the regions control declares shape "${redactPlacement.shape}"`, redactPlacement);
  }
  if (redactPlacement.renderTool !== placement.renderTool) {
    fail('the redact canvas renders its pages with a different tool, so one canvas no longer serves all four shapes');
  }
  if (redactPlacement.kinds.length !== 1 || redactPlacement.kinds[0] !== 'box') {
    fail(
      `the redact toolbar declares the kinds [${redactPlacement.kinds.join(', ')}]; the schema has one`,
      redactPlacement,
    );
  }
  step(
    'the control, fourth shape',
    `redact.regions is the same canvas with shape "${redactPlacement.shape}": renders with ${redactPlacement.renderTool} at ${redactPlacement.dpi} dpi, kinds ${redactPlacement.kinds.join('/')} — the tool whose whole product is an absence`,
  );

  // A document of the stage's own making, because a redaction needs *known* text under a known box: the fixture's own
  // numbers place both tokens, so the box below is derived from the file rather than from a measurement of it.
  const TOKEN_REMOVE = 'REDACT9X7';
  const TOKEN_KEEP = 'KEEP9X7';
  // Drawn at the top of the page by the writer on every page, so it is outside every box this stage draws — and it
  // carries an em dash, which is the whole point: a run the font cannot spell is written back as a `<hex>` string, so
  // this is the one string here that proves the reader reads that spelling too.
  const REDACT_LABEL = 'placement redact fixture — page 1 of 1';
  const REDACT_TEXT_SIZE = 24;
  const redactFixture = buildPdf({
    label: 'placement redact fixture',
    pages: 1,
    texts: [
      { text: TOKEN_REMOVE, x: 72, y: 660, size: REDACT_TEXT_SIZE },
      { text: TOKEN_KEEP, x: 72, y: 560, size: REDACT_TEXT_SIZE },
    ],
  });
  // The reader that will decide the claim is checked on the *input* first: a token search that cannot find the token
  // in the file it was just written into proves nothing about the file that comes back. The label is checked beside
  // it for the same reason — it is text both files carry, so a reader that cannot see it in the input cannot be
  // trusted with its absence in the output.
  const inputSearch = searchableBytes(redactFixture);
  if (!inputSearch.includes(TOKEN_REMOVE)) {
    fail('the fixture is wrong: the token the box is aimed at is not readable in the input');
  }
  if (!inputSearch.includes(REDACT_LABEL)) {
    fail('the fixture is wrong: the page label the output is read for is not readable in the input');
  }
  const redactDocument = await uploadBytes(redactFixture, 'placement-redact.pdf');
  // A generous band over the first token (x 64–324, y 652–692 for glyphs starting at 72/660), and 60 pt away from the
  // second one at y=560 — so a box that landed on the wrong half or the wrong page could not remove the wrong token
  // and still satisfy both halves of the reading.
  const removeBox: Box = { x: 64, y: 652, width: 260, height: 40 };
  const redaction = createRedaction(page, removeBox);

  const redactJob = await json<JobView>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ tool: 'redact', files: [redactDocument.id], options: { regions: [redaction.entry] } }),
    headers: { 'content-type': 'application/json' },
  });
  const finishedRedact = await waitForJob(redactJob.id);
  if (finishedRedact.status !== 'COMPLETED') fail(`redact ended ${finishedRedact.status}`, finishedRedact.error);
  const redactedBytes = await download(finishedRedact.id, 0);

  // The job record reports status; the measurements are on `/result` — the handler's own reading of what it removed,
  // which is the second opinion beside the byte search below.
  const redactResult = await json<{ metrics: Record<string, unknown> }>(`/api/v1/jobs/${finishedRedact.id}/result`);
  const redactMetrics = redactResult.metrics ?? {};
  const regionsWithText = Number(redactMetrics.regionsWithText ?? 0);
  if (regionsWithText < 1) {
    fail(
      'the drawn box sat over no text at all, so whatever the job removed was not this box’s doing — the box is not where the fixture wrote the token',
      { box: removeBox, metrics: redactMetrics },
    );
  }
  const removedSearch = searchableBytes(redactedBytes);
  if (removedSearch.includes(TOKEN_REMOVE)) {
    fail(
      'the token under the drawn box is still in the output, so the box the canvas wrote is not the box the engine removed',
      {
        box: removeBox,
        entry: redaction.entry,
      },
    );
  }
  // The presence control, read *after* the removal and in the form the rewriter left it in: the label is outside every
  // box, so either the file lost text it should have kept or this reader is blind to the hex spelling — and a reader
  // that cannot see a string the file still has cannot be trusted with the absence asserted above.
  if (!removedSearch.includes(REDACT_LABEL)) {
    fail(
      'the page label is not readable in the output, so the absence above is being asserted by a reader that cannot see text the file still has',
      { label: REDACT_LABEL },
    );
  }
  if (!removedSearch.includes(TOKEN_KEEP)) {
    fail(
      'the control token outside the box is gone too, so this reading proves nothing about placement — the output is missing text the box never covered',
      { box: removeBox, controlToken: TOKEN_KEEP },
    );
  }
  const removedTokens = Number(redactMetrics.textRemoved ?? 0);
  if (removedTokens < 1) fail(`the job reports textRemoved: ${removedTokens}`, redactMetrics);
  step(
    'a drawn box removes what is under it, and only that',
    `"${TOKEN_REMOVE}" is gone from the output and "${TOKEN_KEEP}" 100 pt below it is still readable; the job itself reports regionsWithText ${regionsWithText} and textRemoved ${removedTokens}`,
  );

  measurements.redaction = {
    box: removeBox,
    entry: redaction.entry,
    removedToken: TOKEN_REMOVE,
    controlToken: TOKEN_KEEP,
    regionsWithText,
    textRemoved: removedTokens,
    bytes: redactedBytes.length,
  };

  await mkdir(join(REPO_ROOT, 'e2e', 'artifacts'), { recursive: true });
  await writeFile(
    join(REPO_ROOT, args.jsonPath),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base: args.base,
        control: { tool: 'edit-pdf', key: 'elements', ...placement },
        annotationControl: { tool: 'annotate', key: 'annotations', ...annotationPlacement },
        signatureControl: { tool: 'sign', key: 'fields', ...signPlacement },
        redactionControl: { tool: 'redact', key: 'regions', ...redactPlacement },
        fixture: 'fixtures/generated/pages-six-a4.pdf',
        checks,
        measurements,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nplacement passed — ${checks.length} check(s) against ${args.base}`);
  console.log(`Measurements: ${args.jsonPath}`);
}

main().catch((cause: unknown) => {
  console.error('\n✗ the stage threw', cause);
  process.exit(1);
});
