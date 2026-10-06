import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const { metaStore, onlineFlag, queueMutationMock } = vi.hoisted(() => ({
  metaStore: new Map<string, { key: string; value: unknown }>(),
  onlineFlag: { value: true },
  queueMutationMock: vi.fn(),
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      get: async (key: string) => metaStore.get(key) ?? null,
      put: async (record: { key: string; value: unknown }) => {
        metaStore.set(record.key, record);
      },
    },
  },
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? 'owner@example.com' : null) },
}));

vi.mock('../../src/utils/network-status', () => ({
  isOnline: () => onlineFlag.value,
  onlineStatus: writable(true),
}));

vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: (...args: unknown[]) => queueMutationMock(...args),
}));

import * as store from '../../src/stores/agentStore';
import { getMockControls, resetAgentBackend } from '../../src/utils/agent-api';

describe('agentStore', () => {
  beforeEach(async () => {
    metaStore.clear();
    onlineFlag.value = true;
    queueMutationMock.mockReset();
    resetAgentBackend();
    store.resetAgentStore();
    await store.loadAgents();
  });

  const firstCard = () => get(store.waitingOnYou).find((a) => a.kind === 'standard')!;

  it('approving online removes the card and announces the outcome', async () => {
    const card = firstCard();
    await store.decide(card.id, 'approve');
    expect(get(store.waitingOnYou).some((a) => a.id === card.id)).toBe(false);
    expect(get(store.decidedToday)[0]).toMatchObject({ id: card.id, status: 'approved' });
    expect(get(store.agentAnnouncement)).toContain('approved and sent');
  });

  it('approving offline goes through the mutation queue with if_version', async () => {
    onlineFlag.value = false;
    const card = firstCard();
    await store.decide(card.id, 'approve');
    expect(queueMutationMock).toHaveBeenCalledWith('agentDecision', {
      actionId: card.id,
      verb: 'approve',
      ifVersion: card.version,
      mock: true,
    });
    expect(get(store.localDecisions)[card.id]).toEqual({ state: 'queued', verb: 'approve' });
  });

  it('a 409 from another device shows the outcome instead of overwriting', async () => {
    const card = firstCard();
    await getMockControls()!.simulateRemoteDecision(card.id, 'rejected');
    await store.decide(card.id, 'approve');
    expect(get(store.localDecisions)[card.id]).toEqual({ state: 'conflict', outcome: 'rejected' });
    expect(get(store.agentAnnouncement)).toContain('already handled on another device');
  });

  it('a queued decision settles through the queue event', async () => {
    onlineFlag.value = false;
    const card = firstCard();
    await store.decide(card.id, 'reject');
    store.initAgentStore();
    globalThis.dispatchEvent(
      new CustomEvent('fe:agent-decision-settled', {
        detail: {
          actionId: card.id,
          verb: 'reject',
          result: { ok: false, conflict: true, action: { ...card, status: 'approved' } },
        },
      }),
    );
    expect(get(store.localDecisions)[card.id]).toEqual({ state: 'conflict', outcome: 'approved' });
  });

  it('pause all refuses to queue while offline', async () => {
    onlineFlag.value = false;
    await expect(store.setPausedAll(true)).rejects.toThrow('Connect to pause agents');
    expect(get(store.pausedAll)).toBe(false);
    expect(queueMutationMock).not.toHaveBeenCalled();
  });

  it('revoke refuses while offline', async () => {
    onlineFlag.value = false;
    const [agent] = get(store.agents);
    await expect(store.revokeAgent(agent.id)).rejects.toThrow('Connect to revoke');
  });

  it('serves the encrypted cache when the backend is unreachable', async () => {
    const before = get(store.agentSnapshot);
    const controls = getMockControls()!;
    vi.spyOn(controls, 'listAgents').mockRejectedValueOnce(new Error('offline'));
    await store.loadAgents();
    expect(get(store.agentFromCache)).toBe(true);
    expect(get(store.agentSnapshot).agents).toEqual(before.agents);
    expect([...metaStore.keys()]).toEqual(['agent_cache_owner@example.com']);
  });

  it('unusual collects server refusals separately from decisions', () => {
    const { blocked } = get(store.unusual);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((e) => e.type === 'inbound_blocked')).toBe(true);
  });
});
