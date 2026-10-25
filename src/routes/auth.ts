import { Router } from 'express';
import { z } from 'zod';
import { getAuth } from 'firebase-admin/auth';
import '../firebase'; // ensures the Admin app is initialised
import { config } from '../config';
import { authenticate, signAccessToken } from '../middleware/auth';
import { assertUsersExist } from '../services/chatService';
import { actorOf, wrap } from '../utils/http';

export const authRouter = Router();

// Dev/test only. In production tokens come from your identity provider.
if (config.NODE_ENV !== 'production') {
  authRouter.post(
    '/dev-token',
    wrap(async (req, res) => {
      const { userId } = z.object({ userId: z.coerce.number().int().positive() }).parse(req.body);
      await assertUsersExist([userId]);
      res.json({ token: signAccessToken(userId) });
    }),
  );
}

// Mints a Firebase custom token so the client can open real-time Firestore listeners,
// authorized by firestore.rules (membership mirrored from MySQL).
authRouter.post(
  '/firebase-token',
  authenticate,
  wrap(async (req, res) => {
    res.json({ token: await getAuth().createCustomToken(String(actorOf(req))) });
  }),
);
