import { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { pool } from '../db';
import { firestore, chatDoc } from '../firebase';
import { cacheDel, cacheGet, cacheSet } from '../cache';
import { badRequest, forbidden, notFound } from '../errors';
import { logger } from '../logger';

const MAX_GROUP_MEMBERS = 256;
const MEMBERS_TTL_SECONDS = 300;
const membersKey = (chatId: number): string => `chat:${chatId}:members`;

export type ChatType = 'direct' | 'group';

export interface LastMessage {
  messageId: string;
  senderId: number;
  text: string | null;
  createdAt: string | null;
}

export interface ChatSummary {
  chatId: number;
  type: ChatType;
  name: string | null;
  memberIds: number[];
  createdAt: string;
  lastMessage: LastMessage | null;
}

interface IdRow extends RowDataPacket {
  id: number;
}
interface ChatRow extends RowDataPacket {
  id: number;
  type: ChatType;
  name: string | null;
  created_at: Date;
}
interface MemberRow extends RowDataPacket {
  chat_id: number;
  user_id: number;
  role: 'admin' | 'member';
}

const isDuplicateKey = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'ER_DUP_ENTRY';

// ---------- users (dev helper) ----------

export async function createUser(name: string): Promise<{ id: number; name: string }> {
  const [res] = await pool.execute<ResultSetHeader>('INSERT INTO users (name) VALUES (?)', [name]);
  return { id: res.insertId, name };
}

export async function assertUsersExist(userIds: number[]): Promise<void> {
  const unique = [...new Set(userIds)];
  const [rows] = await pool.query<IdRow[]>('SELECT id FROM users WHERE id IN (?)', [unique]);
  if (rows.length !== unique.length) throw notFound('One or more users do not exist');
}

// ---------- membership ----------

async function loadMemberIds(chatId: number): Promise<number[]> {
  const [rows] = await pool.execute<MemberRow[]>('SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId]);
  return rows.map((r) => Number(r.user_id));
}

/** Hot path: every message write calls this. Redis/memory cached; invalidated on membership change. */
export async function getMemberIds(chatId: number): Promise<number[]> {
  const cached = await cacheGet(membersKey(chatId));
  if (cached) {
    try {
      const parsed: unknown = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      /* fall through to DB */
    }
  }
  const ids = await loadMemberIds(chatId);
  if (ids.length === 0) throw notFound(`Chat ${chatId} not found`);
  await cacheSet(membersKey(chatId), JSON.stringify(ids), MEMBERS_TTL_SECONDS);
  return ids;
}

export async function assertMember(chatId: number, userId: number): Promise<void> {
  const ids = await getMemberIds(chatId);
  if (!ids.includes(userId)) throw forbidden(`Not a member of chat ${chatId}`);
}

async function getChatInfo(chatId: number): Promise<ChatRow> {
  const [rows] = await pool.execute<ChatRow[]>('SELECT id, type, name, created_at FROM chats WHERE id = ?', [chatId]);
  const row = rows[0];
  if (!row) throw notFound(`Chat ${chatId} not found`);
  return row;
}

async function assertAdmin(chatId: number, userId: number): Promise<void> {
  const [rows] = await pool.execute<MemberRow[]>(
    'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?',
    [chatId, userId],
  );
  if (rows[0]?.role !== 'admin') throw forbidden('Group admin permission required');
}

/**
 * Mirror membership to Firestore so security rules can authorize real-time listeners.
 * MySQL stays the source of truth; a failure here is logged (and fixed by the next
 * membership change or a reconcile job) instead of failing a committed request.
 */
async function syncChatDoc(chatId: number, type: ChatType, name: string | null, memberIds: number[]): Promise<void> {
  try {
    await chatDoc(chatId).set(
      { type, name, memberIds, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } catch (err) {
    logger.error({ err, chatId }, 'failed to sync chat doc to Firestore');
  }
}

// ---------- direct chats ----------

/** Idempotent and race-free: same pair => same chat, even under concurrent calls. */
export async function getOrCreateDirectChat(userAId: number, userBId: number): Promise<number> {
  if (userAId === userBId) throw badRequest('userAId and userBId must be different');
  await assertUsersExist([userAId, userBId]);

  const directKey = `${Math.min(userAId, userBId)}_${Math.max(userAId, userBId)}`;
  const find = async (): Promise<number | undefined> => {
    const [r] = await pool.execute<IdRow[]>('SELECT id FROM chats WHERE direct_key = ?', [directKey]);
    return r[0]?.id;
  };

  let chatId = await find();
  if (chatId === undefined) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.execute<ResultSetHeader>(
        "INSERT INTO chats (type, direct_key, created_by) VALUES ('direct', ?, ?)",
        [directKey, userAId],
      );
      await conn.query('INSERT INTO chat_members (chat_id, user_id) VALUES ?', [
        [
          [res.insertId, userAId],
          [res.insertId, userBId],
        ],
      ]);
      await conn.commit();
      chatId = res.insertId;
    } catch (err) {
      await conn.rollback();
      if (!isDuplicateKey(err)) throw err;
      chatId = await find(); // lost the race: use the winner's chat
      if (chatId === undefined) throw err;
    } finally {
      conn.release();
    }
  }

  await syncChatDoc(chatId, 'direct', null, [userAId, userBId]);
  return chatId;
}

// ---------- group chats ----------

export async function createGroup(creatorId: number, name: string, memberIds: number[]): Promise<number> {
  const all = [...new Set([creatorId, ...memberIds])];
  if (all.length < 2) throw badRequest('A group needs at least 2 members');
  if (all.length > MAX_GROUP_MEMBERS) throw badRequest(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
  await assertUsersExist(all);

  const conn = await pool.getConnection();
  let chatId: number;
  try {
    await conn.beginTransaction();
    const [res] = await conn.execute<ResultSetHeader>(
      "INSERT INTO chats (type, name, created_by) VALUES ('group', ?, ?)",
      [name, creatorId],
    );
    chatId = res.insertId;
    await conn.query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ?', [
      all.map((u) => [chatId, u, u === creatorId ? 'admin' : 'member']),
    ]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await syncChatDoc(chatId, 'group', name, all);
  return chatId;
}

export async function addMembers(chatId: number, actorId: number, userIds: number[]): Promise<number[]> {
  const info = await getChatInfo(chatId);
  if (info.type !== 'group') throw badRequest('Members can only be added to group chats');
  await assertAdmin(chatId, actorId);
  await assertUsersExist(userIds);

  const current = await loadMemberIds(chatId);
  const merged = new Set([...current, ...userIds]);
  if (merged.size > MAX_GROUP_MEMBERS) throw badRequest(`A group can have at most ${MAX_GROUP_MEMBERS} members`);

  await pool.query('INSERT IGNORE INTO chat_members (chat_id, user_id) VALUES ?', [
    [...new Set(userIds)].map((u) => [chatId, u]),
  ]);
  await cacheDel(membersKey(chatId));

  const ids = [...merged];
  await syncChatDoc(chatId, 'group', info.name, ids);
  return ids;
}

/** Admins can remove anyone; anyone can leave. Last admin leaving promotes the longest-standing member. */
export async function removeMember(chatId: number, actorId: number, targetId: number): Promise<void> {
  const info = await getChatInfo(chatId);
  if (info.type !== 'group') throw badRequest('Members can only be removed from group chats');
  if (actorId !== targetId) await assertAdmin(chatId, actorId);

  const conn = await pool.getConnection();
  let remainingIds: number[] = [];
  try {
    await conn.beginTransaction();
    const [del] = await conn.execute<ResultSetHeader>(
      'DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, targetId],
    );
    if (del.affectedRows === 0) throw notFound('User is not a member of this chat');

    const [remaining] = await conn.execute<MemberRow[]>(
      'SELECT user_id, role FROM chat_members WHERE chat_id = ? ORDER BY joined_at, user_id',
      [chatId],
    );
    remainingIds = remaining.map((r) => Number(r.user_id));
    const first = remaining[0];
    if (!first) {
      await conn.execute('DELETE FROM chats WHERE id = ?', [chatId]);
    } else if (!remaining.some((r) => r.role === 'admin')) {
      await conn.execute("UPDATE chat_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?", [
        chatId,
        first.user_id,
      ]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await cacheDel(membersKey(chatId));
  if (remainingIds.length === 0) {
    firestore.recursiveDelete(chatDoc(chatId)).catch((err: unknown) => {
      logger.error({ err, chatId }, 'failed to delete Firestore data for empty chat');
    });
  } else {
    await syncChatDoc(chatId, 'group', info.name, remainingIds);
  }
}

// ---------- listing ----------

/**
 * Keyset-paginated (newest chat id first). Members come from MySQL in one batched query;
 * last-message previews come from Firestore in one batched getAll — no N+1.
 */
export async function listUserChats(
  userId: number,
  limit: number,
  before?: number,
): Promise<{ chats: ChatSummary[]; nextBefore: number | null }> {
  const [chatRows] = await pool.query<ChatRow[]>(
    `SELECT c.id, c.type, c.name, c.created_at
       FROM chat_members m
       JOIN chats c ON c.id = m.chat_id
      WHERE m.user_id = ? ${before !== undefined ? 'AND m.chat_id < ?' : ''}
      ORDER BY m.chat_id DESC
      LIMIT ?`,
    before !== undefined ? [userId, before, limit] : [userId, limit],
  );
  if (chatRows.length === 0) return { chats: [], nextBefore: null };

  const chatIds = chatRows.map((c) => c.id);
  const [memberRows] = await pool.query<MemberRow[]>(
    'SELECT chat_id, user_id FROM chat_members WHERE chat_id IN (?)',
    [chatIds],
  );
  const membersByChat = new Map<number, number[]>();
  for (const m of memberRows) {
    const list = membersByChat.get(m.chat_id) ?? [];
    list.push(Number(m.user_id));
    membersByChat.set(m.chat_id, list);
  }

  const lastByChat = new Map<number, LastMessage>();
  try {
    const snaps = await firestore.getAll(...chatIds.map((id) => chatDoc(id)));
    snaps.forEach((snap, i) => {
      const lm = snap.get('lastMessage') as
        | { messageId: string; senderId: number; text: string | null; createdAt?: Timestamp }
        | undefined;
      const id = chatIds[i];
      if (lm && id !== undefined) {
        lastByChat.set(id, {
          messageId: lm.messageId,
          senderId: lm.senderId,
          text: lm.text ?? null,
          createdAt: lm.createdAt ? lm.createdAt.toDate().toISOString() : null,
        });
      }
    });
  } catch (err) {
    // Previews are non-critical: degrade gracefully if Firestore is slow/unavailable.
    logger.warn({ err }, 'could not load last-message previews');
  }

  const chats = chatRows.map<ChatSummary>((c) => ({
    chatId: c.id,
    type: c.type,
    name: c.name,
    memberIds: (membersByChat.get(c.id) ?? []).sort((a, b) => a - b),
    createdAt: c.created_at.toISOString(),
    lastMessage: lastByChat.get(c.id) ?? null,
  }));
  const last = chatRows[chatRows.length - 1];
  return { chats, nextBefore: chatRows.length === limit && last ? last.id : null };
}
