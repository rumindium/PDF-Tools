import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The control the HTML tool's silence has been resting on, measured in a real browser (`0-CICD.md` §3.4, §3.8).
 *
 * `bun run test:isolation` leg 5 asserts something about a **document**: the fixture whose `<script>` requests a
 * beacon converts successfully, and no request ever arrives at the loopback listener in the worker. That claim has a
 * premise, and until this case existed nothing checked it — the fixture's script had never been *shown* to run
 * anywhere. A script with a typo, a beacon URL the engine would never resolve, or a `<script>` tag the parser drops
 * would all produce exactly the silence leg 5 reports, and a silence that means "the script is broken" is not the
 * same fact as a silence that means "the engine has no JavaScript runtime". This stage has that shape of defect in
 * its own history: the isolation harness once asked a question of a profile LibreOffice had never initialised, got
 * "no", and wrote down a property it had not measured (`0-IMPLEMENTATION-STATUS.md` §5, defect 98).
 *
 * So this case runs the **same bytes** through a runtime that certainly executes them. The fixture is served from
 * this process on the port its own script names, the page is loaded in the browser, and the beacon must arrive —
 * that is the whole of the first half, and it is what makes leg 5's silence a measurement about an engine rather
 * than about a file.
 *
 * The second half is the tripwire for the plan's engine swap. `html-to-pdf` ships on LibreOffice's HTML import, which
 * has no JavaScript engine at all, and the plan for this tool once named a Chromium print pipeline — which does have
 * one. The claim "a script in a document does not run" is therefore a claim about the **engine**, and this case
 * asserts which engine converted the document. If that changes, this case fails and names the reason, because the
 * isolation leg's silence would afterwards depend on a flag (`setJavaScriptEnabled(false)` or equivalent) that
 * somebody has to remember to set, not on the engine's nature.
 *
 * What this case deliberately does not assert: that the *product's* conversion produced no beacon. The listener here
 * is on the host, and the worker's `127.0.0.1` is its own container — a runtime inside the pool cannot reach this
 * listener even if it runs, so an assertion made from here would pass for the wrong reason. That measurement belongs
 * where the runtime would be, which is what the isolation stage's in-container probe is for.
 */

const FIXTURES = join(process.cwd(), 'fixtures', 'generated');
/** The document `test:isolation` leg 5 hands to the engine, byte for byte. */
const SCRIPT_FIXTURE = join(FIXTURES, 'html-to-pdf-script.html');
/** The port the fixture's own script requests, and therefore the port this control has to answer on. */
const BEACON_PORT = 9913;
/** What the fixture's script asks for. Recorded, never served — the arrival is the assertion. */
const BEACON_PATH = '/script-executed.png';
/** A real 1×1 PNG, so the browser's image load succeeds and the request is a completed fetch rather than an error. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('the fixture whose script must not run', () => {
  test('its script really runs in a browser, and the engine that converts it is the one with no JS runtime', async ({
    page,
    request,
  }) => {
    const hits: string[] = [];
    const server = createServer((incoming, response) => {
      const path = (incoming.url ?? '/').split('?')[0] ?? '/';
      if (path !== '/fixture.html') {
        hits.push(path);
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(ONE_PIXEL_PNG);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(SCRIPT_FIXTURE));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: Error) => {
        reject(
          new Error(
            `the control needs 127.0.0.1:${BEACON_PORT} free on this machine: that is the port the fixture's own script requests, so it is not a port this case gets to pick (${error.message})`,
          ),
        );
      });
      server.listen(BEACON_PORT, '127.0.0.1', resolve);
    });

    try {
      // ── The control: a browser executes this document's script ──────────────────────────────────────────────
      await page.goto(`http://127.0.0.1:${BEACON_PORT}/fixture.html`);
      await expect(page.getByRole('heading', { name: 'HTML SCRIPT FIXTURE MARKER' })).toBeVisible();
      // The callback is the assertion, not the beacon's timing: the listener is this process, so a page that never
      // ran its script leaves the array empty and the case times out with that fact in the failure.
      await expect.poll(() => hits, { timeout: 15_000 }).toContain(BEACON_PATH);
      // The same script's second observable, and the one that survives a blocked image: it renames the document.
      await expect(page).toHaveTitle('SCRIPT EXECUTED');

      // ── The tripwire: which engine runs this tool ──────────────────────────────────────────────────────────
      await request.get('/api/v1/me');
      const uploaded = await request.post('/api/v1/files', {
        multipart: {
          file: {
            name: 'html-to-pdf-script.html',
            mimeType: 'text/html',
            buffer: readFileSync(SCRIPT_FIXTURE),
          },
        },
      });
      expect(uploaded.status()).toBe(201);
      const fileId = ((await uploaded.json()) as { id: string }).id;

      const created = await request.post('/api/v1/jobs', {
        data: { tool: 'html-to-pdf', files: [fileId], options: { pageSize: 'a4' } },
      });
      expect(created.ok()).toBeTruthy();
      const jobId = ((await created.json()) as { id: string }).id;

      let view: { status: string; engine?: { name: string } | null; output?: { bytes: number } | null } = {
        status: 'PENDING',
      };
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        view = (await (await request.get(`/api/v1/jobs/${jobId}`)).json()) as typeof view;
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(view.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // The document carrying the script is ordinary HTML: it must convert, which is the half of leg 5 that says the
      // guard did not simply refuse the file.
      expect(view.status).toBe('COMPLETED');
      // A document came back rather than an error or an empty result. The *page count* is deliberately not asserted
      // here: `html-to-pdf` reports geometry rather than a page count in its metrics, and the isolation stage reads
      // the produced PDF's own page box for exactly that reason.
      expect(view.output?.bytes ?? 0).toBeGreaterThan(0);
      // And the engine is named rather than assumed. A Chromium-backed pipeline would fail here first, which is the
      // point: the silence in the isolation stage is a property of *this* engine, and a swap has to be a decision.
      expect(view.engine?.name).toBe('libreoffice');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
