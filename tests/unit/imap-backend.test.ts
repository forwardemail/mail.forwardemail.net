// The MIME parser needs one set of typed-array classes. jsdom gives the
// test a second set next to Node's, and the parser then misreads its input.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { accountsMock } = vi.hoisted(() => ({ accountsMock: vi.fn() }));

vi.mock('../../src/utils/storage', () => ({
  Accounts: { getAll: () => accountsMock() },
  Local: { get: () => null },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false }));

import { ImapBackend, searchFromQuery } from '../../src/backends/imap';
import {
  closeAllMailAccounts,
  MailEngineError,
  setMailEngineForTests,
} from '../../src/backends/imap-engine';
import { cleanImapSettings, imapSettingsFor } from '../../src/backends/imap-account';
import {
  bytesToBase64,
  folderToRecord,
  headerBytes,
  imapMessageId,
  leanPartOf,
  parseImapMessageId,
  rowToRecord,
} from '../../src/backends/imap-mapping';
import { fromRelayedError, toRelayedError } from '../../src/backends/relay-reads';
import { imapSignInErrorText } from '../../src/backends/imap-errors';
import { normalizeMessageForCache } from '../../src/utils/sync-helpers';

const ALICE = 'alice@example.org';
const SETTINGS = {
  host: 'imap.example.org',
  port: 993,
  security: 'tls',
  username: ALICE,
  password: 'correct horse',
};

const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text));

const HEADER = [
  'Return-Path: <bounce@lists.example.net>',
  'From: =?UTF-8?Q?Zo=C3=AB_M=C3=BCller?= <zoe@example.net>',
  'To: Alice <alice@example.org>, team@example.org',
  'Cc: "Ops, On-call" <ops@example.org>',
  'Subject: =?UTF-8?B?UXVhcnRhbHNiZXJpY2h0IOKAkyBRMw==?=',
  'Date: Tue, 03 Nov 2026 09:14:02 +0100',
  'Message-ID: <q3-report.1042@example.net>',
  'In-Reply-To: <kickoff.77@example.org>',
  'References: <kickoff.77@example.org>',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '',
].join('\r\n');

const FOLDERS = [
  { path: 'INBOX', delimiter: '.', selectable: true, total: 3, unseen: 1, uidValidity: 7 },
  { path: 'INBOX.Clients.Acme', delimiter: '.', selectable: true, total: 0, unseen: 0 },
  { path: 'Trash', delimiter: '.', specialUse: 'trash', selectable: true },
  { path: '[Gmail]', delimiter: '.', selectable: false },
];

let engine: ReturnType<typeof vi.fn>;

beforeEach(() => {
  accountsMock.mockReset().mockReturnValue([{ email: ALICE, kind: 'imap', imap: SETTINGS }]);
  engine = vi.fn(async (cmd: string) => {
    if (cmd === 'mail_open') return 'mail-0-abc';
    if (cmd === 'imap_folders') return FOLDERS;
    return undefined;
  });
  setMailEngineForTests(engine);
});

afterEach(() => setMailEngineForTests(null));

const callsTo = (cmd: string) => engine.mock.calls.filter(([name]) => name === cmd);

describe('message ids', () => {
  it('round-trips a folder name that is not safe in a URL', () => {
    const ref = { uidValidity: 1700000000, uid: 4217, folder: 'Clients/Acme & Søn: 2026?' };
    const id = imapMessageId(ref);

    expect(id).toMatch(/^imap-1700000000-4217-[A-Za-z0-9_-]+$/);
    expect(parseImapMessageId(id)).toEqual(ref);
  });

  it('does not read an id from another kind of account', () => {
    for (const id of [
      '66f1a0c2e4b0a1b2c3d4e5f6',
      4217,
      '',
      null,
      'imap-1-0-SU5CT1g',
      'imap-x-1-a',
    ]) {
      expect(parseImapMessageId(id)).toBeNull();
    }
  });
});

