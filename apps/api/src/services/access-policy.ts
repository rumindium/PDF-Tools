import { AppError } from '@pdftools/errors';
import type { AppSwitches } from './app-switches';
import type { OwnerIdentity, WorkIdentity } from './quota-service';

/**
 * The creation gate: who may start new work (`docs/0-TENANT-FIRST.md` §4.2).
 *
 * Two refusals live here and they are not the same refusal, even though both are `AUTH_REQUIRED`:
 *
 *  - **No account at all** — a guest on an installation that serves accounts. There is nothing to read and nothing
 *    to run, so the client's only useful answer is a sign-in gate.
 *  - **An anonymous session, on an installation where anonymous use has been switched off.** This caller *does* own
 *    rows: an upload staged a minute ago, a finished job they have not downloaded. Refusing the new work while
 *    leaving the reads alone is what keeps the switch from deleting work people can already see
 *    (`docs/0-TENANT-FIRST.md` §4.3), and the message says so, because the alternative is a user concluding their
 *    documents are gone.
 *
 * What this deliberately is *not*:
 *
 *  - **Not a route middleware.** A guard at the route would gate the path, and a job can also be created by the
 *    service layer; the assertion narrows the *identity*, so a call path that reaches `createJob` without passing
 *    here does not compile. That is the property worth having, and it is the reason the signature is
 *    `asserts identity is WorkIdentity` rather than `assertCreationAllowed(): void`.
 *  - **Not a plan or permission check.** A signed-in caller is not examined here at all: their plan comes from the
 *    entitlement mirror, and their app permissions from the platform. Adding a second opinion about access to this
 *    function is how a gate and a plan end up disagreeing about the same request.
 *
 * Every field in the refusal's `details` is read off the resolved switch, never written as a constant — including the
 * one the branch condition already implies. `details.allowAnonymous` is what a gate UI answers "may I offer the
 * no-account path?" with, so a literal there is a value nobody resolved, and one round of this work shipped exactly
 * that mistake (§7a.3, defect 206).
 */

export function assertCreationAllowed(
  identity: OwnerIdentity,
  /**
   * The installation switches exactly as `appSwitches().resolve()` returned them.
   *
   * The **whole** answer, not a `{ allowAnonymous: boolean }` of its own: a policy invented at the call site has to
   * name a `source` and a `resolvedAt` too, which is deliberate friction. The narrower shape is what let an
   * identity-resolution return write a literal `true` where it meant "the resolved value" — a legacy anonymous cookie
   * then carried `true` into a stack whose anonymous use was off, and the guard accepted the upload it exists to
   * refuse. That was found by running both stacks, not by reading this back.
   */
  policy: AppSwitches,
): asserts identity is WorkIdentity {
  if (identity.kind === 'guest') {
    // The default message for the code, used as-is: a visitor with no session is the case the code was added for,
    // and the hint they need is the ordinary one — sign in.
    throw new AppError('AUTH_REQUIRED', undefined, {
      reason: 'no_account',
      // Reported from the resolved switch rather than written as `false`, even though a guest can only have been
      // resolved while the switch read off. Both branches spell this field the same way on purpose: a literal here
      // is indistinguishable from the defect that made this parameter the whole `AppSwitches` (see below), and
      // the client reads this field to decide whether to offer "continue without an account" at all.
      allowAnonymous: policy.allowAnonymous,
    });
  }

  if (identity.kind === 'anonymous' && !policy.allowAnonymous) {
    throw new AppError(
      'AUTH_REQUIRED',
      'Anonymous use is switched off on this installation. Sign in to start a new job — anything you already ran is still available.',
      { reason: 'anonymous_disabled', allowAnonymous: policy.allowAnonymous },
    );
  }
}

/**
 * The strict-mode gate: **may this caller see any of this installation at all?**
 *
 * The second question beside `assertCreationAllowed`, and the two are different products rather than two strengths of
 * one. That one refuses the *act* of starting something and leaves every read alone, which is what lets an
 * installation keep serving a catalogue to visitors. This one refuses the product: with it on, there is no public
 * page, so the routes that hand a stranger the tool definitions or someone's file list are refused too.
 *
 * Three properties, each of them a decision:
 *
 *  - **`guest` and `anonymous` are refused; an account is not.** A caller with no session never had a surface here,
 *    and an existing anonymous session is exactly the case a page gate cannot cover — its cookie is old, so it keeps
 *    working after the switch on the platform changes. Nothing is deleted by refusing it: signing in adopts the work
 *    it already did (`adoptAnonymousWork`), and the message says so rather than leaving someone to conclude their
 *    uploads are gone.
 *  - **A different `reason` from every other refusal.** `strict_mode` is not `anonymous_disabled`: the remedy and the
 *    explanation differ (this installation publishes nothing, versus this installation stopped accepting new work),
 *    and a client that showed the wrong one would be describing a product that does not exist.
 *  - **Nothing here is a permission or a plan check.** An account is not examined: what it may do is the entitlement
 *    mirror's answer and the platform's app roles, and a second opinion here is how two gates end up disagreeing
 *    about one request.
 *
 * Called from the routes rather than from the identity resolver on purpose. `resolveIdentity` has to keep answering
 * for a guest — the sign-in gate, `/me` and the SSO routes are built on it — so a refusal placed there would break
 * the only door that can fix the problem.
 */
export function assertSurfaceAllowed(identity: OwnerIdentity, policy: AppSwitches): void {
  if (!policy.strictMode) return;
  if (identity.kind === 'user' || identity.kind === 'api_key') return;

  if (identity.kind === 'guest') {
    throw new AppError('AUTH_REQUIRED', undefined, {
      reason: 'strict_mode',
      allowAnonymous: policy.allowAnonymous,
      strictMode: true,
    });
  }

  throw new AppError(
    'AUTH_REQUIRED',
    'This installation requires an account. Sign in to continue — anything you already ran is kept and follows you in.',
    { reason: 'strict_mode', allowAnonymous: policy.allowAnonymous, strictMode: true },
  );
}
