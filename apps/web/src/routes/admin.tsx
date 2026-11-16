import type { AdminOverviewBody } from '@pdftools/contracts/api';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from '../components/ui';
import { adminRefusal, canOpenAdmin, canOperateApp } from '../features/app-admin/access';
import { signInHref } from '../features/sign-in-gate/gate';
import { type ApiError, getAdminOverview, runMaintenanceSweep } from '../lib/api-client';
import { formatBytes, formatCount, formatDateTime } from '../lib/format';
import { noIndexSeo } from '../lib/seo';

/**
 * App administration (`docs/0-TENANT-FIRST.md` §6) — the screen behind the header's **Admin** item.
 *
 * Who it is for: the people the platform gave this app's `admin` role, which is a grant that lives in Auth Platform's
 * app management and can change without a deploy here. So the page asks the API, and the API asks the platform; the
 * menu item is only the visible half of the same check (`features/app-admin/access.ts`).
 *
 * What it shows, and why these numbers: every card answers a question an operator asks when something looks wrong —
 * are jobs moving, is storage filling, is the platform reachable, is a pool alive. Nothing here is history: the tool
 * for "how has this been behaving" is the audit trail, and a dashboard that repeated it would be a second, worse copy.
 */
export function AdminRoute() {
  const { me, loading: sessionLoading, reload } = useSession();
  const [overview, setOverview] = useState<AdminOverviewBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  const allowed = canOpenAdmin(me);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await getAdminOverview());
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const sweep = async () => {
    setSweeping(true);
    setSweepResult(null);
    try {
      const result = await runMaintenanceSweep();
      setSweepResult(
        `${formatCount(result.expiredJobs)} job${result.expiredJobs === 1 ? '' : 's'} expired, ` +
          `${formatCount(result.purgedJobDirs)} work director${result.purgedJobDirs === 1 ? 'y' : 'ies'} and ` +
          `${formatCount(result.purgedUploads)} upload${result.purgedUploads === 1 ? '' : 's'} removed` +
          `${result.errors > 0 ? `, ${result.errors} error${result.errors === 1 ? '' : 's'}` : ''}.`,
      );
      await load();
    } catch (err) {
      setError(err as Error);
    } finally {
      setSweeping(false);
    }
  };

  if (sessionLoading && !me) {
    return (
      <Container>
        <div className="page stack">
          <Skeleton width="28%" height={22} />
          <Card className="card-pad stack-sm">
            <Skeleton width="70%" />
            <Skeleton width="45%" />
          </Card>
        </div>
      </Container>
    );
  }

  if (!allowed) {
    const refusal = adminRefusal(me);
    const signIn = refusal.signIn ? signInHref(me, window.location.href) : null;
    return (
      <Container>
        <div className="page stack">
          <PageTitle title="App administration" description="Operational control of this PDF Tools installation." />
          <Card className="card-pad">
            <EmptyState
              title={refusal.title}
              description={refusal.message}
              action={
                signIn ? (
                  <Button variant="primary" onClick={() => window.location.assign(signIn)}>
                    Sign in
                  </Button>
                ) : (
                  <Button onClick={() => void reload()}>Check again</Button>
                )
              }
            />
          </Card>
        </div>
      </Container>
    );
  }

  return (
    <>
      <Seo meta={noIndexSeo('/admin', 'App administration', 'Operational overview for app administrators.')} />
      <Container>
        <div className="page stack">
          <PageTitle
            title="App administration"
            description="This installation, as the platform sees it. Counts are read live on every visit."
            aside={
              <div className="row">
                <Button onClick={() => void load()} loading={loading}>
                  Refresh
                </Button>
                {canOperateApp(me) && (
                  <Button variant="primary" onClick={() => void sweep()} loading={sweeping}>
                    Run storage sweep
                  </Button>
                )}
              </div>
            }
          />

          {error && (
            <Alert tone="danger" title="Could not load the overview">
              {error.message}
            </Alert>
          )}

          {sweepResult && (
            <Alert tone="info" title="Maintenance finished">
              {sweepResult}
            </Alert>
          )}

          {!overview && loading ? (
            <div className="grid-tools">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Card key={i} className="card-pad stack-sm">
                  <Skeleton width="45%" height={12} />
                  <Skeleton width="30%" height={24} />
                </Card>
              ))}
            </div>
          ) : overview ? (
            <>
              <div className="grid-tools">
                <Metric
                  label="Jobs today"
                  value={formatCount(overview.jobs.last24h)}
                  hint={`${formatCount(overview.jobs.total)} all time`}
                />
                <Metric
                  label="Jobs this week"
                  value={formatCount(overview.jobs.last7d)}
                  hint={`${formatCount(overview.jobs.byStatus.find((s) => s.status === 'FAILED')?.count ?? 0)} failed all time`}
                />
                <Metric
                  label="Oldest unfinished"
                  value={overview.jobs.oldestActiveMinutes == null ? '—' : `${overview.jobs.oldestActiveMinutes} min`}
                  hint={
                    overview.jobs.oldestActiveMinutes == null
                      ? 'Nothing queued or running'
                      : 'Queued or processing since then'
                  }
                />
                <Metric
                  label="Stored files"
                  value={formatCount(overview.files.count)}
                  hint={formatBytes(overview.files.bytes)}
                />
                <Metric
                  label="Users"
                  value={formatCount(overview.users.total)}
                  hint={`${formatCount(overview.users.seenLast7d)} seen this week`}
                />
                <Metric
                  label="Active sessions"
                  value={formatCount(overview.sessions.active)}
                  hint={`${formatCount(overview.sessions.linked)} linked to an account`}
                />
              </div>

              <Card className="card-pad stack-sm">
                <h2 style={{ fontSize: 17 }}>Queues</h2>
                <p className="muted small">
                  Depth and live workers per pool. Depth with no workers is a deploy problem; workers with growing depth
                  is a capacity problem.
                </p>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th>Waiting</th>
                      <th>Workers</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.queues.map((queue) => (
                      <tr key={queue.pool}>
                        <td className="mono">{queue.pool}</td>
                        <td>{formatCount(queue.waiting)}</td>
                        <td>{formatCount(queue.workers)}</td>
                        <td>
                          {queue.workers === 0 ? (
                            <Badge tone="danger">No workers</Badge>
                          ) : queue.waiting > 0 ? (
                            <Badge tone="warning">Working</Badge>
                          ) : (
                            <Badge tone="success">Idle</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <div className="grid-two">
                <Card className="card-pad stack-sm">
                  <h2 style={{ fontSize: 17 }}>Jobs by status</h2>
                  {overview.jobs.byStatus.length === 0 ? (
                    <p className="muted small">No jobs have been created on this installation yet.</p>
                  ) : (
                    <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {overview.jobs.byStatus.map((row) => {
                        const share =
                          overview.jobs.total === 0 ? 0 : Math.round((row.count / overview.jobs.total) * 100);
                        return (
                          <li key={row.status} className="stack-sm" style={{ gap: 4 }}>
                            <div className="row-between">
                              <span className="mono">{row.status}</span>
                              <span className="muted tiny">
                                {formatCount(row.count)} · {share}%
                              </span>
                            </div>
                            <div
                              className="bar"
                              data-state={
                                row.status === 'COMPLETED' ? 'done' : row.status === 'FAILED' ? 'failed' : undefined
                              }
                            >
                              <span style={{ width: `${share}%` }} />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>

                <Card className="card-pad stack-sm">
                  <h2 style={{ fontSize: 17 }}>Platform</h2>
                  <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    <li className="row-between">
                      <span className="muted small">App code</span>
                      <span className="mono">{overview.platform.appCode}</span>
                    </li>
                    <li className="row-between">
                      <span className="muted small">Auth Platform</span>
                      {overview.platform.reachable == null ? (
                        <Badge tone="neutral">Not configured</Badge>
                      ) : overview.platform.reachable ? (
                        <Badge tone={overview.platform.status === 200 ? 'success' : 'warning'}>
                          Answered {overview.platform.status}
                        </Badge>
                      ) : (
                        <Badge tone="danger">Unreachable</Badge>
                      )}
                    </li>
                    <li className="row-between">
                      <span className="muted small">Anonymous use</span>
                      <span className="row" style={{ gap: 6 }}>
                        <Badge tone={overview.platform.allowAnonymous ? 'warning' : 'neutral'}>
                          {overview.platform.allowAnonymous ? 'Allowed' : 'Requires an account'}
                        </Badge>
                        <span className="muted tiny">
                          {overview.platform.allowAnonymousSource === 'platform'
                            ? 'from the platform'
                            : overview.platform.allowAnonymousSource === 'stale'
                              ? 'last known answer'
                              : 'environment default'}
                        </span>
                      </span>
                    </li>
                  </ul>
                  {overview.platform.reachable === false && (
                    <p className="muted small">
                      The platform did not answer, so role checks are being answered from the last snapshot this
                      installation has. A grant made there will not appear here until it answers again.
                    </p>
                  )}
                  <p className="muted small">
                    Jobs, files and history stay the caller's own — this page is the only place that reads across
                    accounts, and it is the only one that asks for a permission to do it.
                  </p>
                </Card>
              </div>

              <Card className="card-pad stack-sm">
                <h2 style={{ fontSize: 17 }}>This account</h2>
                <p className="muted small">
                  Read from the platform and cached for a few minutes. Roles are what it calls you here; permissions are
                  what those roles carry — both come from Auth Platform's app management, not from this installation.
                </p>
                <div className="row wrap">
                  {overview.caller.roles.length === 0 ? (
                    <Badge tone="neutral">No roles</Badge>
                  ) : (
                    overview.caller.roles.map((role) => (
                      <Badge key={role} tone="accent">
                        {role}
                      </Badge>
                    ))
                  )}
                </div>
                <div className="row wrap">
                  {overview.caller.permissions.map((permission) => (
                    <span key={permission} className="mono muted">
                      {permission}
                    </span>
                  ))}
                </div>
                <p className="muted small">
                  A role change there takes effect here within minutes without signing out — and immediately for a
                  caller using an API token, whose roles are asked for on every request.{' '}
                  <Link to="/jobs">Job history</Link> and <Link to="/account">your account</Link> are unchanged.
                </p>
              </Card>

              <p className="muted tiny">Read at {formatDateTime(overview.generatedAt)}.</p>
            </>
          ) : null}
        </div>
      </Container>
    </>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="card-pad stack-sm">
      <span className="label">{label}</span>
      <span className="strong" style={{ fontSize: 24, lineHeight: 1.1 }}>
        {value}
      </span>
      <span className="muted tiny">{hint}</span>
    </Card>
  );
}
