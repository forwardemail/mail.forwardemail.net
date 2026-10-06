/**
 * Agent mode state (spec §5).
 *
 * The store only ever mirrors what the server decided. Approve and reject
 * ask the server; the server re-evaluates policy and may refuse. Nothing here
 * decides whether a message is sent.
 *
 * Offline (§5.5): the last good snapshot is cached in the encrypted local
 * store and served when the network is down. Approve/Reject made offline go
 * through the shared mutation queue with if_version, and settle via the
 * `fe:agent-decision-settled` event the queue fires. Pause all and Revoke are
 * online only, on purpose.
 */

import { derived, get, writable } from 'svelte/store';
import { db } from '../utils/db';
import { Local } from '../utils/storage';
import { isOnline, onlineStatus } from '../utils/network-status';
import { queueMutation } from '../utils/mutation-queue';
import { getAgentBackend, AgentApiError } from '../utils/agent-api';
import type {
  Agent,
  AgentPolicyDraft,
  AgentPolicyVersion,
  AgentThread,
  AuditEvent,
  AuditVerifyResult,
  DecisionResult,
  DigestRow,
  DryRunResult,
  PendingAction,
} from '../types/agents';

export type DecisionVerb = 'approve' | 'reject';

/** Per-card local state layered over the server's PendingAction. */
export type LocalDecision =
  | { state: 'sending'; verb: DecisionVerb }
  | { state: 'queued'; verb: DecisionVerb }
  | { state: 'conflict'; outcome: PendingAction['status'] }
  | { state: 'failed'; error: string };

interface Snapshot {
  agents: Agent[];
  pending: PendingAction[];
  decidedToday: PendingAction[];
  audit: AuditEvent[];
  digest: DigestRow[];
  threads: AgentThread[];
  pausedAll: boolean;
  fetchedAt: number;
}

const EMPTY: Snapshot = {
  agents: [],
  pending: [],
  decidedToday: [],
  audit: [],
  digest: [],
  threads: [],
  pausedAll: false,
  fetchedAt: 0,
};

export const agentSnapshot = writable<Snapshot>(EMPTY);
export const agentLoading = writable(false);
export const agentError = writable<string | null>(null);
/** True when the snapshot came from the local cache because the fetch failed. */
export const agentFromCache = writable(false);
export const localDecisions = writable<Record<string, LocalDecision>>({});
/** Text for the aria-live="polite" region (§9). */
export const agentAnnouncement = writable('');

export const agents = derived(agentSnapshot, ($s) => $s.agents);
export const pausedAll = derived(agentSnapshot, ($s) => $s.pausedAll);
export const decidedToday = derived(agentSnapshot, ($s) => $s.decidedToday);
export const digest = derived(agentSnapshot, ($s) => $s.digest);
export const agentThreads = derived(agentSnapshot, ($s) => $s.threads);
export const auditEvents = derived(agentSnapshot, ($s) => $s.audit);
export const agentsOnline = onlineStatus;

export const agentById = derived(agentSnapshot, ($s) => {
  const map: Record<string, Agent> = {};
  for (const a of $s.agents) map[a.id] = a;
  return map;
});

/** Cards still waiting. Local state (sending, queued, conflict) is shown on the card. */
export const waitingOnYou = derived(agentSnapshot, ($s) => $s.pending.filter((a) => !a.unusual));

/**
 * Unusual (§7): pending actions the server flagged, plus scope refusals the
 * server already blocked. The refusals need no decision; they are shown so
 * the owner knows something tried.
 */
export const unusual = derived(agentSnapshot, ($s) => ({
  pending: $s.pending.filter((a) => a.unusual),
  blocked: $s.audit.filter((e) => e.type === 'inbound_blocked'),
}));

const cacheKey = (): string => `agent_cache_${Local.get('email') || 'default'}`;

async function readCache(): Promise<Snapshot | null> {
  try {
    const record = await db.meta.get(cacheKey());
    return (record?.value as Snapshot) ?? null;
  } catch {
    return null;
  }
}

async function writeCache(snapshot: Snapshot): Promise<void> {
  try {
    await db.meta.put({ key: cacheKey(), value: snapshot, updatedAt: Date.now() });
  } catch {
    // The cache is a convenience for offline reads; the live view still works.
  }
}

let loadGeneration = 0;

