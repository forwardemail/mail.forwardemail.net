/**
 * The service worker (public/sw-sync.js) and the desktop shim
 * (src/utils/sync-core.js) send changes queued offline. The tab drains the
 * same queue record, so a processor must not send a change another one is
 * sending, must not drop a change queued while it runs, and must write back
 * only the entries it handled.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncCore } from '../../src/utils/sync-core.js';
import { DB_NAME } from '../../src/utils/db-constants.ts';

const KEY = 'mutation_queue_me@example.com';

const entry = (id, type, payload, extra = {}) => ({
  id,
  type,
  payload: { account: 'me@example.com', ...payload },
  apiBase: 'https://api.test',
  authHeader: 'Basic bWU=',
  status: 'pending',
  retryCount: 0,
  ...extra,
});

// Web Locks as browsers implement them: one holder per name, the rest queue.
function fakeLocks() {
  const tails = new Map();
  return {
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const run = previous.then(() => callback());
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  };
}

function openMeta(indexedDB, name) {
  return new Promise((resolvePromise, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'key' });
      req.result.createObjectStore('syncManifests', { keyPath: ['account', 'folder'] });
    };
    req.onsuccess = () => resolvePromise(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function seed(indexedDB, name, records) {
  const db = await openMeta(indexedDB, name);
  await new Promise((resolvePromise, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    for (const [key, value] of Object.entries(records)) {
      tx.objectStore('meta').put({ key, value, updatedAt: 0 });
    }
    tx.oncomplete = resolvePromise;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readKey(indexedDB, name, key) {
  const db = await openMeta(indexedDB, name);
  const record = await new Promise((resolvePromise, reject) => {
    const req = db.transaction('meta').objectStore('meta').get(key);
    req.onsuccess = () => resolvePromise(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record?.value;
}

// What the tab's queueMutation does: append under the write lock.
async function appendEntry(indexedDB, name, key, mutation) {
  const db = await openMeta(indexedDB, name);
  await new Promise((resolvePromise, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const req = store.get(key);
    req.onsuccess = () => {
      store.put({ key, value: [...(req.result?.value || []), mutation], updatedAt: 0 });
    };
    tx.oncomplete = resolvePromise;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const response = (status) => ({ ok: status >= 200 && status < 300, status });

// One service worker instance running public/sw-sync.js.
function loadServiceWorker({ indexedDB, fetch, locks }) {
  const handlers = {};
  const self = {
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    location: { origin: 'https://mail.example.com' },
    registration: { scope: 'https://mail.example.com/' },
    clients: { matchAll: vi.fn(async () => []) },
    navigator: locks ? { locks } : {},
  };
  vm.runInNewContext(readFileSync(resolve(process.cwd(), 'public/sw-sync.js'), 'utf8'), {
    self,
    URL,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch,
    indexedDB,
  });
  return () => {
    let done;
    handlers.sync({
      tag: 'mutation-queue',
      waitUntil: (promise) => {
        done = promise;
      },
    });
    return done;
  };
}

const processors = [
  {
    name: 'service worker (sw-sync.js)',
    dbName: 'webmail-cache-v1',
    create: ({ indexedDB, fetch, locks }) => loadServiceWorker({ indexedDB, fetch, locks }),
  },
  {
    name: 'desktop shim (sync-core.js)',
    dbName: DB_NAME,
    create: ({ indexedDB, fetch, locks }) => {
      if (locks) vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
      const core = createSyncCore({ postMessage: vi.fn(async () => {}), fetch, indexedDB });
      return () => core.processMutations();
    },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(processors)('$name', ({ dbName, create }) => {
  it('keeps a change queued while it was sending the queue', async () => {
    const indexedDB = new IDBFactory();
    await seed(indexedDB, dbName, {
      [KEY]: [entry('a', 'toggleStar', { messageId: 'm1', isStarred: false, flags: [] })],
    });
    const fetch = vi.fn(async () => {
      await appendEntry(
        indexedDB,
        dbName,
        KEY,
        entry('late', 'toggleRead', { messageId: 'm9', isUnread: true, flags: [] }),
      );
      return response(200);
    });

    await create({ indexedDB, fetch })();

    expect((await readKey(indexedDB, dbName, KEY)).map((m) => m.id)).toEqual(['late']);
  });

  it('sends each change once when two processors start together', async () => {
    const indexedDB = new IDBFactory();
    await seed(indexedDB, dbName, {
      [KEY]: [
        entry('a', 'toggleStar', { messageId: 'm1', isStarred: false, flags: [] }),
        entry('b', 'delete', { messageId: 'm2' }),
      ],
    });
    const locks = fakeLocks();
    const fetch = vi.fn(async () => response(200));

    const first = create({ indexedDB, fetch, locks });
    const second = create({ indexedDB, fetch, locks });
    await Promise.all([first(), second()]);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.test/v1/messages/m1',
      'https://api.test/v1/messages/m2',
    ]);
    expect(await readKey(indexedDB, dbName, KEY)).toEqual([]);
  });

  it('counts a 404 on a queued delete as done', async () => {
    const indexedDB = new IDBFactory();
    await seed(indexedDB, dbName, { [KEY]: [entry('a', 'delete', { messageId: 'm1' })] });
    const fetch = vi.fn(async () => response(404));

    await create({ indexedDB, fetch })();

    expect(await readKey(indexedDB, dbName, KEY)).toEqual([]);
  });

  it('holds a later change to a message while an earlier one waits out its backoff', async () => {
    const indexedDB = new IDBFactory();
    await seed(indexedDB, dbName, {
      [KEY]: [
        entry(
          'a',
          'toggleRead',
          { messageId: 'm1', isUnread: true, flags: [] },
          { retryCount: 1, nextRetryAt: Date.now() + 60_000 },
        ),
        entry('b', 'toggleRead', { messageId: 'm1', isUnread: false, flags: ['\\Seen'] }),
        entry('c', 'toggleStar', { messageId: 'm2', isStarred: false, flags: [] }),
      ],
    });
    const fetch = vi.fn(async () => response(200));

    await create({ indexedDB, fetch })();

    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.test/v1/messages/m2']);
    expect((await readKey(indexedDB, dbName, KEY)).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('spends a retry on a server error and keeps the entry for later', async () => {
    const indexedDB = new IDBFactory();
    await seed(indexedDB, dbName, {
      [KEY]: [entry('a', 'move', { messageId: 'm1', targetFolder: 'Archive' })],
    });
    const fetch = vi.fn(async () => response(503));

    await create({ indexedDB, fetch })();

    const [stored] = await readKey(indexedDB, dbName, KEY);
    expect(stored).toMatchObject({ id: 'a', status: 'pending', retryCount: 1 });
    expect(stored.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('leaves an entry without stored credentials to a tab, and drops one with no account', async () => {
    const indexedDB = new IDBFactory();
    const noAccount = { messageId: 'm2' };
    await seed(indexedDB, dbName, {
      [KEY]: [entry('a', 'delete', { messageId: 'm1' }, { authHeader: '' })],
      mutation_queue_default: [{ ...entry('x', 'delete', {}), payload: noAccount }],
    });
    const fetch = vi.fn(async () => response(200));

    await create({ indexedDB, fetch })();

    expect(fetch).not.toHaveBeenCalled();
    expect(await readKey(indexedDB, dbName, KEY)).toMatchObject([
      { id: 'a', status: 'pending', retryCount: 0 },
    ]);
    expect(await readKey(indexedDB, dbName, 'mutation_queue_default')).toEqual([]);
  });
});
