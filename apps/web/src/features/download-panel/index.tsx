import type { JobResultPart, JobView } from '@pdftools/contracts/api';
import { useEffect, useState } from 'react';
import { IconCompare, IconExternal } from '../../components/icons';
import { Alert, Badge, Button, Card, FactList } from '../../components/ui';
import { formatBytes, statusInfo } from '../../lib/format';
import { comparePages, describeInputs, describeRetention } from './result';

/**
 * Result and download (`docs/0-API.md` §4.5, `0-UI-DESIGN.md` §3.3).
 *
 * One output gets a single download button; several get a list plus the archive, because "download 40 images" as
 * a single button that silently returns a zip is a surprise. Part names come from the job row, never from a URL
 * the client constructs, and the download endpoint rebuilds the path server-side.
 *
 * Two additions here are about a question the panel did not answer: **did I get back what I put in?** The comparison
 * puts the inputs beside the output with the server's own page counts (`features/download-panel/result.ts`), and the
 * preview opens the artefact itself — a PDF in the browser's viewer through the API's inline disposition, images as
 * images — so trusting the result does not require downloading and opening it first.
 */

/** How many pages of a multi-part image job are shown as thumbnails before the list takes over. */
const THUMBNAILS = 6;

export function DownloadPanel({
  job,
  parts,
  archiveUrl,
  metrics,
  inputs,
}: {
  job: JobView;
  parts?: JobResultPart[];
  archiveUrl?: string;
  metrics?: Record<string, unknown>;
  /**
   * What the caller submitted, when it still has it — the other half of the comparison.
   *
   * Optional because the panel is also rendered from a job row fetched on a later page load, where the uploads are
   * long gone. The comparison is then simply absent rather than guessed at.
   */
  inputs?: Array<{ pages: number | null; bytes: number }>;
}) {
  const info = statusInfo(job.status);

  if (job.status !== 'COMPLETED') {
    return (
      <Card className="card-pad">
        <div className="stack-sm">
          <div className="row-between">
            <span className="label">Result</span>
            <Badge tone={info.tone}>{info.label}</Badge>
          </div>
          <p className="small muted">{job.error?.message ?? info.description}</p>
          {job.error ? <span className="mono tiny faint">{job.error.code}</span> : null}
        </div>
      </Card>
    );
  }

  const listed = parts ?? [];
  const multi = listed.length > 1;
  const outputMime = job.output?.mime ?? '';
  // Inline only where the browser renders the bytes as content rather than running them: the API grants the same
  // allow-list, and anything else falls back to a download (`apps/api/src/services/download-service.ts`).
  const previewable = outputMime === 'application/pdf';
  const images = outputMime.startsWith('image/');
  const previewUrl = previewable && job.downloadUrl ? `${job.downloadUrl}?disposition=inline` : null;

  // The comparison is only drawn for a single output: with several parts there is no one artefact to compare against
  // the inputs, and "84 pages in, 12 pages out" would be comparing a document with its first slice.
  const inputPages =
    inputs && inputs.length > 0 && inputs.every((input) => input.pages != null)
      ? inputs.reduce((total, input) => total + (input.pages ?? 0), 0)
      : null;
  const inputBytes = inputs?.reduce((total, input) => total + input.bytes, 0) ?? 0;
  const verdict = inputs && inputs.length > 0 && !multi ? comparePages(inputPages, job.output?.pages ?? null) : null;

  return (
    <Card className="card-pad">
      <div className="stack">
        <div className="row-between">
          <span className="label">Result</span>
          <Badge tone="success">Completed</Badge>
        </div>

        <div className="row-between wrap">
          <div className="stack-sm">
            <span className="strong">{job.output?.name ?? 'Your file'}</span>
            <span className="small muted">
              {formatBytes(job.output?.bytes)}
              {job.output?.pages != null ? ` · ${job.output.pages} pages` : ''}
              {multi ? ` · ${listed.length} parts` : ''}
            </span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {previewUrl ? (
              <a className="btn btn-secondary btn-sm" href={previewUrl} target="_blank" rel="noopener noreferrer">
                Preview <IconExternal size={14} />
              </a>
            ) : null}
            {job.downloadUrl ? (
              <a className="btn btn-primary" href={job.downloadUrl} download>
                Download
              </a>
            ) : (
              <span className="small muted">The result is no longer available.</span>
            )}
          </div>
        </div>

        {images ? (
          <div className="result-thumbs">
            {listed.slice(0, THUMBNAILS).map((part, index) => (
              <a
                key={part.name}
                className="result-thumb"
                href={`${job.downloadUrl}?part=${index}`}
                download
                title={`${part.name} · ${formatBytes(part.bytes)}`}
              >
                <img src={`${job.downloadUrl}?part=${index}`} alt={part.name} loading="lazy" />
                <span className="tiny truncate">{part.name}</span>
              </a>
            ))}
            {listed.length > THUMBNAILS ? (
              <span className="result-thumb result-thumb-more tiny muted">+{listed.length - THUMBNAILS} more</span>
            ) : null}
          </div>
        ) : null}

        {verdict && inputs ? (
          <div className="compare" data-tone={verdict.tone}>
            <div className="row" style={{ gap: 8 }}>
              <IconCompare size={15} />
              <span className="label">Input vs result</span>
            </div>
            <FactList
              facts={[
                ['Input', describeInputs(inputs.length, inputPages, inputBytes)],
                ['Result', describeInputs(1, job.output?.pages ?? null, job.output?.bytes ?? 0)],
              ]}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Badge tone={verdict.tone}>{verdict.label}</Badge>
              <span className="tiny faint">{verdict.detail}</span>
            </div>
          </div>
        ) : null}

        <RetentionNote expiresAt={job.expiresAt} />

        {multi ? (
          <div className="stack-sm">
            <div className="row-between">
              <span className="label">Parts</span>
              {archiveUrl ? (
                <a className="btn btn-secondary btn-sm" href={archiveUrl} download>
                  Download all (.zip)
                </a>
              ) : null}
            </div>
            <div
              style={{
                maxHeight: 240,
                overflow: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
              }}
            >
              <table className="table">
                <tbody>
                  {listed.map((part, index) => (
                    <tr key={part.name}>
                      <td className="truncate mono" title={part.name}>
                        {part.name}
                      </td>
                      <td className="tiny faint" style={{ width: 90 }}>
                        {formatBytes(part.bytes)}
                      </td>
                      <td style={{ width: 90, textAlign: 'right' }}>
                        <a className="small" href={`${job.downloadUrl}?part=${index}`} download>
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {job.warnings.length > 0 ? (
          <div className="stack-sm">
            {job.warnings.map((warning) => (
              <Alert
                key={`${warning.code}-${warning.detail ?? ''}`}
                tone="warning"
                title={warning.code.replaceAll('_', ' ')}
              >
                <span className="small">{warning.detail}</span>
              </Alert>
            ))}
          </div>
        ) : null}

        {metrics && Object.keys(metrics).length > 0 ? (
          <details>
            <summary className="small strong" style={{ cursor: 'pointer' }}>
              Job metrics
            </summary>
            <div className="mono tiny" style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>
              {JSON.stringify(metrics, null, 2)}
            </div>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The retention deadline, ticking.
 *
 * A live countdown rather than a timestamp because the question it answers — "can I come back to this in a minute?" —
 * is about the window, not about the clock, and because the moment it reaches zero the result really is gone
 * (`resolveDownload` refuses an expired row), so a panel still offering a Download button would be lying.
 *
 * It re-reads `Date.now()` on an interval instead of counting down in state, so a laptop that was asleep for an hour
 * shows the truth when it wakes rather than a number that kept counting while nothing was happening.
 */
function RetentionNote({ expiresAt }: { expiresAt: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const retention = describeRetention(expiresAt, now);
  return (
    <span className="tiny faint" data-expired={retention.expired}>
      {retention.label}
    </span>
  );
}

/** Progress card used while a job is running, and as the summary once it finishes. */
export function ProgressPanel({
  status,
  phase,
  progress,
  message,
  transport,
  timeline,
  onCancel,
}: {
  status: JobView['status'] | null;
  phase: string | null;
  progress: number;
  message: string | null;
  transport: 'idle' | 'sse' | 'polling';
  timeline: Array<{ seq: number; kind: string; message: string | null; at: string }>;
  onCancel?: () => void;
}) {
  if (!status) return null;
  const info = statusInfo(status);
  // Narrowed in one place: COMPLETED is a success, every other terminal state is a failure, and everything else is
  // still running. Written as a lookup rather than a chain of ternaries so a new status cannot silently fall
  // through to "running" forever.
  const state: 'done' | 'failed' | 'running' = info.terminal
    ? info.tone === 'success'
      ? 'done'
      : 'failed'
    : 'running';

  return (
    <Card className="card-pad">
      <div className="stack">
        <div className="row-between">
          <div className="row">
            <span className="label">Progress</span>
            <Badge tone={info.tone}>{info.label}</Badge>
          </div>
          <span className="tiny faint">
            {transport === 'polling' ? 'Live updates via polling' : transport === 'sse' ? 'Live' : ''}
          </span>
        </div>

        <div className="bar" data-state={state}>
          <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>

        <div className="row-between">
          <span className="small muted">{message ?? info.description}</span>
          <span className="small faint">{phase ?? ''}</span>
        </div>

        {onCancel && !info.terminal ? (
          <div className="row">
            <Button size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <span className="tiny faint">
              A running conversion cannot be interrupted mid-step; cancellation stops it at the next checkpoint.
            </span>
          </div>
        ) : null}

        {timeline.length > 0 ? (
          <details>
            <summary className="small strong" style={{ cursor: 'pointer' }}>
              Activity ({timeline.length})
            </summary>
            <ul className="timeline" style={{ marginTop: 10 }}>
              {timeline.map((entry) => (
                <li key={entry.seq} data-kind={entry.kind}>
                  <div className="small">{entry.message ?? entry.kind}</div>
                  <div className="tiny faint">
                    {new Date(entry.at).toLocaleTimeString()} · {entry.kind}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Card>
  );
}
