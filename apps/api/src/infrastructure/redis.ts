import { redisConnection } from '@pdftools/queue';
import type { Redis } from 'ioredis';

/** Shared command connection (also used by BullMQ, which needs `maxRetriesPerRequest: null`). */
export function redis(): Redis {
  return redisConnection();
}

export async function pingRedis(): Promise<number> {
  const start = performance.now();
  await redis().ping();
  return Math.round(performance.now() - start);
}

export async function redisGet(key: string): Promise<string | null> {
  return await redis().get(key);
}

export async function redisSetNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis().set(key, value, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

export async function redisIncr(key: string, ttlSeconds: number): Promise<number> {
  const value = await redis().incr(key);
  if (value === 1) await redis().expire(key, ttlSeconds);
  return value;
}

export async function redisDel(key: string): Promise<void> {
  await redis().del(key);
}

/**
 * Run a Lua script, once, on the server.
 *
 * The alternative for anything read-modify-write is two commands and a window between them — which for a rate
 * limiter is the window a caller uses to spend the same token twice. One script is one atomic step, and the keys
 * are passed separately from the arguments so Redis can route the script in a cluster without parsing it.
 */
export async function redisEval(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
  return await redis().eval(script, keys.length, ...keys, ...args);
}
