/**
 * New mail for a signed-in account that is not the one on screen.
 *
 * The multi-account WebSocket manager delivers every signed-in account's
 * events. Mail for an account the user is not looking at used to be dropped
 * at the router, so on a phone with two accounts the second account's mail
 * produced no in-app notice at all, and nothing to tap that would switch to
 * it. It now gets a notice that names the account and opens the message in
 * it, while leaving the active account's badge, list and API session alone.
 *
 * Also covered: on iOS the server sends new mail as an APNs alert that iOS
 * draws in the background, so a backgrounded WebSocket copy must not draw a
 * second one for an account registered for that push. An account whose
 * registration failed or is waiting to be redone still gets the local alert.
 */

const state = vi.hoisted(() => ({
  active: 'alice@example.com',
  accounts: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
  providers: {},
}));

const { messagesStore, selectedFolderStore } = vi.hoisted(() => {
  function miniWritable(initial) {
    let value = initial;
    const subs = new Set();
    return {
      subscribe(fn) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(next) {
        value = next;
        for (const fn of subs) fn(value);
      },
      get value() {
        return value;
      },
    };
  }
  return { messagesStore: miniWritable([]), selectedFolderStore: miniWritable('INBOX') };
});

// The iOS app: a phone, so "in the app" means the page is visible.
vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: true,
  isTauriMacOS: false,
}));
vi.mock('../../src/utils/notification-bridge.js', () => ({
  getPermissionState: vi.fn(() => Promise.resolve('granted')),
  notify: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));
vi.mock('../../src/utils/tauri-bridge.js', () => ({ setBadgeCount: vi.fn() }));
vi.mock('../../src/utils/favicon-badge.js', () => ({ updateFaviconBadge: vi.fn() }));
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/demo-mode.js', () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: vi.fn((key) => (key === 'email' ? state.active : null)),
    set: vi.fn((key, value) => {
      if (key === 'email') state.active = value;
    }),
    remove: vi.fn(),
  },
  Accounts: { getAll: () => state.accounts },
}));
vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      folders: { subscribe: (fn) => (fn([]), () => {}) },
      selectedFolder: selectedFolderStore,
      messages: messagesStore,
    },
    actions: { getSentFolderPath: () => 'Sent', getDraftsFolderPath: () => 'Drafts' },
  },
}));
// Each account's own push registration, as push-notifications reports it.
vi.mock('../../src/utils/push-notifications.js', () => ({
  getPushProviderForAccount: (account) => state.providers[account] ?? null,
  canReceiveWebPush: async () => false,
}));

import { notify } from '../../src/utils/notification-bridge.js';
import { Remote } from '../../src/utils/remote.js';
import {
  connectNotifications,
  getBadgeCount,
  requestNotificationPermission,
  setBadgeCount,
  setNotificationToasts,
} from '../../src/utils/notification-manager.js';
import {
  __resetNotificationOpenForTests,
  configureNotificationOpen,
} from '../../src/utils/notification-open.ts';

function createWsClient() {
  const listeners = {};
  return {
    on(event, handler) {
      (listeners[event] ||= []).push(handler);
      return () => {
        listeners[event] = listeners[event].filter((candidate) => candidate !== handler);
      };
    },
    emit(event, data) {
      for (const handler of listeners[event] || []) handler(data);
    },
  };
}

// The shape helpers/imap/on-append.js broadcasts, tagged with `_account` by
// the multi-account WebSocket manager.
let seq = 0;
function delivery(account, { from, subject = 'Quarterly numbers' } = {}) {
  seq += 1;
  const id = `665f1c2e8a1b2c3d4e5f${String(6000 + seq)}`;
  return {
    _account: account,
    mailbox: 'INBOX',
    message: {
      id,
      folder_id: '665f1c2e8a1b2c3d4e5f0001',
      folder_path: 'INBOX',
      uid: 40 + seq,
      flags: [],
      ...(from === null
        ? {}
        : {
            from: from || {
              value: [{ address: 'carol@sender.test', name: 'Carol Chen' }],
              text: 'Carol Chen <carol@sender.test>',
            },
          }),
      subject,
      object: 'message',
    },
  };
}

