import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runOrThrow } from '../src/index';

/**
 * `run()` promises the child an environment whose `TMPDIR` and `HOME` point inside the job directory. A promise about
 * a *path* is only worth anything if the directory is there when the child starts: Ghostscript exits with
 * "Could not open temporary file …/work/tmp/gs_XXXXXX" when it is not, which is how every `compress` job failed while
 * the tool was disabled and nothing ran it.
 *
 * These tests use `sh` rather than an engine, so they assert the contract instead of one engine's reaction to it, and
 * they run anywhere without the worker images.
 */

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pdftools-run-'));
}

describe('run', () => {
  test('the child sees a TMPDIR that exists and is inside the job directory', async () => {
    const cwd = await scratch();
    try {
      const result = await run('sh', ['-c', 'test -d "$TMPDIR" && echo "$TMPDIR"'], {
        cwd,
        timeoutMs: 10_000,
        engine: 'sh',
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(join(cwd, 'tmp'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('HOME is created too, because an engine that cannot write a profile is a crash, not a warning', async () => {
    const cwd = await scratch();
    try {
      const result = await run('sh', ['-c', 'test -d "$HOME" && echo "$HOME"'], {
        cwd,
        timeoutMs: 10_000,
        engine: 'sh',
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(join(cwd, 'home'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('the engine can actually write a temp file, which is the failure that started this', async () => {
    const cwd = await scratch();
    try {
      const result = await run('sh', ['-c', 'mktemp "$TMPDIR/gs_XXXXXX"'], {
        cwd,
        timeoutMs: 10_000,
        engine: 'sh',
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toStartWith(join(cwd, 'tmp'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('an exit code is returned by `run` and thrown by `runOrThrow`, with the engine stderr attached', async () => {
    const cwd = await scratch();
    try {
      // `run` reports; `runOrThrow` decides. Conflating the two is what turned qpdf's "unrecognized argument" into a
      // generic "no usable output" in the handlers that used the tolerant variant for write operations.
      const tolerant = await run('sh', ['-c', 'echo boom >&2; exit 3'], { cwd, timeoutMs: 10_000, engine: 'sh' });
      expect(tolerant.code).toBe(3);
      expect(tolerant.stderr).toContain('boom');

      await expect(
        runOrThrow('sh', ['-c', 'echo boom >&2; exit 3'], { cwd, timeoutMs: 10_000, engine: 'sh' }),
      ).rejects.toMatchObject({
        code: 'CONVERSION_FAILED',
        // These live on the error itself (`JobFailure`), not in a `details` bag: they are what `toEventPayload`
        // puts in `job_events` for an operator.
        engine: 'sh',
        exitCode: 3,
        stderrTail: 'boom\n',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
