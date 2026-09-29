/**
 * notification-open.ts: every notification tap or click ends up here. See the
 * module header for why the tap is held until the app is ready and why an
 * account switch is awaited before navigating.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { localValues, accounts } = vi.hoisted(() => ({
  localValues: new Map<string, string>(),
  accounts: [] as Array<{ email: string }>,
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key: string) => localValues.get(key) ?? null,
    set: (key: string, value: string) => localValues.set(key, value),
    remove: (key: string) => localValues.delete(key),
  },
  Accounts: { getAll: () => accounts },
}));

const open = await import('../../src/utils/notification-open.ts');

describe('notification-open', () => {
  let navigated: string[];
  let ready: boolean;

  beforeEach(() => {
    open.__resetNotificationOpenForTests();
    navigated = [];
    ready = true;
    localValues.clear();
    localValues.set('email', 'alice@example.com');
    accounts.length = 0;
    accounts.push({ email: 'alice@example.com' });
    open.configureNotificationOpen({
      isReady: () => ready,
      switchAccount: async () => {},
      navigate: (path) => navigated.push(path),
    });
  });

  it('maps forwardemail:// links into the app, and leaves others alone', () => {
    expect(open.deepLinkToTarget('forwardemail://mailbox#inbox/42')).toEqual({
      folder: 'INBOX',
      messageId: '42',
    });
    expect(open.deepLinkToTarget('forwardemail://mailbox#Work%2FProjects/abc')).toEqual({
      folder: 'Work/Projects',
      messageId: 'abc',
    });
    expect(open.deepLinkToTarget('forwardemail://calendar#event=evt-1')).toEqual({
      appPath: '/calendar#event=evt-1',
    });
    expect(open.deepLinkToTarget('forwardemail://mailbox/settings')).toBeNull();
    expect(open.deepLinkToTarget('mailto:someone@example.com')).toBeNull();
    expect(open.deepLinkToTarget('forwardemail://elsewhere')).toBeNull();
  });

  it('refuses paths outside the app and message ids that are not ids', () => {
    expect(open.normalizeNotificationTarget({ appPath: 'https://evil.example/' })).toBeNull();
    expect(open.normalizeNotificationTarget({ appPath: '/mailbox/settings' })).toBeNull();
    expect(open.normalizeNotificationTarget({ folder: 'INBOX', messageId: '../../x?y' })).toEqual({
      folder: 'INBOX',
    });
  });

  it('builds the mailbox location with the folder and id encoded', () => {
    expect(open.notificationTargetPath({ folder: 'Work/Projects', messageId: 'a1' })).toBe(
      '/mailbox#Work%2FProjects/a1',
    );
    expect(open.notificationTargetPath({ folder: 'Archive' })).toBe('/mailbox#Archive');
    expect(open.notificationTargetPath({ messageId: 'a1' })).toBe('/mailbox#INBOX/a1');
  });

  it('maps push payloads from the server to targets', () => {
    expect(
      open.pushDataToTarget(
        { event: 'newMessage', message_id: 'm1', mailbox: 'INBOX', alias_id: 'x' },
        'bob@example.com',
      ),
    ).toEqual({ account: 'bob@example.com', folder: 'INBOX', messageId: 'm1' });
    expect(open.pushDataToTarget({ event: 'calendarEventCreated', message_id: 'e1' })).toEqual({
      appPath: '/calendar#event=e1',
    });
    expect(open.pushDataToTarget({ event: 'contactUpdated', id: 'c1' })).toEqual({
      appPath: '/contacts#contact=c1',
    });
  });

  it('holds a tap until the app is ready, then opens it once', async () => {
    ready = false;
    open.openNotificationTarget({ folder: 'INBOX', messageId: 'm2' });
    await open.flushPendingNotificationOpen();
    expect(navigated).toEqual([]);

    ready = true;
    await open.flushPendingNotificationOpen();
    await open.flushPendingNotificationOpen();
    expect(navigated).toEqual(['/mailbox#INBOX/m2']);
  });

  it('keeps only the newest pending tap', async () => {
    ready = false;
    open.openNotificationTarget({ folder: 'INBOX', messageId: 'first' });
    open.openNotificationTarget({ folder: 'INBOX', messageId: 'second' });
    ready = true;
    await open.flushPendingNotificationOpen();
    expect(navigated).toEqual(['/mailbox#INBOX/second']);
  });

  it('drops a tap that has waited too long', async () => {
    vi.useFakeTimers();
    try {
      ready = false;
      open.openNotificationTarget({ folder: 'INBOX', messageId: 'old' });
      vi.advanceTimersByTime(11 * 60 * 1000);
      ready = true;
      await open.flushPendingNotificationOpen();
      expect(navigated).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a target in the URL of a page reached through a link', async () => {
    const referrer = vi
      .spyOn(document, 'referrer', 'get')
      .mockReturnValue('https://elsewhere.example/');
    try {
      history.replaceState(
        null,
        '',
        `/mailbox?fe_notify=${encodeURIComponent(JSON.stringify({ folder: 'INBOX', messageId: 'x' }))}`,
      );
      expect(open.consumeNotificationTargetFromUrl()).toBe(false);
      // Removed from the address bar all the same.
      expect(window.location.search).toBe('');
      await open.flushPendingNotificationOpen();
      expect(navigated).toEqual([]);
    } finally {
      referrer.mockRestore();
    }
  });

  it('reads and removes a target a web notification put in the URL', async () => {
    const target = { folder: 'INBOX', messageId: 'm3' };
    history.replaceState(
      null,
      '',
      `/mailbox?fe_notify=${encodeURIComponent(JSON.stringify(target))}#INBOX`,
    );
    expect(open.consumeNotificationTargetFromUrl()).toBe(true);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#INBOX');
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/m3']));
  });
});
