import { Request, Response, RequestHandler } from 'express';
import { forbidden, unauthorized } from '../errors';

export const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function actorOf(req: Request): number {
  if (req.userId === undefined) throw unauthorized('Not authenticated');
  return req.userId;
}

/** The acting user always comes from the token; ids in the body must agree with it. */
export function assertSameUser(actor: number, provided: number | undefined): void {
  if (provided !== undefined && provided !== actor) {
    throw forbidden('User id does not match the authenticated user');
  }
}
