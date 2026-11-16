import { closeDb, migrate, rawSql } from '@pdftools/db';

/**
 * Applies pending migrations and exits (`docs/0-CICD.md` §6).
 *
 * The API also migrates at boot in development, which is convenient and wrong for production: in phase 2 several
 * API replicas start at once and would race on DDL. This is the script the deploy job runs between "old code is
 * still serving" and "new code rolls out".
 *
 * The runner only ever appends — it reads `schema_migrations`, skips what it finds, and runs the rest inside a
 * transaction each. It cannot rewrite history, which is the property that makes "roll back the application, leave
 * the schema" a safe instruction.
 *
 *   bun run db:migrate
 */
async function main() {
  // Advisory lock: two deploys overlapping must not both try to apply the same file. The lock is released when
  // this connection closes, including on a crash, so a killed deploy does not block the next one.
  const client = rawSql();
  await client`SELECT pg_advisory_lock(9243137)`;

  try {
    const applied = await migrate((message) => console.log(message));
    if (applied.length === 0) {
      console.log('no pending migrations; schema is up to date');
    } else {
      console.log(`\napplied ${applied.length} migration(s): ${applied.join(', ')}`);
    }

    const rows = await client<{ version: string; applied_at: Date | string }[]>`
      SELECT version, applied_at FROM schema_migrations ORDER BY version`;
    console.log('\nledger:');
    for (const row of rows) {
      // Read as either shape, because a raw tagged query hands timestamps back as the string Postgres printed rather
      // than as a `Date` — drizzle maps them, this client does not. This line used to call `toISOString()` on whatever
      // arrived and threw `applied_at.toISOString is not a function` on every run, **after** the migrations had been
      // applied: the schema was right, the exit code was 1, and the deploy recipe's second step reports that as a
      // failed deploy.
      const when = row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at);
      console.log(`  ${row.version.padEnd(24)} ${when}`);
    }
  } finally {
    await client`SELECT pg_advisory_unlock(9243137)`.catch(() => {});
    await closeDb();
  }
}

await main();
