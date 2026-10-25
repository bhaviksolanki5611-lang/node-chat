import jwt from 'jsonwebtoken';
import { RequestHandler } from 'express';
import { config } from '../config';
import { unauthorized } from '../errors';

/** Swap this pair for your IdP (JWKS / Firebase Auth ID tokens) without touching the routes. */
export function signAccessToken(userId: number): string {
  return jwt.sign({}, config.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: config.JWT_ISSUER,
    subject: String(userId),
    expiresIn: '1h',
  });
}

function verifyAccessToken(token: string): number {
  const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: config.JWT_ISSUER });
  const sub = typeof payload === 'string' ? undefined : payload.sub;
  const id = Number(sub);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad subject');
  return id;
}

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('Missing bearer token'));
    return;
  }
  try {
    req.userId = verifyAccessToken(header.slice(7));
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
};
