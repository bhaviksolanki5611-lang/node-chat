import { FieldPath, FieldValue, Timestamp, DocumentSnapshot, Query } from 'firebase-admin/firestore';
import { firestore, chatDoc, messagesCol, messageDoc, receiptDoc, memberStateDoc } from '../firebase';
import { assertMember } from './chatService';
import { badRequest, conflict, forbidden, notFound } from '../errors';

export interface Message {
  id: string;
  chatId: number;
  senderId: number;
  text: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

const PREVIEW_LEN = 100;
const preview = (t: string): string => (t.length > PREVIEW_LEN ? `${t.slice(0, PREVIEW_LEN - 1)}…` : t);
const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : null);
const isAlreadyExists = (err: unknown): boolean => (err as { code?: number } | null)?.code === 6;

function toMessage(chatId: number, snap: DocumentSnapshot): Message {
  const d = snap.data();
  if (!d) throw notFound('Message not found');
  const deleted = d['deleted'] === true;
  return {
    id: snap.id,
    chatId,
    senderId: d['senderId'] as number,
    text: deleted ? null : (d['text'] as string),
    createdAt: iso(d['createdAt']) ?? new Date(0).toISOString(),
    editedAt: iso(d['editedAt']),
    deleted,
  };
}

async function loadMessage(chatId: number, messageId: string): Promise<DocumentSnapshot> {
  const snap = await messageDoc(chatId, messageId).get();
  if (!snap.exists) throw notFound(`Message ${messageId} not found in chat ${chatId}`);
  return snap;
}

/**
 * Atomically writes the message and the chat's lastMessage preview (powers the chat list
 * without per-chat queries). `clientMessageId` makes retries idempotent.
 */
export async function sendMessage(
  chatId: number,
  senderId: number,
  text: string,
  clientMessageId?: string,
): Promise<Message> {
  await assertMember(chatId, senderId);

  const ref = clientMessageId ? messagesCol(chatId).doc(clientMessageId) : messagesCol(chatId).doc();
  const batch = firestore.batch();
  batch.create(ref, {
    senderId,
    text,
    createdAt: FieldValue.serverTimestamp(), // server clock => consistent ordering across clients
    editedAt: null,
    deleted: false,
  });
  batch.set(
    chatDoc(chatId),
    {
      lastMessage: {
        messageId: ref.id,
        senderId,
        text: preview(text),
        createdAt: FieldValue.serverTimestamp(),
      },
      lastMessageAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  try {
    await batch.commit();
  } catch (err) {
    if (isAlreadyExists(err)) {
      const existing = await ref.get();
      if (existing.get('senderId') === senderId) return toMessage(chatId, existing); // idempotent retry
      throw conflict('clientMessageId is already in use');
    }
    throw err;
  }
  return toMessage(chatId, await ref.get());
}

export async function getMessages(
  chatId: number,
  userId: number,
  limit: number,
  beforeMessageId?: string,
): Promise<{ messages: Message[]; nextBefore: string | null }> {
  await assertMember(chatId, userId);

  // Newest `limit` via a descending scan, returned oldest -> newest. documentId() is the tiebreaker.
  let q: Query = messagesCol(chatId).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
  if (beforeMessageId) q = q.startAfter(await loadMessage(chatId, beforeMessageId));

  const snap = await q.limit(limit).get();
  const messages = snap.docs.map((d) => toMessage(chatId, d)).reverse();
  return { messages, nextBefore: snap.size === limit ? (messages[0]?.id ?? null) : null };
}

/** Idempotent: the first read time wins. */
export async function markRead(
  chatId: number,
  messageId: string,
  userId: number,
): Promise<{ messageId: string; userId: number; alreadyRead: boolean }> {
  await assertMember(chatId, userId);
  const msg = toMessage(chatId, await loadMessage(chatId, messageId));
  if (msg.senderId === userId) throw badRequest('Cannot mark your own message as read');

  try {
    await receiptDoc(chatId, messageId, userId).create({ userId, readAt: FieldValue.serverTimestamp() });
    return { messageId, userId, alreadyRead: false };
  } catch (err) {
    if (isAlreadyExists(err)) return { messageId, userId, alreadyRead: true };
    throw err;
  }
}

/** Monotonic: moving to an older message is a no-op. */
export async function updateLastSeen(
  chatId: number,
  userId: number,
  messageId: string,
): Promise<{ lastSeenMessageId: string; advanced: boolean }> {
  await assertMember(chatId, userId);
  const msgRef = messageDoc(chatId, messageId);
  const stateRef = memberStateDoc(chatId, userId);

  return firestore.runTransaction(async (tx) => {
    const [msgSnap, stateSnap] = await Promise.all([tx.get(msgRef), tx.get(stateRef)]);
    if (!msgSnap.exists) throw notFound(`Message ${messageId} not found in chat ${chatId}`);

    const newTs = msgSnap.get('createdAt') as Timestamp;
    const curTs = stateSnap.get('lastSeenMessageCreatedAt') as Timestamp | undefined;
    const curId = stateSnap.get('lastSeenMessageId') as string | undefined;
    if (curTs && curId && curTs.valueOf() >= newTs.valueOf()) {
      return { lastSeenMessageId: curId, advanced: false };
    }
    tx.set(
      stateRef,
      {
        userId,
        lastSeenMessageId: messageId,
        lastSeenMessageCreatedAt: newTs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { lastSeenMessageId: messageId, advanced: true };
  });
}

export async function editMessage(
  chatId: number,
  messageId: string,
  userId: number,
  text: string,
): Promise<Message> {
  await assertMember(chatId, userId);
  const ref = messageDoc(chatId, messageId);
  const chatRef = chatDoc(chatId);

  await firestore.runTransaction(async (tx) => {
    const [snap, chatSnap] = await Promise.all([tx.get(ref), tx.get(chatRef)]);
    if (!snap.exists) throw notFound(`Message ${messageId} not found in chat ${chatId}`);
    if (snap.get('senderId') !== userId) throw forbidden('Only the sender can edit a message');
    if (snap.get('deleted') === true) throw badRequest('Cannot edit a deleted message');

    tx.update(ref, { text, editedAt: FieldValue.serverTimestamp() });
    if (chatSnap.get('lastMessage.messageId') === messageId) {
      tx.update(chatRef, { 'lastMessage.text': preview(text) }); // keep chat-list preview consistent
    }
  });
  return toMessage(chatId, await ref.get());
}

/** Soft delete keeps ordering, receipts and last-seen pointers valid. */
export async function deleteMessage(chatId: number, messageId: string, userId: number): Promise<Message> {
  await assertMember(chatId, userId);
  const ref = messageDoc(chatId, messageId);
  const chatRef = chatDoc(chatId);

  await firestore.runTransaction(async (tx) => {
    const [snap, chatSnap] = await Promise.all([tx.get(ref), tx.get(chatRef)]);
    if (!snap.exists) throw notFound(`Message ${messageId} not found in chat ${chatId}`);
    if (snap.get('senderId') !== userId) throw forbidden('Only the sender can delete a message');

    tx.update(ref, { deleted: true, text: FieldValue.delete(), deletedAt: FieldValue.serverTimestamp() });
    if (chatSnap.get('lastMessage.messageId') === messageId) {
      tx.update(chatRef, { 'lastMessage.text': null });
    }
  });
  return toMessage(chatId, await ref.get());
}
