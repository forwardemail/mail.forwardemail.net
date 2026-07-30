/**
 * outbox-service unit tests.
 *
 * The outbox is the offline send queue — getting retry/backoff or the
 * sent/failed transitions wrong means lost or duplicated email. Cover queueing
 * (incl. demo block + scheduled), the pending-readiness filter, and the core
 * send loop's success / retry-with-backoff / max-retries-failed transitions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  online: true,
  demo: false,
  activeEmail: 'me@test.com',
  outbox: new Map<string, Record<string, unknown>>(),
  remoteRequest: vi.fn().mockResolvedValue({}),
  saveSentCopy: vi.fn().mockResolvedValue(undefined),
  blockedToast: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => h.activeEmail) },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/sent-copy.js', () => ({
  saveSentCopy: (...a: unknown[]) => h.saveSentCopy(...a),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => h.demo,
  showDemoBlockedToast: (...a: unknown[]) => h.blockedToast(...a),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/db', () => {
  const key = (id: string) => id;
  return {
    db: {
      outbox: {
        put: vi.fn(async (r: Record<string, unknown>) => h.outbox.set(key(String(r.id)), r)),
        get: vi.fn(async ([, id]: [string, string]) => h.outbox.get(key(id))),
        update: vi.fn(async ([, id]: [string, string], changes: Record<string, unknown>) => {
          const cur = h.outbox.get(key(id));
          if (cur) h.outbox.set(key(id), { ...cur, ...changes });
        }),
        where: () => ({ between: () => ({ toArray: async () => [...h.outbox.values()] }) }),
      },
      messages: {
        where: () => ({ equals: () => ({ toArray: async () => [], modify: async () => 0 }) }),
      },
    },
  };
});

import {
  queueEmail,
  getPendingOutbox,
  processOutbox,
  getOutboxItem,
} from '../../src/utils/outbox-service.js';

const email = { to: ['x@y.com'], subject: 'Hi', html: '<p>hello</p>' };

beforeEach(() => {
  h.online = true;
  h.demo = false;
  h.activeEmail = 'me@test.com';
  h.outbox.clear();
  h.remoteRequest.mockReset().mockResolvedValue({});
  h.saveSentCopy.mockClear();
  h.blockedToast.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('queueEmail', () => {
  it('throws an isDemo error and shows the blocked toast in demo mode', async () => {
    h.demo = true;
    await expect(queueEmail(email, { skipProcess: true })).rejects.toMatchObject({ isDemo: true });
    expect(h.blockedToast).toHaveBeenCalled();
    expect(h.outbox.size).toBe(0);
  });

  it('queues a pending item ready to send now', async () => {
    const rec = await queueEmail(email, { skipProcess: true });
    expect(rec).toMatchObject({ status: 'pending', retryCount: 0 });
    expect(h.outbox.size).toBe(1);
  });

  it('marks a future-dated email as scheduled', async () => {
    const sendAt = Date.now() + 60_000;
    const rec = await queueEmail(email, { skipProcess: true, sendAt });
    expect(rec.status).toBe('scheduled');
    expect(rec.nextRetryAt).toBe(sendAt);
  });
});

describe('getPendingOutbox', () => {
  it('includes ready pending + due scheduled, excludes backed-off + future', async () => {
    const now = Date.now();
    h.outbox.set('ready', {
      account: 'me@test.com',
      id: 'ready',
      status: 'pending',
      nextRetryAt: now - 1,
    });
    h.outbox.set('backoff', {
      account: 'me@test.com',
      id: 'backoff',
      status: 'pending',
      nextRetryAt: now + 60_000,
    });
    h.outbox.set('due', {
      account: 'me@test.com',
      id: 'due',
      status: 'scheduled',
      sendAt: now - 1,
    });
    h.outbox.set('future', {
      account: 'me@test.com',
      id: 'future',
      status: 'scheduled',
      sendAt: now + 60_000,
    });
    h.outbox.set('sent', { account: 'me@test.com', id: 'sent', status: 'sent' });
    const ids = (await getPendingOutbox()).map((i) => i.id).sort();
    expect(ids).toEqual(['due', 'ready']);
  });
});

describe('processOutbox', () => {
  it('is a no-op when offline', async () => {
    h.online = false;
    h.outbox.set('a', {
      account: 'me@test.com',
      id: 'a',
      status: 'pending',
      nextRetryAt: 0,
      emailData: email,
    });
    expect(await processOutbox()).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('sends a pending item, marks it sent, and saves a Sent copy', async () => {
    vi.useFakeTimers();
    h.outbox.set('a', {
      account: 'me@test.com',
      id: 'a',
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
      emailData: email,
    });
    const p = processOutbox();
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.remoteRequest).toHaveBeenCalledWith('Emails', expect.anything(), { method: 'POST' });
    expect(h.saveSentCopy).toHaveBeenCalled();
    expect((await getOutboxItem('a'))?.status).toBe('sent');
  });

  it('on send failure, requeues as pending with an incremented retry + backoff', async () => {
    vi.useFakeTimers();
    h.remoteRequest.mockRejectedValue(new Error('smtp 451'));
    const before = Date.now();
    h.outbox.set('a', {
      account: 'me@test.com',
      id: 'a',
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
      emailData: email,
    });
    const p = processOutbox();
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    const item = await getOutboxItem('a');
    expect(item).toMatchObject({ status: 'pending', retryCount: 1, lastError: 'smtp 451' });
    expect(item!.nextRetryAt as number).toBeGreaterThan(before); // backed off into the future
  });

  it('marks an item failed once it hits MAX_RETRIES', async () => {
    vi.useFakeTimers();
    h.remoteRequest.mockRejectedValue(new Error('perma-fail'));
    // retryCount 4 → this attempt makes it 5 (= MAX_RETRIES) → failed
    h.outbox.set('a', {
      account: 'me@test.com',
      id: 'a',
      status: 'pending',
      retryCount: 4,
      nextRetryAt: 0,
      emailData: email,
    });
    const p = processOutbox();
    await vi.runAllTimersAsync();
    await p;
    const item = await getOutboxItem('a');
    expect(item).toMatchObject({ status: 'failed', retryCount: 5, lastError: 'perma-fail' });
  });
});

describe('processOutbox account binding', () => {
  // The drain loop awaits a network send plus a 500ms pause per item, so the
  // user can switch accounts part-way through it. Sending is authenticated by
  // the ACTIVE session, so an item belonging to another account must not go
  // out here: it would be sent from the wrong alias and its Sent copy filed
  // into the wrong mailbox.
  it('refuses to send an item whose account is no longer active', async () => {
    vi.useFakeTimers();
    h.outbox.set('a', {
      account: 'other@test.com',
      id: 'a',
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
      emailData: email,
    });

    const p = processOutbox();
    await vi.runAllTimersAsync();
    const result = await p;

    expect(h.remoteRequest).not.toHaveBeenCalled();
    expect(h.saveSentCopy).not.toHaveBeenCalled();
    // Deferred, not failed: no retry was spent and the item is untouched, so it
    // still sends when that account becomes active again.
    expect(result).toMatchObject({ sent: 0, failed: 0 });
    expect(await getOutboxItem('a')).toMatchObject({ status: 'pending', retryCount: 0 });
  });

  it("files the Sent copy under the item's own account", async () => {
    vi.useFakeTimers();
    h.outbox.set('a', {
      account: 'me@test.com',
      id: 'a',
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
      emailData: email,
    });

    const p = processOutbox();
    await vi.runAllTimersAsync();
    await p;

    expect(h.saveSentCopy).toHaveBeenCalledWith(email, 'me@test.com', null);
  });
});
