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
      equals: (value: unknown) => ({
        toArray: async () => {
          if (name === 'messages' && store.hold) await store.hold;
          return [...store[name].values()].filter(
            (row) => index === 'account' && row.account === value,
          );
        },
        count: async () =>
          [...store[name].values()].filter((row) => index === 'account' && row.account === value)
            .length,
      }),
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
});
