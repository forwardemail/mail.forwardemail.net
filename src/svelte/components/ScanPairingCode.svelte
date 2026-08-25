<script lang="ts">
  /**
   * Receiving half of QR device pairing.
   *
   * Watches the camera for pairing frames, reassembles the bundle, and shows
   * exactly what arrived before writing anything. The confirmation screen
   * renders the same ImportPlan that applyPlan() executes, so what the user
   * approves and what lands on disk cannot drift apart.
   *
   * Nothing is written until the user taps Add. Installing sign-in credentials
   * and private keys because a camera saw a pattern is not something to do
   * silently.
   */
  import { onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import CameraIcon from '@lucide/svelte/icons/camera';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import KeyIcon from '@lucide/svelte/icons/key';
  import CheckIcon from '@lucide/svelte/icons/check';
  import {
    DeviceSyncError,
    FrameCollector,
    applyPlan,
    isPairingCodeComplete,
    openSealedBundle,
    planImport,
    readCurrentState,
    unwrapSealKey,
  } from '../../utils/device-sync';
  import { Input } from '$lib/components/ui/input';
  import type { DeviceSyncBundle, ImportPlan } from '../../utils/device-sync';
  import {
    QR_CAMERA_CONSTRAINTS,
    resolveQrDecoder,
    startScanLoop,
  } from '../../utils/device-sync/scanner';
  import type { QrDecoder, QrFrameSource } from '../../utils/device-sync/scanner';
  import { summarizePgpKeys } from '../../utils/device-sync/pgp-summary';
  import type { PgpKeySummary } from '../../utils/device-sync/pgp-summary';
  import { Local } from '../../utils/storage.js';

  let {
    onCancel,
    onDone,
    createDecoder = resolveQrDecoder,
  }: {
    onCancel: () => void;
    onDone: (result: { account: string | null }) => void;
    /** Injectable so tests and e2e can drive the decode path without a camera. */
    createDecoder?: () => Promise<QrDecoder | null>;
  } = $props();

  type Phase =
    | 'starting'
    | 'scanning'
    | 'opening'
    | 'code'
    | 'unlocking'
    | 'confirm'
    | 'applying'
    | 'done'
    | 'failed';

  let phase = $state<Phase>('starting');
  let error = $state('');
  let received = $state(0);
  let total = $state(0);

  let bundle = $state<DeviceSyncBundle | null>(null);
  let plan = $state<ImportPlan | null>(null);
  let keySummaries = $state<PgpKeySummary[]>([]);
  let video = $state<HTMLVideoElement | null>(null);
  let codeInput = $state('');
  let codeError = $state('');
  let assembled: {
    sealed: Uint8Array;
    key: Uint8Array;
    sessionSalt: Uint8Array;
    codeProtected: boolean;
  } | null = null;

  let stream: MediaStream | null = null;
  let decoder: QrDecoder | null = null;
  let stopLoop: (() => void) | null = null;
  const collector = new FrameCollector();

  const progressLabel = $derived(total > 0 ? `${received} / ${total}` : '');

  const teardown = () => {
    stopLoop?.();
    stopLoop = null;
    decoder?.close();
    decoder = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) video.srcObject = null;
  };

  const fail = (message: string) => {
    teardown();
    error = message;
    phase = 'failed';
  };

  /**
   * A complete set of frames arrived. If the sender required a pairing code the
   * key in those frames is wrapped, so ask for the code before we can open
   * anything - that is the whole point of it: the frames alone are not enough.
   */
  const framesComplete = () => {
    stopLoop?.();
    stopLoop = null;

    const result = collector.assemble();
    assembled = result;
    // The camera is no longer needed either way; release it before a screen
    // that may sit waiting on typing.
    teardown();

    if (result.codeProtected) {
      phase = 'code';
      return;
    }
    // The camera is gone but decrypting and planning take real time on a
    // phone, including a first-use dynamic import of openpgp for the key
    // summaries. Without an explicit phase the UI kept the dead viewfinder up,
    // still captioned to point at the code.
    phase = 'opening';
    void openBundle(result.key);
  };

  const submitCode = async () => {
    if (!assembled || !isPairingCodeComplete(codeInput)) return;
    codeError = '';
    phase = 'unlocking';
    try {
      const key = await unwrapSealKey(assembled.key, codeInput, assembled.sessionSalt);
      await openBundle(key);
    } catch {
      codeError = 'That code did not work. Check it and try again.';
      phase = 'code';
    }
  };

  const openBundle = async (key: Uint8Array) => {
    if (!assembled) return;
    try {
      const opened = await openSealedBundle(assembled.sealed, key);
      bundle = opened;

      const account = opened.account?.email || Local.get('email') || '';
      if (!account) {
        fail('That code carries no account, so there is nothing to add.');
        return;
      }

      const current = await readCurrentState(account);
      plan = planImport(opened, current);
      keySummaries = await summarizePgpKeys(opened.pgp?.keys ?? []);
      phase = 'confirm';
    } catch (cause) {
      if (cause instanceof DeviceSyncError && cause.code === 'EXPIRED') {
        fail('That pairing code has expired. Generate a new one and scan again.');
        return;
      }
      // A wrong pairing code is indistinguishable from a corrupt payload - both
      // fail the AEAD tag. Send the user back to the code rather than to a dead
      // end, since a typo is by far the likelier cause.
      if (
        assembled?.codeProtected &&
        cause instanceof DeviceSyncError &&
        cause.code === 'BAD_KEY'
      ) {
        codeError = 'That code did not work. Check it and try again.';
        phase = 'code';
        return;
      }
      fail(
        cause instanceof DeviceSyncError
          ? cause.message
          : 'That code could not be read. Try scanning again.',
      );
    }
  };

  const onValue = (value: string) => {
    if (phase !== 'scanning') return;
    const result = collector.accept(value);
    if (!result.accepted && !result.restarted) return;

    received = result.received;
    total = result.total;
    if (result.complete) framesComplete();
  };

  const start = async () => {
    phase = 'starting';
    error = '';
    collector.reset();
    assembled = null;
    codeInput = '';
    codeError = '';
    received = 0;
    total = 0;

    try {
      decoder = await createDecoder();
    } catch {
      decoder = null;
    }

    if (!decoder) {
      fail('This device cannot scan QR codes yet. Add the account manually for now.');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS);
    } catch (cause) {
      const name = (cause as Error)?.name;
      fail(
        name === 'NotAllowedError'
          ? 'Camera access was denied. Allow it in system settings, then try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : `The camera could not be started (${name || 'unknown error'}).`,
      );
      return;
    }

    if (video) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay rejection still leaves a live stream the decoder can read.
      }
    }

    phase = 'scanning';
    stopLoop = startScanLoop({
      decoder,
      source: () => (video && video.readyState >= 2 ? (video as QrFrameSource) : null),
      onValue,
    });
  };

  const confirm = async () => {
    if (!plan || !bundle) return;
    phase = 'applying';
    try {
      const result = await applyPlan(plan, bundle, {
        account: bundle.account?.email || Local.get('email') || '',
        activate: Boolean(plan.account),
      });
      phase = 'done';
      onDone({ account: result.activatedAccount });
    } catch (cause) {
      fail(
        cause instanceof DeviceSyncError
          ? cause.message
          : 'Those settings could not be saved. Try again.',
      );
    }
  };

  const cancel = () => {
    teardown();
    onCancel();
  };

  void start();
  onDestroy(teardown);
