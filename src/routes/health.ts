import { Router } from 'express';
import { pool } from '../db';
import { redis } from '../redis';
import { logger } from '../logger';

export const healthRouter = Router();

// Liveness: process is up. Never touches dependencies (avoids restart storms during a DB blip).
healthRouter.get('/live', (_req, res) => {
  res.json({ ok: true });
});

// Readiness: safe to receive traffic. Load balancers use this.
healthRouter.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    if (redis) await redis.ping();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'readiness check failed');
    res.status(503).json({ ok: false });
  }
});
