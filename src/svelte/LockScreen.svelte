<script>
  /**
   * LockScreen Component
   *
   * iOS-style lock screen overlay with PIN pad and optional passkey
   * authentication. Renders as a full-screen modal that blocks all
   * app interaction until the user successfully authenticates.
   */

  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import {
    isVaultConfigured,
    unlockWithPin,
    unlockWithPasskey,
    isUnlocked,
    getLockPrefs,
  } from '../utils/crypto-store.js';
  import {
    isWebAuthnAvailable,
    hasPasskeyCredential,
    authenticatePasskey,
  } from '../utils/passkey-auth.js';

  const dispatch = createEventDispatcher();

  /** Emit both a Svelte component event and a DOM CustomEvent so that
   *  imperative callers (main.ts) who listen on the overlay element
   *  can also react immediately. */
  function emitUnlock() {
    dispatch('unlock');
    // Bubble a real DOM event from this component's root element
    const root = document.getElementById('app-lock-overlay');
    if (root) root.dispatchEvent(new CustomEvent('unlock', { bubbles: true }));
  }

  // --- State ---
  let pin = '';
  let maxLength = 6;
  let error = '';
  let shake = false;
  let loading = false;
  let attempts = 0;
  let lockoutUntil = 0;
  let lockoutTimer = null;
  let lockoutRemaining = '';
  let showPasskeyOption = false;

  const MAX_ATTEMPTS = 10;
  const LOCKOUT_DURATIONS = [0, 0, 0, 30, 60, 120, 300, 600, 1800, 3600];

  onMount(async () => {
    const prefs = getLockPrefs();
    maxLength = prefs.pinLength || 6;

    // Check if passkey is available
    if (prefs.hasPasskey && hasPasskeyCredential() && isWebAuthnAvailable()) {
      showPasskeyOption = true;
      // Auto-trigger passkey prompt on mount
      setTimeout(() => handlePasskeyAuth(), 300);
    }

    // Restore lockout state from sessionStorage
    try {
      const lockoutData = sessionStorage.getItem('webmail_lockout');
      if (lockoutData) {
        const parsed = JSON.parse(lockoutData);
        attempts = parsed.attempts || 0;
        lockoutUntil = parsed.lockoutUntil || 0;
        if (lockoutUntil > Date.now()) {
          startLockoutTimer();
        }
      }
    } catch {
      // ignore
    }
  });

  onDestroy(() => {
    if (lockoutTimer) clearInterval(lockoutTimer);
  });

  function getLockoutDuration(attemptCount) {
    const idx = Math.min(attemptCount, LOCKOUT_DURATIONS.length - 1);
    return (LOCKOUT_DURATIONS[idx] || 0) * 1000;
  }

  function startLockoutTimer() {
    if (lockoutTimer) clearInterval(lockoutTimer);
    updateLockoutDisplay();
    lockoutTimer = setInterval(() => {
      if (Date.now() >= lockoutUntil) {
        clearInterval(lockoutTimer);
        lockoutTimer = null;
        lockoutRemaining = '';
        error = '';
      } else {
        updateLockoutDisplay();
      }
    }, 1000);
  }

  function updateLockoutDisplay() {
    const remaining = Math.ceil((lockoutUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      lockoutRemaining = '';
      return;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    lockoutRemaining = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
    error = `Too many attempts. Try again in ${lockoutRemaining}`;
  }

  function saveLockoutState() {
    try {
      sessionStorage.setItem(
        'webmail_lockout',
        JSON.stringify({
          attempts,
          lockoutUntil,
        }),
      );
    } catch {
      // ignore
    }
  }

  function handleDigit(digit) {
    if (loading || lockoutUntil > Date.now()) return;
    if (pin.length >= maxLength) return;

    error = '';
    pin += digit;

    if (pin.length === maxLength) {
      handlePinSubmit();
    }
  }

  function handleBackspace() {
    if (loading || lockoutUntil > Date.now()) return;
    pin = pin.slice(0, -1);
    error = '';
  }

  async function handlePinSubmit() {
    if (loading) return;
    if (pin.length < maxLength) {
      error = 'Enter your full PIN';
      return;
    }

    // Check lockout
    if (lockoutUntil > Date.now()) {
      pin = '';
      return;
    }

    loading = true;
    error = '';

    try {
      const success = await unlockWithPin(pin);
      if (success) {
        attempts = 0;
        lockoutUntil = 0;
        saveLockoutState();
        emitUnlock();
      } else {
        attempts++;
        const duration = getLockoutDuration(attempts);
        if (duration > 0) {
          lockoutUntil = Date.now() + duration;
          startLockoutTimer();
        } else {
          error = `Incorrect PIN. ${MAX_ATTEMPTS - attempts} attempts remaining.`;
        }
        saveLockoutState();

        if (attempts >= MAX_ATTEMPTS) {
          error = 'Maximum attempts exceeded. Please restart the app.';
        }

        pin = '';
        shake = true;
        setTimeout(() => {
          shake = false;
        }, 500);
      }
    } catch (err) {
      console.error('[LockScreen] PIN unlock failed:', err);
      error = 'Unlock failed. Please try again.';
      pin = '';
    } finally {
      loading = false;
    }
  }

  async function handlePasskeyAuth() {
    if (loading) return;
    loading = true;
    error = '';

    try {
      const result = await authenticatePasskey();
      if (result.success && result.prfOutput) {
        const unlocked = await unlockWithPasskey(result.prfOutput);
        if (unlocked) {
          attempts = 0;
          lockoutUntil = 0;
          saveLockoutState();
          emitUnlock();
          return;
        }
      }
      error = 'Passkey authentication failed. Try your PIN.';
      attempts++;
      const duration = getLockoutDuration(attempts);
      if (duration > 0) {
        lockoutUntil = Date.now() + duration;
        startLockoutTimer();
      }
      saveLockoutState();
      if (attempts >= MAX_ATTEMPTS) {
        error = 'Maximum attempts exceeded. Please restart the app.';
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        error = 'Authentication cancelled.';
      } else {
        console.error('[LockScreen] Passkey auth failed:', err);
        error = 'Passkey failed. Try your PIN instead.';
        attempts++;
        const duration = getLockoutDuration(attempts);
        if (duration > 0) {
          lockoutUntil = Date.now() + duration;
          startLockoutTimer();
        }
        saveLockoutState();
        if (attempts >= MAX_ATTEMPTS) {
          error = 'Maximum attempts exceeded. Please restart the app.';
        }
      }
    } finally {
      loading = false;
    }
  }

  function handleKeydown(event) {
    if (event.key >= '0' && event.key <= '9') {
      handleDigit(event.key);
    } else if (event.key === 'Backspace') {
      handleBackspace();
    } else if (event.key === 'Enter' && pin.length === maxLength) {
      handlePinSubmit();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="lock-screen" role="dialog" aria-modal="true" aria-label="App Lock Screen">
  <div class="lock-container">
    <!-- Lock icon -->
    <div class="lock-icon" aria-hidden="true">
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>

    <h1 class="lock-title">Forward Email</h1>
    <p class="lock-subtitle">Enter your PIN to unlock</p>

    <!-- PIN dots -->
    <div
      class="pin-dots"
      class:shake
      aria-label="PIN entry, {pin.length} of {maxLength} digits entered"
    >
      {#each Array(maxLength) as _, i}
        <div
          class="pin-dot"
          class:filled={i < pin.length}
          class:active={i === pin.length}
          aria-hidden="true"
        ></div>
      {/each}
    </div>

    <!-- Error message -->
    {#if error}
      <p class="error-message" role="alert">{error}</p>
    {/if}

    <!-- Loading indicator -->
    {#if loading}
      <div class="loading-indicator" aria-label="Authenticating">
        <div class="spinner"></div>
      </div>
    {/if}

    <!-- Number pad -->
    <div class="numpad" role="group" aria-label="PIN keypad">
      {#each [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['passkey', '0', 'backspace']] as row}
        <div class="numpad-row">
          {#each row as key}
            {#if key === 'passkey'}
              {#if showPasskeyOption}
                <button
                  class="numpad-key special"
                  on:click={handlePasskeyAuth}
                  disabled={loading || lockoutUntil > Date.now()}
                  aria-label="Unlock with passkey"
                  title="Use passkey"
                >
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                    <polyline points="10 17 15 12 10 7"></polyline>
                    <line x1="15" y1="12" x2="3" y2="12"></line>
                  </svg>
                </button>
              {:else}
                <div class="numpad-key placeholder"></div>
              {/if}
            {:else if key === 'backspace'}
              <button
                class="numpad-key special"
                on:click={handleBackspace}
                disabled={loading || pin.length === 0}
                aria-label="Delete last digit"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path>
                  <line x1="18" y1="9" x2="12" y2="15"></line>
                  <line x1="12" y1="9" x2="18" y2="15"></line>
                </svg>
              </button>
            {:else}
              <button
                class="numpad-key digit"
                on:click={() => handleDigit(key)}
                disabled={loading || lockoutUntil > Date.now()}
                aria-label={key}
              >
                {key}
              </button>
            {/if}
          {/each}
        </div>
      {/each}
    </div>

    {#if showPasskeyOption}
      <p class="passkey-hint">Or use your passkey to unlock</p>
    {/if}
  </div>
</div>

<style>
  .lock-screen {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--lock-bg, #0a0a0a);
    color: var(--lock-fg, #ffffff);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }

  .lock-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 320px;
    width: 100%;
    padding: 2rem 1rem;
  }

  .lock-icon {
    margin-bottom: 1.5rem;
    opacity: 0.7;
  }

  .lock-title {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0 0 0.25rem;
    letter-spacing: -0.01em;
  }

  .lock-subtitle {
    font-size: 0.875rem;
    opacity: 0.6;
    margin: 0 0 2rem;
  }

  .pin-dots {
    display: flex;
    gap: 14px;
    margin-bottom: 1.5rem;
    min-height: 20px;
  }

  .pin-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.3);
    transition: all 0.15s ease;
  }

  .pin-dot.filled {
    background: #ffffff;
    border-color: #ffffff;
    transform: scale(1.1);
  }

  .pin-dot.active {
    border-color: rgba(255, 255, 255, 0.6);
  }

  .shake {
    animation: shake 0.4s ease-in-out;
  }

  @keyframes shake {
    0%,
    100% {
      transform: translateX(0);
    }
    20% {
      transform: translateX(-10px);
    }
    40% {
      transform: translateX(10px);
    }
    60% {
      transform: translateX(-6px);
    }
    80% {
      transform: translateX(6px);
    }
  }

  .error-message {
    color: #ff6b6b;
    font-size: 0.8125rem;
    margin: 0 0 1rem;
    text-align: center;
    min-height: 1.2em;
  }

  .loading-indicator {
    margin-bottom: 1rem;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: #ffffff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .numpad {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .numpad-row {
    display: flex;
    gap: 20px;
    justify-content: center;
  }

  .numpad-key {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.1s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .numpad-key.digit {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
    font-size: 1.75rem;
    font-weight: 300;
  }

  .numpad-key.digit:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
  }

  .numpad-key.digit:active:not(:disabled) {
    background: rgba(255, 255, 255, 0.25);
    transform: scale(0.95);
  }

  .numpad-key.special {
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
  }

  .numpad-key.special:hover:not(:disabled) {
    color: #ffffff;
  }

  .numpad-key.placeholder {
    visibility: hidden;
    cursor: default;
  }

  .numpad-key:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .passkey-hint {
    font-size: 0.75rem;
    opacity: 0.4;
    margin-top: 1.5rem;
  }

  /* Light mode: when the app's .dark class is NOT on <html> */
  :global(html:not(.dark)) .lock-screen {
    --lock-bg: #f5f5f7;
    --lock-fg: #1d1d1f;
  }

  :global(html:not(.dark)) .pin-dot {
    border-color: rgba(0, 0, 0, 0.2);
  }

  :global(html:not(.dark)) .pin-dot.filled {
    background: #1d1d1f;
    border-color: #1d1d1f;
  }

  :global(html:not(.dark)) .pin-dot.active {
    border-color: rgba(0, 0, 0, 0.4);
  }

  :global(html:not(.dark)) .numpad-key.digit {
    background: rgba(0, 0, 0, 0.05);
    color: #1d1d1f;
  }

  :global(html:not(.dark)) .numpad-key.digit:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.1);
  }

  :global(html:not(.dark)) .numpad-key.digit:active:not(:disabled) {
    background: rgba(0, 0, 0, 0.15);
  }

  :global(html:not(.dark)) .numpad-key.special {
    color: rgba(0, 0, 0, 0.5);
  }

  :global(html:not(.dark)) .numpad-key.special:hover:not(:disabled) {
    color: #1d1d1f;
  }

  :global(html:not(.dark)) .spinner {
    border-color: rgba(0, 0, 0, 0.1);
    border-top-color: #1d1d1f;
  }

  /* Responsive adjustments for smaller screens */
  @media (max-height: 600px) {
    .lock-container {
      padding: 1rem;
    }

    .lock-icon {
      margin-bottom: 0.75rem;
    }

    .lock-subtitle {
      margin-bottom: 1rem;
    }

    .numpad-key {
      width: 60px;
      height: 60px;
    }

    .numpad-key.digit {
      font-size: 1.5rem;
    }

    .numpad-row {
      gap: 16px;
    }

    .numpad {
      gap: 8px;
    }
  }

  /* Safe area insets for mobile */
  @supports (padding: env(safe-area-inset-top)) {
    .lock-screen {
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
</style>
