const { callbacks, listenerCleanup, registerPushTokenMock, unregisterPushTokenMock } = vi.hoisted(
  () => ({
    callbacks: {},
    listenerCleanup: { unregister: vi.fn(() => Promise.resolve()) },
    registerPushTokenMock: vi.fn(() => Promise.resolve('registration-id')),
    unregisterPushTokenMock: vi.fn(() => Promise.resolve()),
  }),
);

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: true,
}));

vi.mock('../../src/utils/background-service.js', () => ({
  registerPushToken: registerPushTokenMock,
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

import {
  cleanupPushNotifications,
  initPushNotifications,
} from '../../src/utils/push-notifications.js';

describe('native push tap normalization', () => {
  beforeEach(async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android');
    await cleanupPushNotifications();
    vi.clearAllMocks();
    for (const key of Object.keys(callbacks)) delete callbacks[key];
  });

  afterEach(async () => {
    await cleanupPushNotifications();
    vi.restoreAllMocks();
  });

  it('marks tapped OS notifications as system-displayed without suppressing foreground receipts', async () => {
    await expect(initPushNotifications()).resolves.toBe(true);
    expect(callbacks.received).toBeTypeOf('function');
    expect(callbacks.tapped).toBeTypeOf('function');

    const delivered = [];
    const listener = (event) => delivered.push(event.detail);
    window.addEventListener('fe:push-notification', listener);

    const notification = {
      data: {
        event: 'newMessage',
        notificationId: '123e4567-e89b-12d3-a456-426614174200',
        mailbox: 'INBOX',
      },
    };
    callbacks.received(notification);
    callbacks.tapped(notification);

    window.removeEventListener('fe:push-notification', listener);
    expect(delivered).toEqual([
      notification.data,
      {
        ...notification.data,
        notificationTapped: true,
        displayedBySystem: true,
      },
    ]);
  });
});
