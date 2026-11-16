/**
 * Noticing that the tab is running an **older build** than the one being served (`docs/0-CICD.md` §3.8).
 *
 * A rebuilt bundle is picked up by a *reload* and by nothing else: `index.html` is `no-store` and the assets are
 * content-hashed, so a browser that asks again gets the new screen — but a tab that is already open, and a user who
 * navigates with the in-app links, keeps the stylesheet and the route chunks it loaded. That is not a theoretical gap:
 * `reorder-pages`' two cards were stacked and measured as one grid column in the served CSS, and were reported as still
 * side by side from a tab that predated the rebuild (defect 236). The fix cannot be "tell the user to hard-reload",
 * because nothing on the screen says a reload is what is needed.
 *
 * So the bundle checks the build it was built as (`__BUILD_ID__`, injected by `vite.config.ts`) against the one the
 * served `index.html` carries, and reloads itself when they differ. Both ids come from the same build, so the check is a
 * string comparison rather than a version negotiation — and it never talks to the API, so it cannot be broken by the
 * API being down.
 *
 * ## The three refusals, which is most of the design
 *
 *  1. **No id served at all means no reload.** A proxy that answers with an error page, an offline browser, a
 *     `text/plain` fallback — none of them is evidence of a new build, and reloading on a guess is how a page ends up in
 *     a refresh loop while the network is down.
 *  2. **The same id means no reload.** The ordinary case, and the one that must stay free of side effects.
 *  3. **A difference *and* a check within the last `BUILD_CHECK_INTERVAL_MS` means no reload.** This is the loop guard,
 *     and it is the reason the check is not simply "reload when different": a server that serves an older `index.html`
 *     than the bundle it references (a half-finished deploy, a proxy cache, a CDN lagging a second behind) would
 *     otherwise reload forever, and a browser that reloads forever is worse than one showing a stale column.
 */

/** The id this bundle was compiled with — `vite.config.ts` defines it, and it is injected into `index.html` too. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown';

/**
 * How long after a check the page will not check again.
 *
 * Long enough that the loop guard has teeth (a reload takes far less than five minutes) and short enough that a tab left
 * open over a deploy notices it on the next time it is looked at. The check itself is fired when the tab becomes
 * visible or is focused, never on a timer, so a background tab costs nothing.
 */
export const BUILD_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Where the last check is remembered. `sessionStorage` because it belongs to the tab being reloaded, not to the site. */
export const BUILD_CHECK_KEY = 'pdftools.build-check';

/**
 * Whether a served `index.html` means this tab should reload — the rule, without the browser around it.
 *
 * `lastCheckAt` is `null` for the first check of a tab, and `now` is passed in rather than read so the rule can be
 * tested at any time it likes.
 */
export function shouldReload(running: string, served: string | null, lastCheckAt: number | null, now: number): boolean {
  if (served == null || served === '') return false;
  if (served === running) return false;
  if (lastCheckAt != null && now - lastCheckAt < BUILD_CHECK_INTERVAL_MS) return false;
  return true;
}

/** The build id inside a served `index.html`, or `null` when the page carries none. */
export function buildIdFromHtml(html: string): string | null {
  return /<meta\s+name="build-id"\s+content="([^"]*)"/.exec(html)?.[1] ?? null;
}
