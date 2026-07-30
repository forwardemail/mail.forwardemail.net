/**
 * Forward Email – account scoping seam
 *
 * Every mailbox record in IndexedDB and every row in the visible message list
 * belongs to exactly one signed-in account. Nothing in the type system enforces
 * that: the partition key is a plain `account` string, and the "is this event
 * for the account on screen?" test was written by hand at roughly thirty call
 * sites across the stores, the WebSocket updater, the notification manager and
 * the sync controller. Each of those was correct when written, and each new
 * async path was one forgotten comparison away from filing one account's mail
 * under another's — which is how the same class of bug kept coming back.
 *
 * This module is the single place that answers three questions:
 *
 *   1. Which account is on screen right now?          activeAccount()
 *   2. Does this event/record belong to it?           isActiveAccount()
 *   3. Is this batch of records really all one         assertAccountScoped()
 *      account's, and the one the caller claimed?
 *
 * The comparison helpers are pure and have no storage dependency, so workers
 * and the service worker can import them. `activeAccount()` reads the same
 * tab-scoped key the rest of the app uses; it is only meaningful on the main
 * thread, where the notion of an "active" account exists at all.
 */

import { Local } from './storage.js';

/**
 * The account key used when no account is signed in. Historically every call
 * site spelled this `Local.get('email') || 'default'`; it is centralised here so
 * a record written under the fallback is at least written under the SAME
 * fallback everywhere.
 */
export const FALLBACK_ACCOUNT = 'default';

/**
 * Canonical form for comparing two account identifiers.
 *
 * Email addresses are case-insensitive in the domain part and, in practice,
 * case-insensitive at Forward Email in the local part too. The account list,
 * the WebSocket `_account` tag and `Local.get('email')` do not agree on case:
 * a user who types `Alice@Example.com` at the login form has that exact string
 * stored, while the server echoes back a lowercased address. Comparing raw
 * strings makes those look like two different accounts, which reads as "the
 * event is for somebody else" and silently drops it.
 */
export function normalizeAccount(account?: string | null): string {
  if (typeof account !== 'string') return '';
  return account.trim().toLowerCase();
}

/**
 * True when two account identifiers name the same account. An empty identifier
 * matches nothing — callers that want "empty means active" must say so
 * explicitly (see isActiveAccount), because silently treating unknown as active
 * is exactly the behaviour that let untagged push payloads write into whichever
 * mailbox happened to be on screen.
 */
export function sameAccount(a?: string | null, b?: string | null): boolean {
  const left = normalizeAccount(a);
  const right = normalizeAccount(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * The account currently on screen, in its stored (non-normalized) form. Use
 * this for stamping records; use isActiveAccount() for comparisons.
 */
export function activeAccount(): string {
  return (Local.get('email') as string) || FALLBACK_ACCOUNT;
}

/**
 * True when `account` is the account on screen.
 *
 * `treatUnknownAsActive` exists for one legitimate case: a transport that
 * genuinely cannot tell us which account an event came from, on an install with
 * a single signed-in account. Pass it only where an untagged event is provably
 * harmless. It defaults to false so the safe answer is the one you get by not
 * thinking about it.
 */
export function isActiveAccount(
  account?: string | null,
  { treatUnknownAsActive = false }: { treatUnknownAsActive?: boolean } = {},
): boolean {
  const candidate = normalizeAccount(account);
  if (!candidate) return treatUnknownAsActive;
  return candidate === normalizeAccount(activeAccount());
}

// ── Write-time guard ───────────────────────────────────────────────────────

/**
 * Thrown by assertAccountScoped in development. A distinct class so tests can
 * assert on it without matching message text.
 */
export class AccountScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountScopeError';
  }
}

const isProduction = (): boolean => {
  try {
    return Boolean(import.meta?.env?.PROD);
  } catch {
    return false;
  }
};

/**
 * Assert that every record in a batch about to be persisted carries the account
 * the caller says it is writing under.
 *
 * This is the structural half of the fix. The gates elsewhere stop a mismatched
 * batch from being *built*; this stops a mismatched batch from being *stored*,
 * which is the only failure that outlives a reload. Contaminated rows are not
 * self-healing — once one account's mail is filed under another's partition it
 * stays there until the cache is cleared — so the cost of catching it late is
 * far higher than the cost of one comparison per record.
 *
 * In development it throws. In production it logs and returns false, because
 * refusing to cache mail is a worse outcome for a user than caching it under a
 * wrong-but-consistent key, and the caller is not written to handle a throw.
 *
 * @param context  Call site label, e.g. 'mailboxStore.loadMessages'
 * @param account  The account the caller intends to write under
 * @param records  Records that must each carry that account (records with no
 *                 `account` field are ignored — the caller stamps those itself)
 * @returns true when the batch is consistent
 */
export function assertAccountScoped(
  context: string,
  account: string | null | undefined,
  records: ReadonlyArray<{ account?: string | null } | null | undefined>,
): boolean {
  const expected = normalizeAccount(account);
  if (!expected) {
    report(`${context}: refused to write records under an empty account`);
    return false;
  }
  if (!Array.isArray(records)) return true;

  for (const record of records) {
    const found = record?.account;
    // A record with no account is stamped by the caller on the way in; only a
    // record that already claims an account can claim the WRONG one.
    if (found === undefined || found === null || found === '') continue;
    if (normalizeAccount(found) !== expected) {
      report(
        `${context}: record ${String(
          (record as { id?: unknown })?.id ?? '(no id)',
        )} claims account "${String(found)}" but is being written under "${String(account)}"`,
      );
      return false;
    }
  }
  return true;
}

function report(message: string): void {
  if (isProduction()) {
    console.error(`[account-scope] ${message}`);
    return;
  }
  throw new AccountScopeError(message);
}
