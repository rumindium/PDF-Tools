import { describe, expect, test } from 'bun:test';
import { tripTaken } from './bounce';

/**
 * The loop guard's one rule, asserted as the rule rather than through a browser (`docs/0-TENANT-FIRST.md` §5.5).
 *
 * The storage half is a thin read/write around this function, and the interesting cases are the ones a browser
 * cannot produce on demand: an absent value (a first visit), a value written by an older build, and a value that is
 * something other than the marker — all of which must mean "no trip taken", because the cost of getting that wrong is
 * a visitor who can never be redirected at all, and the cost of the other direction is a loop.
 */
describe('tripTaken', () => {
  test('only the marker counts as a trip', () => {
    expect(tripTaken('1')).toBe(true);
    for (const raw of [null, '', '0', 'true', ' 1']) {
      expect(tripTaken(raw)).toBe(false);
    }
  });
});
