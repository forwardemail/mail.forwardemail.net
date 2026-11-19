import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPendingSendQueue,
  type PendingSendRecord,
  type SubmitResult,
} from '../../src/utils/pending-send';

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): MemoryStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function record(overrides: Partial<PendingSendRecord> = {}): PendingSendRecord {
  return {
    id: 'outbox_1_abc',
    account: 'me@test.com',
    dueAt: 1_000,
    subject: 'Hello',
    emailData: { subject: 'Hello', text: 'body' },
    draftId: 'draft-1',
    serverDraftId: 'server-draft-1',
    sourceMessageId: null,
    archive: false,
    ownerAccount: null,
    replyToMessageId: null,
    replyToMessageFolder: null,
    sendAs: null,
    createdAt: 0,
    phase: 'held',
    ...overrides,
  };
}

function harness(now = 0) {
  let clock = now;
  let timer: (() => void) | null = null;
  const submit = vi.fn(async (_record: PendingSendRecord): Promise<SubmitResult> => ({ ok: true }));
  const deleteDrafts = vi.fn(async () => {});
  const onError = vi.fn();
  const storage = memoryStorage();
  const queue = createPendingSendQueue({
    storage,
    now: () => clock,
    setTimer: (fn) => {
      timer = fn;
    },
    clearTimer: () => {
      timer = null;
    },
    submit,
    deleteDrafts,
    onError,
  });
  return {
    queue,
    storage,
    submit,
    deleteDrafts,
    onError,
    fire: async () => {
      const fn = timer;
      timer = null;
      await fn?.();
    },
    setNow: (value: number) => {
      clock = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pending send queue', () => {
  it('submits an overdue send when the timer fires late, then deletes the draft', async () => {
    const h = harness(0);
    h.queue.enqueue(record({ dueAt: 30_000 }));
    expect(h.submit).not.toHaveBeenCalled();

    h.setNow(90_000);
    await h.fire();

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.deleteDrafts).toHaveBeenCalledTimes(1);
    expect(h.deleteDrafts).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-1' }));
    expect(h.queue.list()).toEqual([]);
  });

  it('survives the queue being stopped, and the next one sends what is overdue', async () => {
    const h = harness(0);
    h.queue.enqueue(record({ dueAt: 30_000 }));
    h.queue.stop();

    h.setNow(90_000);
    await h.fire();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.storage.getItem('webmail_pending_sends')).toContain('outbox_1_abc');

    const next = createPendingSendQueue({
      storage: h.storage,
      now: () => 90_000,
      setTimer: () => {},
      clearTimer: () => {},
      submit: h.submit,
      deleteDrafts: h.deleteDrafts,
      onError: h.onError,
    });
    await next.recover();

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.deleteDrafts).toHaveBeenCalledTimes(1);
  });

  it('recovers a send persisted by a previous launch', async () => {
    const storage = memoryStorage();
    const firstSubmit = vi.fn(async () => ({ ok: true }));
    const first = createPendingSendQueue({
      storage,
      now: () => 100_000,
      setTimer: () => {},
      clearTimer: () => {},
      submit: firstSubmit,
      deleteDrafts: async () => {},
      onError: () => {},
    });
    first.enqueue(record({ dueAt: 50_000 }));
    expect(firstSubmit).not.toHaveBeenCalled();

    const submit = vi.fn(async () => ({ ok: true }));
    const deleteDrafts = vi.fn(async () => {});
    const second = createPendingSendQueue({
      storage,
      now: () => 100_000,
      setTimer: () => {},
      clearTimer: () => {},
      submit,
      deleteDrafts,
      onError: () => {},
    });
    await second.recover();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(deleteDrafts).toHaveBeenCalledTimes(1);
    expect(second.list()).toEqual([]);
  });

  it('retries a send that was mid-flight when the page died', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'webmail_pending_sends',
      JSON.stringify([record({ phase: 'submitting', dueAt: 1 })]),
    );
    const submit = vi.fn(async () => ({ ok: true }));
    const queue = createPendingSendQueue({
      storage,
      now: () => 10,
      setTimer: () => {},
      clearTimer: () => {},
      submit,
      deleteDrafts: async () => {},
      onError: () => {},
    });
    await queue.recover();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and the queue row when the send fails', async () => {
    const h = harness(90_000);
    h.submit.mockResolvedValue({ ok: false, error: 'smtp down' });
    h.queue.enqueue(record({ dueAt: 30_000 }));

    await h.queue.flushDue();

    expect(h.deleteDrafts).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft-1' }),
      'smtp down',
    );
    expect(h.queue.list()).toHaveLength(1);
    expect(h.queue.list()[0].phase).toBe('held');
  });

  it('keeps the draft when the server permanently rejects the message', async () => {
    const h = harness(90_000);
    h.submit.mockResolvedValue({ ok: false, permanent: true, error: 'bad recipient' });
    h.queue.enqueue(record({ dueAt: 30_000 }));

    await h.queue.flushDue();

    expect(h.deleteDrafts).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft-1' }),
      'bad recipient',
    );
    expect(h.queue.list()).toEqual([]);
  });

  it('undo cancels the send and does not delete the draft', async () => {
    const h = harness(0);
    h.queue.enqueue(record({ dueAt: 30_000 }));

    const removed = h.queue.cancel('outbox_1_abc');

    expect(removed?.draftId).toBe('draft-1');
    expect(h.deleteDrafts).not.toHaveBeenCalled();
    h.setNow(90_000);
    await h.fire();
    await h.queue.flushDue();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('sends a future hold immediately when asked to flush everything', async () => {
    const h = harness(0);
    h.queue.enqueue(record({ dueAt: 30_000 }));

    await h.queue.flushAll();

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.deleteDrafts).toHaveBeenCalledTimes(1);
  });

  it('does not send a future hold just because the window was hidden', async () => {
    const h = harness(0);
    h.queue.enqueue(record({ dueAt: 30_000 }));

    h.queue.keepAliveWhileHidden();

    expect(h.submit).not.toHaveBeenCalled();
    expect(h.queue.list()).toHaveLength(1);
  });
});
