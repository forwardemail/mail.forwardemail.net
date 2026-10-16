/**
 * The offline mutation queue in the tab (src/utils/mutation-queue.js):
 * changes to one message go out in the order they were made, a message that
 * is already gone does not count as a failure, every change is sent with its
 * own account's credentials, and a newer direct change can replace a queued
 * one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  meta: new Map<string, { key: string; value: unknown; updatedAt: number }>(),
  active: 'me@example.com' as string | null,
  online: true,
  request: vi.fn(),
  authFor: vi.fn(),
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      get: async (key: string) => h.meta.get(key) ?? null,
      put: async (record: { key: string; value: unknown; updatedAt: number }) => {
        h.meta.set(record.key, structuredClone(record));
      },
    },
  },
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? h.active : null) },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args: unknown[]) => h.request(...args) },
}));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: () => 'Basic active',
  getAuthHeaderForAccount: (account: string) => h.authFor(account),
}));
vi.mock('../../src/config', () => ({ config: { apiBase: 'https://api.test' } }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  swReadyWithTimeout: vi.fn().mockResolvedValue(null),
}));

const KEY = 'mutation_queue_me@example.com';

function entry(id: string, type: string, payload: Record<string, unknown>, extra = {}) {
  return {
    id,
    type,
    payload: { account: 'me@example.com', ...payload },
    status: 'pending',
    retryCount: 0,
    createdAt: 1,
    apiBase: 'https://api.test',
    authHeader: 'Basic stored',
    ...extra,
  };
}

function seed(key: string, value: unknown[]) {
  h.meta.set(key, { key, value, updatedAt: 0 });
}

function stored(key = KEY) {
  return (h.meta.get(key)?.value ?? []) as Array<Record<string, unknown>>;
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

let queue: typeof import('../../src/utils/mutation-queue');

beforeEach(async () => {
  h.meta.clear();
  h.active = 'me@example.com';
  h.online = true;
  h.request.mockReset().mockResolvedValue({});
  h.authFor.mockReset().mockImplementation((account: string) => `Basic ${account}`);
  vi.resetModules();
  queue = await import('../../src/utils/mutation-queue');
});

describe('order of queued changes to one message', () => {
  it('holds a later change while an earlier change to the same message waits out its backoff', async () => {
    seed(KEY, [
      // mark as read, failed once and waiting
      entry(
        'a',
        'toggleRead',
        { messageId: 'm1', isUnread: true, flags: [] },
        {
          retryCount: 1,
          nextRetryAt: Date.now() + 60_000,
        },
      ),
      // then mark as unread again
      entry('b', 'toggleRead', { messageId: 'm1', isUnread: false, flags: ['\\Seen'] }),
      entry('c', 'toggleStar', { messageId: 'm2', isStarred: false, flags: [] }),
    ]);

    await queue.processMutationQueue();

    const paths = h.request.mock.calls.map(([, , options]) => options.pathOverride);
    expect(paths).toEqual(['/v1/messages/m2']);
    expect(stored().map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('holds later changes to a message whose earlier change just failed', async () => {
    seed(KEY, [
      entry('a', 'move', { messageId: 'm1', targetFolder: 'Archive' }),
      entry('b', 'move', { messageId: 'm1', targetFolder: 'Trash' }),
    ]);
    h.request.mockRejectedValueOnce(httpError(503));

    await queue.processMutationQueue();

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(stored().map((m) => [m.id, m.retryCount])).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
  });
});

describe('a queued change on a message that is gone', () => {
  it('counts a 404 on a queued delete as done, with no revert', async () => {
    const reverted = vi.fn();
    window.addEventListener('mailbox-mutation-permanently-failed', reverted);
    seed(KEY, [
      entry('a', 'delete', { messageId: 'm1', internalId: 'm1', subject: 'Old', folder: 'INBOX' }),
      entry('b', 'toggleRead', { messageId: 'm2', isUnread: true, flags: [] }),
    ]);
    h.request.mockRejectedValueOnce(httpError(404)).mockRejectedValueOnce(httpError(404));

    await queue.processMutationQueue();

    expect(stored()).toEqual([]);
    expect(reverted).not.toHaveBeenCalled();
    window.removeEventListener('mailbox-mutation-permanently-failed', reverted);
  });
});

describe('credentials of the queued account', () => {
  it('sends each change as its own account, even after a switch mid-run', async () => {
    seed(KEY, [
      entry('a', 'toggleStar', { messageId: 'm1', isStarred: false, flags: [] }),
      entry('b', 'toggleStar', { messageId: 'm2', isStarred: false, flags: [] }),
    ]);
    h.request.mockImplementationOnce(async () => {
      h.active = 'other@example.com';
      return {};
    });

    await queue.processMutationQueue();

    expect(h.request.mock.calls.map(([, , options]) => options.authHeader)).toEqual([
      'Basic me@example.com',
      'Basic me@example.com',
    ]);
  });

  it('keeps a change waiting, without spending a retry, while its account has no credentials', async () => {
    seed(KEY, [entry('a', 'toggleStar', { messageId: 'm1', isStarred: false, flags: [] })]);
    h.authFor.mockReturnValue('');

    await queue.processMutationQueue();

    expect(h.request).not.toHaveBeenCalled();
    expect(stored()).toMatchObject([{ id: 'a', status: 'pending', retryCount: 0 }]);
  });

  it('drops a change whose account cannot be told', async () => {
    h.active = null;
    const { payload, ...rest } = entry('a', 'delete', { messageId: 'm1' });
    const { account: _account, ...noAccount } = payload;
    seed('mutation_queue_default', [{ ...rest, payload: noAccount }]);

    await queue.processMutationQueue();

    expect(h.request).not.toHaveBeenCalled();
    expect(stored('mutation_queue_default')).toEqual([]);
  });

  it('stores the queued account credentials with an entry for the service worker', async () => {
    h.online = false;
    const mutation = await queue.queueMutation('toggleRead', { messageId: 'm1', isUnread: true });
    expect(mutation.authHeader).toBe('Basic me@example.com');
    expect(h.authFor).toHaveBeenCalledWith('me@example.com');
  });
});

describe('supersedeQueuedMutations', () => {
  it('drops a queued read change that a newer direct change replaces, and nothing else', async () => {
    seed(KEY, [
      entry('a', 'toggleRead', { messageId: 'm1', internalId: 'm1', isUnread: true }),
      entry('b', 'toggleStar', { messageId: 'm1', isStarred: false }),
      entry('c', 'toggleRead', { messageId: 'm2', isUnread: true }),
    ]);

    const removed = await queue.supersedeQueuedMutations({
      account: 'me@example.com',
      messageIds: ['m1'],
      type: 'toggleRead',
    });

    expect(removed.map((m) => m.id)).toEqual(['a']);
    expect(stored().map((m) => m.id)).toEqual(['b', 'c']);
  });

  it("works on the named account's queue, not the active one", async () => {
    seed('mutation_queue_other@example.com', [
      entry('a', 'toggleRead', { messageId: 'm1', account: 'other@example.com' }),
    ]);
    seed(KEY, [entry('b', 'toggleRead', { messageId: 'm1' })]);

    await queue.supersedeQueuedMutations({
      account: 'other@example.com',
      messageIds: ['m1'],
      type: ['toggleRead'],
    });

    expect(stored('mutation_queue_other@example.com')).toEqual([]);
    expect(stored().map((m) => m.id)).toEqual(['b']);
  });
});

describe('queueOrRevertFailedChange', () => {
  const payload = { messageId: 'm1', internalId: 'm1', isUnread: true, flags: [] };

  it('queues a change that failed for a reason that can pass, for the account it was made in', async () => {
    h.online = false;
    h.active = 'other@example.com';
    const result = await queue.queueOrRevertFailedChange(
      'toggleRead',
      payload,
      new TypeError('Failed to fetch'),
      { account: 'me@example.com' },
    );
    expect(result).toBe('queued');
    expect(stored()).toMatchObject([{ type: 'toggleRead', payload: { messageId: 'm1' } }]);
  });

  it('asks for a revert when the server refused the change', async () => {
    const result = await queue.queueOrRevertFailedChange('toggleRead', payload, httpError(400), {
      account: 'me@example.com',
    });
    expect(result).toBe('revert');
    expect(stored()).toEqual([]);
  });

  it('does neither for a message that is gone', async () => {
    const result = await queue.queueOrRevertFailedChange('toggleRead', payload, httpError(404), {
      account: 'me@example.com',
    });
    expect(result).toBe('gone');
    expect(stored()).toEqual([]);
  });
});
