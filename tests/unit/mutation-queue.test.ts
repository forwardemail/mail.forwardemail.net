import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';

// --- hoisted mocks ----------------------------------------------------------
const { metaGetMock, metaPutMock, localGetMock, remoteRequestMock, isOnlineMock, warnMock } =
  vi.hoisted(() => ({
    metaGetMock: vi.fn(),
    metaPutMock: vi.fn(),
    localGetMock: vi.fn(),
    remoteRequestMock: vi.fn(),
    isOnlineMock: vi.fn(),
    warnMock: vi.fn(),
  }));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      get: (...args: unknown[]) => metaGetMock(...args),
      put: (...args: unknown[]) => metaPutMock(...args),
    },
  },
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (...args: unknown[]) => localGetMock(...args) },
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: (...args: unknown[]) => remoteRequestMock(...args),
  },
}));

vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: vi.fn(() => 'Bearer test-token'),
}));

vi.mock('../../src/config', () => ({
  config: { apiBase: 'https://api.test' },
}));

vi.mock('../../src/utils/logger.ts', () => ({
  warn: (...args: unknown[]) => warnMock(...args),
}));

vi.mock('../../src/utils/network-status', () => ({
  isOnline: (...args: unknown[]) => isOnlineMock(...args),
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  swReadyWithTimeout: vi.fn().mockResolvedValue(null),
}));

// In-memory store mirroring the meta-table key/value shape.
const metaStore = new Map<string, { key: string; value: unknown; updatedAt: number }>();

