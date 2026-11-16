import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Schema for `docs/0-DATABASE.md` §2–§3.
 *
 * Postgres enums are kept as real `CREATE TYPE` values (see `migrations/0001_init.sql`) so the database rejects
 * a bad status even if a future code path forgets to validate. The `pgEnum` declarations here mirror those types
 * for Drizzle's benefit — the migration is the authoritative DDL.
 */

export const jobStatus = pgEnum('job_status', ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
export const jobPhase = pgEnum('job_phase', ['queued', 'staging', 'processing', 'finalizing', 'done']);
export const ownerKind = pgEnum('owner_kind', ['anonymous', 'user', 'api_key']);
export const fileStatus = pgEnum('file_status', ['staged', 'claimed', 'purged']);
export const planIdEnum = pgEnum('plan_id', ['anonymous', 'free', 'pro', 'business']);
export const usageMetric = pgEnum('usage_metric', [
  'jobs',
  'pages',
  'bytes_in',
  'bytes_out',
  'engine_seconds',
  'ocr_pages',
  'downloads',
]);
export const sessionKind = pgEnum('session_kind', ['anonymous', 'user']);
export const entitlementSrc = pgEnum('entitlement_src', ['auth_platform', 'manual', 'default']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    authUserId: uuid('auth_user_id').notNull().unique(),
    tenantId: uuid('tenant_id'),
    email: text('email').notNull(),
    displayName: text('display_name'),
    planId: planIdEnum('plan_id').notNull().default('free'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    dataDeletedAt: timestamp('data_deleted_at', { withTimezone: true }),
  },
  (t) => ({ tenantIdx: index('users_tenant_idx').on(t.tenantId) }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    kind: sessionKind('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    anonId: text('anon_id'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // What Auth Platform says this *link* may do (migration 0003): the app roles the account holds and the permission
    // codes those roles carry. Nullable, and `null` is not `[]` — no snapshot yet is a reason to ask the platform,
    // "holds nothing" is an answer that must not be re-asked on every request.
    appRoles: text('app_roles').array(),
    appPermissions: text('app_permissions').array(),
    appAccessAt: timestamp('app_access_at', { withTimezone: true }),
    // The shared-session handle this link came from (migration 0004): kept so the platform can still be asked about
    // *this* session after the browser's cookie is gone, which is the only way "they signed out" and "the hour ran
    // out" can be told apart here (`packages/db/migrations/0004_session_platform_bridge.sql`).
    platformBridge: text('platform_bridge'),
  },
  (t) => ({
    expiryIdx: index('sessions_expiry_idx').on(t.expiresAt),
    userIdx: index('sessions_user_idx').on(t.userId, t.lastUsedAt),
  }),
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    ownerKind: ownerKind('owner_kind').notNull(),
    tenantId: uuid('tenant_id'),
    jobId: uuid('job_id'),
    name: text('name').notNull(),
    detectedType: text('detected_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    pages: integer('pages'),
    encrypted: boolean('encrypted').notNull().default(false),
    checksumSha256: text('checksum_sha256').notNull(),
    status: fileStatus('status').notNull().default('staged'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index('files_expiry_idx').on(t.expiresAt),
    ownerIdx: index('files_owner_idx').on(t.ownerId, t.createdAt),
    jobIdx: index('files_job_idx').on(t.jobId),
  }),
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    tool: text('tool').notNull(),
    category: text('category').notNull(),
    status: jobStatus('status').notNull().default('QUEUED'),
    phase: jobPhase('phase').notNull().default('queued'),
    queue: text('queue').notNull(),
    priority: integer('priority').notNull().default(10),
    progress: smallint('progress').notNull().default(0),
    ownerId: text('owner_id').notNull(),
    ownerKind: ownerKind('owner_kind').notNull(),
    userId: uuid('user_id'),
    tenantId: uuid('tenant_id'),
    anonId: text('anon_id'),
    apiKeyId: uuid('api_key_id'),
    planId: planIdEnum('plan_id').notNull().default('anonymous'),
    options: jsonb('options').notNull().default({}),
    module: text('module'),
    inputFiles: integer('input_files').notNull().default(1),
    inputBytes: bigint('input_bytes', { mode: 'number' }).notNull().default(0),
    inputPages: integer('input_pages').notNull().default(0),
    outputBytes: bigint('output_bytes', { mode: 'number' }),
    outputPages: integer('output_pages'),
    outputParts: integer('output_parts'),
    outputMime: text('output_mime'),
    outputName: text('output_name'),
    resultParts: jsonb('result_parts'),
    metrics: jsonb('metrics'),
    warnings: jsonb('warnings').notNull().default([]),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    engineName: text('engine_name'),
    engineVersion: text('engine_version'),
    workerId: text('worker_id'),
    attempts: smallint('attempts').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index('jobs_expiry_idx').on(t.status, t.expiresAt),
    tenantIdx: index('jobs_tenant_idx').on(t.tenantId, t.createdAt),
    ownerIdx: index('jobs_owner_idx').on(t.ownerId, t.createdAt),
    anonIdx: index('jobs_anon_idx').on(t.anonId, t.createdAt),
    toolIdx: index('jobs_tool_idx').on(t.tool, t.createdAt),
  }),
);

