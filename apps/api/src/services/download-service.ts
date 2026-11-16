import { join } from 'node:path';
import { config } from '@pdftools/config';
import { AppError } from '@pdftools/errors';
import { jobOutputDir } from '../infrastructure/storage';
import { assertSafePartName, contentDisposition } from '../shared/filenames';
import { getJob } from './job-service';
import type { OwnerIdentity } from './quota-service';

/**
 * Download resolution (`docs/0-API.md` §4.5).
 *
 * The client never sends a path — it sends a job id and, optionally, a part index. The path is rebuilt here from
 * the job row, and every part name is validated against a strict allow-list before it is joined, so even a
 * poisoned database row cannot make this serve `/etc/passwd`.
 */

export interface ResolvedPart {
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

interface StoredPart {
  name: string;
  bytes: number;
  mime: string;
  primary?: boolean;
  pages?: number[];
}

export async function resolveDownload(
  jobId: string,
  identity: OwnerIdentity,
  partParam?: string,
): Promise<{ part: ResolvedPart; parts: StoredPart[] }> {
  const job = await getJob(jobId, identity);

  if (job.status !== 'COMPLETED') {
    if (job.status === 'FAILED' || job.status === 'CANCELLED') {
      throw new AppError('JOB_CANCELLED', 'That job did not produce a result.');
    }
    throw new AppError('CONFLICT', 'The job has not finished yet.');
  }
  if (job.expiresAt.getTime() < Date.now()) {
    throw new AppError('JOB_EXPIRED');
  }

  const parts = ((job.resultParts ?? []) as StoredPart[]).filter((p) => p && typeof p.name === 'string');
  if (parts.length === 0) {
    throw new AppError('INTERNAL_ERROR', 'The job has no recorded output.');
  }

  const outputDir = jobOutputDir(job.id);
  const primary = parts.find((p) => p.primary) ?? parts[0]!;

  if (partParam === 'archive') {
    const archiveName = 'parts.zip';
    const path = join(outputDir, archiveName);
    if (!(await Bun.file(path).exists())) {
      // With a single part an archive is pointless; serving the part itself is friendlier than a 404.
      if (parts.length === 1) {
        const p = parts[0]!;
        return { part: await statPart(outputDir, p), parts };
      }
      throw new AppError('INTERNAL_ERROR', 'The archive for this job is missing.');
    }
    const size = Bun.file(path).size;
    return { part: { path, name: archiveName, mime: 'application/zip', bytes: size }, parts };
  }

  if (partParam != null && /^\d+$/.test(partParam)) {
    const index = Number.parseInt(partParam, 10);
    const chosen = parts[index];
    if (!chosen) throw new AppError('VALIDATION_ERROR', `There is no part ${index} in this job.`);
    return { part: await statPart(outputDir, chosen), parts };
  }

  return { part: await statPart(outputDir, primary), parts };
}

async function statPart(outputDir: string, part: StoredPart): Promise<ResolvedPart> {
  const name = assertSafePartName(part.name);
  const path = join(outputDir, name);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new AppError('JOB_EXPIRED', 'The result file is no longer on disk.');
  }
  return { path, name, mime: part.mime || guessMime(name), bytes: file.size };
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    html: 'text/html',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return table[ext] ?? 'application/octet-stream';
}

/**
 * The media types this API will hand the browser to *render*, rather than to save (`0-API.md` §4.5).
 *
 * An allow-list, not a blocklist, and the difference is the whole security argument: a result produced by this
 * installation may be `text/html` (`pdf-to-html`) and may contain a `<script>`, and an inline HTML response is a
 * document running on this origin. Sniffing is already refused (`nosniff`), so a wrong type cannot become a script by
 * accident — but the type is only wrong for a caller who asked for inline, and a caller who asked does not get to
 * choose what the browser does with the bytes. What is left after the list is content the browser renders as
 * *media*: it can be displayed and cannot execute.
 */
const INLINE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'text/plain',
  'text/csv',
]);

/**
 * Whether the response may be rendered in place, from what the caller asked for and what the part actually is.
 *
 * A refusal is a fallback rather than an error on purpose: `?disposition=inline` is a *hint* from a client that
 * wants to preview, and the correct answer to "preview this zip" is the file, not a 422 explaining that a zip is not
 * a picture. The UI's own preview affordance reads the same list — it only offers to open the types the browser will
 * actually display, so the fallback is the backstop and not the expected path.
 */
export function resolveDisposition(requested: string | undefined, mime: string): 'attachment' | 'inline' {
  if (requested !== 'inline') return 'attachment';
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return INLINE_TYPES.has(base) ? 'inline' : 'attachment';
}

/** Stream the bytes. Headers follow §4.5 exactly, including `no-store` and `nosniff`. */
export async function streamPart(
  part: ResolvedPart,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<Response> {
  const body = Bun.file(part.path).stream();
  return new Response(body, {
    headers: {
      'Content-Type': part.mime,
      'Content-Length': String(part.bytes),
      'Content-Disposition': contentDisposition(part.name, disposition),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'X-Result-Ttl-Minutes': String(config.storage.jobTtlMinutes),
    },
  });
}
