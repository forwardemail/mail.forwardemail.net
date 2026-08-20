import {
  cleanupPushNotifications,
  initPushNotifications,
} from '../../src/utils/push-notifications.js';

const { callbacks, listenerCleanup, registerPushTokenMock, unregisterPushTokenMock } = vi.hoisted(
  () => ({
    callbacks: {},
    listenerCleanup: { unregister: vi.fn(() => Promise.resolve()) },
    registerPushTokenMock: vi.fn(() =>
      Promise.resolve({ id: 'registration-id', aliasId: 'alias-1' }),
    ),
    unregisterPushTokenMock: vi.fn(() => Promise.resolve()),
  }),
);

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: true,
}));

vi.mock('../../src/utils/background-service.js', () => ({
  listPushTokens: vi.fn().mockResolvedValue([]),
  registerPushToken: registerPushTokenMock,
  registerPushTokenForAccount: vi.fn(() =>
    Promise.resolve({ id: 'multi-reg-1', aliasId: 'alias-multi-1' }),
  ),
  unregisterPushToken: unregisterPushTokenMock,
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));

vi.mock('../../src/utils/storage', () => {
  const values = new Map();
  return {
    Local: {
      get: vi.fn((key) => values.get(key) ?? null),
      set: vi.fn((key, value) => values.set(key, value)),
      remove: vi.fn((key) => values.delete(key)),
    },
    Accounts: {
      getAll: vi.fn(() => []),
    },
  };
});

vi.mock('../../src/utils/unified-push.js', () => ({
  drainUnifiedPushMessages: vi.fn(() => Promise.resolve([])),
  getUnifiedPushState: vi.fn(() => Promise.resolve(null)),
  getUnifiedPushVapidPublicKey: vi.fn(() => ''),
  isUnifiedPushSupported: vi.fn(() => false),
  listenForUnifiedPush: vi.fn(() => Promise.resolve()),
  pickUnifiedPushDistributor: vi.fn(() => Promise.resolve()),
  registerUnifiedPush: vi.fn(() => Promise.resolve()),
  removeUnifiedPushListeners: vi.fn(() => Promise.resolve()),
  serializeUnifiedPushSubscription: vi.fn(() => ''),
  unregisterUnifiedPush: vi.fn(() => Promise.resolve()),
}));

vi.mock('tauri-plugin-remote-push-api', () => ({
  getToken: vi.fn(() => Promise.resolve('fcm-device-token-1234567890')),
  requestPermission: vi.fn(() => Promise.resolve({ granted: true })),
  onTokenRefresh: vi.fn(async (callback) => {
    callbacks.tokenRefresh = callback;
    return listenerCleanup;
  }),
  onNotificationReceived: vi.fn(async (callback) => {
    callbacks.received = callback;
    return listenerCleanup;
  }),
  onNotificationTapped: vi.fn(async (callback) => {
    callbacks.tapped = callback;
    return listenerCleanup;
  }),
}));

describe('native push tap normalization', () => {
  beforeEach(async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android');
    await cleanupPushNotifications();
    vi.clearAllMocks();
    for (const key of Object.keys(callbacks)) {
      delete callbacks[key];
    }
  });

  afterEach(async () => {
    await cleanupPushNotifications();
    vi.restoreAllMocks();
  });

  it('marks system-displayed only when the FCM message carried a notification block', async () => {
    await expect(initPushNotifications()).resolves.toBe(true);
    expect(callbacks.received).toBeTypeOf('function');
    expect(callbacks.tapped).toBeTypeOf('function');

    const delivered = [];
    const listener = (event) => delivered.push(event.detail);
    globalThis.addEventListener('fe:push-notification', listener);

    const data = {
      event: 'newMessage',
      notificationId: '123e4567-e89b-12d3-a456-426614174200',
      mailbox: 'INBOX',
    };
    // Alert push: the OS drew this one, the client must not draw again.
    callbacks.received({ data, notification: { title: 'John', body: 'Hi' } });
    // Data-only push: nothing was drawn, the client stays free to draw.
    callbacks.received({ data });
    // A tapped notification was by definition drawn by the OS.
    callbacks.tapped({ data });

    globalThis.removeEventListener('fe:push-notification', listener);
    expect(delivered).toEqual([
      {
        ...data,
        displayedBySystem: true,
      },
      {
        ...data,
      },
      {
        ...data,
        notificationTapped: true,
        displayedBySystem: true,
      },
    ]);
  });
});
