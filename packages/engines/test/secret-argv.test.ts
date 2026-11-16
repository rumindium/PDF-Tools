import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_GUARDED_SECRET_LENGTH,
  guardedSecretCount,
  registerJobSecrets,
  releaseJobSecrets,
  run,
} from '../src/index';

/**
 * The command-line guard (`docs/0-SECURITY.md` §7.1).
 *
 * A password passed as an argument is in `/proc/<pid>/cmdline`, readable by every process in the container — on a
 * worker, that is the sibling jobs of other tenants. The transports that avoid this (`stdin`, the Python bridge's
 * `runPythonScriptStdin`) exist so nothing *has* to arrive as an argument; this guard is what makes that a rule the
 * spawn path enforces rather than one each handler remembers.
 *
 * These tests use `sh` rather than an engine, so they assert the guard itself: whether a case would even reach a
 * process. Whether a real handler obeys the rule is a question for the E2E harness, which audits what the running
 * stack left behind.
 */

/** Every test that registers must release, or a value would leak into the next one and fail it for the wrong reason. */
const registered = new Set<string>();
function arm(jobId: string, values: string[]): void {
  registerJobSecrets(jobId, values);
  registered.add(jobId);
}

afterEach(() => {
  for (const jobId of registered) releaseJobSecrets(jobId);
  registered.clear();
  expect(guardedSecretCount()).toBe(0);
});

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pdftools-secret-'));
}

describe('the spawn guard', () => {
  test('a password in the arguments fails the job instead of being spawned', async () => {
    const cwd = await scratch();
    arm('job-1', ['hunter2-correct-horse']);
    try {
      // The exact shape the guard exists for: one argument holding a flag *and* the value, which no equality check
      // would catch.
      await expect(
        run('sh', ['-c', 'true', '--password=hunter2-correct-horse'], { cwd, timeoutMs: 5_000, engine: 'sh' }),
      ).rejects.toMatchObject({ code: 'SECRET_IN_ARGV' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('the refusal names the engine and no argument, so the message cannot re-leak the value', async () => {
    const cwd = await scratch();
    arm('job-2', ['s3cret-value']);
    try {
      const error = (await run('qpdf', ['--password-file=/dev/stdin', '--decrypt', 's3cret-value', 'out.pdf'], {
        cwd,
        timeoutMs: 5_000,
        engine: 'qpdf',
      }).catch((thrown: unknown) => thrown)) as { code: string; engine: string; message: string };

      expect(error.code).toBe('SECRET_IN_ARGV');
      expect(error.engine).toBe('qpdf');
      // The message reaches the user through the job view (`docs/0-API.md` §9), so quoting the command line would put
      // back exactly what the check refused to spawn.
      expect(error.message).not.toContain('s3cret-value');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a value registered by another job also stops this one, because that leak is the same leak', async () => {
    const cwd = await scratch();
    arm('job-3', ['other-jobs-password']);
    try {
      await expect(
        run('sh', ['-c', 'true', '--password=other-jobs-password'], { cwd, timeoutMs: 5_000, engine: 'sh' }),
      ).rejects.toMatchObject({ code: 'SECRET_IN_ARGV' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('an ordinary command line still runs while secrets are guarded', async () => {
    const cwd = await scratch();
    arm('job-4', ['hunter2-correct-horse']);
    try {
      // The guard has to be a rule about one value, not a reason to stop spawning: a tool that refuses everything
      // gets removed, and then the rule goes with it.
      const result = await run('sh', ['-c', 'echo "$(cat <&0)"'], {
        cwd,
        timeoutMs: 5_000,
        engine: 'sh',
        stdin: 'hunter2-correct-horse',
      });
      expect(result.code).toBe(0);
      // And stdin — the transport the rule prefers — is *not* guarded, or every security tool would break.
      expect(result.stdout.trim()).toBe('hunter2-correct-horse');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a value below the floor is not guarded, which is the stated hole rather than a silent one', async () => {
    const cwd = await scratch();
    const short = 'ab'.repeat(Math.ceil(MIN_GUARDED_SECRET_LENGTH / 2)).slice(0, MIN_GUARDED_SECRET_LENGTH - 1);
    arm('job-5', [short]);
    try {
      expect(guardedSecretCount()).toBe(0);
      const result = await run('sh', ['-c', `echo ${short}`], { cwd, timeoutMs: 5_000, engine: 'sh' });
      expect(result.code).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('releasing a job unguards its value, so one job cannot disarm the next', async () => {
    const cwd = await scratch();
    arm('job-6', ['release-me-now']);
    releaseJobSecrets('job-6');
    registered.delete('job-6');
    try {
      expect(guardedSecretCount()).toBe(0);
      const result = await run('sh', ['-c', 'echo release-me-now'], { cwd, timeoutMs: 5_000, engine: 'sh' });
      expect(result.code).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
