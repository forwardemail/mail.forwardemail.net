# WebSocket Real-Time Events

This document describes the real-time WebSocket integration used by the Forward Email desktop and mobile applications.

## Architecture Overview

```
┌──────────────────┐     wss://api.forwardemail.net/v1/ws     ┌──────────────────┐
│  WebSocket Client│ ◄──────────────────────────────────────── │  Forward Email   │
│  (browser)       │         msgpackr / JSON frames            │  API Server      │
└──────┬───────────┘                                           └──────────────────┘
       │
       ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ WebSocket Updater│────►│  Svelte Stores   │────►│  UI Components   │
│ (event router)   │     │  (reactive)      │     │  (auto-refresh)  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
       │
       ▼
┌──────────────────┐
│ Notification Mgr │
│ (cross-platform) │
└──────────────────┘
```

## Connection

The WebSocket client (`src/utils/websocket-client.js`) connects to:

```
wss://api.forwardemail.net/v1/ws
```

Append `?msgpackr=true` for binary framing.

**Authentication** is the first message. Browsers cannot set headers on a WebSocket handshake, and the server rejects credentials in the URL (`?username=`, `?password=`, `?token=`) with `400` because URLs are logged. The client connects with `?auth=message` and sends the alias credentials as its first message (a JSON text frame, within 5 seconds):

```
wss://api.forwardemail.net/v1/ws?auth=message
→ {"event":"auth","username":"you@example.com","password":"…"}
← {"event":"connected","aliasId":"…"}
```

The server sends nothing before it accepts the credentials. It closes the connection with `4400` (malformed message), `4401` (wrong credentials) or `4403` (the account may not connect), which stop reconnecting; any other close (`1013` try again later, `4408` no message in time, `4429` too many connections or failed attempts) is retried with backoff. When the alias password or API token changes, the server closes open connections with `4001`; the client reconnects, and stops with `4401` if the stored password is no longer valid.

Unauthenticated connections receive only broadcast events (`newRelease`).

## Message Format

All server messages are flat JSON objects with an `event` field:

```json
{
  "event": "newMessage",
  "timestamp": 1700000000000,
  "mailbox": "INBOX",
  "message": { "uid": 42 }
}
```

There is no `data` or `payload` wrapper. The client destructures `{ event, timestamp, ...payload }` and dispatches `payload` to registered listeners.

## Protocol Events

| Event  | Direction       | Description                                            |
| ------ | --------------- | ------------------------------------------------------ |
| `auth` | Server → Client | `{ event: 'auth', status: 'ok' }` on success           |
| `ping` | Server → Client | Sent every 30 seconds                                  |
| `pong` | Client → Server | Must respond `{ event: 'pong' }` to each server `ping` |

If the client does not respond with `pong`, the server will close the connection. The client also sets a 45-second timeout — if no `ping` is received within that window, the client closes and reconnects.

## IMAP Events (8)

| Event              | Key Payload Fields                                                   |
| ------------------ | -------------------------------------------------------------------- |
| `newMessage`       | `mailbox`, `message` (includes `from`, `subject`, metadata flags)    |
| `messagesMoved`    | `sourceMailbox`, `destinationMailbox`, `sourceUid`, `destinationUid` |
| `messagesCopied`   | `sourceMailbox`, `destinationMailbox`, `sourceUid`, `destinationUid` |
| `flagsUpdated`     | `mailbox`, `action`, `flags`, `uid`                                  |
| `messagesExpunged` | `mailbox`, `uids`                                                    |
| `mailboxCreated`   | `path`, `mailbox`                                                    |
| `mailboxDeleted`   | `path`, `mailbox`                                                    |
| `mailboxRenamed`   | `oldPath`, `newPath`, `mailbox`                                      |

## CalDAV Events (6)

| Event                  | Key Payload Fields                  |
| ---------------------- | ----------------------------------- |
| `calendarCreated`      | `calendarId`, `calendar`            |
| `calendarUpdated`      | `calendarId`, `calendar`, `changes` |
| `calendarDeleted`      | `calendarId`                        |
| `calendarEventCreated` | `calendarId`, `eventId`, `event`    |
| `calendarEventUpdated` | `calendarId`, `eventId`, `changes`  |
| `calendarEventDeleted` | `calendarId`, `eventId`             |

