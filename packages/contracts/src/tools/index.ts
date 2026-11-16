import type { ZodIssue } from 'zod';
import { CATALOG_VERSION, TOOLS, TOOLS_BY_ID, getTool } from './catalog';
import type { ToolDefinition, ToolQueue } from './types';

export * from './types';
export * from './options';
export * from './secrets';
export * from './password-strength';
export * from './page-ranges';
export { TOOLS, TOOLS_BY_ID, getTool, requireTool, toolsByCategory, acceptsType, CATALOG_VERSION } from './catalog';
export { optionKeys } from './types';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export type ValidationResult<TOptions = unknown> =
  | { ok: true; options: TOptions }
  | { ok: false; issues: ValidationIssue[] };

function toIssues(issues: ZodIssue[]): ValidationIssue[] {
  return issues.map((i) => {
    // `unrecognized_keys` puts the offending names in `keys`, not in `path`. Reporting "(root)" for a mistyped
    // option name tells the user nothing about what to fix, and this is the error a typo produces.
    const unnamedKeys = i.code === 'unrecognized_keys' ? (i as ZodIssue & { keys?: string[] }).keys : undefined;
    return {
      path: unnamedKeys?.length ? unnamedKeys.join(', ') : i.path.join('.') || '(root)',
      message: i.message,
      code: i.code,
    };
  });
}

/**
 * Parse tool options with the registry schema.
 *
 * Called twice on purpose: once by the API when the job is created (so the user gets a field-level error
 * immediately) and once by the worker at claim time (a payload can be crafted directly onto the queue).
 */
export function validateOptions(toolId: string, raw: unknown): ValidationResult {
  const def = getTool(toolId);
  if (!def) {
    return { ok: false, issues: [{ path: 'tool', message: `Unknown tool: ${toolId}`, code: 'invalid_enum_value' }] };
  }
  const parsed = def.options.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error.issues) };
  return { ok: true, options: parsed.data };
}

/**
 * Shape returned by `GET /api/v1/tools` — everything the UI needs, computed for the caller's plan.
 *
 * `queue` and `limits` are in the list response, not only in the detail response, precisely because the UI needs
 * them: the tool page shows which pool a job will run in and what its wall-clock and memory budget are. Fetching
 * the detail endpoint for data the list already knows would mean two round trips to render one screen.
 */
export interface CatalogEntry {
  id: string;
  category: string;
  title: string;
  summary: string;
  queue: ToolQueue;
  input: ToolDefinition['input'];
  output: ToolDefinition['output'];
  optionsUi: ToolDefinition['optionsUi'];
  limits: ToolDefinition['limits'];
  /**
   * Uploads this tool needs beyond its documents, named by option.
   *
   * In the catalog because the form cannot render `imageFileId` as an upload without knowing what to accept, and
   * because "this tool needs a logo as well" is part of what the tool is.
   */
  auxiliaryFiles?: ToolDefinition['auxiliaryFiles'];
  /**
   * Option keys whose values this build never persists (`./secrets.ts`).
   *
   * In the public catalog, not just the server-side definition, for two reasons: the UI should not pre-fill a field
   * it could only ever fill with a placeholder, and the E2E harness reads the declaration from here instead of being
   * told which option is secret by a flag — a check somebody has to remember to pass is a check somebody forgets.
   */
  secrets: readonly string[];
  /**
   * The subset of `secrets` that are passwords this tool **chooses**, and so are judged by the strength policy
   * (`./password-strength.ts`).
   *
   * In the public catalog for the same reason `secrets` is: the form is the place where a weak password is still
   * cheap to fix, and it can only say so if it knows which fields the rule applies to. `unlock`'s `password` is not
   * here — that one already exists on somebody else's document.
   */
  setsPasswords: readonly string[];
  phase: number;
  enabled: boolean;
  available: boolean;
  requiresPlan?: string[];
}

export interface Catalog {
  catalogVersion: number;
  tools: CatalogEntry[];
  plan: {
    id: string;
    maxFileMb: number;
    maxJobMb: number;
    maxPages: number;
    maxFiles: number;
    queuePriority: number;
  };
}

export function buildCatalog(
  planId: string,
  planLimits: Omit<Catalog['plan'], 'id'>,
  availableTools: (id: string) => boolean,
): Catalog {
  return {
    catalogVersion: CATALOG_VERSION,
    tools: TOOLS.map((t) => ({
      id: t.id,
      category: t.category,
      title: t.title,
      summary: t.summary,
      queue: t.queue,
      input: t.input,
      output: t.output,
      optionsUi: t.optionsUi,
      limits: t.limits,
      auxiliaryFiles: t.auxiliaryFiles,
      secrets: t.secrets ?? [],
      setsPasswords: t.setsPasswords ?? [],
      phase: t.phase,
      enabled: t.enabled,
      available: t.enabled && availableTools(t.id),
      requiresPlan: t.plans,
    })),
    plan: { id: planId, ...planLimits },
  };
}

/** Tool ids routed to one pool. Used by the worker bootstrap to subscribe to the right handlers. */
export function toolsForQueue(queue: ToolQueue): ToolDefinition[] {
  return TOOLS.filter((t) => t.queue === queue || t.escalate?.queue === queue);
}

/**
 * The most files any enabled tool accepts in a single request.
 *
 * Read by the upload rate limiter as its burst allowance, for one reason: a limit smaller than the largest legal
 * request refuses a request the product says it accepts. A 50-file merge behind a 30-uploads-per-minute limit
 * cannot be staged inside a minute at all, so "merge up to 50 files" would be true on the contract and false in
 * practice. Deriving the number from the registry rather than writing it at the limiter keeps the two from drifting
 * apart when a tool's `maxFiles` changes.
 */
export function largestInputBatch(): number {
  return TOOLS.filter((tool) => tool.enabled).reduce((max, tool) => Math.max(max, tool.input.maxFiles), 0);
}
