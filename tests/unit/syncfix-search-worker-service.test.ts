/**
 * The search worker keeps one index per account. Callers that disagree about
 * body indexing (the sync worker posts metadata batches without bodies and
 * body batches with them; the main thread passes the user's setting) used to
 * make it throw the live index away and reload the last saved copy, which
 * brought removed messages back and dropped body text.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({
  searchIndex: new Map<string, Row>(),
  indexMeta: new Map<string, Row>(),
  messages: new Map<string, Row>(),
  messageBodies: new Map<string, Row>(),
  // When set, reads of the messages table wait on it (a slow database).
  hold: null as Promise<void> | null,
  // Keys asked for per body-text request, and full body record reads.
  bodyTextRequests: [] as number[],
  fullBodyReads: 0,
  // The limit of each read of the messages table (Infinity: unbounded).
  messageReads: [] as number[],
  // Called after each read of the messages table, with the read's index (a
  // way to change the table between two chunks).
  afterMessageRead: null as null | ((read: number) => void | Promise<void>),
}));

vi.mock('../../src/utils/db-worker-client.js', async () => {
  const { indexableBodyText } = await import('../../src/utils/search-body-text.js');
  const k = (key: unknown) => JSON.stringify(key);
  const table = (name: 'searchIndex' | 'indexMeta' | 'messages' | 'messageBodies') => ({
    get: async (key: unknown) => store[name].get(k(key)),
    put: async (rec: Row) => {
      store[name].set(k([rec.account, rec.key ?? rec.id]), rec);
    },
    bulkGet: async (keys: unknown[]) => {
      if (name === 'messageBodies') store.fullBodyReads += 1;
      return keys.map((key) => store[name].get(k(key)));
    },
    // Same contract as db-engine's bodyTexts: text only, missing rows left out.
    bodyTexts: async (keys: unknown[]) => {
      store.bodyTextRequests.push(keys.length);
      return keys
        .map((key) => store[name].get(k(key)))
        .filter((row): row is Row => Boolean(row?.id))
        .map((row) => ({ id: String(row.id), text: indexableBodyText(row) }));
    },
    where: (index: string) => ({
      equals: (value: unknown) => {
        // Same chain as the db worker client: offset() and limit() narrow
        // what toArray() returns.
        const query = { offset: 0, limit: Infinity };
        const collection = {
          offset: (n: number) => {
            query.offset = n;
            return collection;
          },
          limit: (n: number) => {
            query.limit = n;
            return collection;
          },
          toArray: async () => {
            if (name === 'messages' && store.hold) await store.hold;
            if (name === 'messages') store.messageReads.push(query.limit);
            const rows = [...store[name].values()]
              .filter((row) => index === 'account' && row.account === value)
              .slice(query.offset, query.offset + query.limit);
            if (name === 'messages') await store.afterMessageRead?.(store.messageReads.length);
            return rows;
          },
          count: async () =>
            [...store[name].values()].filter((row) => index === 'account' && row.account === value)
              .length,
        };
        return collection;
      },
      // The primary key, [account+id], in key order. Bounds are [account, id]
      // pairs; -Infinity and [] stand for below and above every id.
      between: (lower: unknown[], upper: unknown[], includeLower = true, includeUpper = false) => {
        const query = { limit: Infinity };
        const below = (a: unknown, b: unknown) =>
          a === -Infinity || Array.isArray(b)
            ? a !== b
            : !Array.isArray(a) && String(a) < String(b);
        const collection = {
          limit: (n: number) => {
            query.limit = n;
            return collection;
          },
          toArray: async () => {
            if (index !== '[account+id]') throw new Error(`no between on ${index}`);
            if (name === 'messages' && store.hold) await store.hold;
            if (name === 'messages') store.messageReads.push(query.limit);
            const rows = [...store[name].values()]
              .filter((row) => row.account === lower[0])
              .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
              .filter((row) => (includeLower ? !below(row.id, lower[1]) : below(lower[1], row.id)))
              .filter((row) => (includeUpper ? !below(upper[1], row.id) : below(row.id, upper[1])))
              .slice(0, query.limit);
            if (name === 'messages') await store.afterMessageRead?.(store.messageReads.length);
            return rows;
          },
        };
        return collection;
      },
    }),
  });
  return {
    dbClient: {
      searchIndex: table('searchIndex'),
      indexMeta: table('indexMeta'),
      messages: table('messages'),
      messageBodies: table('messageBodies'),
    },
    connectToDbWorker: () => {},
  };
});

const ACCOUNT = 'me@x.test';
const responses = new Map<number, Row>();
let nextId = 0;
let syncPort: MessagePort;

const onmessage = () =>
  (self as unknown as { onmessage: (event: unknown) => Promise<void> }).onmessage;

async function call(action: string, payload: Row = {}) {
  const id = ++nextId;
  await onmessage()({ data: { id, action, payload } });
  return responses.get(id) as { ok: boolean; result: Row };
}

async function searchIds(query: string, includeBody: boolean) {
  const res = await call('search', { account: ACCOUNT, query, crossFolder: true, includeBody });
  return ((res.result.results as Row[]) || []).map((hit) => hit.id).sort();
}

const msg = (id: string, subject: string) => ({
  id,
  account: ACCOUNT,
  folder: 'INBOX',
  subject,
  from: 'Ada <ada@x.test>',
  snippet: '',
  date: Date.UTC(2026, 9, 1),
  labels: [],
});

beforeAll(async () => {
  (self as unknown as { postMessage: (m: Row) => void }).postMessage = (m) => {
    responses.set(m.id as number, m);
  };
  await import('../../src/workers/search.worker.ts');
  const channel = new MessageChannel();
  await onmessage()({ data: { id: ++nextId, action: 'connectDbPort' }, ports: [channel.port1] });
  const sync = new MessageChannel();
  await onmessage()({ data: { id: ++nextId, action: 'connectSyncPort' }, ports: [sync.port1] });
  syncPort = sync.port2;
});

beforeEach(() => {
  store.searchIndex.clear();
  store.indexMeta.clear();
  store.messages.clear();
  store.messageBodies.clear();
  store.hold = null;
  store.bodyTextRequests = [];
  store.fullBodyReads = 0;
  store.messageReads = [];
  store.afterMessageRead = null;
});

describe('search worker service per account', () => {
  it('a caller asking for the other body mode does not bring back a removed message', async () => {
    const account = 'ghost@x.test';
    // The index was last saved holding both messages.
    store.searchIndex.set(JSON.stringify([account, 'messages_v1']), {
      account,
      key: 'messages_v1',
      data: [
        { ...msg('m1', 'Quarterly invoice'), labelsText: '' },
        { ...msg('m2', 'Quarterly report'), labelsText: '' },
      ],
    });
    await call('init', { account, includeBody: false });
    // The user deletes m1. The removal is in memory; the debounced write has
    // not happened yet.
    await call('remove', { account, ids: ['m1'] });

    // Another caller asks with includeBody true (the sync worker's body batch,
    // or a search issued with the other setting).
    const res = await call('search', {
      account,
      query: 'quarterly',
      crossFolder: true,
      includeBody: true,
    });
    const ids = ((res.result.results as Row[]) || []).map((hit) => hit.id);
    expect(ids).toEqual(['m2']);
  });

  it('a metadata batch without a body does not strip body text from the index', async () => {
    await call('init', { account: ACCOUNT, includeBody: true });
    // The sync worker fetched the body: it is in messageBodies and is posted
    // to the index with includeBody true.
    store.messageBodies.set(JSON.stringify([ACCOUNT, 'b1']), {
      id: 'b1',
      account: ACCOUNT,
      textContent: 'The kumquat shipment lands on Tuesday',
    });
    syncPort.postMessage({
      action: 'index',
      payload: {
        account: ACCOUNT,
        includeBody: true,
        messages: [{ ...msg('b1', 'Logistics'), body: '<p>The kumquat shipment</p>' }],
      },
    });
    await vi.waitFor(async () => expect(await searchIds('kumquat', true)).toEqual(['b1']), {
      timeout: 2000,
    });

    // A flag change arrives as a metadata batch (no body, includeBody false),
    // and the body row is not readable this time (for example evicted).
    store.messageBodies.clear();
    syncPort.postMessage({
      action: 'index',
      payload: {
        account: ACCOUNT,
        includeBody: false,
        messages: [{ ...msg('b1', 'Logistics'), labels: ['work'] }],
      },
    });
    await vi.waitFor(async () => expect(await searchIds('work', true)).toEqual(['b1']), {
      timeout: 2000,
    });
    expect(await searchIds('kumquat', true)).toEqual(['b1']);
  });

  // Each write copies the whole index, so a sync burst must not write it once
  // per drained batch; a flush (the app being hidden) writes it at once.
  it('a drained sync batch is not written until the debounce or a flush', async () => {
    const account = 'burst@x.test';
    await call('init', { account, includeBody: false });
    const saved = () => store.searchIndex.get(JSON.stringify([account, 'messages_v1']));
    const before = saved();
    syncPort.postMessage({
      action: 'index',
      payload: { account, includeBody: false, messages: [msg('s1', 'Rhubarb crumble')] },
    });
    await vi.waitFor(async () => {
      const res = await call('search', { account, query: 'rhubarb', crossFolder: true });
      expect((res.result.results as Row[]).map((h) => h.id)).toEqual(['s1']);
    });
    expect(saved()).toBe(before);

    await call('flush', {});
    expect(((saved()?.data as Row[]) || []).map((e) => e.id)).toContain('s1');
  });

  it('turning body indexing off through init drops body text without reloading', async () => {
    const account = 'toggle@x.test';
    await call('init', { account, includeBody: true });
    store.messageBodies.set(JSON.stringify([account, 't1']), {
      id: 't1',
      account,
      textContent: 'persimmon tart recipe',
    });
    await call('index', { account, messages: [msg('t1', 'Dessert')] });
    await call('index', { account, messages: [msg('t2', 'Dessert again')] });
    expect(
      (
        (await call('search', { account, query: 'persimmon', crossFolder: true })).result
          .results as Row[]
      ).map((h) => h.id),
    ).toEqual(['t1']);
    await call('remove', { account, ids: ['t2'] });

    await call('init', { account, includeBody: false });
    const body = await call('search', { account, query: 'persimmon', crossFolder: true });
    expect(body.result.results).toEqual([]);
    const subject = await call('search', { account, query: 'dessert', crossFolder: true });
    expect((subject.result.results as Row[]).map((h) => h.id)).toEqual(['t1']);
  });

  it('a rebuild leaves out a message removed while it read the database', async () => {
    const account = 'rebuild@x.test';
    store.messages.set(JSON.stringify([account, 'r1']), { ...msg('r1', 'Ticket one'), account });
    store.messages.set(JSON.stringify([account, 'r2']), { ...msg('r2', 'Ticket two'), account });
    await call('init', { account, includeBody: false });
    let release = () => {};
    store.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rebuild = call('rebuildFromCache', { account, includeBody: false });
    // The removal lands while the rebuild is still reading its snapshot.
    await call('remove', { account, ids: ['r1'] });
    release();
    await rebuild;
    const res = await call('search', { account, query: 'ticket', crossFolder: true });
    expect((res.result.results as Row[]).map((h) => h.id)).toEqual(['r2']);
  });
});

describe('search worker body reads on a large mailbox', () => {
  // The startup rebuild asked the db worker for every cached body in one
  // request, raw source and attachments included. For a large mailbox the
  // answer was too big to post and took the whole app down on each launch.
  it('a rebuild reads body text in batches and never whole body records', async () => {
    const account = 'big@x.test';
    const count = 1_201;
    for (let i = 0; i < count; i++) {
      const id = `m${i}`;
      store.messages.set(JSON.stringify([account, id]), { ...msg(id, `Update ${i}`), account });
      store.messageBodies.set(JSON.stringify([account, id]), {
        id,
        account,
        rawBody: `Subject: Update ${i}\r\n\r\n${'x'.repeat(2_000)}`,
        body: `<p>Shipment ${i} left the warehouse</p>`,
        textContent: i === 700 ? 'gooseberry crumble' : `Shipment ${i} left the warehouse`,
        attachments: [{ filename: 'label.pdf', content: 'J'.repeat(2_000) }],
      });
    }

    const res = await call('rebuildFromCache', { account, includeBody: true });
    expect(res.ok).toBe(true);
    expect(store.fullBodyReads).toBe(0);
    expect(store.bodyTextRequests).toEqual([500, 500, 201]);

    const hits = await call('search', { account, query: 'gooseberry', crossFolder: true });
    expect((hits.result.results as Row[]).map((h) => h.id)).toEqual(['m700']);
  });

  // On iOS every worker shares the web content process's memory limit, and
  // reading the whole mailbox at once at startup ended the page.
  it('a rebuild and the missing-message check read the mailbox a chunk at a time', async () => {
    const account = 'many@x.test';
    const count = 4_500;
    for (let i = 0; i < count; i++) {
      const id = `n${i}`;
      store.messages.set(JSON.stringify([account, id]), {
        ...msg(id, i === 4_321 ? 'Quince delivery' : `Note ${i}`),
        account,
      });
    }

    const rebuilt = await call('rebuildFromCache', { account, includeBody: false });
    expect(rebuilt.ok).toBe(true);
    expect(store.messageReads.length).toBeGreaterThan(1);
    expect(store.messageReads.every((limit) => Number.isFinite(limit) && limit <= 2_000)).toBe(
      true,
    );
    const hits = await call('search', { account, query: 'quince', crossFolder: true });
    expect((hits.result.results as Row[]).map((h) => h.id)).toEqual(['n4321']);

    store.messageReads = [];
    store.messages.set(JSON.stringify([account, 'late']), {
      ...msg('late', 'Persimmon arrival'),
      account,
    });
    const synced = await call('syncMissingMessages', { account, includeBody: false });
    expect(synced.result.synced).toBe(1);
    expect(store.messageReads.every((limit) => Number.isFinite(limit) && limit <= 2_000)).toBe(
      true,
    );
    const late = await call('search', { account, query: 'persimmon', crossFolder: true });
    expect((late.result.results as Row[]).map((h) => h.id)).toEqual(['late']);
  });
});

const savedIds = (account: string) =>
  (
    (store.searchIndex.get(JSON.stringify([account, 'messages_v1']))?.data as Row[] | undefined) ||
    []
  )
    .map((e) => e.id)
    .sort();

const hitIds = async (account: string, query: string) =>
  (
    ((await call('search', { account, query, crossFolder: true })).result?.results as Row[]) || []
  ).map((h) => h.id);

describe('search worker paging through the mailbox', () => {
  // Messages deleted from the cache between two chunk reads shifted the rest
  // down, so reading by offset skipped as many rows as were deleted.
  it('a rebuild indexes every remaining message when rows are deleted between chunks', async () => {
    const account = 'paging@x.test';
    const id = (i: number) => `p${String(i).padStart(5, '0')}`;
    for (let i = 0; i < 4_500; i++) {
      store.messages.set(JSON.stringify([account, id(i)]), {
        ...msg(id(i), i === 2_050 ? 'Tamarind invoice' : `Note ${i}`),
        account,
      });
    }
    store.afterMessageRead = (read) => {
      // The first chunk has been read; the user deletes 100 of its messages.
      if (read !== 1) return;
      for (let i = 0; i < 100; i++) store.messages.delete(JSON.stringify([account, id(i)]));
    };

    const res = await call('rebuildFromCache', { account, includeBody: false });
    expect(res.ok).toBe(true);
    // Every message still cached is indexed (the 100 deleted ones were read
    // before their deletion, so 4,500 in all).
    expect(res.result.count).toBe(4_500);
    expect(await hitIds(account, 'tamarind')).toEqual([id(2_050)]);
    expect(store.messageReads.every((limit) => limit <= 2_000)).toBe(true);
  });
});

describe('search worker rebuild', () => {
  const seed = async (account: string) => {
    await call('init', { account, includeBody: false });
    await call('index', {
      account,
      messages: [msg('old1', 'Saffron order'), msg('old2', 'Saffron receipt')],
    });
    await call('flush', {});
    expect(savedIds(account)).toEqual(['old1', 'old2']);
    for (let i = 0; i < 2_500; i++) {
      const id = `c${String(i).padStart(5, '0')}`;
      store.messages.set(JSON.stringify([account, id]), { ...msg(id, `Cardamom ${i}`), account });
    }
  };

  it('keeps serving and saving the old index until the new one is complete', async () => {
    const account = 'swap@x.test';
    await seed(account);
    let release = () => {};
    store.afterMessageRead = (read) =>
      read === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;

    const rebuild = call('rebuildFromCache', { account, includeBody: false });
    await vi.waitFor(() => expect(store.messageReads.length).toBe(1));
    // Mid-rebuild: searches see the old index, and a flush (the app going to
    // the background) does not save a half-built one.
    expect((await hitIds(account, 'saffron')).sort()).toEqual(['old1', 'old2']);
    await call('flush', {});
    expect(savedIds(account)).toEqual(['old1', 'old2']);

    release();
    const res = await rebuild;
    expect(res.result.count).toBe(2_500);
    expect(await hitIds(account, 'saffron')).toEqual([]);
    expect(savedIds(account)).toHaveLength(2_500);
  });

  it('a failed rebuild leaves the old index in memory and on disk', async () => {
    const account = 'broken@x.test';
    await seed(account);
    store.afterMessageRead = (read) => {
      if (read === 2) throw new Error('database went away');
    };

    const res = await call('rebuildFromCache', { account, includeBody: false });
    expect(res.ok).toBe(false);
    await call('flush', {});
    expect(savedIds(account)).toEqual(['old1', 'old2']);
    expect((await hitIds(account, 'saffron')).sort()).toEqual(['old1', 'old2']);
    expect(await hitIds(account, 'cardamom')).toEqual([]);
  });

  it('on a phone a failed rebuild in place puts the old index back and never saves the partial one', async () => {
    const { setSearchMemoryProfile } = await import('../../src/utils/search-service.js');
    setSearchMemoryProfile(true);
    try {
      const account = 'lite@x.test';
      await seed(account);
      store.afterMessageRead = async (read) => {
        if (read !== 2) return;
        // The first chunk is in the index; a flush now must not save it.
        await call('flush', {});
        throw new Error('database went away');
      };

      const res = await call('rebuildFromCache', { account, includeBody: false });
      expect(res.ok).toBe(false);
      expect(savedIds(account)).toEqual(['old1', 'old2']);
      await call('flush', {});
      expect(savedIds(account)).toEqual(['old1', 'old2']);
      expect((await hitIds(account, 'saffron')).sort()).toEqual(['old1', 'old2']);
      expect(await hitIds(account, 'cardamom')).toEqual([]);
    } finally {
      setSearchMemoryProfile(false);
    }
  });
});

describe('search worker after an account is signed out', () => {
  const signOut = async (account: string) => {
    await call('dropAccount', { account });
    // Accounts.remove() then deletes the account's cache.
    store.searchIndex.delete(JSON.stringify([account, 'messages_v1']));
    store.indexMeta.delete(JSON.stringify([account, 'messages_v1']));
  };

  it('a flush does not write the deleted index back', async () => {
    const account = 'gone@x.test';
    await call('init', { account, includeBody: false });
    await call('index', { account, messages: [msg('g1', 'Lychee basket')] });
    await signOut(account);

    // Retiring the worker on the account switch, or the app being hidden.
    await call('flush', {});
    expect(store.searchIndex.has(JSON.stringify([account, 'messages_v1']))).toBe(false);
  });

  it('the debounced write and a late sync batch do not write it back either', async () => {
    const account = 'late@x.test';
    await call('init', { account, includeBody: false });
    await call('index', { account, messages: [msg('l1', 'Loquat jam')] });
    await signOut(account);
    syncPort.postMessage({
      action: 'index',
      payload: { account, includeBody: false, messages: [msg('l2', 'Loquat tart')] },
    });
    // Past the 800ms debounce and the 100ms batch delay.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await call('flush', {});
    expect(store.searchIndex.has(JSON.stringify([account, 'messages_v1']))).toBe(false);
  });

  it('signing in again indexes and saves the account as before', async () => {
    const account = 'again@x.test';
    await call('init', { account, includeBody: false });
    await signOut(account);
    await call('init', { account, includeBody: false });
    await call('index', { account, messages: [msg('a1', 'Medlar pie')] });
    await call('flush', {});
    expect(savedIds(account)).toEqual(['a1']);
  });
});
