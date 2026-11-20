/**
 * Changes made offline are queued and sent later, also by the service worker
 * (public/sw-sync.js) and by the desktop app's background sync
 * (src/utils/sync-core.js). The queued payload has the state from before the
 * change, and a queued "mark as read" was sent as "mark as unread": the
 * message turned unread again in every client once the queue ran. What
 * changed is sent next to the whole list, so the server applies only that,
 * and no folder, which the server takes as a move.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { createSyncCore } from '../../src/utils/sync-core.js';
import { DB_NAME } from '../../src/utils/db-constants.ts';

const queue = () => [
  {
    id: 'q1',
    type: 'toggleRead',
    payload: { messageId: 'm1', isUnread: true, flags: ['\\Flagged'], folder: 'INBOX' },
    apiBase: 'https://api.test',
    authHeader: 'Basic dGVzdA==',
    status: 'pending',
    retryCount: 0,
  },
  {
    id: 'q2',
    type: 'toggleStar',
    payload: { messageId: 'm2', isStarred: true, flags: ['\\Seen', '\\Flagged'], folder: 'INBOX' },
    apiBase: 'https://api.test',
    authHeader: 'Basic dGVzdA==',
    status: 'pending',
    retryCount: 0,
  },
  {
    id: 'q3',
    type: 'label',
    payload: { messageId: 'm3', labels: ['work'], previousLabels: ['work', 'urgent'] },
    apiBase: 'https://api.test',
    authHeader: 'Basic dGVzdA==',
    status: 'pending',
    retryCount: 0,
  },
  // the message a reply answered (answered-flag.ts)
  {
    id: 'q4',
    type: 'addFlags',
    payload: { messageId: 'm4', flags: ['\\Seen', '\\Answered'], add: ['\\Answered'] },
    apiBase: 'https://api.test',
    authHeader: 'Basic dGVzdA==',
    status: 'pending',
    retryCount: 0,
  },
  // its flags unknown here: only the addition
  {
    id: 'q5',
    type: 'addFlags',
    payload: { messageId: 'm5', flags: null, add: ['\\Answered'] },
    apiBase: 'https://api.test',
    authHeader: 'Basic dGVzdA==',
    status: 'pending',
    retryCount: 0,
  },
];

const expected = {
  'https://api.test/v1/messages/m1': { flags: ['\\Flagged', '\\Seen'], flags_add: ['\\Seen'] },
  'https://api.test/v1/messages/m2': { flags: ['\\Seen'], flags_remove: ['\\Flagged'] },
  'https://api.test/v1/messages/m3': { labels: ['work'], labels_remove: ['urgent'] },
  'https://api.test/v1/messages/m4': {
    flags: ['\\Seen', '\\Answered'],
    flags_add: ['\\Answered'],
  },
  'https://api.test/v1/messages/m5': { flags_add: ['\\Answered'] },
};

function seed(indexedDB, name, stores, entries = queue()) {
  return new Promise((resolvePromise, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const [store, keyPath] of stores) req.result.createObjectStore(store, { keyPath });
    };

    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({
        key: 'mutation_queue_me@example.com',
        value: entries,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => {
        db.close();
        resolvePromise();
      };

      tx.onerror = () => reject(tx.error);
    };

    req.onerror = () => reject(req.error);
  });
}

function sentBodies(fetch) {
  return Object.fromEntries(
    fetch.mock.calls.map(([url, options]) => [url, JSON.parse(options.body)]),
  );
}

function readQueue(indexedDB, name) {
  return new Promise((resolvePromise, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('meta').objectStore('meta').get('mutation_queue_me@example.com');
      get.onsuccess = () => {
        db.close();
        resolvePromise(get.result?.value);
      };

      get.onerror = () => reject(get.error);
    };

    req.onerror = () => reject(req.error);
  });
}

async function runDesktop(entries) {
  const indexedDB = new IDBFactory();
  await seed(indexedDB, DB_NAME, [['meta', 'key']], entries);
  const fetch = vi.fn(async () => ({ ok: true }));
  const core = createSyncCore({ postMessage: vi.fn(async () => {}), fetch, indexedDB });

  await core.processMutations();

  return { fetch, left: await readQueue(indexedDB, DB_NAME) };
}

async function runServiceWorker(entries) {
  const indexedDB = new IDBFactory();
  await seed(
    indexedDB,
    'webmail-cache-v1',
    [
      ['syncManifests', ['account', 'folder']],
      ['meta', 'key'],
    ],
    entries,
  );
  const fetch = vi.fn(async () => ({ ok: true }));
  const handlers = {};
  const self = {
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    location: { origin: 'https://mail.example.com' },
    registration: { scope: 'https://mail.example.com/' },
    clients: { matchAll: vi.fn(async () => []) },
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

  let done;
  handlers.sync({
    tag: 'mutation-queue',
    waitUntil: (promise) => {
      done = promise;
    },
  });
  await done;

  return { fetch, left: await readQueue(indexedDB, 'webmail-cache-v1') };
}

// Both of these replay over the Forward Email REST API with the URL and
// header stored on the entry. A change for an account on another kind of
// server must not go there: it is left for the tab, which sends it through
// that account's own backend.
const otherServer = () => [
  { ...queue()[0], id: 'i1', backend: 'imap' },
  { ...queue()[1], id: 'f1', backend: 'forwardemail' },
];

describe.each([
  ['desktop background sync (sync-core.js)', runDesktop],
  ['service worker background sync (sw-sync.js)', runServiceWorker],
])('queued changes sent in the background: %s', (_name, run) => {
  it('sends what changed next to the whole list, and no folder', async () => {
    const { fetch, left } = await run(queue());

    expect(sentBodies(fetch)).toEqual(expected);
    expect(left).toEqual([]);
  });

  it('leaves a change for another kind of server queued and unsent', async () => {
    const { fetch, left } = await run(otherServer());

    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.test/v1/messages/m2']);
    expect(left.map((m) => m.id)).toEqual(['i1']);
    expect(left[0]).toMatchObject({ status: 'pending', retryCount: 0 });
  });
});
