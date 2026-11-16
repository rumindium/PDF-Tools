import { createHmac, randomUUID } from 'node:crypto';
import { config } from '@pdftools/config';
import {
  type JobView,
  type ToolDefinition,
  type ToolQueue,
  acceptsType,
  effectiveQueue,
  effectiveTimeoutSeconds,
  evaluatePasswordStrength,
  extractSecrets,
  getTool,
  redactSecrets,
  secretKeysFor,
  secretStashTtlSeconds,
  strongPasswordsRequired,
  validateOptions,
} from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { AppError } from '@pdftools/errors';
import { PRIORITY_BY_PLAN, createQueue, queueForTool, redisConnection } from '@pdftools/queue';
import { cancelKey, lockKey, purgeJobReveal, purgeJobSecrets, stashJobSecrets } from '@pdftools/queue';
import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { ensureDir, jobOutputDir, removeDir } from '../infrastructure/storage';
import { deriveOutputName } from '../shared/filenames';
import { recordEvent } from './event-service';
import { claimFileForJob, loadFile } from './file-service';
import {
  type OwnerIdentity,
  type WorkIdentity,
  assertConcurrencyAvailable,
  assertQuotaAvailable,
  effectivePlanId,
  limitsFor,
} from './quota-service';

/**
 * Job creation is where every rejection happens (`docs/0-API.md` §4.1) — a job that reaches a worker with an
 * unacceptable input is a bug, not a user error, so all validation lives here:
 *
 *   tool exists and is enabled → plan allows it → options schema → password policy → files exist and are owned →
 *   size limits → page limit → quota → concurrency → enqueue
 */

export interface CreateJobInput {
  tool: string;
  files: string[];
  options?: unknown;
  retainMinutes?: number;
  callbackUrl?: string;
  priority?: number;
  idempotencyKey?: string | null;
  module?: string | null;
}

export interface CreatedJob {
  id: string;
  tool: string;
  status: 'QUEUED';
  /**
   * The queue **name** (`pdf-heavy`), not the pool id (`heavy`).
   *
   * One spelling, because there are two consumers and they must agree: `GET /jobs/:id` reports the stored name,
   * and the web UI renders whichever it is handed. Typing this as `ToolQueue` let the create path return the pool
   * while the idempotent replay path returned the name — the same endpoint answering two ways, hidden behind a
   * cast. The column, the detail endpoint, the pool config and the logs all use the name, so the name wins.
   */
  queue: string;
  priority: number;
  estimatedSeconds: number | null;
  expiresAt: string;
  eventsUrl: string;
}

/**
 * The idempotency fingerprint of a submission.
 *
 * **Keyed, not plain.** A hash of the request is a hash of whatever the request contained, and for three tools that
 * includes a password the caller typed — a *fast* SHA-256 of a password is a password hash in the sense a password
 * cracker cares about, and it sits in a table whose whole purpose is to be looked up. Anyone holding a dump could
 * confirm a guessed password offline, because the tool id and the file ids are in the same row. The payload is
 * therefore domain-separated and hashed with the installation's secret (`SESSION_SECRET`), which restores the
 * property that matters: the value is a fingerprint only for someone who already has the deployment's key material.
 *
 * The input is still hashed *with* the password rather than after redacting it, so the semantics are unchanged: a
 * retry that changes the password is a different request and gets a `CONFLICT`, not the previous job. Rows written
 * before this change simply stop matching, which costs at most one re-submission inside the 24 h idempotency window.
 */
function requestHash(input: CreateJobInput): string {
  return createHmac('sha256', config.session.secret)
    .update('pdftools.idempotency.v1\u0000')
    .update(JSON.stringify({ tool: input.tool, files: input.files, options: input.options ?? {} }))
    .digest('hex');
}

/** A file the job carries. Documents come from the request; attachments are named by an option. */
type LoadedFile = Awaited<ReturnType<typeof loadFile>>;

interface AttachmentFile extends LoadedFile {
  kind: 'attachment';
  attachmentOption: string;
}

function isAttachment(file: LoadedFile | AttachmentFile): file is AttachmentFile {
  return (file as AttachmentFile).kind === 'attachment';
}

