/**
 * Notification channels exist only on Android. On iOS the plugin answers
 * createChannel with "not implemented", so the startup call is a wasted
 * native round trip that raced the click handler's own plugin calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createChannel } = vi.hoisted(() => ({ createChannel: vi.fn(async () => {}) }));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: true,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({ createChannel }));

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

async function loadOn(userAgent) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.resetModules();
  return import('../../src/utils/notification-bridge.js');
}

describe('notification channels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    createChannel.mockClear();
  });

  it('creates the mail and sync channels on Android', async () => {
    const { initNotificationChannels } = await loadOn(ANDROID_UA);
    await initNotificationChannels();
    expect(createChannel.mock.calls.map(([channel]) => channel.id)).toEqual([
      'new-mail',
      'sync-status',
    ]);
  });

  it('asks the plugin for no channels on iOS', async () => {
    const { initNotificationChannels } = await loadOn(IPHONE_UA);
    await initNotificationChannels();
    expect(createChannel).not.toHaveBeenCalled();
  });
});
