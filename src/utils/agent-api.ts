/**
 * Owner-side client for the agent mode API (spec §4.7).
 *
 * Two implementations behind one interface: RemoteAgentBackend speaks the
 * real /v1/agents* endpoints, MockAgentBackend simulates them in memory until
 * the server ships M0. The mock is the default while the endpoints do not
 * exist; set localStorage `webmail_agent_mode_backend` to `server` to point the UI at
 * a real build.
 *
 * Only owner endpoints live here. The agent endpoints (POST
 * /v1/agents/:id/messages and friends) take agent credentials and have no
 * business in the owner's client.
 */

import { Remote } from './remote.js';
import { Local } from './storage.js';
import { AgentApiError, MockAgentBackend } from './agent-mock-backend';
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

export { AgentApiError };

export interface AgentBackend {
  readonly kind: 'mock' | 'server';
  listAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent>;
  getPausedAll(): Promise<boolean>;
  listPendingActions(): Promise<PendingAction[]>;
  listDecidedToday(): Promise<PendingAction[]>;
  getAction(id: string): Promise<PendingAction>;
  approve(id: string, ifVersion: number): Promise<DecisionResult>;
  reject(id: string, ifVersion: number, note?: string): Promise<DecisionResult>;
  takeOver(id: string, ifVersion: number): Promise<DecisionResult>;
  pauseAgent(id: string): Promise<Agent>;
  resumeAgent(id: string): Promise<Agent>;
  pauseAll(): Promise<boolean>;
  resumeAll(): Promise<boolean>;
  revoke(id: string): Promise<Agent>;
  listPolicyVersions(agentId: string): Promise<AgentPolicyVersion[]>;
  dryRun(agentId: string, candidate: AgentPolicyDraft): Promise<DryRunResult>;
  publishPolicy(agentId: string, draft: AgentPolicyDraft): Promise<AgentPolicyVersion>;
  rollbackPolicy(agentId: string, toVersion: number): Promise<AgentPolicyVersion>;
  listAudit(agentId?: string): Promise<AuditEvent[]>;
  verifyAudit(agentId: string): Promise<AuditVerifyResult>;
  digest(): Promise<DigestRow[]>;
  listThreads(): Promise<AgentThread[]>;
  getThread(id: string): Promise<AgentThread>;
}

type RequestOptions = { method?: string; pathOverride: string };

const call = async <T>(
  action: string,
  path: string,
  method = 'GET',
  body: Record<string, unknown> = {},
): Promise<T> => {
  const options: RequestOptions = { method, pathOverride: path };
  try {
    return (await Remote.request(action, body, options)) as T;
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 0;
    throw new AgentApiError(status, (err as Error)?.message || 'Request failed');
  }
};

const enc = encodeURIComponent;

/**
 * Real endpoints. A 409 on approve/reject is the expected outcome when
 * another device decided first, so it is turned into a result rather than an
 * exception. Remote strips unknown fields from error bodies, so the current
 * state is re-read with a GET instead of trusted from the 409 body.
 */
export class RemoteAgentBackend implements AgentBackend {
  readonly kind = 'server' as const;

  listAgents = () => call<Agent[]>('AgentList', '/v1/agents');
  getAgent = (id: string) => call<Agent>('Agent', `/v1/agents/${enc(id)}`);
  getPausedAll = async () =>
    (await call<{ paused: boolean }>('AgentPauseState', '/v1/agents/pause-all')).paused;
  listPendingActions = () =>
    call<PendingAction[]>('AgentActions', '/v1/agent-actions?status=pending');
  listDecidedToday = () =>
    call<PendingAction[]>('AgentActions', '/v1/agent-actions?status=decided&since=24h');
  getAction = (id: string) => call<PendingAction>('AgentAction', `/v1/agent-actions/${enc(id)}`);

