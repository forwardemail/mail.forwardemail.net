// The inbox rows are built by parsing mail headers.
// @vitest-environment node
/**
 * New mail for an account on a custom IMAP server. The mail engine only
 * says "the inbox changed"; this checks what the app makes of that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ active: 'alice@example.org' }));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? h.active : null) },
  Accounts: {
    getAll: () =>
      ['alice@example.org', 'work@example.net'].map((email) => ({
        email,
        kind: 'imap',
        imap: {
          host: 'imap.example.org',
          port: 993,
          security: 'tls',
          username: email,
          password: 'secret',
        },
      })),
  },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false }));

import { setMailEngineForTests } from '../../src/backends/imap-engine';
import { getMailBackend, resetMailBackendsForTests } from '../../src/backends';
import { bytesToBase64 } from '../../src/backends/imap-mapping';
import {
  ensureInboxWatch,
  handleMailChanged,
  INBOX_CHANGED_EVENT,
  resetInboxWatchForTests,
} from '../../src/backends/imap-watch';

const ALICE = 'alice@example.org';
const WORK = 'work@example.net';

const row = (uid: number, subject: string, flags: string[] = []) => ({
  uid,
  flags,
  header: bytesToBase64(
    new TextEncoder().encode(
      `From: Zoe <zoe@example.net>\r\nSubject: ${subject}\r\nMessage-ID: <m${uid}@example.net>\r\n\r\n`,
    ),
  ),
});

let inbox: Record<string, { uidValidity: number; rows: ReturnType<typeof row>[] }>;
let announced: Array<{ data: Record<string, unknown>; otherAccount: boolean }>;
let heard: string[];
let watched: string[];
// This file runs without a window, so stand in for the one the app listens on.
const target = globalThis as { dispatchEvent?: (event: Event) => boolean };

beforeEach(() => {
  h.active = ALICE;
  inbox = {
    'handle-alice': { uidValidity: 7, rows: [row(11, 'Old news'), row(10, 'Older news')] },
    'handle-work': { uidValidity: 3, rows: [row(5, 'Standup notes')] },
  };
  announced = [];
  heard = [];
  watched = [];
  resetMailBackendsForTests();
  let opened = 0;
  setMailEngineForTests(async (cmd, args = {}) => {
    // Accounts sign in in the order they are first used: Alice, then work.
    if (cmd === 'mail_open') return (opened += 1) === 1 ? 'handle-alice' : 'handle-work';
    if (cmd === 'mail_watch') watched.push(String(args.handle));
    if (cmd === 'imap_folders') return [{ path: 'INBOX', delimiter: '/', selectable: true }];
    if (cmd === 'imap_rows') {
      const box = inbox[String(args.handle)];
      return { total: box.rows.length, uidValidity: box.uidValidity, rows: box.rows };
    }
    return null;
  });
  resetInboxWatchForTests((data, opts) => {
    announced.push({ data, otherAccount: opts.otherAccount });
  });
  target.dispatchEvent = (event: Event) => {
    if (event.type === INBOX_CHANGED_EVENT) heard.push((event as CustomEvent).detail.account);
    return true;
  };
});
afterEach(() => {
  delete target.dispatchEvent;
  setMailEngineForTests(null);
});

describe('watching an IMAP inbox', () => {
  it('asks the engine to watch and does not announce mail that was already there', async () => {
    await ensureInboxWatch(ALICE);

    expect(watched).toEqual(['handle-alice']);
    expect(announced).toEqual([]);
  });

  it('announces what arrived since the last look, oldest first, and tells the app', async () => {
    await ensureInboxWatch(ALICE);
    inbox['handle-alice'].rows = [
      row(13, 'Lease signed'),
      row(12, 'Lunch?'),
      ...inbox['handle-alice'].rows,
    ];

    await handleMailChanged({ handle: 'handle-alice', folder: 'INBOX' });

    expect(heard).toEqual([ALICE]);
    expect(announced.map((a) => (a.data.message as { subject: string }).subject)).toEqual([
      'Lunch?',
      'Lease signed',
    ]);
    expect(announced[0]).toMatchObject({
      otherAccount: false,
      data: { _account: ALICE, mailbox: 'INBOX' },
    });
    // The message is named by the id the list and the reader use.
    expect((announced[0].data.message as { id: string }).id).toMatch(/^imap-7-12-/);
  });

  it('does not announce the same message twice', async () => {
    await ensureInboxWatch(ALICE);
    inbox['handle-alice'].rows = [row(12, 'Lunch?'), ...inbox['handle-alice'].rows];

    await handleMailChanged({ handle: 'handle-alice' });
    // A flag change or a deletion also counts as a change of the inbox.
    await handleMailChanged({ handle: 'handle-alice' });

    expect(announced).toHaveLength(1);
  });

  it('marks mail for an account that is not on screen as such', async () => {
    await ensureInboxWatch(ALICE);
    await ensureInboxWatch(WORK);
    inbox['handle-work'].rows = [row(6, 'Invoice 114'), ...inbox['handle-work'].rows];

    await handleMailChanged({ handle: 'handle-work' });

    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ otherAccount: true, data: { _account: WORK } });
  });

  it('starts counting again when the server renumbers the folder', async () => {
    await ensureInboxWatch(ALICE);
    // UIDVALIDITY changed: every message has a new number, none of them new mail.
    inbox['handle-alice'] = { uidValidity: 8, rows: [row(900, 'Old news')] };

    await handleMailChanged({ handle: 'handle-alice' });

    expect(announced).toEqual([]);
  });

  it('ignores an event for a connection this window did not open', async () => {
    await ensureInboxWatch(ALICE);

    await handleMailChanged({ handle: 'someone-else' });
    await handleMailChanged(null);

    expect(heard).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('does nothing for a Forward Email account', async () => {
    expect(getMailBackend('nobody@example.com')?.kind).not.toBe('imap');
    await ensureInboxWatch('nobody@example.com');
    expect(watched).toEqual([]);
  });
});
