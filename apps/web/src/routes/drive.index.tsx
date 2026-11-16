import type { JobListBody } from '@pdftools/contracts/api';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Button, Card, EmptyState, Skeleton } from '../components/ui';
import { SignInGate } from '../features/sign-in-gate';
import { isSignedIn } from '../features/sign-in-gate/gate';
import { listJobs } from '../lib/api-client';
import { formatBytes, formatRelative, statusInfo } from '../lib/format';
import { noIndexSeo } from '../lib/seo';

/**
 * My Drive — the files this account kept.
 *
 * Anonymous runs are free but never stored: without an account there is no
 * drive to put them in. A signed-in caller sees every job still inside its
 * retention window, with the download link that works until it expires and
 * a way back to the tool that made it.
 */
const PAGE_SIZE = 20;

export function DriveRoute() {
  const { me } = useSession();
  const signedIn = isSignedIn(me);
  const [page, setPage] = useState(1);
  const [body, setBody] = useState<JobListBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!signedIn) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listJobs({ page, pageSize: PAGE_SIZE })
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
  }, [page, signedIn]);

  return (
    <>
      <Seo meta={noIndexSeo('/drive', 'My Drive', 'Files this account kept, with download links.')} />
      <Container>
        <div className="page stack" style={{ gap: 18 }}>
          <PageTitle
            title="My Drive"
            description="Results you ran while signed in, kept until their retention window ends. Anonymous runs are never stored here."
          />

          {!signedIn ? (
            <Card className="card-pad">
              <SignInGate hint="Signing in is what turns a run into a file kept in your drive — anonymous runs stay free, but they are never stored." />
            </Card>
          ) : (
            <Card>
              {error ? (
                <EmptyState title="Could not load your drive" description={error} />
              ) : loading && !body ? (
                <div className="card-pad stack-sm">
                  <Skeleton width="60%" />
                  <Skeleton width="80%" />
                  <Skeleton width="45%" />
                </div>
              ) : !body || body.items.length === 0 ? (
                <EmptyState
                  title="Your drive is empty"
                  description="Run any tool while signed in and the result lands here, with a download link until it expires."
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
                        <th>File</th>
                        <th>Status</th>
                        <th className="hide-sm">Size</th>
                        <th className="hide-sm">Saved</th>
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
                            </td>
                            <td className="hide-sm small muted" style={{ width: 110 }}>
                              {job.output ? formatBytes(job.output.bytes) : '—'}
                            </td>
                            <td className="hide-sm tiny faint" style={{ width: 130 }}>
                              {formatRelative(job.createdAt)}
                            </td>
                            <td style={{ width: 180, textAlign: 'right' }}>
                              {job.downloadUrl ? (
                                <span className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
                                  <a className="small" href={job.downloadUrl} download>
                                    Download
                                  </a>
                                  {job.tool ? (
                                    <Link className="small faint" to={`/tools/${job.tool}`}>
                                      Run again
                                    </Link>
                                  ) : null}
                                </span>
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
                      {body.items.length} of {body.total} file{body.total === 1 ? '' : 's'} · page {body.page}
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
          )}
        </div>
      </Container>
    </>
  );
}