  private async decide(
    id: string,
    verb: 'approve' | 'reject' | 'take-over',
    body: Record<string, unknown>,
  ): Promise<DecisionResult> {
    try {
      const action = await call<PendingAction>(
        'AgentActionDecide',
        `/v1/agent-actions/${enc(id)}/${verb}`,
        'POST',
        body,
      );
      return { ok: true, action };
    } catch (err) {
      if (err instanceof AgentApiError && err.status === 409) {
        return { ok: false, conflict: true, action: await this.getAction(id) };
      }
      // Transport failures are not a decision. Throw so an offline-queued
      // approval stays queued and retries instead of being marked done.
      const status = err instanceof AgentApiError ? err.status : 0;
      if (status === 0 || status === 408 || status === 429 || status >= 500) throw err;
      return { ok: false, conflict: false, error: (err as Error).message };
    }
  }

  approve = (id: string, ifVersion: number) =>
    this.decide(id, 'approve', { if_version: ifVersion });
  reject = (id: string, ifVersion: number, note?: string) =>
    this.decide(id, 'reject', { if_version: ifVersion, ...(note ? { note } : {}) });
  takeOver = (id: string, ifVersion: number) =>
    this.decide(id, 'take-over', { if_version: ifVersion });

  pauseAgent = (id: string) => call<Agent>('AgentPause', `/v1/agents/${enc(id)}/pause`, 'POST');
  resumeAgent = (id: string) => call<Agent>('AgentPause', `/v1/agents/${enc(id)}/resume`, 'POST');
  pauseAll = async () => {
    await call('AgentPauseAll', '/v1/agents/pause-all', 'POST');
    return true;
  };
  resumeAll = async () => {
    await call('AgentPauseAll', '/v1/agents/resume-all', 'POST');
    return false;
  };
  revoke = (id: string) => call<Agent>('AgentRevoke', `/v1/agents/${enc(id)}`, 'DELETE');
  listPolicyVersions = (agentId: string) =>
    call<AgentPolicyVersion[]>('AgentPolicy', `/v1/agents/${enc(agentId)}/policy/versions`);
  dryRun = (agentId: string, candidate: AgentPolicyDraft) =>
    call<DryRunResult>(
      'AgentPolicyDryRun',
      `/v1/agents/${enc(agentId)}/policy/dry-run`,
      'POST',
      candidate as unknown as Record<string, unknown>,
    );
  publishPolicy = (agentId: string, draft: AgentPolicyDraft) =>
    call<AgentPolicyVersion>(
      'AgentPolicyPublish',
      `/v1/agents/${enc(agentId)}/policy`,
      'POST',
      draft as unknown as Record<string, unknown>,
    );
  rollbackPolicy = (agentId: string, toVersion: number) =>
    call<AgentPolicyVersion>(
      'AgentPolicyRollback',
      `/v1/agents/${enc(agentId)}/policy/rollback`,
      'POST',
      { toVersion },
    );
  listAudit = (agentId?: string) =>
    call<AuditEvent[]>(
      'AgentAudit',
      agentId ? `/v1/agents/${enc(agentId)}/audit` : '/v1/agents/audit',
    );
  verifyAudit = (agentId: string) =>
    call<AuditVerifyResult>('AgentAuditVerify', `/v1/agents/${enc(agentId)}/audit/verify`);
  digest = () => call<DigestRow[]>('AgentDigest', '/v1/agent-digest?since=24h');
  listThreads = () => call<AgentThread[]>('AgentThreads', '/v1/agent-threads');
  getThread = (id: string) => call<AgentThread>('AgentThread', `/v1/agent-threads/${enc(id)}`);
}

let mock: { owner: string; backend: MockAgentBackend } | null = null;

export function useServerBackend(): boolean {
  try {
    return Local.get('agent_mode_backend') === 'server';
  } catch {
    return false;
  }
}

/**
 * The backend for the signed-in account. The mock is rebuilt per account so
 * one account's agents never show under another.
 */
export function getAgentBackend(): AgentBackend {
  if (useServerBackend()) return new RemoteAgentBackend();
  const owner = (Local.get('email') as string) || 'owner@example.com';
  if (!mock || mock.owner !== owner) {
    mock = { owner, backend: new MockAgentBackend({ owner }) };
  }
  return mock.backend;
}

/** Prototype-only controls. Null when talking to a real server. */
export function getMockControls(): MockAgentBackend | null {
  const backend = getAgentBackend();
  return backend instanceof MockAgentBackend ? backend : null;
}

/** Test seam. */
export function resetAgentBackend(): void {
  mock = null;
}