export const jobEvents = pgTable(
  'job_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    status: jobStatus('status'),
    phase: jobPhase('phase'),
    progress: smallint('progress'),
    message: text('message'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobSeqIdx: index('job_events_job_idx').on(t.jobId, t.seq),
    createdIdx: index('job_events_created_idx').on(t.createdAt),
    uniqSeq: unique('job_events_job_id_seq_key').on(t.jobId, t.seq),
  }),
);

export const plans = pgTable('plans', {
  id: planIdEnum('id').primaryKey(),
  name: text('name').notNull(),
  maxFileMb: integer('max_file_mb').notNull(),
  maxJobMb: integer('max_job_mb').notNull(),
  maxPages: integer('max_pages').notNull(),
  maxFiles: integer('max_files').notNull(),
  jobsPerWindow: integer('jobs_per_window').notNull(),
  windowSeconds: integer('window_seconds').notNull(),
  maxConcurrent: smallint('max_concurrent').notNull(),
  queuePriority: smallint('queue_priority').notNull(),
  resultTtlMinutes: integer('result_ttl_minutes').notNull(),
  historyDays: integer('history_days').notNull().default(0),
  maxApiKeys: smallint('max_api_keys').notNull().default(0),
  tools: jsonb('tools').notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    userId: uuid('user_id'),
    planId: planIdEnum('plan_id').notNull(),
    limits: jsonb('limits').notNull(),
    tools: jsonb('tools').notNull(),
    priority: smallint('priority').notNull(),
    source: entitlementSrc('source').notNull().default('auth_platform'),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqOwner: unique('entitlements_tenant_user_key').on(t.tenantId, t.userId) }),
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    userId: uuid('user_id'),
    anonId: text('anon_id'),
    apiKeyId: uuid('api_key_id'),
    planId: planIdEnum('plan_id').notNull(),
    tool: text('tool').notNull(),
    metric: usageMetric('metric').notNull(),
    value: numeric('value', { precision: 20, scale: 4 }).notNull(),
    unit: text('unit').notNull(),
    source: text('source').notNull().default('job'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('usage_tenant_time_idx').on(t.tenantId, t.occurredAt),
    userIdx: index('usage_user_time_idx').on(t.userId, t.occurredAt),
    anonIdx: index('usage_anon_time_idx').on(t.anonId, t.occurredAt),
    toolIdx: index('usage_tool_time_idx').on(t.tool, t.occurredAt),
  }),
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    ownerId: text('owner_id').notNull(),
    requestHash: text('request_hash').notNull(),
    jobId: uuid('job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({ expiryIdx: index('idempotency_expiry_idx').on(t.expiresAt) }),
);
