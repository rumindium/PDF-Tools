import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { config } from '@pdftools/config';
import type { UploadedFile } from '@pdftools/contracts';
import { getDb, schema } from '@pdftools/db';
import { AppError } from '@pdftools/errors';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { ensureDir, jobInputDir, removeDir, stagingPath } from '../infrastructure/storage';
import { detectType } from '../shared/detect-type';
import { sanitizeDisplayName } from '../shared/filenames';
import { probePdf } from '../shared/pdf-probe';
import type { OwnerIdentity, WorkIdentity } from './quota-service';

/**
 * Upload lifetime: bytes land in `staging/`, a row records what we detected, and nothing is claimed until a job
 * asks for it. Unclaimed uploads are swept after `UPLOAD_TTL_MINUTES`, which is why the sweeper checks
 * `files.status = 'staged'` rather than trusting a timer.
 */

const MAX_NAME_LENGTH = 180;

export async function storeUpload(
  // `WorkIdentity`, not `OwnerIdentity`: this is the function that writes `owner_id`, and a guest has no id to
  // write. The type is the guard — the upload route cannot reach this line without having passed
  // `assertCreationAllowed` (`services/access-policy.ts`), which is what makes the refusal structural rather than
  // something a reader has to trust.
  identity: WorkIdentity,
  streamed: {
    tempPath: string;
    originalName: string;
    declaredType: string;
    sizeBytes: number;
    checksumSha256: string;
  },
): Promise<UploadedFile> {
  const detected = await detectType(streamed.tempPath);
  if (detected.family === 'unknown') {
    await removeDir(streamed.tempPath);
    throw new AppError('UNSUPPORTED_FILE_TYPE', 'That file type is not supported.', {
      name: sanitizeDisplayName(streamed.originalName),
    });
  }

  const id = randomUUID();
  const finalPath = stagingPath(id);
  await ensureDir(config.storage.stagingDir);
  await rename(streamed.tempPath, finalPath);

  // A password-protected PDF is still stored: the unlock flow needs the original bytes, and discarding a
  // 200 MB protected file so the user has to upload it again would be hostile. The flag is what tool
  // validation reads to decide whether a password option is required.
  const probe = detected.family === 'pdf' ? await probePdf(finalPath) : { encrypted: false, pages: null };

  const displayName = sanitizeDisplayName(streamed.originalName || `upload${detected.ext}`, MAX_NAME_LENGTH);
  const expiresAt = new Date(Date.now() + config.storage.uploadTtlMinutes * 60_000);

  await getDb().insert(schema.files).values({
    id,
    ownerId: identity.ownerId,
    ownerKind: identity.kind,
    tenantId: identity.tenantId,
    name: displayName,
    detectedType: detected.mime,
    sizeBytes: streamed.sizeBytes,
    pages: probe.pages,
    encrypted: probe.encrypted,
    checksumSha256: streamed.checksumSha256,
    status: 'staged',
    expiresAt,
  });

  return {
    id,
    name: displayName,
    detectedType: detected.mime,
    sizeBytes: streamed.sizeBytes,
    pages: probe.pages,
    encrypted: probe.encrypted,
    checksumSha256: streamed.checksumSha256,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function loadFile(id: string, identity: OwnerIdentity) {
  // A guest owns no upload, and the answer is the one a stranger's id gets — see `getJob` in `job-service.ts` for
  // why not-found is the right refusal on a read path.
  if (identity.kind === 'guest') throw new AppError('FILE_NOT_FOUND');

  const rows = await getDb().select().from(schema.files).where(eq(schema.files.id, id)).limit(1);
  const file = rows[0];
  if (!file) throw new AppError('FILE_NOT_FOUND');
  if (file.ownerId !== identity.ownerId) throw new AppError('FORBIDDEN', 'That upload belongs to another session.');
  if (file.expiresAt.getTime() < Date.now()) throw new AppError('FILE_NOT_FOUND', 'That upload has expired.');
  return { ...file, path: stagingPath(file.id) };
}

export async function deleteFile(id: string, identity: OwnerIdentity): Promise<void> {
  const file = await loadFile(id, identity);
  await getDb().update(schema.files).set({ status: 'purged' }).where(eq(schema.files.id, id));
  await removeDir(file.path);
}

/**
 * Move an upload into the job's input directory.
 *
 * The bytes are *copied*, not moved, so the same upload can be used by a second job
 * (`docs/0-QUEUE-AND-JOBS.md` §10) and so a purge of one job can never break another.
 */
export async function claimFileForJob(
  fileId: string,
  jobId: string,
  identity: OwnerIdentity,
): Promise<{
  id: string;
  name: string;
  storedPath: string;
  sizeBytes: number;
  pages: number | null;
  checksumSha256: string;
  detectedType: string;
}> {
  const file = await loadFile(fileId, identity);
  const inputDir = await ensureDir(jobInputDir(jobId));
  const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '';
  const storedPath = `${inputDir}/${fileId}${ext}`;
  await Bun.write(storedPath, Bun.file(file.path));

  await getDb().update(schema.files).set({ jobId, status: 'claimed' }).where(eq(schema.files.id, fileId));

  return {
    id: file.id,
    name: file.name,
    storedPath,
    sizeBytes: file.sizeBytes,
    pages: file.pages,
    checksumSha256: file.checksumSha256,
    detectedType: file.detectedType,
  };
}

/** Staging entries whose upload row is gone or expired — the sweeper's cleanup list. */
export async function purgeStaleUploads(maxAgeMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const rows = await getDb()
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.status, 'staged'),
        lt(schema.files.createdAt, cutoff),
        lt(schema.files.expiresAt, new Date()),
      ),
    )
    .limit(500);

  for (const row of rows) {
    await removeDir(stagingPath(row.id));
  }
  if (rows.length > 0) {
    await getDb()
      .update(schema.files)
      .set({ status: 'purged' })
      .where(
        inArray(
          schema.files.id,
          rows.map((r) => r.id),
        ),
      );
  }
  return rows.length;
}

/** Staged bytes on disk with no database row at all — an interrupted upload. */
export async function purgeOrphanStaging(ids: string[]): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    await removeDir(stagingPath(id));
    removed += 1;
  }
  return removed;
}
