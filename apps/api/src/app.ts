import { randomUUID } from 'node:crypto';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { config, isProduction } from '@pdftools/config';
import { asAppError } from '@pdftools/errors';
import { childLogger } from '@pdftools/logger';
import { Elysia } from 'elysia';
import { accountModule, healthModule } from './modules/account';
import { adminModule } from './modules/admin';
import { filesModule } from './modules/files';
import { jobsModule } from './modules/jobs';
import { toolsModule } from './modules/tools';
import { strictSurface } from './plugins/strict-surface';

const log = childLogger({ component: 'api' });

/**
 * Error mapping (`docs/0-API.md` §7). One shape for every failure, no stack traces, no engine stderr, no
 * filesystem paths — those belong in `job_events` where only operators look.
 */
export function buildApp() {
  const app = new Elysia({ name: 'pdftools-api' })
    .use(
      cors({
        origin: config.api.corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'Last-Event-ID', 'X-Request-Id'],
        exposeHeaders: ['X-Request-Id', 'Retry-After'],
      }),
    )
    .onRequest(({ request, set }) => {
      const requestId = request.headers.get('x-request-id') ?? randomUUID();
      set.headers['X-Request-Id'] = requestId;
      set.headers['X-Content-Type-Options'] = 'nosniff';
      set.headers['Referrer-Policy'] = 'no-referrer';
      if (isProduction()) {
        set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
      }
    })
    // A single handler on purpose: two would mean the first one to return a value wins, and a generic mapper
    // placed first would swallow every validation error into a 500.
    .onError(({ error, code, set, path }) => {
      const requestId = String(set.headers['X-Request-Id'] ?? randomUUID());
      set.headers['X-Request-Id'] = requestId;

      if (code === 'VALIDATION' || code === 'PARSE') {
        set.status = 422;
        return {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'The request body or parameters are not valid.',
            requestId,
            details: { issues: (error as { all?: unknown[] }).all ?? String((error as Error)?.message ?? error) },
          },
        };
      }
      if (code === 'NOT_FOUND') {
        set.status = 404;
        return { error: { code: 'JOB_NOT_FOUND', message: 'No such endpoint.', requestId } };
      }

      const appError = asAppError(error);
      // 5xx is ours to fix, 4xx is the caller's; only the former is worth an error-level log with a stack. The
      // stack is included because a 500 that logs only its message ("Expected Request object") names a symptom
      // and not a line — the one thing an operator cannot reconstruct from a client report.
      const level = appError.status >= 500 ? 'error' : 'debug';
      log[level](
        {
          err: String(error),
          code: appError.code,
          path,
          requestId,
          ...(level === 'error' ? { stack: (error as Error)?.stack } : {}),
        },
        'request failed',
      );

      set.status = appError.status;
      return {
        error: {
          code: appError.code,
          message: appError.message,
          requestId,
          ...(appError.details ? { details: appError.details } : {}),
        },
      };
    })
    .use(healthModule)
    // Account and SSO before the strict edge, and that order is the feature: `/me` is where a client learns that
    // strict mode is on, and `/sso/*` is the only door that can satisfy it. A guard that stood in front of these
    // would refuse the visitor the explanation and the way in, and leave an installation nobody can enter.
    .use(accountModule)
    // Strict mode: with it on, everything registered *after* this line serves accounts only
    // (`plugins/strict-surface.ts` explains why the decision is made at the edge rather than in each module).
    .use(strictSurface)
    .use(toolsModule)
    .use(filesModule)
    .use(jobsModule)
    // The app's own administration area: gated on permissions Auth Platform defines and grants, not on anything this
    // installation decides by itself (`modules/admin.ts`).
    .use(adminModule);

  if (!isProduction()) {
    app.use(swagger({ path: '/api/docs' }));
  }

  // Root: a tiny service description, because "what is on this port" should never require a network call.
  app.get('/', () => ({
    service: 'pdf-tools-api',
    version: config.version,
    catalog: '/api/v1/tools',
    health: '/health',
    docs: isProduction() ? undefined : '/api/docs',
  }));

  return app;
}
