import { config } from '@pdftools/config';
import { CATALOG_VERSION, TOOLS, getTool } from '@pdftools/contracts';
import { AppError } from '@pdftools/errors';
import { Elysia } from 'elysia';
import { resolveIdentity } from '../plugins/session';
import { limitsFor } from '../services/quota-service';

/**
 * `docs/0-API.md` §5 — the catalog the UI renders from.
 *
 * Plan-dependent fields are computed per caller, so the frontend never ships its own accept-list, its own size
 * numbers, or its own idea of which tools exist. That is the whole point of the registry.
 */
export const toolsModule = new Elysia({ prefix: '/api/v1/tools', tags: ['tools'] })
  .get('/', async (ctx) => {
    const auth = await resolveIdentity(ctx);
    const limits = await limitsFor(auth.identity);
    const available = (id: string) => limits.tools.includes('*') || limits.tools.includes(id);

    return {
      catalogVersion: CATALOG_VERSION,
      plan: {
        id: limits.id,
        maxFileMb: limits.maxFileMb,
        maxJobMb: limits.maxJobMb,
        maxPages: limits.maxPages,
        maxFiles: limits.maxFiles,
        queuePriority: limits.queuePriority,
      },
      tools: TOOLS.map((tool) => ({
        id: tool.id,
        category: tool.category,
        title: tool.title,
        summary: tool.summary,
        // The pool is part of the catalog because the UI shows it, and because "this will be slow because it goes
        // to the OCR pool" is information the user should have before submitting rather than after waiting.
        queue: tool.queue,
        input: {
          ...tool.input,
          // Never advertise a per-file ceiling above what this caller's plan allows.
          maxFileMb: Math.min(tool.input.maxFileMb, limits.maxFileMb),
        },
        output: tool.output,
        optionsUi: tool.optionsUi,
        // Which option values this build never stores (`docs/0-SECURITY.md` §5). Published because the UI must not
        // try to pre-fill such a field — the only value it could ever receive back is a placeholder — and because
        // the E2E harness reads the declaration here rather than being told by a flag which option is a secret.
        secrets: tool.secrets ?? [],
        // Published alongside `secrets`, and for the same reason: the form is where a weak password is still cheap to
        // fix, so it has to know which fields the strength policy judges.
        setsPasswords: tool.setsPasswords ?? [],
        limits: tool.limits,
        auxiliaryFiles: tool.auxiliaryFiles,
        phase: tool.phase,
        enabled: tool.enabled && config.flags[tool.id] !== false,
        available: available(tool.id),
        ...(tool.plans?.length ? { requiresPlan: tool.plans } : {}),
      })),
    };
  })
  .get('/:id', async ({ params, ...ctx }) => {
    const auth = await resolveIdentity(ctx);
    const tool = getTool(params.id);
    if (!tool) throw new AppError('VALIDATION_ERROR', `Unknown tool: ${params.id}`);
    const limits = await limitsFor(auth.identity);

    // Explicitly projected: the zod schema is a server-side object and has no business in a JSON response.
    // The UI renders its form from `optionsUi`, which is the serializable half of the same definition.
    return {
      id: tool.id,
      category: tool.category,
      title: tool.title,
      summary: tool.summary,
      queue: tool.queue,
      input: { ...tool.input, maxFileMb: Math.min(tool.input.maxFileMb, limits.maxFileMb) },
      output: tool.output,
      optionsUi: tool.optionsUi,
      secrets: tool.secrets ?? [],
      setsPasswords: tool.setsPasswords ?? [],
      limits: tool.limits,
      auxiliaryFiles: tool.auxiliaryFiles,
      phase: tool.phase,
      requiresPlan: tool.plans ?? null,
      enabled: tool.enabled && config.flags[tool.id] !== false,
      available: limits.tools.includes('*') || limits.tools.includes(tool.id),
    };
  });
