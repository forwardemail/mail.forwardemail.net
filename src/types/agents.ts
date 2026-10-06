/**
 * Agent mode domain model, per docs/agent-mode-spec §3.
 *
 * Names are normative and shared with the server. The client never enforces
 * any of this: the server evaluates every agent send at submission time and
 * the UI only shows what it decided.
 */

export type AgentStatus = 'active' | 'paused' | 'revoked';

export type AutonomyLevel = 'off' | 'draft' | 'approve' | 'notify' | 'silent';

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  'off',
  'draft',
  'approve',
  'notify',
  'silent',
] as const;

export type ActionClass =
  | 'reply_known'
  | 'initiate_known'
  | 'first_contact'
  | 'acknowledge'
  | 'attach'
  | 'forward'
  | 'commitment'
  | 'unclassified';

export const ACTION_CLASSES: readonly ActionClass[] = [
  'reply_known',
  'initiate_known',
  'first_contact',
  'acknowledge',
  'attach',
  'forward',
  'commitment',
  'unclassified',
] as const;

export interface AgentScope {
  writeDomains: string[];
  readFolders: string[];
  maxAttachmentBytes: number;
}

export interface AgentQuotas {
  sendsPerDay: number;
  sendsPerCounterpartyPerDay: number;
  agentThreadBudget: number;
  commitmentLimit?: { amount: number; currency: string };
}

export interface AgentPolicyVersion {
  id: string;
  agentId: string;
  version: number;
  publishedBy: string;
  publishedAt: string;
  levels: Record<ActionClass, AutonomyLevel>;
  locked: ActionClass[];
  scope: AgentScope;
  quotas: AgentQuotas;
}

/** The editable part of a policy, before the server stamps it as a version. */
export type AgentPolicyDraft = Pick<AgentPolicyVersion, 'levels' | 'locked' | 'scope' | 'quotas'>;

export interface Agent {
  id: string;
  aliasId: string;
  address: string;
  ownerUserId: string;
  name: string;
  status: AgentStatus;
  policyVersionId: string;
  policyVersion: number;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
  cleanSince: string;
  /** Per-class streaks, for the earned-autonomy display (§5.4). */
  classStreaks?: Partial<Record<ActionClass, { since: string; actions: number }>>;
}

export type PendingActionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface PendingAction {
  id: string;
  agentId: string;
  policyVersionId: string;
  policyVersion: number;
  actionClass: ActionClass;
  /** Shown in the UI verbatim. Never rewritten client-side. */
  reason: { rule: string; summary: string };
  envelope: { from: string; to: string[]; subject: string; messageRef: string };
  preview: string;
  body?: string;
  counterparty: {
    domain: string;
    status: 'known' | 'new' | 'agent';
    lastContact?: string;
    messages?: number;
  };
  /** 'escalation' cards offer Take over / Decline instead of Approve. */
  kind: 'standard' | 'escalation';
  unusual?: boolean;
  threadId?: string;
  status: PendingActionStatus;
  version: number;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  expiresAt: string;
}

export type AuditEventType =
  | 'send'
  | 'queue'
  | 'approve'
  | 'reject'
  | 'deny'
  | 'policy_publish'
  | 'pause'
  | 'resume'
  | 'revoke'
  | 'inbound_blocked'
  | 'budget_reached';

export interface AuditEvent {
  id: string;
  agentId: string;
  seq: number;
  prevHash: string;
  hash: string;
  at: string;
  actor: { kind: 'agent' | 'user' | 'system'; id: string };
  type: AuditEventType;
  actionClass?: ActionClass;
  level?: AutonomyLevel;
  policyVersion?: number;
  rule?: string;
  /** Message-ID only. The audit log never stores bodies. */
  messageRef?: string;
  counterpartyDomain?: string;
  /** Plain-language line for the UI, written by the server. */
  summary?: string;
}

export interface AgentThreadMessage {
  id: string;
  from: string;
  isAgent: boolean;
  /** Whose agent: ours, theirs, or a human. */
  side: 'ours' | 'theirs' | 'human';
  at: string;
  body: string;
}

export interface AgentThread {
  id: string;
  agentId: string;
  subject: string;
  counterparty: string;
  summary: string;
  budgetUsed: number;
  budget: number;
  messages: AgentThreadMessage[];
  pendingActionId?: string;
}

export interface DigestRow {
  counterpartyDomain: string;
  sent: number;
  queued: number;
  lastAt: string;
}

/** The server's answer to approve/reject. 409 carries the current state. */
export type DecisionResult =
  | { ok: true; action: PendingAction }
  | { ok: false; conflict: true; action: PendingAction }
  | { ok: false; conflict: false; error: string };

export interface DryRunResult {
  sampled: number;
  changed: number;
  /** "Under v5, 14 of the last 200 actions would have queued instead of sending" */
  summary: string;
  byClass: Partial<Record<ActionClass, { from: string; to: string; count: number }>>;
}

export interface AuditVerifyResult {
  valid: boolean;
  checked: number;
  brokenAt?: number;
}