async function drainMicrotasks() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('mutation-queue', () => {
  let queueModule: typeof import('../../src/utils/mutation-queue');

  beforeEach(async () => {
    vi.clearAllMocks();
    metaStore.clear();

    localGetMock.mockImplementation((key: string) => (key === 'email' ? 'user@example.com' : null));
    isOnlineMock.mockReturnValue(true);

    metaGetMock.mockImplementation(async (key: string) => metaStore.get(key) ?? null);
    metaPutMock.mockImplementation(
      async (record: { key: string; value: unknown; updatedAt: number }) => {
        metaStore.set(record.key, record);
      },
    );
    remoteRequestMock.mockResolvedValue({});

    vi.resetModules();
    queueModule = await import('../../src/utils/mutation-queue');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues a mutation under the current account', async () => {
    isOnlineMock.mockReturnValue(false); // keep it pending so we can inspect
    const mutation = await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });

    expect(mutation.type).toBe('toggleRead');
    expect(mutation.payload.account).toBe('user@example.com');
    expect(mutation.status).toBe('pending');
    expect(mutation.authHeader).toBe('Bearer test-token');
    expect(mutation.apiBase).toBe('https://api.test');

    const record = metaStore.get('mutation_queue_user@example.com');
    expect(record?.value).toHaveLength(1);
    expect(get(queueModule.mutationQueueCount)).toBe(1);
  });

  it('drains the queue immediately when online and executes in order', async () => {
    await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });
    await queueModule.queueMutation('toggleStar', {
      messageId: 'm2',
      isStarred: false,
      flags: [],
      folder: 'INBOX',
    });

    await drainMicrotasks();

    expect(remoteRequestMock).toHaveBeenCalledTimes(2);
    // Both should be completed and removed from the persisted queue.
    const record = metaStore.get('mutation_queue_user@example.com');
    expect(record?.value).toEqual([]);
    expect(get(queueModule.mutationQueueCount)).toBe(0);
  });

  it('retries transient failures with exponential backoff', async () => {
    vi.useFakeTimers();
    remoteRequestMock.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});

    await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });
    await drainMicrotasks();

    // First attempt fails — mutation goes back to pending with a nextRetryAt.
    const afterFailure = metaStore.get('mutation_queue_user@example.com')?.value as Array<{
      status: string;
      retryCount: number;
      nextRetryAt: number;
    }>;
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].status).toBe('pending');
    expect(afterFailure[0].retryCount).toBe(1);
    expect(afterFailure[0].nextRetryAt).toBeGreaterThan(Date.now());

    // Advance past the backoff window and retry.
    vi.advanceTimersByTime(60_000);
    await queueModule.processMutationQueue();
    await drainMicrotasks();

    expect(remoteRequestMock).toHaveBeenCalledTimes(2);
    const finalState = metaStore.get('mutation_queue_user@example.com')?.value;
    expect(finalState).toEqual([]);
  });

  it('gives up after MAX_RETRIES and emits a mutation-queue-failed event', async () => {
    remoteRequestMock.mockRejectedValue(new Error('boom'));
    const listener = vi.fn();
    window.addEventListener('mutation-queue-failed', listener as unknown as (ev: Event) => void);

    await queueModule.queueMutation('delete', {
      messageId: 'm1',
      folder: 'INBOX',
    });

    // Re-invoke processing five times to exhaust retries (backoff check
    // bypassed by manipulating nextRetryAt directly).
    for (let i = 0; i < 6; i += 1) {
      const record = metaStore.get('mutation_queue_user@example.com');
      if (record) {
        (record.value as Array<{ nextRetryAt?: number }>).forEach((m) => {
          delete m.nextRetryAt;
        });
      }
      await queueModule.processMutationQueue();
      await drainMicrotasks();
    }

    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ count: 1 });

    window.removeEventListener('mutation-queue-failed', listener as unknown as (ev: Event) => void);
  });

  it('skips execution when offline and leaves queue intact', async () => {
    isOnlineMock.mockReturnValue(false);

    await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });
    await queueModule.processMutationQueue();

    expect(remoteRequestMock).not.toHaveBeenCalled();
    const record = metaStore.get('mutation_queue_user@example.com');
    expect(record?.value).toHaveLength(1);
  });

  it('preserves per-account isolation', async () => {
    isOnlineMock.mockReturnValue(false);

    localGetMock.mockImplementation((key: string) =>
      key === 'email' ? 'alice@example.com' : null,
    );
    await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });

    localGetMock.mockImplementation((key: string) => (key === 'email' ? 'bob@example.com' : null));
    await queueModule.queueMutation('toggleStar', {
      messageId: 'm2',
      isStarred: false,
      flags: [],
      folder: 'INBOX',
    });

    expect(metaStore.get('mutation_queue_alice@example.com')?.value).toHaveLength(1);
    expect(metaStore.get('mutation_queue_bob@example.com')?.value).toHaveLength(1);
  });

  it('constructs the correct API path per mutation type', async () => {
    const cases: Array<{
      type: Parameters<typeof queueModule.queueMutation>[0];
      payload: Record<string, unknown>;
      expectedMethod: string;
      expectedPathFragment: string;
      expectedBody?: Record<string, unknown>;
    }> = [
      {
        type: 'toggleRead',
        payload: { messageId: 'm1', isUnread: true, flags: [], folder: 'INBOX' },
        expectedMethod: 'PUT',
        expectedPathFragment: '/v1/messages/m1',
      },
      {
        type: 'move',
        payload: { messageId: 'm2', targetFolder: 'Archive' },
        expectedMethod: 'PUT',
        expectedPathFragment: '/v1/messages/m2',
        expectedBody: { folder: 'Archive' },
      },
      {
        type: 'delete',
        payload: { messageId: 'm3', permanent: true },
        expectedMethod: 'DELETE',
        expectedPathFragment: '/v1/messages/m3?permanent=1',
      },
      {
        type: 'label',
        payload: { messageId: 'm4', labels: ['work', 'urgent'] },
        expectedMethod: 'PUT',
        expectedPathFragment: '/v1/messages/m4',
        expectedBody: { labels: ['work', 'urgent'] },
      },
    ];

    for (const c of cases) {
      remoteRequestMock.mockClear();
      await queueModule.queueMutation(c.type, c.payload);
      await drainMicrotasks();

      expect(remoteRequestMock).toHaveBeenCalledTimes(1);
      const [, body, opts] = remoteRequestMock.mock.calls[0];
      expect(opts.method).toBe(c.expectedMethod);
      expect(opts.pathOverride).toContain(c.expectedPathFragment);
      if (c.expectedBody) {
        expect(body).toMatchObject(c.expectedBody);
      }
    }
  });

  it('clearCompletedMutations prunes completed entries but keeps pending ones', async () => {
    isOnlineMock.mockReturnValue(false);
    await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });

    // Hand-roll a completed entry alongside the pending one.
    const key = 'mutation_queue_user@example.com';
    const existing = metaStore.get(key)!;
    (existing.value as Array<Record<string, unknown>>).push({
      id: 'done-1',
      type: 'toggleRead',
      payload: {},
      status: 'completed',
      retryCount: 0,
      createdAt: Date.now(),
    });

    await queueModule.clearCompletedMutations();
    const after = metaStore.get(key)?.value as Array<{ status: string }>;
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pending');
  });

  it('getMutationQueueCount reflects non-completed mutations', async () => {
    isOnlineMock.mockReturnValue(false);
    await queueModule.queueMutation('toggleRead', {
      messageId: 'm1',
      isUnread: true,
      flags: [],
      folder: 'INBOX',
    });

    const count = await queueModule.getMutationQueueCount();
    expect(count).toBe(1);
    expect(get(queueModule.mutationQueueCount)).toBe(1);
  });
});
