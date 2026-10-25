import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { forbidden } from '../errors';
import { authenticate } from '../middleware/auth';
import * as chats from '../services/chatService';
import { actorOf, wrap } from '../utils/http';

export const userRouter = Router();

// Dev/test helper only: in production users are owned by your user service.
if (config.NODE_ENV !== 'production') {
  userRouter.post(
    '/',
    wrap(async (req, res) => {
      const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
      res.status(201).json(await chats.createUser(name));
    }),
  );
}

// 6. List user chats (keyset pagination + last-message preview)
userRouter.get(
  '/:userId/chats',
  authenticate,
  wrap(async (req, res) => {
    const { userId } = z.object({ userId: z.coerce.number().int().positive() }).parse(req.params);
    if (userId !== actorOf(req)) throw forbidden('You can only list your own chats');
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    res.json(await chats.listUserChats(userId, q.limit, q.before));
  }),
);
