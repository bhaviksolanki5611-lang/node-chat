import { Router } from 'express';
import { z } from 'zod';
import { forbidden } from '../errors';
import { authenticate } from '../middleware/auth';
import { sendLimiter } from '../middleware/rateLimit';
import * as chats from '../services/chatService';
import * as messages from '../services/messageService';
import { actorOf, assertSameUser, wrap } from '../utils/http';

const id = z.coerce.number().int().positive();
const messageId = z.string().min(1).max(128);
const text = z.string().trim().min(1).max(4000);
// Client-generated id => safe retries (becomes the Firestore document id)
const clientMessageId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const chatRouter = Router();
chatRouter.use(authenticate);

// 1. Create or get chat (caller must be one of the two users)
chatRouter.post(
  '/create',
  wrap(async (req, res) => {
    const actor = actorOf(req);
    const { userAId, userBId } = z.object({ userAId: id, userBId: id }).parse(req.body);
    if (actor !== userAId && actor !== userBId) throw forbidden('You can only create chats you are part of');
    res.json({ chatId: await chats.getOrCreateDirectChat(userAId, userBId) });
  }),
);

// Group chats
chatRouter.post(
  '/group',
  wrap(async (req, res) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(100), memberIds: z.array(id).min(1).max(255) })
      .parse(req.body);
    res.status(201).json({ chatId: await chats.createGroup(actorOf(req), body.name, body.memberIds) });
  }),
);

chatRouter.post(
  '/:chatId/members',
  wrap(async (req, res) => {
    const { chatId } = z.object({ chatId: id }).parse(req.params);
    const { userIds } = z.object({ userIds: z.array(id).min(1).max(100) }).parse(req.body);
    res.json({ chatId, memberIds: await chats.addMembers(chatId, actorOf(req), userIds) });
  }),
);

chatRouter.delete(
  '/:chatId/members/:userId',
  wrap(async (req, res) => {
    const p = z.object({ chatId: id, userId: id }).parse(req.params);
    await chats.removeMember(p.chatId, actorOf(req), p.userId);
    res.status(204).end();
  }),
);

// 2. Send message
chatRouter.post(
  '/:chatId/message/send',
  sendLimiter,
  wrap(async (req, res) => {
    const actor = actorOf(req);
    const { chatId } = z.object({ chatId: id }).parse(req.params);
    const body = z.object({ senderId: id.optional(), text, clientMessageId: clientMessageId.optional() }).parse(req.body);
    assertSameUser(actor, body.senderId);
    res.status(201).json(await messages.sendMessage(chatId, actor, body.text, body.clientMessageId));
  }),
);

// 3. Get messages
chatRouter.get(
  '/:chatId/messages',
  wrap(async (req, res) => {
    const { chatId } = z.object({ chatId: id }).parse(req.params);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: messageId.optional() })
      .parse(req.query);
    res.json(await messages.getMessages(chatId, actorOf(req), q.limit, q.before));
  }),
);

// 4. Mark message read
chatRouter.post(
  '/:chatId/message/:messageId/read',
  wrap(async (req, res) => {
    const actor = actorOf(req);
    const p = z.object({ chatId: id, messageId }).parse(req.params);
    const body = z.object({ userId: id.optional() }).parse(req.body ?? {});
    assertSameUser(actor, body.userId);
    res.json(await messages.markRead(p.chatId, p.messageId, actor));
  }),
);

// 5. Update last seen message
chatRouter.post(
  '/:chatId/lastseen',
  wrap(async (req, res) => {
    const actor = actorOf(req);
    const { chatId } = z.object({ chatId: id }).parse(req.params);
    const body = z.object({ userId: id.optional(), messageId }).parse(req.body);
    assertSameUser(actor, body.userId);
    res.json(await messages.updateLastSeen(chatId, actor, body.messageId));
  }),
);

// Edit / delete
chatRouter.patch(
  '/:chatId/message/:messageId',
  wrap(async (req, res) => {
    const actor = actorOf(req);
    const p = z.object({ chatId: id, messageId }).parse(req.params);
    const body = z.object({ userId: id.optional(), text }).parse(req.body);
    assertSameUser(actor, body.userId);
    res.json(await messages.editMessage(p.chatId, p.messageId, actor, body.text));
  }),
);

chatRouter.delete(
  '/:chatId/message/:messageId',
  wrap(async (req, res) => {
    const actor = actorOf(req);
    const p = z.object({ chatId: id, messageId }).parse(req.params);
    const body = z.object({ userId: id.optional() }).parse(req.body ?? {});
    assertSameUser(actor, body.userId);
    res.json(await messages.deleteMessage(p.chatId, p.messageId, actor));
  }),
);
