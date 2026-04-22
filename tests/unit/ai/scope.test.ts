/**
 * Scope enforcement tests.
 *
 * Scope is the security boundary between "what the user authorized the AI to
 * see" and "the full mailbox". Two invariants these tests lock in:
 *
 *   1. The model cannot widen scope. If the model returns a tool call with a
 *      `from` filter that names an address outside the participant set, the
 *      merge must intersect it back — never pass it through.
 *   2. Even if a tool returns out-of-scope rows (buggy compiler, cache
 *      pollution), enforceScope filters them before they reach the model.
 *
 * Weakening either invariant turns Ask AI into a cross-customer data leak in
 * a shared support inbox, which is the motivation for scope existing at all.
 */

import { describe, expect, it } from 'vitest';
import {
  scopeToSearchFilters,
  mergeScopedFilters,
  enforceScope,
  hasRepos,
  findRepo,
  scopeLabel,
  isScopeReady,
  extractParticipants,
  type ThreadScope,
  type ParticipantScope,
  type MailboxScope,
} from '../../../src/ai/context/scope';

const threadScope = (overrides: Partial<ThreadScope> = {}): ThreadScope => ({
  kind: 'thread',
  account: 'acct-1',
  threadId: 'thread-a',
  ...overrides,
});

const participantScope = (overrides: Partial<ParticipantScope> = {}): ParticipantScope => ({
  kind: 'participants',
  account: 'acct-1',
  participants: ['alice@acme.com', 'bob@acme.com'],
  ...overrides,
});

const mailboxScope = (overrides: Partial<MailboxScope> = {}): MailboxScope => ({
  kind: 'mailbox',
  account: 'acct-1',
  confirmed: true,
  ...overrides,
});

describe('scopeToSearchFilters', () => {
  it('thread scope pins thread_id', () => {
    expect(scopeToSearchFilters(threadScope({ threadId: 'thread-a' }))).toEqual({
      thread_id: 'thread-a',
    });
  });

  it('thread scope with null threadId returns empty (treat as all-messages for the draft/summarize seed)', () => {
    expect(scopeToSearchFilters(threadScope({ threadId: null }))).toEqual({});
  });

  it('participants scope emits the from allowlist', () => {
    expect(scopeToSearchFilters(participantScope())).toEqual({
      from: ['alice@acme.com', 'bob@acme.com'],
    });
  });

  it('empty participants returns empty filters', () => {
    expect(scopeToSearchFilters(participantScope({ participants: [] }))).toEqual({});
  });

  it('mailbox scope is unconstrained', () => {
    expect(scopeToSearchFilters(mailboxScope())).toEqual({});
  });
});

describe('mergeScopedFilters', () => {
  it('thread scope overrides any thread_id the model supplied', () => {
    const merged = mergeScopedFilters(threadScope({ threadId: 'thread-a' }), {
      thread_id: 'thread-evil',
      from: ['carol@evil.com'],
    });
    expect(merged.thread_id).toBe('thread-a');
    // from is untouched by thread scope — thread_id already restricts.
    expect(merged.from).toEqual(['carol@evil.com']);
  });

  it('participant scope intersects the model-supplied from list', () => {
    const merged = mergeScopedFilters(participantScope(), {
      from: ['alice@acme.com', 'carol@evil.com'],
    });
    expect(merged.from).toEqual(['alice@acme.com']);
  });

  it('participant scope fills in from when the model omitted it', () => {
    const merged = mergeScopedFilters(participantScope(), { text_query: 'refund' });
    expect(merged.from).toEqual(['alice@acme.com', 'bob@acme.com']);
    expect(merged.text_query).toBe('refund');
  });

  it('participant scope intersection is case-insensitive', () => {
    const merged = mergeScopedFilters(participantScope(), {
      from: ['ALICE@acme.com', 'Bob@Acme.com', 'carol@evil.com'],
    });
    expect(merged.from).toEqual(['ALICE@acme.com', 'Bob@Acme.com']);
  });

  it('participant scope with no overlap yields empty from (no results, not a bypass)', () => {
    const merged = mergeScopedFilters(participantScope(), {
      from: ['carol@evil.com', 'dan@evil.com'],
    });
    expect(merged.from).toEqual([]);
  });

  it('mailbox scope passes model filters through unchanged', () => {
    const merged = mergeScopedFilters(mailboxScope(), {
      from: ['anyone@anywhere.com'],
      is_unread: true,
    });
    expect(merged).toEqual({ from: ['anyone@anywhere.com'], is_unread: true });
  });

  it('defaults to empty modelFilters', () => {
    expect(mergeScopedFilters(mailboxScope())).toEqual({});
  });
});

