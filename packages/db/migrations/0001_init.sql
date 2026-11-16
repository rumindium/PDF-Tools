-- 0001_init.sql — PDF Tools core schema (`docs/0-DATABASE.md` §2–§3).
--
-- Written as plain SQL rather than generated DDL so the migration is reviewable and the enum types are created
-- explicitly. `drizzle-kit generate` can take over later; the tracked-migration runner in
-- scripts/ops/migrate.ts is what applies this either way.
--
-- Every statement is idempotent: re-running the migration on an existing database is a no-op, which keeps the
-- dev bootstrap (`docker compose up`) safe.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('QUEUED','PROCESSING','COMPLETED','FAILED','CANCELLED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_phase AS ENUM ('queued','staging','processing','finalizing','done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE owner_kind AS ENUM ('anonymous','user','api_key');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE file_status AS ENUM ('staged','claimed','purged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE plan_id AS ENUM ('anonymous','free','pro','business');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE usage_metric AS ENUM ('jobs','pages','bytes_in','bytes_out','engine_seconds','ocr_pages','downloads');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_kind AS ENUM ('anonymous','user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE entitlement_src AS ENUM ('auth_platform','manual','default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Identity ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY,
  auth_user_id    UUID NOT NULL UNIQUE,
  tenant_id       UUID,
  email           TEXT NOT NULL,
  display_name    TEXT,
  plan_id         plan_id NOT NULL DEFAULT 'free',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  data_deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY,
  kind         session_kind NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  anon_id      TEXT,
  ip_hash      TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT sessions_owner CHECK ((kind = 'user' AND user_id IS NOT NULL)
                                OR (kind = 'anonymous' AND anon_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx   ON sessions (user_id, last_used_at DESC);

-- ── Files and jobs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id              UUID PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  owner_kind      owner_kind NOT NULL,
  tenant_id       UUID,
  job_id          UUID,
  name            TEXT NOT NULL,
  detected_type   TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  pages           INTEGER,
  encrypted       BOOLEAN NOT NULL DEFAULT false,
  checksum_sha256 TEXT NOT NULL,
  status          file_status NOT NULL DEFAULT 'staged',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS files_expiry_idx ON files (expires_at) WHERE status <> 'purged';
CREATE INDEX IF NOT EXISTS files_owner_idx  ON files (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_job_idx    ON files (job_id);

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY,
  tool             TEXT NOT NULL,
  category         TEXT NOT NULL,
  status           job_status NOT NULL DEFAULT 'QUEUED',
  phase            job_phase  NOT NULL DEFAULT 'queued',
  queue            TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 10,
  progress         SMALLINT NOT NULL DEFAULT 0,
  owner_id         TEXT NOT NULL,
  owner_kind       owner_kind NOT NULL,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  tenant_id        UUID,
  anon_id          TEXT,
  api_key_id       UUID,
  plan_id          plan_id NOT NULL DEFAULT 'anonymous',
  options          JSONB NOT NULL DEFAULT '{}'::jsonb,
  module           TEXT,
  input_files      INTEGER NOT NULL DEFAULT 1,
  input_bytes      BIGINT  NOT NULL DEFAULT 0,
  input_pages      INTEGER NOT NULL DEFAULT 0,
  output_bytes     BIGINT,
  output_pages     INTEGER,
  output_parts     INTEGER,
  output_mime      TEXT,
  output_name      TEXT,
  result_parts     JSONB,
  metrics          JSONB,
  warnings         JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code       TEXT,
  error_message    TEXT,
  engine_name      TEXT,
  engine_version   TEXT,
  worker_id        TEXT,
  attempts         SMALLINT NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  duration_ms      INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_expiry_idx ON jobs (status, expires_at);
CREATE INDEX IF NOT EXISTS jobs_tenant_idx ON jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_owner_idx  ON jobs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_anon_idx   ON jobs (anon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_tool_idx   ON jobs (tool, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status) WHERE status IN ('QUEUED','PROCESSING');
CREATE INDEX IF NOT EXISTS jobs_apikey_idx ON jobs (api_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  status     job_status,
  phase      job_phase,
  progress   SMALLINT,
  message    TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_events_job_id_seq_key UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS job_events_job_idx     ON job_events (job_id, seq);
CREATE INDEX IF NOT EXISTS job_events_created_idx ON job_events (created_at);

-- ── Metering, plans, entitlements ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id                 plan_id PRIMARY KEY,
  name               TEXT NOT NULL,
  max_file_mb        INTEGER NOT NULL,
  max_job_mb         INTEGER NOT NULL,
  max_pages          INTEGER NOT NULL,
  max_files          INTEGER NOT NULL,
  jobs_per_window    INTEGER NOT NULL,
  window_seconds     INTEGER NOT NULL,
  max_concurrent     SMALLINT NOT NULL,
  queue_priority     SMALLINT NOT NULL,
  result_ttl_minutes INTEGER NOT NULL,
  history_days       INTEGER NOT NULL DEFAULT 0,
  max_api_keys       SMALLINT NOT NULL DEFAULT 0,
  tools              JSONB NOT NULL,
  ocr_pages_per_job  INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlements (
  id          UUID PRIMARY KEY,
  tenant_id   UUID,
  user_id     UUID,
  plan_id     plan_id NOT NULL,
  limits      JSONB NOT NULL,
  tools       JSONB NOT NULL,
  priority    SMALLINT NOT NULL,
  source      entitlement_src NOT NULL DEFAULT 'auth_platform',
  version     BIGINT NOT NULL DEFAULT 1,
  valid_until TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_tenant_user_key UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id          UUID PRIMARY KEY,
  tenant_id   UUID,
  user_id     UUID,
  anon_id     TEXT,
  api_key_id  UUID,
  plan_id     plan_id NOT NULL,
  tool        TEXT NOT NULL,
  metric      usage_metric NOT NULL,
  value       NUMERIC(20,4) NOT NULL,
  unit        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'job',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_tenant_time_idx ON usage_records (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_user_time_idx   ON usage_records (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_anon_time_idx   ON usage_records (anon_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_tool_time_idx   ON usage_records (tool, occurred_at DESC);

-- ── Infrastructure ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  job_id       UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

-- Applied-migration ledger, so the runner knows what has already run.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
