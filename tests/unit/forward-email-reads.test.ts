import { describe, expect, it, vi } from 'vitest';
import { createForwardEmailReads } from '../../src/backends/forward-email-reads';

const API = 'https://api.example.test';
const AUTH = 'Basic YWxpY2VAZXhhbXBsZS5jb206cGFzcw==';

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

function reads(respond: (url: string) => Response | Promise<Response>, apiBase = API) {
  const fetch = vi.fn(async (url: string, _options?: Record<string, unknown>) => respond(url));
  const authHeader = vi.fn(() => AUTH);
  return {
    fetch,
    authHeader,
    reads: createForwardEmailReads({ apiBase: () => apiBase, authHeader, fetch }),
  };
}

const sentHeaders = (fetch: ReturnType<typeof vi.fn>) =>
  (fetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;

describe('listMessages', () => {
  it('asks for the page with the account header and leaves out empty values', async () => {
    const { reads: r, fetch } = reads(() => json([]));

    await r.listMessages({
      folder: 'INBOX',
      page: 2,
      limit: 100,
      since_modseq: undefined,
      search: '',
      raw: false,
    });

    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(`${API}/v1/messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      folder: 'INBOX',
      page: '2',
      limit: '100',
      raw: 'false',
    });
    expect(sentHeaders(fetch).Authorization).toBe(AUTH);
  });

  it('returns the rows and the folder total from the count header', async () => {
    const rows = [
      { id: '66f1a0c2e4b0a1b2c3d4e5f6', subject: 'Invoice 1042', folder: 'INBOX' },
      { id: '66f1a0c2e4b0a1b2c3d4e5f7', subject: 'Re: lunch', folder: 'INBOX' },
    ];
    const { reads: r } = reads(() => json(rows, { headers: { 'X-Item-Count': '4310' } }));

    expect(await r.listMessages({ folder: 'INBOX' })).toEqual({
      rows,
      total: 4310,
      notModified: false,
    });
  });

  it('reads rows from the older wrapped answer shape', async () => {
    const { reads: r } = reads(() => json({ Result: { List: [{ id: 'a' }] } }));

    expect((await r.listMessages({ folder: 'INBOX' })).rows).toEqual([{ id: 'a' }]);
  });

  // An absent header is not a folder with no messages.
  it.each([[undefined], ['']])('has no total when the count header is %j', async (count) => {
    const headers = count === undefined ? {} : { 'X-Item-Count': count };
    const { reads: r } = reads(() => json([{ id: 'a' }], { headers }));

    expect((await r.listMessages({ folder: 'INBOX' })).total).toBeNull();
  });

  // The server answers 204 to since_modseq when nothing changed. That is not
  // an empty folder, and the caller must not clear its cached rows.
  it('tells nothing-changed apart from an empty page', async () => {
    const unchanged = reads(
      () => new Response(null, { status: 204, headers: { 'X-Item-Count': '12' } }),
    );
    const empty = reads(() => json([], { headers: { 'X-Item-Count': '0' } }));

    expect(await unchanged.reads.listMessages({ folder: 'INBOX', since_modseq: 99 })).toEqual({
      rows: [],
      total: 12,
      notModified: true,
    });
    expect(await empty.reads.listMessages({ folder: 'INBOX' })).toEqual({
      rows: [],
      total: 0,
      notModified: false,
    });
  });

  it('fails with the server status and message', async () => {
    const { reads: r } = reads(() => new Response('Rate limit exceeded', { status: 429 }));

    await expect(r.listMessages({ folder: 'INBOX' })).rejects.toMatchObject({
      status: 429,
      message: 'Rate limit exceeded',
    });
  });
});

describe('listFolders', () => {
  it('asks for more than the default page of folders', async () => {
    const { reads: r, fetch } = reads(() => json([]));

    await r.listFolders();

    expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/folders?limit=100`);
  });

  it.each([
    ['a plain list', [{ path: 'INBOX' }, { path: 'Sent Mail' }]],
    ['a wrapped list', { Result: [{ path: 'INBOX' }, { path: 'Sent Mail' }] }],
    ['wrapped items', { Result: { Items: [{ path: 'INBOX' }, { path: 'Sent Mail' }] } }],
  ])('reads folders from %s', async (_name, body) => {
    const { reads: r } = reads(() => json(body));

    expect(await r.listFolders()).toEqual([{ path: 'INBOX' }, { path: 'Sent Mail' }]);
  });
});

describe('getMessage', () => {
  it('asks for the source of a message in its folder', async () => {
    const { reads: r, fetch } = reads(() => json({ id: 'm1', raw: 'Subject: hi\r\n\r\nhello' }));

    const detail = await r.getMessage('m1', { folder: 'Sent Mail', raw: true });

    expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/messages/m1?folder=Sent%20Mail&raw=true`);
    expect(detail).toEqual({ id: 'm1', raw: 'Subject: hi\r\n\r\nhello' });
  });

  it('asks for the message alone when no folder is given', async () => {
    const { reads: r, fetch } = reads(() => json({ id: 'm1' }));

    await r.getMessage('m1');

    expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/messages/m1`);
  });

  it('escapes an id that is not safe in a path', async () => {
    const { reads: r, fetch } = reads(() => json({}));

    await r.getMessage('INBOX/7?x=1');

    expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/messages/INBOX%2F7%3Fx%3D1`);
  });

  // The body pass stops for a 401 and skips one message for a 404, so the
  // status has to reach it.
  it.each([401, 404, 503])('fails with status %i', async (status) => {
    const { reads: r } = reads(() => new Response('', { status, statusText: 'Nope' }));

    await expect(r.getMessage('m1', { raw: true })).rejects.toMatchObject({ status });
  });
});

describe('checkMessage', () => {
  it('asks for the smallest answer', async () => {
    const { reads: r, fetch } = reads(() => json({ id: 'm1', folder: 'Archive' }));

    await r.checkMessage('m1');

    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1/messages/m1');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      raw: 'false',
      nodemailer: 'false',
      attachments: 'false',
    });
  });

  it('finds a message and returns where it is now', async () => {
    const { reads: r } = reads(() => json({ id: 'm1', folder: 'Archive' }));

    expect(await r.checkMessage('m1')).toEqual({
      state: 'found',
      detail: { id: 'm1', folder: 'Archive' },
    });
  });

  it('reports a message the server no longer has', async () => {
    const { reads: r } = reads(() => new Response('Not found', { status: 404 }));

    expect(await r.checkMessage('m1')).toEqual({ state: 'gone' });
  });

  // A refused sign-in or an outage says nothing about the message. Reading
  // either as "gone" would delete cached mail that still exists.
  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [429, 'unknown'],
    [500, 'unknown'],
  ])('does not call a message gone on a %i', async (status, state) => {
    const { reads: r } = reads(() => new Response('', { status }));

    expect(await r.checkMessage('m1')).toEqual({ state });
  });

  it('keeps a message whose answer cannot be read', async () => {
    const { reads: r } = reads(() => new Response('<html>gateway</html>', { status: 200 }));

    expect(await r.checkMessage('m1')).toEqual({ state: 'found', detail: null });
  });
});

describe('credentials and address', () => {
  it('sends nothing when the account has no header', async () => {
    const fetch = vi.fn();
    const r = createForwardEmailReads({
      apiBase: () => API,
      authHeader: () => {
        throw new Error('No credentials for account alice@example.com: account switched');
      },
      fetch,
    });

    await expect(r.listMessages({ folder: 'INBOX' })).rejects.toThrow('No credentials');
    await expect(r.listFolders()).rejects.toThrow('No credentials');
    await expect(r.getMessage('m1')).rejects.toThrow('No credentials');
    await expect(r.checkMessage('m1')).rejects.toThrow('No credentials');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the header again for each request', async () => {
    const { reads: r, authHeader } = reads(() => json([]));

    await r.listFolders();
    await r.listFolders();

    expect(authHeader).toHaveBeenCalledTimes(2);
  });

  it('accepts an API address with a trailing slash', async () => {
    const { reads: r, fetch } = reads(() => json({}), `${API}/`);

    await r.getMessage('m1');

    expect(fetch.mock.calls[0][0]).toBe(`${API}/v1/messages/m1`);
  });
});
