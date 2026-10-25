import rateLimit, { Options } from 'express-rate-limit';
import RedisStore, { RedisReply } from 'rate-limit-redis';
import { config } from '../config';
import { redis } from '../redis';

// Redis-backed counters so limits hold across instances; memory store otherwise.
function store(prefix: string): Options['store'] {
  const client = redis;
  if (!client) return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as Promise<RedisReply>,
  });
}

const common = {
  windowMs: 60_000,
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
};

/** Per-IP, applied to everything. */
export const globalLimiter = rateLimit({
  ...common,
  limit: config.RATE_LIMIT_GLOBAL_PER_MIN,
  store: store('global'),
});

/** Per-user, applied after authentication on the send endpoint. */
export const sendLimiter = rateLimit({
  ...common,
  limit: config.RATE_LIMIT_SEND_PER_MIN,
  keyGenerator: (req) => `u:${req.userId ?? 'anon'}`,
  store: store('send'),
});
