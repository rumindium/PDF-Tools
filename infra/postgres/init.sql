-- Postgres bootstrap, run once on an empty data directory.
--
-- Schema creation is **not** here. Tables come from `packages/db/migrations/*.sql` applied by the migration
-- runner (`packages/db/src/index.ts` → `migrate()`), which the API calls at boot and which
-- `scripts/ops/migrate.ts` can run on its own for a deploy job. Two places that create tables is two histories to
-- reconcile, and the one that runs inside a transaction with a ledger is the one that wins.

-- `pg_trgm` powers the operator-facing searches over job metadata (tool, file name fragments). Extensions cannot
-- be created by a non-superuser, so they belong here rather than in a migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Timestamps are stored with time zone everywhere; this makes the server's default agree with how the rows are
-- written instead of depending on the client's locale.
ALTER DATABASE pdftools SET timezone TO 'UTC';

-- Usage rows are the only table that grows without bound (one row per metric per job). The default autovacuum
-- settings are tuned for smaller, hotter tables, so this one gets a lower threshold — an unvacuumed usage table
-- is a slow reporting query six months from now.
--
-- That tuning cannot live here: `autovacuum_vacuum_scale_factor` is a SIGHUP-context GUC, and Postgres refuses
-- `ALTER DATABASE ... SET` for those with "parameter cannot be changed now" (a failed statement here also leaves
-- the volume half-initialised, because the entrypoint skips init on every boot after this one). It is applied
-- from the server's command line in docker-compose.yml instead, which SIGHUP GUCs do accept.
