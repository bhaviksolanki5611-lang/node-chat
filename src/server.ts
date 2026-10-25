import { app } from './app';
import { config } from './config';
import { pool } from './db';
import { firestore } from './firebase';
import { logger } from './logger';
import { redis } from './redis';

if (config.NODE_ENV === 'production' && !redis) {
  logger.warn('REDIS_URL not set: membership cache and rate limits are per-instance. Required for multi-instance deployments.');
}

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'chat backend listening');
});
// Keep-alive must exceed the load balancer idle timeout (typically 60s) to avoid sporadic 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();

  // Stop accepting new connections, let in-flight requests finish, then release resources.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([pool.end(), redis ? redis.quit() : Promise.resolve(), firestore.terminate()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
