import type { MeBody } from '@pdftools/contracts/api';
import type { Catalog, CatalogEntry } from '@pdftools/contracts/tools';
import { FactList, InfoTip } from '../../components/ui';
import { formatBytes } from '../../lib/format';

/**
 * What a run will do — the output, the pool's own limits, the plan's ceilings and the retention window — behind a `ⓘ`.
 *
 * One component because three places state these four facts and they must not drift: the tool page's banner while the
 * session has no document in it, the **foot of the studio's inspector** once it does, and — in full screen, where the
 * inspector is hidden and the bar is the only part of the studio the mode keeps — the **studio bar**, which slides back
 * in when the pointer reaches the stage's top edge. All three are wired in `features/placement/index.tsx` and
 * `routes/tools.$toolId.tsx` (`0-E2E-CHECKLIST.md` §48, §49). The banner used to be the only one, and it is unmounted
 * the moment a document lands — which took the plan's page ceiling and the retention window off the screen exactly when a
 * run was being prepared against them; the bar's copy is the same sentence one level further in, because "one page at a
 * time, and the navigation out of the way" is precisely when a run is about to be started. So the list is written once
 * and rendered in whichever of the three the screen is showing — one at a time, never two.
 *
 * `side` and `align` are what differ, and both are about room rather than about wording. In the banner the panel has the
 * rest of the page under it. At the foot of the inspector — which is its own scroll container — it opens **above**
 * itself, because a panel below that trigger is a panel the reader has to scroll to find. The bar in full screen has the
 * opposite problem and so the opposite answer: its trigger rides the top of a stage that clips its own overflow, so the
 * panel opens **below**. The trigger is at the column's left edge in the foot and sits after the bar's own document chip,
 * so the panel is anchored by its leading edge in both and hangs over the thing it belongs to rather than over the
 * drawing (`InfoTip` clamps either one to the window, defect 257).
 *
 * Nothing here is guessed from the tool: every number comes from the catalog entry or the session the API handed the
 * page (`me.entitlements`, `catalog.plan`), which is what keeps the panel honest about a plan this build knows nothing
 * about.
 */
export function RunFacts({
  tool,
  me,
  catalog,
  side = 'below',
  align = 'end',
}: {
  tool: CatalogEntry;
  /** The caller's plan and entitlements; `null` while the session is still loading. */
  me: MeBody | null;
  catalog: Catalog | null;
  /** Which way the panel opens — `above` at the foot of a scrolling column. */
  side?: 'below' | 'above';
  /** Which edge of the trigger the panel is anchored by — `start` where the trigger is the column's own left edge. */
  align?: 'start' | 'end';
}) {
  return (
    <InfoTip label={`What a ${tool.title} run will do`} side={side} align={align}>
      <span className="strong small">Before you run it</span>
      <FactList
        facts={[
          ['Output', `${tool.output.kind} · ${tool.output.mime}`],
          [
            'Job limits',
            `${tool.limits.timeoutSeconds}s wall clock · ${tool.limits.memoryMb} MB · ${
              tool.limits.maxPages > 0 ? `${tool.limits.maxPages} pages` : 'no extra page cap'
            }`,
          ],
          [
            'Fair-use limits',
            `Free · ${me?.entitlements.maxPages ?? '—'} pages · ${formatBytes(
              (me?.entitlements.maxJobMb ?? 0) * 1024 * 1024,
            )} per job`,
          ],
          [
            'Retention',
            // The deadline that matters is on the job row and is printed in the result panel; this is the policy behind
            // it, which is the only thing knowable before a job exists.
            catalog?.plan.id === 'anonymous' ? '30 minutes for a session with no account' : 'Per the retention window',
          ],
        ]}
      />
    </InfoTip>
  );
}
