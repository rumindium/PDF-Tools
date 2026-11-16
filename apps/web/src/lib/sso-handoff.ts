import { ApiError } from './api-client';

/**
 * The SSO handoff as a pure orchestration (`routes/sso.callback.tsx` renders it).
 *
 * Extracted so the ordering is testable without a browser: the exchange, then the session reload, then leaving.
 * The reload is awaited **before** navigating home because `/` renders from the session, and arriving before the
 * reloaded identity lands is how the header flashes Anonymous after a successful handoff. Returns `null` on
 * success, or the failure message the route should show.
 */
export interface SsoHandoffDeps {
  /** Exchange the single-use code for a session. Rejects when the code is bad, used, or expired. */
  consume: (code: string) => Promise<unknown>;
  /** Re-read the identity and catalog. Resolves once the new answers are on screen. */
  reload: () => Promise<void>;
  /** Leave for home. Called only after the reload has resolved. */
  navigateHome: () => void;
}

export async function completeSsoHandoff(code: string, deps: SsoHandoffDeps): Promise<string | null> {
  try {
    await deps.consume(code);
  } catch (cause: unknown) {
    return cause instanceof ApiError ? cause.message : String(cause);
  }
  await deps.reload();
  deps.navigateHome();
  return null;
}
