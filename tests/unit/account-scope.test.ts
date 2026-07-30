/**
 * Account scoping seam.
 *
 * Every mailbox record belongs to exactly one signed-in account, and the only
 * thing that has ever enforced that is a hand-written comparison repeated at
 * dozens of call sites. These tests pin the behaviour those call sites now
 * share, including the two decisions that are easy to get subtly wrong:
 * what an unknown account means, and what happens to a batch of records whose
 * account disagrees with the partition it is headed for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const localValues = new Map<string, string>();

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: vi.fn((key: string) => localValues.get(key) ?? null),
    set: vi.fn((key: string, value: string) => localValues.set(key, value)),
    remove: vi.fn((key: string) => localValues.delete(key)),
  },
}));

const {
  AccountScopeError,
  FALLBACK_ACCOUNT,
  activeAccount,
  assertAccountScoped,
  isActiveAccount,
  normalizeAccount,
  sameAccount,
} = await import('../../src/utils/account-scope.ts');

beforeEach(() => {
  localValues.clear();
  localValues.set('email', 'alice@example.com');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('normalizeAccount', () => {
  it('folds case and surrounding whitespace', () => {
    expect(normalizeAccount('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('maps every non-string to the empty identifier', () => {
    expect(normalizeAccount(null)).toBe('');
    expect(normalizeAccount(undefined)).toBe('');
    expect(normalizeAccount(42 as unknown as string)).toBe('');
  });
});

describe('sameAccount', () => {
  it('matches addresses that differ only in case, as the API and the login form do', () => {
    // The login form stores exactly what the user typed while the server
    // echoes a lowercased address, so a raw string compare reports two
    // different accounts and drops the event as "somebody else's".
    expect(sameAccount('Alice@Example.com', 'alice@example.com')).toBe(true);
  });

  it('never matches on an empty identifier', () => {
    expect(sameAccount('', 'alice@example.com')).toBe(false);
    expect(sameAccount('alice@example.com', null)).toBe(false);
    expect(sameAccount('', '')).toBe(false);
  });
});

describe('activeAccount', () => {
  it('returns the stored email', () => {
    expect(activeAccount()).toBe('alice@example.com');
  });

  it('falls back to a single shared sentinel when signed out', () => {
    // Call sites used to spell this fallback themselves. Sharing one value is
    // the point: records written under the fallback must all land in the same
    // partition, not in several near-identical ones.
    localValues.delete('email');
    expect(activeAccount()).toBe(FALLBACK_ACCOUNT);
  });
});

describe('isActiveAccount', () => {
  it('recognises the account on screen regardless of case', () => {
    expect(isActiveAccount('ALICE@example.com')).toBe(true);
  });

  it('rejects another signed-in account', () => {
    expect(isActiveAccount('bob@example.com')).toBe(false);
  });

  it('defaults an unknown account to NOT active', () => {
    // The safe answer has to be the one you get without thinking about it.
    // Defaulting unknown to active is what let untagged push payloads write
    // into whichever mailbox happened to be open.
    expect(isActiveAccount('')).toBe(false);
    expect(isActiveAccount(undefined)).toBe(false);
  });

  it('treats an unknown account as active only when the caller opts in', () => {
    expect(isActiveAccount('', { treatUnknownAsActive: true })).toBe(true);
    // Opting in must not weaken a KNOWN mismatch.
    expect(isActiveAccount('bob@example.com', { treatUnknownAsActive: true })).toBe(false);
  });
});

describe('assertAccountScoped', () => {
  it('passes a batch that agrees with the target partition', () => {
    expect(
      assertAccountScoped('test', 'alice@example.com', [
        { account: 'alice@example.com', id: '1' },
        { account: 'Alice@Example.com', id: '2' },
      ]),
    ).toBe(true);
  });

  it('ignores records with no account, which the caller stamps on the way in', () => {
    expect(
      assertAccountScoped('test', 'alice@example.com', [{ id: '1' }, { account: '', id: '2' }]),
    ).toBe(true);
  });

  it('throws when a record claims a different account than the batch', () => {
    // This is the failure that outlives a reload: contaminated rows are not
    // self-healing and stay until the cache is cleared.
    expect(() =>
      assertAccountScoped('test', 'alice@example.com', [
        { account: 'alice@example.com', id: '1' },
        { account: 'bob@example.com', id: '2' },
      ]),
    ).toThrow(AccountScopeError);
  });

  it('names the offending record so the call site is findable', () => {
    expect(() =>
      assertAccountScoped('mailboxStore.loadMessages', 'alice@example.com', [
        { account: 'bob@example.com', id: 'msg-99' },
      ]),
    ).toThrow(/mailboxStore\.loadMessages.*msg-99.*bob@example\.com/s);
  });

  it('refuses to write anything under an empty account', () => {
    expect(() => assertAccountScoped('test', '', [{ account: 'alice@example.com' }])).toThrow(
      AccountScopeError,
    );
  });
});
