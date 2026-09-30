/**
 * Forward Email – WebSocket Client
 *
 * Connects to wss://api.forwardemail.net/v1/ws with:
 *   - The alias credentials in the first message (?auth=message)
 *   - Optional msgpackr binary framing (?msgpackr=true)
 *   - Exponential backoff reconnection with jitter
 *   - Server-initiated ping/pong keep-alive (responds to server pings)
 *   - All 20 server events dispatched to registered listeners
 *
 * Protocol (per api-websocket-handler.js):
 *   - Server sends flat JSON/msgpackr objects: { event, timestamp, ...fields }
 *   - Server sends { event: 'connected', aliasId } on successful auth
 *   - Server sends { event: 'connected', broadcastOnly: true } for unauth
 *   - Server sends { event: 'ping' } every 30s; client responds { event: 'pong' }
 *   - Client messages (except pong) are silently ignored by the server
 *
 * Authentication:
 *   Browsers cannot set headers on a WebSocket handshake, and the server
 *   rejects credentials in the URL (?username=, ?password=, ?token=) because
 *   URLs are logged.  The client connects with ?auth=message and sends
 *   { event: 'auth', username, password } as its first message; the server
 *   sends nothing until it answers with { event: 'connected', aliasId }, or
 *   closes the connection (4400 malformed, 4401 wrong credentials, 4403 not
 *   allowed: not retried; anything else: retried with backoff).
 *
 * Hardening:
 *   - Enforces wss:// only (never ws://).
 *   - Credentials only travel in the first message, never in a URL.
 *   - Reconnection has a hard cap on total attempts to prevent infinite loops.
 *   - Inbound messages are validated: type-checked, size-limited.
 *   - Rate limiting on inbound messages to prevent flood attacks.
 *   - Listener errors are caught and isolated.
 */

import { config } from '../config';

// ── msgpackr (browser bundle) ──────────────────────────────────────────────
let unpack = null;
let pack = null;
let msgpackrAvailable = false;
let _initPromise = null;

/**
 * Lazily load the msgpackr browser bundle.
 * Falls back to JSON if msgpackr is unavailable.
 * Uses a Promise singleton to prevent concurrent initialization races.
 */
async function initMsgpackr() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const { Unpackr } = await import('msgpackr/unpack');
      const unpackr = new Unpackr({ mapsAsObjects: true, int64AsNumber: true });
      // Use Uint8Array instead of Buffer for browser compatibility
      unpack = (buffer) => unpackr.unpack(new Uint8Array(buffer));
      // For sending pong responses in msgpackr format
      try {
        const { Packr } = await import('msgpackr');
        const packr = new Packr();
        pack = (obj) => packr.pack(obj);
      } catch {
        // Pack not available — send pong as JSON
        pack = null;
      }
      msgpackrAvailable = true;
    } catch {
      // msgpackr not available — fall back to JSON
      msgpackrAvailable = false;
    }
  })();
  return _initPromise;
}

// ── Event Names ────────────────────────────────────────────────────────────
export const WS_EVENTS = Object.freeze({
  // IMAP (8)
  NEW_MESSAGE: 'newMessage',
  MESSAGES_MOVED: 'messagesMoved',
  MESSAGES_COPIED: 'messagesCopied',
  FLAGS_UPDATED: 'flagsUpdated',
  LABELS_UPDATED: 'labelsUpdated',
  MESSAGES_EXPUNGED: 'messagesExpunged',
  MAILBOX_CREATED: 'mailboxCreated',
  MAILBOX_DELETED: 'mailboxDeleted',
  MAILBOX_RENAMED: 'mailboxRenamed',
  // CalDAV (6)
  CALENDAR_CREATED: 'calendarCreated',
  CALENDAR_UPDATED: 'calendarUpdated',
  CALENDAR_DELETED: 'calendarDeleted',
  CALENDAR_EVENT_CREATED: 'calendarEventCreated',
  CALENDAR_EVENT_UPDATED: 'calendarEventUpdated',
  CALENDAR_EVENT_DELETED: 'calendarEventDeleted',
  // CardDAV (5)
  ADDRESS_BOOK_CREATED: 'addressBookCreated',
  ADDRESS_BOOK_DELETED: 'addressBookDeleted',
  CONTACT_CREATED: 'contactCreated',
  CONTACT_UPDATED: 'contactUpdated',
  CONTACT_DELETED: 'contactDeleted',
  // App (1)
  NEW_RELEASE: 'newRelease',
});

