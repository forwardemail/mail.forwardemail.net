/**
 * A cached list page is shown without a request only while the socket has
 * delivered every change since the server sent it. In a shared inbox,
 * getting this wrong shows one person a message as unread after someone else
 * read it, or hides a reply, so each way it stops holding is covered here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createListFreshness,
  FRESH_MAX_AGE_MS,
  LIVE_SILENCE_MS,
  type ListFreshness,
} from '../../src/utils/list-freshness';

const A = 'support@example.com';
const B = 'shaun@example.com';
const PAGE = 'p1|newest|50';
const INBOX = { folder: 'INBOX', key: PAGE, rows: 20, ids: ['665f00aa'] };

describe('list freshness', () => {
  let t: number;
  let socket: Record<string, { authenticated: boolean; lastHeardAt: number }>;
  let f: ListFreshness;

  // The server pings every 30 s; this stands in for one arriving.
  const ping = (account = A) => {
    socket[account].lastHeardAt = t;
  };
  const sync = (view = INBOX, account = A) => {
    const token = f.begin(account);
    f.mark(token, view);
  };

  beforeEach(() => {
    t = 1_000_000;
    socket = {
      [A]: { authenticated: true, lastHeardAt: t },
      [B]: { authenticated: true, lastHeardAt: t },
    };
    f = createListFreshness({ now: () => t });
    f.setProbe((account) => socket[account]);
  });

  it('serves a page synced on a live socket from the cache', () => {
    sync();
    t += 60_000;
    ping();
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(true);
    // Paths are compared without case, as the server and IMAP treat them.
    expect(f.isFresh(A, 'inbox', PAGE, 20)).toBe(true);
  });

  it('asks again after a disconnect, even once reconnected', () => {
    sync();
    f.noteMissed(A);
    ping();
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('asks again after an event was dropped for size or rate', () => {
    sync();
    f.noteMissed(A);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('a disconnect of another account leaves this one alone', () => {
    sync();
    sync(INBOX, B);
    f.noteMissed(B);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(true);
    expect(f.isFresh(B, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('a socket silent past the ping window is not trusted (after a sleep)', () => {
    sync();
    t += LIVE_SILENCE_MS + 1;
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('a page synced while the socket was down is never trusted', () => {
    socket[A].authenticated = false;
    sync();
    socket[A].authenticated = true;
    ping();
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('expires after the freshness window even with a healthy socket', () => {
    sync();
    t += FRESH_MAX_AGE_MS;
    ping();
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('an event naming the folder by path or by server id makes it stale', () => {
    sync();
    f.noteChanged(A, ['INBOX']);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);

    sync();
    f.noteChanged(A, ['665F00AA']);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('an event for another folder leaves this one fresh', () => {
    sync();
    f.noteChanged(A, ['Sent', '665f00bb']);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(true);
  });

  it('a page saved without its folder id is dropped by any id it cannot rule out', () => {
    sync({ ...INBOX, ids: [] });
    f.noteChanged(A, ['665f00aa']);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('an event that names no folder makes the whole account stale', () => {
    sync();
    sync({ ...INBOX, folder: 'Sent', ids: ['665f00bb'] });
    f.noteChanged(A, []);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
    expect(f.isFresh(A, 'Sent', PAGE, 20)).toBe(false);
  });

  it('a response that raced a change to its folder is not marked fresh', () => {
    const token = f.begin(A);
    // Another person reads a message while this request is on its way.
    f.noteChanged(A, ['665f00aa']);
    f.mark(token, INBOX);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('a response that raced a change to another folder still counts', () => {
    const token = f.begin(A);
    f.noteChanged(A, ['Sent', '665f00bb']);
    f.mark(token, INBOX);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(true);
  });

  it('a cache holding fewer rows than the server sent is not trusted', () => {
    sync();
    expect(f.isFresh(A, 'INBOX', PAGE, 19)).toBe(false);
  });

  it('pages are kept per page, sort and page size', () => {
    sync();
    expect(f.isFresh(A, 'INBOX', 'p2|newest|50', 20)).toBe(false);
    expect(f.isFresh(A, 'INBOX', 'p1|oldest|50', 20)).toBe(false);
  });

  it('reset drops everything, and pages begun before it are not marked', () => {
    const token = f.begin(A);
    sync();
    f.reset();
    f.mark(token, INBOX);
    expect(f.isFresh(A, 'INBOX', PAGE, 20)).toBe(false);
  });

  it('holds() follows the same rules for calendar and contact reloads', () => {
    const token = f.begin(A);
    t += 60_000;
    ping();
    expect(f.holds(token, 15 * 60_000)).toBe(true);
    t += 15 * 60_000;
    ping();
    expect(f.holds(token, 15 * 60_000)).toBe(false);

    const next = f.begin(A);
    f.noteMissed(A);
    expect(f.holds(next, 15 * 60_000)).toBe(false);
    expect(f.holds(null, 15 * 60_000)).toBe(false);
  });
});