export async function loadAgents(): Promise<void> {
  const generation = ++loadGeneration;
  agentLoading.set(true);
  const backend = getAgentBackend();
  try {
    const [agentsList, pending, decided, audit, digestRows, threads, paused] = await Promise.all([
      backend.listAgents(),
      backend.listPendingActions(),
      backend.listDecidedToday(),
      backend.listAudit(),
      backend.digest(),
      backend.listThreads(),
      backend.getPausedAll(),
    ]);
    if (generation !== loadGeneration) return;
    const snapshot: Snapshot = {
      agents: agentsList,
      pending,
      decidedToday: decided,
      audit,
      digest: digestRows,
      threads,
      pausedAll: paused,
      fetchedAt: Date.now(),
    };
    agentSnapshot.set(snapshot);
    agentFromCache.set(false);
    agentError.set(null);
    // Drop local "sending" markers for cards the server no longer lists, but
    // keep queued and conflict markers until they settle.
    localDecisions.update((current) => {
      const next = { ...current };
      const live = new Set(pending.map((a) => a.id));
      for (const [id, d] of Object.entries(next)) {
        if (d.state === 'sending' && !live.has(id)) delete next[id];
      }
      return next;
    });
    void writeCache(snapshot);
  } catch (err) {
    if (generation !== loadGeneration) return;
    const cached = await readCache();
    if (cached) {
      agentSnapshot.set(cached);
      agentFromCache.set(true);
      agentError.set(null);
    } else {
      agentError.set((err as Error)?.message || 'Could not load agents');
    }
  } finally {
    if (generation === loadGeneration) agentLoading.set(false);
  }
}

const setLocal = (id: string, decision: LocalDecision | null): void => {
  localDecisions.update((current) => {
    const next = { ...current };
    if (decision) next[id] = decision;
    else delete next[id];
    return next;
  });
};

const findAction = (id: string): PendingAction | undefined =>
  get(agentSnapshot).pending.find((a) => a.id === id);

const describeOutcome = (status: PendingAction['status']): string =>
  ({
    approved: 'approved',
    rejected: 'rejected',
    expired: 'expired',
    cancelled: 'cancelled',
    pending: 'still pending',
  })[status];

/** Apply the server's answer to local state. Shared by online and queued paths. */
export function settleDecision(id: string, verb: DecisionVerb, result: DecisionResult): void {
  const action = findAction(id);
  const label = action ? `${action.envelope.subject}` : 'Action';
  if (result.ok) {
    agentSnapshot.update((s) => ({
      ...s,
      pending: s.pending.filter((a) => a.id !== id),
      decidedToday: [result.action, ...s.decidedToday.filter((a) => a.id !== id)],
    }));
    setLocal(id, null);
    agentAnnouncement.set(`${label}: ${verb === 'approve' ? 'approved and sent' : 'rejected'}`);
    return;
  }
  if (result.conflict) {
    setLocal(id, { state: 'conflict', outcome: result.action.status });
    agentAnnouncement.set(
      `${label}: already handled on another device, ${describeOutcome(result.action.status)}`,
    );
    return;
  }
  setLocal(id, { state: 'failed', error: result.error });
  agentAnnouncement.set(`${label}: ${result.error}`);
}

export async function decide(id: string, verb: DecisionVerb): Promise<void> {
  const action = findAction(id);
  if (!action) return;
  const current = get(localDecisions)[id];
  if (current?.state === 'sending' || current?.state === 'queued') return;

  if (!isOnline()) {
    await queueMutation('agentDecision', {
      actionId: id,
      verb,
      ifVersion: action.version,
      // The service worker cannot reach the in-memory mock, so it must leave
      // these for the page to process.
      mock: getAgentBackend().kind === 'mock',
    });
    setLocal(id, { state: 'queued', verb });
    agentAnnouncement.set(
      `${action.envelope.subject}: will ${verb === 'approve' ? 'send' : 'reject'} when online`,
    );
    return;
  }

  setLocal(id, { state: 'sending', verb });
  const backend = getAgentBackend();
  try {
    const result =
      verb === 'approve'
        ? await backend.approve(id, action.version)
        : await backend.reject(id, action.version);
    settleDecision(id, verb, result);
  } catch (err) {
    setLocal(id, { state: 'failed', error: (err as Error)?.message || 'Request failed' });
  }
}

/** Clear a conflict or failure marker once the user has seen it. */
export function dismissDecision(id: string): void {
  const local = get(localDecisions)[id];
  setLocal(id, null);
  if (local?.state === 'conflict') {
    agentSnapshot.update((s) => ({ ...s, pending: s.pending.filter((a) => a.id !== id) }));
  }
}

