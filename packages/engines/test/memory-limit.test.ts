import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryLimitSupport, memoryLimitedCommand, run } from '../src/index';

/**
 * `limits.memoryMb` is in every catalog entry and is passed into `run()` by every handler, so the question these
 * tests answer is not whether the number is there — the registry test already asks that — but **what the number
 * does**. `docs/0-IMPLEMENTATION-STATUS.md` §6 states the finding this closes in its own words: the field was
 * declared, validated and read by no runner.
 *
 * Both halves are asserted, because they fail separately:
 *
 *  1. **the command line** — the engine, or `prlimit` in front of it carrying the tool's own budget in bytes. This
 *     half is portable, so it runs on every machine including the ones this repository is developed on.
 *  2. **the limit itself** — which only a Linux process can observe. `ulimit -v` inside the child is the
 *     measurement, and it is paired with a control that must **not** be capped: a ceiling that applied to
 *     everything would pass the first assertion while quietly removing the headroom an engine's own budget allows.
 */
const support = memoryLimitSupport();

/** Both `process.platform` and the wrapper, because `ulimit -v` in a child proves nothing without either. */
const observable = process.platform === 'linux' && support.enforced;

describe('the memory budget a tool declares', () => {
  test('with no budget the engine is spawned exactly as it always was', () => {
    expect(memoryLimitedCommand('qpdf', ['--version'], undefined, '/usr/bin/prlimit')).toEqual({
      command: 'qpdf',
      args: ['--version'],
      limited: false,
    });
  });

  test("with a budget the wrapper goes in front, and the ceiling is the tool's own number in bytes", () => {
    const limited = memoryLimitedCommand('gs', ['-sDEVICE=pdfwrite', '-o', 'out.pdf'], 2048, '/usr/bin/prlimit');
    expect(limited.command).toBe('/usr/bin/prlimit');
    // Every argument the engine was given survives, in order and untouched: the wrapper is a prefix, not a rewrite.
    expect(limited.args).toEqual(['--as=2147483648', '--', 'gs', '-sDEVICE=pdfwrite', '-o', 'out.pdf']);
    expect(limited.limited).toBe(true);
  });

  test('a zero budget means "no cap of its own", not "no address space"', () => {
    // `maxPages: 0` is the catalog's spelling of the same idea, and a wrapper that read `0` as an absolute ceiling
    // would fail every job of the tools that declare it.
    expect(memoryLimitedCommand('pdftotext', ['-'], 0, '/usr/bin/prlimit').limited).toBe(false);
  });

  test('the command line is unchanged where this environment has no prlimit', () => {
    // The honest path on a machine without util-linux, and the one `memoryLimitSupport()` reports rather than hides.
    expect(memoryLimitedCommand('qpdf', ['--check'], 1024, null)).toEqual({
      command: 'qpdf',
      args: ['--check'],
      limited: false,
    });
  });

  test('this environment says which of the two it is, in one sentence', () => {
    expect(support.enforced).toBe(process.platform === 'linux' && support.via != null);
    expect(support.reason).toContain(support.enforced ? 'applied' : 'not applied');
    if (support.enforced) expect(support.via?.endsWith('prlimit')).toBe(true);
  });

  test.skipIf(!observable)('the child really is capped, and the same call without a budget is not', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pdftools-memlimit-'));
    try {
      // The probe is `sh`, not an engine: `ulimit -v` reports what the child *inherited*, which is the claim being
      // made here, instead of relying on some engine happening to die under the ceiling.
      const capped = await run('sh', ['-c', 'ulimit -v'], { cwd, timeoutMs: 10_000, memoryMb: 256, engine: 'sh' });
      expect(capped.code).toBe(0);
      expect(capped.stdout.trim()).toBe(String(256 * 1024));

      const unbounded = await run('sh', ['-c', 'ulimit -v'], { cwd, timeoutMs: 10_000, engine: 'sh' });
      expect(unbounded.code).toBe(0);
      const reported = unbounded.stdout.trim();
      expect(reported === 'unlimited' || Number(reported) > 256 * 1024).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test.skipIf(!observable)(
    'an engine that is not installed is still ENGINE_UNAVAILABLE, not a wrapper failure',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'pdftools-memlimit-'));
      try {
        // The wrapper is what runs first, so a missing engine now fails *inside* it. The classification has to
        // survive that: `ENGINE_UNAVAILABLE` is what the API tells a caller, and a wrapper's exit code reported as
        // an engine failure would be a diagnostic about this file rather than about the image it runs in.
        await expect(
          run('pdftools-engine-that-does-not-exist', [], { cwd, timeoutMs: 10_000, memoryMb: 256, engine: 'qpdf' }),
        ).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
