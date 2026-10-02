/**
 * The browser notification fallback stays out of the desktop and mobile apps.
 * They show notifications through the Tauri notification plugin and ask the
 * operating system for permission directly, as before.
 */

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(),
}));

vi.mock('../../src/utils/platform.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: true,
  isTauriDesktop: true,
  isTauriMobile: false,
  isTauriMacOS: false,
}));
vi.mock('@tauri-apps/plugin-notification', () => plugin);
vi.mock('../../src/utils/demo-mode.js', () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => undefined), set: vi.fn(), remove: vi.fn() },
  Accounts: { getAll: vi.fn(() => []) },
}));

import { notify } from '../../src/utils/notification-bridge.js';
import {
  allowBrowserNotifications,
  getPushNotificationStatus,
} from '../../src/utils/push-notifications.js';
import { clearTaskReminders, refreshTaskReminders } from '../../src/utils/task-reminders.ts';

const originalNotification = globalThis.Notification;

describe('native apps keep their own notifications', () => {
  let browserNotification;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin.isPermissionGranted.mockResolvedValue(false);
    browserNotification = vi.fn();
    browserNotification.permission = 'default';
    browserNotification.requestPermission = vi.fn(async () => 'granted');
    globalThis.Notification = browserNotification;
  });

  afterEach(() => {
    clearTaskReminders();
    globalThis.Notification = originalNotification;
  });

  it('shows notifications through the Tauri plugin, never the Notifications API', async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);

    await expect(notify({ title: 'Alice', body: 'Hello', tag: 'new-message-1' })).resolves.toBe(
      true,
    );
    expect(plugin.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Alice', body: 'Hello' }),
    );
    expect(browserNotification).not.toHaveBeenCalled();
  });

  it('has no browser notification state and never asks the browser', async () => {
    const status = await getPushNotificationStatus();
    expect(status.browserNotifications).toBeNull();

    await expect(allowBrowserNotifications()).resolves.toBe('unsupported');
    expect(browserNotification.requestPermission).not.toHaveBeenCalled();
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it('still asks the operating system when task reminders load', async () => {
    refreshTaskReminders([]);

    await vi.waitFor(() => expect(plugin.requestPermission).toHaveBeenCalledTimes(1));
    expect(browserNotification.requestPermission).not.toHaveBeenCalled();
  });
});
