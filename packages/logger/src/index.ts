import { config } from '@pdftools/config';
import pino, { type Logger } from 'pino';

/**
 * Logging rules from `docs/0-SECURITY.md` §5 and `CROSS-MODULE.md` §7:
 *
 * - passwords are redacted by key name, everywhere, before anything is written;
 * - document content, page text, and file names never appear in logs;
 * - `requestId`/`jobId`/`tool` are child-logger fields so a single grep reconstructs one job's story.
 */
const REDACT_PATHS = [
  'password',
  'userPassword',
  'ownerPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'headers.authorization',
  'headers.cookie',
  'cookie',
  'session',
  'secret',
  'apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'options.password',
  'options.userPassword',
  'options.ownerPassword',
];

let root: Logger | null = null;

export function logger(): Logger {
  if (root) return root;
  root = pino({
    level: config.logLevel,
    base: { service: 'pdftools', version: config.version },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    transport: config.logPretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,version' },
        }
      : undefined,
  });
  return root;
}

export function childLogger(fields: Record<string, unknown>): Logger {
  return logger().child(fields);
}

export function jobLogger(jobId: string, tool: string, workerId?: string): Logger {
  return logger().child({ jobId, tool, ...(workerId ? { workerId } : {}) });
}

export type { Logger };