/**
 * Resolve the uploads a tool names by option (`ToolAuxiliaryFile`, e.g. `watermark.imageFileId`) into attachments.
 *
 * The id comes from the user's own upload, so it is loaded through the same ownership and expiry check as a
 * document: an option must never become a way to read a file that belongs to someone else.
 *
 * **Two declaration shapes**, because one tool's uploads live inside an array of elements rather than at the top level.
 * `watermark.imageFileId` is a plain option key; `edit-pdf.elements[].fileId` names the ids *inside* the element list,
 * one per image element. The `[]` is parsed rather than special-cased so the rule stays one sentence: a declaration
 * whose option contains `[]` is resolved against every entry of that array, and the file id is collected from the
 * field named after the dot. Without this, `edit-pdf`'s image elements would be the only option surface in the
 * registry that no loader can reach — and the handler would reject every one of them with `IMAGE_REQUIRED` even
 * though the caller uploaded the image.
 *
 * Duplicate ids collapse: the same image used on forty pages is one attachment, not forty. That matters because the
 * file is staged and SHA-256 verified per attachment, and because the handler matches its element to an attachment by
 * id — so a second copy would be bytes moved for nothing.
 *
 * Every failure is reported as `IMAGE_REQUIRED` — the code `docs/11-WATERMARK.md` §3 defines for it — because the
 * remedy is always the same (upload the image again). Answering `FILE_NOT_FOUND` for a missing id and `FORBIDDEN`
 * for someone else's would also let a caller probe which file ids exist.
 */
async function loadAuxiliaryFiles(
  def: ToolDefinition,
  options: Record<string, unknown>,
  identity: OwnerIdentity,
): Promise<AttachmentFile[]> {
  const attachments: AttachmentFile[] = [];
  const seen = new Set<string>();

  for (const declaration of def.auxiliaryFiles ?? []) {
    for (const value of resolveDeclaredIds(options, declaration.option)) {
      // Absent means "no attachment". Whether it was *required* is the schema's business: it already refuses
      // `kind=image` without an image id, and repeating that rule here would give one mistake two messages.
      if (value == null) continue;
      if (typeof value !== 'string') {
        throw new AppError('IMAGE_REQUIRED', `${declaration.label} must be the id of an uploaded file.`);
      }
      if (seen.has(value)) continue;

      const file = await loadFile(value, identity).catch(() => null);
      if (!file) {
        throw new AppError(
          'IMAGE_REQUIRED',
          `${declaration.label} was not found. Upload it and use the id that comes back.`,
        );
      }
      if (!declaration.accepts.includes(file.detectedType)) {
        throw new AppError(
          'IMAGE_REQUIRED',
          `${declaration.label} must be one of: ${declaration.accepts.join(', ')}.`,
          {
            detectedType: file.detectedType,
          },
        );
      }

      seen.add(value);
      attachments.push({ ...file, kind: 'attachment', attachmentOption: declaration.option });
    }
  }
  return attachments;
}

/**
 * The file ids one declaration names: the option itself, or the field inside every entry of an array option.
 *
 * An array option that is missing or is not an array yields nothing rather than throwing, because "there is no element
 * list" is a validation failure the schema has already reported with a better message than this loader could.
 */
function resolveDeclaredIds(options: Record<string, unknown>, option: string): unknown[] {
  const nested = /^([A-Za-z0-9_]+)\[\]\.([A-Za-z0-9_]+)$/.exec(option);
  if (!nested) return [options[option]];

  const [, key, field] = nested;
  const list = options[key!];
  if (!Array.isArray(list)) return [];
  return list.map((entry) =>
    entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[field!] : undefined,
  );
}

