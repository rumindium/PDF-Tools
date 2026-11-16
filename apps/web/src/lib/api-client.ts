import type {
  AdminOverviewBody,
  CreatedJobBody,
  JobListBody,
  JobResultBody,
  JobView,
  MeBody,
  SsoProbeBody,
  SsoSignOutBody,
  UploadedFile,
} from '@pdftools/contracts/api';
import type { Catalog } from '@pdftools/contracts/tools';

/**
 * The single door to the API (`docs/0-FOLDER-STRUCTURE.md` §3, `lib/api-client.ts`).
 *
 * Relative paths only: in development Vite proxies `/api`, in production Caddy does. Nothing here knows the API's
 * origin, which is what keeps the session cookie first-party and the browser free of tokens.
 *
 * Errors are normalised into `ApiError` carrying the API's own `code`, so a screen can branch on
 * `PAGE_LIMIT_EXCEEDED` instead of parsing a message string.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId: string | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }

  /** Field-level issues, when the API rejected an options object. */
  get issues(): Array<{ path: string; message: string }> {
    const raw = this.details?.issues;
    if (!Array.isArray(raw)) return [];
    return raw.filter((i): i is { path: string; message: string } => {
      return typeof i === 'object' && i != null && 'path' in i && 'message' in i;
    });
  }
}

function requestIdOf(response: Response): string | null {
  return response.headers.get('x-request-id');
}

async function toError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR';
  let message = `Request failed with status ${response.status}.`;
  let details: Record<string, unknown> | null = null;

  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.details && typeof body.error.details === 'object') {
      details = body.error.details as Record<string, unknown>;
    }
  } catch {
    /* a non-JSON error body is still an error; the default message stands */
  }

  return new ApiError(code, message, response.status, requestIdOf(response), details);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface UploadOptions {
  kind?: 'input' | 'attachment';
  onProgress?: (percent: number, loadedBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Upload one file with real progress.
 *
 * `XMLHttpRequest` rather than `fetch` because only XHR reports upload progress in every browser; the API's
 * streaming multipart reader means the server never buffers the body, so a 1 GB upload stays flat on both sides
 * and the user still sees a moving bar.
 */
export function uploadFile(file: File, options: UploadOptions = {}): Promise<UploadedFile> {
  return new Promise<UploadedFile>((resolve, reject) => {
    const form = new FormData();
    form.append('kind', options.kind ?? 'input');
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/files', true);
    xhr.withCredentials = true;
    xhr.responseType = 'text';

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !options.onProgress) return;
      options.onProgress(Math.round((event.loaded / event.total) * 100), event.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedFile);
        } catch {
          reject(new ApiError('INTERNAL_ERROR', 'The upload response could not be read.', xhr.status));
        }
        return;
      }
      // Typed explicitly: the upload handler's own local alias would be `null`, and the `as typeof parsed`
      // pattern makes every field below unreadable to the compiler.
      let parsed: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      try {
        parsed = JSON.parse(xhr.responseText) as typeof parsed;
      } catch {
        /* keep the defaults below */
      }
      reject(
        new ApiError(
          parsed?.error?.code ?? 'INTERNAL_ERROR',
          parsed?.error?.message ?? `The upload failed with status ${xhr.status}.`,
          xhr.status,
          xhr.getResponseHeader('x-request-id'),
          (parsed?.error?.details as Record<string, unknown> | undefined) ?? null,
        ),
      );
    };

    xhr.onerror = () => reject(new ApiError('INTERNAL_ERROR', 'The upload could not reach the server.', 0));
    xhr.onabort = () => reject(new ApiError('JOB_CANCELLED', 'The upload was cancelled.', 0));

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

// ── Endpoint wrappers ───────────────────────────────────────────────────────

export const getCatalog = () => api<Catalog>('/api/v1/tools');

export const getMe = () => api<MeBody>('/api/v1/me');

/**
 * The app's operational picture, for the administration dashboard.
 *
 * Answers 403 for an account without `pdftools.admin.read`, and that refusal is meant to reach the screen: the page
 * hides the door when it knows, but a bookmarked URL or a role removed while a tab is open has to be told the truth
 * by the API rather than by a hidden button.
 */
export const getAdminOverview = () => api<AdminOverviewBody>('/api/v1/admin/overview');

/** Run the on-demand storage sweep — needs `pdftools.admin.operate`, which the dashboard renders a button for. */
export const runMaintenanceSweep = () =>
  api<{
    expiredJobs: number;
    purgedJobDirs: number;
    purgedUploads: number;
    orphanStaging: number;
    orphanJobDirs: number;
    errors: number;
  }>('/api/v1/admin/sweep', { method: 'POST' });

export const createJob = (body: {
  tool: string;
  files: string[];
  options?: unknown;
  retainMinutes?: number;
  module?: string;
}) =>
  api<CreatedJobBody>('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  });

/**
 * One job. `reveal` asks the API for the values it will hand over only to a request that wants them — the owner
 * password `encrypt` generated. The flag is set by the screen that is about to *show* the value, never by the progress
 * poller: a plain `getJob` must never carry a secret, which is what the harness asserts against the running API.
 */
export const getJob = (jobId: string, options: { reveal?: boolean } = {}) =>
  api<JobView>(`/api/v1/jobs/${jobId}${options.reveal ? '?reveal=1' : ''}`);

export const getJobResult = (jobId: string) => api<JobResultBody>(`/api/v1/jobs/${jobId}/result`);

export const cancelJob = (jobId: string) =>
  api<{ status: string; note: string }>(`/api/v1/jobs/${jobId}`, { method: 'DELETE' });

export const listJobs = (params: { page?: number; pageSize?: number; status?: string; tool?: string } = {}) => {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.status) query.set('status', params.status);
  if (params.tool) query.set('tool', params.tool);
  const suffix = query.toString();
  return api<JobListBody>(`/api/v1/jobs${suffix ? `?${suffix}` : ''}`);
};

/**
 * Exchange a workspace handoff code for *a session*, not for tokens.
 *
 * The API performs the exchange with Auth Platform and returns only the identity it proved; the access token stays
 * on the server. Nothing here needs to store a credential, which is the point.
 */
export const consumeSsoCode = (code: string) =>
  api<{ linked?: boolean; userId?: string; tenantId?: string | null; displayName?: string | null }>(
    '/api/v1/sso/consume',
    { method: 'POST', body: JSON.stringify({ code }) },
  );

/**
 * End this app's link to the workspace account (`docs/0-TENANT-FIRST.md` §5.4).
 *
 * The browser's own memory of the sign-out is written by the caller (`lib/auto-link.ts`), not here: this call is what
 * changes the session, and the cookie is what stops the next page load from changing it back. Keeping the two apart
 * is also what makes the failure legible — a refused call means the link is still there, and the screen must not say
 * otherwise.
 */
export const signOutOfAccount = () => api<SsoSignOutBody>('/api/v1/sso/sign-out', { method: 'POST' });

/**
 * Ask the API whether the browser's workspace cookie can be turned into an account on this session
 * (`docs/0-TENANT-FIRST.md` §5).
 *
 * No body: the input is the `auth_session` cookie, which is HttpOnly and therefore invisible to this code — the API
 * reads it from the request the browser sends on its own. `linked: false` is a normal answer, not an error, so this
 * never throws for "not signed in"; it throws only when the call itself fails.
 */
export const probeSso = () => api<SsoProbeBody>('/api/v1/sso/probe', { method: 'POST' });
