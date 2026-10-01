// Notification bridge – the browser path.
//
// notify() now reports whether a system notification reached the OS, so the
// caller can fall back to an in-app notice. The service worker path used to
// fire and forget: a rejected showNotification() was an unhandled rejection
// and the caller believed the notification had been shown.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({ isTauri: false, isTauriMobile: false }));
vi.mock('../../src/utils/notification-open.ts', () => ({
  notificationDataToTarget: vi.fn(() => ({ folder: 'INBOX', messageId: '7' })),
  openNotificationTarget: vi.fn(),
}));

import {
  canRevokePermission,
  getPermissionState,
  notify,
  requestPermission,
  revokePermission,
} from '../../src/utils/notification-bridge.js';

const originalNotification = globalThis.Notification;
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

function installNotification({ permission = 'granted', throws = false, request } = {}) {
  const created = [];
  class FakeNotification {
    constructor(title, options) {
      if (throws) throw new TypeError('Illegal constructor');
      this.title = title;
      this.options = options;
      created.push(this);
    }
    close() {}
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = request || vi.fn(async () => permission);
  globalThis.Notification = FakeNotification;
  return created;
}

function installServiceWorker(showNotification) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: {},
      ready: Promise.resolve({ showNotification }),
    },
  });
}

describe('notification-bridge on the web', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.Notification = originalNotification;
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
      delete navigator.serviceWorker;
    }
    vi.restoreAllMocks();
  });

  it('shows the notification through the service worker, with the app icon', async () => {
    installNotification();
    const showNotification = vi.fn(async () => {});
    installServiceWorker(showNotification);

    const shown = await notify({ title: 'Alice', body: 'Hello', tag: 'new-message-1' });

    expect(shown).toBe(true);
    expect(showNotification).toHaveBeenCalledWith('Alice', {
      body: 'Hello',
      icon: '/icons/icon-192.png',
      tag: 'new-message-1',
      data: { target: { folder: 'INBOX', messageId: '7' } },
    });
  });

  it('falls back to new Notification() when the service worker refuses', async () => {
    const created = installNotification();
    installServiceWorker(vi.fn(async () => Promise.reject(new TypeError('No permission'))));

    const shown = await notify({ title: 'Alice', body: 'Hello' });

    expect(shown).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Alice');
  });

  it('reports failure when neither path can show it', async () => {
    installNotification({ throws: true });
    installServiceWorker(vi.fn(async () => Promise.reject(new TypeError('No permission'))));

    expect(await notify({ title: 'Alice', body: 'Hello' })).toBe(false);
  });

  it('reports failure without permission and never asks for it', async () => {
    installNotification({ permission: 'default' });

    expect(await notify({ title: 'Alice', body: 'Hello' })).toBe(false);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('reads the permission state without prompting', async () => {
    installNotification({ permission: 'denied' });
    expect(await getPermissionState()).toBe('denied');
    installNotification({ permission: 'default' });
    expect(await getPermissionState()).toBe('default');
    delete globalThis.Notification;
    expect(await getPermissionState()).toBe('unsupported');
    expect(await requestPermission()).toBe('denied');
  });

  it('supports the callback-only requestPermission of older Safari', async () => {
    installNotification({
      permission: 'default',
      request: vi.fn((callback) => {
        callback('granted');
        return undefined;
      }),
    });

    expect(await requestPermission()).toBe('granted');
  });
  it('turns notifications off only where the app keeps the permission (the terminal client)', async () => {
    installNotification({ permission: 'granted' });
    // A browser keeps the choice in its own settings.
    expect(canRevokePermission()).toBe(false);
    expect(await revokePermission()).toBe(false);

    // The terminal client's Notification can give the permission back.
    installNotification({ permission: 'granted' });
    globalThis.Notification.revokePermission = vi.fn(async () => {
      globalThis.Notification.permission = 'default';
    });
    expect(canRevokePermission()).toBe(true);
    expect(await revokePermission()).toBe(true);
    expect(globalThis.Notification.revokePermission).toHaveBeenCalledOnce();
    expect(await getPermissionState()).toBe('default');
  });
});