describe('enforceScope', () => {
  const rows = [
    { thread_id: 'thread-a', from: 'alice@acme.com', to: 'bob@acme.com' },
    { thread_id: 'thread-b', from: 'carol@evil.com', to: 'alice@acme.com' },
    { thread_id: 'thread-c', from: 'dan@evil.com', to: 'dan@evil.com' },
    { thread_id: null, root_id: 'thread-a', from: 'alice@acme.com' },
  ];

  it('thread scope keeps rows matching thread_id OR root_id', () => {
    expect(enforceScope(threadScope({ threadId: 'thread-a' }), rows)).toEqual([rows[0], rows[3]]);
  });

  it('thread scope with null threadId returns all (caller has no thread to enforce)', () => {
    expect(enforceScope(threadScope({ threadId: null }), rows)).toEqual(rows);
  });

  it('thread scope also honors rootId when provided', () => {
    const scope = threadScope({ threadId: 'thread-x', rootId: 'thread-a' });
    const result = enforceScope(scope, rows);
    // rows[0].thread_id matches rootId; rows[3].root_id matches threadId (no, but rootId yes on thread_id)
    // Only row[3] — root_id matches threadId (no, 'thread-a' !== 'thread-x').
    // row[0] thread_id 'thread-a' === rootId 'thread-a' — kept.
    expect(result).toContain(rows[0]);
  });

  it('participant scope keeps rows whose from/to/cc intersects the allowlist', () => {
    const scope = participantScope({ participants: ['alice@acme.com'] });
    const result = enforceScope(scope, rows);
    // rows[0] from=alice ✓, rows[1] to=alice ✓, rows[2] none ✗, rows[3] from=alice ✓
    expect(result).toEqual([rows[0], rows[1], rows[3]]);
  });

  it('participant scope comparison is case-insensitive', () => {
    const scope = participantScope({ participants: ['alice@acme.com'] });
    const result = enforceScope(scope, [{ from: 'ALICE@ACME.COM' }]);
    expect(result).toHaveLength(1);
  });

  it('participant scope handles array to/cc fields', () => {
    const scope = participantScope({ participants: ['carol@acme.com'] });
    const result = enforceScope(scope, [
      { from: 'anyone@anywhere.com', to: ['bob@acme.com', 'carol@acme.com'] },
      { from: 'anyone@anywhere.com', cc: ['carol@acme.com'] },
    ]);
    expect(result).toHaveLength(2);
  });

  it('mailbox scope keeps everything', () => {
    expect(enforceScope(mailboxScope(), rows)).toEqual(rows);
  });
});

describe('hasRepos / findRepo', () => {
  it('hasRepos false when absent or empty', () => {
    expect(hasRepos(threadScope())).toBe(false);
    expect(hasRepos(threadScope({ repos: [] }))).toBe(false);
  });

  it('hasRepos true when attached', () => {
    expect(hasRepos(threadScope({ repos: [{ id: 'r1', label: 'webmail' }] }))).toBe(true);
  });

  it('findRepo returns matching repo or null', () => {
    const scope = threadScope({
      repos: [
        { id: 'r1', label: 'webmail' },
        { id: 'r2', label: 'api' },
      ],
    });
    expect(findRepo(scope, 'r2')).toEqual({ id: 'r2', label: 'api' });
    expect(findRepo(scope, 'missing')).toBeNull();
    expect(findRepo(threadScope(), 'r1')).toBeNull();
  });
});

describe('scopeLabel', () => {
  it('renders per-kind labels', () => {
    expect(scopeLabel(threadScope())).toBe('Thread only');
    expect(scopeLabel(participantScope())).toBe('Participants (2)');
    expect(scopeLabel(mailboxScope({ confirmed: true }))).toBe('Full mailbox');
    expect(scopeLabel(mailboxScope({ confirmed: false }))).toBe('Full mailbox (not confirmed)');
  });
});

describe('isScopeReady', () => {
  it('thread/participants are always ready', () => {
    expect(isScopeReady(threadScope())).toBe(true);
    expect(isScopeReady(participantScope())).toBe(true);
  });

  it('mailbox is ready only when confirmed', () => {
    expect(isScopeReady(mailboxScope({ confirmed: false }))).toBe(false);
    expect(isScopeReady(mailboxScope({ confirmed: true }))).toBe(true);
  });
});

describe('extractParticipants', () => {
  it('returns unique lowercased addresses', () => {
    expect(
      extractParticipants([
        { from: 'Alice@Acme.com', to: 'bob@acme.com' },
        { from: 'bob@acme.com', to: 'ALICE@acme.com' },
      ]),
    ).toEqual(['alice@acme.com', 'bob@acme.com']);
  });

  it('splits comma-separated headers', () => {
    expect(extractParticipants([{ from: 'a@x.com', to: 'b@x.com, c@x.com; d@x.com' }])).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });

  it('handles arrays on to/cc', () => {
    expect(
      extractParticipants([{ from: 'a@x.com', to: ['b@x.com'], cc: ['c@x.com', 'd@x.com'] }]),
    ).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  });

  it('ignores null/undefined/empty', () => {
    expect(extractParticipants([{ from: null, to: undefined, cc: '' }])).toEqual([]);
  });
});
