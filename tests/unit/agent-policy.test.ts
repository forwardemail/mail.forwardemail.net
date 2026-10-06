import { describe, expect, it } from 'vitest';
import {
  allowedLevels,
  classifyAction,
  defaultPolicy,
  dryRun,
  evaluate,
  levelRank,
  type ClassifiedAction,
  type QuotaContext,
} from '../../src/utils/agent-policy';
import { ACTION_CLASSES, AUTONOMY_LEVELS } from '../../src/types/agents';
import type {
  ActionClass,
  AgentPolicyDraft,
  AuditEvent,
  AutonomyLevel,
} from '../../src/types/agents';

const NO_USAGE: QuotaContext = { sendsToday: 0, sendsByCounterpartyToday: {} };

const policyWith = (
  overrides: Partial<Record<ActionClass, AutonomyLevel>> = {},
): AgentPolicyDraft => {
  const base = defaultPolicy();
  return { ...base, levels: { ...base.levels, ...overrides }, locked: [] };
};

const action = (
  classes: ActionClass[],
  extra: Partial<ClassifiedAction> = {},
): ClassifiedAction => ({
  classes,
  recipientDomains: ['acme.com'],
  attachmentBytes: 0,
  agentThreadCount: 0,
  ...extra,
});

/** Deterministic PRNG so property runs are reproducible. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};
const pick = <T>(rand: () => number, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)];

describe('evaluate: every action class at every level', () => {
  const expected: Record<AutonomyLevel, 'allow' | 'queue' | 'deny'> = {
    off: 'deny',
    draft: 'queue',
    approve: 'queue',
    notify: 'allow',
    silent: 'allow',
  };

  for (const cls of ACTION_CLASSES) {
    for (const level of AUTONOMY_LEVELS) {
      // Unclassified is floored at approve whatever the policy says.
      const want =
        cls === 'unclassified' && levelRank(level) > levelRank('approve')
          ? 'queue'
          : expected[level];
      it(`${cls} at ${level} → ${want}`, () => {
        const result = evaluate(policyWith({ [cls]: level }), action([cls]), NO_USAGE);
        expect(result.decision).toBe(want);
      });
    }
  }
});

describe('evaluate: rules', () => {
  it('takes the most restrictive class when several apply', () => {
    const p = policyWith({ reply_known: 'silent', attach: 'approve' });
    const r = evaluate(p, action(['reply_known', 'attach']), NO_USAGE);
    expect(r.decision).toBe('queue');
    expect(r.rule).toBe('level.attach');
  });

  it('refuses recipients outside writeDomains and marks it blocked', () => {
    const p = policyWith({ reply_known: 'silent' });
    p.scope.writeDomains = ['acme.com'];
    const r = evaluate(p, action(['reply_known'], { recipientDomains: ['evil.test'] }), NO_USAGE);
    expect(r).toMatchObject({ decision: 'deny', rule: 'scope.write_domains', blocked: true });
  });

  it('treats an empty writeDomains as no allowlist', () => {
    const p = policyWith({ reply_known: 'silent' });
    p.scope.writeDomains = [];
    expect(evaluate(p, action(['reply_known']), NO_USAGE).decision).toBe('allow');
  });

  it('refuses attachments over the scope limit', () => {
    const p = policyWith({ attach: 'silent' });
    p.scope.maxAttachmentBytes = 100;
    const r = evaluate(p, action(['attach'], { attachmentBytes: 101 }), NO_USAGE);
    expect(r.decision).toBe('deny');
  });

  it('queues commitments over the limit with a plain-language reason', () => {
    const p = policyWith({ commitment: 'silent' });
    p.quotas.commitmentLimit = { amount: 500, currency: 'USD' };
    const r = evaluate(
      p,
      action(['reply_known', 'commitment'], { commitment: { amount: 1840, currency: 'USD' } }),
      NO_USAGE,
    );
    expect(r.decision).toBe('queue');
    expect(r.reason).toBe('Commitments over $500 need a human');
  });

  it('queues a commitment in a different currency rather than guessing the rate', () => {
    const p = policyWith({ commitment: 'silent', reply_known: 'silent' });
    p.quotas.commitmentLimit = { amount: 500, currency: 'USD' };
    const r = evaluate(
      p,
      action(['reply_known', 'commitment'], { commitment: { amount: 10, currency: 'EUR' } }),
      NO_USAGE,
    );
    expect(r.decision).toBe('queue');
  });

  it('escalates when the agent-to-agent budget is reached', () => {
    const p = policyWith({ reply_known: 'silent' });
    const r = evaluate(p, action(['reply_known'], { agentThreadCount: 6 }), NO_USAGE);
    expect(r).toMatchObject({
      decision: 'queue',
      escalation: true,
      reason: 'Conversation budget reached',
    });
  });

  it('turns an allow into a queue when the daily quota is used up', () => {
    const p = policyWith({ reply_known: 'silent' });
    const r = evaluate(p, action(['reply_known']), {
      sendsToday: 100,
      sendsByCounterpartyToday: {},
    });
    expect(r).toMatchObject({ decision: 'queue', rule: 'quota.sends_per_day' });
  });

  it('turns an allow into a queue when the per-counterparty quota is used up', () => {
    const p = policyWith({ reply_known: 'silent' });
    const r = evaluate(p, action(['reply_known']), {
      sendsToday: 0,
      sendsByCounterpartyToday: { 'acme.com': 20 },
    });
    expect(r).toMatchObject({ decision: 'queue', rule: 'quota.sends_per_counterparty' });
  });

  it('never lets a quota turn a deny into something else', () => {
    const p = policyWith({ forward: 'off' });
    const r = evaluate(p, action(['forward']), { sendsToday: 1000, sendsByCounterpartyToday: {} });
    expect(r.decision).toBe('deny');
  });

  it('treats an action with no classes as unclassified', () => {
    const r = evaluate(policyWith({ unclassified: 'approve' }), action([]), NO_USAGE);
    expect(r.decision).toBe('queue');
  });
});

describe('allowedLevels', () => {
  it('never offers a level the server cannot apply', () => {
    for (const cls of ['unclassified', 'initiate_known'] as ActionClass[]) {
      expect(allowedLevels(cls)).toEqual(['off', 'draft', 'approve']);
    }
    expect(allowedLevels('reply_known')).toEqual([...AUTONOMY_LEVELS]);
  });
});

describe('classifyAction', () => {
  const meta = {
    recipientDomains: ['acme.com'],
    knownDomains: ['acme.com'],
    inKnownThread: true,
    attachmentBytes: 0,
    isForward: false,
  };

  it('classifies a reply in a known thread from metadata alone', () => {
    expect(classifyAction(meta, null).classes).toEqual(['reply_known']);
  });

  it('marks an unknown recipient domain as first contact', () => {
    expect(classifyAction({ ...meta, recipientDomains: ['new.dev'] }, null).classes).toContain(
      'first_contact',
    );
  });

  it('does not let a declaration clear unclassified on a new thread', () => {
    const c = classifyAction({ ...meta, inKnownThread: false }, { class: 'acknowledge' });
    expect(c.classes).toContain('unclassified');
  });

  it('marks an undeclared new thread as unclassified', () => {
    const c = classifyAction({ ...meta, inKnownThread: false }, null);
    expect(c.classes).toEqual(expect.arrayContaining(['initiate_known', 'unclassified']));
  });

  it('keeps metadata classes when the agent declares something milder', () => {
    const c = classifyAction({ ...meta, recipientDomains: ['new.dev'] }, { class: 'acknowledge' });
    expect(c.classes).toEqual(expect.arrayContaining(['first_contact', 'acknowledge']));
  });

  it('treats an unknown declared class as unclassified', () => {
    const c = classifyAction(meta, { class: 'totally_safe' as ActionClass });
    expect(c.classes).toContain('unclassified');
  });

  it('treats a commitment with no amount as unbounded', () => {
    const c = classifyAction(meta, { class: 'commitment' });
    expect(c.commitment?.amount).toBe(Infinity);
  });
});

describe('properties', () => {
  const randomPolicy = (rand: () => number): AgentPolicyDraft => {
    const p = defaultPolicy();
    for (const cls of ACTION_CLASSES) p.levels[cls] = pick(rand, AUTONOMY_LEVELS);
    p.quotas.commitmentLimit = rand() > 0.5 ? { amount: 500, currency: 'USD' } : undefined;
    return p;
  };

  const randomMeta = (rand: () => number) => ({
    recipientDomains: [pick(rand, ['acme.com', 'new.dev', 'globex.net'])],
    knownDomains: ['acme.com', 'globex.net'],
    inKnownThread: rand() > 0.5,
    attachmentBytes: rand() > 0.7 ? 5000 : 0,
    isForward: rand() > 0.85,
  });

  const restriction = (d: 'allow' | 'queue' | 'deny') => ({ allow: 0, queue: 1, deny: 2 })[d];

  it('a declaration never lowers restriction', () => {
    const rand = rng(42);
    for (let i = 0; i < 2000; i++) {
      const policy = randomPolicy(rand);
      const meta = randomMeta(rand);
      const ctx = { sendsToday: Math.floor(rand() * 120), sendsByCounterpartyToday: {} };
      const undeclared = evaluate(policy, classifyAction(meta, null), ctx);
      const declared = evaluate(
        policy,
        classifyAction(meta, {
          class: pick(rand, ACTION_CLASSES),
          amount: Math.floor(rand() * 2000),
          currency: 'USD',
        }),
        ctx,
      );
      expect(restriction(declared.decision)).toBeGreaterThanOrEqual(
        restriction(undeclared.decision),
      );
    }
  });

  it('unclassified never yields allow', () => {
    const rand = rng(7);
    for (let i = 0; i < 2000; i++) {
      const policy = randomPolicy(rand);
      const extra = ACTION_CLASSES.filter(() => rand() > 0.7);
      const r = evaluate(policy, action(['unclassified', ...extra]), NO_USAGE);
      expect(r.decision).not.toBe('allow');
    }
  });

  it('evaluate is pure: same inputs, same output, inputs untouched', () => {
    const rand = rng(99);
    for (let i = 0; i < 200; i++) {
      const policy = randomPolicy(rand);
      const a = action([pick(rand, ACTION_CLASSES)]);
      const before = JSON.stringify([policy, a]);
      expect(evaluate(policy, a, NO_USAGE)).toEqual(evaluate(policy, a, NO_USAGE));
      expect(JSON.stringify([policy, a])).toBe(before);
    }
  });
});

describe('dryRun', () => {
  const event = (type: 'send' | 'queue', actionClass: ActionClass): AuditEvent => ({
    id: Math.random().toString(36),
    agentId: 'a',
    seq: 1,
    prevHash: '',
    hash: '',
    at: new Date().toISOString(),
    actor: { kind: 'agent', id: 'a' },
    type,
    actionClass,
  });

  it('summarises how many recent actions would change', () => {
    const events = [
      ...Array.from({ length: 14 }, () => event('send', 'reply_known')),
      ...Array.from({ length: 6 }, () => event('send', 'acknowledge')),
    ];
    const r = dryRun(policyWith({ reply_known: 'approve', acknowledge: 'silent' }), events, 5);
    expect(r.changed).toBe(14);
    expect(r.summary).toBe(
      'Under v5, 14 of the last 20 actions would have queued instead of sending',
    );
  });

  it('only looks at the last 200 decisive events', () => {
    const events = Array.from({ length: 250 }, () => event('send', 'reply_known'));
    expect(dryRun(policyWith({ reply_known: 'silent' }), events, 2).sampled).toBe(200);
  });
});