## CardDAV Events (6)

| Event                | Key Payload Fields                      |
| -------------------- | --------------------------------------- |
| `addressBookCreated` | `addressBookId`, `addressBook`          |
| `addressBookUpdated` | `addressBookId`, `changes`              |
| `addressBookDeleted` | `addressBookId`                         |
| `contactCreated`     | `addressBookId`, `contactId`, `card`    |
| `contactUpdated`     | `addressBookId`, `contactId`, `changes` |
| `contactDeleted`     | `addressBookId`, `contactId`            |

## App Events (1)

| Event        | Key Payload Fields                                   |
| ------------ | ---------------------------------------------------- |
| `newRelease` | `release` (with `tagName`, `name`, `body`, `assets`) |

## msgpackr Binary Encoding

When the `?msgpackr=true` query parameter is set, the server sends binary-encoded messages using [msgpackr](https://github.com/kriszyp/msgpackr). The client lazily loads the `msgpackr/unpack` browser bundle and falls back to JSON parsing if the library is unavailable. Pong responses are sent in the same encoding as the connection.

## Event Routing

The **WebSocket Updater** (`src/utils/websocket-updater.js`) bridges WebSocket events to Svelte stores:

- `newMessage` / `messagesMoved` / `flagsUpdated` → Refresh mailbox message list
- `mailboxCreated` / `mailboxDeleted` / `mailboxRenamed` → Refresh folder sidebar
- `calendarEvent*` → Sync calendar data
- `contact*` / `addressBook*` → Sync contacts
- `newRelease` → Trigger auto-update check via `updater-bridge.js`

## Notification Integration

The **Notification Manager** (`src/utils/notification-manager.js`) dispatches platform-appropriate notifications:

- **Web**: `Notification` API with `navigator.setAppBadge()`
- **Tauri Desktop**: `@tauri-apps/plugin-notification`
- **Tauri Mobile**: `@tauri-apps/plugin-notification` (APNs/FCM via native bridge)

## Rate Limiting

Inbound messages are rate-limited to 200 messages per minute. Excess messages are silently dropped and a warning is logged.

## Reconnection

- **Backoff**: Exponential with jitter (1s initial, 60s max)
- **Hard cap**: 50 attempts before giving up (dispatches `_maxReconnectsReached`)
- **No reconnect** on close codes `1000` (normal), `4400` (malformed first message), `4401` (wrong credentials), or `4403` (not allowed)
- **Reset** of the backoff and attempt counter once the server sends `connected`
- **Credential change**: Closes and reconnects automatically

## Usage

```javascript
import { createWebSocketClient, WS_EVENTS } from '../utils/websocket-client.js';

const ws = createWebSocketClient({
  email: 'user@domain.com',
  password: 'alias-password',
});

// Listen for specific events
ws.on(WS_EVENTS.NEW_MESSAGE, (data) => {
  console.log('New message in', data.mailbox);
});

// Listen for all events (wildcard receives eventName as first arg)
ws.on('*', (eventName, data) => {
  console.log(`Event: ${eventName}`, data);
});

// Auth confirmation
ws.on('_authenticated', () => {
  console.log('WebSocket authenticated');
});

ws.connect();

// Later: clean shutdown
ws.destroy();
```

## Error Codes

| Close Code | Meaning                 |
| ---------- | ----------------------- |
| `1000`     | Normal closure          |
| `4000`     | Client ping timeout     |
| `1013`     | Try again later         |
| `4001`     | Credentials changed     |
| `4400`     | Malformed first message |
| `4401`     | Wrong credentials       |
| `4403`     | Not allowed             |
| `4408`     | No first message        |
| `4429`     | Too many connections    |

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Full architecture document
- [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md) — Push notification architecture (complements WebSocket for background delivery)
- [SECURITY.md](./SECURITY.md) — WebSocket security hardening details
