/**
 * In-memory stand-in for the agent mode server (spec §4), used until the M0
 * API exists. It implements the server's observable contract, not just its
 * happy path, so the client is built against the real edge cases:
 *
 *   - optimistic concurrency on approve/reject (409 with current state)
 *   - approval re-runs the evaluator against the CURRENT policy
 *   - expired actions cannot be approved
 *   - revoke cancels every pending action before returning
 *   - pause-all is a separate, reversible flag
 *   - the audit log is hash chained per agent and verifiable
 *
 * Everything here lives in memory and resets on reload. Persisting it would
 * let a prototype look more real than it is.
 */

import type {
  ActionClass,
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
import {
  classifyAction,
  defaultPolicy,
  dryRun as runDryRun,
  evaluate,
  levelRank,
  type ActionDeclaration,
  type ActionMetadata,
} from './agent-policy';

export class AgentApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const EXPIRY_MS = 7 * DAY;

/**
 * Not a cryptographic hash. The mock only needs the chain to be
 * tamper-evident inside one page session; the server uses SHA-256.
 */
export function chainHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Key-sorted JSON at every depth, so field order can never change a hash. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
};

const canonical = (event: Omit<AuditEvent, 'hash'>): string => {
  const { prevHash: _prev, ...rest } = event;
  return stableStringify(rest);
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface SimulatedSend {
  agentId: string;
  to: string[];
  subject: string;
  preview: string;
  body?: string;
  meta?: Partial<ActionMetadata>;
  declared?: ActionDeclaration;
  agentThreadCount?: number;
  threadId?: string;
}

export interface MockAgentBackendOptions {
  owner: string;
  now?: () => number;
  seed?: boolean;
}

export class MockAgentBackend {
  readonly kind = 'mock' as const;
  private owner: string;
  private now: () => number;
  private agents = new Map<string, Agent>();
  private versions = new Map<string, AgentPolicyVersion[]>();
  private actions = new Map<string, PendingAction>();
  private audit = new Map<string, AuditEvent[]>();
  private threads = new Map<string, AgentThread>();
  private knownDomains = new Set<string>();
  private sendsToday = new Map<string, number>();
  private sendsByCounterparty = new Map<string, Map<string, number>>();
  private pausedAll = false;
  private seq = 0;

  constructor({ owner, now = () => Date.now(), seed = true }: MockAgentBackendOptions) {
    this.owner = owner;
    this.now = now;
    if (seed) this.seed();
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36)}`;
  }

  // ── audit ──────────────────────────────────────────────────────────────

  private writeAudit(
    agentId: string,
    fields: Omit<AuditEvent, 'id' | 'agentId' | 'seq' | 'prevHash' | 'hash' | 'at'> & {
      at?: string;
    },
  ): AuditEvent {
    const log = this.audit.get(agentId) ?? [];
    const prevHash = log.length ? log[log.length - 1].hash : '0'.repeat(16);
    const base: Omit<AuditEvent, 'hash'> = {
      id: this.id('evt'),
      agentId,
      seq: log.length + 1,
      prevHash,
      at: fields.at ?? this.iso(),
      ...fields,
    };
    const event: AuditEvent = { ...base, hash: chainHash(prevHash + canonical(base)) };
    log.push(event);
    this.audit.set(agentId, log);
    return event;
  }

  /** Test seam: edit a stored event without fixing its hash. */
  tamperAuditEvent(agentId: string, seq: number, patch: Partial<AuditEvent>): void {
    const event = this.audit.get(agentId)?.find((e) => e.seq === seq);
    if (event) Object.assign(event, patch);
  }

  // ── guards ─────────────────────────────────────────────────────────────

  private requireAgent(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new AgentApiError(404, 'Agent not found');
    return agent;
  }

  private currentPolicy(agentId: string): AgentPolicyVersion {
    const list = this.versions.get(agentId) ?? [];
    return list[list.length - 1];
  }

  private expireStale(): void {
    const now = this.now();
    for (const action of this.actions.values()) {
      if (action.status === 'pending' && Date.parse(action.expiresAt) <= now) {
        action.status = 'expired';
        action.version += 1;
      }
    }
  }

  // ── owner API ──────────────────────────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    return [...this.agents.values()].map(clone);
  }

  async getAgent(id: string): Promise<Agent> {
    return clone(this.requireAgent(id));
  }

  async getPausedAll(): Promise<boolean> {
    return this.pausedAll;
  }

  async listPendingActions(): Promise<PendingAction[]> {
    this.expireStale();
    return [...this.actions.values()]
      .filter((a) => a.status === 'pending')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(clone);
  }

  async listDecidedToday(): Promise<PendingAction[]> {
    const since = this.now() - DAY;
    return [...this.actions.values()]
      .filter((a) => a.status !== 'pending' && a.decidedAt && Date.parse(a.decidedAt) >= since)
      .sort((a, b) => Date.parse(b.decidedAt!) - Date.parse(a.decidedAt!))
      .map(clone);
  }

  async getAction(id: string): Promise<PendingAction> {
    this.expireStale();
    const action = this.actions.get(id);
    if (!action) throw new AgentApiError(404, 'Action not found');
    return clone(action);
  }

  async approve(id: string, ifVersion: number): Promise<DecisionResult> {
    this.expireStale();
    const action = this.actions.get(id);
    if (!action) return { ok: false, conflict: false, error: 'Action not found' };
    if (action.version !== ifVersion || action.status !== 'pending') {
      return { ok: false, conflict: true, action: clone(action) };
    }
    const agent = this.requireAgent(action.agentId);
    if (agent.status !== 'active') {
      return { ok: false, conflict: false, error: `${agent.name} is ${agent.status}` };
    }
    if (this.pausedAll) {
      return { ok: false, conflict: false, error: 'All agents are paused' };
    }

    // Re-run the evaluator against the policy as it is now. An approval never
    // sends something the current policy forbids.
    const policy = this.currentPolicy(agent.id);
    const domains = action.envelope.to.map((addr) => addr.split('@')[1] ?? '');
    const recheck = evaluate(
      policy,
      {
        classes: [action.actionClass],
        recipientDomains: domains,
        attachmentBytes: 0,
        agentThreadCount: 0,
      },
      { sendsToday: 0, sendsByCounterpartyToday: {} },
    );
    if (recheck.decision === 'deny') {
      return {
        ok: false,
        conflict: false,
        error: `Policy v${policy.version} no longer allows this: ${recheck.reason}`,
      };
    }

    action.status = 'approved';
    action.version += 1;
    action.decidedAt = this.iso();
    action.decidedBy = this.owner;
    for (const d of domains) this.knownDomains.add(d);
    this.writeAudit(agent.id, {
      actor: { kind: 'user', id: this.owner },
      type: 'approve',
      actionClass: action.actionClass,
      policyVersion: policy.version,
      rule: action.reason.rule,
      messageRef: action.envelope.messageRef,
      counterpartyDomain: domains[0],
      summary: `Approved: ${action.envelope.subject}`,
    });
    this.writeAudit(agent.id, {
      actor: { kind: 'agent', id: agent.id },
      type: 'send',
      actionClass: action.actionClass,
      level: 'approve',
      policyVersion: policy.version,
      messageRef: action.envelope.messageRef,
      counterpartyDomain: domains[0],
      summary: `Sent to ${action.envelope.to.join(', ')}`,
    });
    return { ok: true, action: clone(action) };
  }

  async reject(id: string, ifVersion: number, note?: string): Promise<DecisionResult> {
    this.expireStale();
    const action = this.actions.get(id);
    if (!action) return { ok: false, conflict: false, error: 'Action not found' };
    if (action.version !== ifVersion || action.status !== 'pending') {
      return { ok: false, conflict: true, action: clone(action) };
    }
    action.status = 'rejected';
    action.version += 1;
    action.decidedAt = this.iso();
    action.decidedBy = this.owner;
    const agent = this.requireAgent(action.agentId);
    // A rejection resets that class's streak (§5.4).
    if (agent.classStreaks) {
      agent.classStreaks[action.actionClass] = { since: this.iso(), actions: 0 };
    }
    agent.cleanSince = this.iso();
    this.writeAudit(agent.id, {
      actor: { kind: 'user', id: this.owner },
      type: 'reject',
      actionClass: action.actionClass,
      policyVersion: this.currentPolicy(agent.id).version,
      rule: action.reason.rule,
      messageRef: action.envelope.messageRef,
      counterpartyDomain: action.counterparty.domain,
      summary: note ? `Rejected: ${note}` : `Rejected: ${action.envelope.subject}`,
    });
    return { ok: true, action: clone(action) };
  }

  async takeOver(id: string, ifVersion: number): Promise<DecisionResult> {
    const result = await this.reject(id, ifVersion, 'taken over by owner');
    if (result.ok) {
      const action = this.actions.get(id)!;
      action.status = 'cancelled';
    }
    return result.ok ? { ok: true, action: clone(this.actions.get(id)!) } : result;
  }

  async pauseAgent(id: string): Promise<Agent> {
    const agent = this.requireAgent(id);
    if (agent.status === 'revoked') throw new AgentApiError(409, 'Agent is revoked');
    agent.status = 'paused';
    this.writeAudit(id, { actor: { kind: 'user', id: this.owner }, type: 'pause' });
    return clone(agent);
  }

  async resumeAgent(id: string): Promise<Agent> {
    const agent = this.requireAgent(id);
    if (agent.status === 'revoked') throw new AgentApiError(409, 'Agent is revoked');
    agent.status = 'active';
    this.writeAudit(id, { actor: { kind: 'user', id: this.owner }, type: 'resume' });
    return clone(agent);
  }

  async pauseAll(): Promise<boolean> {
    this.pausedAll = true;
    for (const agent of this.agents.values()) {
      if (agent.status !== 'revoked') {
        this.writeAudit(agent.id, {
          actor: { kind: 'user', id: this.owner },
          type: 'pause',
          summary: 'All agents paused',
        });
      }
    }
    return true;
  }

  async resumeAll(): Promise<boolean> {
    this.pausedAll = false;
    for (const agent of this.agents.values()) {
      if (agent.status !== 'revoked') {
        this.writeAudit(agent.id, {
          actor: { kind: 'user', id: this.owner },
          type: 'resume',
          summary: 'All agents resumed',
        });
      }
    }
    return false;
  }

  /** All five steps of §4.4 happen before this returns. */
  async revoke(id: string): Promise<Agent> {
    const agent = this.requireAgent(id);
    if (agent.status === 'revoked') return clone(agent);
    agent.status = 'revoked';
    agent.revokedAt = this.iso();
    agent.revokedBy = this.owner;
    let cancelled = 0;
    for (const action of this.actions.values()) {
      if (action.agentId === id && action.status === 'pending') {
        action.status = 'cancelled';
        action.version += 1;
        action.decidedAt = this.iso();
        cancelled += 1;
      }
    }
    this.writeAudit(id, {
      actor: { kind: 'user', id: this.owner },
      type: 'revoke',
      summary: `Revoked. ${cancelled} pending ${cancelled === 1 ? 'action' : 'actions'} cancelled; inbound now goes to the owner for 30 days`,
    });
    return clone(agent);
  }

  async listPolicyVersions(agentId: string): Promise<AgentPolicyVersion[]> {
    this.requireAgent(agentId);
    return clone(this.versions.get(agentId) ?? []);
  }

  async dryRun(agentId: string, candidate: AgentPolicyDraft): Promise<DryRunResult> {
    const nextVersion = this.currentPolicy(agentId).version + 1;
    return runDryRun(candidate, this.audit.get(agentId) ?? [], nextVersion);
  }

  async publishPolicy(agentId: string, draft: AgentPolicyDraft): Promise<AgentPolicyVersion> {
    const agent = this.requireAgent(agentId);
    if (agent.status === 'revoked') throw new AgentApiError(409, 'Agent is revoked');
    const list = this.versions.get(agentId) ?? [];
    const prev = list[list.length - 1];
    // Locked classes cannot change without owner re-auth, which this
    // prototype does not have, so refuse instead of silently accepting.
    for (const cls of prev?.locked ?? []) {
      if (draft.levels[cls] !== prev.levels[cls]) {
        throw new AgentApiError(403, `${cls} is locked and needs re-authentication to change`);
      }
    }
    // Take only the editable fields. Identity, version and authorship are the
    // server's to stamp, whatever else the caller sends.
    const { levels, locked, scope, quotas } = clone(draft);
    const version: AgentPolicyVersion = {
      id: this.id('pol'),
      agentId,
      version: (prev?.version ?? 0) + 1,
      publishedBy: this.owner,
      publishedAt: this.iso(),
      levels,
      locked,
      scope,
      quotas,
    };
    list.push(version);
    this.versions.set(agentId, list);
    agent.policyVersionId = version.id;
    agent.policyVersion = version.version;
    this.writeAudit(agentId, {
      actor: { kind: 'user', id: this.owner },
      type: 'policy_publish',
      policyVersion: version.version,
      summary: `Published policy v${version.version}`,
    });
    return clone(version);
  }

  async rollbackPolicy(agentId: string, toVersion: number): Promise<AgentPolicyVersion> {
    const target = (this.versions.get(agentId) ?? []).find((v) => v.version === toVersion);
    if (!target) throw new AgentApiError(404, `No version ${toVersion}`);
    const { levels, locked, scope, quotas } = target;
    // Rollback restores an old version as a new one; history is never rewritten.
    return this.publishPolicy(agentId, clone({ levels, locked, scope, quotas }));
  }

  async listAudit(agentId?: string): Promise<AuditEvent[]> {
    const lists = agentId ? [this.audit.get(agentId) ?? []] : [...this.audit.values()];
    return lists
      .flat()
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq)
      .map(clone);
  }

  async verifyAudit(agentId: string): Promise<AuditVerifyResult> {
    const log = this.audit.get(agentId) ?? [];
    let prev = '0'.repeat(16);
    for (const event of log) {
      const { hash, ...rest } = event;
      if (event.prevHash !== prev || chainHash(prev + canonical(rest)) !== hash) {
        return { valid: false, checked: log.length, brokenAt: event.seq };
      }
      prev = hash;
    }
    return { valid: true, checked: log.length };
  }

  async digest(): Promise<DigestRow[]> {
    const since = this.now() - DAY;
    const rows = new Map<string, DigestRow>();
    for (const event of await this.listAudit()) {
      if (!event.counterpartyDomain || Date.parse(event.at) < since) continue;
      if (event.type !== 'send' && event.type !== 'queue') continue;
      const row = rows.get(event.counterpartyDomain) ?? {
        counterpartyDomain: event.counterpartyDomain,
        sent: 0,
        queued: 0,
        lastAt: event.at,
      };
      if (event.type === 'send') row.sent += 1;
      else row.queued += 1;
      if (event.at > row.lastAt) row.lastAt = event.at;
      rows.set(event.counterpartyDomain, row);
    }
    return [...rows.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  async listThreads(): Promise<AgentThread[]> {
    return [...this.threads.values()].map(clone);
  }

  async getThread(id: string): Promise<AgentThread> {
    const thread = this.threads.get(id);
    if (!thread) throw new AgentApiError(404, 'Thread not found');
    return clone(thread);
  }

  // ── agent API (simulated) ──────────────────────────────────────────────

  /**
   * POST /v1/agents/:id/messages as the agent would call it. Exposed so the
   * prototype can show a new card arriving; the real endpoint takes agent
   * credentials, never the owner's.
   */
  async simulateAgentSend(input: SimulatedSend): Promise<{
    status: 'sent' | 'queued' | 'denied' | 'paused' | 'revoked';
    actionId?: string;
    reason?: string;
  }> {
    const agent = this.requireAgent(input.agentId);
    if (agent.status === 'revoked') return { status: 'revoked' };
    if (agent.status === 'paused' || this.pausedAll) {
      this.writeAudit(agent.id, {
        actor: { kind: 'system', id: 'evaluator' },
        type: 'deny',
        rule: this.pausedAll ? 'global.pause' : 'agent.paused',
        summary: 'Send refused while paused',
      });
      return { status: 'paused' };
    }

    const domains = input.to.map((addr) => (addr.split('@')[1] ?? '').toLowerCase());
    const meta: ActionMetadata = {
      recipientDomains: domains,
      knownDomains: [...this.knownDomains],
      inKnownThread: false,
      attachmentBytes: 0,
      isForward: false,
      ...input.meta,
    };
    const classified = classifyAction(meta, input.declared, input.agentThreadCount ?? 0);
    const policy = this.currentPolicy(agent.id);
    const counterpartyCounts = this.sendsByCounterparty.get(agent.id) ?? new Map();
    const result = evaluate(policy, classified, {
      sendsToday: this.sendsToday.get(agent.id) ?? 0,
      sendsByCounterpartyToday: Object.fromEntries(counterpartyCounts),
    });
    const messageRef = `<${this.id('msg')}@${agent.address.split('@')[1]}>`;
    const actionClass = classified.classes.reduce((governing, cls) =>
      levelRank(policy.levels[cls]) < levelRank(policy.levels[governing]) ? cls : governing,
    );

    if (result.decision === 'deny') {
      this.writeAudit(agent.id, {
        actor: { kind: 'system', id: 'evaluator' },
        type: result.blocked ? 'inbound_blocked' : 'deny',
        actionClass,
        policyVersion: policy.version,
        rule: result.rule,
        counterpartyDomain: domains[0],
        summary: result.reason,
      });
      return { status: 'denied', reason: result.reason };
    }

    if (result.decision === 'allow') {
      this.sendsToday.set(agent.id, (this.sendsToday.get(agent.id) ?? 0) + 1);
      for (const d of domains) counterpartyCounts.set(d, (counterpartyCounts.get(d) ?? 0) + 1);
      this.sendsByCounterparty.set(agent.id, counterpartyCounts);
      this.writeAudit(agent.id, {
        actor: { kind: 'agent', id: agent.id },
        type: 'send',
        actionClass,
        level: result.level,
        policyVersion: policy.version,
        rule: result.rule,
        messageRef,
        counterpartyDomain: domains[0],
        summary: `Sent to ${input.to.join(', ')}`,
      });
      return { status: 'sent' };
    }

    const action: PendingAction = {
      id: this.id('act'),
      agentId: agent.id,
      policyVersionId: policy.id,
      policyVersion: policy.version,
      actionClass,
      reason: { rule: result.rule, summary: result.reason },
      envelope: { from: agent.address, to: input.to, subject: input.subject, messageRef },
      preview: input.preview,
      body: input.body ?? input.preview,
      counterparty: {
        domain: domains[0] ?? '',
        status: this.knownDomains.has(domains[0]) ? 'known' : 'new',
      },
      kind: result.escalation ? 'escalation' : 'standard',
      threadId: input.threadId,
      status: 'pending',
      version: 1,
      createdAt: this.iso(),
      expiresAt: this.iso(EXPIRY_MS),
    };
    this.actions.set(action.id, action);
    this.writeAudit(agent.id, {
      actor: { kind: 'system', id: 'evaluator' },
      type: result.escalation ? 'budget_reached' : 'queue',
      actionClass,
      level: result.level,
      policyVersion: policy.version,
      rule: result.rule,
      messageRef,
      counterpartyDomain: domains[0],
      summary: result.reason,
    });
    return { status: 'queued', actionId: action.id, reason: result.reason };
  }

  /** Simulate another device deciding first, to exercise the 409 path. */
  async simulateRemoteDecision(id: string, outcome: 'approved' | 'rejected'): Promise<void> {
    const action = this.actions.get(id);
    if (!action || action.status !== 'pending') return;
    if (outcome === 'approved') await this.approve(id, action.version);
    else await this.reject(id, action.version, 'decided on another device');
  }

  // ── seed ───────────────────────────────────────────────────────────────

  private addAgent(name: string, policy: AgentPolicyDraft, cleanDays: number): Agent {
    const domain = this.owner.split('@')[1] || 'example.com';
    const id = this.id('agt');
    const agent: Agent = {
      id,
      aliasId: this.id('als'),
      address: `${name}@${domain}`,
      ownerUserId: this.owner,
      name,
      status: 'active',
      policyVersionId: '',
      policyVersion: 0,
      createdAt: this.iso(-60 * DAY),
      cleanSince: this.iso(-cleanDays * DAY),
      classStreaks: {},
    };
    this.agents.set(id, agent);
    this.writeAudit(id, {
      actor: { kind: 'user', id: this.owner },
      type: 'policy_publish',
      policyVersion: 1,
      summary: 'Created with policy v1',
      at: this.iso(-60 * DAY),
    });
    const version: AgentPolicyVersion = {
      id: this.id('pol'),
      agentId: id,
      version: 1,
      publishedBy: this.owner,
      publishedAt: this.iso(-60 * DAY),
      ...clone(policy),
    };
    this.versions.set(id, [version]);
    agent.policyVersionId = version.id;
    agent.policyVersion = 1;
    return agent;
  }

  private seed(): void {
    for (const d of ['acme-supply.com', 'northwind.io', 'globex.net', 'contoso.org']) {
      this.knownDomains.add(d);
    }

    const billingPolicy = defaultPolicy();
    billingPolicy.levels.reply_known = 'notify';
    billingPolicy.levels.acknowledge = 'silent';
    billingPolicy.quotas.commitmentLimit = { amount: 500, currency: 'USD' };
    const billing = this.addAgent('billing-agent', billingPolicy, 41);
    billing.classStreaks = {
      reply_known: { since: this.iso(-41 * DAY), actions: 212 },
      acknowledge: { since: this.iso(-41 * DAY), actions: 96 },
      first_contact: { since: this.iso(-34 * DAY), actions: 58 },
      commitment: { since: this.iso(-9 * DAY), actions: 7 },
    };

    const schedulingPolicy = defaultPolicy();
    schedulingPolicy.levels.reply_known = 'notify';
    schedulingPolicy.levels.initiate_known = 'approve';
    schedulingPolicy.quotas.agentThreadBudget = 6;
    const scheduling = this.addAgent('scheduling-agent', schedulingPolicy, 12);
    scheduling.classStreaks = {
      reply_known: { since: this.iso(-12 * DAY), actions: 44 },
    };

    const research = this.addAgent('research-agent', defaultPolicy(), 3);
    research.status = 'paused';
    this.writeAudit(research.id, {
      actor: { kind: 'user', id: this.owner },
      type: 'pause',
      at: this.iso(-2 * DAY),
    });

    // A history of sends so the digest and dry run have something to read.
    const history: Array<[Agent, ActionClass, string, number]> = [
      [billing, 'reply_known', 'acme-supply.com', 3],
      [billing, 'reply_known', 'northwind.io', 5],
      [billing, 'acknowledge', 'globex.net', 7],
      [billing, 'acknowledge', 'acme-supply.com', 9],
      [billing, 'reply_known', 'contoso.org', 11],
      [scheduling, 'reply_known', 'northwind.io', 4],
      [scheduling, 'reply_known', 'globex.net', 6],
    ];
    for (const [agent, cls, domain, hoursAgo] of history) {
      for (let i = 0; i < 4; i++) {
        this.writeAudit(agent.id, {
          actor: { kind: 'agent', id: agent.id },
          type: 'send',
          actionClass: cls,
          level: cls === 'acknowledge' && agent === billing ? 'silent' : 'notify',
          policyVersion: 1,
          messageRef: `<${this.id('msg')}@${agent.address.split('@')[1]}>`,
          counterpartyDomain: domain,
          summary: `Sent to ${domain}`,
          at: this.iso(-(hoursAgo + i * 0.4) * HOUR),
        });
      }
    }

    const queue = (
      agent: Agent,
      cls: ActionClass,
      fields: Partial<PendingAction> & {
        to: string[];
        subject: string;
        preview: string;
        body: string;
        rule: string;
        summary: string;
      },
      minutesAgo: number,
    ): PendingAction => {
      const domain = fields.to[0].split('@')[1];
      const action: PendingAction = {
        id: this.id('act'),
        agentId: agent.id,
        policyVersionId: agent.policyVersionId,
        policyVersion: agent.policyVersion,
        actionClass: cls,
        reason: { rule: fields.rule, summary: fields.summary },
        envelope: {
          from: agent.address,
          to: fields.to,
          subject: fields.subject,
          messageRef: `<${this.id('msg')}@${agent.address.split('@')[1]}>`,
        },
        preview: fields.preview,
        body: fields.body,
        counterparty: fields.counterparty ?? {
          domain,
          status: this.knownDomains.has(domain) ? 'known' : 'new',
          lastContact: this.knownDomains.has(domain) ? this.iso(-3 * DAY) : undefined,
          messages: this.knownDomains.has(domain) ? 23 : 0,
        },
        kind: fields.kind ?? 'standard',
        unusual: fields.unusual,
        threadId: fields.threadId,
        status: 'pending',
        version: 1,
        createdAt: this.iso(-minutesAgo * 60_000),
        expiresAt: this.iso(EXPIRY_MS - minutesAgo * 60_000),
      };
      this.actions.set(action.id, action);
      this.writeAudit(agent.id, {
        actor: { kind: 'system', id: 'evaluator' },
        type: action.kind === 'escalation' ? 'budget_reached' : 'queue',
        actionClass: cls,
        level: 'approve',
        policyVersion: agent.policyVersion,
        rule: fields.rule,
        messageRef: action.envelope.messageRef,
        counterpartyDomain: domain,
        summary: fields.summary,
        at: action.createdAt,
      });
      return action;
    };

    queue(
      billing,
      'commitment',
      {
        to: ['ap@acme-supply.com'],
        subject: 'Re: Q4 renewal quote',
        preview: 'Confirming the renewal at $1,840/yr for 12 seats, starting November 1.',
        body:
          'Hi Dana,\n\nConfirming the renewal at $1,840/yr for 12 seats, starting November 1. ' +
          'Invoice to follow from our side once you countersign.\n\nThanks,\nbilling-agent\n\n' +
          '--\nSent by an automated agent on behalf of the account owner.',
        rule: 'quota.commitment_limit',
        summary: 'Commitments over $500 need a human',
      },
      14,
    );

    queue(
      billing,
      'first_contact',
      {
        to: ['billing@initech.dev'],
        subject: 'Invoice #4471 past due',
        preview: 'Following up on invoice #4471, now 15 days past due.',
        body:
          'Hello,\n\nFollowing up on invoice #4471 (issued Sept 12), now 15 days past due. ' +
          'A copy is linked from your billing portal.\n\nRegards,\nbilling-agent\n\n' +
          '--\nSent by an automated agent on behalf of the account owner.',
        rule: 'level.first_contact',
        summary: 'First contact with a new domain needs a human',
      },
      52,
    );

    const thread: AgentThread = {
      id: this.id('thr'),
      agentId: scheduling.id,
      subject: 'Finding a time: onboarding call',
      counterparty: 'assistant@northwind.io',
      summary:
        'Both agents have proposed four slots each. None overlap; the counterparty agent keeps ' +
        'offering mornings in UTC+9 while our calendar has only afternoons free.',
      budgetUsed: 6,
      budget: 6,
      messages: [
        ['ours', 'Proposing Tue 14:00 or Wed 15:30 (UTC-7).'],
        ['theirs', 'Those do not work. Could you do Thu 09:00 or Fri 08:30 (UTC+9)?'],
        ['ours', 'Thu and Fri mornings are blocked. Mon 16:00 or Tue 17:00 (UTC-7)?'],
        ['theirs', 'Unfortunately not. Offering Mon 10:00 or Wed 09:30 (UTC+9).'],
        ['ours', 'Not available then. Wed 16:00 or Thu 16:30 (UTC-7)?'],
        ['theirs', 'Could we look at Fri 09:00 or Mon 08:00 (UTC+9)?'],
      ].map(([side, body], i) => ({
        id: this.id('tm'),
        from: side === 'ours' ? scheduling.address : 'assistant@northwind.io',
        isAgent: true,
        side: side as 'ours' | 'theirs',
        at: this.iso(-(6 - i) * 2 * HOUR),
        body,
      })),
    };
    this.threads.set(thread.id, thread);

    const escalation = queue(
      scheduling,
      'reply_known',
      {
        to: ['assistant@northwind.io'],
        subject: 'Re: Finding a time: onboarding call',
        preview: 'Proposing Tue 13:00 or Thu 17:00 (UTC-7).',
        body: 'Proposing Tue 13:00 or Thu 17:00 (UTC-7).',
        rule: 'quota.agent_thread_budget',
        summary: 'Conversation budget reached',
        kind: 'escalation',
        threadId: thread.id,
        counterparty: {
          domain: 'northwind.io',
          status: 'agent',
          lastContact: this.iso(-2 * HOUR),
          messages: 6,
        },
      },
      25,
    );
    thread.pendingActionId = escalation.id;

    // Unusual: a scope refusal triggered by an inbound message.
    this.writeAudit(billing.id, {
      actor: { kind: 'system', id: 'evaluator' },
      type: 'inbound_blocked',
      actionClass: 'forward',
      policyVersion: 1,
      rule: 'level.forward',
      messageRef: `<${this.id('msg')}@mailer.unknown-vendor.biz>`,
      counterpartyDomain: 'unknown-vendor.biz',
      summary:
        'An inbound message asked billing-agent to forward all invoices to an outside address. ' +
        'Forwards are not allowed, so the server refused it.',
      at: this.iso(-3 * HOUR),
    });
  }
}
