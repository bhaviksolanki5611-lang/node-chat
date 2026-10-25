# Chat Backend

Chat API built with Node.js, TypeScript (strict), MySQL and Firebase Firestore.

Users, chats and chat members are in MySQL. Messages, read receipts and last seen
are in Firestore.

## Setup

You need Node 20+, a MySQL database and a Firebase project (or the Firestore emulator).

```bash
npm install
cp .env.example .env     # fill in your values
npm run migrate          # creates the tables
npm run dev
```

There is also a docker-compose file that starts MySQL, Redis, the Firestore
emulator and the API together:

```bash
docker compose up --build
```

Run `npm test` for the tests and `npm run typecheck` for the type check.

## How it is organised

```
src/
  routes/       express routes (validation with zod)
  services/     business logic (chatService, messageService)
  middleware/   auth, rate limit, error handler
  db.ts         mysql pool
  firebase.ts   firestore setup and document paths
  cache.ts      small cache (redis if configured, memory otherwise)
migrations/     sql files, run in order by src/migrate.ts
tests/          api tests
firestore.rules security rules for client side listeners
```

Firestore structure:

```
chats/{chatId}                                   members, last message preview
chats/{chatId}/messages/{messageId}              senderId, text, createdAt, editedAt, deleted
chats/{chatId}/messages/{messageId}/readReceipts/{userId}
chats/{chatId}/members/{userId}                  last seen message
```

## Some decisions

- A direct chat has a `direct_key` like `3_7` (smaller id first) with a unique index.
  So calling create twice, even at the same time, gives the same chat.
- Message time is the Firestore server timestamp, so ordering does not depend on
  the client's clock.
- Every write checks that the user is a member of the chat. Member lists are cached
  for 5 minutes and the cache is cleared when members change.
- The user id comes from the JWT. If `senderId` or `userId` is also sent in the body,
  it has to match the token, otherwise the request gets a 403.
- Marking a message as read twice keeps the first read time. Last seen only moves
  forward, an older message id is ignored.
- Delete is a soft delete so receipts and last seen still point to a valid message.
- `clientMessageId` is optional on send. If the client retries with the same id it
  gets the same message back instead of a duplicate.

## API

All routes need `Authorization: Bearer <token>` except the health checks.

| Method | Path | Body / query |
|---|---|---|
| POST | `/chat/create` | `userAId`, `userBId` returns `chatId` |
| POST | `/chat/:chatId/message/send` | `text`, optional `clientMessageId` |
| GET | `/chat/:chatId/messages` | `limit` (default 50), `before` (message id) |
| POST | `/chat/:chatId/message/:messageId/read` | |
| POST | `/chat/:chatId/lastseen` | `messageId` |
| GET | `/user/:userId/chats` | `limit`, `before` (chat id) |
| PATCH | `/chat/:chatId/message/:messageId` | `text` |
| DELETE | `/chat/:chatId/message/:messageId` | |
| POST | `/chat/group` | `name`, `memberIds` |
| POST | `/chat/:chatId/members` | `userIds` (admin only) |
| DELETE | `/chat/:chatId/members/:userId` | admin removes others, anyone can leave |
| POST | `/auth/firebase-token` | token for Firestore listeners |
| GET | `/health/live`, `/health/ready` | |

Messages come back oldest to newest. If there are more, `nextBefore` is the id to
pass as `before` for the next page.

For local testing, when `NODE_ENV` is not `production`, you can use
`POST /user` (create a user) and `POST /auth/dev-token` (get a token for a user id).
Both are disabled in production.

## Example

```bash
curl -X POST localhost:3000/user -H 'content-type: application/json' -d '{"name":"Alice"}'
curl -X POST localhost:3000/user -H 'content-type: application/json' -d '{"name":"Bob"}'

TOKEN=$(curl -s -X POST localhost:3000/auth/dev-token \
  -H 'content-type: application/json' -d '{"userId":1}' | jq -r .token)

curl -X POST localhost:3000/chat/create -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"userAId":1,"userBId":2}'

curl -X POST localhost:3000/chat/1/message/send -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"text":"hello"}'

curl localhost:3000/chat/1/messages -H "authorization: Bearer $TOKEN"
```

## Config

See `.env.example`. The important ones:

- `JWT_SECRET` (at least 32 characters)
- `MYSQL_*` for the database
- `REDIS_URL`, needed if you run more than one instance (shared cache and rate limits)
- `GOOGLE_APPLICATION_CREDENTIALS`, or `FIRESTORE_EMULATOR_HOST` for local work

## Known limitations

- Auth is a simple HS256 JWT. In a real deployment `verifyAccessToken` in
  `src/middleware/auth.ts` should check tokens from the actual identity provider.
- After a MySQL change to members, the member list is copied to Firestore. If that
  copy fails it is only logged, there is no retry job yet.
- Every message updates the chat document (last message preview), so one very busy
  chat can hit the Firestore limit of about 1 write per second per document.
- The chat list is ordered by chat id, not by last activity.
- Read receipts are one document per reader per message, which is expensive for
  very large groups.
