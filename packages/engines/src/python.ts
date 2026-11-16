import { config } from '@pdftools/config';
import { type RunOptions, runOrThrow } from './run';

/**
 * The Python bridge: pikepdf and PyMuPDF, for the structural edits qpdf's CLI cannot express.
 *
 * Two transports, and the choice between them is a security decision rather than a style one:
 *
 *  - `runPythonScript` passes the payload as `--json <payload>` on the command line. Every other value in this
 *    codebase reaches an engine as an argument, and arguments are safe from shell interpretation (`run` never uses a
 *    shell) but are **world-readable inside the container** via `/proc/<pid>/cmdline` to any process running as the
 *    same user — which, on a worker, means the sibling jobs of other tenants.
 *  - `runPythonScriptStdin` passes the payload on stdin instead. It is what a payload containing a **password** must
 *    use (`10-PROTECT-AND-UNLOCK.md` §4). Nothing lands on disk either: stdin is a pipe, so a crashed engine cannot
 *    leave the secret in a job directory the sweeper only reaches later.
 *
 * Both forms print exactly one JSON line, which `parseJsonLine` reads. Anything else on stdout is engine noise.
 *
 * That line is a **result**, not a log, so both forms ask for the payload-sized stdout budget. The engine wrapper's
 * default is a 4 KB log tail, and a script that reports one object per output crosses it quietly: `split`'s decorator
 * returns a result per part, so a 125-part job produced 13 kB of JSON, the parse failed, and every part came back
 * with a warning that its bookmarks could not be restored — while the parts themselves were perfect (defect 126).
 * Nothing about that failure pointed at the budget, which is why the budget is now the bridge's own business.
 */

/** The most a bridge result may be: 8 MB. A per-output result is tens of bytes; this is a ceiling, not a target. */
const BRIDGE_RESULT_BYTES = 8 * 1024 * 1024;

export function runPythonScript(
  script: string,
  payload: unknown,
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  return runOrThrow(config.engines.python ?? 'python3', ['-c', script, '--json', JSON.stringify(payload)], {
    ...opts,
    engine: 'python',
    stdoutLimitBytes: BRIDGE_RESULT_BYTES,
  });
}

export function runPythonScriptStdin(
  script: string,
  payload: unknown,
  opts: Omit<RunOptions, 'engine'>,
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  return runOrThrow(config.engines.python ?? 'python3', ['-c', script], {
    ...opts,
    engine: 'python',
    stdin: JSON.stringify(payload ?? {}),
    stdoutLimitBytes: BRIDGE_RESULT_BYTES,
  });
}

/** The scripts print JSON on one line; anything else on stdout is engine noise and is ignored. */
export function parseJsonLine<T>(stdout: string): T | null {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