function setVisible(visible) {
  Object.defineProperty(document, 'visibilityState', {
    value: visible ? 'visible' : 'hidden',
    configurable: true,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('new mail for another signed-in account', () => {
  let ws;
  let cleanup;
  let toasts;
  let switched;
  let navigated;

  beforeEach(async () => {
    vi.clearAllMocks();
    state.active = 'alice@example.com';
    state.accounts = [{ email: 'alice@example.com' }, { email: 'bob@example.com' }];
    state.providers = {};
    messagesStore.set([]);
    selectedFolderStore.set('INBOX');
    await setBadgeCount(0);
    await requestNotificationPermission();

    switched = [];
    navigated = [];
    __resetNotificationOpenForTests();
    configureNotificationOpen({
      isReady: () => true,
      switchAccount: async (email) => {
        switched.push(email);
        state.active = email;
      },
      navigate: (path) => navigated.push(path),
    });

    toasts = { show: vi.fn() };
    setNotificationToasts(toasts);
    ws = createWsClient();
    cleanup = connectNotifications(ws);
  });

  afterEach(() => {
    cleanup?.();
    setVisible(true);
  });

  it('shows a toast naming the account, and View switches to it and opens the message', async () => {
    setVisible(true);
    const event = delivery('bob@example.com');

    ws.emit('newMessage', event);

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    const [text, , , action] = toasts.show.mock.calls[0];
    expect(text).toContain('bob@example.com');
    expect(text).toContain('Carol Chen');
    expect(text).toContain('Quarterly numbers');
    expect(action.label).toBe('View');

    action.callback();

    await vi.waitFor(() => expect(navigated).toEqual([`/mailbox#INBOX/${event.message.id}`]));
    expect(switched).toEqual(['bob@example.com']);
  });

  it("leaves the active account's badge, list and API session alone", async () => {
    setVisible(true);
    // No sender in the payload: for the active account this triggers a
    // MessageList lookup under the active session, which would search
    // alice's mailbox for bob's message.
    ws.emit('newMessage', delivery('bob@example.com', { from: null }));

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    await settle();
    expect(getBadgeCount()).toBe(0);
    expect(messagesStore.value).toEqual([]);
    expect(Remote.request).not.toHaveBeenCalled();
  });

  it('ignores mail for an account that is not signed in on this device', async () => {
    setVisible(true);
    ws.emit('newMessage', delivery('mallory@example.com'));
    await settle();

    expect(toasts.show).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(getBadgeCount()).toBe(0);
  });

  it('still counts, lists and toasts mail for the active account without naming it', async () => {
    setVisible(true);
    const event = delivery('alice@example.com');
    ws.emit('newMessage', event);

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    expect(toasts.show.mock.calls[0][0]).toBe('New email from Carol Chen: Quarterly numbers');
    await vi.waitFor(() => expect(messagesStore.value).toHaveLength(1));
    expect(getBadgeCount()).toBe(1);

    toasts.show.mock.calls[0][3].callback();
    await vi.waitFor(() => expect(navigated).toEqual([`/mailbox#INBOX/${event.message.id}`]));
    expect(switched).toEqual([]);
  });

  it('draws a background alert for the other account that opens it when tapped', async () => {
    setVisible(false);
    const event = delivery('bob@example.com');
    ws.emit('newMessage', event);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].data).toEqual({
      account: 'bob@example.com',
      folder: 'INBOX',
      messageId: event.message.id,
    });
    expect(getBadgeCount()).toBe(0);
  });

  it('shows the notice when a tapped push for the other account could not be matched', async () => {
    window.dispatchEvent(new CustomEvent('fe:notification-unmatched'));
    expect(toasts.show).toHaveBeenCalledTimes(1);
    expect(toasts.show.mock.calls[0][0]).toMatch(/could not match this email to an account/i);
  });
});

describe('background WebSocket mail on iOS when APNs draws the alert', () => {
  let ws;
  let cleanup;

  beforeEach(async () => {
    vi.clearAllMocks();
    state.active = 'alice@example.com';
    state.accounts = [{ email: 'alice@example.com' }, { email: 'bob@example.com' }];
    state.providers = {};
    await setBadgeCount(0);
    await requestNotificationPermission();
    setNotificationToasts({ show: vi.fn() });
    ws = createWsClient();
    cleanup = connectNotifications(ws);
    setVisible(false);
  });

  afterEach(() => {
    cleanup?.();
    setVisible(true);
  });

  it('does not draw a second alert for an account registered for APNs', async () => {
    state.providers = { 'alice@example.com': 'apns', 'bob@example.com': 'apns' };
    ws.emit('newMessage', delivery('alice@example.com'));
    ws.emit('newMessage', delivery('bob@example.com'));

    // The badge still moves for the active account: only the visual is skipped.
    await vi.waitFor(() => expect(getBadgeCount()).toBe(1));
    await settle();
    expect(notify).not.toHaveBeenCalled();
  });

  it('draws the alert for an account whose push registration failed', async () => {
    // Alice is registered; bob's registration failed, so APNs never alerts
    // for him and this connection is the only way he hears about new mail.
    state.providers = { 'alice@example.com': 'apns' };
    const event = delivery('bob@example.com');
    ws.emit('newMessage', event);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].data.account).toBe('bob@example.com');
  });
});
