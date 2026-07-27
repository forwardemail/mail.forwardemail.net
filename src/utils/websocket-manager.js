/**
 * Forward Email – Multi-Account WebSocket Manager
 *
 * Maintains one WebSocket connection per signed-in account so that real-time
 * events (new messages, flag changes, calendar/contact updates) arrive for
 * ALL accounts regardless of which one is active in the UI.
 *
 * Design principles:
 *   - Dummy-proof: connections are reconciled automatically on boot, resume,
 *     account add, and account remove. No user action required.
 *   - Each connection authenticates with its own alias credentials.
 *   - Events are tagged with the originating account email before dispatch.
 *   - A unified event bus lets downstream code (notifications, UI refresh)
 *     subscribe once and receive events from every account.
 *   - Account switch does NOT tear down connections — all stay alive.
 *   - Sign-out removes only that account's connection.
 *
 * Usage:
 *   import { getWebSocketManager } from './websocket-manager.js';
 *   const mgr = getWebSocketManager();
 *   mgr.reconcile();  // Ensure all accounts are connected
 *   mgr.on('newMessage', (payload) => { ... });
 *   mgr.removeAccount('alice@example.com');  // On sign-out
 *   mgr.destroy();  // Full teardown
 */

import { createWebSocketClient } from './websocket-client.js';
import { Accounts, Local } from './storage';

// ── Singleton ─────────────────────────────────────────────────────────────
let _instance = null;

/**
 * Get or create the singleton WebSocket manager.
 * @returns {WebSocketManager}
 */
export function getWebSocketManager() {
  if (!_instance) {
    _instance = createWebSocketManager();
  }
  return _instance;
}

/**
 * Destroy the singleton (for testing or full app teardown).
 */
export function destroyWebSocketManager() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

// ── Manager Factory ───────────────────────────────────────────────────────

/**
 * @typedef {Object} WebSocketManager
 * @property {() => void} reconcile - Sync connections with current account list
 * @property {(email: string) => void} removeAccount - Disconnect one account
 * @property {(event: string, handler: Function) => Function} on - Subscribe to events
 * @property {(event: string, handler: Function) => void} off - Unsubscribe
 * @property {() => void} destroy - Tear down all connections
 * @property {() => Map<string, object>} getClients - Get all active clients (for testing)
 * @property {(email: string) => object|null} getClient - Get a specific account's client
 */

/**
 * Create a multi-account WebSocket manager.
 * @returns {WebSocketManager}
 */
