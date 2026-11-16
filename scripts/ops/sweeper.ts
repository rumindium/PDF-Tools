import { closeDb } from '@pdftools/db';
import { closeQueueConnection } from '@pdftools/queue';
import { requeueStalledJobs, runSweep } from '../../apps/api/src/services/cleanup-service';

/**
 * Runs the cleanup sweep once, on demand (`docs/0-CICD.md` §11).
 *
 * The API already sweeps on an interval. This exists for the two moments the interval is not good enough: during
 * an incident, when an operator wants the filesystem reconciled *now*, and in tests, where waiting 300 seconds for
 * a TTL to be noticed is not an option.
 *
 * It imports the API's own service rather than reimplementing the sweep. One implementation means the manual run
 * and the scheduled run can never disagree about what "expired" means.
 *
 *   bun run sweeper
 */
async function main() {
  console.log('sweeping…');
  const result = await runSweep();

  console.log(
    [
      `expired jobs          ${result.expiredJobs}`,
      `purged job dirs       ${result.purgedJobDirs}`,
      `purged staged uploads ${result.purgedUploads}`,
      `orphan staging files  ${result.orphanStaging}`,
      `orphan job dirs       ${result.orphanJobDirs}`,
      `errors                ${result.errors}`,
    ].join('\n'),
  );

  const stalled = await requeueStalledJobs();
  console.log(`\nstalled jobs handled  ${stalled}`);

  if (result.errors > 0) {
    // A partial sweep is not a failure of the command, but it must not exit 0 either: a cron wrapper that only
    // checks the exit code would otherwise never alert on a half-broken sweeper.
    console.error('\nthe sweep completed with errors; see the API logs for the failing layer');
    process.exitCode = 1;
  }

  await closeQueueConnection().catch(() => {});
  await closeDb();
}

await main();