</script>

<div class="fixed inset-0 z-50 flex flex-col bg-background">
  <header class="flex items-center justify-between border-b border-border p-4">
    <h1 class="flex items-center gap-2 text-base font-semibold">
      <CameraIcon class="h-4 w-4" />
      Add from another device
    </h1>
    <Button variant="ghost" size="sm" onclick={cancel}>Cancel</Button>
  </header>

  {#if phase === 'starting' || phase === 'scanning'}
    <div class="relative flex-1 overflow-hidden bg-black">
      <!-- svelte-ignore a11y_media_has_caption -->
      <!--
        Held invisible until the stream is actually playing. Without that there
        is a stretch during 'starting' where the element exists with no source,
        which is exactly when a webview reaches for its own placeholder chrome.
      -->
      <video
        bind:this={video}
        class="fe-camera-preview h-full w-full object-cover transition-opacity"
        class:opacity-0={phase !== 'scanning'}
        playsinline
        muted
        autoplay
      ></video>

      <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div class="h-64 w-64 rounded-lg border-2 border-white/80"></div>
      </div>
    </div>

    <footer class="space-y-1 p-4 text-center">
      <p class="text-sm">
        {phase === 'starting' ? 'Starting the camera…' : 'Point at the code on your computer'}
      </p>
      {#if total > 1}
        <p class="text-sm text-muted-foreground" aria-live="polite">
          Receiving… {progressLabel}
        </p>
      {/if}
      <p class="text-xs text-muted-foreground">
        On your computer: Settings → Sync to another device
      </p>
    </footer>
  {:else if phase === 'code' || phase === 'unlocking'}
    <div class="flex flex-1 flex-col justify-center gap-4 p-6">
      <div class="space-y-1">
        <h2 class="text-lg font-semibold">Enter the pairing code</h2>
        <p class="text-sm text-muted-foreground">
          It is shown next to the code on your computer. Without it, the scan alone cannot open this
          account.
        </p>
      </div>

      <Input
        bind:value={codeInput}
        placeholder="XXXX-XXXX"
        autocapitalize="characters"
        autocomplete="one-time-code"
        spellcheck="false"
        class="text-center font-mono text-xl tracking-widest"
        disabled={phase === 'unlocking'}
        onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && submitCode()}
      />

      {#if codeError}
        <p class="text-sm text-destructive">{codeError}</p>
      {/if}

      <Button
        onclick={submitCode}
        disabled={phase === 'unlocking' || !isPairingCodeComplete(codeInput)}
      >
        {phase === 'unlocking' ? 'Checking…' : 'Continue'}
      </Button>
      {#if phase === 'unlocking'}
        <p class="text-center text-xs text-muted-foreground">
          Deliberately slow — the same work that makes guessing the code impractical.
        </p>
      {/if}
    </div>
  {:else if phase === 'confirm' && plan}
    <div class="fe-mobile-page-scroll flex-1 space-y-4 overflow-y-auto p-4">
      <h2 class="text-lg font-semibold">Add this account?</h2>

      {#if plan.account}
        <section class="space-y-1">
          <p class="font-medium">{plan.account.email}</p>
          <p class="text-sm text-muted-foreground">
            {plan.account.isNew ? 'New account on this device' : 'Already on this device'}
          </p>
        </section>
      {/if}

      {#if keySummaries.length > 0}
        <section class="space-y-2">
          <p class="text-sm text-muted-foreground">
            {plan.pgp?.added.length ?? 0} PGP key(s) to add
            {#if (plan.pgp?.duplicates.length ?? 0) > 0}
              · {plan.pgp?.duplicates.length} already here
            {/if}
          </p>
          {#each keySummaries as key (key.name + (key.fingerprint ?? ''))}
            <div class="flex items-start gap-2 border border-border p-2 text-sm">
              <KeyIcon class="mt-0.5 h-4 w-4 shrink-0" />
              <div class="min-w-0">
                <p class="font-medium">{key.name}</p>
                {#if key.error}
                  <p class="text-destructive">{key.error}</p>
                {:else}
                  <p class="font-mono text-xs text-muted-foreground">
                    {key.shortId}{key.algorithm ? ` · ${key.algorithm}` : ''}
                  </p>
                  {#if key.userIds.length > 0}
                    <p class="truncate text-xs text-muted-foreground">{key.userIds[0]}</p>
                  {/if}
                {/if}
              </div>
            </div>
          {/each}
          {#if (plan.pgp?.renamed.length ?? 0) > 0}
            <p class="text-xs text-muted-foreground">
              A key here already uses that name, so the incoming one is saved as “{plan.pgp
                ?.renamed[0].to}”. Both are kept.
            </p>
          {/if}
        </section>
      {/if}

      {#if plan.settings.length > 0 || plan.extras.length > 0}
        <section class="space-y-1">
          <p class="text-sm text-muted-foreground">
            {plan.settings.length + plan.extras.length} setting(s) will change
          </p>
          <ul class="text-sm">
            {#each plan.settings.slice(0, 6) as change (change.id)}
              <li class="text-muted-foreground">{change.label}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if bundle?.src}
        <p class="text-xs text-muted-foreground">
          From {bundle.src.app} on {bundle.src.os}
        </p>
      {/if}
    </div>

    <footer class="flex gap-2 border-t border-border p-4">
      <Button variant="ghost" class="flex-1" onclick={cancel}>Cancel</Button>
      <Button class="flex-1" onclick={confirm}>Add account</Button>
    </footer>
  {:else if phase === 'applying' || phase === 'opening'}
    <div class="flex flex-1 items-center justify-center p-4">
      <p class="text-sm text-muted-foreground">
        {phase === 'opening' ? 'Reading the code…' : 'Saving…'}
      </p>
    </div>
  {:else if phase === 'done'}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4">
      <CheckIcon class="h-8 w-8" />
      <p class="text-sm">Added.</p>
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertCircle class="h-8 w-8 text-destructive" />
      <p class="text-sm">{error}</p>
      <div class="flex gap-2">
        <Button variant="ghost" onclick={cancel}>Cancel</Button>
        <Button onclick={start}>Try again</Button>
      </div>
    </div>
  {/if}
</div>