// ── Reconnection Constants ─────────────────────────────────────────────────
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_MAX_MS = 2_000;
const PING_TIMEOUT_MS = 45_000; // Close if no ping received within 45s (server sends every 30s)
const MAX_RECONNECT_ATTEMPTS = 50;
// Close codes after which reconnecting cannot help (malformed first message,
// wrong credentials, not allowed); the credentials must change first
const NO_RETRY_CLOSE_CODES = new Set([4400, 4401, 4403]);

// ── Message Rate Limiting ──────────────────────────────────────────────────
const MAX_MESSAGES_PER_MINUTE = 200;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KB

/**
 * Create a WebSocket client for the Forward Email real-time API.
 *
 * @param {Object} opts
 * @param {string} [opts.email]    - Alias email for Basic Auth
 * @param {string} [opts.password] - Alias password for Basic Auth
 * @param {string} [opts.apiBase]  - Override API base URL
 * @param {boolean} [opts.useMsgpackr=false] - Whether to request msgpackr encoding
 * @returns {Object} Client with connect/destroy/on/off methods
 */
export function createWebSocketClient(opts = {}) {
  const listeners = new Map();
  let socket = null;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer = null;
  let pingTimeoutTimer = null;
  let destroyed = false;
  let connected = false;
  let authenticated = false;
  let reconnectAttempts = 0;
  // Whether this client instance uses msgpackr (opt-in per instance)
  const wantsMsgpackr = opts.useMsgpackr === true;

  // Rate limiting state
  let messageCount = 0;
  let rateLimitWindowStart = Date.now();

  // Reset reconnect counter when the browser comes back online
  // A handshake is under way
  function isConnecting() {
    return socket?.readyState === 0;
  }

  function handleOnline() {
    if (destroyed) return;
    reconnectAttempts = 0;
    backoff = INITIAL_BACKOFF_MS;
    // If not currently connected, trigger a reconnect immediately
    if (!connected && !reconnectTimer && !isConnecting()) {
      scheduleReconnect();
    }
  }
  window.addEventListener('online', handleOnline);

  /**
   * Build the WebSocket URL (never with credentials; see the 'open' handler).
   */
  function buildURL() {
    const base = opts.apiBase || config.apiBase || 'https://api.forwardemail.net';
    const wsBase = base.replace(/^http/, 'ws');

    // Enforce secure WebSocket (allow localhost for development)
    if (!wsBase.startsWith('wss://') && !wsBase.startsWith('ws://localhost')) {
      console.warn('[ws] Refusing non-secure WebSocket URL');
      return null;
    }

    const url = new URL('/v1/ws', wsBase);
    // Only request msgpackr if the client explicitly opted in AND the library loaded
    if (wantsMsgpackr && msgpackrAvailable) {
      url.searchParams.set('msgpackr', 'true');
    }
    return url.toString();
  }

  // Check inbound message rate limit
  function isRateLimited() {
    const now = Date.now();
    if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
      messageCount = 0;
      rateLimitWindowStart = now;
    }
    messageCount++;
    return messageCount > MAX_MESSAGES_PER_MINUTE;
  }

  // Parse incoming message with size validation
  function parseMessage(data) {
    try {
      // Size check for string messages
      if (typeof data === 'string' && data.length > MAX_MESSAGE_SIZE) {
        console.warn('[ws] Rejected oversized message:', data.length, 'bytes');
        return null;
      }

      // Binary data — use msgpackr if available
      if (wantsMsgpackr && msgpackrAvailable && unpack && data instanceof ArrayBuffer) {
        if (data.byteLength > MAX_MESSAGE_SIZE) {
          console.warn('[ws] Rejected oversized binary message:', data.byteLength, 'bytes');
          return null;
        }
        return unpack(data);
      }

      // String data — parse as JSON
      if (typeof data === 'string') {
        return JSON.parse(data);
      }

      // Blob -> ArrayBuffer -> unpack or JSON
      if (data instanceof Blob) {
        if (data.size > MAX_MESSAGE_SIZE) {
          console.warn('[ws] Rejected oversized blob message:', data.size, 'bytes');
          return null;
        }
        return data
          .arrayBuffer()
          .then((buf) => {
            if (wantsMsgpackr && msgpackrAvailable && unpack) return unpack(buf);
            return JSON.parse(new TextDecoder().decode(buf));
          })
          .catch((err) => {
            // The synchronous try/catch below cannot see this async failure.
            console.error('[ws] Failed to parse message:', err);
            return null;
          });
      }

      return JSON.parse(String(data));
    } catch (err) {
      console.error('[ws] Failed to parse message:', err);
      return null;
    }
  }

  // Send a message to the server (JSON or msgpackr)
  function send(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      if (wantsMsgpackr && msgpackrAvailable && pack) {
        socket.send(pack(obj));
      } else {
        socket.send(JSON.stringify(obj));
      }
    } catch {
      // ignore send errors
    }
  }

  // Dispatch event to listeners (with error isolation)
  function dispatch(eventName, payload) {
    const handlers = listeners.get(eventName);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[ws] Listener error for ${eventName}:`, err);
        }
      }
    }
    // Also dispatch to wildcard listeners
    const wildcards = listeners.get('*');
    if (wildcards) {
      for (const fn of wildcards) {
        try {
          fn(eventName, payload);
        } catch (err) {
          console.error('[ws] Wildcard listener error:', err);
        }
      }
    }
  }

  // Reset the ping timeout — server sends { event: 'ping' } every 30s.
  // If we don't receive one within 45s, assume the connection is dead.
  function resetPingTimeout() {
    clearPingTimeout();
    pingTimeoutTimer = setTimeout(() => {
      console.warn('[ws] No ping received from server, closing connection');
      if (socket) {
        socket.close(4000, 'Ping timeout');
      }
    }, PING_TIMEOUT_MS);
  }

  function clearPingTimeout() {
    if (pingTimeoutTimer) {
      clearTimeout(pingTimeoutTimer);
      pingTimeoutTimer = null;
    }
  }

  // Schedule reconnection with exponential backoff + jitter
  function scheduleReconnect() {
    if (destroyed) return;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[ws] Max reconnect attempts reached, giving up');
      dispatch('_maxReconnectsReached', { attempts: reconnectAttempts });
      return;
    }

    reconnectAttempts++;
    const jitter = Math.random() * JITTER_MAX_MS;
    const delay = Math.min(backoff + jitter, MAX_BACKOFF_MS);
    console.info(
      `[ws] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
    );
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      connect();
    }, delay);
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // Connect
  async function connect() {
    if (destroyed) return;
    cancelReconnect();

    // Ensure msgpackr is initialized (once) if the client wants it
    if (wantsMsgpackr) {
      await initMsgpackr();
    }

    const url = buildURL();
    if (!url) {
      console.error('[ws] Invalid WebSocket URL');
      return;
    }

    console.info('[ws] Connecting...');

    // Browsers cannot set an Authorization header on a WebSocket handshake,
    // and the server rejects credentials in the URL (they end up in logs), so
    // the credentials are sent as the first message instead (see 'open').
    const withCredentials = Boolean(opts.email && opts.password);
    let connectURL = url;
    if (withCredentials) {
      const u = new URL(url);
      u.searchParams.set('auth', 'message');
      connectURL = u.toString();
    }

    let ws;
    try {
      ws = new WebSocket(connectURL);
      if (wantsMsgpackr && msgpackrAvailable) {
        ws.binaryType = 'arraybuffer';
      }
    } catch (err) {
      console.error('[ws] Connection error:', err);
      scheduleReconnect();
      return;
    }

    // A replaced socket (reconnect, credential change) can still fire close
    // or error afterwards; only the current socket may change state.
    const previous = socket;
    socket = ws;
    connected = false;
    authenticated = false;
    clearPingTimeout();
    if (previous && previous.readyState < 2) {
      try {
        previous.close(1000, 'Replaced');
      } catch {
        // ignore
      }
    }

    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      console.info('[ws] Connected');
      if (withCredentials) {
        // Always a JSON text frame (the server accepts nothing else here),
        // whatever encoding the events use.
        try {
          ws.send(
            JSON.stringify({
              event: 'auth',
              username: opts.email,
              password: opts.password,
            }),
          );
        } catch (err) {
          console.warn('[ws] Could not send credentials:', err?.message || err);
        }
      }
      connected = true;
      authenticated = false;
      // (the reconnect counter and backoff reset once the server accepts the
      // connection, see 'connected': a server that keeps closing it right
      // away must not be retried without backoff)
      messageCount = 0;
      rateLimitWindowStart = Date.now();
      // Don't start ping timeout here — wait for auth response or first ping.
      // The server sends pings after authentication, not immediately on open.
      dispatch('_connected', {});
    });

    ws.addEventListener('message', async (event) => {
      if (socket !== ws) return;
      // Rate limit check
      if (isRateLimited()) {
        return;
      }

      const parsed = await parseMessage(event.data);
      // replaced while a Blob was being read
      if (socket !== ws || !parsed) return;

      // Server sends flat objects: { event, timestamp, ...fields }
      const eventName = parsed.event || parsed.type;

      // Validate event name is a non-empty string
      if (typeof eventName !== 'string' || !eventName) return;

      // Handle protocol-level events before dispatching to listeners
      switch (eventName) {
        case 'ping':
          // Respond to server ping with pong
          send({ event: 'pong' });
          resetPingTimeout();
          return;

        case 'auth':
          // Legacy auth event — server confirms authentication status
          if (parsed.status === 'ok') {
            authenticated = true;
            console.info('[ws] Authenticated');
            resetPingTimeout();
            dispatch('_authenticated', {});
          } else {
            authenticated = false;
            console.warn('[ws] Auth failed:', parsed.message || 'unknown error');
            dispatch('_authFailed', { message: parsed.message });
          }
          return;

        case 'connected':
          reconnectAttempts = 0;
          backoff = INITIAL_BACKOFF_MS;
          // Server sends { event: 'connected', aliasId } on successful auth,
          // or { event: 'connected', broadcastOnly: true } for unauthenticated.
          if (parsed.aliasId && !parsed.broadcastOnly) {
            authenticated = true;
            console.info('[ws] Authenticated (aliasId:', parsed.aliasId, ')');
            resetPingTimeout();
            dispatch('_authenticated', { aliasId: parsed.aliasId });
          } else {
            console.info('[ws] Connected in broadcast-only mode');
            dispatch('_broadcastOnly', {});
          }
          return;

        default:
          break;
      }

      // Destructure: remove protocol fields, keep domain data
      // eslint-disable-next-line no-unused-vars
      const { event: _e, type: _t, timestamp: _ts, ...payload } = parsed;

      // Dispatch to registered listeners
      dispatch(eventName, payload);
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      console.info(`[ws] Closed: code=${event.code}`);
      connected = false;
      authenticated = false;
      clearPingTimeout();
      dispatch('_disconnected', { code: event.code, reason: event.reason });

      // Don't reconnect on normal closure or auth failure
      if (event.code === 1000) return;
      // 4001: the server closed it because the credentials changed; the
      // reconnect below authenticates again, which closes with 4401 (and
      // stops) if the stored password is no longer valid
      if (NO_RETRY_CLOSE_CODES.has(event.code)) {
        console.warn('[ws] Authentication failed, not reconnecting');
        dispatch('_authFailed', { code: event.code });
        return;
      }

      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      // The browser Error event carries no useful detail (it's opaque for
      // security reasons).  Log connection context instead so developers
      // can correlate failures with network/auth state.
      // Guard against socket being null (race with destroy/close)
      const state = socket?.readyState ?? 3; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      const stateLabel = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state] || state;
      console.warn(
        `[ws] Connection error (readyState=${stateLabel}, attempt=${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
      );
      dispatch('_error', { readyState: state });
    });
  }

  // Public API
  return {
    /**
     * Start the WebSocket connection.
     */
    connect,

    /**
     * Permanently close the connection and stop reconnecting.
     */
    destroy() {
      destroyed = true;
      cancelReconnect();
      clearPingTimeout();
      window.removeEventListener('online', handleOnline);
      if (socket) {
        socket.close(1000, 'Client destroyed');
        socket = null;
      }
      listeners.clear();
      connected = false;
      authenticated = false;
      reconnectAttempts = 0;
    },

    /**
     * Register an event listener.
     * @param {string} event - Event name (from WS_EVENTS) or '*' for all
     * @param {Function} handler
     * @returns {Function} Unsubscribe function
     */
    on(event, handler) {
      if (typeof event !== 'string' || typeof handler !== 'function') {
        return () => {};
      }
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },

    /**
     * Remove an event listener.
     */
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },

    /**
     * Update credentials and reconnect.
     */
    updateCredentials(email, password) {
      if (typeof email !== 'string' || typeof password !== 'string') return;
      opts.email = email;
      opts.password = password;
      reconnectAttempts = 0;
      backoff = INITIAL_BACKOFF_MS;
      if (destroyed) return;
      // connect() replaces (and closes) the current socket; a normal close
      // does not trigger the reconnect path by itself.
      connect();
    },

    /**
     * Reset the reconnection counter (e.g. after user action).
     */
    resetReconnectCounter() {
      reconnectAttempts = 0;
      backoff = INITIAL_BACKOFF_MS;
    },

    /**
     * Reconnect if currently disconnected. Resets the reconnect counter
     * first so a previously exhausted budget doesn't block recovery.
     * Safe to call when already connected (no-op).
     */
    reconnect() {
      if (destroyed || connected || isConnecting()) return;
      reconnectAttempts = 0;
      backoff = INITIAL_BACKOFF_MS;
      connect();
    },

    /** Whether the socket is currently connected. */
    get connected() {
      return connected;
    },

    /** Whether the server has confirmed authentication. */
    get authenticated() {
      return authenticated;
    },
  };
}

/**
 * Create a lightweight WebSocket client for newRelease events only.
 * Does NOT require authentication.
 */
export function createReleaseWatcher(opts = {}) {
  return createWebSocketClient({
    ...opts,
    email: undefined,
    password: undefined,
  });
}
