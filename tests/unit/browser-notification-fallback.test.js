/**
 * Browser notifications when Web Push cannot deliver.
 *
 * A browser that registers for Web Push gets new-mail alerts from its service
 * worker, even with the app closed. When registration fails (the push service
 * is unreachable, as in Brave with Google push messaging off), or the browser
 * has no Push API at all, the open app shows each new message with the
 * Notifications API from its WebSocket events. Permission is only ever asked
 * for from a click.
 *
 * The push, web-push, notification-bridge and notification-manager modules run
 * for real. Notification, PushManager, the service worker registration and
 * fetch are stand-ins with the browser API shapes.
 */
import crypto from 'node:crypto';

const { localStore, accounts } = vi.hoisted(() => ({
  localStore: new Map(),
  accounts: [],
}));

vi.mock('../../src/utils/demo-mode.js', () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn((key) => localStore.get(key)),
    set: vi.fn((key, value) => localStore.set(key, value)),
    remove: vi.fn((key) => localStore.delete(key)),
  },
  Accounts: { getAll: vi.fn(() => accounts) },
}));
vi.mock('../../src/utils/notification-open.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openNotificationTarget: vi.fn() };
});
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/favicon-badge.js', () => ({ updateFaviconBadge: vi.fn() }));
vi.mock('../../src/utils/tauri-bridge.js', () => ({ setBadgeCount: vi.fn() }));
vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      folders: { subscribe: (fn) => (fn([]), () => {}) },
      selectedFolder: { subscribe: (fn) => (fn(''), () => {}) },
      messages: { subscribe: (fn) => (fn([]), () => {}), set: vi.fn() },
    },
    actions: {
      getSentFolderPath: () => 'Sent',
      getDraftsFolderPath: () => 'Drafts',
    },
  },
}));

const EMAIL = 'me@example.com';
const PASSWORD = 'generated-password';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/browser-subscription';

function p256PublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}

/**
 * @param {object} options
 * @param {'default'|'granted'|'denied'} [options.permission]
 * @param {'granted'|'denied'|'default'} [options.answer] what the prompt answers
 * @param {boolean} [options.pushManager] whether window.PushManager exists
 * @param {Error|null} [options.subscribeError] what pushManager.subscribe rejects with
 * @param {boolean|'installing'} [options.serviceWorker] whether a service worker
 *   is registered ('installing': registered, not active yet, as on a first
 *   visit; `activate()` makes it active)
 */
function installBrowser({
  permission = 'granted',
  answer = 'granted',
  pushManager = true,
  subscribeError = null,
  serviceWorker = true,
} = {}) {
  const state = {
    permission,
    prompts: 0,
    subscription: null,
    created: [],
    requests: [],
  };
  const keys = { p256dh: p256PublicKey(), auth: crypto.randomBytes(16).toString('base64url') };

  class FakeNotification {
    static get permission() {
      return state.permission;
    }

    static requestPermission = vi.fn((callback) => {
      state.prompts += 1;
      state.permission = answer;
      callback?.(answer);
      return Promise.resolve(answer);
    });

    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      state.created.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  globalThis.Notification = FakeNotification;
  window.Notification = FakeNotification;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  if (pushManager) window.PushManager = function PushManager() {};
  else delete window.PushManager;

  const installing = serviceWorker === 'installing';
  let activate = () => {};
  const registration = {
    active: installing ? null : { postMessage() {} },
    showNotification: vi.fn(async () => {}),
    pushManager: {
      getSubscription: async () => state.subscription,
      subscribe: async (options) => {
        if (subscribeError) throw subscribeError;
        state.subscription = {
          endpoint: ENDPOINT,
          options,
          toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys }),
          unsubscribe: async () => {
            state.subscription = null;
            return true;
          },
        };
        return state.subscription;
      },
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: installing
      ? {
          // (no controller and no active worker yet; `ready` settles once
          // the worker is active)
          controller: null,
          ready: new Promise((resolve) => {
            activate = () => {
              registration.active = { postMessage() {} };
              resolve(registration);
            };
          }),
          getRegistration: async () => registration,
          addEventListener() {},
        }
      : serviceWorker
        ? {
            controller: {},
            ready: Promise.resolve(registration),
            getRegistration: async () => registration,
            addEventListener() {},
          }
        : {
            controller: null,
            // never settles without a registered worker
            ready: new Promise(() => {}),
            getRegistration: async () => undefined,
            addEventListener() {},
          },
  });

  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ url: String(url), method, body });
    if (method === 'POST') {
      return new Response(
        JSON.stringify({
          id: 'reg-me',
          alias: 'alias-me',
          platform: body.platform,
          token: body.token,
        }),
        { status: 201 },
      );
    }
    if (method === 'GET') {
      const posted = state.requests.filter((r) => r.method === 'POST');
      return new Response(
        JSON.stringify(
          posted.map((r) => ({
            id: 'reg-me',
            alias: 'alias-me',
            platform: r.body.platform,
            token: r.body.token,
            failure_count: 0,
          })),
        ),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });

  return { state, registration, activate: () => activate() };
}

