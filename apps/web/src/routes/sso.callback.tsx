import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '../app/providers';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Alert, Card } from '../components/ui';
import { SignInGate } from '../features/sign-in-gate';
import { gateApplies } from '../features/sign-in-gate/gate';
import { consumeSsoCode } from '../lib/api-client';
import { noIndexSeo } from '../lib/seo';
import { completeSsoHandoff } from '../lib/sso-handoff';

/**
 * Auth Platform handoff (`docs/CROSS-MODULE.md` §3, `routes/sso.callback.tsx`).
 *
 * The code in the URL is single-use and short-lived (60 seconds), and this route hands it straight to the API for
 * exchange. What it deliberately does **not** do is keep the resulting tokens in the browser: the exchange
 * happens on the server so the access token never enters `localStorage`, `sessionStorage`, or a readable cookie —
 * the same reason the platform's own web app stores an opaque handle rather than a 5 KB JWT (that token exceeds
 * the 4 KB browser cookie limit and gets silently dropped).
 *
 * While the exchange runs the page shows a full diagram loader (workspace → this app) rather than a bare spinner,
 * and on success it reloads the session and replaces the history entry with `/` — there is no intermediate
 * "accepted, click to continue" screen to get stuck on. A failure is a notice rather than a dead end — but "you can
 * keep working anonymously" is only true while this installation serves visitors (`docs/0-TENANT-FIRST.md` §4.2),
 * so on a tenant-first installation the same failure offers the sign-in link again instead of a way around it.
 */
export function SsoCallbackRoute() {
  const [params] = useSearchParams();
  const code = params.get('code');
  const navigate = useNavigate();
  const { me, reload } = useSession();
  const gated = gateApplies(me);
  const [state, setState] = useState<'working' | 'failed'>('working');
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!code) {
      setState('failed');
      setMessage('This link is missing its handoff code.');
      return;
    }
    // Guard against React StrictMode double-invoking the effect: the code is single-use, so a second exchange
    // would turn a success into a failure.
    if (started.current === code) return;
    started.current = code;
    completeSsoHandoff(code, {
      consume: consumeSsoCode,
      reload,
      navigateHome: () => navigate('/', { replace: true }),
    }).then((failure) => {
      if (failure) {
        setState('failed');
        setMessage(failure);
      }
    });
  }, [code, navigate, reload]);

  return (
    <>
      <Seo meta={noIndexSeo('/sso/callback', 'Signing you in', 'Completing the workspace sign-in handoff.')} />
      {state === 'working' ? (
        <output className="sso-handoff" aria-label="Signing you in">
          <div className="sso-handoff-diagram" aria-hidden="true">
            <span className="sso-node sso-node-left">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                <rect x="3" y="4" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M3 8.5h18" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="5.4" cy="6.4" r="1" fill="currentColor" />
              </svg>
            </span>
            <span className="sso-link">
              <span className="sso-link-track" />
              <span className="sso-link-packet" />
            </span>
            <span className="sso-node sso-node-right">
              <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
                <path d="M10 7h8.5L23 11.5V25H10z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M18 7v5h5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M13 17.5h7M13 21h4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
          </div>
          <p className="strong" style={{ margin: 0 }}>
            Signing you in…
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Completing the handoff from the workspace.
          </p>
        </output>
      ) : (
        <Container>
          <div className="page stack" style={{ maxWidth: 560 }}>
            <PageTitle title="Signing you in" description="Completing the handoff from the workspace." />

            <Card className="card-pad">
              <div className="stack-sm">
                <Alert tone="warning" title="Could not complete the handoff">
                  <span className="small">
                    {message} Handoff codes expire after 60 seconds and can only be used once.
                    {gated
                      ? ' Nothing has been lost — signing in again is enough.'
                      : ' You can keep working anonymously — nothing has been lost.'}
                  </span>
                </Alert>
                {gated ? (
                  <SignInGate hint="The workspace link and this sign-in are the same account." />
                ) : (
                  <div className="row">
                    <Link className="btn btn-secondary btn-sm" to="/">
                      Continue anonymously
                    </Link>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </Container>
      )}
    </>
  );
}
