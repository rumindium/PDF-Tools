import { describe, expect, test } from 'bun:test';
import { asAppError } from '@pdftools/errors';
import { Elysia } from 'elysia';
import { strictSurfaceWith } from '../src/plugins/strict-surface';
import type { AppSwitches } from '../src/services/app-switches';

/**
 * The strict-mode edge, asserted where it can actually fail (`docs/0-TENANT-FIRST.md` §4.2).
 *
 * This file exists because of a defect that no other kind of test could see. The hook was written, registered in
 * `app.ts`, and reviewed — and it guarded **nothing**, because Elysia's default hook scope is `local` and a local hook
 * inside a plugin does not reach the parent that `use`d it. Every unit test of the policy still passed, because the
 * policy was never the broken part; a strict installation simply went on serving its catalogue. The two properties
 * below are the ones that would have caught it:
 *
 *  1. **A route composed after the hook is refused; a route composed before it is not.** The second half is not a
 *     convenience — `/me` and `/sso/*` are registered before the hook on purpose, and they are the only door that can
 *     satisfy a gate. A test that only checked the refusal would also pass for a hook that leaked everywhere, which
 *     would leave an installation nobody can enter.
 *  2. **A refused request never reaches its handler.** Asserted with a counter rather than by reading the response:
 *     "it answered 401" and "it did not run" are different claims, and the second is the one the edge is for. The
 *     browser gate is a page; this is what makes it more than a suggestion to a client that could ignore it.
 *
 * The composition order mirrors `app.ts` — public routes, then the hook, then the product — and the requests go
 * through `app.handle` so the hook runs in the real lifecycle rather than being called by hand. The switch is
 * injected because both positions must be posed in one process: `config` is read once, so an installation's strict
 * mode cannot be flipped mid-run, and a test that could only see one position would be back to reading the code.
 */

/** An answer with strict mode on — `allowAnonymous` already false, exactly as the resolver would pair them. */
function switches(over: Partial<AppSwitches> = {}): AppSwitches {
  return { allowAnonymous: false, strictMode: true, source: 'env', resolvedAt: Date.now(), ...over };
}

/** `app.ts`'s order in miniature: what is public, then the edge, then the product. */
function compose(answer: AppSwitches) {
  const ran = { product: 0, publicRoute: 0 };

  const app = new Elysia({ name: 'probe-root' })
    // `app.ts`'s error mapping in miniature, through the same `asAppError`: the *body shape* is the app's business and
    // not the hook's, and it is mirrored here so that the assertion can name the error the hook threw instead of
    // accepting any 401 from anywhere. Elysia's default rendering of a thrown `AppError` is a bare message.
    .onError(({ error, set }) => {
      const mapped = asAppError(error);
      set.status = mapped.status;
      return { error: { code: mapped.code, details: mapped.details } };
    })
    // Stands in for `/health`, `/me` and `/sso/*`: registered *before* the hook, and required to stay reachable —
    // `/me` is where a client is told strict mode is on, and `/sso/*` is the only way to satisfy it.
    .get('/public', () => {
      ran.publicRoute += 1;
      return { ok: 'public' };
    })
    .use(strictSurfaceWith(async () => answer))
    // Stands in for the catalogue, the tool definitions and the file list: the product surface.
    .get('/product', () => {
      ran.product += 1;
      return { ok: 'product' };
    });

  const get = async (path: string) => {
    // A real hostname: measurements of this hook against the installed Elysia showed a single-label host (`http://x/`)
    // failing to route at all, which would have made a broken guard look like a working one.
    const response = await app.handle(new Request(`http://localhost:4000${path}`));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  return { get, ran };
}

describe('the strict-mode edge', () => {
  test('refuses a caller with no account on the product routes, and lets them reach the door', async () => {
    const { get, ran } = compose(switches());

    const product = await get('/product');
    expect(product.status).toBe(401);
    expect(product.body).toMatchObject({ error: { code: 'AUTH_REQUIRED', details: { reason: 'strict_mode' } } });

    // The public half, which is a refusal to *not* guard: a gate that covered these would describe an installation
    // with no way in.
    const publicRoute = await get('/public');
    expect(publicRoute.status).toBe(200);
    expect(ran.publicRoute).toBe(1);
  });

  test('the refusal happens before the handler, not after it', async () => {
    const { get, ran } = compose(switches());

    await get('/product');

    // The claim the edge exists for: with the switch on there is no public page, so the route that would have built
    // one must not have run at all. Reading the 401 alone would accept a guard that ran the work and then complained.
    expect(ran.product).toBe(0);
  });

  test('with strict mode off nothing is refused and the product serves visitors', async () => {
    const { get, ran } = compose(switches({ strictMode: false, allowAnonymous: true }));

    expect((await get('/product')).status).toBe(200);
    expect(ran.product).toBe(1);
  });

  test('the answer is read once per request, not once per route', async () => {
    // Cheapness is a design claim in this plugin (`app.ts` explains the ordering), and the way it would break silently
    // is a second resolution somewhere below. One request, one lookup.
    let lookups = 0;
    const app = new Elysia({ name: 'count-root' })
      .get('/public', () => ({ ok: 1 }))
      .use(
        strictSurfaceWith(async () => {
          lookups += 1;
          return switches({ strictMode: false });
        }),
      )
      .get('/product', () => ({ ok: 1 }));

    await app.handle(new Request('http://localhost:4000/product'));
    expect(lookups).toBe(1);
  });
});
