import { describe, expect, test } from 'bun:test';
import { BUILD_CHECK_INTERVAL_MS, buildIdFromHtml, shouldReload } from './build-id';

/**
 * The stale-bundle rule (`docs/0-CICD.md` §9).
 *
 * The rule is three refusals and one reload, and every refusal is a case where reloading would be *wrong* rather than
 * merely unnecessary: no id served (an offline browser or an error page must not cause a refresh loop), the same id (the
 * ordinary case), and a difference inside the interval (the loop guard). The reload itself is the only case with a side
 * effect, which is why it is the only one that has to be *argued* for.
 */
describe('the stale-bundle rule', () => {
  const NOW = 1_700_000_000_000;

  test('a different id reloads — that is the whole point', () => {
    expect(shouldReload('build-a', 'build-b', null, NOW)).toBe(true);
    // …and on a tab whose last check was long enough ago, which is the same answer after a deploy.
    expect(shouldReload('build-a', 'build-b', NOW - BUILD_CHECK_INTERVAL_MS - 1, NOW)).toBe(true);
  });

  test('no id served means no reload, because a missing answer is not a new build', () => {
    // The three shapes a failed fetch takes: `null` (the request threw or was not ok), an empty string, and an HTML
    // page with no meta at all. A browser that reloads on any of them loops while the network is down.
    expect(shouldReload('build-a', null, null, NOW)).toBe(false);
    expect(shouldReload('build-a', '', null, NOW)).toBe(false);
    expect(buildIdFromHtml('<html><head></head></html>')).toBeNull();
  });

  test('the same id means no reload, at any interval', () => {
    expect(shouldReload('build-a', 'build-a', null, NOW)).toBe(false);
    expect(shouldReload('build-a', 'build-a', NOW, NOW)).toBe(false);
  });

  test('a difference inside the interval is refused — the loop guard', () => {
    // The case this exists for: a server serving an older `index.html` than the bundle it references (a half-finished
    // deploy, a proxy cache, a CDN a second behind). Reloading again cannot help, and a browser that reloads forever is
    // worse than one showing a stale column.
    expect(shouldReload('build-a', 'build-b', NOW, NOW)).toBe(false);
    expect(shouldReload('build-a', 'build-b', NOW - 1, NOW)).toBe(false);
    // One millisecond short of the interval is still inside it…
    expect(shouldReload('build-a', 'build-b', NOW - BUILD_CHECK_INTERVAL_MS + 1, NOW)).toBe(false);
    // …and exactly at the interval it is allowed again: the guard is a delay, not a one-shot. A tab left open over a
    // deploy has to reload the second time it is looked at, or the guard would have bought a permanent stale tab.
    expect(shouldReload('build-a', 'build-b', NOW - BUILD_CHECK_INTERVAL_MS, NOW)).toBe(true);
  });

  test('the id is read from the served page, and only from the meta the build writes', () => {
    expect(buildIdFromHtml('<head><meta name="build-id" content="m3k9" /></head>')).toBe('m3k9');
    expect(buildIdFromHtml('<meta  name="build-id"   content="x">')).toBe('x');
    // Not `content` of some other meta, and not a build id in a comment or a script: the id has to be the one the
    // *server* is serving, or the comparison is against the tab's own guess.
    expect(buildIdFromHtml('<meta name="description" content="build-id" />')).toBeNull();
    expect(buildIdFromHtml('<script>const buildId = "x"</script>')).toBeNull();
  });
});
