/**
 * Auth-failure recovery policy.
 *
 * Forcing re-authentication is destructive: it deletes the stored credentials
 * (Local.remove writes through to localStorage, and Local.get re-copies from
 * there, so nothing short of deleting both copies actually redirects to
 * login). Anything that can reach it therefore has to be sure the session is
 * really gone, not merely unreachable for a moment.
 *
 * Two ways it used to be wrong, both of which signed users out for good:
 *
 *   - While the vault is locked, credentials are encrypted at rest and
 *     Local.get() returns null, so every request goes out unauthenticated. On
 *     mobile that is the normal state right after the screen comes back on:
 *     the WebView was reclaimed, sessionStorage (which holds the plaintext
 *     copies) was evicted, and the resume burst fires before the user has
 *     entered their code. The resulting 401s said nothing about the session,
 *     but recovery deleted the credentials anyway — so the correct code,
 *     entered a second later, had nothing left to restore.
 *
 *   - A WebSocket closing 4401/4403 is weaker evidence than an HTTP 401: it
 *     also happens when a reconnect races a token that is mid-restore. The
 *     HTTP path already waits for three consecutive failures before it
 *     believes them (AUTH_FAILURE_THRESHOLD in remote.js); the socket path
 *     acted on the first close.
 */

export type AuthFailureSource = 'http-401' | 'websocket';

/** Recover, or the reason we declined to. */
export type AuthRecoveryVerdict = 'recover' | 'locked' | 'awaiting-corroboration';

/** A second socket failure this long after the first is treated as unrelated. */
export const WS_AUTH_FAILURE_WINDOW_MS = 60_000;

export interface AuthRecoveryDeps {
  isLockEnabled: () => boolean;
  isVaultConfigured: () => boolean;
  isUnlocked: () => boolean;
  /** Injected so the corroboration window is testable without fake timers. */
  now?: () => number;
}

export interface AuthRecoveryPolicy {
  /** Whether an auth failure from `source` justifies destroying credentials. */
  evaluate: (source: AuthFailureSource) => AuthRecoveryVerdict;
  /**
   * Whether a request stands any chance of authenticating right now. False
   * while the vault is locked, which is when background work should hold off
   * rather than fire a burst of requests that can only 401.
   */
  canAuthenticate: () => boolean;
}

export function createAuthRecoveryPolicy(deps: AuthRecoveryDeps): AuthRecoveryPolicy {
  const now = deps.now ?? (() => Date.now());
  let firstWsFailureAt = 0;

  const canAuthenticate = () =>
    !(deps.isLockEnabled() && deps.isVaultConfigured() && !deps.isUnlocked());

  return {
    canAuthenticate,

    evaluate(source) {
      // Checked before the socket bookkeeping below: a failure that the lock
      // fully explains must not count toward corroborating a real one.
      if (!canAuthenticate()) return 'locked';

      if (source === 'websocket') {
        const at = now();
        if (at - firstWsFailureAt > WS_AUTH_FAILURE_WINDOW_MS) {
          firstWsFailureAt = at;
          return 'awaiting-corroboration';
        }
        firstWsFailureAt = 0;
      }

      return 'recover';
    },
  };
}
