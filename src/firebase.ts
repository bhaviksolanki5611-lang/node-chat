import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore, CollectionReference, DocumentReference } from 'firebase-admin/firestore';
import { config } from './config';

if (getApps().length === 0) {
  // With FIRESTORE_EMULATOR_HOST set no real credentials are needed.
  initializeApp(
    process.env['FIRESTORE_EMULATOR_HOST']
      ? { projectId: config.FIREBASE_PROJECT_ID ?? 'demo-chat' }
      : { credential: applicationDefault(), projectId: config.FIREBASE_PROJECT_ID },
  );
}

export const firestore: Firestore = getFirestore();
firestore.settings({ ignoreUndefinedProperties: true });

/*
 * Firestore layout
 *   chats/{chatId}                                   { type, name, memberIds[], lastMessage{...}, lastMessageAt }
 *   chats/{chatId}/messages/{messageId}              { senderId, text, createdAt, editedAt, deleted }
 *   chats/{chatId}/messages/{id}/readReceipts/{uid}  { userId, readAt }
 *   chats/{chatId}/members/{uid}                     { lastSeenMessageId, lastSeenMessageCreatedAt }
 */
export const chatDoc = (chatId: number): DocumentReference => firestore.collection('chats').doc(String(chatId));
export const messagesCol = (chatId: number): CollectionReference => chatDoc(chatId).collection('messages');
export const messageDoc = (chatId: number, messageId: string): DocumentReference =>
  messagesCol(chatId).doc(messageId);
export const receiptDoc = (chatId: number, messageId: string, userId: number): DocumentReference =>
  messageDoc(chatId, messageId).collection('readReceipts').doc(String(userId));
export const memberStateDoc = (chatId: number, userId: number): DocumentReference =>
  chatDoc(chatId).collection('members').doc(String(userId));