async function loadModules({ vapidKey = p256PublicKey() } = {}) {
  vi.resetModules();
  const { config } = await import('../../src/config.js');
  config.unifiedPushVapidPublicKey = vapidKey;
  const push = await import('../../src/utils/push-notifications.js');
  const manager = await import('../../src/utils/notification-manager.js');
  const open = await import('../../src/utils/notification-open.ts');
  return { push, manager, open };
}

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

function newMessage(uid, subject = 'Quarterly report') {
  return {
    notification_id: `n-${uid}`,
    mailbox: 'INBOX',
    message: {
      id: uid,
      uid,
      from: { text: 'Alice <alice@example.com>' },
      subject,
    },
  };
}

// Let the async new-message handler (dynamic imports, permission reads)
// finish before asserting that nothing was shown.
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

const originalNotification = globalThis.Notification;
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalFetch = globalThis.fetch;

describe('browser notifications when Web Push cannot deliver', () => {
  let cleanup = null;

  beforeEach(() => {
    localStorage.clear();
    localStore.clear();
    accounts.length = 0;
    localStore.set('email', EMAIL);
    localStore.set('alias_auth', `${EMAIL}:${PASSWORD}`);
    accounts.push({ email: EMAIL, aliasAuth: `${EMAIL}:${PASSWORD}` });
    // The app is open in a background tab: new mail gets a system notification.
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    cleanup?.();
    cleanup = null;
    // nothing from this test may still be running when the next one starts
    await settle();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    globalThis.Notification = originalNotification;
    window.Notification = originalNotification;
    if (originalServiceWorker)
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    else delete navigator.serviceWorker;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('leaves new mail to the service worker when Web Push registered', async () => {
    const { state, registration } = installBrowser();
    const { push, manager } = await loadModules();

    await expect(push.syncPushNotifications()).resolves.toBe(true);
    const status = await push.getPushNotificationStatus();
    expect(status.browserNotifications).toEqual({
      mode: 'push',
      permission: 'granted',
      pushFailure: null,
    });

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('push-ok-1'));
    // handled: the badge counts it
    await vi.waitFor(() => expect(manager.getBadgeCount()).toBe(1));
    await settle();

    // The push for this message reaches the service worker, which shows it.
    // The page drawing the WebSocket copy as well would notify twice.
    expect(registration.showNotification).not.toHaveBeenCalled();
    expect(state.created).toHaveLength(0);
  });

  it('shows new mail through the service worker when the push service is unreachable', async () => {
    const { state, registration } = installBrowser({
      // what Chromium rejects with when it cannot register with FCM
      subscribeError: new DOMException('Registration failed - push service error', 'AbortError'),
    });
    const { push, manager } = await loadModules();

    await expect(push.syncPushNotifications()).resolves.toBe(false);
    const status = await push.getPushNotificationStatus();
    expect(status.browserNotifications).toEqual({
      mode: 'fallback',
      permission: 'granted',
      pushFailure: 'push-service-unavailable',
    });
    expect(state.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('fallback-1'));

    await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
    const [title, options] = registration.showNotification.mock.calls[0];
    expect(title).toBe('Alice');
    expect(options.body).toBe('Quarterly report');
    // The service worker's notificationclick opens this message in its account.
    expect(options.data.target).toEqual({
      account: EMAIL,
      folder: 'INBOX',
      messageId: 'fallback-1',
    });
    expect(state.created).toHaveLength(0);
  });

  it('shows each message once when the socket repeats it', async () => {
    const { registration } = installBrowser({
      subscribeError: new DOMException('Registration failed - push service error', 'AbortError'),
    });
    const { push, manager } = await loadModules();
    await push.syncPushNotifications();

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('repeat-1'));
    await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
    ws.emit('newMessage', { ...newMessage('repeat-1'), notification_id: 'n-repeat-1-replay' });
    await settle();

    expect(registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it('uses new Notification() without a service worker, and a click opens the message', async () => {
    const { state } = installBrowser({ pushManager: false, serviceWorker: false });
    const { push, manager, open } = await loadModules();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});

    await expect(push.syncPushNotifications()).resolves.toBe(false);
    const status = await push.getPushNotificationStatus();
    expect(status.supported).toBe(false);
    expect(status.browserNotifications.mode).toBe('fallback');

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('no-push-1'));

    await vi.waitFor(() => expect(state.created).toHaveLength(1));
    const notification = state.created[0];
    expect(notification.title).toBe('Alice');

    notification.onclick();
    expect(focus).toHaveBeenCalled();
    expect(notification.closed).toBe(true);
    expect(open.openNotificationTarget).toHaveBeenCalledWith({
      account: EMAIL,
      folder: 'INBOX',
      messageId: 'no-push-1',
    });
  });

  it('waits for a service worker that is still installing (a first visit) and shows new mail once', async () => {
    const { state, registration, activate } = installBrowser({
      pushManager: false,
      serviceWorker: 'installing',
    });
    // (a worker without an active one rejects, as Chromium does)
    registration.showNotification.mockImplementation(async () => {
      if (!registration.active)
        throw new TypeError('No active registration available on the ServiceWorkerRegistration.');
    });
    const { push, manager } = await loadModules();
    await push.syncPushNotifications();

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('installing-1'));
    await settle();
    expect(registration.showNotification).not.toHaveBeenCalled();

    activate();
    await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
    await settle();
    expect(registration.showNotification).toHaveBeenCalledTimes(1);
    expect(state.created).toHaveLength(0);
  });

  it('uses new Notification() once when the installing service worker does not become active in time', async () => {
    const { state, registration } = installBrowser({
      pushManager: false,
      serviceWorker: 'installing',
    });
    const { push, manager } = await loadModules();
    await push.syncPushNotifications();

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('installing-2'));

    await vi.waitFor(() => expect(state.created).toHaveLength(1), { timeout: 5000 });
    expect(state.created[0].title).toBe('Alice');
    expect(registration.showNotification).not.toHaveBeenCalled();
  });

  it('falls back the same way when the build has no Web Push key', async () => {
    const { registration } = installBrowser();
    const { push, manager } = await loadModules({ vapidKey: '' });

    expect((await push.getPushNotificationStatus()).browserNotifications.mode).toBe('fallback');

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('no-key-1'));
    await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
  });

  it('never prompts on its own; the offer toast prompts from its button', async () => {
    const { state } = installBrowser({ permission: 'default', pushManager: false });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const { push, manager } = await loadModules();
    const toasts = { show: vi.fn() };
    manager.setNotificationToasts(toasts);

    await push.syncPushNotifications();
    expect((await push.getPushNotificationStatus()).browserNotifications.mode).toBe(
      'needs-permission',
    );
    await manager.initNotificationPermission();
    expect(state.prompts).toBe(0);

    const offer = toasts.show.mock.calls.find(([, , , action]) => action?.label === 'Turn on');
    expect(offer).toBeTruthy();
    // The click handler asks synchronously, while the click counts as a gesture.
    offer[3].callback();
    expect(state.prompts).toBe(1);
    await vi.waitFor(() =>
      expect(toasts.show).toHaveBeenCalledWith('Notifications are on.', 'success'),
    );
    expect((await push.getPushNotificationStatus()).browserNotifications.mode).toBe('fallback');

    // offered once per device
    toasts.show.mockClear();
    await manager.initNotificationPermission();
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('asks from the Settings button in the same click, then tries Web Push', async () => {
    const { state } = installBrowser({ permission: 'default' });
    const { push } = await loadModules();

    const pending = push.allowBrowserNotifications();
    expect(state.prompts).toBe(1);
    await expect(pending).resolves.toBe('granted');

    // allowed, so Web Push registered as well
    expect(state.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect((await push.getPushNotificationStatus()).browserNotifications.mode).toBe('push');
  });

  it('does not prompt a site the user blocked, and Settings reports it', async () => {
    const { state, registration } = installBrowser({ permission: 'denied', pushManager: false });
    const { push, manager } = await loadModules();
    const toasts = { show: vi.fn() };
    manager.setNotificationToasts(toasts);

    await expect(push.allowBrowserNotifications()).resolves.toBe('denied');
    await expect(manager.requestNotificationPermission()).resolves.toBe(false);
    await manager.initNotificationPermission();
    expect(state.prompts).toBe(0);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(toasts.show).not.toHaveBeenCalled();

    const status = await push.getPushNotificationStatus();
    expect(status.browserNotifications).toMatchObject({ mode: 'blocked', permission: 'denied' });

    const ws = createWsClient();
    cleanup = manager.connectNotifications(ws);
    ws.emit('newMessage', newMessage('blocked-1'));
    await vi.waitFor(() => expect(manager.getBadgeCount()).toBe(1));
    await settle();
    expect(registration.showNotification).not.toHaveBeenCalled();
    expect(state.created).toHaveLength(0);
  });

  it('reports a page without the Notifications API as unavailable', async () => {
    installBrowser({ pushManager: false });
    delete globalThis.Notification;
    delete window.Notification;
    const { push } = await loadModules();

    const status = await push.getPushNotificationStatus();
    expect(status.browserNotifications).toMatchObject({
      mode: 'unavailable',
      permission: 'unsupported',
    });
    await expect(push.allowBrowserNotifications()).resolves.toBe('denied');
  });
});