describe('a list row', () => {
  it('becomes a row the list can show, with encoded words decoded', async () => {
    const record = await rowToRecord(
      {
        uid: 12,
        flags: ['\\Seen', '\\Flagged', 'work', '$Forwarded'],
        size: 48211,
        internalDate: '2026-11-03T08:14:09+00:00',
        header: encode(HEADER),
      },
      'INBOX',
      7,
    );
    const row = normalizeMessageForCache(record as never, 'INBOX', ALICE);

    expect(row.id).toBe(imapMessageId({ uidValidity: 7, uid: 12, folder: 'INBOX' }));
    expect(row.subject).toBe('Quartalsbericht – Q3');
    expect(row.from).toContain('Zoë Müller');
    expect(row.from).toContain('zoe@example.net');
    expect(row.is_unread).toBe(false);
    expect(row.is_starred).toBe(true);
    expect(row.has_attachment).toBe(true);
    expect(row.header_message_id).toBe('<q3-report.1042@example.net>');
    expect(row.in_reply_to).toBe('<kickoff.77@example.org>');
    // Arrival time, not the sender's clock.
    expect(row.dateMs).toBe(Date.parse('2026-11-03T08:14:09+00:00'));
    expect(row.labels).toContain('work');
    expect(row.labels).not.toContain('\\Seen');
  });

  it('shows an unread message with no subject or sender header', async () => {
    const record = await rowToRecord(
      { uid: 3, flags: [], header: encode('X-Spam: yes\r\n\r\n') },
      'Junk',
      7,
    );
    const row = normalizeMessageForCache(record as never, 'Junk', ALICE);

    expect(row.is_unread).toBe(true);
    expect(row.has_attachment).toBe(false);
    expect(row.subject).toBe('(No subject)');
  });
});

describe('a message source', () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const bytes = (value: string) => new TextEncoder().encode(value);

  it('is cut after the first blank line, whichever line ending it uses', () => {
    expect(text(headerBytes(bytes('A: 1\r\nB: 2\r\n\r\nbody\r\n\r\nmore')))).toBe(
      'A: 1\r\nB: 2\r\n\r\n',
    );
    expect(text(headerBytes(bytes('A: 1\nB: 2\n\nbody')))).toBe('A: 1\nB: 2\n\n');
  });

  it('is kept whole when it has no body', () => {
    expect(text(headerBytes(bytes('A: 1\r\nB: 2')))).toBe('A: 1\r\nB: 2');
  });
});

describe('folders', () => {
  it('shows a dotted path with slashes and names the folder by its path', () => {
    expect(folderToRecord(FOLDERS[1])).toMatchObject({
      id: 'INBOX/Clients/Acme',
      path: 'INBOX/Clients/Acme',
      name: 'Acme',
    });
    expect(folderToRecord(FOLDERS[2]).specialUse).toBe('\\Trash');
    expect(folderToRecord({ path: 'inbox', selectable: true }).path).toBe('INBOX');
  });

  it('lists only folders that can hold mail', async () => {
    const folders = await new ImapBackend(ALICE).listFolders();

    expect(folders.map((f) => f.path)).toEqual(['INBOX', 'INBOX/Clients/Acme', 'Trash']);
    expect(folders[0]).toMatchObject({ total: 3, unseen_count: 1, uid_validity: 7 });
  });

  it("sends the server's own separator back to it", async () => {
    const backend = new ImapBackend(ALICE);
    await backend.createFolder('INBOX/Clients/Globex');
    await backend.renameFolder('INBOX/Clients/Acme', 'INBOX/Clients/Acme Ltd');

    expect(callsTo('imap_create_folder')[0][1]).toMatchObject({ path: 'INBOX.Clients.Globex' });
    expect(callsTo('imap_rename_folder')[0][1]).toMatchObject({
      from: 'INBOX.Clients.Acme',
      to: 'INBOX.Clients.Acme Ltd',
    });
  });
});

