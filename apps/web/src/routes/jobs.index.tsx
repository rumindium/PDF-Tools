import type { JobListBody } from '@pdftools/contracts/api';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Button, Card, EmptyState, SelectInput, Skeleton } from '../components/ui';
import { listJobs } from '../lib/api-client';
import { formatBytes, formatDateTime, formatRelative, statusInfo } from '../lib/format';
import { noIndexSeo } from '../lib/seo';

/**
 * Job history (`docs/0-FOLDER-STRUCTURE.md` §3, `routes/account.jobs.tsx` — mounted here at `/jobs`).
 *
 * Paging, filtering and ordering are the server's: `GET /jobs` takes `page`, `pageSize`, `status` and `tool`, and
 * the response carries `total` and `hasMore`. Doing it in the browser would mean fetching a history that grows
 * without bound, including rows whose documents have long since been deleted.
 */
const PAGE_SIZE = 20;

export function JobsIndexRoute() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [tool, setTool] = useState('');
  const [body, setBody] = useState<JobListBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listJobs({ page, pageSize: PAGE_SIZE, ...(status ? { status } : {}), ...(tool ? { tool } : {}) })
      .then((result) => {
        if (cancelled) return;
        setBody(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, status, tool]);

  const toolOptions = [
    { value: '', label: 'All tools' },
    ...[
      'merge',
      'split',
      'compress',
      'extract-pages',
      'rotate',
      'pdf-to-images',
      'office-to-pdf',
      'pdf-to-pdfa',
      'ocr',
    ].map((id) => ({ value: id, label: id })),
  ];

  return (
    <>
      <Seo meta={noIndexSeo('/jobs', 'Job history', 'Your recent PDF jobs and their download links.')} />
      <Container>
        <div className="page stack" style={{ gap: 18 }}>
          <PageTitle
            title="Job history"
            description="Every job you have run, newest first. A download link works until the job's retention window ends, which is what EXPIRED means."
          />

          <div className="row wrap" style={{ gap: 12 }}>
            <div style={{ width: 190 }}>
              <SelectInput
                aria-label="Filter by status"
                value={status}
                options={[
                  { value: '', label: 'Any status' },
                  { value: 'COMPLETED', label: 'Completed' },
                  { value: 'PROCESSING', label: 'Processing' },
                  { value: 'QUEUED', label: 'Queued' },
                  { value: 'FAILED', label: 'Failed' },
                  { value: 'CANCELLED', label: 'Cancelled' },
                  { value: 'EXPIRED', label: 'Expired' },
                ]}
                onChange={(event) => {
                  setPage(1);
                  setStatus(event.currentTarget.value);
                }}
              />
            </div>
            <div style={{ width: 210 }}>
              <SelectInput
                aria-label="Filter by tool"
                value={tool}
                options={toolOptions}
                onChange={(event) => {
                  setPage(1);
                  setTool(event.currentTarget.value);
                }}
              />
            </div>
            {status || tool ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setStatus('');
                  setTool('');
                  setPage(1);
                }}
              >
                Reset filters
              </Button>
            ) : null}
          </div>

          <Card>
            {error ? (
              <EmptyState title="Could not load your jobs" description={error} />
            ) : loading && !body ? (
              <div className="card-pad stack-sm">
                <Skeleton width="60%" />
                <Skeleton width="80%" />
                <Skeleton width="45%" />
              </div>
            ) : !body || body.items.length === 0 ? (
              <EmptyState
                title="No jobs here"
                description="Jobs appear the moment you submit one, complete with a live progress stream."
                action={
                  <Link className="btn btn-secondary btn-sm" to="/tools">
                    Pick a tool
                  </Link>
                }
              />
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Status</th>
                      <th className="hide-sm">Output</th>
                      <th className="hide-sm">Created</th>
                      <th className="hide-sm">Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {body.items.map((job) => {
                      const info = statusInfo(job.status);
                      return (
                        <tr key={job.id}>
                          <td>
                            <Link className="strong small" to={`/jobs/${job.id}`}>
                              {job.tool}
                            </Link>
                            <div className="tiny faint mono">{job.id.slice(0, 8)}</div>
                          </td>
                          <td style={{ width: 120 }}>
                            <span className={`badge badge-${info.tone}`}>{info.label}</span>
                            {job.status === 'PROCESSING' ? (
                              <div className="tiny faint" style={{ marginTop: 4 }}>
                                {job.progress}%
                              </div>
                            ) : null}
                          </td>
                          <td className="hide-sm small muted" style={{ width: 110 }}>
                            {job.output ? formatBytes(job.output.bytes) : '—'}
                            {job.output?.pages != null ? (
                              <div className="tiny faint">{job.output.pages} pages</div>
                            ) : null}
                          </td>
                          <td className="hide-sm tiny faint" style={{ width: 130 }}>
                            {formatRelative(job.createdAt)}
                          </td>
                          <td className="hide-sm tiny faint" style={{ width: 150 }}>
                            {formatDateTime(job.expiresAt)}
                          </td>
                          <td style={{ width: 110, textAlign: 'right' }}>
                            {job.downloadUrl ? (
                              <a className="small" href={job.downloadUrl} download>
                                Download
                              </a>
                            ) : (
                              <Link className="small" to={`/jobs/${job.id}`}>
                                Open
                              </Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="row-between card-pad" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="small muted">
                    {body.items.length} of {body.total} job{body.total === 1 ? '' : 's'} · page {body.page}
                  </span>
                  <div className="row" style={{ gap: 8 }}>
                    <Button
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      Previous
                    </Button>
                    <Button size="sm" disabled={!body.hasMore} onClick={() => setPage((current) => current + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </Container>
    </>
  );
}
