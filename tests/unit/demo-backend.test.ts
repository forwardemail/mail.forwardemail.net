/**
 * The demo mailbox as a mail backend: the real demo data and the real
 * backend, with only the toast host stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false, isTauri: false }));

import {
  activateDemoMode,
  deactivateDemoMode,
  isDemoBlockedError,
  setDemoToasts,
} from '../../src/utils/demo-mode';
import { DEMO_EMAIL } from '../../src/utils/demo-data';
import {
  backendKindForAccount,
  DemoBackend,
  getMailBackend,
  resetMailBackendsForTests,
} from '../../src/backends';

const show = vi.fn();

beforeEach(() => {
  show.mockReset();
  setDemoToasts({ show });
  resetMailBackendsForTests();
  activateDemoMode();
});
afterEach(() => {
  deactivateDemoMode();
  setDemoToasts(null);
  resetMailBackendsForTests();
});

const demo = () => getMailBackend(DEMO_EMAIL) as DemoBackend;

describe('the demo backend', () => {
  it('is the backend of every account while the demo is on, and of none after', () => {
    expect(demo()).toBeInstanceOf(DemoBackend);
    expect(backendKindForAccount('someone@else.example')).toBe('demo');

    deactivateDemoMode();
    resetMailBackendsForTests();
    expect(backendKindForAccount(DEMO_EMAIL)).toBe('forwardemail');
    expect(getMailBackend(DEMO_EMAIL)).not.toBeInstanceOf(DemoBackend);
  });

  it('lists folders and a page of the inbox', async () => {
    const folders = await demo().listFolders();
    expect(folders.map((f) => f.path)).toContain('INBOX');
    const rows = await demo().requestMessageList({ folder: 'INBOX', page: 1 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ id: expect.any(String), subject: expect.any(String) });
  });

  it('opens the message that was asked for', async () => {
    const rows = await demo().requestMessageList({ folder: 'INBOX' });
    const wanted = rows[rows.length - 1];
    const opened = await demo().requestMessage(wanted.id, { folder: 'INBOX' });
    expect(opened.id).toBe(wanted.id);
    expect(opened.subject).toBe(wanted.subject);
  });

  it('remembers a message marked read, and unread again', async () => {
    const unread = (await demo().requestMessageList({ folder: 'INBOX' })).find(
      (m: { flags?: string[] }) => !m.flags?.includes('\\Seen'),
    );
    expect(unread, 'the demo inbox has an unread message').toBeTruthy();
    const flagsNow = async () =>
      (await demo().requestMessageList({ folder: 'INBOX' })).find(
        (m: { id: string }) => m.id === unread.id,
      ).flags;

    await demo().changeFlags(unread.id, { add: ['\\Seen'] });
    expect(await flagsNow()).toContain('\\Seen');

    await demo().changeFlags(unread.id, { remove: ['\\Seen'] });
    expect(await flagsNow()).not.toContain('\\Seen');
  });

  it('answers a search from the demo mailbox', async () => {
    const subject = (await demo().requestMessageList({ folder: 'INBOX' }))[0].subject as string;
    const word = subject.split(/\s+/).find((w) => w.length > 3) as string;
    const hits = await demo().requestMessageList({ search: word });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const text = JSON.stringify(hit).toLowerCase();
      expect(text).toContain(word.toLowerCase());
    }
  });

  it('refuses a move with a toast naming what the user tried', async () => {
    const err = await demo()
      .moveMessage('demo-1', 'Archive', { label: 'Archive' })
      .catch((e) => e);
    expect(isDemoBlockedError(err)).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toContain('Archive');
  });

  it('refuses deletes and folder changes the same way', async () => {
    for (const attempt of [
      () => demo().deleteMessage(),
      () => demo().createFolder(),
      () => demo().renameFolder(),
      () => demo().deleteFolder(),
    ]) {
      expect(isDemoBlockedError(await attempt().catch((e) => e))).toBe(true);
    }
    expect(show).toHaveBeenCalledTimes(4);
  });

  it('gives the service worker nothing to replay', () => {
    expect(demo().backgroundReplay()).toBeNull();
  });
});
