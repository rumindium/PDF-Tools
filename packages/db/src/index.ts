import { config } from '@pdftools/config';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Re-exported as a namespace so callers write `schema.jobs` — one spelling, no chance of a caller importing the
// rows and the namespace differently.
export * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

let sql: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;

/** Shared client. One pool per process; the API and each worker get their own. */
export function getDb(): Db {
  if (db) return db;
  sql = postgres(config.db.url, {
    max: config.db.poolMax,
    idle_timeout: 30,
    // Long jobs mean long-lived processes; keep the pool honest about dead sockets.
    connect_timeout: 10,
    onnotice: () => {},
  });
  db = drizzle(sql, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
    db = null;
  }
}

/** Raw tagged-template access for the places drizzle is a poor fit (sweepers, analytics). */
export function rawSql(): ReturnType<typeof postgres> {
  if (!sql) getDb();
  return sql as ReturnType<typeof postgres>;
}

export async function pingDb(): Promise<number> {
  const start = performance.now();
  await rawSql()`select 1`;
  return Math.round(performance.now() - start);
}

/**
 * Apply the tracked SQL migrations in `migrations/`.
 *
 * Deliberately small: read the directory, skip what the ledger already has, run the rest inside a transaction
 * each. A migration runner that can rewrite history is a liability; this one only ever appends.
 */
export async function migrate(log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = rawSql();
  await client`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  const applied = new Set<string>(
    (await client<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version),
  );

  const dir = new URL('../migrations/', import.meta.url);
  const entries = [...((await Array.fromAsync(new Bun.Glob('*.sql').scan({ cwd: dir.pathname }))) as string[])].sort();
  const ran: string[] = [];

  for (const file of entries) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const body = await Bun.file(new URL(file, dir)).text();
    log(`applying ${version}`);
    await client.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
    ran.push(version);
  }
  return ran;
}
