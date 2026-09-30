/**
 * Web Push in the browser build: Settings registration subscribes this
 * browser with the VAPID key and registers the subscription with the server
 * as platform "web-push" for every signed-in account.
 *
 * The browser pieces (Notification, PushManager, the service worker
 * registration) are stand-ins with the real API shapes; the push module, the
 * web-push module and the server client run for real against a recorded fetch.
 */
import crypto from 'node:crypto';

const { localStore, accounts } = vi.hoisted(() => ({
  localStore: new Map(),
  accounts: [],
}));

vi.mock('../../src/utils/demo-mode.js', () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn((key) => localStore.get(key)),
    set: vi.fn((key, value) => localStore.set(key, value)),
    remove: vi.fn((key) => localStore.delete(key)),
  },
  Accounts: {
    getAll: vi.fn(() => accounts),
  },
}));

const EMAIL = 'me@example.com';
const OTHER = 'other@example.com';
const PASSWORD = 'generated-password';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/browser-subscription';

function p256PublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}

function installBrowser({ permission = 'default', pushManager = true } = {}) {
  const state = {
    permission,
    subscription: null,
    subscribeCalls: [],
    workerMessages: [],
    requests: [],
  };

  const keys = { p256dh: p256PublicKey(), auth: crypto.randomBytes(16).toString('base64url') };

  globalThis.Notification = {
    get permission() {
      return state.permission;
    },
    requestPermission: vi.fn(async () => {
      state.permission = 'granted';
      return 'granted';
    }),
  };
  window.Notification = globalThis.Notification;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  if (pushManager) window.PushManager = function PushManager() {};
  else delete window.PushManager;

  const registration = {
    active: { postMessage: (message) => state.workerMessages.push(message) },
    pushManager: {
      getSubscription: async () => state.subscription,
      subscribe: async (options) => {
        state.subscribeCalls.push(options);
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
    value: {
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
      addEventListener() {},
    },
    configurable: true,
  });

  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ url: String(url), method, body, headers: init.headers || {} });
    const auth = init.headers?.Authorization || '';
    const email = Buffer.from(auth.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':')[0];
    const aliasId = email === OTHER ? 'alias-other' : 'alias-me';
    if (method === 'POST') {
      return new Response(
        JSON.stringify({
          id: `reg-${aliasId}`,
          alias: aliasId,
          platform: body.platform,
          token: body.token,
        }),
        { status: 201 },
      );
    }
    if (method === 'GET') {
      const posted = state.requests.filter((r) => r.method === 'POST');
      const mine = posted.filter((r) => {
        const a = r.headers.Authorization || '';
        return Buffer.from(a.replace(/^Basic /, ''), 'base64')
          .toString()
          .startsWith(email);
      });
      return new Response(
        JSON.stringify(
          mine.map((r) => ({
            id: `reg-${aliasId}`,
            alias: aliasId,
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

  return { state, keys };
}

async function loadModule(vapidPublicKey = p256PublicKey()) {
  vi.resetModules();
  const { config } = await import('../../src/config.js');
  config.unifiedPushVapidPublicKey = vapidPublicKey;
  const push = await import('../../src/utils/push-notifications.js');
  return { push, vapidPublicKey };
}

describe('web push in the browser build', () => {
  beforeEach(() => {
    localStore.clear();
    accounts.length = 0;
    localStore.set('email', EMAIL);
    localStore.set('alias_auth', `${EMAIL}:${PASSWORD}`);
    accounts.push(
      { email: EMAIL, aliasAuth: `${EMAIL}:${PASSWORD}` },
      { email: OTHER, aliasAuth: `${OTHER}:${PASSWORD}` },
    );
  });

  it('reports this browser as supported with the Web Push provider', async () => {
    installBrowser();
    const { push } = await loadModule();

    const status = await push.getPushNotificationStatus();
    expect(status.supported).toBe(true);
    expect(status.platform).toBe('web');
    expect(status.provider).toBe('web-push');
    expect(status.permission).toBe('not-granted');
    expect(status.health).toBe('permission-not-granted');
  });

  it('registers from Settings: prompts in the click, subscribes, and registers every account', async () => {
    const { state, keys } = installBrowser();
    const { push, vapidPublicKey } = await loadModule();

    const pending = push.registerCurrentDevicePush();
    // asked synchronously, while the click still counts as a user gesture
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.status.health).toBe('active');
    expect(result.status.currentRegistration.platform).toBe('web-push');

    expect(state.subscribeCalls).toHaveLength(1);
    expect(state.subscribeCalls[0].userVisibleOnly).toBe(true);
    expect(Buffer.from(state.subscribeCalls[0].applicationServerKey).toString('base64url')).toBe(
      vapidPublicKey,
    );

    const posts = state.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.url)).toEqual([
      'https://api.forwardemail.net/v1/push-tokens',
      'https://api.forwardemail.net/v1/push-tokens',
    ]);
    for (const post of posts) {
      expect(post.body.platform).toBe('web-push');
      expect(JSON.parse(post.body.token)).toEqual({ endpoint: ENDPOINT, keys });
    }

    // the worker learns which account each alias belongs to
    expect(state.workerMessages).toContainEqual({
      type: 'push-accounts',
      accounts: { 'alias-me': EMAIL, 'alias-other': OTHER },
    });
    expect(push.getActivePushProvider()).toBe('web-push');
    await expect(push.canReceiveWebPush()).resolves.toBe(true);
  });

  it('never prompts or subscribes on its own before the user allows notifications', async () => {
    const { state } = installBrowser();
    const { push } = await loadModule();

    await expect(push.syncPushNotifications()).resolves.toBe(false);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(state.subscribeCalls).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
  });

  it('keeps an allowed browser registered at startup without prompting', async () => {
    const { state } = installBrowser({ permission: 'granted' });
    const { push } = await loadModule();

    await expect(push.syncPushNotifications()).resolves.toBe(true);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(state.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('explains when the browser has no Push API (iOS Safari outside the Home Screen)', async () => {
    installBrowser({ pushManager: false });
    const { push } = await loadModule();

    const status = await push.getPushNotificationStatus();
    expect(status.supported).toBe(false);
    expect(status.platform).toBe('web');
    const result = await push.registerCurrentDevicePush();
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('names a browser that cannot reach its push service and registers nothing', async () => {
    const { state } = installBrowser({ permission: 'granted' });
    const registration = await navigator.serviceWorker.ready;
    // what Chromium rejects with when it cannot register with FCM (Brave
    // with Google push messaging off, a blocked network)
    registration.pushManager.subscribe = async () => {
      throw new DOMException('Registration failed - push service error', 'AbortError');
    };
    const { push } = await loadModule();

    const result = await push.registerCurrentDevicePush();
    expect(result).toMatchObject({ ok: false, code: 'push-service-unavailable' });
    expect(result.detail).toBe('Registration failed - push service error');
    expect(state.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    await expect(push.canReceiveWebPush()).resolves.toBe(false);
  });

  it('replaces a subscription made with an old VAPID key', async () => {
    const { state } = installBrowser({ permission: 'granted' });
    const oldKey = Buffer.from(p256PublicKey(), 'base64url');
    let unsubscribed = false;
    state.subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/old',
      options: { applicationServerKey: new Uint8Array(oldKey).buffer },
      toJSON: () => ({}),
      unsubscribe: async () => {
        unsubscribed = true;
        state.subscription = null;
        return true;
      },
    };
    const { push } = await loadModule();

    await expect(push.syncPushNotifications()).resolves.toBe(true);
    expect(unsubscribed).toBe(true);
    expect(state.subscribeCalls).toHaveLength(1);
  });

  it('keeps a subscription made with the current key (or one whose key is not exposed)', async () => {
    const vapidPublicKey = p256PublicKey();
    for (const applicationServerKey of [
      new Uint8Array(Buffer.from(vapidPublicKey, 'base64url')).buffer,
      null,
    ]) {
      const { state, keys } = installBrowser({ permission: 'granted' });
      let unsubscribed = false;
      state.subscription = {
        endpoint: ENDPOINT,
        options: { applicationServerKey },
        toJSON: () => ({ endpoint: ENDPOINT, keys }),
        unsubscribe: async () => {
          unsubscribed = true;
          return true;
        },
      };
      localStore.clear();
      localStore.set('email', EMAIL);
      localStore.set('alias_auth', `${EMAIL}:${PASSWORD}`);
      const { push } = await loadModule(vapidPublicKey);

      await expect(push.syncPushNotifications()).resolves.toBe(true);
      expect(unsubscribed).toBe(false);
      expect(state.subscribeCalls).toHaveLength(0);
    }
  });
});
