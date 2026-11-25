/**
 * The controller is what turns a due record into a send. A record whose
 * outbox row has been removed (Undo, sign-out) must not put the message back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  outbox: new Map<string, Record<string, unknown>>(),
  queueEmail: vi.fn(),
  commitHeldSend: vi.fn(),
  deleteDraft: vi.fn(),
}));

vi.mock('../../src/utils/outbox-service', () => ({
  getOutboxItem: async (id: string) => h.outbox.get(id),
  queueEmail: (...args: unknown[]) => h.queueEmail(...args),
  commitHeldSend: (...args: unknown[]) => h.commitHeldSend(...args),
}));
vi.mock('../../src/utils/draft-service', () => ({
  deleteDraft: (...args: unknown[]) => h.deleteDraft(...args),
}));

import {
  adoptPendingSend,
  startPendingSendController,
} from '../../src/utils/pending-send-controller';
import {
  getAttachedPendingSendQueue,
  PENDING_SEND_STORAGE_KEY,
} from '../../src/utils/pending-send';

const email = { to: ['x@y.com'], subject: 'Hi', text: 'the secret plan' };

function pending(id: string) {
  return {
    id,
    account: 'me@test.com',
    dueAt: Date.now() - 1,
    subject: 'Hi',
    emailData: email,
    draftId: null,
    serverDraftId: null,
    sourceMessageId: null,
    createdAt: Date.now() - 10_000,
    phase: 'held' as const,
  };
}

const failures: unknown[] = [];
globalThis.addEventListener('pending-send-failed', (event) => {
  failures.push((event as CustomEvent).detail);
});

const queueIsEmpty = () =>
  vi.waitFor(() => expect(getAttachedPendingSendQueue()?.list()).toEqual([]));

beforeEach(async () => {
  await startPendingSendController();
  h.outbox.clear();
  h.queueEmail.mockReset().mockImplementation(async (data, options) => {
    const row = { id: options.id, account: options.account, status: 'pending', emailData: data };
    h.outbox.set(options.id, row);
    return row;
  });
  h.commitHeldSend.mockReset().mockResolvedValue({ ok: true });
  h.deleteDraft.mockReset().mockResolvedValue(undefined);
  failures.length = 0;
});

describe('pending send controller', () => {
  it('does not put back a message whose outbox row was removed', async () => {
    h.outbox.set('outbox_1_abc', { id: 'outbox_1_abc', status: 'pending', emailData: email });
    await adoptPendingSend(pending('outbox_1_abc'));
    // Undo, from another tab: the row goes and this queue is not told
    h.outbox.delete('outbox_1_abc');

    globalThis.__feFlushPendingSends?.();
    await queueIsEmpty();

    expect(h.queueEmail).not.toHaveBeenCalled();
    expect(h.commitHeldSend).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it('keeps only the deadline in localStorage when the outbox has the message', async () => {
    h.outbox.set('outbox_2_abc', { id: 'outbox_2_abc', status: 'pending', emailData: email });
    h.commitHeldSend.mockResolvedValue({ ok: false, deferred: true, retryInMs: 60_000 });

    await adoptPendingSend(pending('outbox_2_abc'));

    const stored = localStorage.getItem(PENDING_SEND_STORAGE_KEY) || '';
    expect(stored).toContain('outbox_2_abc');
    expect(stored).not.toContain('the secret plan');
    getAttachedPendingSendQueue()?.complete('outbox_2_abc');
  });

  it('sends from the record when the page died before the outbox write', async () => {
    // No outbox row was ever written for this one
    await adoptPendingSend(pending('outbox_3_abc'));

    globalThis.__feFlushPendingSends?.();
    await queueIsEmpty();

    expect(h.queueEmail).toHaveBeenCalledTimes(1);
    expect(h.queueEmail.mock.calls[0][1]).toMatchObject({ id: 'outbox_3_abc', undoHold: true });
    expect(h.commitHeldSend).toHaveBeenCalledWith('me@test.com', 'outbox_3_abc');
  });
});
