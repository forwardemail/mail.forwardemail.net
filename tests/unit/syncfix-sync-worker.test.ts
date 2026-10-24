/**
 * Sync worker fixes, driven through the worker's message interface with an
 * in-memory database behind the db port and a fake /v1 API.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cachedBodyStatus } from '../../src/workers/sync-pure.ts';

// openpgp does not load under jsdom. These stand-ins decrypt anything once a
// key is unlocked, which is all the PGP badge test needs.
vi.mock('openpgp', () => ({
  readPrivateKey: async () => ({ isDecrypted: () => true, getFingerprint: () => 'fp' }),
  readMessage: async () => ({}),
  decrypt: async () => ({
    data: 'Subject: Launch codes\nContent-Type: text/plain\n\nThe real body\n',
    signatures: [{}],
  }),
}));

type Row = Record<string, unknown>;
const tables = new Map<string, Map<string, Row>>();
const table = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name) as Map<string, Row>;
};
const keyOf = (key: unknown) => JSON.stringify(key);
const rowKey = (name: string, row: Row) => {
  if (name === 'meta') return keyOf(row.key);
  if (name === 'syncManifests') return keyOf([row.account, row.folder]);
  if (name === 'folders') return keyOf([row.account, row.path]);
  return keyOf([row.account, row.id]);
};
const matches = (row: Row, index: string, value: unknown) => {
  if (index.startsWith('[')) {
    const fields = index.slice(1, -1).split('+');
    return fields.every((f, i) => row[f] === (value as unknown[])[i]);
  }
  return row[index] === value;
};

// Hook a test can set to change the database while a request is in flight.
let onDbAction: ((action: string, name: string, payload: Row) => void) | null = null;
// A request this returns true for is never answered, as when the database is
// busy with a long job for another tab or worker.
let dbStalls: ((action: string, name: string) => boolean) | null = null;

function answer(action: string, name: string, payload: Row) {
  onDbAction?.(action, name, payload);
  const t = table(name);
  switch (action) {
    case 'get':
      return t.get(keyOf(payload.key));
    case 'put':
      t.set(rowKey(name, payload.record as Row), payload.record as Row);
      return undefined;
    case 'bulkGet':
      return (payload.keys as unknown[]).map((key) => t.get(keyOf(key)));
    case 'bulkPut':
      for (const row of payload.records as Row[]) t.set(rowKey(name, row), row);
      return undefined;
    case 'bulkDelete':
      for (const key of payload.keys as unknown[]) t.delete(keyOf(key));
      return undefined;
    case 'update': {
      const existing = t.get(keyOf(payload.key));
      if (!existing) return 0;
      t.set(keyOf(payload.key), { ...existing, ...(payload.changes as Row) });
      return 1;
    }
    case 'queryEquals':
      return [...t.values()].filter((row) => matches(row, payload.index as string, payload.value));
    case 'query': {
      const where = payload.where as Row;
      if (payload.index === 'account' && payload.queryMode === 'summaries') {
        // sizes of a page of stored rows (the phone's oversized body prune)
        const options = (payload.options || {}) as { offset?: number; limit?: number };
        const rows = [...t.values()].filter((r) => r.account === where.value);
        const page = rows.slice(
          options.offset || 0,
          (options.offset || 0) + (options.limit || 1e9),
        );
        return page.map((r) => ({
          account: r.account,
          id: r.id,
          approxBytes: JSON.stringify(r).length,
        }));
      }
      // count on [account+folder], primary keys oldest first on
      // [account+folder+date]: what the phone history trim asks for
      const [account, folder] = (where.value || where.lower) as unknown[];
      const rows = [...t.values()].filter((r) => r.account === account && r.folder === folder);
      if (payload.queryMode === 'count') return rows.length;
      const byDate = (a: Row, b: Row) =>
        Number(new Date(a.date as string | number)) - Number(new Date(b.date as string | number));
      if (payload.queryMode === 'primaryKeys') {
        return rows
          .filter((r) => r.date != null)
          .sort(byDate)
          .map((r) => [r.account, r.id]);
      }
      if (payload.queryMode === 'toArray') {
        // newest first from [account+folder+date]: the bodies pass's sample
        const options = (payload.options || {}) as { reverse?: boolean; limit?: number };
        const sorted = rows.filter((r) => r.date != null).sort(byDate);
        if (options.reverse) sorted.reverse();
        return options.limit ? sorted.slice(0, options.limit) : sorted;
      }
      return undefined;
    }
    case 'bodyStatuses':
      return (payload.keys as unknown[]).map((key) => cachedBodyStatus(t.get(keyOf(key))));
    case 'queryEqualsModify': {
      let n = 0;
      for (const [k, row] of t) {
        if (!matches(row, payload.index as string, payload.value)) continue;
        t.set(k, { ...row, ...(payload.changes as Row) });
        n += 1;
      }
      return n;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fake API
// ---------------------------------------------------------------------------

const ACCOUNT = 'me@x.test';
const oid = (n: number) => `64b7f0c2e4b0a1a2b3${String(n).padStart(6, '0')}`;
const serverMsg = (n: number, folder: string, extra: Row = {}) => ({
  id: oid(n),
  uid: n,
  folder_path: folder,
  subject: `Message ${n}`,
  from: { value: [{ address: `s${n}@x.test`, name: `Sender ${n}` }] },
  flags: ['\\Seen'],
  date: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
  ...extra,
});

// Folder contents on the server, newest first, as the list endpoint pages them.
const serverFolders = new Map<string, Row[]>();
let exposeItemCount = false;
let listHook: ((url: URL) => Row[] | null | void) | null = null;
let detailHook: ((id: string, url: URL) => Response | Promise<Response> | null | void) | null =
  null;
const requests: URL[] = [];

function listResponse(url: URL) {
  const folder = url.searchParams.get('folder') || '';
  const page = Number(url.searchParams.get('page') || 1);
  const limit = Math.min(Number(url.searchParams.get('limit') || 25), 100);
  const override = listHook?.(url);
  const all = serverFolders.get(folder) || [];
  const body = override ?? all.slice((page - 1) * limit, page * limit);
  const headers: Record<string, string> = {};
  if (exposeItemCount) headers['X-Item-Count'] = String(all.length);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

const posted: Row[] = [];
const searchPortMessages: Row[] = [];

const onmessage = () => (self as unknown as { onmessage: (event: unknown) => void }).onmessage;

let taskSeq = 0;
async function runTask(task: Row): Promise<Row> {
  const taskId = `t${++taskSeq}`;
  onmessage()({ data: { type: 'task', taskId, task: { account: ACCOUNT, ...task } } });
  let done: Row | undefined;
  await vi.waitFor(
    () => {
      done = posted.find(
        (m) => m.taskId === taskId && (m.type === 'taskComplete' || m.type === 'taskError'),
      );
      expect(done).toBeTruthy();
    },
    { timeout: 20_000, interval: 5 },
  );
  return done as Row;
}

let requestSeq = 0;
async function request(action: string, payload: Row): Promise<Row> {
  const requestId = ++requestSeq;
  onmessage()({ data: { type: 'request', requestId, action, payload } });
  let done: Row | undefined;
  await vi.waitFor(
    () => {
      done = posted.find(
        (m) =>
          m.requestId === requestId && (m.type === 'requestComplete' || m.type === 'requestError'),
      );
      expect(done).toBeTruthy();
    },
    { timeout: 5000, interval: 5 },
  );
  return done as Row;
}

const cachedIds = (folder: string) =>
  [...table('messages').values()]
    .filter((r) => r.account === ACCOUNT && r.folder === folder)
    .map((r) => r.id as string)
    .sort();

const manifestOf = (folder: string) => table('syncManifests').get(keyOf([ACCOUNT, folder]));

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  globalThis.fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const detail = url.pathname.match(/\/v1\/messages\/([^/]+)$/);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      const hooked = await detailHook?.(id, url);
      if (hooked) return hooked;
      for (const list of serverFolders.values()) {
        const found = list.find((m) => m.id === id);
        if (found) return new Response(JSON.stringify(found), { status: 200 });
      }
      return new Response('{"message":"Message does not exist"}', { status: 404 });
    }
    return listResponse(url);
  }) as unknown as typeof fetch;
  (self as unknown as { postMessage: (msg: Row) => void }).postMessage = (msg) => {
    posted.push(msg);
  };

  await import('../../src/workers/sync.worker.ts');
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (event) => {
    const { id, action, table: name, payload } = event.data;
    if (dbStalls?.(action, name)) return;
    port2.postMessage({ id, ok: true, result: answer(action, name, payload || {}) });
  };
  onmessage()({ data: { type: 'connectDbPort' }, ports: [port1] });
  const search = new MessageChannel();
  search.port2.onmessage = (event) => searchPortMessages.push(event.data);
  onmessage()({ data: { type: 'connectSearchPort' }, ports: [search.port1] });
  onmessage()({
    data: {
      type: 'init',
      config: { apiBase: 'https://api.example.com', account: ACCOUNT, authHeader: 'Basic x' },
    },
  });
});

beforeEach(() => {
  exposeItemCount = false;
  listHook = null;
  detailHook = null;
  onDbAction = null;
  dbStalls = null;
  requests.length = 0;
});

const seedFolderTotal = (folder: string, total: number) =>
  table('folders').set(keyOf([ACCOUNT, folder]), { account: ACCOUNT, path: folder, total });

// Run backfill batches the way the controller does until the worker says done.
async function backfillUntilDone(folder: string, maxBatches = 30) {
  const results: Row[] = [];
  for (let i = 0; i < maxBatches; i += 1) {
    const res = await runTask({ type: 'backfill', folder, pageSize: 50 });
    results.push(res);
    if (res.type === 'taskError' || res.done) break;
  }
  return results;
}

describe('offline history on a phone', () => {
  const setMemoryConstrained = (memoryConstrained: boolean) =>
    onmessage()({
      data: {
        type: 'init',
        config: {
          apiBase: 'https://api.example.com',
          account: ACCOUNT,
          authHeader: 'Basic x',
          memoryConstrained,
        },
      },
    });

  it('trims a folder cached before the cap to its newest 2000', async () => {
    const folder = 'Trim';
    // A phone that cached 2,300 messages here before the cap existed
    for (let n = 1; n <= 2300; n += 1) {
      const msg = serverMsg(n, folder);
      table('messages').set(keyOf([ACCOUNT, msg.id]), {
        account: ACCOUNT,
        id: msg.id,
        folder,
        date: msg.date,
      });
      table('messageBodies').set(keyOf([ACCOUNT, msg.id]), { account: ACCOUNT, id: msg.id });
    }
    table('messages').set(keyOf([ACCOUNT, 'undated']), { account: ACCOUNT, id: 'undated', folder });
    serverFolders.set(folder, []);
    searchPortMessages.length = 0;
    setMemoryConstrained(true);
    try {
      await runTask({ type: 'backfill', folder, pageSize: 50 });

      const left = cachedIds(folder);
      // 2,301 rows, the undated one included, down to 2,000: the 301 oldest
      // dated rows go and the undated one stays, as it cannot be placed
      expect(left).toHaveLength(2000);
      expect(left).not.toContain(oid(301));
      expect(left).toContain(oid(302));
      expect(left).toContain(oid(2300));
      expect(left).toContain('undated');
      expect(table('messageBodies').has(keyOf([ACCOUNT, oid(1)]))).toBe(false);
      const removed = searchPortMessages
        .filter((m) => m.action === 'remove')
        .flatMap((m) => (m.payload as { ids: string[] }).ids);
      expect(removed).toHaveLength(301);
    } finally {
      setMemoryConstrained(false);
      searchPortMessages.length = 0;
    }
  });

  it('leaves a desktop history alone', async () => {
    const folder = 'NoTrim';
    for (let n = 1; n <= 2100; n += 1) {
      const msg = serverMsg(n, folder);
      table('messages').set(keyOf([ACCOUNT, msg.id]), {
        account: ACCOUNT,
        id: msg.id,
        folder,
        date: msg.date,
      });
    }
    serverFolders.set(folder, []);
    await runTask({ type: 'backfill', folder, pageSize: 50 });
    expect(cachedIds(folder)).toHaveLength(2100);
  });
});

describe('backfill paging', () => {
  it('does not skip messages that shift onto pages already read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const folder = 'Shift';
      const all = Array.from({ length: 300 }, (_, i) => serverMsg(300 - i, folder));
      serverFolders.set(folder, all.slice());
      seedFolderTotal(folder, 300);
      exposeItemCount = true;
      let served = 0;
      listHook = (url) => {
        if (url.searchParams.get('folder') !== folder) return null;
        served += 1;
        // After the first backfill page, another client moves the 30 newest
        // messages out of the folder.
        if (served === 2) serverFolders.set(folder, all.slice(30));
        return null;
      };

      await backfillUntilDone(folder);

      const expected = all
        .slice(30)
        .map((m) => m.id as string)
        .sort();
      const cached = cachedIds(folder);
      for (const id of expected) expect(cached).toContain(id);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('does not mark a folder complete on empty pages the server total disagrees with', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const folder = 'Flaky';
      const all = Array.from({ length: 180 }, (_, i) => serverMsg(1000 + 180 - i, folder));
      serverFolders.set(folder, all);
      seedFolderTotal(folder, 180);
      // The server answers three pages in a row with nothing (a hiccup on its
      // side), then recovers.
      let emptyAnswers = 0;
      listHook = (url) => {
        if (url.searchParams.get('folder') !== folder) return null;
        if (url.searchParams.get('page') === '2' && emptyAnswers < 3) {
          emptyAnswers += 1;
          return [];
        }
        return null;
      };

      // First round: the walk stops at the hiccup without finishing.
      await backfillUntilDone(folder);
      expect(manifestOf(folder)?.backfillComplete).not.toBe(true);

      // Later rounds (the next metadata syncs re-queue backfill) resume.
      await backfillUntilDone(folder);
      await backfillUntilDone(folder);
      await backfillUntilDone(folder);

      expect(cachedIds(folder)).toEqual(all.map((m) => m.id as string).sort());
      expect(manifestOf(folder)?.backfillComplete).toBe(true);
      expect(manifestOf(folder)?.backfillTotal).toBe(180);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('walks again when the server total grows past the finished one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const folder = 'Grows';
      const first = Array.from({ length: 40 }, (_, i) => serverMsg(2000 + 40 - i, folder));
      serverFolders.set(folder, first);
      seedFolderTotal(folder, 40);
      await backfillUntilDone(folder);
      expect(manifestOf(folder)?.backfillComplete).toBe(true);

      // Older mail is moved into the folder from elsewhere (it sorts below
      // what the forward pass looks at).
      const older = Array.from({ length: 10 }, (_, i) => serverMsg(1900 - i, folder));
      serverFolders.set(folder, [...first, ...older]);
      seedFolderTotal(folder, 50);
      await backfillUntilDone(folder);

      for (const m of older) expect(cachedIds(folder)).toContain(m.id);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe('pruning messages the server no longer has', () => {
  it('removes cached rows confirmed gone, follows a move, keeps one the listing missed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const folder = 'Prune';
      const live = Array.from({ length: 60 }, (_, i) => serverMsg(3000 + 60 - i, folder));
      serverFolders.set(folder, live);
      seedFolderTotal(folder, 60);
      const old = Date.now() - 86_400_000;
      // Cached long ago: three since deleted on the server, one moved to
      // Archive by another client.
      const deleted = [oid(3901), oid(3902), oid(3903)];
      for (const id of deleted) {
        table('messages').set(keyOf([ACCOUNT, id]), {
          id,
          account: ACCOUNT,
          folder,
          subject: 'gone',
          updatedAt: old,
        });
        table('messageBodies').set(keyOf([ACCOUNT, id]), { id, account: ACCOUNT, body: 'x' });
      }
      const moved = serverMsg(3950, 'Archive');
      serverFolders.set('Archive', [moved]);
      table('messages').set(keyOf([ACCOUNT, moved.id]), {
        id: moved.id,
        account: ACCOUNT,
        folder,
        subject: 'moved',
        updatedAt: old,
      });
      // A message the server still has here, but the listing did not include
      // (as if a shifted page skipped it).
      const missed = serverMsg(3960, folder);
      table('messages').set(keyOf([ACCOUNT, missed.id]), {
        id: missed.id,
        account: ACCOUNT,
        folder,
        subject: 'missed',
        updatedAt: old,
      });
      detailHook = (id) =>
        id === missed.id ? new Response(JSON.stringify(missed), { status: 200 }) : null;

      const results = await backfillUntilDone(folder);

      for (const id of deleted) {
        expect(table('messages').has(keyOf([ACCOUNT, id]))).toBe(false);
        expect(table('messageBodies').has(keyOf([ACCOUNT, id]))).toBe(false);
      }
      expect(table('messages').get(keyOf([ACCOUNT, moved.id]))?.folder).toBe('Archive');
      expect(table('messages').has(keyOf([ACCOUNT, missed.id]))).toBe(true);
      const prunedIds = results.flatMap((r) => (r.prunedIds as string[]) || []);
      expect(prunedIds.sort()).toEqual([...deleted].sort());
      const removed = searchPortMessages
        .filter((m) => m.action === 'remove')
        .flatMap((m) => (m.payload as { ids: string[] }).ids);
      expect(removed.sort()).toEqual([...deleted].sort());
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('prunes nothing when the walk did not reach the end of the listing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const folder = 'Partial';
      const live = Array.from({ length: 250 }, (_, i) => serverMsg(5000 + 250 - i, folder));
      serverFolders.set(folder, live);
      seedFolderTotal(folder, 250);
      const stale = oid(5999);
      table('messages').set(keyOf([ACCOUNT, stale]), {
        id: stale,
        account: ACCOUNT,
        folder,
        updatedAt: 1,
      });
      // Page 3 keeps failing.
      listHook = (url) => {
        if (url.searchParams.get('folder') === folder && url.searchParams.get('page') === '3') {
          throw new Error('boom');
        }
        return null;
      };
      await backfillUntilDone(folder);
      expect(table('messages').has(keyOf([ACCOUNT, stale]))).toBe(true);
      expect(requests.some((u) => u.pathname.endsWith(stale))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe('bodies pass', () => {
  it('keeps going past a message that fails and does not retry it on the next pass', async () => {
    const folder = 'Bodies';
    const ids = [oid(7001), oid(7002), oid(7003)];
    ids.forEach((id, i) =>
      table('messages').set(keyOf([ACCOUNT, id]), {
        id,
        account: ACCOUNT,
        folder,
        date: 3000 - i,
        subject: `Body ${i}`,
      }),
    );
    detailHook = (id) => {
      if (id === ids[1]) return new Response('{"message":"gone"}', { status: 404 });
      return new Response(JSON.stringify({ id, html: `<p>body of ${id}</p>`, text: 'hi' }), {
        status: 200,
      });
    };
    const first = await runTask({ type: 'bodies', folder, limit: 10 });
    expect(first.type).toBe('taskComplete');
    expect(table('messageBodies').get(keyOf([ACCOUNT, ids[2]]))?.body).toContain('body of');

    requests.length = 0;
    await runTask({ type: 'bodies', folder, limit: 10 });
    expect(requests.filter((u) => u.pathname.endsWith(ids[1]))).toHaveLength(0);
  });

  it('downloads a PGP message it cannot decrypt only once', async () => {
    const folder = 'Pgp';
    const id = oid(7101);
    table('messages').set(keyOf([ACCOUNT, id]), { id, account: ACCOUNT, folder, date: 1 });
    const raw =
      'Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----\r\n';
    detailHook = (reqId) =>
      reqId === id ? new Response(JSON.stringify({ id, raw }), { status: 200 }) : null;

    await runTask({ type: 'bodies', folder, limit: 10 });
    await runTask({ type: 'bodies', folder, limit: 10 });
    await runTask({ type: 'bodies', folder, limit: 10 });
    expect(requests.filter((u) => u.pathname.endsWith(id))).toHaveLength(1);

    // The reader still gets the ciphertext to decrypt, without a download.
    requests.length = 0;
    const detail = await request('messageDetail', {
      account: ACCOUNT,
      folder,
      message: { id },
    });
    expect((detail.result as Row).pgpLocked).toBe(true);
    expect((detail.result as Row).raw).toBe(raw);
    expect(((detail.result as Row).meta as Row).raw).toBe(raw);
    expect(requests).toHaveLength(0);
  });

  // At every launch the pass read the whole folder and up to 200 whole cached
  // bodies (raw message and attachments included), copied to this worker just
  // to see which were missing: one of the spikes that ended the iOS page.
  it('reads only the newest headers and never the cached bodies themselves', async () => {
    const folder = 'Lean';
    const ids = Array.from({ length: 30 }, (_, i) => oid(7300 + i));
    ids.forEach((id, i) => {
      table('messages').set(keyOf([ACCOUNT, id]), {
        id,
        account: ACCOUNT,
        folder,
        date: 5000 + i,
        subject: `Lean ${i}`,
      });
      table('messageBodies').set(keyOf([ACCOUNT, id]), {
        id,
        account: ACCOUNT,
        folder,
        body: `<p>cached ${i}</p>`,
        attachments: [],
      });
    });
    // the newest one has no body yet
    table('messageBodies').delete(keyOf([ACCOUNT, ids[29]]));
    detailHook = (id) =>
      new Response(JSON.stringify({ id, html: `<p>body of ${id}</p>` }), { status: 200 });
    const calls: Array<{ action: string; name: string; payload: Row }> = [];
    onDbAction = (action, name, payload) => calls.push({ action, name, payload });

    await runTask({ type: 'bodies', folder, limit: 5 });

    expect(table('messageBodies').get(keyOf([ACCOUNT, ids[29]]))?.body).toContain('body of');
    const bodyReads = calls.filter(
      (c) => c.name === 'messageBodies' && ['bulkGet', 'queryEquals'].includes(c.action),
    );
    expect(bodyReads).toHaveLength(0);
    const statusCalls = calls.filter((c) => c.action === 'bodyStatuses');
    expect(statusCalls).toHaveLength(1);
    // the newest the pass can use (its limit), not the whole folder
    expect((statusCalls[0].payload.keys as unknown[]).length).toBe(5);
    expect(calls.some((c) => c.name === 'messages' && c.action === 'queryEquals')).toBe(false);
  });

  it('does not download again a body that had no attachments to list', async () => {
    const folder = 'NoParts';
    const id = oid(7401);
    // The server flags an attachment (a signature part) the body has none of
    table('messages').set(keyOf([ACCOUNT, id]), {
      id,
      account: ACCOUNT,
      folder,
      date: 1,
      has_attachment: true,
    });
    detailHook = (reqId) =>
      reqId === id
        ? new Response(JSON.stringify({ id, html: '<p>signed</p>' }), { status: 200 })
        : null;
    await runTask({ type: 'bodies', folder, limit: 10 });
    // Later passes leave it alone: they read the whole body record again to
    // find it cached, at every launch
    const reads: string[] = [];
    onDbAction = (action, name) => {
      if (name === 'messageBodies' && action === 'get') reads.push(action);
    };
    await runTask({ type: 'bodies', folder, limit: 10 });
    await runTask({ type: 'bodies', folder, limit: 10 });
    expect(requests.filter((u) => u.pathname.endsWith(id))).toHaveLength(1);
    expect(reads).toHaveLength(0);
  });

  it('drops, once, bodies a phone cached in full before it kept lean copies', async () => {
    const folder = 'Old';
    const big = oid(7601);
    const small = oid(7602);
    for (const id of [big, small]) {
      table('messages').set(keyOf([ACCOUNT, id]), { id, account: ACCOUNT, folder, date: 1 });
    }
    table('messageBodies').set(keyOf([ACCOUNT, big]), {
      id: big,
      account: ACCOUNT,
      folder,
      body: '<p>big</p>',
      attachments: [],
      meta: { raw: 'A'.repeat(3_000_000) },
    });
    table('messageBodies').set(keyOf([ACCOUNT, small]), {
      id: small,
      account: ACCOUNT,
      folder,
      body: '<p>small</p>',
      attachments: [],
    });
    detailHook = (id) =>
      new Response(JSON.stringify({ id, html: `<p>again ${id}</p>` }), { status: 200 });
    const init = (memoryConstrained: boolean) =>
      onmessage()({
        data: {
          type: 'init',
          config: {
            apiBase: 'https://api.example.com',
            account: ACCOUNT,
            authHeader: 'Basic x',
            memoryConstrained,
          },
        },
      });
    init(true);
    try {
      await runTask({ type: 'bodies', folder, limit: 10 });
    } finally {
      init(false);
    }
    // the big one was dropped and downloaded again, lean; the small one kept
    expect(table('messageBodies').get(keyOf([ACCOUNT, big]))?.body).toContain('again');
    expect(table('messageBodies').get(keyOf([ACCOUNT, small]))?.body).toBe('<p>small</p>');
    expect(table('meta').size).toBeGreaterThan(0);
  });

  it('keeps a lean body copy on a phone', async () => {
    const folder = 'Phone';
    const id = oid(7501);
    table('messages').set(keyOf([ACCOUNT, id]), { id, account: ACCOUNT, folder, date: 1 });
    const photo = 'A'.repeat(2_000_000);
    detailHook = (reqId) =>
      reqId === id
        ? new Response(
            JSON.stringify({
              id,
              html: '<p>see attached</p>',
              nodemailer: {
                html: '<p>see attached</p>',
                text: 'see attached',
                headers: { subject: 'Photo' },
                attachments: [
                  {
                    filename: 'photo.jpg',
                    contentType: 'image/jpeg',
                    size: 1_500_000,
                    content: photo,
                  },
                  {
                    filename: 'logo.png',
                    contentType: 'image/png',
                    contentId: 'logo',
                    disposition: 'inline',
                    content: 'iVBORw0KGgo=',
                  },
                ],
              },
            }),
            { status: 200 },
          )
        : null;
    const init = (memoryConstrained: boolean) =>
      onmessage()({
        data: {
          type: 'init',
          config: {
            apiBase: 'https://api.example.com',
            account: ACCOUNT,
            authHeader: 'Basic x',
            memoryConstrained,
          },
        },
      });
    init(true);
    try {
      await runTask({ type: 'bodies', folder, limit: 10 });
    } finally {
      init(false);
    }
    const cached = table('messageBodies').get(keyOf([ACCOUNT, id])) as Row;
    expect(cached.body).toContain('see attached');
    const parsed = (cached.meta as Row).nodemailer as Row;
    expect(parsed.html).toBeUndefined();
    expect(parsed.text).toBeUndefined();
    expect(parsed.headers).toEqual({ subject: 'Photo' });
    expect((parsed.attachments as Row[]).every((a) => a.content === undefined)).toBe(true);
    // The photo is listed without its content (downloaded when opened), the
    // inline logo the body shows is kept
    const listed = cached.attachments as Row[];
    expect(listed.find((a) => a.filename === 'photo.jpg')).toMatchObject({ needsDownload: true });
    expect(JSON.stringify(cached).length).toBeLessThan(100_000);
  });
});

describe('opening a message while the database is busy', () => {
  it('shows a downloaded PGP message without waiting to cache it', async () => {
    const folder = 'Busy';
    const id = oid(7201);
    const raw =
      'Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----\r\n';
    detailHook = (reqId) =>
      reqId === id ? new Response(JSON.stringify({ id, raw }), { status: 200 }) : null;
    // Reads and writes of bodies go unanswered.
    dbStalls = (action, name) => name === 'messageBodies';

    const started = Date.now();
    const detail = await request('messageDetail', { account: ACCOUNT, folder, message: { id } });

    expect(detail.type).toBe('requestComplete');
    expect((detail.result as Row).raw).toBe(raw);
    // The cache lookup gives up after a few seconds; the write is not awaited.
    expect(Date.now() - started).toBeLessThan(4500);
  }, 10_000);

  it('shows a downloaded plain message without waiting to cache it', async () => {
    const folder = 'Busy';
    const id = oid(7202);
    const raw = 'Content-Type: text/plain\r\nSubject: Hi\r\n\r\nHello there\r\n';
    detailHook = (reqId) =>
      reqId === id ? new Response(JSON.stringify({ id, raw }), { status: 200 }) : null;
    dbStalls = (action, name) => name === 'messageBodies' && action === 'put';

    const started = Date.now();
    const detail = await request('messageDetail', { account: ACCOUNT, folder, message: { id } });

    expect(detail.type).toBe('requestComplete');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('list page writes', () => {
  it('merges into cached rows and leaves a just-deleted message out', async () => {
    const folder = 'INBOX-merge';
    const kept = serverMsg(8001, folder, { subject: '...' });
    const deletedHere = serverMsg(8002, folder);
    const starred = serverMsg(8003, folder, { flags: ['\\Seen'] });
    serverFolders.set(folder, [kept, deletedHere, starred]);
    table('messages').set(keyOf([ACCOUNT, kept.id]), {
      id: kept.id,
      account: ACCOUNT,
      folder,
      subject: 'Quarterly numbers',
      pgpEncrypted: true,
      pgpSigned: true,
      bodyIndexed: true,
      to: 'boss@x.test',
      flags: ['\\Seen'],
    });
    table('messages').set(keyOf([ACCOUNT, starred.id]), {
      id: starred.id,
      account: ACCOUNT,
      folder,
      flags: ['\\Seen', '\\Flagged'],
      is_starred: true,
      is_flagged: true,
    });

    const res = await request('messagePage', {
      account: ACCOUNT,
      folder,
      page: 1,
      limit: 50,
      lightweight: true,
      pendingDeleteIds: [deletedHere.id],
      pendingFlagMutations: { [starred.id]: { is_starred: true } },
    });
    expect(res.type).toBe('requestComplete');

    const row = table('messages').get(keyOf([ACCOUNT, kept.id]));
    expect(row).toMatchObject({
      subject: 'Quarterly numbers',
      pgpEncrypted: true,
      pgpSigned: true,
      bodyIndexed: true,
      to: 'boss@x.test',
    });
    expect(table('messages').has(keyOf([ACCOUNT, deletedHere.id]))).toBe(false);
    expect(table('messages').get(keyOf([ACCOUNT, starred.id]))).toMatchObject({
      is_starred: true,
    });
    expect(table('messages').get(keyOf([ACCOUNT, starred.id]))?.flags).toContain('\\Flagged');
  });
});

describe('metadata pass with a pending local change', () => {
  it('does not overwrite a read change the server has not applied yet', async () => {
    const folder = 'Pending';
    const msg = serverMsg(8501, folder, { flags: [] });
    serverFolders.set(folder, [msg]);
    table('messages').set(keyOf([ACCOUNT, msg.id]), {
      id: msg.id,
      account: ACCOUNT,
      folder,
      flags: ['\\Seen'],
      is_unread: false,
      is_unread_index: 0,
    });
    await runTask({
      type: 'metadata',
      folder,
      pageSize: 50,
      pendingFlagMutations: { [msg.id]: { is_unread: false } },
    });
    expect(table('messages').get(keyOf([ACCOUNT, msg.id]))).toMatchObject({
      is_unread: false,
      flags: ['\\Seen'],
    });
  });
});

describe('heal pass', () => {
  it('writes only the sender and does not undo a change made during the fetch', async () => {
    const folder = 'Heal';
    const msg = serverMsg(9001, folder);
    serverFolders.set(folder, []);
    table('messages').set(keyOf([ACCOUNT, msg.id]), {
      id: msg.id,
      account: ACCOUNT,
      folder,
      from: '',
      flags: [],
      is_unread: true,
    });
    const gone = serverMsg(9002, folder);
    table('messages').set(keyOf([ACCOUNT, gone.id]), {
      id: gone.id,
      account: ACCOUNT,
      folder,
      from: '',
    });
    detailHook = (id) => {
      if (id === msg.id) {
        // The user reads the message while the sender lookup is in flight.
        const row = table('messages').get(keyOf([ACCOUNT, msg.id])) as Row;
        table('messages').set(keyOf([ACCOUNT, msg.id]), {
          ...row,
          flags: ['\\Seen'],
          is_unread: false,
        });
        return new Response(JSON.stringify(msg), { status: 200 });
      }
      if (id === gone.id) {
        // ...and deletes the other one.
        table('messages').delete(keyOf([ACCOUNT, gone.id]));
        return new Response(JSON.stringify(gone), { status: 200 });
      }
      return null;
    };
    await runTask({ type: 'metadata', folder, pageSize: 50 });
    const row = table('messages').get(keyOf([ACCOUNT, msg.id]));
    expect(row?.from).toContain('s9001@x.test');
    expect(row).toMatchObject({ is_unread: false, flags: ['\\Seen'] });
    expect(table('messages').has(keyOf([ACCOUNT, gone.id]))).toBe(false);
  });
});

describe('PGP badge', () => {
  it('decrypts in the background a PGP message cached before the key was unlocked', async () => {
    const folder = 'PgpLater';
    const id = oid(9201);
    table('messages').set(keyOf([ACCOUNT, id]), { id, account: ACCOUNT, folder, date: 1 });
    const raw =
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----\r\n';
    detailHook = (reqId) =>
      reqId === id ? new Response(JSON.stringify({ id, raw }), { status: 200 }) : null;

    // The first pass runs before any key is unlocked: the ciphertext is cached.
    await runTask({ type: 'bodies', folder, limit: 10 });
    expect(table('messageBodies').get(keyOf([ACCOUNT, id]))).toMatchObject({ pgpLocked: true });

    // Then the key is unlocked, and the next pass decrypts the cached copy.
    onmessage()({ data: { type: 'pgpKeys', keys: [{ name: 'k', value: 'armored' }] } });
    await new Promise((r) => setTimeout(r, 10));
    requests.length = 0;
    await runTask({ type: 'bodies', folder, limit: 10 });

    const cached = table('messageBodies').get(keyOf([ACCOUNT, id]));
    expect(cached?.pgpLocked).toBeFalsy();
    expect(cached?.raw).toBeUndefined();
    // Only a successful decrypt records the badge.
    expect(table('messages').get(keyOf([ACCOUNT, id]))).toMatchObject({ pgpEncrypted: true });
    // From the cached ciphertext, not a second download.
    expect(requests.filter((u) => u.pathname.endsWith(id))).toHaveLength(0);

    onmessage()({ data: { type: 'pgpKeys', keys: [] } });
    await new Promise((r) => setTimeout(r, 10));
  });

  it('does not try the same keys on a locked PGP message twice', async () => {
    const folder = 'PgpWrongKey';
    const id = oid(9202);
    table('messages').set(keyOf([ACCOUNT, id]), { id, account: ACCOUNT, folder, date: 1 });
    table('messageBodies').set(keyOf([ACCOUNT, id]), {
      id,
      account: ACCOUNT,
      folder,
      body: '',
      raw: 'Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----\r\n',
      pgpLocked: true,
    });
    onmessage()({ data: { type: 'pgpKeys', keys: [{ name: 'k', value: 'armored' }] } });
    await new Promise((r) => setTimeout(r, 10));
    const openpgp = await import('openpgp');
    const decrypt = vi.spyOn(openpgp, 'decrypt').mockRejectedValue(new Error('no matching key'));
    try {
      await runTask({ type: 'bodies', folder, limit: 10 });
      await runTask({ type: 'bodies', folder, limit: 10 });
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(requests.filter((u) => u.pathname.endsWith(id))).toHaveLength(0);
    } finally {
      decrypt.mockRestore();
      onmessage()({ data: { type: 'pgpKeys', keys: [] } });
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  it('records pgpEncrypted and pgpSigned after a worker decrypt', async () => {
    onmessage()({ data: { type: 'pgpKeys', keys: [{ name: 'k', value: 'armored' }] } });
    await new Promise((r) => setTimeout(r, 10));
    const folder = 'PgpBadge';
    const id = oid(9101);
    table('messages').set(keyOf([ACCOUNT, id]), {
      id,
      account: ACCOUNT,
      folder,
      subject: '...',
      date: 1,
    });
    const raw =
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----\r\n';
    detailHook = (reqId) =>
      reqId === id ? new Response(JSON.stringify({ id, raw }), { status: 200 }) : null;
    await runTask({ type: 'bodies', folder, limit: 10 });
    expect(table('messages').get(keyOf([ACCOUNT, id]))).toMatchObject({
      pgpEncrypted: true,
      pgpSigned: true,
    });
    // Drop the keys again so later tests see a locked worker.
    onmessage()({ data: { type: 'pgpKeys', keys: [] } });
    await new Promise((r) => setTimeout(r, 10));
  });
});
