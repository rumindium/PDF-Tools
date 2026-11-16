import { spawn } from 'node:child_process';
import { constants, accessSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import { JobFailure } from '@pdftools/errors';

/**
 * The only place in the codebase where a process is spawned (`docs/0-WORKERS.md` §3).
 *
 * Guarantees, in order of importance:
 *  1. no shell — arguments are an array, so a file named `; rm -rf /` is just a file;
 *  2. **no registered secret ever appears in the arguments** (`docs/0-SECURITY.md` §7.1) — checked here rather than in
 *     each handler, because this is the one door every engine comes through;
 *  3. timeout escalates SIGTERM → SIGKILL and kills the *process group*, so LibreOffice's children die too;
 *  4. the tool's own memory budget is a real ceiling — `RLIMIT_AS`, not a number in a catalog entry that someone
 *     sizes a node against (`memoryLimitedCommand` below says where it can apply and how that is reported);
 *  5. stdout/stderr capture is bounded — a runaway engine cannot fill memory with logs;
 *  6. environment is allow-listed, and TMPDIR/HOME point inside the job's work directory *and exist*;
 *  7. a non-zero exit becomes a typed `JobFailure`, never a raw string.
 */

/**
 * Values that must not be spawned on a command line: a job's passwords, registered by the worker for as long as that
 * job is running.
 *
 * An argument is readable by every process in the container through `/proc/<pid>/cmdline`, which on a worker means the
 * sibling jobs of other tenants — so the transports that carry a secret (`RunOptions.stdin`, the Python bridge's
 * `runPythonScriptStdin`) exist precisely so nothing has to arrive as an argument. This registry is what turns that
 * from a rule the handlers follow into one the spawn path enforces: the day a handler reaches for `--password=`, the
 * job fails with `SECRET_IN_ARGV` instead of leaking.
 *
 * Keyed by job id, so concurrent jobs in one worker cannot unregister each other's values, and a union of the values
 * rather than a per-job lookup: a secret belonging to *another* job appearing in this one's arguments is not a false
 * positive, it is the same leak from the other direction.
 */
const GUARDED_SECRETS = new Map<string, Set<string>>();

/**
 * The shortest value worth guarding.
 *
 * Below this, a value occurs inside ordinary arguments by accident — a one-character password would match `--pages=1`
 * — and a guard that fails legitimate jobs is a guard somebody removes. The contract allows shorter passwords, so this
 * is a real (small) hole, stated in `docs/0-SECURITY.md` §7.1 rather than hidden: it covers every password worth
 * calling one, and none of the ones that are two characters long.
 */
export const MIN_GUARDED_SECRET_LENGTH = 4;

export function registerJobSecrets(jobId: string, values: Iterable<string>): void {
  const guarded = new Set<string>();
  for (const value of values) {
    if (value.length >= MIN_GUARDED_SECRET_LENGTH) guarded.add(value);
  }
  if (guarded.size > 0) GUARDED_SECRETS.set(jobId, guarded);
}

export function releaseJobSecrets(jobId: string): void {
  GUARDED_SECRETS.delete(jobId);
}

/** Which values are currently guarded, for tests and diagnostics. Never returned over the API. */
export function guardedSecretCount(): number {
  let total = 0;
  for (const values of GUARDED_SECRETS.values()) total += values.size;
  return total;
}

/**
 * Refuse to spawn a command line that carries a guarded value.
 *
 * Substring rather than equality, because the leak this exists for is `--password=hunter2` — one argument holding a
 * flag and a value. The floor on the value's length is what keeps the substring test from firing on short values that
 * legitimately appear in paths and page ranges.
 */
function assertNoSecretInArgs(binary: string, args: string[]): void {
  if (GUARDED_SECRETS.size === 0) return;
  for (const values of GUARDED_SECRETS.values()) {
    for (const value of values) {
      if (args.some((arg) => arg.includes(value))) {
        // No argument is named in the error: the message reaches the user through the job view, and quoting the
        // command line would put back the secret this check just refused to spawn.
        throw new JobFailure('SECRET_IN_ARGV', {
          engine: binary,
          message: `A password was about to be passed to ${binary} as a command-line argument, where every process in the container can read it. The job was stopped instead.`,
        });
      }
    }
  }
}

/**
 * Where a memory ceiling comes from.
 *
 * `limits.memoryMb` is in every catalog entry, asserted greater than zero by the registry test, and passed into
 * `run()` by every handler — and until this was written it was read by nothing. That is worse than the field being
 * absent, because it is the number an operator sizes a node against — `docs/0-IMPLEMENTATION-STATUS.md` §6 states the
 * finding in its own words: declared, validated and never enforced.
 *
 * The enforcement is `RLIMIT_AS`, and neither Node nor Bun exposes an rlimit API, so the ceiling is applied by
 * util-linux's `prlimit`, which runs the engine with the limits already set (`prlimit(1)`: "When command is given,
 * prlimit will run this command with the given arguments"). The binary and its arguments stay an array and nothing
 * is added to them, so the two guarantees above survive: no shell, and no secret on a command line.
 *
 * **It is Linux-only, and that is reported rather than hidden.** `prlimit` ships with util-linux, so on a
 * developer's machine — or macOS — a budget is still declared and not applied. `memoryLimitSupport()` answers which
 * of the two this process is, `bun run engines:check` prints it, and `test/memory-limit.test.ts` asserts both halves.
 */
export const PRLIMIT_CANDIDATES = ['/usr/bin/prlimit', '/bin/prlimit', '/usr/sbin/prlimit', '/sbin/prlimit'] as const;

let prlimitResolved: string | null | undefined;

/** The `prlimit` this process will use, or `null`. Resolved once, because it cannot appear mid-process. */
export function resolvePrlimit(): string | null {
  if (prlimitResolved !== undefined) return prlimitResolved;
  prlimitResolved = null;
  if (process.platform === 'linux') {
    for (const candidate of PRLIMIT_CANDIDATES) {
      try {
        accessSync(candidate, constants.X_OK);
        prlimitResolved = candidate;
        break;
      } catch {
        // Not at this path; the list is short and ordered by where util-linux actually installs it.
      }
    }
  }
  return prlimitResolved;
}

export interface MemoryLimitSupport {
  /** True when a spawned engine really gets an `RLIMIT_AS` ceiling in this process. */
  enforced: boolean;
  /** The wrapper that applies it, or `null` when there is none. */
  via: string | null;
  /** One sentence for an operator, saying which of the two this environment is and why. */
  reason: string;
}

/** Whether a tool's declared memory budget is applied here, and by what. */
export function memoryLimitSupport(): MemoryLimitSupport {
  const prlimit = resolvePrlimit();
  if (prlimit != null) {
    return { enforced: true, via: prlimit, reason: `RLIMIT_AS is applied to every engine by ${prlimit}` };
  }
  return {
    enforced: false,
    via: null,
    reason:
      process.platform === 'linux'
        ? 'prlimit (util-linux) is not installed here, so limits.memoryMb is declared but not applied'
        : `RLIMIT_AS is a Linux facility and this process runs on ${process.platform}, so limits.memoryMb is declared but not applied`,
  };
}

/**
 * The command line one engine call is spawned with: the engine itself, or `prlimit` in front of it.
 *
 * Separated out because it is the half of the enforcement that can be asserted on any platform — the other half is
 * the limit itself, which only a Linux process can observe (`test/memory-limit.test.ts` runs that half there and
 * skips it elsewhere, naming why).
 *
 * `--as` takes a plain byte count, which is what `prlimit(1)` documents, and giving a single `value` sets the soft
 * and hard limits to the same number — lowering both, which is the only direction an unprivileged process can take.
 */
export function memoryLimitedCommand(
  binary: string,
  args: string[],
  memoryMb: number | undefined,
  prlimit: string | null = resolvePrlimit(),
): { command: string; args: string[]; limited: boolean } {
  // `0` is the catalog's "no cap of its own", the same shape `maxPages: 0` uses, and an engine with no budget is
  // spawned exactly as it was before any of this existed.
  if (memoryMb == null || memoryMb <= 0 || prlimit == null) {
    return { command: binary, args, limited: false };
  }
  return { command: prlimit, args: [`--as=${memoryMb * 1024 * 1024}`, '--', binary, ...args], limited: true };
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /**
   * The tool's memory budget from the catalog, applied to the spawned engine as `RLIMIT_AS` where that is possible
   * (`memoryLimitedCommand`). Undefined or `0` means no ceiling, which is what a caller without a tool definition
   * behind it — a probe, the version check — passes.
   */
  memoryMb?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Engine name for diagnostics (e.g. 'qpdf'). */
  engine?: string;
  /**
   * Payload written to the child's stdin, which is otherwise `/dev/null`.
   *
   * It exists for one reason: a **secret must not travel on the command line**. A password given as an argument is
   * visible in `/proc/<pid>/cmdline` to every other process running as the same user — and on a worker container that
   * means the sibling jobs of other tenants (`docs/0-SECURITY.md` §5). qpdf's `--password-file=/dev/stdin` is the
   * transport built for this, and it needs stdin to be a pipe rather than an open `/dev/null`.
   *
   * A pipe is not a file: the value never lands on disk, so a crashed engine cannot leave the password behind in a
   * job directory the sweeper only deletes later.
   */
  stdin?: string | Uint8Array;
  /**
   * How much of the child's **stdout** to keep, in characters. Defaults to the configured log tail.
   *
   * The default is a *log* budget (4 KB): enough to explain a failure, deliberately too small to hold a payload. An
   * engine that prints a document's structure to stdout is not logging, and truncating it does not lose a diagnostic
   * — it corrupts a structured payload into something that does not parse. That is not hypothetical: `split --mode
   * by-size` read qpdf's object table through this channel and refused every document whose table exceeded 4 KB,
   * which is every document with more than a couple of dozen objects (defect 123).
   *
   * Stderr is not affected by this option: an engine that floods stderr is the case the log budget exists for.
   */
  stdoutLimitBytes?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Either stream was cut short. */
  truncated: boolean;
  /** stdout specifically was cut short — the flag a payload reader has to test before trusting a parse failure. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  engine: string;
}

const ALLOWED_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME',
  'TMPDIR',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'JAVA_HOME',
  'LIBREOFFICE_PROFILE_ROOT',
];

/**
 * Create the scratch directories the environment promises, immediately before spawning.
 *
 * `buildEnv` points `TMPDIR` and `HOME` inside the job directory so an engine cannot leave files in `/tmp` that the
 * sweeper never sees — but pointing at a directory that does not exist is worse than not pointing at all: the child
 * starts and then dies on its first write. Ghostscript refuses outright (`Could not open temporary file
 * …/work/tmp/gs_XXXXXX`), which is how `compress` failed *every* job while its tool flag was off and nothing ran it.
 *
 * Created here rather than by the worker's staging step because this function is what decides where they are: the two
 * facts have to live in one place or they drift exactly as they had.
 */
async function ensureScratchDirs(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await mkdir(join(cwd, 'home'), { recursive: true });
}

function buildEnv(cwd: string, extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  // Keep every engine's scratch space inside the job directory so a crashed engine cannot leave
  // droppings in /tmp that the sweeper never sees.
  env.TMPDIR = `${cwd}/tmp`;
  env.HOME = `${cwd}/home`;
  env.LANG ??= 'C.UTF-8';
  if (extra) Object.assign(env, extra);
  return env;
}

export async function run(binary: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const engine = opts.engine ?? binary;
  const started = performance.now();
  const cap = config.limits.engineLogTailBytes;
  const stdoutCap = Math.max(opts.stdoutLimitBytes ?? cap, cap);

  assertNoSecretInArgs(binary, args);
  await ensureScratchDirs(opts.cwd);

  // Decided before the spawn and never after it: `RLIMIT_AS` can only be *raised* by a privileged process, so a
  // ceiling that turns out to be too low is not something a running job can recover from.
  const invocation = memoryLimitedCommand(binary, args, opts.memoryMb);

  return await new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: opts.cwd,
        env: buildEnv(opts.cwd, opts.env),
        shell: false,
        detached: true, // own process group → we can kill the whole tree
        stdio: [opts.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new JobFailure('ENGINE_UNAVAILABLE', {
          engine,
          message: `Could not start ${engine}. It may not be installed.`,
          cause: error,
        }),
      );
      return;
    }

    // Written and closed before anything else can happen: an engine that waits on stdin's EOF has to get it, and an
    // engine that never reads it must not hold the process open. `end` is exactly "send and close".
    if (opts.stdin != null) child.stdin?.end(opts.stdin);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const append = (target: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') {
        if (stdout.length < stdoutCap) stdout += text.slice(0, stdoutCap - stdout.length);
        else stdoutTruncated = true;
      } else {
        if (stderr.length < cap) stderr += text.slice(0, cap - stderr.length);
        else stderrTruncated = true;
      }
    };

    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), config.limits.engineKillGraceSeconds * 1000).unref?.();
    }, opts.timeoutMs);

    const onAbort = () => {
      killGroup('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', (error) => {
      finish(() =>
        reject(
          new JobFailure('ENGINE_UNAVAILABLE', {
            engine,
            message: `Could not run ${engine}.`,
            cause: error,
          }),
        ),
      );
    });

    child.on('close', (code) => {
      finish(() => {
        const durationMs = Math.round(performance.now() - started);
        // A wrapper that cannot `exec` its command never reaches the engine at all, and says so on stderr — without
        // the wrapper that is the ENOENT `spawn` raises, so reporting it as an engine that exited 1 would be a
        // different and wrong answer. Both codes are accepted because util-linux's `prlimit` exits `EXIT_FAILURE`
        // (1) from its failed-`exec` path while the shell convention is 127, and the message on stderr is what
        // actually identifies it.
        if (invocation.limited && (code === 1 || code === 127) && /failed to execute/.test(stderr)) {
          reject(
            new JobFailure('ENGINE_UNAVAILABLE', {
              engine,
              message: `Could not start ${engine}. It may not be installed.`,
              stderrTail: stderr,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new JobFailure('CONVERSION_TIMEOUT', {
              engine,
              exitCode: code ?? -1,
              stderrTail: stderr,
              message: `${engine} exceeded its time budget.`,
            }),
          );
          return;
        }
        if (opts.signal?.aborted) {
          reject(new JobFailure('JOB_CANCELLED', { engine, message: 'The job was cancelled.' }));
          return;
        }
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
          durationMs,
          truncated: stdoutTruncated || stderrTruncated,
          stdoutTruncated,
          stderrTruncated,
          engine,
        });
      });
    });
  });
}

/** Run and require success, mapping a non-zero exit to CONVERSION_FAILED. */
export async function runOrThrow(binary: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const result = await run(binary, args, opts);
  if (result.code !== 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: result.engine,
      exitCode: result.code,
      stderrTail: result.stderr,
    });
  }
  return result;
}

/** `gs` exits 0 even on some failures; the caller checks this instead of trusting the code alone. */
export function stderrIndicatesFailure(result: RunResult): boolean {
  return /Error|Unrecoverable|Failed/i.test(result.stderr);
}