/**
 * Take over converts the action into an owner draft. Opening the composer
 * is the shell's job, so this fires an event with the draft instead.
 */
export async function takeOver(id: string): Promise<boolean> {
  const action = findAction(id);
  if (!action) return false;
  if (!isOnline()) {
    setLocal(id, { state: 'failed', error: 'Connect to take over this conversation' });
    return false;
  }
  const result = await getAgentBackend().takeOver(id, action.version);
  if (!result.ok) {
    settleDecision(id, 'reject', result);
    return false;
  }
  agentSnapshot.update((s) => ({ ...s, pending: s.pending.filter((a) => a.id !== id) }));
  globalThis.dispatchEvent?.(
    new CustomEvent('fe:agent-take-over', {
      detail: {
        to: action.envelope.to,
        subject: action.envelope.subject,
        body: action.body ?? action.preview,
        inReplyTo: action.envelope.messageRef,
      },
    }),
  );
  agentAnnouncement.set(`${action.envelope.subject}: taken over, draft opened`);
  return true;
}

const requireOnline = (what: string): void => {
  if (!isOnline()) throw new AgentApiError(0, `Connect to ${what}`);
};

export async function setPausedAll(paused: boolean): Promise<void> {
  requireOnline(paused ? 'pause agents' : 'resume agents');
  const backend = getAgentBackend();
  const state = paused ? await backend.pauseAll() : await backend.resumeAll();
  agentSnapshot.update((s) => ({ ...s, pausedAll: state }));
  agentAnnouncement.set(state ? 'All agents paused' : 'All agents resumed');
  void loadAgents();
}

const replaceAgent = (agent: Agent): void =>
  agentSnapshot.update((s) => ({
    ...s,
    agents: s.agents.map((a) => (a.id === agent.id ? agent : a)),
  }));

export async function setAgentPaused(id: string, paused: boolean): Promise<void> {
  requireOnline(paused ? 'pause this agent' : 'resume this agent');
  const backend = getAgentBackend();
  replaceAgent(paused ? await backend.pauseAgent(id) : await backend.resumeAgent(id));
  void loadAgents();
}

export async function revokeAgent(id: string): Promise<void> {
  requireOnline('revoke this agent');
  replaceAgent(await getAgentBackend().revoke(id));
  agentAnnouncement.set('Agent revoked');
  await loadAgents();
}

export const policyVersions = (agentId: string): Promise<AgentPolicyVersion[]> =>
  getAgentBackend().listPolicyVersions(agentId);

export const dryRunPolicy = (agentId: string, draft: AgentPolicyDraft): Promise<DryRunResult> =>
  getAgentBackend().dryRun(agentId, draft);

export async function publishPolicy(
  agentId: string,
  draft: AgentPolicyDraft,
): Promise<AgentPolicyVersion> {
  requireOnline('publish a policy');
  const version = await getAgentBackend().publishPolicy(agentId, draft);
  await loadAgents();
  return version;
}

export async function rollbackPolicy(
  agentId: string,
  toVersion: number,
): Promise<AgentPolicyVersion> {
  requireOnline('roll back a policy');
  const version = await getAgentBackend().rollbackPolicy(agentId, toVersion);
  await loadAgents();
  return version;
}

export const verifyAuditChain = (agentId: string): Promise<AuditVerifyResult> =>
  getAgentBackend().verifyAudit(agentId);

export const loadThread = (id: string): Promise<AgentThread> => getAgentBackend().getThread(id);

export const loadAction = async (id: string): Promise<PendingAction | null> => {
  const local = findAction(id) ?? get(agentSnapshot).decidedToday.find((a) => a.id === id);
  if (local) return local;
  try {
    return await getAgentBackend().getAction(id);
  } catch {
    return null;
  }
};

let listening = false;

/** Wire the queue's settle event and reload when connectivity returns. */
export function initAgentStore(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('fe:agent-decision-settled', (event) => {
    const { actionId, verb, result } = (event as CustomEvent).detail ?? {};
    if (actionId && result) settleDecision(actionId, verb, result);
  });
  let wasOnline = isOnline();
  onlineStatus.subscribe((online: boolean) => {
    if (online && !wasOnline) void loadAgents();
    wasOnline = online;
  });
}

/** Test seam. */
export function resetAgentStore(): void {
  agentSnapshot.set(EMPTY);
  localDecisions.set({});
  agentAnnouncement.set('');
  agentError.set(null);
  agentFromCache.set(false);
  loadGeneration += 1;
}
