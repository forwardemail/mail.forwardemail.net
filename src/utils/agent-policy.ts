/**
 * Agent policy evaluator, spec §4.2 and §4.3.
 *
 * The server is the only enforcer. This module is the reference
 * implementation of the pure evaluate() function the server will run, kept
 * here so the prototype's mock backend and the policy editor's dry run use
 * the exact same rules, and so the table-driven tests can be lifted into the
 * server repo as they are. Nothing in the client may use a result from this
 * file to decide whether a message is sent.
 *
 * No I/O, no clock reads, no randomness. Every input arrives as an argument.
 */

import type {
  ActionClass,
  AgentPolicyDraft,
  AuditEvent,
  AutonomyLevel,
  DryRunResult,
} from '../types/agents';
import { ACTION_CLASSES, AUTONOMY_LEVELS } from '../types/agents';

/** Lower index means less autonomy, so more restrictive. */
const LEVEL_RANK: Record<AutonomyLevel, number> = {
  off: 0,
  draft: 1,
  approve: 2,
  notify: 3,
  silent: 4,
};

export const levelRank = (level: AutonomyLevel): number => LEVEL_RANK[level] ?? 0;

export const mostRestrictive = (levels: AutonomyLevel[]): AutonomyLevel =>
  levels.reduce<AutonomyLevel>(
    (lowest, level) => (levelRank(level) < levelRank(lowest) ? level : lowest),
    'silent',
  );

/** Facts the server derives itself from the message. Never taken from the agent. */
export interface ActionMetadata {
  recipientDomains: string[];
  /** Domains the account has corresponded with before. */
  knownDomains: string[];
  /** In-Reply-To matches a thread this agent participates in. */
  inKnownThread: boolean;
  attachmentBytes: number;
  /** Resent-* headers or forwarded-content markers. */
  isForward: boolean;
}

/** What the agent says about its own message via X-FE-Agent-Action or the API. */
export interface ActionDeclaration {
  class?: ActionClass;
  amount?: number;
  currency?: string;
}

export interface ClassifiedAction {
  classes: ActionClass[];
  recipientDomains: string[];
  attachmentBytes: number;
  commitment?: { amount: number; currency: string };
  /** Consecutive agent-authored messages in this thread, both sides. */
  agentThreadCount: number;
}

export interface QuotaContext {
  sendsToday: number;
  sendsByCounterpartyToday: Record<string, number>;
}

export type Decision = 'allow' | 'queue' | 'deny';

export interface Evaluation {
  decision: Decision;
  level: AutonomyLevel;
  /** Stable rule id, recorded in the audit log. */
  rule: string;
  /** Plain-language reason, shown verbatim in the UI. */
  reason: string;
  /** True when the queue came from the loop guard and needs Take over / Decline. */
  escalation?: boolean;
  /** True for scope refusals that belong in Unusual as inbound_blocked. */
  blocked?: boolean;
}

/**
 * Turn server-derived metadata plus the agent's declaration into the set of
 * classes the action belongs to.
 *
 * A declaration only ever adds a class, so it can never make an action less
 * restricted than its metadata already makes it: evaluate() takes the most
 * restrictive level across every class present.
 */
export function classifyAction(
  meta: ActionMetadata,
  declared: ActionDeclaration | null | undefined,
  agentThreadCount = 0,
): ClassifiedAction {
  const classes = new Set<ActionClass>();
  const known = new Set(meta.knownDomains.map((d) => d.toLowerCase()));
  const domains = meta.recipientDomains.map((d) => d.toLowerCase());

  if (domains.length === 0 || domains.some((d) => !known.has(d))) {
    classes.add('first_contact');
  } else if (meta.inKnownThread) {
    classes.add('reply_known');
  } else {
    classes.add('initiate_known');
  }

  if (meta.attachmentBytes > 0) classes.add('attach');
  if (meta.isForward) classes.add('forward');

  let commitment: ClassifiedAction['commitment'];
  if (declared?.class && ACTION_CLASSES.includes(declared.class)) {
    classes.add(declared.class);
    if (declared.class === 'commitment') {
      commitment = {
        amount: Number.isFinite(declared.amount) ? Number(declared.amount) : Infinity,
        currency: (declared.currency || '').toUpperCase(),
      };
    }
  } else if (declared?.class) {
    // A declaration we don't recognise is not something to guess about.
    classes.add('unclassified');
  }

  // A new thread has nothing in its metadata that marks it safe, so it is
  // unclassified (invariant 9). A declaration cannot clear that: if it could,
  // declaring "acknowledge" would make a new thread less restricted than
  // declaring nothing. A reply in a known thread is classified by metadata.
  if (classes.has('initiate_known')) {
    classes.add('unclassified');
  }

  return {
    classes: [...classes],
    recipientDomains: domains,
    attachmentBytes: meta.attachmentBytes,
    commitment,
    agentThreadCount,
  };
}

