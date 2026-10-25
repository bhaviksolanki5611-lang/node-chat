import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { logger } from '../logger';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = String(req.id ?? '');

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      requestId,
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, requestId });
    return;
  }
  if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body', requestId });
    return;
  }
  if ((err as { type?: string } | null)?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large', requestId });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error', requestId });
}
