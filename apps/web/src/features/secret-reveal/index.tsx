import { useState } from 'react';
import { Card } from '../../components/ui';

/**
 * The value a job produced that only the caller may hold: today, the owner password of a document this service
 * protected for them.
 *
 * Three decisions are visible in what this renders, and each one is a place where the helpful-looking version is the
 * wrong one:
 *
 *  1. **It is on the screen until the user dismisses it, not on a timer.** The value is held by the service for as long
 *     as the output file exists, and the panel says so rather than inventing a countdown nobody can verify. What the
 *     user must not do is close the tab believing they have it.
 *  2. **It is shown in full, and copyable.** A masked value with a reveal toggle protects nothing here — the person
 *     reading this screen is the person who owns the document — and it costs them a password manager paste.
 *  3. **It explains the aftermath.** The single thing a user gets wrong with a generated owner password is believing
 *     they can change the permissions later without it, so the panel names the only remedy that still works once the
 *     value is gone: run the tool again on the original.
 *
 * A job that reveals nothing renders nothing: 32 of the 33 tools never call this, and a component that returned an
 * empty card would make the tool page look broken for all of them.
 */
export function SecretReveal({ secrets, note }: { secrets?: Record<string, string> | null; note?: string }) {
  const entries = Object.entries(secrets ?? {});
  const [copied, setCopied] = useState<string | null>(null);
  if (entries.length === 0) return null;

  const copy = (key: string, value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied((current) => (current === key ? null : current)), 4000);
      })
      .catch(() => {
        // Clipboard access can be refused (an insecure origin, a permission prompt). The value is on screen and
        // selectable, so the fallback is the user's own selection rather than an error banner.
        setCopied(null);
      });
  };

  return (
    <Card className="card-pad">
      <div className="stack">
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="label">Save this now</span>
        </div>
        {entries.map(([key, value]) => (
          <div key={key} className="stack-sm">
            <div className="row-between" style={{ gap: 12, alignItems: 'center' }}>
              <span className="small muted">{labelFor(key)}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(key, value)}>
                {copied === key ? 'Copied' : 'Copy'}
              </button>
            </div>
            <code className="mono secret-value">{value}</code>
          </div>
        ))}
        <span className="tiny faint">
          {note ??
            'It is not stored with the job: the service holds it only while the output file exists. Once this page is gone, nobody can recover it — to change the permissions later, run the tool again on the original document.'}
        </span>
      </div>
    </Card>
  );
}

/** The key as the caller named it, in words. Unknown keys are left as they are rather than guessed at. */
function labelFor(key: string): string {
  if (key === 'ownerPassword') return 'Owner password';
  return key.replaceAll(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