export async function createJob(identity: WorkIdentity, input: CreateJobInput): Promise<CreatedJob> {
  const db = getDb();
  const def = getTool(input.tool);
  if (!def)
    throw new AppError('VALIDATION_ERROR', `Unknown tool: ${input.tool}`, {
      issues: [{ path: 'tool', message: 'Unknown tool' }],
    });
  if (!def.enabled || config.flags[def.id] === false) {
    throw new AppError('TOOL_DISABLED', `${def.title} is not available in this build yet.`);
  }

  const limits = await limitsFor(identity);

  // Two independent gates, both must pass:
  //   1. the entitlement's tool list (mirrored from Auth Platform) must include the tool;
  //   2. the tool's own plan gate must not exclude this plan — a wildcard entitlement never overrides
  //      a Pro-only tool, because that gate exists precisely to survive a mis-seeded entitlement.
  // The plan gate is evaluated against the *effective* plan, which is the account's plan except on a dev stack that
  // granted the session one (`effectivePlanId`). One function, used by the quota resolver too, so a gated tool can
  // never look open because two places disagreed about which plan was in play.
  const plan = effectivePlanId(identity);
  const inEntitlement = limits.tools.includes('*') || limits.tools.includes(def.id);
  const passesPlanGate = !def.plans || def.plans.length === 0 || def.plans.includes(plan as 'pro' | 'business');
  if (!inEntitlement || !passesPlanGate) {
    throw new AppError('TOOL_NOT_IN_PLAN', `${def.title} is not part of the ${limits.name} plan.`, {
      planId: plan,
      tool: def.id,
      ...(def.plans?.length ? { requiresPlan: def.plans } : {}),
    });
  }

  // ── Options ──────────────────────────────────────────────────────────────
  // Validated before the files, because it is the cheapest rejection and the one whose message the user can act
  // on: a job that is missing its watermark image should not be told first that its PDF is too large.
  const validation = validateOptions(def.id, input.options ?? {});
  if (!validation.ok) {
    throw new AppError('VALIDATION_ERROR', undefined, { issues: validation.issues });
  }

  // ── Password policy ──────────────────────────────────────────────────────
  // The passwords this tool *sets* are judged here, because this is the only layer that knows the caller's plan — a
  // worker never sees it, which is why the handler's half of this rule is the warning rather than the refusal
  // (`workers/light/src/handlers/security.ts`). The resolved requirement is written back into the options below, so
  // the warning and the refusal are decided by the same verdict instead of two guesses at the same plan.
  const passwordOptions = validation.options as Record<string, unknown>;
  const requireStrongPasswords = strongPasswordsRequired(plan, passwordOptions.requireStrongPasswords === true);
  for (const key of def.setsPasswords ?? []) {
    const value = passwordOptions[key];
    if (typeof value !== 'string') continue;
    const strength = evaluatePasswordStrength(value);
    if (strength.belowFloor || (requireStrongPasswords && !strength.meetsPolicy)) {
      throw new AppError('WEAK_PASSWORD', undefined, {
        option: key,
        length: strength.length,
        classes: strength.classes,
        issues: strength.issues,
        planId: plan,
        requireStrongPasswords,
      });
    }
  }

  // ── Secrets ──────────────────────────────────────────────────────────────
  // Everything that leaves this function in a durable form goes through here: the job row, the queue payload, and
  // the dead-letter copy BullMQ keeps of a failed payload. The real value goes to a Redis key whose TTL is the
  // job's own budget (`packages/contracts/src/tools/secrets.ts`), and is what the worker merges back in.
  //
  // Extracted from the *validated* options, not from the request body: a password the schema rejected is not a
  // password this job has, and stashing it would hand the handler a value the API already refused.
  const secretOptions = validation.options as Record<string, unknown>;
  // The resolved policy decision rides along in the persisted options. It is not a secret, the worker cannot re-derive
  // it (the plan is not part of its payload), and the warning it drives has to describe the *same* verdict that let the
  // job through — a second guess at the plan in the handler is exactly how a job ends up warning about a rule that was
  // enforced differently. Tools whose passwords are not policy-governed get nothing added, so the key's presence is
  // itself the statement "this tool's passwords were judged".
  const persistableOptions = {
    ...redactSecrets(def, secretOptions),
    ...((def.setsPasswords?.length ?? 0) > 0 ? { requireStrongPasswords } : {}),
  };
  const hasDeclaredSecrets = secretKeysFor(def).length > 0;

  // ── Files ────────────────────────────────────────────────────────────────
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Provide at least one file id.', {
      issues: [{ path: 'files', message: 'Required' }],
    });
  }
  if (input.files.length < def.input.minFiles || input.files.length > def.input.maxFiles) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${def.title} takes between ${def.input.minFiles} and ${def.input.maxFiles} files.`,
      {
        issues: [{ path: 'files', message: `Expected ${def.input.minFiles}–${def.input.maxFiles} files` }],
      },
    );
  }

  const loaded = [];
  for (const fileId of input.files) {
    const file = await loadFile(fileId, identity);
    if (!acceptsType(def, file.detectedType)) {
      throw new AppError('UNSUPPORTED_FILE_TYPE', `${def.title} does not accept ${file.detectedType}.`, {
        detectedType: file.detectedType,
        accepts: def.input.accepts,
      });
    }
    // "Does this tool accept a password?" is answered from the same `optionsUi` the form renders, rather than by
    // reaching into the zod schema: one source of truth for what the tool can do, and it cannot disagree with what
    // the user was shown.
    const acceptsPassword = def.optionsUi.some((field) => field.control === 'password');
    if (file.encrypted && !acceptsPassword) {
      throw new AppError('ENCRYPTED_INPUT', undefined, { fileId: file.id });
    }
    loaded.push(file);
  }

  // ── Uploads named by options ─────────────────────────────────────────────
  loaded.push(...(await loadAuxiliaryFiles(def, validation.options as Record<string, unknown>, identity)));

  const perFileLimitMb = Math.min(def.input.maxFileMb, limits.maxFileMb);
  for (const file of loaded) {
    if (file.sizeBytes > perFileLimitMb * 1024 * 1024) {
      throw new AppError('FILE_TOO_LARGE', undefined, {
        limitMb: perFileLimitMb,
        receivedMb: Math.round((file.sizeBytes / 1024 / 1024) * 10) / 10,
        planId: effectivePlanId(identity),
      });
    }
  }

  const totalBytes = loaded.reduce((sum, f) => sum + f.sizeBytes, 0);
  if (totalBytes > limits.maxJobMb * 1024 * 1024) {
    throw new AppError('JOB_SIZE_EXCEEDED', undefined, {
      limitMb: limits.maxJobMb,
      receivedMb: Math.round(totalBytes / 1024 / 1024),
    });
  }

  // The page limit is enforced here when the count is known, and **carried to the worker** for when it is not. `null`
  // means "we could not tell from the bytes", and the payload's `planMaxPages` is what lets the worker apply the same
  // ceiling to the count it reads from the file (step 5, `0-QUEUE-AND-JOBS.md` §3). Without it the limit was skipped
  // for exactly the documents the scan cannot size — the ceiling existed only in the layer that could not count
  // (defect 154: a Free account's 620-page document ran, because `maxPages` as it reached a worker was the *tool's*
  // cap from the catalog, `0` for every tool in the registry).
  //
  // Attachments are excluded from the count on purpose: an image has no pages, so including one would make the
  // count "unknown" for every image watermark — quietly switching the plan's page limit off for precisely the jobs
  // that carry one.
  const documents = loaded.filter((file) => !isAttachment(file));
  const knownPages = documents.reduce((sum, f) => sum + (f.pages ?? 0), 0);
  const pagesUnknown = documents.some((f) => f.pages == null);
  if (!pagesUnknown && knownPages > limits.maxPages) {
    throw new AppError('PAGE_LIMIT_EXCEEDED', undefined, { pages: knownPages, limit: limits.maxPages });
  }

  // ── Quota and concurrency ────────────────────────────────────────────────
  await assertQuotaAvailable(identity, limits);
  await assertConcurrencyAvailable(identity, limits);

  // ── Idempotency ──────────────────────────────────────────────────────────
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const hash = requestHash(input);
  if (idempotencyKey) {
    const existing = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, idempotencyKey))
      .limit(1);
    const row = existing[0];
    if (row) {
      if (row.requestHash !== hash) {
        throw new AppError('CONFLICT', 'That idempotency key was used with a different request.');
      }
      if (row.jobId) {
        const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, row.jobId)).limit(1);
        if (job) {
          return {
            id: job.id,
            tool: job.tool,
            status: 'QUEUED',
            queue: job.queue,
            priority: job.priority,
            estimatedSeconds: null,
            expiresAt: job.expiresAt.toISOString(),
            eventsUrl: `/api/v1/jobs/${job.id}/events`,
          };
        }
      }
    }
  }

  // ── Route ────────────────────────────────────────────────────────────────
  // Escalation counts *documents*: `aboveFiles` exists for "this is a 30-file merge", and an attachment the user
  // never picked as a document is not one of those files.
  const queue = effectiveQueue(def, {
    pages: knownPages || undefined,
    bytes: totalBytes,
    files: documents.length,
  });
  // `noUncheckedIndexedAccess` is on, and it is right to be: an unknown plan id falls back to the *lowest*
  // priority rather than to `undefined`, which would otherwise reach the database as a NOT NULL violation.
  const priority = (identity.kind === 'api_key' ? PRIORITY_BY_PLAN.api_key : PRIORITY_BY_PLAN[plan]) ?? 10;
  const retainMinutes = Math.min(input.retainMinutes ?? limits.resultTtlMinutes, limits.resultTtlMinutes);

  const jobId = randomUUID();
  const expiresAt = new Date(Date.now() + retainMinutes * 60_000);
  await ensureDir(jobOutputDir(jobId));

  const attachmentOptions = new Map(
    loaded.filter(isAttachment).map((file) => [file.id, file.attachmentOption] as const),
  );

  const claims = [];
  for (const file of loaded) {
    claims.push(await claimFileForJob(file.id, jobId, identity));
  }

  await db.insert(schema.jobs).values({
    id: jobId,
    tool: def.id,
    category: def.category,
    status: 'QUEUED',
    phase: 'queued',
    queue: queueForTool(queue),
    priority,
    ownerId: identity.ownerId,
    ownerKind: identity.kind,
    userId: identity.userId,
    tenantId: identity.tenantId,
    anonId: identity.anonId,
    // The effective plan, not the account's: this row is the record of *which limits were applied*, and a job run
    // under a granted plan really was run under that plan's page ceiling, timeout and priority.
    planId: plan,
    // The placeholder, never `validation.options`: this column is the record that outlives the request.
    options: persistableOptions,
    module: input.module ?? null,
    inputFiles: claims.length,
    inputBytes: totalBytes,
    inputPages: knownPages,
    warnings: [],
    expiresAt,
  });

  await recordEvent({
    jobId,
    type: 'status',
    status: 'QUEUED',
    phase: 'queued',
    progress: 0,
    message: 'Job accepted and queued.',
  });

  if (idempotencyKey) {
    await db
      .insert(schema.idempotencyKeys)
      .values({
        key: idempotencyKey,
        ownerId: identity.ownerId,
        requestHash: hash,
        jobId,
        expiresAt: new Date(Date.now() + config.limits.idempotencyTtlHours * 3600_000),
      })
      .onConflictDoNothing();
  }

  const queueHandle = createQueue(queue);
  try {
    // Stashed *before* the job becomes claimable, which is the only ordering that has no race in it: `add` is what
    // makes a worker able to see the job, so a worker that can see it can already read its secret.
    if (hasDeclaredSecrets) {
      // The TTL is derived from the **longest** budget this job could end up with, not the one it was routed with:
      // the worker escalates a job to `heavy` (with the heavier budget) after it knows the real sizes, and a stash
      // that expired under the escalated attempt would fail the job for a reason that has nothing to do with it.
      const longestBudget = Math.max(effectiveTimeoutSeconds(def, queue), def.escalate?.timeoutSeconds ?? 0);
      await stashJobSecrets(
        jobId,
        extractSecrets(def, secretOptions),
        secretStashTtlSeconds(longestBudget, config.queue.maxAttempts),
      );
    }
    await queueHandle.add(
      def.id,
      {
        jobId,
        tool: def.id,
        queue,
        priority,
        ownerKind: identity.kind,
        planId: plan,
        // Redacted here too. The payload is transient but not ephemeral: `removeOnFail` keeps a failed one for a
        // day, which is exactly the window a password must not survive in.
        options: persistableOptions,
        files: claims.map((c) => ({
          id: c.id,
          name: c.name,
          // The type the API detected from the bytes, so a worker can make a policy decision about the file rather than
          // about its name alone (`packages/queue/src/runtime.ts`).
          detectedType: c.detectedType,
          sizeBytes: c.sizeBytes,
          pages: c.pages,
          checksumSha256: c.checksumSha256,
          storedPath: c.storedPath,
          // Only set for attachments, so a handler looks one up by the option that named it instead of by position
          // — the order of `input.files` is the user's, and inferring "the second file is the logo" breaks the day
          // a tool takes two documents.
          ...(attachmentOptions.has(c.id)
            ? { kind: 'attachment' as const, attachmentOption: attachmentOptions.get(c.id) }
            : {}),
        })),
        limits: {
          // The budget follows the pool the job was routed to, not the pool the tool is declared on: an escalated
          // job is one that is *expected* to need longer (`01-MERGE.md` §7).
          timeoutSeconds: effectiveTimeoutSeconds(def, queue),
          memoryMb: def.limits.memoryMb,
          maxPages: def.limits.maxPages,
          // The plan's ceiling, not the tool's: the worker reads the real page count at claim time, and this is the
          // number it compares that count against. The job row records the same plan (`planId`), so the two agree.
          planMaxPages: limits.maxPages,
        },
        retentionTtlMinutes: retainMinutes,
        createdAt: new Date().toISOString(),
      },
      { jobId, priority },
    );
  } catch (error) {
    // The row exists but the queue does not: fail the job honestly instead of leaving a QUEUED ghost that the
    // user watches forever. A worker reaching a missing payload cannot happen because the row is what a client
    // reads; the reverse (a payload with no worker) is the survivable direction.
    await db
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: 'WORKER_UNAVAILABLE', errorMessage: 'The job queue is unavailable.' })
      .where(eq(schema.jobs.id, jobId));
    await recordEvent({
      jobId,
      type: 'error',
      status: 'FAILED',
      payload: { code: 'WORKER_UNAVAILABLE' },
      message: 'The job queue is unavailable.',
    });
    // The job will never run, so the value it was holding has no reason to exist any more. The TTL would have
    // removed it anyway; waiting for that would keep a caller's password in Redis for the length of a time budget
    // nothing is going to use.
    await purgeJobSecrets(jobId).catch(() => 0);
    throw new AppError('WORKER_UNAVAILABLE', undefined, { cause: String(error) });
  } finally {
    await queueHandle.close();
  }

  return {
    id: jobId,
    tool: def.id,
    status: 'QUEUED',
    queue: queueForTool(queue),
    priority,
    estimatedSeconds: estimateSeconds(def.id, knownPages),
    expiresAt: expiresAt.toISOString(),
    eventsUrl: `/api/v1/jobs/${jobId}/events`,
  };
}

function estimateSeconds(tool: string, pages: number): number | null {
  if (!pages) return null;
  const table: Record<string, number> = {
    merge: 0.02,
    split: 0.05,
    'extract-pages': 0.03,
    'delete-pages': 0.03,
    'reorder-pages': 0.04,
    rotate: 0.02,
    'pdf-to-images': 0.35,
    'office-to-pdf': 0.5,
    'pdf-to-pdfa': 0.7,
    ocr: 3.5,
  };
  const perPage = table[tool];
  if (!perPage) return null;
  return Math.max(2, Math.ceil(pages * perPage) + 3);
}

export async function getJob(jobId: string, identity: OwnerIdentity) {
  // A guest owns nothing, and gets the answer a stranger's id gets. Both alternatives are worse: `AUTH_REQUIRED`
  // would make this one route behave unlike its siblings (the read paths are deliberately open —
  // `docs/0-TENANT-FIRST.md` §4.2), and `FORBIDDEN` would confirm that the id belongs to somebody.
  if (identity.kind === 'guest') throw new AppError('JOB_NOT_FOUND');

  const [job] = await getDb()
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.ownerId, identity.ownerId)))
    .limit(1);
  if (!job) throw new AppError('JOB_NOT_FOUND');
  return job;
}

export function toJobView(job: Awaited<ReturnType<typeof getJob>>): JobView {
  const expired = job.expiresAt.getTime() < Date.now() && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status);
  const parts = (job.resultParts ?? []) as Array<{ name: string; bytes: number; mime: string; primary?: boolean }>;
  const downloadUrl = job.status === 'COMPLETED' && !expired ? `/api/v1/jobs/${job.id}/download` : undefined;

  return {
    id: job.id,
    tool: job.tool,
    status: expired ? 'EXPIRED' : job.status,
    progress: job.progress,
    phase: job.phase,
    queue: job.queue,
    priority: job.priority,
    output:
      job.outputBytes != null
        ? {
            bytes: job.outputBytes,
            pages: job.outputPages ?? null,
            parts: job.outputParts ?? parts.length,
            mime: job.outputMime ?? 'application/octet-stream',
            name: job.outputName ?? deriveOutputName('document', '', '.pdf'),
          }
        : null,
    warnings: ((job.warnings ?? []) as Array<{ code: string; detail?: string }>) ?? [],
    error: job.errorCode ? { code: job.errorCode as never, message: job.errorMessage ?? '' } : null,
    engine: job.engineName ? { name: job.engineName, version: job.engineVersion ?? '' } : null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt.toISOString(),
    ...(downloadUrl ? { downloadUrl } : {}),
    eventsUrl: `/api/v1/jobs/${job.id}/events`,
  };
}

export interface ListJobsQuery {
  status?: string[];
  tool?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export async function listJobs(identity: OwnerIdentity, query: ListJobsQuery) {
  // An empty page rather than a refusal: "you have no jobs" is the truth for a caller who cannot have any, and the
  // jobs screen has to be able to render it. Returning `AUTH_REQUIRED` here would make a *list* the thing that
  // teaches a visitor they need an account, which is the gate's job.
  if (identity.kind === 'guest') {
    return {
      items: [] as ReturnType<typeof toJobView>[],
      page: query.page,
      pageSize: query.pageSize,
      total: 0,
      hasMore: false,
    };
  }

  const conditions = [eq(schema.jobs.ownerId, identity.ownerId)];
  if (query.status?.length) {
    conditions.push(inArray(schema.jobs.status, query.status as never[]));
  }
  if (query.tool) conditions.push(eq(schema.jobs.tool, query.tool));
  if (query.from) conditions.push(gte(schema.jobs.createdAt, query.from));
  if (query.to) conditions.push(lte(schema.jobs.createdAt, query.to));

  const db = getDb();
  const [totals] = await db
    .select({ value: count() })
    .from(schema.jobs)
    .where(and(...conditions));
  const rows = await db
    .select()
    .from(schema.jobs)
    .where(and(...conditions))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const total = Number(totals?.value ?? 0);
  return {
    items: rows.map((row) => toJobView(row as never)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasMore: query.page * query.pageSize < total,
  };
}

/**
 * Cancel or purge. The fast path (QUEUED) removes the queued job; the honest path (PROCESSING) sets a flag the
 * worker checks, because a single `qpdf` invocation cannot be interrupted mid-write and pretending otherwise
 * would be a lie the user discovers in the output.
 */
export async function cancelJob(jobId: string, identity: OwnerIdentity): Promise<{ status: string; note: string }> {
  const job = await getJob(jobId, identity);
  const db = getDb();

  if (job.status === 'QUEUED') {
    const queue = createQueue(job.queue as ToolQueue);
    try {
      const queued = await queue.getJob(jobId);
      await queued?.remove();
    } catch {
      /* already claimed or gone */
    } finally {
      await queue.close();
    }
    await removeDir(`${config.storage.tempDir}/${jobId}/input`).catch(() => {});
    // A job cancelled before a worker claimed it never gets the chance to purge its own stash.
    await purgeJobSecrets(jobId).catch(() => 0);
    await db
      .update(schema.jobs)
      .set({ status: 'CANCELLED', phase: 'done', completedAt: new Date() })
      .where(eq(schema.jobs.id, jobId));
    await recordEvent({
      jobId,
      type: 'status',
      status: 'CANCELLED',
      phase: 'done',
      message: 'Cancelled before a worker claimed it.',
    });
    return { status: 'CANCELLED', note: 'Removed from the queue before a worker claimed it.' };
  }

  if (job.status === 'PROCESSING') {
    await db.update(schema.jobs).set({ cancelRequested: true }).where(eq(schema.jobs.id, jobId));
    await redisConnection().set(cancelKey(jobId), '1', 'EX', 3600);
    await recordEvent({
      jobId,
      type: 'status',
      status: 'PROCESSING',
      message: 'Cancellation requested; the worker will stop at the next checkpoint.',
    });
    return {
      status: 'PROCESSING',
      note: 'Cancellation requested. The current engine step cannot be interrupted and will finish; the result will be discarded.',
    };
  }

  await removeDir(`${config.storage.tempDir}/${jobId}`).catch(() => {});
  await purgeJobSecrets(jobId).catch(() => 0);
  // The value the caller was given belongs to the file being deleted here: purging the result and leaving the password
  // behind would be holding a key to something that no longer exists.
  await purgeJobReveal(jobId).catch(() => 0);
  await redisConnection()
    .del(lockKey(jobId))
    .catch(() => 0);
  return { status: job.status, note: 'Result files were purged. The job record is kept for history.' };
}