describe('ImapBackend', () => {
  const id = imapMessageId({ uidValidity: 7, uid: 12, folder: 'INBOX/Clients/Acme' });

  it('signs in once and reuses the handle', async () => {
    const backend = new ImapBackend(ALICE);
    await backend.changeFlags(id, { add: ['\\Seen'] });
    await backend.changeFlags(id, { remove: ['\\Flagged'] });

    expect(callsTo('mail_open')).toHaveLength(1);
    expect(callsTo('mail_open')[0][1]).toEqual({ imap: SETTINGS });
    expect(callsTo('imap_store_many')[0][1]).toEqual({
      handle: 'mail-0-abc',
      folder: 'INBOX.Clients.Acme',
      uids: [12],
      add: ['\\Seen'],
      remove: [],
    });
  });

  it('signs in again when the engine has forgotten the handle', async () => {
    let opens = 0;
    engine.mockImplementation(async (cmd: string, args: { handle?: string }) => {
      if (cmd === 'mail_open') return `mail-${++opens}`;
      if (cmd === 'imap_folders') return FOLDERS;
      if (args.handle === 'mail-1') throw { kind: 'handle', message: 'not connected' };
      return undefined;
    });

    await new ImapBackend(ALICE).changeFlags(id, { add: ['\\Seen'] });

    expect(opens).toBe(2);
    expect(callsTo('imap_store_many').at(-1)?.[1]).toMatchObject({ handle: 'mail-2' });
  });

  // App Lock seals the saved password; the engine's copy has to go as well.
  it('signs every account out of the engine when asked, and in again on the next use', async () => {
    const backend = new ImapBackend(ALICE);
    await backend.listFolders();

    await closeAllMailAccounts();

    expect(callsTo('mail_close').map(([, args]) => args)).toEqual([{ handle: 'mail-0-abc' }]);
    await backend.listFolders();
    expect(callsTo('mail_open')).toHaveLength(2);
  });

  it('applies a label change as the keywords added and removed', async () => {
    await new ImapBackend(ALICE).changeLabels(id, {
      labels: ['work', 'urgent'],
      previous: ['work', 'later'],
    });

    expect(callsTo('imap_store_many')[0][1]).toMatchObject({ add: ['urgent'], remove: ['later'] });
  });

  it('deletes by moving to Trash, and removes for good from Trash or when asked', async () => {
    const backend = new ImapBackend(ALICE);
    const inTrash = imapMessageId({ uidValidity: 9, uid: 5, folder: 'Trash' });

    await backend.deleteMessage(id);
    await backend.deleteMessage(inTrash);
    await backend.deleteMessage(id, { permanent: true });

    expect(callsTo('imap_move_many')).toHaveLength(1);
    expect(callsTo('imap_move_many')[0][1]).toMatchObject({ uids: [12], destination: 'Trash' });
    expect(callsTo('imap_delete_many').map(([, args]) => args.folder)).toEqual([
      'Trash',
      'INBOX.Clients.Acme',
    ]);
  });

  // The server lists a folder by arrival and nothing else, so a filter or a
  // search is two requests: which messages match, then their rows.
  it('answers a filtered list with a search and the rows of that page', async () => {
    engine.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_search') return { uidValidity: 7, uids: [40, 31, 12, 9, 4] };
      if (cmd === 'imap_rows_for') {
        return {
          total: 3,
          uidValidity: 7,
          rows: (args.uids as number[]).map((uid) => ({ uid, flags: [], header: encode(HEADER) })),
        };
      }
      return undefined;
    });
    const backend = new ImapBackend(ALICE);

    const page = await backend.listMessages({
      folder: 'INBOX/Clients/Acme',
      is_unread: true,
      search: ' invoice ',
      since: '2026-03-09T00:00:00.000Z',
      page: 2,
      limit: 2,
    });

    expect(callsTo('imap_search')[0][1]).toMatchObject({
      folder: 'INBOX.Clients.Acme',
      query: { text: 'invoice', unseen: true, since: '2026-03-09' },
    });
    // The second page of two: the third and fourth matches.
    expect(callsTo('imap_rows_for')[0][1]).toMatchObject({
      folder: 'INBOX.Clients.Acme',
      uids: [12, 9],
    });
    expect(page.total).toBe(5);
    expect(page.rows.map((row) => row.uid)).toEqual([12, 9]);
    expect(page.rows[0].folder).toBe('INBOX/Clients/Acme');
    // A plain list was never asked for.
    expect(callsTo('imap_rows')).toHaveLength(0);
  });

  it('does not fetch rows when nothing matches', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_search') return { uidValidity: 7, uids: [] };
      return undefined;
    });

    const page = await new ImapBackend(ALICE).listMessages({ folder: 'INBOX', from: 'nobody' });

    expect(page).toEqual({ rows: [], total: 0, notModified: false });
    expect(callsTo('imap_rows_for')).toHaveLength(0);
  });

  it('searches every folder but Trash when no folder is named', async () => {
    engine.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_search') {
        return { uidValidity: 7, uids: args.folder === 'INBOX' ? [5] : [8] };
      }
      if (cmd === 'imap_rows_for') {
        return {
          total: 1,
          uidValidity: 7,
          rows: (args.uids as number[]).map((uid) => ({ uid, flags: [], header: encode(HEADER) })),
        };
      }
      return undefined;
    });

    const rows = await new ImapBackend(ALICE).requestMessageList({ search: 'lease', limit: 20 });

    expect(callsTo('imap_search').map(([, args]) => args.folder)).toEqual([
      'INBOX',
      'INBOX.Clients.Acme',
    ]);
    expect(rows.map((row: { folder: string }) => row.folder)).toEqual([
      'INBOX',
      'INBOX/Clients/Acme',
    ]);
  });

  it('reads the filters out of a list query, and nothing out of a plain one', () => {
    expect(searchFromQuery({ folder: 'INBOX', page: 1, limit: 50, sort: '-date' })).toBeNull();
    expect(searchFromQuery({ search: '   ' })).toBeNull();
    expect(
      searchFromQuery({
        subject: 'lease',
        to: 'bob@example.org',
        is_flagged: true,
        has_attachments: true,
        before: 'not a date',
      }),
    ).toEqual({ subject: 'lease', to: 'bob@example.org', flagged: true, hasAttachment: true });
  });

  // The id names the folder and the message's number in it, so both change.
  it('answers a move with the id the message has in its new folder', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_move_many') return [{ uid: 12, located: { uidValidity: 91, uid: 3 } }];
      return undefined;
    });

    const remap = await new ImapBackend(ALICE).moveMessage(id, 'inbox');

    expect(callsTo('imap_move_many')[0][1]).toMatchObject({
      folder: 'INBOX.Clients.Acme',
      uids: [12],
      destination: 'INBOX',
    });
    expect(remap).toEqual({
      [id]: imapMessageId({ uidValidity: 91, uid: 3, folder: 'INBOX' }),
    });
  });

  it('answers a move with nothing when the server could not say where it went', async () => {
    expect(await new ImapBackend(ALICE).moveMessage(id, 'INBOX')).toEqual({});
  });

  it('answers a delete to Trash like the move it is', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_move_many') return [{ uid: 12, located: { uidValidity: 5, uid: 61 } }];
      return undefined;
    });
    const backend = new ImapBackend(ALICE);

    expect(await backend.deleteMessage(id)).toEqual({
      [id]: imapMessageId({ uidValidity: 5, uid: 61, folder: 'Trash' }),
    });
    expect(await backend.deleteMessage(id, { permanent: true })).toEqual({});
  });

  it('saves a draft before removing the copy it replaces', async () => {
    const order: string[] = [];
    engine.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') {
        return [...FOLDERS, { path: 'INBOX.Drafts', delimiter: '.', selectable: true }];
      }
      if (cmd === 'imap_append') return { uidValidity: 33, uid: 9 };
      return undefined;
    });
    const previous = imapMessageId({ uidValidity: 33, uid: 8, folder: 'INBOX/Drafts' });
    const raw = new TextEncoder().encode('Subject: Lunch\r\n\r\nNoon?\r\n');

    const saved = await new ImapBackend(ALICE).saveDraft(raw, { previousId: previous });

    expect(saved).toBe(imapMessageId({ uidValidity: 33, uid: 9, folder: 'INBOX/Drafts' }));
    expect(callsTo('imap_append')[0][1]).toMatchObject({
      folder: 'INBOX.Drafts',
      flags: ['\\Draft', '\\Seen'],
      message: bytesToBase64(raw),
    });
    expect(callsTo('imap_delete')[0][1]).toMatchObject({ folder: 'INBOX.Drafts', uid: 8 });
    expect(order.indexOf('imap_append')).toBeLessThan(order.indexOf('imap_delete'));
  });

  it('keeps the earlier draft when saving the new one fails', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') {
        return [
          ...FOLDERS,
          { path: 'Drafts', delimiter: '.', specialUse: 'drafts', selectable: true },
        ];
      }
      if (cmd === 'imap_append') throw new MailEngineError('network', 'Could not connect');
      return undefined;
    });
    const previous = imapMessageId({ uidValidity: 33, uid: 8, folder: 'Drafts' });

    await expect(
      new ImapBackend(ALICE).saveDraft(new Uint8Array([1]), { previousId: previous }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(callsTo('imap_delete')).toHaveLength(0);
  });

  it('fetches one attachment and decodes it from how the server holds it', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      // base64 as servers send it: wrapped lines
      if (cmd === 'imap_part') return new TextEncoder().encode('eWVhcix0\r\nb3RhbA==\r\n').buffer;
      return undefined;
    });

    const bytes = await new ImapBackend(ALICE).getPart(id, '2', 'base64');

    expect(callsTo('imap_part')[0][1]).toMatchObject({
      folder: 'INBOX.Clients.Acme',
      uid: 12,
      section: '2',
    });
    expect(new TextDecoder().decode(bytes)).toBe('year,total');
  });

  it('answers a request for the parsed message with the body and every attachment', async () => {
    const source = [
      'From: Zoe <zoe@example.net>',
      'To: alice@example.org',
      'Subject: Lease',
      'Message-ID: <lease.1@example.net>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Signed copy attached.',
      '--b1',
      'Content-Type: application/pdf; name="lease.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="lease.pdf"',
      '',
      'JVBERi0xLjQ=',
      '--b1--',
      '',
    ].join('\r\n');
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_raw') return new TextEncoder().encode(source).buffer;
      if (cmd === 'imap_row') return { uid: 12, flags: ['\\Seen'], header: encode(source) };
      return undefined;
    });
    const backend = new ImapBackend(ALICE);

    const detail = await backend.requestMessage(id, { raw: false });

    // The whole message: a forward needs the file, not a stand-in for it.
    expect(callsTo('imap_message')).toHaveLength(0);
    expect(detail.nodemailer.text.trim()).toBe('Signed copy attached.');
    expect(detail.nodemailer.attachments).toHaveLength(1);
    expect(detail.nodemailer.attachments[0]).toMatchObject({
      filename: 'lease.pdf',
      contentType: 'application/pdf',
    });
    expect(new TextDecoder().decode(detail.nodemailer.attachments[0].content)).toBe('%PDF-1.4');
    expect(detail.flags).toEqual(['\\Seen']);

    // The source on its own, for "view original" and the .eml download.
    expect(await backend.requestMessage(id, { raw: true, responseAs: 'text' })).toBe(source);
  });

  it('lists a page with the folder total', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_rows') {
        return { total: 3, uidValidity: 7, rows: [{ uid: 12, flags: [], header: encode(HEADER) }] };
      }
      return undefined;
    });

    const page = await new ImapBackend(ALICE).listMessages({ folder: 'INBOX', page: 2, limit: 50 });

    expect(callsTo('imap_rows')[0][1]).toMatchObject({ folder: 'INBOX', page: 2, limit: 50 });
    expect(page.total).toBe(3);
    expect(page.notModified).toBe(false);
    expect(page.rows[0].id).toBe(imapMessageId({ uidValidity: 7, uid: 12, folder: 'INBOX' }));
  });

  it('returns a message source with the metadata the reader needs', async () => {
    const source = `${HEADER.trimEnd()}\r\n\r\nGrüße aus Köln\r\n`;
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_message') return new TextEncoder().encode(source).buffer;
      return undefined;
    });

    const detail = await new ImapBackend(ALICE).getMessage(id);

    expect(detail.raw).toBe(source);
    expect(detail.nodemailer.headers['message-id']).toBe('<q3-report.1042@example.net>');
    expect(detail.nodemailer.from.value[0]).toEqual({
      name: 'Zoë Müller',
      address: 'zoe@example.net',
    });
  });

  it('tells a message that is gone from one it could not check', async () => {
    const backend = new ImapBackend(ALICE);
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_row') return null;
      return undefined;
    });
    expect(await backend.checkMessage(id)).toEqual({ state: 'gone' });

    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_row') throw { kind: 'auth', message: 'LOGIN failed' };
      return FOLDERS;
    });
    expect(await backend.checkMessage(id)).toEqual({ state: 'rejected' });
    // A Forward Email id says nothing about this server.
    expect(await backend.checkMessage('66f1a0c2e4b0a1b2c3d4e5f6')).toEqual({ state: 'unknown' });
  });

  it('is not ready, and sends nothing, once the account has no saved settings', async () => {
    accountsMock.mockReturnValue([{ email: ALICE }]);
    const backend = new ImapBackend(ALICE);

    expect(backend.isReady()).toBe(false);
    await expect(backend.changeFlags(id, { add: ['\\Seen'] })).rejects.toMatchObject({
      code: 'BACKEND_NOT_READY',
    });
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('an attachment left on the server', () => {
  // What the mail engine writes in place of a part it did not download.
  const marker = 'fe-part-not-downloaded 2.1 8123456 base64';

  it('is recognised by its marker, as text or as decoded bytes', () => {
    const expected = { section: '2.1', size: 8123456, encoding: 'base64' };
    expect(leanPartOf(marker)).toEqual(expected);
    expect(leanPartOf(new TextEncoder().encode(`${marker}\r\n`))).toEqual(expected);
    expect(leanPartOf(new TextEncoder().encode(marker).buffer)).toEqual(expected);
  });

  it('is not seen in a real attachment', () => {
    expect(leanPartOf(new TextEncoder().encode('%PDF-1.4 real file content'))).toBeNull();
    expect(leanPartOf(`${marker} and then some more text`)).toBeNull();
    // Only a section number: nothing else may be asked of the server.
    expect(leanPartOf('fe-part-not-downloaded HEADER 10 base64')).toBeNull();
    expect(leanPartOf(new Uint8Array(5_000_000))).toBeNull();
    expect(leanPartOf(undefined)).toBeNull();
  });
});

describe('saved settings', () => {
  it('are read only from an account marked as IMAP', () => {
    expect(imapSettingsFor(ALICE)).toEqual(SETTINGS);
    accountsMock.mockReturnValue([{ email: ALICE, imap: SETTINGS }]);
    expect(imapSettingsFor(ALICE)).toBeNull();
  });

  it.each([
    ['no host', { ...SETTINGS, host: '  ' }],
    ['no password', { ...SETTINGS, password: '' }],
    ['a port out of range', { ...SETTINGS, port: 70000 }],
    ['no encryption', { ...SETTINGS, security: 'none' }],
  ])('are refused with %s', (_name, input) => {
    expect(cleanImapSettings(input)).toBeNull();
  });
});

describe('errors', () => {
  it('keep their status and kind across the worker boundary', () => {
    const sent = toRelayedError(
      Object.assign(new Error('LOGIN failed'), { status: 401, kind: 'auth' }),
    );
    const received = fromRelayedError(JSON.parse(JSON.stringify(sent)));

    expect(received).toBeInstanceOf(Error);
    expect(received).toMatchObject({ message: 'LOGIN failed', status: 401, kind: 'auth' });
  });

  it('are explained in plain words at sign-in', () => {
    expect(imapSignInErrorText({ kind: 'auth', message: 'AUTHENTICATIONFAILED' })).toMatch(
      /did not accept.*AUTHENTICATIONFAILED/,
    );
    expect(imapSignInErrorText({ kind: 'local', message: 'x' })).toMatch(/own network/);
    expect(imapSignInErrorText(new Error('boom'))).toBe('boom');
  });
});

// A selection is changed one message at a time by the store, all asked for at
// once. One command per message made a few dozen messages take most of a
// minute on a connection that runs one command at a time.
describe('changes asked for together', () => {
  const inAcme = (uid: number) =>
    imapMessageId({ uidValidity: 7, uid, folder: 'INBOX/Clients/Acme' });
  const inInbox = (uid: number) => imapMessageId({ uidValidity: 7, uid, folder: 'INBOX' });

  it('move as one command, and each message gets its own new id', async () => {
    engine.mockImplementation(async (cmd: string, args: { uids?: number[] }) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_move_many') {
        // 14 could not be found again (no Message-ID): no new id for it.
        return (args.uids || []).map((uid) => ({
          uid,
          located: uid === 14 ? null : { uidValidity: 9, uid: uid + 100 },
        }));
      }
      return undefined;
    });
    const backend = new ImapBackend(ALICE);

    const remaps = await Promise.all(
      [12, 13, 14].map((uid) => backend.moveMessage(inAcme(uid), 'Trash')),
    );

    expect(callsTo('imap_move_many')).toHaveLength(1);
    expect(callsTo('imap_move_many')[0][1]).toMatchObject({
      folder: 'INBOX.Clients.Acme',
      uids: [12, 13, 14],
      destination: 'Trash',
    });
    expect(remaps).toEqual([
      { [inAcme(12)]: imapMessageId({ uidValidity: 9, uid: 112, folder: 'Trash' }) },
      { [inAcme(13)]: imapMessageId({ uidValidity: 9, uid: 113, folder: 'Trash' }) },
      {},
    ]);
  });

  it('are kept apart by folder and by what is changed', async () => {
    const backend = new ImapBackend(ALICE);
    await Promise.all([
      backend.changeFlags(inAcme(12), { add: ['\\Seen'] }),
      backend.changeFlags(inAcme(13), { add: ['\\Seen'] }),
      backend.changeFlags(inInbox(4), { add: ['\\Seen'] }),
      backend.changeFlags(inAcme(14), { add: ['\\Flagged'] }),
      backend.moveMessage(inAcme(15), 'INBOX'),
      backend.moveMessage(inAcme(16), 'Trash'),
    ]);

    expect(callsTo('imap_store_many').map(([, a]) => [a.folder, a.uids, a.add])).toEqual([
      ['INBOX.Clients.Acme', [12, 13], ['\\Seen']],
      ['INBOX', [4], ['\\Seen']],
      ['INBOX.Clients.Acme', [14], ['\\Flagged']],
    ]);
    expect(callsTo('imap_move_many').map(([, a]) => [a.uids, a.destination])).toEqual([
      [[15], 'INBOX'],
      [[16], 'Trash'],
    ]);
  });

  it('delete as one command: to Trash, or for good from Trash', async () => {
    const backend = new ImapBackend(ALICE);
    const inTrash = (uid: number) => imapMessageId({ uidValidity: 9, uid, folder: 'Trash' });

    await Promise.all([
      backend.deleteMessage(inAcme(12)),
      backend.deleteMessage(inAcme(13)),
      backend.deleteMessage(inTrash(5)),
      backend.deleteMessage(inTrash(6)),
    ]);

    expect(callsTo('imap_move_many').map(([, a]) => [a.uids, a.destination])).toEqual([
      [[12, 13], 'Trash'],
    ]);
    expect(callsTo('imap_delete_many').map(([, a]) => [a.folder, a.uids])).toEqual([
      ['Trash', [5, 6]],
    ]);
  });

  it('that arrive while one is on the wire join the next command, not one each', async () => {
    let release: () => void = () => {};
    const firstOnTheWire = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stores = 0;
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_store_many' && (stores += 1) === 1) await firstOnTheWire;
      return undefined;
    });
    const backend = new ImapBackend(ALICE);

    const first = backend.changeFlags(inAcme(1), { add: ['\\Seen'] });
    await vi.waitFor(() => expect(stores).toBe(1));
    // The app reads its database between these, so they arrive a moment apart.
    const later = [2, 3, 4].map(async (uid) => {
      await new Promise((resolve) => setTimeout(resolve, uid));
      return backend.changeFlags(inAcme(uid), { add: ['\\Seen'] });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([first, ...later]);

    expect(callsTo('imap_store_many').map(([, a]) => a.uids)).toEqual([[1], [2, 3, 4]]);
  });

  it('fail together, so every one of them is queued to try again', async () => {
    engine.mockImplementation(async (cmd: string) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_move_many') throw { kind: 'network', message: 'Could not connect' };
      return undefined;
    });
    const backend = new ImapBackend(ALICE);

    const results = await Promise.allSettled(
      [12, 13].map((uid) => backend.moveMessage(inAcme(uid), 'Trash')),
    );

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ kind: 'network' });
    // A later change is not held up by the failure.
    await backend.changeFlags(inAcme(12), { add: ['\\Seen'] });
    expect(callsTo('imap_store_many')).toHaveLength(1);
  });

  it('are split when a selection is larger than one command may name', async () => {
    const backend = new ImapBackend(ALICE);
    const uids = Array.from({ length: 450 }, (_, i) => i + 1);

    await Promise.all(uids.map((uid) => backend.changeFlags(inAcme(uid), { add: ['\\Seen'] })));

    const sizes = callsTo('imap_store_many').map(([, a]) => (a.uids as number[]).length);
    expect(sizes).toEqual([200, 200, 50]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(250);
  });

  it('refuse an id from another server without sending anything', async () => {
    await expect(
      new ImapBackend(ALICE).moveMessage('65f0c1d2e3a4b5c6d7e8f901', 'Trash'),
    ).rejects.toMatchObject({ kind: 'missing' });
    expect(callsTo('imap_move_many')).toEqual([]);
  });
});

