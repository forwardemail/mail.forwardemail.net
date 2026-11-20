import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock, authForAccountMock, accountsMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  authForAccountMock: vi.fn(),
  accountsMock: vi.fn(),
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args: unknown[]) => requestMock(...args) },
}));

vi.mock('../../src/utils/auth', () => ({
  getAuthHeaderForAccount: (...args: unknown[]) => authForAccountMock(...args),
}));

vi.mock('../../src/utils/storage', () => ({
  Accounts: { getAll: () => accountsMock() },
  Local: { get: () => null },
}));

import {
  BackendNotReadyError,
  ForwardEmailBackend,
  backendKindForAccount,
  getMailBackend,
  resetMailBackendsForTests,
} from '../../src/backends/index.ts';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const headerFor = (account: string) => `Basic ${account}`;

beforeEach(() => {
  requestMock.mockReset().mockResolvedValue({});
  authForAccountMock.mockReset().mockImplementation(headerFor);
  accountsMock.mockReset().mockReturnValue([{ email: ALICE }, { email: BOB }]);
  resetMailBackendsForTests();
});

describe('ForwardEmailBackend', () => {
  it('sends a flag change as the whole list plus what changed', async () => {
    await new ForwardEmailBackend(ALICE).changeFlags('m1', {
      flags: ['\\Flagged', '\\Seen'],
      add: ['\\Seen'],
    });

    expect(requestMock).toHaveBeenCalledWith(
      'MessageUpdate',
      { flags: ['\\Flagged', '\\Seen'], flags_add: ['\\Seen'] },
      { method: 'PUT', pathOverride: '/v1/messages/m1', authHeader: headerFor(ALICE) },
    );
  });

  // A guessed whole list would replace every flag the message has. A reply
  // sets \Answered on a message whose flags this device may never have loaded.
  it('sends only the change when the message flags are unknown', async () => {
    await new ForwardEmailBackend(ALICE).changeFlags('m1', { flags: null, add: ['\\Answered'] });

    const [, body] = requestMock.mock.calls[0];
    expect(body).toEqual({ flags_add: ['\\Answered'] });
    expect(body).not.toHaveProperty('flags');
  });

  it('sends a label change as the difference from the labels before it', async () => {
    await new ForwardEmailBackend(ALICE).changeLabels('m1', {
      labels: ['work', 'urgent'],
      previous: ['work', 'later'],
    });

    expect(requestMock.mock.calls[0][1]).toEqual({
      labels: ['work', 'urgent'],
      labels_add: ['urgent'],
      labels_remove: ['later'],
    });
  });

  // The server reads a folder in the body as a move. A flag or label change
  // that carried one moved a message back out of the folder another client
  // had put it in.
  it('never names a folder in a flag or label change', async () => {
    const backend = new ForwardEmailBackend(ALICE);
    await backend.changeFlags('m1', { flags: ['\\Seen'], add: ['\\Seen'] });
    await backend.changeLabels('m1', { labels: ['work'], previous: [] });

    for (const [, body] of requestMock.mock.calls) expect(body).not.toHaveProperty('folder');
  });

  it('moves by naming only the destination, and keeps the message id', async () => {
    const remap = await new ForwardEmailBackend(ALICE).moveMessage('m1', 'Archive');

    expect(requestMock.mock.calls[0][1]).toEqual({ folder: 'Archive' });
    expect(remap).toEqual({});
  });

  it('deletes to Trash by default and for good only when asked', async () => {
    const backend = new ForwardEmailBackend(ALICE);
    await backend.deleteMessage('m1');
    await backend.deleteMessage('m1', { permanent: true });

    expect(requestMock.mock.calls[0][2].pathOverride).toBe('/v1/messages/m1');
    expect(requestMock.mock.calls[1][2].pathOverride).toBe('/v1/messages/m1?permanent=1');
    expect(requestMock.mock.calls[1][2].method).toBe('DELETE');
  });

  it('escapes a message id that is not safe in a path', async () => {
    await new ForwardEmailBackend(ALICE).moveMessage('INBOX/7?x=1', 'Archive');

    expect(requestMock.mock.calls[0][2].pathOverride).toBe('/v1/messages/INBOX%2F7%3Fx%3D1');
  });

  // Older cached rows carry a numeric id.
  it('takes a numeric message id', async () => {
    await new ForwardEmailBackend(ALICE).deleteMessage(4217);

    expect(requestMock.mock.calls[0][2].pathOverride).toBe('/v1/messages/4217');
  });

  it("uses its own account's credentials whichever account is active", async () => {
    await new ForwardEmailBackend(BOB).changeFlags('m1', { flags: [], remove: ['\\Seen'] });

    expect(authForAccountMock).toHaveBeenCalledWith(BOB);
    expect(requestMock.mock.calls[0][2].authHeader).toBe(headerFor(BOB));
  });

  // Remote falls back to the active account's credentials when it is given no
  // header, so a request without one would change another account's mailbox.
  it.each([
    ['changeFlags', (b: ForwardEmailBackend) => b.changeFlags('m1', { add: ['\\Seen'] })],
    ['changeLabels', (b: ForwardEmailBackend) => b.changeLabels('m1', { labels: ['a'] })],
    ['moveMessage', (b: ForwardEmailBackend) => b.moveMessage('m1', 'Archive')],
    ['deleteMessage', (b: ForwardEmailBackend) => b.deleteMessage('m1')],
    ['requestMessageList', (b: ForwardEmailBackend) => b.requestMessageList({ folder: 'INBOX' })],
    ['listFolders', (b: ForwardEmailBackend) => b.listFolders()],
    ['getFolder', (b: ForwardEmailBackend) => b.getFolder('f1')],
    ['createFolder', (b: ForwardEmailBackend) => b.createFolder('Clients')],
    ['renameFolder', (b: ForwardEmailBackend) => b.renameFolder('f1', 'Customers')],
    ['deleteFolder', (b: ForwardEmailBackend) => b.deleteFolder('f1')],
  ])('%s sends nothing when its account has no credentials', async (_name, call) => {
    authForAccountMock.mockReturnValue('');
    const backend = new ForwardEmailBackend(ALICE);

    expect(backend.isReady()).toBe(false);
    await expect(call(backend)).rejects.toBeInstanceOf(BackendNotReadyError);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('asks for a page of messages and passes the answer through untouched', async () => {
    const answer = { Result: { List: [{ id: 'm1', subject: 'Invoice 1042' }] } };
    requestMock.mockResolvedValue(answer);
    const signal = new AbortController().signal;

    const res = await new ForwardEmailBackend(ALICE).requestMessageList(
      { folder: 'INBOX', page: 3, limit: 100, lightweight: true },
      { timeout: 60_000, signal, perfLabel: 'search.server' },
    );

    expect(res).toBe(answer);
    expect(requestMock).toHaveBeenCalledWith(
      'MessageList',
      { folder: 'INBOX', page: 3, limit: 100, lightweight: true },
      {
        method: 'GET',
        pathOverride: '/v1/messages',
        timeout: 60_000,
        signal,
        perfLabel: 'search.server',
        authHeader: headerFor(ALICE),
      },
    );
  });

  // An explicit undefined timeout would replace the per-action default.
  it('leaves the default timeout alone when none is given', async () => {
    await new ForwardEmailBackend(ALICE).requestMessageList({ folder: 'INBOX' });

    expect(requestMock.mock.calls[0][2]).toEqual({
      method: 'GET',
      pathOverride: '/v1/messages',
      authHeader: headerFor(ALICE),
    });
  });

  it('lists up to 100 folders, whichever shape the answer has', async () => {
    const folders = [
      { id: 'f1', path: 'INBOX' },
      { id: 'f2', path: 'Clients/Acme' },
    ];
    const backend = new ForwardEmailBackend(ALICE);

    requestMock.mockResolvedValueOnce(folders);
    expect(await backend.listFolders()).toEqual(folders);
    requestMock.mockResolvedValueOnce({ Result: { Items: folders } });
    expect(await backend.listFolders()).toEqual(folders);

    const [action, , options] = requestMock.mock.calls[0];
    expect(action).toBe('Folders');
    expect(options).toMatchObject({
      method: 'GET',
      pathOverride: '/v1/folders?limit=100',
      // A large mailbox takes far longer than the default to list its folders.
      timeout: 120_000,
      authHeader: headerFor(ALICE),
    });
  });

  it('reads one folder by id', async () => {
    requestMock.mockResolvedValue({ id: 'f2', path: 'Clients/Acme', flags: ['$label1'] });

    const folder = await new ForwardEmailBackend(ALICE).getFolder('f2');

    expect(folder.flags).toEqual(['$label1']);
    expect(requestMock.mock.calls[0][2]).toEqual({
      method: 'GET',
      pathOverride: '/v1/folders/f2',
      authHeader: headerFor(ALICE),
    });
  });

  it('creates a folder at a path', async () => {
    await new ForwardEmailBackend(ALICE).createFolder('Clients/Acme');

    expect(requestMock).toHaveBeenCalledWith(
      'FolderCreate',
      { path: 'Clients/Acme' },
      { method: 'POST', pathOverride: '/v1/folders', authHeader: headerFor(ALICE) },
    );
  });

  it('renames a folder by id to its new path', async () => {
    await new ForwardEmailBackend(ALICE).renameFolder('f2', 'Clients/Acme Ltd');

    expect(requestMock).toHaveBeenCalledWith(
      'FolderUpdate',
      { path: 'Clients/Acme Ltd' },
      { method: 'PUT', pathOverride: '/v1/folders/f2', authHeader: headerFor(ALICE) },
    );
  });

  it('deletes a folder by id, escaping one that is a path', async () => {
    await new ForwardEmailBackend(ALICE).deleteFolder('Clients/Acme');

    expect(requestMock).toHaveBeenCalledWith(
      'FolderDelete',
      {},
      {
        method: 'DELETE',
        pathOverride: '/v1/folders/Clients%2FAcme',
        authHeader: headerFor(ALICE),
      },
    );
  });

  it('lets a failed request reach the caller with its status', async () => {
    requestMock.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

    await expect(
      new ForwardEmailBackend(ALICE).moveMessage('gone', 'Archive'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('getMailBackend', () => {
  it('treats an account record with no kind as a Forward Email account', () => {
    expect(backendKindForAccount(ALICE)).toBe('forwardemail');
    expect(getMailBackend(ALICE)?.kind).toBe('forwardemail');
  });

  it('finds the account whatever case its address was typed in', () => {
    accountsMock.mockReturnValue([{ email: 'Carol@Example.com', kind: 'imap' }]);

    expect(backendKindForAccount('carol@example.com')).toBe('imap');
  });

  it('ignores a kind it does not know', () => {
    accountsMock.mockReturnValue([{ email: ALICE, kind: 'gopher' }]);

    expect(backendKindForAccount(ALICE)).toBe('forwardemail');
  });

  // The REST backend would send an IMAP account's changes to the Forward
  // Email API, as that address.
  it('gives no backend, not the REST one, for a kind this build cannot serve', () => {
    accountsMock.mockReturnValue([{ email: ALICE, kind: 'imap' }]);

    expect(getMailBackend(ALICE)).toBeNull();
  });

  it('gives each account its own backend and reuses it', () => {
    const alice = getMailBackend(ALICE);

    expect(getMailBackend(ALICE)).toBe(alice);
    expect(getMailBackend(BOB)).not.toBe(alice);
    expect(getMailBackend(BOB)?.account).toBe(BOB);
  });

  it('still works while the account list cannot be read', () => {
    accountsMock.mockImplementation(() => {
      throw new Error('vault locked');
    });

    expect(getMailBackend(ALICE)?.kind).toBe('forwardemail');
  });
});
