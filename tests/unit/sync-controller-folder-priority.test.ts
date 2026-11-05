import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, type Readable, type Writable } from 'svelte/store';

// The folder the user opens syncs next: its metadata ahead of everything
// queued, its backfill ahead of other folders' backfills.
const hoisted = vi.hoisted(() => {
  // Backfill batches each folder has left; one when not set.
  const batches: Record<string, number> = {};
  const resolvers: Array<() => void> = [];
  const sendSyncTask = vi.fn(
    (task: { type: string; folder: string }) =>
      new Promise((resolve) => {
        let result = {};
        if (task.type === 'backfill') {
          batches[task.folder] = (batches[task.folder] ?? 1) - 1;
          result = { done: batches[task.folder] <= 0 };
        }
        resolvers.push(() => resolve(result));
      }),
  );
  return { batches, resolvers, sendSyncTask };
});

vi.mock('../../src/utils/sync-helpers.ts', () => ({
  accountKey: (a: string) => (a || '').toLowerCase(),
}));
vi.mock('../../src/utils/sync-settings.js', () => ({
  getSyncSettings: () => ({ pageSize: 50, maxHeaders: 500, scope: 'all', bodyLimit: 100 }),
  pickFoldersForScope: (folders: unknown[]) => folders,
}));
vi.mock('../../src/stores/mailboxActions', async () => {
  const { writable } = await import('svelte/store');
  return { syncProgress: writable({ active: false, folder: '' }) };
});
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncTask: hoisted.sendSyncTask,
  onSyncProgress: vi.fn(() => () => {}),
  resetSyncWorkerReady: vi.fn(),
  connectSyncSearchPort: vi.fn(),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/stores/mailboxStore', () => ({
  getPendingDeleteIds: () => [],
  getPendingFlagMutations: () => ({}),
}));
vi.mock('../../src/workers/sync-pure.ts', () => ({
  nextBackfillDecision: (result: { done?: boolean }) => ({
    requeue: result?.done === false,
    noProgressStreak: 0,
  }),
}));

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const sent = () =>
  hoisted.sendSyncTask.mock.calls.map((call) => {
    const task = (call as unknown[])[0] as { type: string; folder: string };
    return `${task.type}:${task.folder}`;
  });

describe('sync-controller folder switch priority', () => {
  let startInitialSync: (account: string, folders: unknown[], options?: unknown) => void;
  let syncFolderOnDemand: (folder: string, account: string) => void;
  let syncSummary: Readable<string>;
  let syncProgress: Writable<{ active: boolean; folder: string }>;

  beforeEach(async () => {
    vi.resetModules();
    hoisted.resolvers.length = 0;
    hoisted.sendSyncTask.mockClear();
    for (const key of Object.keys(hoisted.batches)) delete hoisted.batches[key];
    ({ startInitialSync, syncFolderOnDemand, syncSummary } =
      await import('../../src/utils/sync-controller.js'));
    ({ syncProgress } = (await import('../../src/stores/mailboxActions')) as never);
  });

  const finishCurrent = async () => {
    hoisted.resolvers.shift()?.();
    await tick();
  };
  const drain = async () => {
    for (let i = 0; i < 40 && hoisted.resolvers.length; i++) await finishCurrent();
  };

  afterEach(drain);

  const folders = (...paths: string[]) => paths.map((path) => ({ path }));

  it('runs the opened folder next when several folders are queued, and shows it', async () => {
    startInitialSync('a@b.com', folders('INBOX', 'A', 'B', 'C'));
    await tick();

    syncFolderOnDemand('C', 'a@b.com');
    await finishCurrent();

    // INBOX was running and finishes; C goes ahead of A and B.
    expect(sent()).toEqual(['metadata:INBOX', 'metadata:C']);
    expect(get(syncSummary)).toBe('Syncing C');
    expect(get(syncProgress)).toMatchObject({ active: true, folder: 'C' });

    await drain();
    expect(sent().filter((t) => t === 'metadata:C')).toHaveLength(1);
  });

  it("runs the opened folder between batches of another folder's backfill", async () => {
    hoisted.batches.INBOX = 3;
    startInitialSync('a@b.com', folders('INBOX', 'A', 'C'));
    await tick();
    await finishCurrent();
    await finishCurrent();
    await finishCurrent();
    // The first of INBOX's three backfill batches is running; A and C wait.
    expect(sent().at(-1)).toBe('backfill:INBOX');

    syncFolderOnDemand('C', 'a@b.com');
    await drain();

    expect(sent().slice(3)).toEqual([
      'backfill:INBOX',
      'metadata:C',
      'backfill:C',
      'backfill:A',
      'backfill:INBOX',
      'backfill:INBOX',
    ]);
  });

  it('runs only the last of several quickly opened folders first, without duplicates', async () => {
    startInitialSync('a@b.com', folders('INBOX', 'A', 'B', 'C', 'D'));
    await tick();

    syncFolderOnDemand('A', 'a@b.com');
    syncFolderOnDemand('B', 'a@b.com');
    syncFolderOnDemand('C', 'a@b.com');
    await finishCurrent();
    expect(sent()).toEqual(['metadata:INBOX', 'metadata:C']);

    await drain();
    // Every folder's metadata and backfill ran, each once.
    expect(sent().filter((t) => t.startsWith('metadata:'))).toHaveLength(5);
    expect(sent().filter((t) => t.startsWith('backfill:'))).toHaveLength(5);
    expect(new Set(sent()).size).toBe(sent().length);
  });

  it("bumps only the synced account's folder, and the current folder after a switch", async () => {
    startInitialSync('a@b.com', folders('INBOX', 'A', 'B'));
    await tick();

    // A folder opened for another account leaves this account's queue alone.
    syncFolderOnDemand('B', 'other@b.com');
    await finishCurrent();
    expect(sent()).toEqual(['metadata:INBOX', 'metadata:A']);

    // Switching account: the folder on screen syncs first once the old
    // account's running task is done.
    startInitialSync('c@d.com', folders('INBOX', 'Work'), { folder: 'Work' });
    await finishCurrent();
    expect(sent().slice(2, 3)).toEqual(['metadata:Work']);
    expect(hoisted.sendSyncTask.mock.calls.at(-1)?.[0]).toMatchObject({ account: 'c@d.com' });
  });
});