// The sync pass keeps where it read a folder up to and asks only for what
// changed after. Before, every pass read the newest page again, headers and
// all, and a flag changed further down the folder was never seen.
describe('asking a folder only for what changed', () => {
  const rowsFor = (args: Record<string, unknown>) => ({
    total: 900,
    uidValidity: 7,
    rows: (args.uids as number[]).map((uid) => ({
      uid,
      flags: ['\\Seen'],
      header: encode(HEADER),
    })),
  });
  const serve = (changes: unknown) =>
    engine.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'mail_open') return 'h';
      if (cmd === 'imap_folders') return FOLDERS;
      if (cmd === 'imap_changes') return typeof changes === 'function' ? changes() : changes;
      if (cmd === 'imap_rows_for') return rowsFor(args);
      if (cmd === 'imap_rows') {
        return {
          total: 900,
          uidValidity: 7,
          highestModseq: '90060115205545361',
          rows: [{ uid: 900, flags: [], header: encode(HEADER) }],
        };
      }
      return undefined;
    });

  it('stamps a listed page with where the folder had changed up to', async () => {
    serve(null);
    const page = await new ImapBackend(ALICE).listMessages({ folder: 'INBOX', page: 1 });
    // Kept as text: the counter is larger than a number holds exactly.
    expect(page.rows[0].modseq).toBe('7:90060115205545361');
    expect(callsTo('imap_changes')).toEqual([]);
  });

  it('answers with no rows, and reads none, when nothing changed', async () => {
    serve({ uidValidity: 7, highestModseq: '400', uids: [] });
    const page = await new ImapBackend(ALICE).listMessages({
      folder: 'INBOX/Clients/Acme',
      since_modseq: '7:400',
      page: 1,
      limit: 50,
    });

    expect(page).toMatchObject({ rows: [], notModified: true });
    expect(callsTo('imap_changes')[0][1]).toMatchObject({
      folder: 'INBOX.Clients.Acme',
      since: '400',
    });
    expect(callsTo('imap_rows')).toEqual([]);
    expect(callsTo('imap_rows_for')).toEqual([]);
  });

  it('reads only the changed messages, wherever they are in the folder', async () => {
    serve({ uidValidity: 7, highestModseq: '412', uids: [900, 31, 4] });
    const page = await new ImapBackend(ALICE).listMessages({
      folder: 'INBOX',
      since_modseq: '7:400',
      page: 1,
      limit: 50,
    });

    expect(callsTo('imap_rows_for')[0][1]).toMatchObject({ folder: 'INBOX', uids: [900, 31, 4] });
    expect(page.rows.map((row) => [row.uid, row.modseq])).toEqual([
      [900, '7:412'],
      [31, '7:412'],
      [4, '7:412'],
    ]);
    expect(page.notModified).toBe(false);
    expect(callsTo('imap_rows')).toEqual([]);
  });

  it('cuts later pages from the list the first page read', async () => {
    let reads = 0;
    // A message changes between the two pages: read again, the list would
    // have one more at the top and uid 2 would fall off the end of page 2.
    serve(() => {
      reads += 1;
      return {
        uidValidity: 7,
        highestModseq: '412',
        uids: reads === 1 ? [5, 4, 3, 2] : [9, 5, 4, 3, 2],
      };
    });
    const backend = new ImapBackend(ALICE);
    const query = { folder: 'INBOX', since_modseq: '7:400', limit: 2 };

    const first = await backend.listMessages({ ...query, page: 1 });
    const second = await backend.listMessages({ ...query, page: 2 });
    const third = await backend.listMessages({ ...query, page: 3 });

    expect(first.rows.map((row) => row.uid)).toEqual([5, 4]);
    expect(second.rows.map((row) => row.uid)).toEqual([3, 2]);
    expect(third.rows).toEqual([]);
    expect(reads).toBe(1);
  });

  it('lists the folder as before on a server that does not count changes', async () => {
    serve(null);
    const page = await new ImapBackend(ALICE).listMessages({
      folder: 'INBOX',
      since_modseq: '7:400',
      page: 1,
    });
    expect(callsTo('imap_rows')).toHaveLength(1);
    expect(page.rows.map((row) => row.uid)).toEqual([900]);
  });

  it('lists the folder again when it was rebuilt since the token was kept', async () => {
    // UIDVALIDITY was 6 when the token was saved: its counter means nothing now.
    serve({ uidValidity: 7, highestModseq: '3', uids: [] });
    const page = await new ImapBackend(ALICE).listMessages({
      folder: 'INBOX',
      since_modseq: '6:400',
      page: 1,
    });
    expect(callsTo('imap_rows')).toHaveLength(1);
    expect(page.rows[0].modseq).toBe('7:90060115205545361');
  });

  it('does not take a Forward Email MODSEQ for a folder token', async () => {
    serve({ uidValidity: 7, highestModseq: '412', uids: [4] });
    await new ImapBackend(ALICE).listMessages({ folder: 'INBOX', since_modseq: 400, page: 1 });
    expect(callsTo('imap_changes')).toEqual([]);
    expect(callsTo('imap_rows')).toHaveLength(1);
  });
});
