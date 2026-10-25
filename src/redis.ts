import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

export const redis: Redis | null = config.REDIS_URL
  ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
  : null;

redis?.on('error', (err: Error) => logger.error({ err }, 'redis error'));
