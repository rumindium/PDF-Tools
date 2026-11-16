import { describe, expect, test } from 'bun:test';
import { ApiError } from './api-client';
import { type SsoHandoffDeps, completeSsoHandoff } from './sso-handoff';

/**
 * The handoff orchestration (`lib/sso-handoff.ts`), pinned without a browser.
 *
 * The claim that matters is the order: exchange, then reload, then leave. A test that only checks \"ends up
 * home\" would pass for the fire-and-forget version too — the version where the header flashes Anonymous because
 * `/` rendered from the stale session. So the success case records the call order and holds the reload open with
 * a deferred promise to prove leaving waits for it.
 */
describe('completeSsoHandoff', () => {
  test('consumes, reloads, then leaves — in that order', async () => {
    const order: string[] = [];
    let resolveReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => {
      resolveReload = resolve;
    });
    const deps: SsoHandoffDeps = {
      consume: async (code) => {
        order.push(`consume:${code}`);
      },
      reload: () => {
        order.push('reload-start');
        return reloadGate.then(() => {
          order.push('reload-done');
        });
      },
      navigateHome: () => {
        order.push('navigate');
      },
    };

    const pending = completeSsoHandoff('code-1', deps);
    // Let the microtasks run: consume resolves, reload starts, and then nothing — leaving waits on the gate.
    await Bun.sleep(0);
    expect(order).toEqual(['consume:code-1', 'reload-start']);

    resolveReload();
    expect(await pending).toBeNull();
    expect(order).toEqual(['consume:code-1', 'reload-start', 'reload-done', 'navigate']);
  });

  test('a refused code reports the API message and never reloads or leaves', async () => {
    const order: string[] = [];
    const failure = await completeSsoHandoff('used-code', {
      consume: async () => {
        throw new ApiError('HANDOFF_INVALID', 'Handoff codes can only be used once.', 400);
      },
      reload: async () => {
        order.push('reload');
      },
      navigateHome: () => {
        order.push('navigate');
      },
    });
    expect(failure).toBe('Handoff codes can only be used once.');
    expect(order).toEqual([]);
  });

  test('a non-API failure is still a message, not a hang', async () => {
    const failure = await completeSsoHandoff('code-9', {
      consume: async () => {
        throw new Error('network down');
      },
      reload: async () => {},
      navigateHome: () => {},
    });
    expect(failure).toContain('network down');
  });
});
