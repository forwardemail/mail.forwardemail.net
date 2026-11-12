/**
 * Compose recipient autocomplete: people from the Sent folder and messages
 * sent from this device, merged with the address book and ranked.
 *
 * The Sent folder is read through the real db-engine (fake-indexeddb), the
 * same code the db worker runs, so the index, reverse order and field picking
 * are exercised for real.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeOperation } from '../../src/utils/db-engine';

const { demoModeMock, isOnlineMock, localGetMock, remoteRequestMock } = vi.hoisted(() => ({
  demoModeMock: vi.fn(),
  isOnlineMock: vi.fn(),
  localGetMock: vi.fn(),
  remoteRequestMock: vi.fn(),
}));

// The db client API the app uses, backed by the real engine.
vi.mock('../../src/utils/db', async () => {
  const { executeOperation: run } = await import('../../src/utils/db-engine');
  const where = (table, index) => {
    const spec = { options: {} };
    const builder = {
      between(lower, upper, includeLower = true, includeUpper = false) {
        spec.where = { op: 'between', lower, upper, includeLower, includeUpper };
        return builder;
      },
      reverse() {
        spec.options.reverse = true;
        return builder;
      },
      limit(n) {
        spec.options.limit = n;
        return builder;
      },
      pickFields(fields) {
        return run({
          action: 'query',
          table,
          payload: { index, where: spec.where, queryMode: 'fields', fields, options: spec.options },
        });
      },
    };
    return builder;
  };
  return {
    db: {
      meta: {
        get: (key) => run({ action: 'get', table: 'meta', payload: { key } }),
        put: (record) => run({ action: 'put', table: 'meta', payload: { record } }),
      },
      messages: {
        where: (index) => where('messages', index),
        bulkPut: (records) => run({ action: 'bulkPut', table: 'messages', payload: { records } }),
        bulkGet: (keys) => run({ action: 'bulkGet', table: 'messages', payload: { keys } }),
      },
    },
  };
});

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (...args) => localGetMock(...args) },
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args) => remoteRequestMock(...args) },
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: (...args) => demoModeMock(...args),
}));

vi.mock('../../src/utils/network-status', () => ({
  isOnline: (...args) => isOnlineMock(...args),
}));

const {
  cacheSentRecipients,
  getContacts,
  getRecentRecipients,
  mergeRecentAddresses,
  mergeRecipientSources,
  parseRecipients,
  searchRecipients,
} = await import('../../src/utils/contact-cache.js');

const ACCOUNT = 'me@example.com';
const STORAGE = { email: ACCOUNT, alias_auth: `${ACCOUNT}:secret` };
const run = (action, table, payload) => executeOperation({ action, table, payload });
let folderSeq = 0;
// Each test reads its own Sent folder, so the short in-memory memo of a
// previous test's scan never answers for this one.
const nextSentFolder = () => `Sent-${++folderSeq}`;

const sent = (folder, id, date, fields) => ({ account: ACCOUNT, id, folder, date, ...fields });

describe('recipient suggestions', () => {
  beforeAll(async () => {
    expect(await run('init')).toEqual({ success: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    localGetMock.mockImplementation((key) => STORAGE[key] ?? null);
    isOnlineMock.mockReturnValue(true);
    demoModeMock.mockReturnValue(false);
    await run('clear', 'messages');
    await run('clear', 'meta');
  });

  describe('parseRecipients', () => {
    it('reads names and addresses from stored address strings', () => {
      expect(
        parseRecipients('Jane Doe <Jane@Example.com>, bob@example.org, "Roe, Rick" <rick@x.io>'),
      ).toEqual([
        { email: 'jane@example.com', name: 'Jane Doe' },
        { email: 'bob@example.org', name: '' },
        { email: 'rick@x.io', name: 'Roe, Rick' },
      ]);
    });

    it('drops values that are not addresses', () => {
      expect(parseRecipients('undisclosed-recipients:;')).toEqual([]);
      expect(parseRecipients('')).toEqual([]);
      expect(parseRecipients(null)).toEqual([]);
      expect(parseRecipients([{ address: 'obj@example.com', name: 'Obj' }])).toEqual([
        { email: 'obj@example.com', name: 'Obj' },
      ]);
    });
  });

  describe('getRecentRecipients', () => {
    it('collects To, Cc and Bcc from the Sent folder, most used first', async () => {
      const folder = nextSentFolder();
      await run('bulkPut', 'messages', {
        records: [
          sent(folder, 'm1', 1000, { to: 'Ann Lee <ann@example.com>', cc: 'cat@example.com' }),
          sent(folder, 'm2', 2000, { to: 'ann@example.com', bcc: 'Dan <dan@example.com>' }),
          sent(folder, 'm3', 3000, { to: 'Ann L. <ann@example.com>' }),
          // Another folder and another account are not Sent mail for this account.
          { account: ACCOUNT, id: 'i1', folder: 'INBOX', date: 4000, to: 'inbox@example.com' },
          { account: 'other@example.com', id: 'o1', folder, date: 5000, to: 'x@example.com' },
        ],
      });

      const recents = await getRecentRecipients({ sentFolder: folder });

      expect(recents.map((r) => r.email)).toEqual([
        'ann@example.com',
        'dan@example.com',
        'cat@example.com',
      ]);
      // The newest name wins.
      expect(recents[0]).toMatchObject({ name: 'Ann L.', count: 3, lastUsed: 3000 });
      expect(recents[1]).toMatchObject({ name: 'Dan', count: 1, lastUsed: 2000 });
      expect(remoteRequestMock).not.toHaveBeenCalled();
    });

    it('fetches Sent from the server into the message cache when nothing is cached', async () => {
      const folder = nextSentFolder();
      remoteRequestMock.mockResolvedValue([
        { id: 'r1', to: [{ address: 'srv@example.com', name: 'Server Person' }], date: 50 },
      ]);

      const recents = await getRecentRecipients({ sentFolder: folder });

      expect(remoteRequestMock).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({ folder, page: 1, limit: 200 }),
        expect.objectContaining({ method: 'GET', pathOverride: '/v1/messages' }),
      );
      expect(recents).toEqual([
        { email: 'srv@example.com', name: 'Server Person', count: 1, lastUsed: 50 },
      ]);
      // Written to the cache, so it works offline and is not fetched again.
      const cached = await run('toArray', 'messages');
      expect(cached).toEqual([
        expect.objectContaining({
          account: ACCOUNT,
          id: 'r1',
          folder,
          to: 'Server Person <srv@example.com>',
        }),
      ]);
    });

    it('caches Sent once per period, pages through it, and keeps rows already cached', async () => {
      const folder = nextSentFolder();
      // The mailbox sync already cached r1 with its own fields.
      await run('bulkPut', 'messages', {
        records: [sent(folder, 'r1', 5, { to: 'kept@example.com', subject: 'from sync' })],
      });
      const page1 = Array.from({ length: 200 }, (_, i) => ({
        id: `p${i}`,
        to: `person${i}@example.com`,
        date: 1000 + i,
      }));
      page1[0] = { id: 'r1', to: 'replaced@example.com', date: 5 };
      remoteRequestMock
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce([{ id: 'last', to: 'last@example.com', date: 9 }]);

      expect(await cacheSentRecipients({ sentFolder: folder })).toBe(200);
      expect(remoteRequestMock).toHaveBeenCalledTimes(2);
      expect(remoteRequestMock.mock.calls[1][1]).toMatchObject({ page: 2 });
      const r1 = await run('get', 'messages', { key: [ACCOUNT, 'r1'] });
      expect(r1).toMatchObject({ to: 'kept@example.com', subject: 'from sync' });

      // Fetched recently: no second request.
      expect(await cacheSentRecipients({ sentFolder: folder })).toBe(0);
      expect(remoteRequestMock).toHaveBeenCalledTimes(2);
      // Sending from this device keeps the fetch time.
      await mergeRecentAddresses(['x@example.com']);
      expect(await cacheSentRecipients({ sentFolder: folder })).toBe(0);
      expect(remoteRequestMock).toHaveBeenCalledTimes(2);
    });

    it('leaves messages moved out of Sent, or being deleted, where they are', async () => {
      const folder = nextSentFolder();
      // Moved to Trash a moment ago; the server still lists it in Sent.
      await run('bulkPut', 'messages', {
        records: [{ account: ACCOUNT, id: 'moved', folder: 'Trash', date: 3, to: 'm@example.com' }],
      });
      remoteRequestMock.mockResolvedValue([
        { id: 'moved', to: 'm@example.com', date: 3 },
        { id: 'deleting', to: 'd@example.com', date: 2 },
        { id: 'new', to: 'n@example.com', date: 1 },
      ]);

      expect(await cacheSentRecipients({ sentFolder: folder, skipIds: ['deleting'] })).toBe(1);

      expect(await run('get', 'messages', { key: [ACCOUNT, 'moved'] })).toMatchObject({
        folder: 'Trash',
      });
      expect(await run('get', 'messages', { key: [ACCOUNT, 'deleting'] })).toBeUndefined();
      expect(await run('get', 'messages', { key: [ACCOUNT, 'new'] })).toMatchObject({ folder });
    });

    it('stops paging at a page with nothing new', async () => {
      const folder = nextSentFolder();
      const page = Array.from({ length: 200 }, (_, i) => ({
        id: `k${i}`,
        to: 'k@example.com',
        date: i,
      }));
      await run('bulkPut', 'messages', {
        records: page.map((m) => ({ account: ACCOUNT, folder, ...m })),
      });
      remoteRequestMock.mockResolvedValue(page);

      expect(await cacheSentRecipients({ sentFolder: folder })).toBe(0);
      expect(remoteRequestMock).toHaveBeenCalledTimes(1);
    });

    it('keeps pages fetched before a failure and waits before trying again', async () => {
      const folder = nextSentFolder();
      const page1 = Array.from({ length: 200 }, (_, i) => ({
        id: `f${i}`,
        to: 'f@example.com',
        date: i,
      }));
      remoteRequestMock.mockResolvedValueOnce(page1).mockRejectedValueOnce(new Error('503'));

      expect(await cacheSentRecipients({ sentFolder: folder })).toBe(200);
      expect(await run('get', 'messages', { key: [ACCOUNT, 'f0'] })).toMatchObject({ folder });

      // Not again on the next folder load.
      expect(await cacheSentRecipients({ sentFolder: folder })).toBe(0);
      expect(remoteRequestMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache demo messages', async () => {
      demoModeMock.mockReturnValue(true);
      const folder = nextSentFolder();
      remoteRequestMock.mockResolvedValue([{ id: 'd1', to: 'demo@example.com', date: 1 }]);

      expect((await getRecentRecipients({ sentFolder: folder })).map((r) => r.email)).toEqual([
        'demo@example.com',
      ]);
      expect(await run('toArray', 'messages')).toEqual([]);
    });

    it('does not call the server while offline', async () => {
      isOnlineMock.mockReturnValue(false);
      expect(await getRecentRecipients({ sentFolder: nextSentFolder() })).toEqual([]);
      expect(remoteRequestMock).not.toHaveBeenCalled();
    });

    it('keeps addresses sent from this device, even with no Sent folder', async () => {
      await mergeRecentAddresses(['Pat <pat@example.com>', 'PAT@example.com', 'bad']);

      const recents = await getRecentRecipients();

      expect(recents).toEqual([
        expect.objectContaining({ email: 'pat@example.com', name: 'Pat', count: 1 }),
      ]);
    });

    it('does not double count a message that is also in Sent', async () => {
      const folder = nextSentFolder();
      await mergeRecentAddresses(['dup@example.com']);
      await run('bulkPut', 'messages', {
        records: [sent(folder, 'm1', 10, { to: 'dup@example.com' })],
      });

      const [entry] = await getRecentRecipients({ sentFolder: folder });

      expect(entry).toMatchObject({ email: 'dup@example.com', count: 1 });
    });

    it('survives a contacts refresh, which replaces the contacts cache', async () => {
      await mergeRecentAddresses(['keep@example.com']);
      remoteRequestMock.mockResolvedValue({ contacts: [] });

      await getContacts({ forceRefresh: true });

      expect((await getRecentRecipients()).map((r) => r.email)).toEqual(['keep@example.com']);
    });
  });

  describe('mergeRecipientSources + searchRecipients', () => {
    const contacts = [
      { email: 'Jane.Doe@Example.com', name: 'Jane Doe', company: 'Acme' },
      { email: 'janet@example.com', name: 'Janet Smith', company: '' },
      { email: 'zed@example.com', name: 'Zed', company: 'Janeway Ltd' },
    ];
    const recents = [
      { email: 'jane.doe@example.com', name: 'J. Doe', count: 2, lastUsed: 20 },
      { email: 'jan@sent-only.io', name: 'Jan Sent', count: 9, lastUsed: 90 },
      { email: 'mojane@example.com', name: '', count: 50, lastUsed: 99 },
    ];
    const entries = mergeRecipientSources(contacts, recents);

    it('merges by address, keeping the contact name and adding usage', () => {
      expect(entries).toHaveLength(5);
      expect(entries.find((e) => e.email === 'Jane.Doe@Example.com')).toMatchObject({
        name: 'Jane Doe',
        company: 'Acme',
        count: 2,
        isContact: true,
      });
      expect(entries.find((e) => e.email === 'jan@sent-only.io')).toMatchObject({
        name: 'Jan Sent',
        isContact: false,
      });
    });

    it('puts word-start matches first, then the most used', () => {
      const emails = searchRecipients(entries, 'jan').map((e) => e.email);
      // mojane@ is used most but only matches mid-word, so it comes last.
      expect(emails).toEqual([
        'jan@sent-only.io',
        'Jane.Doe@Example.com',
        'janet@example.com',
        'zed@example.com',
        'mojane@example.com',
      ]);
    });

    it('matches every word of a name typed with spaces', () => {
      expect(searchRecipients(entries, 'jane do').map((e) => e.email)).toEqual([
        'Jane.Doe@Example.com',
      ]);
      expect(searchRecipients(entries, 'smith janet').map((e) => e.email)).toEqual([
        'janet@example.com',
      ]);
    });

    it('leaves out addresses already added, in any case, and honours limit', () => {
      const emails = searchRecipients(entries, 'jan', {
        exclude: ['JANE.DOE@example.com', 'Jan Sent <jan@sent-only.io>'],
        limit: 2,
      }).map((e) => e.email);
      expect(emails).toEqual(['janet@example.com', 'zed@example.com']);
    });

    it('returns nothing for empty input', () => {
      expect(searchRecipients(entries, '   ')).toEqual([]);
      expect(searchRecipients(entries, ', ;')).toEqual([]);
    });
  });
});
