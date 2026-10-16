/**
 * The sync and search workers each hold a MessagePort to the db worker. When
 * the db worker is replaced, that port goes dead, so both clients must open a
 * new one to the replacement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Posted = { msg: Record<string, unknown>; transfer: unknown[] };

class FakeWorker {
  posted: Posted[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: Record<string, unknown>, transfer: unknown[] = []) {
    this.posted.push({ msg, transfer });
    // The search client awaits a reply to each request it sends.
    if (typeof msg.id === 'number') {
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result: null } }));
    }
  }
  terminate() {}
}

const env = vi.hoisted(() => ({
  dbWorker: null as unknown,
  useMainThread: false,
  listeners: [] as Array<(info: { worker: unknown; useMainThread: boolean }) => void>,
  workers: [] as unknown[],
  // Channels the main thread answers on, opened while the engine runs here.
  mainThreadPorts: 0,
}));

vi.mock('../../src/workers/sync.worker.ts?worker&inline', () => ({
  default: class {
    constructor() {
      const w = new FakeWorker();
      env.workers.push(w);
      return w;
    }
  },
}));
vi.mock('../../src/workers/search.worker.ts?worker&inline', () => ({
  default: class {
    constructor() {
      const w = new FakeWorker();
      env.workers.push(w);
      return w;
    }
  },
}));
vi.mock('../../src/utils/db.js', () => ({
  getDbWorker: () => env.dbWorker,
  initializeDatabase: vi.fn(async () => {}),
  isDbUsingMainThread: () => env.useMainThread,
}));
vi.mock('../../src/utils/db-worker-client.js', () => ({
  // Mirrors the real one: a channel to the db worker, or one this thread
  // answers on when the engine runs here.
  openDbPortForWorker: (workerId: string) => {
    const channel = new MessageChannel();
    if (env.useMainThread) {
      env.mainThreadPorts += 1;
      return channel.port2;
    }
    if (!env.dbWorker) return null;
    (env.dbWorker as FakeWorker).postMessage({ type: 'connectPort', workerId }, [channel.port1]);
    return channel.port2;
  },
  onDbWorkerChange: (listener: (info: { worker: unknown; useMainThread: boolean }) => void) => {
    env.listeners.push(listener);
    return () => {
      env.listeners = env.listeners.filter((l) => l !== listener);
    };
  },
}));
vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: (key: string) => (key === 'email' ? 'me@x.test' : null) },
}));
vi.mock('../../src/utils/auth.ts', () => ({ getAuthHeader: () => 'Basic bWU6cHc=' }));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoMode: () => false }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/config.js', () => ({ config: { apiBase: 'https://api.example.com' } }));

const announce = (worker: unknown, useMainThread = false) => {
  for (const listener of [...env.listeners]) listener({ worker, useMainThread });
};

const connectPortsTo = (dbWorker: FakeWorker, workerId: string) =>
  dbWorker.posted.filter((p) => p.msg.type === 'connectPort' && p.msg.workerId === workerId);

const portsHandedTo = (worker: FakeWorker, type: string) =>
  worker.posted.filter((p) => p.msg.type === type || p.msg.action === type);

beforeEach(() => {
  env.useMainThread = false;
});

describe('sync worker client', () => {
  it('opens a new db port when the db worker is replaced', async () => {
    const first = new FakeWorker();
    env.dbWorker = first;
    const { ensureSyncWorkerReady } = await import('../../src/utils/sync-worker-client.js');
    const syncWorker = (await ensureSyncWorkerReady()) as unknown as FakeWorker;

    expect(connectPortsTo(first, 'sync')).toHaveLength(1);
    expect(portsHandedTo(syncWorker, 'connectDbPort')).toHaveLength(1);

    const replacement = new FakeWorker();
    env.dbWorker = replacement;
    announce(replacement);
    await vi.waitFor(() => expect(connectPortsTo(replacement, 'sync')).toHaveLength(1));

    const handed = portsHandedTo(syncWorker, 'connectDbPort');
    expect(handed).toHaveLength(2);
    // The new port is the partner of the one given to the replacement db worker.
    expect(handed[1].transfer[0]).toBeInstanceOf(MessagePort);
    expect(handed[1].transfer[0]).not.toBe(handed[0].transfer[0]);
  });

  it('gives the sync worker a channel the main thread answers when the database falls back', async () => {
    const { getSyncWorker } = await import('../../src/utils/sync-worker-client.js');
    const syncWorker = getSyncWorker() as unknown as FakeWorker;
    const before = portsHandedTo(syncWorker, 'connectDbPort').length;

    // Its old port went to a db worker that is gone; without a new one every
    // database request it makes waits out its timeout.
    env.useMainThread = true;
    env.dbWorker = null;
    announce(null, true);
    await vi.waitFor(() =>
      expect(portsHandedTo(syncWorker, 'connectDbPort')).toHaveLength(before + 1),
    );
    expect(env.mainThreadPorts).toBe(1);
  });

  it('opens a fresh channel when the sync worker reports stalled requests', async () => {
    env.useMainThread = false;
    const db = new FakeWorker();
    env.dbWorker = db;
    const { getSyncWorker } = await import('../../src/utils/sync-worker-client.js');
    const syncWorker = getSyncWorker() as unknown as FakeWorker;
    const before = portsHandedTo(syncWorker, 'connectDbPort').length;

    syncWorker.onmessage?.({ data: { type: 'dbStalled', action: 'put' } });
    await vi.waitFor(() =>
      expect(portsHandedTo(syncWorker, 'connectDbPort')).toHaveLength(before + 1),
    );
    expect(connectPortsTo(db, 'sync')).toHaveLength(1);

    // A second report right after does not churn channels.
    syncWorker.onmessage?.({ data: { type: 'dbStalled', action: 'get' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(portsHandedTo(syncWorker, 'connectDbPort')).toHaveLength(before + 1);
  });
});

describe('search worker client', () => {
  it('opens a new db port when the db worker is replaced', async () => {
    const first = new FakeWorker();
    env.dbWorker = first;
    const { SearchWorkerClient } = await import('../../src/utils/search-worker-client.js');
    const client = new SearchWorkerClient();
    await client.ensureDbConnected();
    const searchWorker = client.getWorker() as unknown as FakeWorker;

    expect(connectPortsTo(first, 'search')).toHaveLength(1);
    expect(portsHandedTo(searchWorker, 'connectDbPort')).toHaveLength(1);

    const replacement = new FakeWorker();
    env.dbWorker = replacement;
    announce(replacement);
    expect(client.dbConnected).toBe(false);
    await client.ensureDbConnected();

    expect(connectPortsTo(replacement, 'search')).toHaveLength(1);
    expect(portsHandedTo(searchWorker, 'connectDbPort')).toHaveLength(2);
    expect(client.dbConnected).toBe(true);
    client.terminate();
  });

  it('marks the connection stale and waits when the db worker goes away', async () => {
    env.dbWorker = new FakeWorker();
    const { SearchWorkerClient } = await import('../../src/utils/search-worker-client.js');
    const client = new SearchWorkerClient();
    await client.ensureDbConnected();
    const searchWorker = client.getWorker() as unknown as FakeWorker;

    announce(null);

    expect(client.dbConnected).toBe(false);
    expect(portsHandedTo(searchWorker, 'connectDbPort')).toHaveLength(1);
    client.terminate();
  });
});
