/**
 * Unit tests for the multi-account WebSocket manager.
 *
 * Verifies:
 *   - reconcile() creates connections for all signed-in accounts
 *   - reconcile() removes connections for signed-out accounts
 *   - Events from any account are dispatched with _account tag
 *   - removeAccount() disconnects only that account
 *   - destroy() tears down everything
 *   - on/off subscription management
 *   - reconnectAll() reconnects disconnected clients
 *   - anyConnected and connectionCount getters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockClients = new Map();

function createMockClient(email) {
  const eventHandlers = new Map();
  const client = {
    email,
    connected: true,
    connect: vi.fn(),
    reconnect: vi.fn(),
    destroy: vi.fn(() => {
      client.connected = false;
    }),
    on: vi.fn((event, handler) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      eventHandlers.get(event).add(handler);
      return () => eventHandlers.get(event)?.delete(handler);
    }),
    // Test helper: simulate an event from this client
    _emit(event, payload) {
      const handlers = eventHandlers.get(event) || new Set();
      for (const fn of handlers) fn(event, payload);
      // Also fire wildcard
      const wildcards = eventHandlers.get('*') || new Set();
      for (const fn of wildcards) fn(event, payload);
    },
    // Test helper: fire an internal event
    _emitInternal(event, payload) {
      const handlers = eventHandlers.get(event) || new Set();
      for (const fn of handlers) fn(payload);
    },
  };
  mockClients.set(email, client);
  return client;
}

vi.mock('../../src/utils/websocket-client.js', () => ({
  createWebSocketClient: vi.fn(({ email }) => createMockClient(email)),
}));

vi.mock('../../src/utils/storage', () => ({
  Accounts: {
    getAll: vi.fn(() => []),
  },
  Local: {
    get: vi.fn(() => null),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import {
  getWebSocketManager,
  destroyWebSocketManager,
} from '../../src/utils/websocket-manager.js';
import { Accounts, Local } from '../../src/utils/storage';
import { createWebSocketClient } from '../../src/utils/websocket-client.js';

describe('WebSocket Manager – Multi-Account', () => {
  let mgr;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients.clear();
    destroyWebSocketManager();
  });

  afterEach(() => {
    destroyWebSocketManager();
  });

  describe('reconcile()', () => {
    it('creates connections for all signed-in accounts', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'bob@example.com', aliasAuth: 'bob@example.com:pass2' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      expect(createWebSocketClient).toHaveBeenCalledTimes(2);
      expect(createWebSocketClient).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'pass1',
      });
      expect(createWebSocketClient).toHaveBeenCalledWith({
        email: 'bob@example.com',
        password: 'pass2',
      });
      expect(mgr.connectionCount).toBe(2);
    });

    it('includes the active account even if not in Accounts list', () => {
      Accounts.getAll.mockReturnValue([]);
      Local.get.mockImplementation((key) => {
        if (key === 'email') return 'active@example.com';
        if (key === 'alias_auth') return 'active@example.com:activepass';
        return null;
      });

      mgr = getWebSocketManager();
      mgr.reconcile();

      expect(createWebSocketClient).toHaveBeenCalledWith({
        email: 'active@example.com',
        password: 'activepass',
      });
      expect(mgr.connectionCount).toBe(1);
    });

    it('does not duplicate connections on repeated reconcile', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();
      mgr.reconcile();
      mgr.reconcile();

      expect(createWebSocketClient).toHaveBeenCalledTimes(1);
      expect(mgr.connectionCount).toBe(1);
    });

    it('removes connections for accounts no longer signed in', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'bob@example.com', aliasAuth: 'bob@example.com:pass2' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();
      expect(mgr.connectionCount).toBe(2);

      // Bob signs out
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      mgr.reconcile();

      expect(mgr.connectionCount).toBe(1);
      const bobClient = mockClients.get('bob@example.com');
      expect(bobClient.destroy).toHaveBeenCalled();
    });

    it('adds new accounts on reconcile', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();
      expect(mgr.connectionCount).toBe(1);

      // Charlie signs in
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'charlie@example.com', aliasAuth: 'charlie@example.com:pass3' },
      ]);
      mgr.reconcile();

      expect(mgr.connectionCount).toBe(2);
      expect(createWebSocketClient).toHaveBeenCalledWith({
        email: 'charlie@example.com',
        password: 'pass3',
      });
    });
  });

  describe('Event dispatch with _account tagging', () => {
    it('tags events with the originating account email', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      const handler = vi.fn();
      mgr.on('newMessage', handler);

      // Simulate the wildcard handler being called by the client
      const aliceClient = mockClients.get('alice@example.com');
      // Find the wildcard handler registered on the client
      const wildcardCall = aliceClient.on.mock.calls.find((c) => c[0] === '*');
      expect(wildcardCall).toBeTruthy();
      const wildcardHandler = wildcardCall[1];

      // Simulate an event
      wildcardHandler('newMessage', { mailbox: 'INBOX', uid: 123 });

      expect(handler).toHaveBeenCalledWith({
        mailbox: 'INBOX',
        uid: 123,
        _account: 'alice@example.com',
      });
    });

    it('dispatches events from different accounts to the same listener', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'bob@example.com', aliasAuth: 'bob@example.com:pass2' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      const handler = vi.fn();
      mgr.on('newMessage', handler);

      // Simulate event from Alice
      const aliceWildcard = mockClients.get('alice@example.com').on.mock.calls.find(
        (c) => c[0] === '*',
      )[1];
      aliceWildcard('newMessage', { uid: 1 });

      // Simulate event from Bob
      const bobWildcard = mockClients.get('bob@example.com').on.mock.calls.find(
        (c) => c[0] === '*',
      )[1];
      bobWildcard('newMessage', { uid: 2 });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith({ uid: 1, _account: 'alice@example.com' });
      expect(handler).toHaveBeenCalledWith({ uid: 2, _account: 'bob@example.com' });
    });

    it('does not dispatch internal events (prefixed with _) through wildcard', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      const handler = vi.fn();
      mgr.on('_authenticated', handler);

      // The wildcard handler should skip _-prefixed events
      const aliceWildcard = mockClients.get('alice@example.com').on.mock.calls.find(
        (c) => c[0] === '*',
      )[1];
      aliceWildcard('_authenticated', {});

      // Should NOT be dispatched via wildcard (internal events use dedicated handlers)
      expect(handler).not.toHaveBeenCalled();
    });

    it('dispatches internal events via dedicated handlers', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      const handler = vi.fn();
      mgr.on('_authenticated', handler);

      // Find the dedicated _authenticated handler
      const authCall = mockClients.get('alice@example.com').on.mock.calls.find(
        (c) => c[0] === '_authenticated',
      );
      expect(authCall).toBeTruthy();
      authCall[1](); // Fire it

      expect(handler).toHaveBeenCalledWith({ _account: 'alice@example.com' });
    });
  });

  describe('removeAccount()', () => {
    it('disconnects only the specified account', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'bob@example.com', aliasAuth: 'bob@example.com:pass2' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();
      expect(mgr.connectionCount).toBe(2);

      mgr.removeAccount('bob@example.com');

      expect(mgr.connectionCount).toBe(1);
      expect(mockClients.get('bob@example.com').destroy).toHaveBeenCalled();
      expect(mgr.getClient('alice@example.com')).toBeTruthy();
      expect(mgr.getClient('bob@example.com')).toBeNull();
    });

    it('is a no-op for unknown accounts', () => {
      mgr = getWebSocketManager();
      expect(() => mgr.removeAccount('unknown@example.com')).not.toThrow();
    });
  });

  describe('on/off subscription', () => {
    it('returns an unsubscribe function from on()', () => {
      mgr = getWebSocketManager();
      const handler = vi.fn();
      const unsub = mgr.on('newMessage', handler);

      expect(typeof unsub).toBe('function');
      unsub();

      // After unsubscribe, handler should not be called
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);
      mgr.reconcile();

      const aliceWildcard = mockClients.get('alice@example.com').on.mock.calls.find(
        (c) => c[0] === '*',
      )[1];
      aliceWildcard('newMessage', { uid: 1 });

      expect(handler).not.toHaveBeenCalled();
    });

    it('off() removes a specific handler', () => {
      mgr = getWebSocketManager();
      const handler = vi.fn();
      mgr.on('newMessage', handler);
      mgr.off('newMessage', handler);

      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);
      mgr.reconcile();

      const aliceWildcard = mockClients.get('alice@example.com').on.mock.calls.find(
        (c) => c[0] === '*',
      )[1];
      aliceWildcard('newMessage', { uid: 1 });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('reconnectAll()', () => {
    it('reconnects disconnected clients', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'bob@example.com', aliasAuth: 'bob@example.com:pass2' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      // Simulate Alice disconnecting
      mockClients.get('alice@example.com').connected = false;

      mgr.reconnectAll();

      expect(mockClients.get('alice@example.com').reconnect).toHaveBeenCalled();
      expect(mockClients.get('bob@example.com').reconnect).not.toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('disconnects all clients and clears listeners', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
        { email: 'bob@example.com', aliasAuth: 'bob@example.com:pass2' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      const handler = vi.fn();
      mgr.on('newMessage', handler);

      mgr.destroy();

      expect(mockClients.get('alice@example.com').destroy).toHaveBeenCalled();
      expect(mockClients.get('bob@example.com').destroy).toHaveBeenCalled();
      expect(mgr.connectionCount).toBe(0);
    });

    it('prevents new connections after destroy', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.destroy();
      mgr.reconcile(); // Should be a no-op

      expect(createWebSocketClient).not.toHaveBeenCalled();
      expect(mgr.connectionCount).toBe(0);
    });
  });

  describe('Getters', () => {
    it('anyConnected returns true when at least one client is connected', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      expect(mgr.anyConnected).toBe(true);

      mockClients.get('alice@example.com').connected = false;
      expect(mgr.anyConnected).toBe(false);
    });

    it('getClient returns the client for a specific account', () => {
      Accounts.getAll.mockReturnValue([
        { email: 'alice@example.com', aliasAuth: 'alice@example.com:pass1' },
      ]);
      Local.get.mockReturnValue(null);

      mgr = getWebSocketManager();
      mgr.reconcile();

      const client = mgr.getClient('alice@example.com');
      expect(client).toBeTruthy();
      expect(client.email).toBe('alice@example.com');
      expect(mgr.getClient('unknown@example.com')).toBeNull();
    });
  });

  describe('Singleton behavior', () => {
    it('getWebSocketManager returns the same instance', () => {
      const mgr1 = getWebSocketManager();
      const mgr2 = getWebSocketManager();
      expect(mgr1).toBe(mgr2);
    });

    it('destroyWebSocketManager resets the singleton', () => {
      const mgr1 = getWebSocketManager();
      destroyWebSocketManager();
      const mgr2 = getWebSocketManager();
      expect(mgr1).not.toBe(mgr2);
    });
  });
});
