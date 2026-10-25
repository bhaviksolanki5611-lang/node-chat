import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Infrastructure is mocked: these tests cover the HTTP contract (auth, validation, authorization).
vi.mock('../src/db', () => ({ pool: { query: vi.fn().mockResolvedValue([[{}]]) } }));
vi.mock('../src/redis', () => ({ redis: null }));
vi.mock('../src/firebase', () => ({}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ createCustomToken: vi.fn() }) }));
vi.mock('../src/services/chatService', () => ({
  getOrCreateDirectChat: vi.fn().mockResolvedValue(42),
  listUserChats: vi.fn().mockResolvedValue({ chats: [], nextBefore: null }),
  createGroup: vi.fn().mockResolvedValue(7),
  assertUsersExist: vi.fn(),
}));
vi.mock('../src/services/messageService', () => ({
  sendMessage: vi.fn().mockResolvedValue({ id: 'm1', text: 'hi' }),
}));

import { app } from '../src/app';
import * as messageService from '../src/services/messageService';

const tokenFor = (userId: number): string =>
  jwt.sign({}, 'test-secret-test-secret-test-secret-123', {
    algorithm: 'HS256',
    issuer: 'chat-backend',
    subject: String(userId),
    expiresIn: '5m',
  });
const auth = (userId: number): [string, string] => ['Authorization', `Bearer ${tokenFor(userId)}`];

beforeEach(() => vi.clearAllMocks());

describe('health', () => {
  it('liveness is public', async () => {
    await request(app).get('/health/live').expect(200);
  });
  it('readiness checks dependencies', async () => {
    await request(app).get('/health/ready').expect(200);
  });
});

describe('authentication', () => {
  it('rejects requests without a token', async () => {
    await request(app).post('/chat/create').send({ userAId: 1, userBId: 2 }).expect(401);
  });
  it('rejects a token signed with the wrong secret', async () => {
    const bad = jwt.sign({}, 'x'.repeat(40), { subject: '1', issuer: 'chat-backend' });
    await request(app).post('/chat/create').set('Authorization', `Bearer ${bad}`).send({}).expect(401);
  });
});

describe('POST /chat/create', () => {
  it('returns the chat id for a participant', async () => {
    const res = await request(app).post('/chat/create').set(...auth(1)).send({ userAId: 1, userBId: 2 }).expect(200);
    expect(res.body).toEqual({ chatId: 42 });
  });
  it('forbids creating a chat between two other users', async () => {
    await request(app).post('/chat/create').set(...auth(3)).send({ userAId: 1, userBId: 2 }).expect(403);
  });
  it('validates input', async () => {
    const res = await request(app).post('/chat/create').set(...auth(1)).send({ userAId: 'abc' }).expect(400);
    expect(res.body.error).toBe('Validation failed');
  });
});

describe('POST /chat/:chatId/message/send', () => {
  it('uses the authenticated user as sender', async () => {
    await request(app).post('/chat/1/message/send').set(...auth(5)).send({ text: 'hi' }).expect(201);
    expect(messageService.sendMessage).toHaveBeenCalledWith(1, 5, 'hi', undefined);
  });
  it('blocks sender spoofing', async () => {
    await request(app).post('/chat/1/message/send').set(...auth(5)).send({ senderId: 9, text: 'hi' }).expect(403);
    expect(messageService.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects empty text', async () => {
    await request(app).post('/chat/1/message/send').set(...auth(5)).send({ text: '   ' }).expect(400);
  });
  it('rejects malformed JSON', async () => {
    await request(app)
      .post('/chat/1/message/send')
      .set(...auth(5))
      .set('Content-Type', 'application/json')
      .send('{bad')
      .expect(400);
  });
});

describe('GET /user/:userId/chats', () => {
  it("forbids listing someone else's chats", async () => {
    await request(app).get('/user/2/chats').set(...auth(1)).expect(403);
  });
  it('lists own chats', async () => {
    const res = await request(app).get('/user/1/chats?limit=10').set(...auth(1)).expect(200);
    expect(res.body).toEqual({ chats: [], nextBefore: null });
  });
});
