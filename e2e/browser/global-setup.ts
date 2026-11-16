import type { FullConfig } from '@playwright/test';
import { STAGE_VIEWPORT, WEB_URL } from '../../playwright.config';
import { requireAnonymousUse } from '../lib/stack-gap';

/**
 * The browser stage's pre-flight, in one place rather than five.
 *
 * `docs/0-TENANT-FIRST.md` §6: the tenant-first profile is the only stack where the 401 path is real, and on it every
 * case in `e2e/browser` fails for the same reason — the dropzone it drives refuses to hand a document to a caller with
 * no account. Five red files, each with a screenshot of the same sign-in gate, is a worse report than one line saying
 * which stack the cases need.
 *
 * The probe goes to the **web origin**, not the API port, and that is deliberate: it is the same `/api/v1/me` the SPA
 * itself calls, through the same nginx proxy, so the check also proves the proxy path the cases depend on. An API-only
 * probe would pass on a stack whose `/api` proxy is broken, and the stage would then fail five times for a reason
 * unrelated to the switch.
 *
 * The second check is about this repository rather than the stack, and it is here for the same reason the first is: it
 * is a fact about **the whole stage** whose absence is invisible until a case fails for a reason that reads as a bug in
 * the product. Every claim in `e2e/browser` is measured on whatever window the browser was given, so a stage that
 * quietly runs at another size measures something nobody declared (defect 255).
 *
 * Playwright runs this once, before any project, so a tenant-first stack stops the stage with `STACK_GAP_EXIT_CODE`
 * and a named reason instead of producing 5 failures and 5 screenshots.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  requireStageViewport(config);
  await requireAnonymousUse(
    WEB_URL,
    'every browser case drives the upload form, which this stack refuses to a caller with no account',
  );
}

/**
 * The stage runs at the viewport `playwright.config.ts` declares, or it says so before running a single case.
 *
 * The viewport a project gets is the one in **its own** `use`, and that is the fold the defect lived in: a project that
 * spreads a device descriptor has the descriptor's viewport *in* that object (Desktop Chrome is 1280 × 720), so a
 * file-level default is not inherited, it is overridden — silently, because both lines look right. Reading the
 * project's resolved number is what makes this a check of the stage rather than a second spelling of `STAGE_VIEWPORT`,
 * and it is what would have caught the twelve files that ran at a size nothing had declared while the config,
 * `0-CICD.md` and two cases' own "restore the default" calls all said 1440 × 900 (defect 255).
 *
 * One viewport for the stage is the design, not a limitation: a case that needs another window narrows it itself
 * (`page.setViewportSize`), which is where the claim about that width lives — `edit-pdf`'s 380 px and `reorder-pages`'
 * 1000 px readings both do exactly that.
 */
function requireStageViewport(config: FullConfig): void {
  for (const project of config.projects) {
    const { viewport } = project.use;
    if (viewport?.width === STAGE_VIEWPORT.width && viewport?.height === STAGE_VIEWPORT.height) continue;
    throw new Error(
      `project "${project.name}" is set to ${viewport?.width ?? 'no'} × ${viewport?.height ?? 'no'} viewport, not the stage's ${STAGE_VIEWPORT.width} × ${STAGE_VIEWPORT.height}: a project's \`use\` overrides the file's, and every device descriptor carries a viewport of its own, so the project has to name it (\`viewport: STAGE_VIEWPORT\` in \`playwright.config.ts\`).`,
    );
  }
}
