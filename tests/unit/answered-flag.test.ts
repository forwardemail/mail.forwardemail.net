/**
 * markOriginalAnswered: the message a reply answers gets \Answered on the
 * server, where IMAP clients read it, whether or not this client has the
 * message cached, and a change that fails for a reason that can pass is
 * queued for retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const h = vi.hoisted(() => ({
  online: true,
  active: 'me@example.com',
  rows: new Map<string, Record<string, unknown>>(),
  request: vi.fn(),
  queue: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? h.active : null) },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args: unknown[]) => h.request(...args) },
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: (...args: unknown[]) => h.queue(...args),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
// IndexedDB rows by [account, id], with the two calls the helper makes.
vi.mock('../../src/utils/db', () => ({
  db: {
    messages: {
      where: () => ({
        equals: ([account, id]: [string, string]) => {
          const key = `${account}|${id}`;
          return {
            toArray: async () => (h.rows.has(key) ? [h.rows.get(key)] : []),
            modify: async (changes: Record<string, unknown>) => {
              if (h.rows.has(key)) h.rows.set(key, { ...h.rows.get(key), ...changes });
            },
          };
        },
      }),
    },
  },
}));

const { markOriginalAnswered } = await import('../../src/utils/answered-flag');
const { messages } = await import('../../src/stores/messageStore');

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

beforeEach(() => {
  h.online = true;
  h.active = 'me@example.com';
  h.rows.clear();
  h.request.mockReset().mockResolvedValue({});
  h.queue.mockReset().mockResolvedValue({});
  messages.set([]);
});

describe('markOriginalAnswered', () => {
  it('adds \\Answered to a cached message, here and on the server', async () => {
    h.rows.set('me@example.com|m1', { id: 'm1', flags: ['\\Seen'] });
    await markOriginalAnswered('m1');
    expect(h.rows.get('me@example.com|m1')?.flags).toEqual(['\\Seen', '\\Answered']);
    expect(h.request).toHaveBeenCalledWith(
      'MessageUpdate',
      { flags: ['\\Seen', '\\Answered'], flags_add: ['\\Answered'] },
      { method: 'PUT', pathOverride: '/v1/messages/m1' },
    );
  });

  it('still tells the server when the local copy already has the flag', async () => {
    h.rows.set('me@example.com|m1', { id: 'm1', flags: ['\\Answered'] });
    await markOriginalAnswered('m1');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1]).toMatchObject({ flags_add: ['\\Answered'] });
  });

  it('uses the flags on screen for a message that is not cached', async () => {
    messages.set([{ id: 'm2', flags: ['\\Flagged'] }] as never);
    await markOriginalAnswered('m2');
    expect(h.request.mock.calls[0][1]).toEqual({
      flags: ['\\Flagged', '\\Answered'],
      flags_add: ['\\Answered'],
    });
    expect(get(messages)[0]).toMatchObject({ is_answered: true });
  });

  it('sends only the addition when it knows none of the flags', async () => {
    await markOriginalAnswered('m3');
    expect(h.request.mock.calls[0][1]).toEqual({ flags_add: ['\\Answered'] });
  });

  it('queues the change offline, and when the server fails', async () => {
    h.online = false;
    await markOriginalAnswered('m4');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.queue).toHaveBeenCalledWith('addFlags', {
      messageId: 'm4',
      flags: null,
      add: ['\\Answered'],
    });

    h.online = true;
    h.queue.mockClear();
    h.request.mockRejectedValueOnce(httpError(503));
    await markOriginalAnswered('m5');
    expect(h.queue).toHaveBeenCalledWith('addFlags', expect.objectContaining({ messageId: 'm5' }));

    h.queue.mockClear();
    h.request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await markOriginalAnswered('m6');
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it('does not queue a change the server refuses', async () => {
    h.request.mockRejectedValueOnce(httpError(404));
    await markOriginalAnswered('gone');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("leaves the server alone when another account's outbox send finishes", async () => {
    h.rows.set('other@example.com|m7', { id: 'm7', flags: [] });
    await markOriginalAnswered('m7', { account: 'other@example.com' });
    // Its own cached copy is still marked.
    expect(h.rows.get('other@example.com|m7')?.flags).toEqual(['\\Answered']);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('does nothing without a message id', async () => {
    await markOriginalAnswered(null);
    await markOriginalAnswered('');
    expect(h.request).not.toHaveBeenCalled();
  });
});
