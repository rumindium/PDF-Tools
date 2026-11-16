import { BUILD_CHECK_INTERVAL_MS, BUILD_CHECK_KEY, BUILD_ID, buildIdFromHtml, shouldReload } from './build-id';

/**
 * The browser half of the stale-bundle check: fetch the served `index.html`, compare its build id, reload if it differs
 * (`./build-id.ts` has the rule and the three refusals; this file is the plumbing).
 *
 * It runs **at boot and when the tab is looked at again**, never on a timer: a background tab costs nothing, and the
 * moment a user is actually looking at a stale column is the moment the tab becomes visible. The fetch is `no-store`
 * against the same origin, so it is one small request and it never touches the API — a check that could fail because the
 * API is down would be a check that reloads a working page for the wrong reason.
 */

function lastCheckAt(): number | null {
  try {
    const raw = sessionStorage.getItem(BUILD_CHECK_KEY);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // A browser with storage disabled (private mode, a blocked cookie jar) cannot remember its last check, so the guard
    // degrades to "check every time the tab is looked at" — which is the safe direction: the reload itself is still
    // gated on an id that really differs.
    return null;
  }
}

function rememberCheck(now: number): void {
  try {
    sessionStorage.setItem(BUILD_CHECK_KEY, String(now));
  } catch {
    // Ignored on purpose: see above.
  }
}

/** The served `index.html`'s build id, or `null` when it cannot be read — which the rule treats as "do not reload". */
async function servedBuildId(): Promise<string | null> {
  try {
    const response = await fetch('/index.html', { cache: 'no-store', headers: { accept: 'text/html' } });
    if (!response.ok) return null;
    return buildIdFromHtml(await response.text());
  } catch {
    return null;
  }
}

/**
 * Check once, and reload the tab if it is running an older build than the server.
 *
 * Returns whether a reload was started, which is what the browser case asserts against.
 */
export async function checkForNewBuild(now: number = Date.now()): Promise<boolean> {
  const previous = lastCheckAt();
  if (previous != null && now - previous < BUILD_CHECK_INTERVAL_MS) return false;
  // Marked *before* the decision, and that ordering is the loop guard's teeth: a reload must not be able to reset the
  // clock it is gated on.
  rememberCheck(now);
  const served = await servedBuildId();
  if (!shouldReload(BUILD_ID, served, previous, now)) return false;
  location.reload();
  return true;
}

/**
 * Start watching: publish the running id on the document, check once now, and check again whenever the tab is looked at.
 *
 * The id goes on `<html>`'s `data-build-id` rather than into a hidden element because it is a fact about the document
 * that a developer (and the browser case) should be able to read without a network round trip — and it makes "which
 * build is this tab on" answerable from DevTools, which is the question a stale tab raises.
 */
export function watchForNewBuild(): void {
  document.documentElement.dataset.buildId = BUILD_ID;
  void checkForNewBuild();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForNewBuild();
  });
  window.addEventListener('focus', () => {
    void checkForNewBuild();
  });
}
