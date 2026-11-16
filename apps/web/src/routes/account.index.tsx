import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Alert, Badge, Card, EmptyState, Skeleton } from '../components/ui';
import { SignInGate } from '../features/sign-in-gate';
import { gateApplies } from '../features/sign-in-gate/gate';
import { api } from '../lib/api-client';
import { formatBytes } from '../lib/format';
import { noIndexSeo } from '../lib/seo';

/**
 * Account and usage (`docs/0-FOLDER-STRUCTURE.md` §3, `routes/account.index.tsx`).
 *
 * `GET /me/usage` groups by tool or by day. One caveat is surfaced rather than hidden: `bytes_out` is only
 * recorded for jobs, so a period before metering was enabled shows job counts with no byte total. Silently
 * printing `0 B` would read as "you used nothing", which is a different claim.
 */
interface UsageBucket {
  bucket: string;
  jobs: number;
  bytes: number;
}

export function AccountRoute() {
  const { me, loading } = useSession();
  const [byTool, setByTool] = useState<UsageBucket[] | null>(null);
  const [byDay, setByDay] = useState<UsageBucket[] | null>(null);
  const gated = gateApplies(me);

  useEffect(() => {
    void api<{ buckets: UsageBucket[] }>('/api/v1/me/usage?groupBy=tool')
      .then((body) => setByTool(body.buckets))
      .catch(() => setByTool([]));
    void api<{ buckets: UsageBucket[] }>('/api/v1/me/usage?groupBy=day')
      .then((body) => setByDay(body.buckets))
      .catch(() => setByDay([]));
  }, []);

  if (loading && !me) {
    return (
      <Container>
        <div className="page stack">
          <Skeleton width="30%" height={22} />
          <Card className="card-pad stack-sm">
            <Skeleton width="70%" />
            <Skeleton width="50%" />
          </Card>
        </div>
      </Container>
    );
  }

  return (
    <>
      <Seo meta={noIndexSeo('/account', 'Your usage', 'Fair-use quota and usage for this session.')} />
      <Container>
        <div className="page stack" style={{ gap: 18 }}>
          <PageTitle
            title="Your usage"
            description="What your session has used in the current window. Everything is free; the numbers below are fair-use accounting."
            aside={<Badge tone="accent">Free</Badge>}
          />

          {gated ? (
            <Card className="card-pad">
              <SignInGate hint="Usage is counted per account, so this page has nothing to show until then." />
            </Card>
          ) : null}

          {gated ? null : (
            <div className="grid-tools">
              <Card className="card-pad stack-sm">
                <span className="label">Jobs</span>
                <span className="strong" style={{ fontSize: 22 }}>
                  {me ? (me.quota.unlimited ? 'Unlimited' : `${me.quota.used} / ${me.quota.limit}`) : '—'}
                </span>
                <span className="tiny faint">
                  {me?.quota.unlimited
                    ? `Signed-in accounts have no job cap — ${me.quota.used} run so far, fair-use sizes apply.`
                    : `Anonymous sessions get ${me?.quota.limit ?? 15} jobs a day. Sign in for unlimited.`}
                </span>
              </Card>
              <Card className="card-pad stack-sm">
                <span className="label">Per file</span>
                <span className="strong" style={{ fontSize: 22 }}>
                  {me ? `${me.entitlements.maxFileMb} MB` : '—'}
                </span>
                <span className="tiny faint">Above this, the API rejects the upload before it is stored.</span>
              </Card>
              <Card className="card-pad stack-sm">
                <span className="label">Per job</span>
                <span className="strong" style={{ fontSize: 22 }}>
                  {me ? `${me.entitlements.maxJobMb} MB` : '—'}
                </span>
                <span className="tiny faint">Combined size of every file in one job.</span>
              </Card>
              <Card className="card-pad stack-sm">
                <span className="label">Pages</span>
                <span className="strong" style={{ fontSize: 22 }}>
                  {me ? me.entitlements.maxPages.toLocaleString() : '—'}
                </span>
                <span className="tiny faint">Checked before the job is queued and again by the worker.</span>
              </Card>
            </div>
          )}

          {/*
          Identity, said in the caller's own terms. The anonymous sentence is only true when anonymous use is on: on a
          tenant-first installation there is no anonymous history to warn about, and a caller whose session predates
          the switch can still reach what they ran, so what they need to hear is that reads kept working
          (`docs/0-TENANT-FIRST.md` §4.3).
        */}
          <Alert tone="info" title="Identity">
            <span className="small">
              This session is <span className="mono">{me?.kind ?? 'unknown'}</span>
              {me?.displayName ? ` for ${me.displayName}` : ''}.{' '}
              {gated
                ? 'No account is signed in, and this installation needs one to start a job.'
                : me?.allowAnonymous === false && me?.kind === 'anonymous'
                  ? 'This installation no longer serves anonymous visitors, so new jobs are refused — but everything you already ran is still reachable, and signing in keeps it.'
                  : "Anonymous history is tied to this browser's cookie — signing out or clearing cookies loses the ability to reach those jobs, which is the trade for not requiring an account."}
            </span>
          </Alert>

          <div className="grid-two">
            <Card className="card-pad stack-sm">
              <span className="label">Jobs by tool</span>
              {byTool == null ? (
                <Skeleton width="80%" />
              ) : byTool.length === 0 ? (
                <EmptyState title="No usage in this window" />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th style={{ width: 90 }}>Jobs</th>
                      <th style={{ width: 110 }}>Output</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byTool.map((bucket) => (
                      <tr key={bucket.bucket}>
                        <td className="small">{bucket.bucket}</td>
                        <td className="small">{bucket.jobs}</td>
                        <td className="small muted">{bucket.bytes > 0 ? formatBytes(bucket.bytes) : 'not metered'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="card-pad stack-sm">
              <span className="label">Last 30 days</span>
              {byDay == null ? (
                <Skeleton width="80%" />
              ) : byDay.length === 0 ? (
                <EmptyState title="Nothing recorded yet" />
              ) : (
                <table className="table">
                  <tbody>
                    {byDay.map((bucket) => (
                      <tr key={bucket.bucket}>
                        <td className="small mono">{bucket.bucket}</td>
                        <td className="small">{bucket.jobs} jobs</td>
                        <td className="small muted" style={{ textAlign: 'right' }}>
                          {bucket.bytes > 0 ? formatBytes(bucket.bytes) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Link className="small" to="/jobs">
                Open job history →
              </Link>
            </Card>
          </div>
        </div>
      </Container>
    </>
  );
}
