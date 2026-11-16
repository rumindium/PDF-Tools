import type { JobResultBody } from '@pdftools/contracts/api';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from '../components/ui';
import { DownloadPanel, ProgressPanel } from '../features/download-panel';
import { useJobWatcher } from '../features/job-runner';
import { SecretReveal } from '../features/secret-reveal';
import { gateApplies } from '../features/sign-in-gate/gate';
import { cancelJob, getJob, getJobResult } from '../lib/api-client';
import { PHASE_LABEL, formatBytes, formatDateTime, statusInfo } from '../lib/format';
import { noIndexSeo } from '../lib/seo';

/**
 * Job detail (`docs/0-FOLDER-STRUCTURE.md` §3, `routes/jobs.$jobId.tsx`).
 *
 * A page you can leave open and come back to: it reads the job row (not a client-side cache), so the state is
 * correct after a refresh, and it only opens a live stream while the job can still change. The activity list
 * records the transitions this page observed, which is enough to explain "it sat in staging for a while" without
 * re-implementing the server's event log.
 */
export function JobRoute() {
  const { jobId } = useParams<{ jobId: string }>();
  const { me } = useSession();
  const { job, error, loading, setJob } = useJobWatcher(jobId);
  const [result, setResult] = useState<JobResultBody | null>(null);
  const [observed, setObserved] = useState<Array<{ seq: number; kind: string; message: string | null; at: string }>>(
    [],
  );
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Whatever this job produced that only its owner may see — fetched on request, never by the poller above. */
  const [secrets, setSecrets] = useState<Record<string, string> | null>(null);
  const [revealing, setRevealing] = useState(false);

  const [asked, setAsked] = useState(false);

  const reveal = () => {
    if (!job) return;
    setRevealing(true);
    void getJob(job.id, { reveal: true })
      .then((fresh) => {
        setSecrets(fresh.secrets ?? null);
        setAsked(true);
      })
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRevealing(false));
  };

  useEffect(() => {
    if (!job || job.status !== 'COMPLETED') return;
    getJobResult(job.id)
      .then(setResult)
      .catch(() => setResult(null));
  }, [job]);

  useEffect(() => {
    if (!job) return;
    setObserved((current) => {
      const last = current[current.length - 1];
      if (last && last.message === (job.error?.message ?? job.phase)) return current;
      return [
        ...current,
        {
          seq: current.length + 1,
          kind: job.status === 'COMPLETED' ? 'done' : job.status === 'FAILED' ? 'failed' : 'progress',
          message: job.error?.message ?? `${statusInfo(job.status).label} · ${PHASE_LABEL[job.phase] ?? job.phase}`,
          at: new Date().toISOString(),
        },
      ].slice(-40);
    });
  }, [job]);

  if (loading && !job) {
    return (
      <Container>
        <div className="page stack">
          <Skeleton width="26%" height={22} />
          <Skeleton width="60%" />
          <Card className="card-pad">
            <Skeleton width="90%" />
          </Card>
        </div>
      </Container>
    );
  }

  if (!job) {
    return (
      <Container>
        <div className="page">
          <Card>
            <EmptyState
              title={error?.code === 'JOB_NOT_FOUND' ? 'That job does not exist' : 'Could not load this job'}
              // The API's own sentence comes first when there is one — it knows more than this page does — and the
              // explanation is *appended* rather than replacing it, because the two answers are not alternatives.
              //
              // A guest owns no rows at all, so "a different session" would explain the same 404 with a session that
              // cannot exist (`docs/0-TENANT-FIRST.md` §4.2); what is true for them is that the job may predate the
              // switch, and that signing in is how they get back to what they can still reach.
              description={
                gateApplies(me)
                  ? `${error?.message ? `${error.message} ` : ''}It may have been run before this installation required an account, or in a different browser. Sign in and open it from your history.`
                  : (error?.message ??
                    'It may belong to a different session — anonymous jobs are scoped to our cookie.')
              }
              action={
                <Link className="btn btn-secondary btn-sm" to="/jobs">
                  Back to history
                </Link>
              }
            />
          </Card>
        </div>
      </Container>
    );
  }

  const info = statusInfo(job.status);

  return (
    <>
      <Seo meta={noIndexSeo(`/jobs/${job.id}`, `Job ${job.id}`, 'Job status, progress and download links.')} />
      <Container>
        <div className="page stack" style={{ gap: 18 }}>
          <PageTitle
            title={job.tool}
            description={<span className="mono tiny">{job.id}</span>}
            aside={
              <div className="row wrap" style={{ gap: 6 }}>
                <Badge tone={info.tone}>{info.label}</Badge>
                <Badge tone="neutral">{job.queue}</Badge>
                {job.engine ? <Badge tone="neutral">{job.engine.name}</Badge> : null}
              </div>
            }
          />

          {notice ? <Alert tone="info">{notice}</Alert> : null}

          <div className="grid-two">
            <div className="stack">
              <ProgressPanel
                status={job.status}
                phase={job.phase}
                progress={job.progress}
                message={job.error?.message ?? info.description}
                transport="sse"
                timeline={observed}
                onCancel={
                  ['QUEUED', 'PROCESSING'].includes(job.status)
                    ? () => {
                        setCancelling(true);
                        void cancelJob(job.id)
                          .then((response) => {
                            setNotice(response.note);
                            return setJob({
                              ...job,
                              status: response.status === 'PROCESSING' ? job.status : 'CANCELLED',
                            });
                          })
                          .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
                          .finally(() => setCancelling(false));
                      }
                    : undefined
                }
              />

              {cancelling ? <span className="tiny faint">Requesting cancellation…</span> : null}

              <DownloadPanel
                job={job}
                parts={result?.parts}
                archiveUrl={result?.archiveUrl}
                metrics={result?.metrics}
              />

              {/*
              A button rather than a fetch on load, and that is the whole reason the API's reveal is opt-in: this page
              is the one a user reloads, shares, or leaves open on a second monitor, and the password should leave the
              service when somebody asks for it — not every time this screen mounts.
            */}
              {job.status === 'COMPLETED' && !secrets ? (
                <Card className="card-pad">
                  <div className="stack-sm">
                    <span className="label">Generated password</span>
                    <span className="small muted">
                      If this job generated an owner password, the service still holds it while the output exists.
                    </span>
                    <Button variant="secondary" loading={revealing} onClick={reveal}>
                      Show it
                    </Button>
                    {/* "Nothing happened" is a bad answer to a click: most jobs have nothing to hand over, and the
                      button must say so rather than look broken. */}
                    {asked ? <span className="tiny faint">This job generated no value to hand back.</span> : null}
                  </div>
                </Card>
              ) : null}

              <SecretReveal secrets={secrets} />
            </div>

            <Card className="card-pad">
              <div className="stack-sm">
                <span className="label">Details</span>
                <dl className="stack-sm" style={{ margin: 0 }}>
                  {[
                    ['Created', formatDateTime(job.createdAt)],
                    ['Started', formatDateTime(job.startedAt)],
                    ['Finished', formatDateTime(job.completedAt)],
                    ['Expires', formatDateTime(job.expiresAt)],
                    [
                      'Output',
                      job.output
                        ? `${formatBytes(job.output.bytes)}${job.output.pages != null ? ` · ${job.output.pages} pages` : ''}`
                        : '—',
                    ],
                    ['Parts', job.output?.parts != null ? String(job.output.parts) : '—'],
                    [
                      'Engine',
                      job.engine ? `${job.engine.name}${job.engine.version ? ` ${job.engine.version}` : ''}` : '—',
                    ],
                    ['Priority', String(job.priority)],
                  ].map(([term, detail]) => (
                    <div key={term} className="row-between" style={{ gap: 10 }}>
                      <dt className="small muted">{term}</dt>
                      <dd className="small" style={{ margin: 0, textAlign: 'right' }}>
                        {detail}
                      </dd>
                    </div>
                  ))}
                </dl>

                {job.error ? (
                  <Alert tone="danger" title={job.error.code.replaceAll('_', ' ')}>
                    <span className="small">{job.error.message}</span>
                  </Alert>
                ) : null}

                <div className="row" style={{ gap: 8 }}>
                  <Link className="btn btn-secondary btn-sm" to="/jobs">
                    All jobs
                  </Link>
                  {job.tool ? (
                    <Link className="btn btn-ghost btn-sm" to={`/tools/${job.tool}`}>
                      Run it again
                    </Link>
                  ) : null}
                </div>
              </div>
            </Card>
          </div>
        </div>
      </Container>
    </>
  );
}

/** Shown by the download panel when a completed job's bytes are already gone. */
export const NO_RESULT_NOTE =
  'The result was removed when its retention window ended. Running the job again is the only way back to it.';
