import type { JobStatus } from '@pdftools/contracts/api';

/** Presentation helpers. Nothing here decides behaviour — status *meaning* lives in `statusInfo` below, once. */

/**
 * A grouped whole number for counts.
 *
 * Its own helper rather than `toLocaleString` at each call site: a dashboard is read in glances, and `12345` beside
 * `12 345` is the kind of inconsistency that makes two numbers look like two kinds of thing.
 */
export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat().format(value);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface StatusInfo {
  tone: BadgeTone;
  label: string;
  /** True when the job will not change again — the UI stops streaming and shows the result. */
  terminal: boolean;
  description: string;
}

/**
 * The status vocabulary, in one table.
 *
 * Every screen reads this instead of re-deriving a colour from a status string; that is the difference between
 * "EXPIRED" looking like a failure in one place and a neutral end state in another.
 */
export const STATUS_INFO: Record<JobStatus, StatusInfo> = {
  QUEUED: {
    tone: 'neutral',
    label: 'Queued',
    terminal: false,
    description: 'Waiting for a worker in this pool.',
  },
  PROCESSING: {
    tone: 'accent',
    label: 'Processing',
    terminal: false,
    description: 'A worker has claimed the job.',
  },
  COMPLETED: { tone: 'success', label: 'Completed', terminal: true, description: 'The result is ready.' },
  FAILED: { tone: 'danger', label: 'Failed', terminal: true, description: 'The job could not be completed.' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled', terminal: true, description: 'The job was cancelled.' },
  EXPIRED: {
    tone: 'warning',
    label: 'Expired',
    terminal: true,
    description: 'The result was deleted when its retention window ended.',
  },
};

export function statusInfo(status: string | null | undefined): StatusInfo {
  if (status && status in STATUS_INFO) return STATUS_INFO[status as JobStatus];
  return { tone: 'neutral', label: status ?? 'Unknown', terminal: false, description: '' };
}

export const PHASE_LABEL: Record<string, string> = {
  queued: 'Queued',
  staging: 'Preparing files',
  processing: 'Processing',
  finalizing: 'Finalising',
  done: 'Done',
};

export function formatToolName(toolId: string): string {
  return toolId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
