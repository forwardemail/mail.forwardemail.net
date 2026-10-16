/**
 * \Answered on the message a reply answered belongs to the mailbox the reply
 * was sent from. The user can switch accounts while IndexedDB is read; the
 * change must still be queued for, and sent as, the replying account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  online: true,
  active: 'me@example.com',
  switchTo: '' as string,
  request: vi.fn(),
  queue: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? h.active : null) },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args: unknown[]) => h.request(...args) },
}));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeaderForAccount: (account: string) => `Basic ${account}`,
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  mutationQueueCount: { subscribe: () => () => {} },
  queueMutation: (...args: unknown[]) => h.queue(...args),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/utils/db', () => ({
  db: {
    messages: {
      where: () => ({
        equals: () => ({
          // the user switches accounts while IndexedDB answers
          toArray: async () => {
            if (h.switchTo) h.active = h.switchTo;
            return [];
          },
          modify: async () => {},
        }),
      }),
    },
  },
}));

const { markOriginalAnswered, repliedMessageToArchive } =
  await import('../../src/utils/answered-flag');

beforeEach(() => {
  h.online = true;
  h.active = 'me@example.com';
  h.switchTo = '';
  h.request.mockReset().mockResolvedValue({});
  h.queue.mockReset().mockResolvedValue({});
});

describe('markOriginalAnswered across an account switch', () => {
  it('queues the change for the replying account, not the one switched to', async () => {
    h.switchTo = 'other@example.com';
    await markOriginalAnswered('m1');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.queue).toHaveBeenCalledWith('addFlags', expect.objectContaining({ messageId: 'm1' }), {
      account: 'me@example.com',
    });
  });

  it('queues an offline change for the account it was made in', async () => {
    h.online = false;
    await markOriginalAnswered('m2');
    expect(h.queue).toHaveBeenCalledWith('addFlags', expect.objectContaining({ messageId: 'm2' }), {
      account: 'me@example.com',
    });
  });

  it("sends the change with the replying account's credentials", async () => {
    await markOriginalAnswered('m3');
    expect(h.request.mock.calls[0][2]).toMatchObject({ authHeader: 'Basic me@example.com' });
  });
});

describe('repliedMessageToArchive ("Send & Archive")', () => {
  const inbox = [
    { id: 'answered', folder: 'INBOX', subject: 'Question' },
    { id: 'other', folder: 'INBOX', subject: 'Unrelated' },
  ];
  const view = (active: string, selected = inbox[1]) => ({
    isActive: (account: string) => account === active,
    messages: inbox,
    selected,
  });

  it('archives the message the reply answered, not the one selected now', () => {
    const target = { ownerAccount: 'me@example.com', replyToMessageId: 'answered' };
    expect(repliedMessageToArchive(target, view('me@example.com'))).toBe(inbox[0]);
  });

  it('archives nothing in the account switched to', () => {
    const target = { ownerAccount: 'me@example.com', replyToMessageId: 'answered' };
    expect(repliedMessageToArchive(target, view('other@example.com'))).toBeNull();
  });

  it('archives by id and folder when the answered message is not on screen', () => {
    const target = {
      ownerAccount: 'me@example.com',
      replyToMessageId: 'scrolled-away',
      replyToMessageFolder: 'Work',
    };
    expect(repliedMessageToArchive(target, view('me@example.com'))).toEqual({
      id: 'scrolled-away',
      folder: 'Work',
    });
  });

  it('archives nothing for a send that answered no known message', () => {
    expect(
      repliedMessageToArchive({ ownerAccount: 'me@example.com' }, view('me@example.com')),
    ).toBeNull();
  });
});
