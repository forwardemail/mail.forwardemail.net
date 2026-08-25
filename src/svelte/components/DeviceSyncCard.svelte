<script lang="ts">
  /**
   * Sync to another device - the sending half of QR pairing.
   *
   * Builds a bundle from the active account (sign-in, PGP keys, portable
   * settings), seals it, and puts it on screen as a QR code for a phone to
   * scan. Nothing goes through a server; the code itself carries the payload,
   * so anything too large for one QR becomes an animated sequence of frames.
   *
   * Because the code IS the secret, it is gated behind the App Lock PIN where
   * one is configured, hidden until the user deliberately reveals it, and
   * expires on a visible countdown.
   *
   * The receiving half lives on mobile: Settings → Add from another device.
   */
  import { onDestroy } from 'svelte';
  import * as Card from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import QrCodeIcon from '@lucide/svelte/icons/qr-code';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import { Local } from '../../utils/storage.js';
  import { isLockEnabled, isVaultConfigured, unlockWithPin } from '../../utils/crypto-store.js';
  import { getOS, isTauriDesktop } from '../../utils/platform.js';
  import {
    DEFAULT_TTL_SECONDS,
    DeviceSyncError,
    collectBundle,
    encodeFrames,
    formatPairingCode,
    generatePairingCode,
    newSessionId,
    sealBundle,
    wrapSealKey,
  } from '../../utils/device-sync';

  let { account = '' }: { account?: string } = $props();

  /**
   * Frame cadence. Faster than this and a phone camera keeps catching frames
   * mid-transition; slower and a multi-frame code takes visibly too long.
   */
  const FRAME_INTERVAL_MS = 400;
  /**
   * Rendered size of the code. A multi-frame bundle lands on a version 20
   * symbol - 97 modules plus quiet zone - so 288px gave under 3px per module,
   * which forces a phone close enough that it cannot hold focus. At 400px each
   * module is ~4px and the phone can sit back at a comfortable focus distance.
   */
  const QR_PIXELS = 400;

  let includeAccount = $state(true);
  let includePgp = $state(true);
  let includeSettings = $state(true);

  let phase = $state<'idle' | 'pin' | 'active' | 'expired'>('idle');
  let busy = $state(false);
  let error = $state('');
  let pin = $state('');

  let frames = $state<string[]>([]);
  let pairingCode = $state('');
  let sharedCredentials = $state(false);
  let expiredUnprotected = $state(false);
  let frameIndex = $state(0);
  let secondsLeft = $state(0);
  let held = $state(false);
  let keepVisible = $state(false);
  let canvas = $state<HTMLCanvasElement | null>(null);

  let animationTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  const visible = $derived(held || keepVisible);
  const multiFrame = $derived(frames.length > 1);

  const pgpKeyCount = $derived.by(() => {
    if (!account) return 0;
    try {
      const raw = Local.get(`pgp_keys_${account}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  });

  // A disabled checkbox still holds its bound value, so an account with no
  // keys would otherwise count the PGP bucket as selected forever.
  const pgpSelected = $derived(includePgp && pgpKeyCount > 0);
  const anythingSelected = $derived(includeAccount || pgpSelected || includeSettings);

  /**
   * A pairing code is what makes a photograph of the code useless. The TTL does
   * not do that job: expiry lives inside the payload and is honoured by an
   * honest scanner, while anyone holding the image already holds the key.
   *
   * So it defaults on exactly when there is something worth stealing -
   * credentials or private keys - and off for a settings-only bundle, where the
   * extra typing buys nothing.
   */
  const protectionRecommended = $derived(includeAccount || pgpSelected);
  let requireCode = $state(true);
  // Follow the recommendation only until the user touches the checkbox. An
  // unconditional reset would silently discard an explicit opt-in the moment
  // any bucket toggles, and the next code would go out unprotected.
  let requireCodeTouched = false;
  $effect(() => {
    const recommended = protectionRecommended;
    if (!requireCodeTouched) requireCode = recommended;
  });

  const countdownLabel = $derived.by(() => {
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = String(secondsLeft % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  });

  const clearTimers = () => {
    if (animationTimer) clearInterval(animationTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    animationTimer = null;
    countdownTimer = null;
  };

  const wipeCanvas = () => {
    if (!canvas) return;
    try {
      // A webview without a 2d context is rare but not impossible, and this
      // runs inside an effect where a throw would take the card down with it.
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    } catch {
      // nothing to clear
    }
  };

  /**
   * Drop the payload as well as the timers. The frames carry the seal key, so
   * leaving them in component state after the code expires would keep a live
   * credential around for as long as the settings page stays open.
   */
  const stopPairing = (next: 'idle' | 'expired') => {
    // Decide the warning BEFORE the wipe below; by render time pairingCode is
    // always empty, which made the rotate-password alarm fire on every
    // credential expiry, protected or not.
    expiredUnprotected = next === 'expired' && sharedCredentials && !pairingCode;
    clearTimers();
    frames = [];
    frameIndex = 0;
    secondsLeft = 0;
    held = false;
    keepVisible = false;
    pairingCode = '';
    wipeCanvas();
    phase = next;
  };

  const startPairing = async () => {
    if (busy) return;
    busy = true;
    error = '';
    // Regenerate reuses this path while a code is live; without this the old
    // countdown and animation intervals keep running alongside the new ones.
    clearTimers();
    expiredUnprotected = false;

    try {
      const bundle = await collectBundle({
        account,
        include: { account: includeAccount, pgp: pgpSelected, settings: includeSettings },
        source: {
          app: isTauriDesktop ? 'desktop' : 'web',
          os: getOS(),
          name: isTauriDesktop ? 'this computer' : 'this browser',
        },
      });

      const { key, sealed } = await sealBundle(bundle);

      // The session id doubles as the KDF salt, so it has to exist before the
      // key is wrapped rather than being generated inside encodeFrames.
      const sessionId = newSessionId();
      const code = requireCode ? generatePairingCode() : '';
      const frameKey = code ? await wrapSealKey(key, code, sessionId) : key;

      pairingCode = code ? formatPairingCode(code) : '';
      sharedCredentials = includeAccount;
      frames = encodeFrames({
        sealed,
        key: frameKey,
        sessionId,
        codeProtected: Boolean(code),
      });
      frameIndex = 0;
      secondsLeft = DEFAULT_TTL_SECONDS;
      phase = 'active';
      pin = '';

      if (frames.length > 1) {
        animationTimer = setInterval(() => {
          frameIndex = (frameIndex + 1) % frames.length;
        }, FRAME_INTERVAL_MS);
      }

      countdownTimer = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft <= 0) stopPairing('expired');
      }, 1000);
    } catch (cause) {
      error =
        cause instanceof DeviceSyncError
          ? cause.message
          : 'Could not build a pairing code for this account.';
      phase = 'idle';
    } finally {
      busy = false;
    }
  };

  /**
   * Revealing unmounts the overlay button, so its own pointerup can never
   * fire. Listen on the window for the release instead; otherwise one tap
   * turned hold-to-reveal into a permanent reveal.
   */
  const beginHold = () => {
    held = true;
    const release = () => {
      held = false;
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  const beginReveal = async () => {
    error = '';
    // Checked at click time, not via $derived: these are plain localStorage
    // reads with no reactive backing, so a derived value would go stale the
    // moment App Lock is enabled or disabled elsewhere on this same page.
    if (isLockEnabled() && isVaultConfigured()) {
      phase = 'pin';
      return;
    }
    await startPairing();
  };

  const confirmPin = async () => {
    if (busy) return;
    busy = true;
    error = '';
    try {
      // Re-deriving the KEK from the entered PIN is how we verify it. An
      // already-unlocked vault simply unlocks again.
      const ok = await unlockWithPin(pin);
      if (!ok) {
        error = 'That PIN did not match.';
        return;
      }
    } catch {
      error = 'That PIN did not match.';
      return;
    } finally {
      busy = false;
    }
    await startPairing();
  };

  $effect(() => {
    const frame = frames[frameIndex];
    const target = canvas;
    if (!target) return;

    if (!visible || !frame) {
      wipeCanvas();
      return;
    }

    let cancelled = false;
    // Lazy so the encoder only lands in the chunk that actually renders a code.
    import('qrcode')
      .then(({ default: QRCode }) => {
        if (cancelled) return;
        return QRCode.toCanvas(target, frame, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: QR_PIXELS,
          // Fixed black on white regardless of theme. A themed QR is a QR that
          // sometimes will not scan.
          color: { dark: '#000000ff', light: '#ffffffff' },
        });
      })
      .catch(() => {
        if (!cancelled) error = 'Could not render the pairing code.';
      });

    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    clearTimers();
    frames = [];
  });
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="flex items-center gap-2">
      <QrCodeIcon class="h-4 w-4" />
      Sync to another device
    </Card.Title>
    <Card.Description>
      Move this account, its PGP keys and its app settings to your phone by scanning a code. Nothing
      is sent over the internet — the code itself carries everything.
    </Card.Description>
  </Card.Header>

  <Card.Content class="space-y-4">
    {#if error}
      <p class="flex items-start gap-2 text-sm text-destructive">
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error}</span>
      </p>
    {/if}

    {#if phase === 'idle' || phase === 'expired'}
      {#if phase === 'expired'}
        <p class="text-sm text-muted-foreground">
          That code expired. Generate a new one when your phone is ready.
        </p>
        {#if expiredUnprotected}
          <p class="text-sm">
            That code carried this account's password with no pairing code. If anyone could see your
            screen, change the password for <strong>{account}</strong> — rotating it is the only thing
            that actually revokes what was shown.
          </p>
        {/if}
      {/if}

      <fieldset class="space-y-2">
        <legend class="mb-2 text-sm text-muted-foreground">Include</legend>

        <label class="flex items-center gap-3 text-sm">
          <Checkbox bind:checked={includeAccount} aria-label="Include sign-in credentials" />
          <span>Sign-in for <strong>{account || 'this account'}</strong></span>
        </label>

        <label class="flex items-center gap-3 text-sm">
          <Checkbox
            bind:checked={includePgp}
            disabled={pgpKeyCount === 0}
            aria-label="Include PGP keys and passphrases"
          />
          <span>
            PGP keys and passphrases
            {#if pgpKeyCount === 0}
              <span class="text-muted-foreground">(none saved)</span>
            {:else}
              <span class="text-muted-foreground">({pgpKeyCount})</span>
            {/if}
          </span>
        </label>

        <label class="flex items-center gap-3 text-sm">
          <Checkbox bind:checked={includeSettings} aria-label="Include app settings" />
          <span>App settings, signature and saved searches</span>
        </label>
      </fieldset>

      <label class="flex items-start gap-3 text-sm">
        <Checkbox
          bind:checked={requireCode}
          onCheckedChange={() => (requireCodeTouched = true)}
          aria-label="Require a pairing code"
          class="mt-0.5"
        />
        <span>
          Require a pairing code
          <span class="block text-xs text-muted-foreground">
            You type a short code on your phone as well as scanning. Without it, a photo of the code
            is enough to use it.
          </span>
        </span>
      </label>

      <Button onclick={beginReveal} disabled={busy || !anythingSelected || !account}>
        {busy ? 'Preparing…' : 'Show pairing code'}
      </Button>

      <p class="text-xs text-muted-foreground">
        Anyone who photographs the code gets everything in it. Show it only when you can see who is
        around you, and never on a shared or projected screen.
      </p>
    {:else if phase === 'pin'}
      <div class="space-y-3">
        <p class="text-sm">Enter your app lock PIN to continue.</p>
        <Input
          type="password"
          inputmode="numeric"
          autocomplete="current-password"
          placeholder="PIN"
          bind:value={pin}
          onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirmPin()}
        />
        <div class="flex gap-2">
          <Button
            variant="ghost"
            onclick={() => {
              phase = 'idle';
              pin = '';
              error = '';
            }}>Cancel</Button
          >
          <Button onclick={confirmPin} disabled={busy || pin.length === 0}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
        </div>
      </div>
    {:else}
      <div class="space-y-3">
        <div class="relative w-fit">
          <canvas
            bind:this={canvas}
            data-testid="pairing-qr-canvas"
            width={QR_PIXELS}
            height={QR_PIXELS}
            class="block rounded bg-white"
            class:invisible={!visible}
            aria-hidden="true"
          ></canvas>

          {#if !visible}
            <button
              type="button"
              class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded border border-dashed border-border bg-muted text-sm text-muted-foreground"
              style="width: {QR_PIXELS}px; height: {QR_PIXELS}px;"
              onpointerdown={beginHold}
            >
              <EyeIcon class="h-5 w-5" />
              Press and hold to reveal
            </button>
          {/if}
        </div>

        <label class="flex items-center gap-3 text-sm">
          <Checkbox bind:checked={keepVisible} aria-label="Keep the code visible while I scan" />
          <span>Keep the code visible while I scan</span>
        </label>

        <p class="text-sm text-muted-foreground" aria-live="polite">
          Expires in {countdownLabel}
          {#if multiFrame}
            · this code animates, keep your phone pointed at it
          {/if}
        </p>

        {#if pairingCode}
          <div class="border border-border p-3">
            <p class="text-xs text-muted-foreground">Pairing code — type this on your phone</p>
            <p class="font-mono text-2xl tracking-widest">{pairingCode}</p>
            <p class="mt-1 text-xs text-muted-foreground">
              Keep it separate from the code itself. A photo of the QR is useless without it.
            </p>
          </div>
        {/if}

        <p class="text-sm">
          On your phone: <strong>Settings → Add from another device</strong>
        </p>

        <div class="flex gap-2">
          <Button variant="ghost" onclick={() => stopPairing('idle')}>Cancel</Button>
          <Button variant="ghost" onclick={startPairing} disabled={busy}>
            <RefreshIcon class="mr-2 h-4 w-4" />
            Regenerate
          </Button>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
