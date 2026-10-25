import { redis } from './redis';
import { logger } from './logger';

/**
 * Tiny cache facade. Redis when REDIS_URL is set (required for multi-instance
 * deployments so invalidation reaches every node); per-process memory otherwise.
 * Fails open: a cache outage degrades to MySQL reads, never to request failures.
 */
const MAX_LOCAL_ENTRIES = 10_000;
const local = new Map<string, { value: string; expiresAt: number }>();

export async function cacheGet(key: string): Promise<string | null> {
  if (redis) {
    try {
      return await redis.get(key);
    } catch (err) {
      logger.warn({ err, key }, 'cache get failed');
      return null;
    }
  }
  const hit = local.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    local.delete(key);
    return null;
  }
  return hit.value;
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (redis) {
    try {
      await redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, 'cache set failed');
    }
    return;
  }
  if (local.size >= MAX_LOCAL_ENTRIES) {
    const oldest = local.keys().next();
    if (!oldest.done) local.delete(oldest.value);
  }
  local.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function cacheDel(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(key);
    } catch (err) {
      logger.warn({ err, key }, 'cache del failed');
    }
    return;
  }
  local.delete(key);
}
