import { Elysia } from 'elysia';
import { assertSurfaceAllowed } from '../services/access-policy';
import { type AppSwitches, appSwitches } from '../services/app-switches';
import { resolveIdentity } from './session';

/**
 * Strict mode at the edge: with it on, the product routes serve accounts only (`docs/0-TENANT-FIRST.md` §4.2).
 *
 * The page gate is the visible half of this and the browser cannot be the whole of it. A router that renders the gate
 * decides what *this* bundle shows; the catalogue, the tool definitions and someone's file list are still one `curl`
 * away, and an anonymous session minted before the switch was flipped never even loads a page that would ask. So the
 * decision is made here, once, in front of the routes that hand out the product — and the client mirrors it rather
 * than being trusted to enforce it.
 *
 * **Ordered so the common case is free.** The switch is read first and the identity only second: with strict mode off
 * this hook is one cached memory read per request, and no identity is resolved, no session is minted and no cookie is
 * re-emitted. Only a strict installation pays for the second resolution — one extra read, and it is read-only by
 * construction, because strict mode resolves `allowAnonymous` to `false` and `resolveIdentity` therefore never mints
 * (`plugins/session.ts`'s refusal to create is what makes this hook cheap as well as correct).
 *
 * **A named plugin, registered before the product modules**, because Elysia scopes hooks by composition order: this
 * exists as its own plugin rather than as three calls inside three modules so that the routes it covers are decided
 * once, in `app.ts`, where a reader can see which modules are behind it. Registering it inside each module would be
 * the same guarantee with three places to forget it.
 *
 * **`as: 'scoped'`, which is not the default and is load-bearing.** Elysia's default scope is `local`, and a *local*
 * hook inside a plugin reaches nothing in the parent that `use`d it: this hook was written, registered, reviewed — and
 * covered no route at all, so a strict installation went on serving its catalogue. Measured against the installed
 * Elysia (1.4.30) with one guard plugin and three probe routes, answering which paths the hook can see:
 *
 * ```text
 * (default) /before=200  /after-own=200  /product=200     <- composes, guards nothing
 * local     /before=200  /after-own=200  /product=200     <- same thing, said out loud
 * scoped    /before=200  /after-own=BLOCKED  /product=BLOCKED
 * global    /before=200  /after-own=BLOCKED  /product=BLOCKED
 * ```
 *
 * `scoped` and `global` answer the same way under this ordering; `scoped` is the one chosen, because the difference is
 * what happens to `/me`, `/health` and `/sso/*` — registered *before* this plugin and deliberately outside it. `global`
 * is documented as order-independent, which is a promise about the routes this design needs to stay public, so the
 * narrower scope is the one whose meaning does not depend on a future Elysia release keeping that promise.
 *
 * The type checker cannot catch this class of mistake — a hook that guards nothing is still a `Elysia` instance — so
 * the ordering is asserted where it can fail: `test/strict-surface.test.ts` composes the hook the way `app.ts` does,
 * with routes on both sides of it, and probes both positions of the switch.
 */
export function strictSurfaceWith(resolve: () => Promise<AppSwitches>) {
  return new Elysia({ name: 'strict-surface' }).onBeforeHandle(
    // `scoped`, not the default `local`: see the measurement above.
    { as: 'scoped' },
    async (ctx) => {
      const switches = await resolve();
      if (!switches.strictMode) return;
      const auth = await resolveIdentity(ctx);
      assertSurfaceAllowed(auth.identity, switches);
    },
  );
}

/**
 * The resolver is a parameter only so that both positions of the switch can be posed in a test — the wiring this file
 * is *about* (which routes the hook reaches, and that a refused request never reaches its handler) is not observable
 * in a process whose strict mode was fixed before the module graph loaded. `appSwitches()` is what ships.
 */
export const strictSurface = strictSurfaceWith(() => appSwitches().resolve());
