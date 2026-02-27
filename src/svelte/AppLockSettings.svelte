<script>
  /**
   * App Lock Settings Component
   *
   * Provides UI for configuring the app lock feature:
   *   - Enable/disable app lock
   *   - Set/change PIN
   *   - Register/remove passkey
   *   - Configure inactivity timeout
   *   - Lock on minimize option
   *
   * Placed in Settings > Privacy & Security, above the PGP section.
   */

  import { onMount } from 'svelte';
  import {
    isVaultConfigured,
    isLockEnabled,
    getLockPrefs,
    setLockPrefs,
    setupWithPin,
    setupWithPasskey,
    changePin,
    disableLock,
    removePasskeyEnvelope,
    isUnlocked,
    unlockWithPin,
  } from '../utils/crypto-store.js';
  import {
    isWebAuthnAvailable,
    isPrfSupported,
    hasPasskeyCredential,
    registerPasskey,
    removePasskeyCredential,
  } from '../utils/passkey-auth.js';
  import { startAppLockTimer } from '../main';
  import {
    stop as stopInactivityTimer,
    onPrefsChanged as notifyTimerPrefsChanged,
  } from '../utils/inactivity-timer.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Card from '$lib/components/ui/card';
  import * as Select from '$lib/components/ui/select';
  import Lock from '@lucide/svelte/icons/lock';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import CheckCircle from '@lucide/svelte/icons/check-circle';

  // --- State ---
  let enabled = false;
  let prefs = getLockPrefs();
  let showSetupPin = false;
  let showChangePin = false;
  let showDisableConfirm = false;
  let pinInput = '';
  let pinConfirm = '';
  let currentPinInput = '';
  let newPinInput = '';
  let newPinConfirm = '';
  let error = '';
  let success = '';
  let loading = false;
  let webauthnAvailable = false;
  let prfSupported = false;
  let passkeyRegistered = false;

  // Timeout options (in milliseconds)
  const TIMEOUT_OPTIONS = [
    { label: '30 seconds', value: 30 * 1000 },
    { label: '1 minute', value: 60 * 1000 },
    { label: '2 minutes', value: 2 * 60 * 1000 },
    { label: '5 minutes', value: 5 * 60 * 1000 },
    { label: '10 minutes', value: 10 * 60 * 1000 },
    { label: '15 minutes', value: 15 * 60 * 1000 },
    { label: '30 minutes', value: 30 * 60 * 1000 },
    { label: '1 hour', value: 60 * 60 * 1000 },
    { label: 'Never', value: 0 },
  ];

  const PIN_LENGTH_OPTIONS = [4, 6, 8];

  onMount(async () => {
    enabled = isLockEnabled() && isVaultConfigured();
    prefs = getLockPrefs();
    webauthnAvailable = isWebAuthnAvailable();
    prfSupported = await isPrfSupported();
    passkeyRegistered = hasPasskeyCredential();
  });

  function clearMessages() {
    error = '';
    success = '';
  }

  function clearInputs() {
    pinInput = '';
    pinConfirm = '';
    currentPinInput = '';
    newPinInput = '';
    newPinConfirm = '';
  }

  function validatePin(pin) {
    const len = prefs.pinLength || 6;
    if (!pin || pin.length !== len) {
      return `PIN must be exactly ${len} digits`;
    }
    if (!/^\d+$/.test(pin)) {
      return 'PIN must contain only digits';
    }
    if (/^(.)\1+$/.test(pin)) {
      return 'PIN cannot be all the same digit';
    }
    let sequential = true;
    let reverseSequential = true;
    for (let i = 1; i < pin.length; i++) {
      if (Number(pin[i]) !== Number(pin[i - 1]) + 1) sequential = false;
      if (Number(pin[i]) !== Number(pin[i - 1]) - 1) reverseSequential = false;
    }
    if (sequential || reverseSequential) {
      return 'PIN cannot be a sequential number';
    }
    return null;
  }

  async function handleEnableLock() {
    showSetupPin = true;
    clearMessages();
    clearInputs();
  }

  async function handleSetupPin() {
    clearMessages();
    const validationError = validatePin(pinInput);
    if (validationError) {
      error = validationError;
      return;
    }
    if (pinInput !== pinConfirm) {
      error = 'PINs do not match';
      return;
    }

    loading = true;
    try {
      await setupWithPin(pinInput);
      prefs = { ...prefs, enabled: true };
      setLockPrefs(prefs);
      enabled = true;
      showSetupPin = false;
      clearInputs();
      success = 'App lock enabled successfully';
      // Start the inactivity timer now that lock is enabled
      startAppLockTimer();
    } catch (err) {
      console.error('[AppLockSettings] Setup failed:', err);
      error = 'Failed to set up app lock. Please try again.';
    } finally {
      loading = false;
    }
  }

  async function handleDisableLock() {
    clearMessages();
    loading = true;
    try {
      await disableLock();
      stopInactivityTimer();
      if (passkeyRegistered) {
        removePasskeyCredential();
        passkeyRegistered = false;
      }
      enabled = false;
      prefs = getLockPrefs();
      showDisableConfirm = false;
      success = 'App lock disabled. Data has been decrypted.';
    } catch (err) {
      console.error('[AppLockSettings] Disable failed:', err);
      error = 'Failed to disable app lock.';
    } finally {
      loading = false;
    }
  }

  async function handleChangePin() {
    clearMessages();
    const validationError = validatePin(newPinInput);
    if (validationError) {
      error = validationError;
      return;
    }
    if (newPinInput !== newPinConfirm) {
      error = 'New PINs do not match';
      return;
    }
    if (!currentPinInput) {
      error = 'Enter your current PIN';
      return;
    }

    loading = true;
    try {
      const changed = await changePin(currentPinInput, newPinInput);
      if (changed) {
        showChangePin = false;
        clearInputs();
        success = 'PIN changed successfully';
      } else {
        error = 'Current PIN is incorrect';
      }
    } catch (err) {
      console.error('[AppLockSettings] Change PIN failed:', err);
      error = 'Failed to change PIN.';
    } finally {
      loading = false;
    }
  }

  async function handleRegisterPasskey() {
    clearMessages();
    loading = true;
    try {
      const result = await registerPasskey('Forward Email User');
      if (result.prfOutput) {
        await setupWithPasskey(result.prfOutput);
        prefs = { ...prefs, hasPasskey: true };
        setLockPrefs(prefs);
        passkeyRegistered = true;
        success = 'Passkey registered successfully';
      } else {
        error =
          'Your device does not support PRF extension. Passkey cannot be used for encryption.';
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        error = 'Passkey registration was cancelled.';
      } else {
        console.error('[AppLockSettings] Passkey registration failed:', err);
        error = 'Failed to register passkey.';
      }
    } finally {
      loading = false;
    }
  }

  function handleRemovePasskey() {
    clearMessages();
    removePasskeyCredential();
    removePasskeyEnvelope();
    prefs = { ...prefs, hasPasskey: false };
    setLockPrefs(prefs);
    passkeyRegistered = false;
    success = 'Passkey removed';
  }

  function handleTimeoutChange(event) {
    const value = Number(event.target.value);
    prefs = { ...prefs, timeoutMs: value };
    setLockPrefs(prefs);
    notifyTimerPrefsChanged();
  }

  function handlePinLengthChange(event) {
    const value = Number(event.target.value);
    prefs = { ...prefs, pinLength: value };
    setLockPrefs(prefs);
  }

  function handleLockOnMinimizeChange(checked) {
    prefs = { ...prefs, lockOnMinimize: checked };
    setLockPrefs(prefs);
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="flex items-center gap-2">
      <Lock class="h-5 w-5" />
      App Lock
    </Card.Title>
    <Card.Description>
      Protect your email with a PIN or passkey. When enabled, all data stored on this device is
      encrypted and the app requires authentication to access.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-4">
    {#if success}
      <div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400" role="status">
        <CheckCircle class="h-4 w-4" />
        <span>{success}</span>
      </div>
    {/if}
    {#if error}
      <div class="flex items-center gap-2 text-sm text-destructive" role="alert">
        <AlertCircle class="h-4 w-4" />
        <span>{error}</span>
      </div>
    {/if}

    {#if !enabled}
      {#if !showSetupPin}
        <Button onclick={handleEnableLock} disabled={loading}>
          Enable App Lock
        </Button>
      {:else}
        <div class="space-y-3 rounded-md border border-border p-4">
          <div class="space-y-1">
            <Label for="pin-length">PIN Length</Label>
            <select
              id="pin-length"
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onchange={handlePinLengthChange}
              value={prefs.pinLength || 6}
            >
              {#each PIN_LENGTH_OPTIONS as len}
                <option value={len}>{len} digits</option>
              {/each}
            </select>
          </div>

          <div class="space-y-1">
            <Label for="new-pin">Enter PIN</Label>
            <Input
              id="new-pin"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={prefs.pinLength || 6}
              bind:value={pinInput}
              placeholder={'Enter ' + (prefs.pinLength || 6) + '-digit PIN'}
              autocomplete="off"
              disabled={loading}
            />
          </div>

          <div class="space-y-1">
            <Label for="confirm-pin">Confirm PIN</Label>
            <Input
              id="confirm-pin"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={prefs.pinLength || 6}
              bind:value={pinConfirm}
              placeholder="Confirm PIN"
              autocomplete="off"
              disabled={loading}
            />
          </div>

          <div class="flex gap-2">
            <Button onclick={handleSetupPin} disabled={loading}>
              {loading ? 'Setting up...' : 'Set PIN & Enable'}
            </Button>
            <Button
              variant="outline"
              onclick={() => {
                showSetupPin = false;
                clearInputs();
                clearMessages();
              }}
              disabled={loading}
            >
              Cancel
            </Button>
          </div>
        </div>
      {/if}
    {:else}
      <!-- Inactivity timeout -->
      <div class="space-y-1">
        <Label for="timeout">Auto-lock after inactivity</Label>
        <select
          id="timeout"
          class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onchange={handleTimeoutChange}
          value={prefs.timeoutMs}
        >
          {#each TIMEOUT_OPTIONS as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>

      <!-- Lock on minimize -->
      <div class="flex items-center gap-2">
        <Checkbox
          checked={prefs.lockOnMinimize || false}
          onCheckedChange={handleLockOnMinimizeChange}
          id="lock-on-minimize"
        />
        <Label for="lock-on-minimize" class="text-sm font-normal">
          Lock when app is minimized or hidden
        </Label>
      </div>

      <!-- Change PIN -->
      {#if !showChangePin}
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            showChangePin = true;
            clearMessages();
            clearInputs();
          }}
        >
          Change PIN
        </Button>
      {:else}
        <div class="space-y-3 rounded-md border border-border p-4">
          <div class="space-y-1">
            <Label for="current-pin">Current PIN</Label>
            <Input
              id="current-pin"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={prefs.pinLength || 6}
              bind:value={currentPinInput}
              placeholder="Current PIN"
              autocomplete="off"
              disabled={loading}
            />
          </div>
          <div class="space-y-1">
            <Label for="new-pin-change">New PIN</Label>
            <Input
              id="new-pin-change"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={prefs.pinLength || 6}
              bind:value={newPinInput}
              placeholder="New PIN"
              autocomplete="off"
              disabled={loading}
            />
          </div>
          <div class="space-y-1">
            <Label for="confirm-new-pin">Confirm New PIN</Label>
            <Input
              id="confirm-new-pin"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={prefs.pinLength || 6}
              bind:value={newPinConfirm}
              placeholder="Confirm New PIN"
              autocomplete="off"
              disabled={loading}
            />
          </div>
          <div class="flex gap-2">
            <Button onclick={handleChangePin} disabled={loading}>
              {loading ? 'Changing...' : 'Change PIN'}
            </Button>
            <Button
              variant="outline"
              onclick={() => {
                showChangePin = false;
                clearInputs();
                clearMessages();
              }}
              disabled={loading}
            >
              Cancel
            </Button>
          </div>
        </div>
      {/if}

      <!-- Passkey management -->
      {#if webauthnAvailable}
        <div class="rounded-md border border-border p-4 space-y-3">
          <div>
            <p class="text-sm font-medium">Passkey</p>
            <p class="text-xs text-muted-foreground mt-1">
              Use your device's biometric authentication (fingerprint, face) or security key as an
              alternative to your PIN.
            </p>
          </div>
          {#if prfSupported}
            {#if passkeyRegistered}
              <div class="flex items-center gap-3">
                <span class="inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20">
                  <ShieldCheck class="h-3 w-3" />
                  Passkey registered
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onclick={handleRemovePasskey}
                  disabled={loading}
                >
                  Remove
                </Button>
              </div>
            {:else}
              <Button variant="outline" size="sm" onclick={handleRegisterPasskey} disabled={loading}>
                {loading ? 'Registering...' : 'Register Passkey'}
              </Button>
            {/if}
          {:else}
            <p class="text-xs text-muted-foreground italic">
              Passkey registration requires a browser and authenticator that support the WebAuthn
              PRF extension. Your current browser or device does not support this feature.
            </p>
          {/if}
        </div>
      {/if}

      <!-- Disable lock -->
      {#if !showDisableConfirm}
        <Button
          variant="destructive"
          size="sm"
          onclick={() => {
            showDisableConfirm = true;
            clearMessages();
          }}
        >
          Disable App Lock
        </Button>
      {:else}
        <div class="rounded-md border border-destructive/50 bg-destructive/5 p-4 space-y-3">
          <p class="text-sm text-destructive">
            Disabling app lock will decrypt all stored data. Your emails and credentials will be
            stored in plaintext on this device.
          </p>
          <div class="flex gap-2">
            <Button variant="destructive" size="sm" onclick={handleDisableLock} disabled={loading}>
              {loading ? 'Disabling...' : 'Confirm Disable'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onclick={() => {
                showDisableConfirm = false;
                clearMessages();
              }}
              disabled={loading}
            >
              Cancel
            </Button>
          </div>
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>
