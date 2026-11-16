import type { MeBody } from '@pdftools/contracts/api';
import type { Catalog } from '@pdftools/contracts/tools';
import { ApiError } from './api-client';

/**
 * What one page load should write, from the two answers it asked for.
 *
 * `GET /me` and `GET /tools` are fetched together because they answer one question between them — what may this caller
 * do — but they are **not** a pair, and treating them as one is a defect that shipped: under `Promise.all`, a refusal
 * of the second threw away the first.
 *
 * The refusal is deliberate. With strict mode on there is no public page (`docs/0-TENANT-FIRST.md` §4.4), so
 * `/api/v1/tools` answers `AUTH_REQUIRED` to anyone without an account — and the identity that would have been read
 * from `/me` is exactly what the sign-in gate is made of. A strict installation therefore rendered its shell, an
 * "Could not reach the API" banner and an empty tool grid, and never offered the one thing it accepts. Measured in a
 * browser on the live stack; every unit test passed, because nothing was wrong with either call on its own.
 *
 * Two rules, and they are different rules:
 *
 *  1. **A refusal is not a fault.** `AUTH_REQUIRED` from the catalogue is this installation stating a policy, and a
 *     banner describing an outage over it tells the person the opposite of what happened. Every other failure — a
 *     network drop, a 500, a malformed body — is a fault and still gets the banner.
 *  2. **The identity outlives the catalogue.** A failed `/me` does not erase an identity already on screen (the app
 *     keeps working from its last good answer), and a refused catalogue never takes the identity with it. What it
 *     *does* take is any catalogue held from an earlier load: those tools and their ceilings were computed for
 *     somebody this installation no longer serves, and leaving them up is how a form offers an upload the API will
 *     refuse.
 *
 * Pure, and taking the settled results rather than the promises, so both halves are testable without a network: the
 * wrong version of this function is the one where a refused catalogue clears `me`, and that case cannot be produced by
 * a running stack whose switch is in one position.
 */
export interface ReconcileInput {
  me: PromiseSettledResult<MeBody>;
  catalog: PromiseSettledResult<Catalog>;
}

export interface ReconcileResult {
  /** The identity to write, or `null` for "leave the one you have" — a failed `/me` is not an empty identity. */
  me: MeBody | null;
  /** The catalogue to write, or `null` to clear it. Cleared whenever the last attempt did not produce one. */
  catalog: Catalog | null;
  /** The banner, or `null` for "nothing worth interrupting the person about". */
  error: ApiError | null;
}

function failure(result: PromiseSettledResult<unknown>): ApiError | null {
  if (result.status !== 'rejected') return null;
  const reason = result.reason;
  return reason instanceof ApiError ? reason : new ApiError('INTERNAL_ERROR', String(reason), 0);
}

export function reconcileLoad({ me, catalog }: ReconcileInput): ReconcileResult {
  const meError = failure(me);
  const catalogError = failure(catalog);

  return {
    me: me.status === 'fulfilled' ? me.value : null,
    catalog: catalog.status === 'fulfilled' ? catalog.value : null,
    // `/me` first: if the identity itself could not be read, that is the failure worth reporting, and it is also the
    // only one that leaves the rest of the page guessing.
    error: meError ?? (catalogError?.code === 'AUTH_REQUIRED' ? null : catalogError),
  };
}
