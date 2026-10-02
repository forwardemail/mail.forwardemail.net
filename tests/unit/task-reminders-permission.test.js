/**
 * Task reminders in the browser never ask for notification permission when
 * the calendar loads. That ask comes from no click, and browsers ignore such
 * a prompt (some count it against the site). The web app asks from the Turn
 * on toast and from Settings, and reminders show once the user allows it.
 */

vi.mock('../../src/utils/platform.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: false,
  isTauriMobile: false,
}));

import { clearTaskReminders, refreshTaskReminders } from '../../src/utils/task-reminders.ts';

const originalNotification = globalThis.Notification;

describe('task reminders in the browser', () => {
  afterEach(() => {
    clearTaskReminders();
    globalThis.Notification = originalNotification;
  });

  it('does not prompt for permission when the calendar loads', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    globalThis.Notification = { permission: 'default', requestPermission };

    refreshTaskReminders([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestPermission).not.toHaveBeenCalled();
  });
});
