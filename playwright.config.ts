import { defineConfig, devices } from '@playwright/test';

/**
 * The browser stage (`0-CICD.md` §3.8).
 *
 * Every other stage in this repository talks to the API and reads bytes. This one drives the **web app** — the same
 * bundle a user loads — which is the only way a claim about the UI can fail: the upload form, the options panel, the
 * run button, the progress stream and the download link are one chain, and a stage that posts to `POST /jobs` itself
 * tests the half of it that was never in doubt.
 *
 * Three decisions worth stating:
 *
 * 1. **The files are named `*.e2e.ts`, and that is not cosmetic.** `bun test` auto-discovers `*.spec.ts` and
 *    `*.test.ts`, so a Playwright spec named the usual way would be collected by the unit runner and executed without
 *    a browser (or worse, half-executed). The runner's own `testMatch` is the `.e2e.ts` suffix this repository already
 *    uses for its harnesses (`e2e/merge.e2e.ts`, `e2e/tool.e2e.ts`), and the unit runner ignores it.
 * 2. **`baseURL` is the web container, not the API.** The SPA is served by nginx with `/api` proxied from the same
 *    origin (`infra/nginx/default.conf.template`), so pointing the browser at :5180 exercises the proxy path too —
 *    including the streaming upload that a buffering proxy is the classic way to break.
 * 3. **The browser is the bundled Chromium by default, and the installed Chrome where asked.** A machine that has
 *    Chrome (`PLAYWRIGHT_CHANNEL=chrome`) skips a ~150 MB download; CI installs the bundled build and leaves the
 *    variable unset. Both paths run the same file, and neither is a different browser *engine*, so the stage's claims
 *    do not change with the switch.
 * 4. **The viewport is declared here and named in the project** (`STAGE_VIEWPORT`), because a project's `use` overrides
 *    the file's and every device descriptor carries a viewport of its own — the one line in this file that could be
 *    present, plausible and completely unread (defect 255), checked by the pre-flight.
 *
 * One worker, no retries: these cases share one dev stack and one anonymous session per page, so parallelism would
 * buy seconds and cost the ability to read a failure.
 */
/**
 * The origin the browser drives.
 *
 * Exported because the stage's pre-flight (`e2e/browser/global-setup.ts`) has to probe the **same** origin: a second
 * default spelled in a second file is exactly how a stack gets checked at one address and driven at another.
 */
export const WEB_URL = process.env.PDFTOOLS_WEB_URL ?? 'http://localhost:5180';

/**
 * The viewport every case runs at, and the stage's own **declaration** of it rather than a default it inherits.
 *
 * It is named, exported and repeated in the project below because a project's `use` **overrides** the file's `use` — so
 * a `viewport` written only in the top-level `use` is not a default at all, it is a line the stage never reads. That is
 * how this stage ran twelve files at `devices['Desktop Chrome']`'s **1280 × 720** while the config, `0-CICD.md` and two
 * cases' own "restore the default" calls all said 1440 × 900 (defect 255): the declaration was there, the size was not.
 * The pre-flight checks the resolved value (`e2e/browser/global-setup.ts`), so the mistake fails once by name instead of
 * as a case that cannot reach the element it measures.
 */
export const STAGE_VIEWPORT = { width: 1440, height: 900 };

export default defineConfig({
  testDir: 'e2e/browser',
  testMatch: /.*\.e2e\.ts$/,
  //
  // `strict-gate.e2e.ts` is not one of this stage's cases, and collecting it was a way for the stage to be red on a
  // stack that is working: it asserts that a visitor is walked to the sign-in page, which is a claim about a stack
  // that publishes nothing, and this config is pointed at the ordinary one (anonymous use on) where that visitor
  // simply gets the app. The file's own header says which config it belongs to; the pre-flight above and this line are
  // what hold the two positions apart — `bun run test:browser` for the cases that drive the upload form,
  // `--config playwright.strict.config.ts` for the gate, and neither able to skip the other's work.
  //
  testIgnore: /strict-gate\.e2e\.ts$/,
  // One pre-flight for the whole stage: a stack that requires an account refuses the dropzone every case drives, so
  // the stage stops once with a named gap instead of failing five files with five screenshots of the same gate. The
  // file is deliberately `global-setup.ts` rather than `*.e2e.ts`, which is what keeps the `testMatch` above from
  // collecting it as a case.
  globalSetup: 'e2e/browser/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A upload + a job + a download on a cold stack is a few seconds; the ceiling is for a job that is queued behind
  // another pool's work, not for the browser.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    // The artifact the docs quote, in the same `e2e/artifacts` directory as every other stage's.
    ['json', { outputFile: 'e2e/artifacts/browser.json' }],
  ],
  use: {
    baseURL: WEB_URL,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The heavy pool runs two jobs at a time in this compose file, and a case may queue behind a rendered preview.
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  //
  // The viewport is spelled out **next to the device it is applied to**, and the second half of this line is the whole
  // reason: `devices['Desktop Chrome']` carries a 1280 × 720 of its own, and a project's `use` overrides the file's, so
  // spreading the descriptor and stopping there is not "using the browser's shape" — it is replacing `STAGE_VIEWPORT`
  // with the descriptor's without a word (defect 255). A case that needs a different window narrows it itself, which is
  // what `edit-pdf` and `reorder-pages` already do around their 380 px and 1000 px readings.
  //
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: STAGE_VIEWPORT } }],
});