function createWebSocketManager() {
  /** @type {Map<string, ReturnType<typeof createWebSocketClient>>} */
  const clients = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  let destroyed = false;

  /**
   * Dispatch an event to all registered listeners, tagged with the account.
   */
  function dispatch(eventName, account, payload) {
    const data = { ...payload, _account: account };

    // Event-specific listeners
    const handlers = listeners.get(eventName);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn(data);
        } catch (err) {
          console.error(`[ws-manager] Listener error for ${eventName}:`, err);
        }
      }
    }

    // Wildcard listeners
    const wildcards = listeners.get('*');
    if (wildcards) {
      for (const fn of wildcards) {
        try {
          fn(eventName, data);
        } catch (err) {
          console.error('[ws-manager] Wildcard listener error:', err);
        }
      }
    }
  }

  /**
   * Extract email and password from aliasAuth string ("email:password").
   * The password may contain colons.
   */
  function parseAliasAuth(aliasAuth) {
    if (!aliasAuth || typeof aliasAuth !== 'string') return null;
    const colonIdx = aliasAuth.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      email: aliasAuth.slice(0, colonIdx),
      password: aliasAuth.slice(colonIdx + 1),
    };
  }

  /**
   * Create and connect a WebSocket client for a specific account.
   */
  function connectAccount(email, password) {
    if (destroyed || clients.has(email)) return;

    const client = createWebSocketClient({ email, password });

    // Subscribe to ALL events via wildcard and tag with account
    client.on('*', (eventName, payload) => {
      // Skip internal protocol events (prefixed with _)
      if (typeof eventName === 'string' && eventName.startsWith('_')) return;
      dispatch(eventName, email, payload || {});
    });

    // Also forward internal events for debugging/status
    client.on('_authenticated', () => {
      dispatch('_authenticated', email, {});
    });
    client.on('_disconnected', (data) => {
      dispatch('_disconnected', email, data || {});
    });
    client.on('_authFailed', (data) => {
      dispatch('_authFailed', email, data || {});
    });
    client.on('_maxReconnectsReached', (data) => {
      dispatch('_maxReconnectsReached', email, data || {});
    });

    client.connect();
    clients.set(email, client);
    console.info(`[ws-manager] Connected account: ${email}`);
  }

  /**
   * Disconnect and remove a specific account's WebSocket client.
   */
  function disconnectAccount(email) {
    const client = clients.get(email);
    if (client) {
      client.destroy();
      clients.delete(email);
      console.info(`[ws-manager] Disconnected account: ${email}`);
    }
  }

  return {
    /**
     * Reconcile WebSocket connections with the current list of signed-in
     * accounts. Creates connections for new accounts, removes connections
     * for accounts that are no longer signed in.
     *
     * This is the core "dummy-proof" method — call it on boot, resume,
     * account add, or whenever the account list may have changed.
     */
    reconcile() {
      if (destroyed) return;

      const accounts = Accounts.getAll() || [];
      const activeEmail = Local.get('email');
      const activeAliasAuth = Local.get('alias_auth');

      // Build the set of accounts that should have connections
      const desiredAccounts = new Map();

      // Add all accounts from the Accounts list
      for (const account of accounts) {
        if (account.email && account.aliasAuth) {
          const parsed = parseAliasAuth(account.aliasAuth);
          if (parsed) {
            desiredAccounts.set(account.email, parsed.password);
          }
        }
      }

      // Ensure the active account is included (may not be in Accounts list
      // during initial sign-in before Accounts.add is called)
      if (activeEmail && activeAliasAuth) {
        const parsed = parseAliasAuth(activeAliasAuth);
        if (parsed && !desiredAccounts.has(activeEmail)) {
          desiredAccounts.set(activeEmail, parsed.password);
        }
      }

      // Connect accounts that don't have a client yet
      for (const [email, password] of desiredAccounts) {
        if (!clients.has(email)) {
          connectAccount(email, password);
        }
      }

      // Disconnect accounts that are no longer signed in
      for (const email of clients.keys()) {
        if (!desiredAccounts.has(email)) {
          disconnectAccount(email);
        }
      }
    },

    /**
     * Remove a specific account's connection (e.g. on sign-out).
     * @param {string} email
     */
    removeAccount(email) {
      disconnectAccount(email);
    },

    /**
     * Force reconnect all clients (e.g. after network recovery).
     */
    reconnectAll() {
      if (destroyed) return;
      for (const client of clients.values()) {
        if (!client.connected) {
          client.reconnect();
        }
      }
    },

    /**
     * Register an event listener for events from ANY account.
     * The payload will include `_account` field with the originating email.
     *
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
     * Permanently destroy all connections and clear state.
     */
    destroy() {
      destroyed = true;
      for (const email of [...clients.keys()]) {
        disconnectAccount(email);
      }
      listeners.clear();
    },

    /**
     * Get all active clients (for testing/debugging).
     * @returns {Map<string, object>}
     */
    getClients() {
      return new Map(clients);
    },

    /**
     * Get a specific account's client.
     * @param {string} email
     * @returns {object|null}
     */
    getClient(email) {
      return clients.get(email) || null;
    },

    /**
     * Whether any client is currently connected.
     */
    get anyConnected() {
      for (const client of clients.values()) {
        if (client.connected) return true;
      }
      return false;
    },

    /**
     * Number of active connections.
     */
    get connectionCount() {
      return clients.size;
    },
  };
}