const levelToDecision = (level: AutonomyLevel): Decision => {
  if (level === 'off') return 'deny';
  if (level === 'draft' || level === 'approve') return 'queue';
  return 'allow';
};

const CLASS_LABEL: Record<ActionClass, string> = {
  reply_known: 'Replies to known contacts',
  initiate_known: 'New threads to known contacts',
  first_contact: 'First contact with a new domain',
  acknowledge: 'Acknowledgements',
  attach: 'Messages with attachments',
  forward: 'Forwards',
  commitment: 'Commitments',
  unclassified: 'Unclassified messages',
};

export const actionClassLabel = (cls: ActionClass): string => CLASS_LABEL[cls] ?? cls;

const LEVEL_PHRASE: Record<AutonomyLevel, string> = {
  off: 'are not allowed',
  draft: 'go to Drafts for a human to edit',
  approve: 'need a human',
  notify: 'send and appear in the digest',
  silent: 'send without notice',
};

const formatMoney = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};

/**
 * evaluate(policy, action, ctx) → { decision, level, rule, reason }
 *
 * Order matters. Hard scope refusals come first because no level can grant
 * what scope forbids. Then the class levels. Then the guards that can only
 * push an allow down to a queue (unclassified floor, commitment limit,
 * conversation budget, quotas).
 */
export function evaluate(
  policy: AgentPolicyDraft,
  action: ClassifiedAction,
  ctx: QuotaContext,
): Evaluation {
  const { scope, quotas, levels } = policy;

  // 1. Scope. These are refusals, not questions for a human.
  if (scope.writeDomains.length > 0) {
    const allowed = new Set(scope.writeDomains.map((d) => d.toLowerCase()));
    const outside = action.recipientDomains.find((d) => !allowed.has(d));
    if (outside) {
      return {
        decision: 'deny',
        level: 'off',
        rule: 'scope.write_domains',
        reason: `${outside} is outside this agent's allowed recipient domains`,
        blocked: true,
      };
    }
  }

  if (action.attachmentBytes > scope.maxAttachmentBytes) {
    return {
      decision: 'deny',
      level: 'off',
      rule: 'scope.max_attachment_bytes',
      reason: 'Attachments are larger than this agent may send',
      blocked: true,
    };
  }

  // 2. Class levels. The most restrictive class wins.
  const classes: ActionClass[] = action.classes.length ? action.classes : ['unclassified'];
  let governing: ActionClass = classes[0];
  for (const cls of classes) {
    const current = levels[cls] ?? 'off';
    if (levelRank(current) < levelRank(levels[governing] ?? 'off')) governing = cls;
  }
  let level: AutonomyLevel = levels[governing] ?? 'off';
  let rule = `level.${governing}`;
  let reason = `${CLASS_LABEL[governing]} ${LEVEL_PHRASE[level]}`;

  if (levelToDecision(level) === 'deny') {
    return {
      decision: 'deny',
      level,
      rule,
      reason,
      blocked: governing === 'forward',
    };
  }

  // 3. Unknown means most restrictive. Unclassified never sends on its own,
  // whatever level the policy gives it.
  if (classes.includes('unclassified') && levelRank(level) > levelRank('approve')) {
    level = 'approve';
    rule = 'floor.unclassified';
    reason = 'The agent did not say what kind of message this is, so a human checks it';
  }

  // 4. Commitment limit. Over the limit always needs a human.
  if (action.commitment && quotas.commitmentLimit) {
    const limit = quotas.commitmentLimit;
    const sameCurrency = action.commitment.currency === limit.currency.toUpperCase();
    if (!sameCurrency || action.commitment.amount > limit.amount) {
      if (levelRank(level) > levelRank('approve')) level = 'approve';
      rule = 'quota.commitment_limit';
      reason = `Commitments over ${formatMoney(limit.amount, limit.currency)} need a human`;
    }
  }

  // 5. Loop guard (§6.2). Escalate rather than ask for a yes/no.
  if (action.agentThreadCount >= quotas.agentThreadBudget) {
    return {
      decision: 'queue',
      level: 'approve',
      rule: 'quota.agent_thread_budget',
      reason: 'Conversation budget reached',
      escalation: true,
    };
  }

  let decision = levelToDecision(level);

  // 6. Quotas only ever convert allow into queue.
  if (decision === 'allow') {
    if (ctx.sendsToday >= quotas.sendsPerDay) {
      return {
        decision: 'queue',
        level: 'approve',
        rule: 'quota.sends_per_day',
        reason: `Daily limit of ${quotas.sendsPerDay} sends reached`,
      };
    }
    const busiest = action.recipientDomains.find(
      (d) => (ctx.sendsByCounterpartyToday[d] ?? 0) >= quotas.sendsPerCounterpartyPerDay,
    );
    if (busiest) {
      return {
        decision: 'queue',
        level: 'approve',
        rule: 'quota.sends_per_counterparty',
        reason: `Daily limit of ${quotas.sendsPerCounterpartyPerDay} sends to ${busiest} reached`,
      };
    }
  }

  decision = levelToDecision(level);
  return { decision, level, rule, reason };
}

