import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './playwright.config';

/**
 * The browser stage for a stack that serves **nobody** — one case, and no anonymous pre-flight.
 *
 * `playwright.config.ts` is pointed at the ordinary stack, where every case drives the upload form and the pre-flight
 * stops once with a named gap if the installation requires an account. This config exists for the opposite position:
 * strict mode on, where the page a visitor gets is the thing under test, so a pre-flight demanding an anonymous
 * session would stop the one case that can run.
 *
 * Two decisions, both about not weakening the ordinary stage:
 *
 * 1. **A separate file rather than a flag on the standard one.** A `--grep` or an environment variable read inside
 *    `global-setup.ts` would make the browser stage's pre-flight conditional, and a pre-flight with a branch is a
 *    pre-flight that can be argued out of stopping — which is the only thing it is for. Here the two positions have
 *    two entry points and neither can be talked into the other's behaviour.
 * 2. **`testMatch` narrowed to the one file that belongs here.** Running this config runs `strict-gate.e2e.ts` and
 *    nothing else, so it cannot be used to skip the cases that need an account — those five are simply not collected.
 *
 * What it keeps from the standard config on purpose: the **web origin** (`WEB_URL`, nginx, `/api` proxied) rather than
 * the API port, because the gate is rendered from a call the SPA makes through that proxy, and one worker with no
 * retries, because there is one stack to read a failure from.
 *
 *   bunx playwright test --config playwright.strict.config.ts      (needs the strict profile up)
 */
export default defineConfig({
  testDir: 'e2e/browser',
  testMatch: /strict-gate\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['json', { outputFile: 'e2e/artifacts/browser-strict.json' }]],
  use: {
    baseURL: WEB_URL,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
