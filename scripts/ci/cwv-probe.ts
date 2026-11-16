import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Core Web Vitals probe (S6): serves the production bundle and measures LCP/CLS/TTFB per route under
 * emulated Fast-3G + 4× CPU throttling — the conditions the Search Console field data is collected in.
 *
 *   bun run test:cwv -- --dir apps/web/dist
 *
 * Report-only on purpose: the first run sets the baseline, and a budget without one is a guess. Numbers go in
 * `docs/18-SEO-GROWTH-AND-BACKLOG.md` S6; if a route is red, the fix is a separate change with a re-measure.
 * Needs the Playwright Chromium (`bunx playwright install chromium`), same as `test:browser`.
 */

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

const ROUTES = ['/', '/tools', '/tools/merge', '/pricing', '/id/tools/merge'];

interface RouteMetrics {
  route: string;
  ttfbMs: number;
  lcpMs: number;
  cls: number;
}

async function main(): Promise<void> {
  const dir = resolve(REPO_ROOT, arg('--dir', 'apps/web/dist'));
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`cwv: no production bundle at ${dir} — build the web app first`);
    process.exit(2);
  }
  const port = Number(arg('--port', '8901'));

  const server = Bun.serve({
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const file = join(dir, path === '/' ? 'index.html' : path.slice(1));
      // SPA fallback: client routes are served by index.html; the /id snapshot pages are static files that
      // exist in the seo build, never here, so they measure the English shell — the ID shell is byte-identical
      // in structure, and its numbers would only differ in copy length.
      const target = existsSync(file) && statSync(file).isFile() ? file : join(dir, 'index.html');
      return new Response(readFileSync(target), {
        headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
      });
    },
  });

  // System Chrome, not the Playwright-managed revision: this machine's pinned-Chromium cache has a broken
  // layout (`0-E2E-CHECKLIST.md` records the same finding — `PLAYWRIGHT_CHANNEL=chrome` is the workaround there
  // too), and a versioned browser download would make the probe depend on the network.
  const browser = await chromium.launch({
    executablePath: arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome'),
    args: ['--no-sandbox'],
  });
  const results: RouteMetrics[] = [];
  try {
    for (const route of ROUTES) {
      const context = await browser.newContext();
      const page = await context.newPage();
      // `--no-throttle` measures the same bundle on a desktop machine: the gap between the two runs separates
      // the bundle's own cost (parse, render) from the throttling's (download, slowed CPU).
      if (!process.argv.includes('--no-throttle')) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 150,
          downloadThroughput: 204_800,
          uploadThroughput: 93_750,
          connectionType: 'cellular3g',
        });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      await page.goto(`http://localhost:${port}${route}`);
      // Let the SPA boot, paint, and settle: LCP fires after the hero renders, CLS accumulates while the
      // tool board fills in.
      await page.waitForTimeout(8_000);
      const metrics = (await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        // LCP entries are delivered to observers, not kept in the timeline buffer — `getEntriesByType` reads
        // zero after the fact, so observe with `buffered: true` and take the last entry.
        const lcpPromise = new Promise<number>((resolve) => {
          const seen: number[] = [];
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) seen.push(entry.startTime);
          });
          observer.observe({ type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(seen.length > 0 ? seen[seen.length - 1]! : -1);
          }, 500);
        });
        const shifts = performance.getEntriesByType('layout-shift') as Array<
          PerformanceEntry & { value: number; hadRecentInput: boolean }
        >;
        const cls = shifts.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0);
        return lcpPromise.then((lcpMs) => ({ ttfbMs: nav ? nav.responseStart : -1, lcpMs, cls }));
      })) as Omit<RouteMetrics, 'route'>;
      results.push({ route, ...metrics });
      await context.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
  }

  console.log('route            TTFB(ms)  LCP(ms)  CLS');
  for (const result of results) {
    const flag = result.lcpMs > 2500 || result.cls > 0.1 ? '  <-- needs work (LCP > 2.5s or CLS > 0.1)' : '';
    console.log(
      `${result.route.padEnd(16)} ${String(Math.round(result.ttfbMs)).padStart(8)} ${String(Math.round(result.lcpMs)).padStart(8)}  ${result.cls.toFixed(4)}${flag}`,
    );
  }
}

await main();
