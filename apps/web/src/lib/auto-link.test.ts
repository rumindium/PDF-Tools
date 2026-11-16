import { describe, expect, test } from 'bun:test';
import { hasSuppressionCookie, relinkRequested, withRelinkParam } from './auto-link';

/**
 * The sign-out memory and the marker that clears it (`docs/0-TENANT-FIRST.md` §5.4).
 *
 * Both are string parsing, and both fail in a way nobody notices: a cookie value read wrongly makes the sign-out
 * button look broken once and then work, and a `relink` marker that does not survive the round trip means a person who
 * pressed Sign in is asked to sign in again. Hence the cases below, including the ones that only differ in a prefix.
 */

describe('hasSuppressionCookie', () => {
  test('finds the flag among the other cookies the app sets', () => {
    expect(hasSuppressionCookie('pdft_session=abc; pdft_no_autolink=1; theme=dark')).toBe(true);
    expect(hasSuppressionCookie('pdft_no_autolink=1')).toBe(true);
  });

  test('a cleared value is not the flag', () => {
    // `allowAutoLink` expires the cookie, but a browser that has not applied the expiry yet can still send the name
    // with an empty value — and reading that as "suppressed" would make a sign-in look like it did nothing.
    expect(hasSuppressionCookie('pdft_no_autolink=')).toBe(false);
    expect(hasSuppressionCookie('pdft_no_autolink=0')).toBe(false);
  });

  test('no cookie at all, and a merely similar name', () => {
    expect(hasSuppressionCookie('')).toBe(false);
    expect(hasSuppressionCookie('pdft_session=abc')).toBe(false);
    expect(hasSuppressionCookie('pdft_no_autolink_disabled=1')).toBe(false);
  });
});

describe('relinkRequested', () => {
  test('accepts the marker the app writes and nothing else', () => {
    expect(relinkRequested('?relink=1')).toBe(true);
    expect(relinkRequested('?next=/tools/merge&relink=1')).toBe(true);
    for (const search of ['', '?relink=0', '?relink=true', '?next=/tools/merge']) {
      expect(relinkRequested(search)).toBe(false);
    }
  });
});

describe('withRelinkParam', () => {
  test('adds the marker to a real address, keeping what was there', () => {
    expect(withRelinkParam('http://localhost:5180/tools/merge')).toBe('http://localhost:5180/tools/merge?relink=1');
    expect(withRelinkParam('https://pdf.example.com/tools/merge?page=2')).toBe(
      'https://pdf.example.com/tools/merge?page=2&relink=1',
    );
  });

  test('an address that cannot be parsed is returned untouched', () => {
    // The alternative is `undefined` in a redirect parameter, which the platform would faithfully send the visitor to.
    expect(withRelinkParam('not a url')).toBe('not a url');
  });
});
