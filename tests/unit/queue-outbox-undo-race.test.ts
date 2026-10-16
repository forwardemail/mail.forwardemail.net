/**
 * Undo send while the outbox processor is working through its list. The
 * processor read the list before it started; an item undone since must not
 * be sent, and an item already being sent must not be undone (the composer
 * would reopen for a message that went out).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  outbox: new Map<string, Record<string, unknown>>(),
  remoteRequest: vi.fn(),
  beforeGet: null as null | ((id: string) => Promise<void> | void),
}));

vi.mock('../../src/utils/storage', () => ({ Local: { get: () => 'me@test.com' } }));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/auth', () => ({ getAuthHeaderForAccount: () => 'Basic me' }));
vi.mock('../../src/utils/catchall-credentials', () => ({ buildCatchallAuthHeader: () => '' }));
vi.mock('../../src/utils/sent-copy.js', () => ({ saveSentCopy: vi.fn(async () => null) }));
vi.mock('../../src/utils/answered-flag.ts', () => ({ markOriginalAnswered: vi.fn() }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  showDemoBlockedToast: vi.fn(),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));
vi.mock('../../src/utils/db', () => ({
  db: {
    outbox: {
      put: async (r: Record<string, unknown>) => h.outbox.set(String(r.id), r),
      get: async ([, id]: [string, string]) => {
        await h.beforeGet?.(id);
        return h.outbox.get(id);
      },
      update: async ([, id]: [string, string], changes: Record<string, unknown>) => {
        const cur = h.outbox.get(id);
        if (!cur) return 0;
        h.outbox.set(id, { ...cur, ...changes });
        return 1;
      },
      delete: async ([, id]: [string, string]) => {
        h.outbox.delete(id);
      },
      where: () => ({ between: () => ({ toArray: async () => [...h.outbox.values()] }) }),
    },
    messages: {
      where: () => ({ equals: () => ({ toArray: async () => [], modify: async () => 0 }) }),
    },
  },
}));

const { processOutbox, cancelQueuedSend, deleteOutboxItem } =
  await import('../../src/utils/outbox-service.js');

const item = (id: string) => ({
  id,
  account: 'me@test.com',
  status: 'scheduled',
  sendAt: Date.now() - 1,
  nextRetryAt: Date.now() - 1,
  retryCount: 0,
  emailData: { to: ['x@y.com'], subject: id, html: '<p>hi</p>' },
});

beforeEach(() => {
  h.outbox.clear();
  h.beforeGet = null;
  h.remoteRequest.mockReset().mockResolvedValue({ id: 'srv' });
});

describe('undo send during an outbox run', () => {
  it('does not send an item undone after the run read its list', async () => {
    h.outbox.set('first', item('first'));
    h.outbox.set('undone', item('undone'));
    // The user presses Undo on the second message while the first is sending.
    // Any removal of the row counts, whichever path the undo takes.
    h.remoteRequest.mockImplementation(async (action: string, payload: { subject?: string }) => {
      if (action === 'Emails' && payload?.subject === 'first') await deleteOutboxItem('undone');
      return { id: 'srv' };
    });

    await processOutbox();

    const sentSubjects = h.remoteRequest.mock.calls
      .filter(([action]) => action === 'Emails')
      .map(([, payload]) => payload.subject);
    expect(sentSubjects).toEqual(['first']);
    expect(h.outbox.has('undone')).toBe(false);
  });

  it('does not undo an item the processor has claimed', async () => {
    h.outbox.set('claimed', item('claimed'));
    let undo: Promise<{ cancelled: boolean }> | null = null;
    h.remoteRequest.mockImplementation(async (action: string) => {
      if (action === 'Emails') undo = cancelQueuedSend('claimed');
      return { id: 'srv' };
    });

    await processOutbox();

    await expect(undo).resolves.toMatchObject({ cancelled: false });
    expect(h.outbox.get('claimed')).toMatchObject({ status: 'sent' });
  });

  it('lets only one of a claim and an undo that race on the same item win', async () => {
    h.outbox.set('race', item('race'));
    let undo: Promise<{ cancelled: boolean }> | null = null;
    // Undo starts while the processor is reading the item to claim it.
    h.beforeGet = (id) => {
      if (id === 'race' && !undo) undo = cancelQueuedSend('race');
    };

    await processOutbox();
    const { cancelled } = (await undo) as { cancelled: boolean };

    const sent = h.remoteRequest.mock.calls.some(([action]) => action === 'Emails');
    expect(sent).toBe(!cancelled);
  });
});
