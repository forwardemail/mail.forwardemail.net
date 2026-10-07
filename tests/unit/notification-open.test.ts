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
  let switched: string[];
  let ready: boolean;
  const deps = () => ({
    isReady: () => ready,
    switchAccount: async (email: string) => {
      switched.push(email);
      localValues.set('email', email);
    },
    navigate: (path: string) => navigated.push(path),
  });

  beforeEach(() => {
    open.__resetNotificationOpenForTests();
    navigated = [];
    switched = [];
    ready = true;
    localValues.clear();
    localValues.set('email', 'alice@example.com');
    accounts.length = 0;
    accounts.push({ email: 'alice@example.com' }, { email: 'bob@example.com' });
    open.configureNotificationOpen(deps());
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
    // Delivered to temporary storage: no id yet, so subject and sender.
    expect(
      open.pushDataToTarget({
        event: 'newMessage',
        message_id: '',
        mailbox: 'INBOX',
        subject: 'Lunch on Friday',
        sender: 'Dave <dave@example.com>',
      }),
    ).toEqual({ folder: 'INBOX', subject: 'Lunch on Friday', sender: 'Dave <dave@example.com>' });
  });

  it('hands the mailbox the subject and sender of a message without an id, once', async () => {
    open.openNotificationTarget({
      folder: 'INBOX',
      subject: 'Lunch on Friday',
      sender: 'Dave <dave@example.com>',
    });
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX']));
    const hint = open.takeNotificationMessageHint();
    expect(hint).toEqual({
      folder: 'INBOX',
      subject: 'Lunch on Friday',
      sender: 'Dave <dave@example.com>',
    });
    expect(open.takeNotificationMessageHint()).toBeNull();

    const match = (subject: string, from: unknown) =>
      open.messageMatchesHint({ subject, from }, hint);
    expect(match('Lunch  on friday', 'Dave Smith <DAVE@example.com>')).toBe(true);
    expect(match('Lunch on Friday', { value: [{ address: 'dave@example.com' }] })).toBe(true);
    expect(match('Lunch on Friday', 'Carol <carol@example.com>')).toBe(false);
    expect(match('Re: Lunch on Friday', 'dave@example.com')).toBe(false);
  });

  it('switches to the account as it is stored, whatever its case in the notification', async () => {
    open.openNotificationTarget({ account: 'Bob@Example.com', folder: 'INBOX', messageId: 'm9' });
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/m9']));
    expect(switched).toEqual(['bob@example.com']);
  });

  it('keeps a tap saved until it has been opened, and never its subject', async () => {
    let finishSwitch = () => {};
    open.configureNotificationOpen({
      ...deps(),
      switchAccount: (email: string) =>
        new Promise<void>((resolve) => {
          finishSwitch = () => {
            localValues.set('email', email);
            resolve();
          };
        }),
    });
    open.openNotificationTarget({
      account: 'bob@example.com',
      folder: 'INBOX',
      subject: 'Lunch on Friday',
      sender: 'Dave <dave@example.com>',
    });
    // Mid-switch, the page could still die: the tap is still saved.
    await Promise.resolve();
    const saved = sessionStorage.getItem('fe_notification_open_pending') || '';
    expect(JSON.parse(saved).target).toEqual({ account: 'bob@example.com', folder: 'INBOX' });

    finishSwitch();
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX']));
    expect(sessionStorage.getItem('fe_notification_open_pending')).toBeNull();
  });

  it('keeps a waiting tap across a reload of the page', async () => {
    ready = false;
    open.openNotificationTarget({ account: 'bob@example.com', folder: 'INBOX', messageId: 'm5' });
    await open.flushPendingNotificationOpen();
    expect(navigated).toEqual([]);

    // A fresh copy of the module, as after a reload; sessionStorage remains.
    vi.resetModules();
    const reloaded = await import('../../src/utils/notification-open.ts');
    ready = true;
    reloaded.configureNotificationOpen(deps());
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/m5']));
    expect(switched).toEqual(['bob@example.com']);

    // Opened once: another reload has nothing left.
    vi.resetModules();
    const again = await import('../../src/utils/notification-open.ts');
    again.configureNotificationOpen(deps());
    await again.flushPendingNotificationOpen();
    expect(navigated).toEqual(['/mailbox#INBOX/m5']);
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
