/**
 * Auth-failure recovery policy.
 *
 * Recovery deletes the stored credentials, so the cost of a false positive is
 * a permanent sign-out. These cover the two false positives that caused one:
 * a locked vault (every request 401s because the credentials are encrypted at
 * rest) and a single WebSocket 4401 (which also fires when a reconnect races a
 * token that is mid-restore).
 */

import { describe, it, expect } from 'vitest';
import {
  canRouteAsSignedIn,
  createAuthRecoveryPolicy,
  readSessionStatus,
  WS_AUTH_FAILURE_WINDOW_MS,
} from '../../src/utils/auth-recovery';

/** Defaults describe an unlocked vault with app lock switched on. */
function makePolicy(overrides = {}) {
  const state = {
    lockEnabled: true,
    vaultConfigured: true,
    unlocked: true,
    clock: 1_000_000,
    ...overrides,
  };
  const policy = createAuthRecoveryPolicy({
    isLockEnabled: () => state.lockEnabled,
    isVaultConfigured: () => state.vaultConfigured,
    isUnlocked: () => state.unlocked,
    now: () => state.clock,
  });
  return { policy, state };
}

describe('locked vault', () => {
  it('ignores an HTTP 401 while locked', () => {
    // The screen came back on, sessionStorage was evicted, and the resume
    // burst fired before the user entered their code. These 401s say nothing
    // about the session.
    const { policy } = makePolicy({ unlocked: false });
    expect(policy.evaluate('http-401')).toBe('locked');
  });

  it('ignores a socket failure while locked', () => {
    const { policy } = makePolicy({ unlocked: false });
    expect(policy.evaluate('websocket')).toBe('locked');
  });

  it('does not let failures during the lock corroborate a later real one', () => {
    // Otherwise the first post-unlock socket close would find a primed
    // counter and immediately delete the credentials.
    const { policy, state } = makePolicy({ unlocked: false });
    policy.evaluate('websocket');
    policy.evaluate('websocket');

    state.unlocked = true;
    expect(policy.evaluate('websocket')).toBe('awaiting-corroboration');
  });

  it('recovers once unlocked, since a 401 then is real', () => {
    const { policy, state } = makePolicy({ unlocked: false });
    expect(policy.evaluate('http-401')).toBe('locked');

    state.unlocked = true;
    expect(policy.evaluate('http-401')).toBe('recover');
  });

  it('does not gate when app lock is off', () => {
    const { policy } = makePolicy({ lockEnabled: false, unlocked: false });
    expect(policy.evaluate('http-401')).toBe('recover');
  });

  it('does not gate when the vault was never configured', () => {
    // isUnlocked() is false before setup; without the configured check the
    // app could never force re-auth at all.
    const { policy } = makePolicy({ vaultConfigured: false, unlocked: false });
    expect(policy.evaluate('http-401')).toBe('recover');
  });
});

describe('websocket corroboration', () => {
  it('does not act on a single close', () => {
    const { policy } = makePolicy();
    expect(policy.evaluate('websocket')).toBe('awaiting-corroboration');
  });

  it('acts on a second close inside the window', () => {
    const { policy, state } = makePolicy();
    expect(policy.evaluate('websocket')).toBe('awaiting-corroboration');
    state.clock += WS_AUTH_FAILURE_WINDOW_MS - 1;
    expect(policy.evaluate('websocket')).toBe('recover');
  });

  it('treats a late second close as a fresh first one', () => {
    const { policy, state } = makePolicy();
    policy.evaluate('websocket');
    state.clock += WS_AUTH_FAILURE_WINDOW_MS + 1;
    expect(policy.evaluate('websocket')).toBe('awaiting-corroboration');
  });

  it('resets after recovering, so the next close starts over', () => {
    const { policy, state } = makePolicy();
    policy.evaluate('websocket');
    state.clock += 1000;
    expect(policy.evaluate('websocket')).toBe('recover');

    state.clock += 1000;
    expect(policy.evaluate('websocket')).toBe('awaiting-corroboration');
  });

  it('leaves the HTTP path acting on the first report', () => {
    // remote.js already waits for three consecutive 401s before dispatching,
    // so corroborating again here would need six.
    const { policy } = makePolicy();
    expect(policy.evaluate('http-401')).toBe('recover');
  });
});

describe('canAuthenticate', () => {
  it('is false only while a configured vault is locked', () => {
    expect(makePolicy({ unlocked: false }).policy.canAuthenticate()).toBe(false);
    expect(makePolicy().policy.canAuthenticate()).toBe(true);
    expect(makePolicy({ lockEnabled: false, unlocked: false }).policy.canAuthenticate()).toBe(true);
    expect(makePolicy({ vaultConfigured: false, unlocked: false }).policy.canAuthenticate()).toBe(
      true,
    );
  });

  it('tracks the vault unlocking without needing a new policy', () => {
    const { policy, state } = makePolicy({ unlocked: false });
    expect(policy.canAuthenticate()).toBe(false);
    state.unlocked = true;
    expect(policy.canAuthenticate()).toBe(true);
  });
});

// The route guard's half of the same problem. Recovery decides whether to
// destroy credentials; routing decides whether to show the login page. Both
// used to read "no credential" straight off a locked vault, and both were wrong
// for the same reason.
describe('readSessionStatus', () => {
  const deps = (hasCreds: boolean, locked: boolean) => ({
    hasReadableCredentials: () => hasCreds,
    isVaultLocked: () => locked,
  });

  it('reads credentials it can see as signed in', () => {
    expect(readSessionStatus(deps(true, false))).toBe('signed-in');
    expect(canRouteAsSignedIn(deps(true, false))).toBe(true);
  });

  it('reads an empty unlocked session as signed out', () => {
    expect(readSessionStatus(deps(false, false))).toBe('signed-out');
    expect(canRouteAsSignedIn(deps(false, false))).toBe(false);
  });

  // The case that sent people to the login page after their phone slept: the
  // credentials exist, they are simply sealed. Routing has to wait, not decide.
  it('refuses to call a locked vault signed out', () => {
    expect(readSessionStatus(deps(false, true))).toBe('unknown-while-locked');
    expect(canRouteAsSignedIn(deps(false, true))).toBe(true);
  });
});