/**
 * Dry run (§4.3): replay recent audit events under a candidate policy and
 * report how outcomes would have changed. Works on the audit log's metadata
 * only (class and level), which is all the log keeps.
 */
export function dryRun(
  candidate: AgentPolicyDraft,
  events: AuditEvent[],
  candidateVersion: number,
): DryRunResult {
  const decisive = events
    .filter((e) => (e.type === 'send' || e.type === 'queue') && e.actionClass)
    .slice(-200);
  const byClass: DryRunResult['byClass'] = {};
  let changed = 0;

  for (const event of decisive) {
    const cls = event.actionClass as ActionClass;
    const before: Decision = event.type === 'send' ? 'allow' : 'queue';
    let next = candidate.levels[cls] ?? 'off';
    if (cls === 'unclassified' && levelRank(next) > levelRank('approve')) next = 'approve';
    const after = levelToDecision(next);
    if (after !== before) {
      changed += 1;
      const entry = byClass[cls] ?? { from: describe(before), to: describe(after), count: 0 };
      entry.count += 1;
      byClass[cls] = entry;
    }
  }

  const transitions = Object.values(byClass);
  let summary: string;
  if (decisive.length === 0) {
    summary = 'No recent actions to compare against';
  } else if (changed === 0) {
    summary = `Under v${candidateVersion}, none of the last ${decisive.length} actions would have changed`;
  } else if (transitions.length === 1) {
    const t = transitions[0];
    summary = `Under v${candidateVersion}, ${changed} of the last ${decisive.length} actions would have ${t.to} instead of ${t.from === 'sent' ? 'sending' : t.from === 'queued' ? 'queuing' : 'being refused'}`;
  } else {
    summary = `Under v${candidateVersion}, ${changed} of the last ${decisive.length} actions would have had a different outcome`;
  }

  return { sampled: decisive.length, changed, summary, byClass };
}

const describe = (d: Decision): string =>
  d === 'allow' ? 'sent' : d === 'queue' ? 'queued' : 'been refused';

/** Defaults for a new agent. Conservative on purpose (§4.2). */
export function defaultPolicy(): AgentPolicyDraft {
  return {
    levels: {
      reply_known: 'approve',
      initiate_known: 'draft',
      first_contact: 'approve',
      acknowledge: 'notify',
      attach: 'approve',
      forward: 'off',
      commitment: 'approve',
      unclassified: 'approve',
    },
    locked: ['unclassified'],
    scope: { writeDomains: [], readFolders: ['INBOX'], maxAttachmentBytes: 10 * 1024 * 1024 },
    quotas: { sendsPerDay: 100, sendsPerCounterpartyPerDay: 20, agentThreadBudget: 6 },
  };
}

/**
 * Levels a class may take. Unclassified is floored at approve, and a new
 * thread always carries unclassified (see classifyAction), so offering
 * Notify or Silent for either would show a level the server never applies.
 */
export function allowedLevels(cls: ActionClass): AutonomyLevel[] {
  if (cls === 'unclassified' || cls === 'initiate_known') {
    return AUTONOMY_LEVELS.filter((l) => levelRank(l) <= levelRank('approve'));
  }
  return [...AUTONOMY_LEVELS];
}
