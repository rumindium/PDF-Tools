import { spawnSync } from 'node:child_process';

/**
 * Where a statement that needs the worker image's engines runs: the pooled container, or — when there is no Docker
 * daemon — this host.
 *
 * The verification harness and the fixture builders both measure or construct documents with engines that live in the
 * worker image (`qpdf`, poppler, `pikepdf`, PyMuPDF), and both used to reach them exclusively through `docker compose
 * exec worker-heavy|worker-light`. That is the right transport for a compose stack and the wrong one for a rootless
 * stack: `scripts/noroot-stack.sh` runs the pools as the current user, on a machine whose Docker socket needs root, and
 * there every reader answered `null` — "no container was reachable" — on a stack that was up, which the harness's own
 * contract turns into a *failure*. A verification suite that cannot run is the difference between "PDF Tools runs
 * without Docker" and "PDF Tools starts without Docker".
 *
 * The same statement, run here, needs only the engines on `PATH`:
 *
 *     eval "$(scripts/noroot-stack.sh env)"   # engines/bin and the pikepdf venv, plus the marker below
 *     bun run e2e:merge
 *
 * `PDFTOOLS_INSPECT_TRANSPORT=local|docker` forces the choice. Without it the transport is probed once with
 * `docker info`, which is about the *daemon* rather than the binary on purpose: a machine with `docker` installed and
 * no reachable daemon is exactly the case this exists for, and the case a `command -v docker` check gets wrong.
 */
export type WorkerTransport = 'docker' | 'local';

let transportMemo: WorkerTransport | null = null;

/** The transport for this process, decided once — `docker info` costs a process spawn and must not repeat per case. */
export function workerTransport(): WorkerTransport {
  if (transportMemo) return transportMemo;
  const forced = (process.env.PDFTOOLS_INSPECT_TRANSPORT ?? '').trim().toLowerCase();
  if (forced === 'docker' || forced === 'local') {
    transportMemo = forced;
    return transportMemo;
  }

  let daemonReachable = false;
  try {
    daemonReachable = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 4000 }).status === 0;
  } catch {
    daemonReachable = false;
  }

  if (!daemonReachable) {
    process.stderr.write(
      '[pdf-tools] no Docker daemon — running worker statements on this host ' +
        '(eval "$(scripts/noroot-stack.sh env)" puts the engines on PATH, and sets PDFTOOLS_INSPECT_TRANSPORT=local)\n',
    );
  }
  transportMemo = daemonReachable ? 'docker' : 'local';
  return transportMemo;
}

/** One spawn, planned for whichever transport `workerTransport()` chose. */
export interface WorkerExecPlan {
  /** argv for the spawn: `docker compose exec … sh -c <statement>`, or a local `sh -c <statement>`. */
  argv: string[];
  /** The spawn's environment — inherited for the container call, extended with `env` for the local one. */
  env: Record<string, string | undefined>;
}

/**
 * Plan the spawn a caller needs: the `-e` pairs become the container's environment, or this process's own.
 *
 * `service` is the compose service the statement wants (`worker-light` for the readers, `worker-heavy` for the form
 * builder) and is unused locally: a rootless stack has one set of engines on `PATH` rather than one container per pool,
 * so a statement asking for a tool the host does not have fails the same way it does in a pool that lacks it.
 */
export function planWorkerExec(service: string, env: Record<string, string>, statement: string): WorkerExecPlan {
  if (workerTransport() === 'docker') {
    const pairs = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
    return {
      argv: ['docker', 'compose', 'exec', '-T', ...pairs, service, 'sh', '-c', statement],
      env: process.env,
    };
  }
  return { argv: ['sh', '-c', statement], env: { ...process.env, ...env } };
}
