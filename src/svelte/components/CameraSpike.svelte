<script lang="ts">
  /**
   * Camera + QR decode spike, for the receiving half of device pairing.
   *
   * Lives on the hidden /mailbox/diagnostics page because that route is
   * auth-independent - which is exactly the state a phone is in when you are
   * testing pairing on it for the first time.
   *
   * It answers three questions that decide how the scanner gets built:
   *   1. Is the webview a secure context? getUserMedia is gated on it.
   *   2. Does getUserMedia actually hand back a camera under wry?
   *   3. Is there a usable QR decoder, and can it read our frames off a screen?
   *
   * Point it at Settings → Sync to another device on a desktop or in webmail
   * and it reports live progress, which measures the whole path end to end.
   *
   * Read the "origin" line before believing any camera failure. getUserMedia
   * needs a secure context, and which origin the webview gets depends on how it
   * was launched:
   *   - built app (debug or release): http://tauri.localhost - secure, the
   *     .localhost suffix is treated as potentially trustworthy.
   *   - android dev with adb reverse: http://localhost:5174 - secure.
   *     android-dev.sh sets that up for phones as well as emulators.
   *   - anything on a LAN address (http://192.168.x.x:5174): NOT secure. That
   *     is the fallback when adb reverse did not run, and it is what iOS uses
   *     for a physical device. The camera is blocked there for reasons that
   *     have nothing to do with this design.
   */
  import { onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import CameraIcon from '@lucide/svelte/icons/camera';
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import { getOS, isTauriMobile } from '../../utils/platform.js';
  import { FrameCollector, decodeFrame } from '../../utils/device-sync';
  import {
    QR_CAMERA_CONSTRAINTS,
    createQrDecoder,
    isNativeDecoderAvailable,
    startScanLoop,
  } from '../../utils/device-sync/scanner';
  import type { QrDecoder, QrFrameSource } from '../../utils/device-sync/scanner';

  // The formats listing is the one probe scanner.ts has no reason to expose;
  // everything else camera- or decode-shaped is borrowed from scanner.ts so
  // this screen keeps diagnosing the exact code path the real scanner runs.
  type FormatProbe = { getSupportedFormats?: () => Promise<string[]> };
  const detectorCtor = (globalThis as { BarcodeDetector?: FormatProbe }).BarcodeDetector;

  let probe = $state<Record<string, string>>({});
  let supportedFormats = $state<string[]>([]);

  let cameraState = $state<'idle' | 'starting' | 'live' | 'failed'>('idle');
  let cameraError = $state('');
  let trackInfo = $state<Record<string, unknown> | null>(null);
  let video = $state<HTMLVideoElement | null>(null);

  let cameraFps = $state(0);
  let decoderKind = $state('none');
  let decodeAttempts = $state(0);
  let decodesSucceeded = $state(0);
  let lastRawValue = $state('');
  let pairingProgress = $state<{ received: number; total: number } | null>(null);
  let pairingComplete = $state(false);
  let copied = $state(false);

  let stream: MediaStream | null = null;
  let decoder: QrDecoder | null = null;
  let stopLoop: (() => void) | null = null;
  let stopFpsCounter: (() => void) | null = null;
  const collector = new FrameCollector();

  const yesNo = (value: unknown) => (value ? 'yes' : 'no');

  const runProbe = async () => {
    probe = {
      platform: `${getOS()}${isTauriMobile ? ' (tauri mobile)' : ''}`,
      origin: globalThis.location?.origin ?? 'unknown',
      isSecureContext: yesNo(globalThis.isSecureContext),
      'navigator.mediaDevices': yesNo(navigator.mediaDevices),
      getUserMedia: yesNo(typeof navigator.mediaDevices?.getUserMedia === 'function'),
      BarcodeDetector: yesNo(isNativeDecoderAvailable()),
      requestVideoFrameCallback: yesNo(
        typeof HTMLVideoElement !== 'undefined' &&
          'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      ),
      CompressionStream: yesNo(typeof globalThis.CompressionStream === 'function'),
    };

    if (detectorCtor?.getSupportedFormats) {
      try {
        supportedFormats = await detectorCtor.getSupportedFormats();
      } catch {
        supportedFormats = [];
      }
    }
  };

  void runProbe();

  const verdict = $derived.by(() => {
    if (probe.isSecureContext === 'no') {
      return {
        tone: 'bad',
        text: `Not a secure context (${probe.origin}). getUserMedia is blocked here regardless of permissions. This origin is a LAN address, so the block is the origin, not the design. Reconnect over USB so adb reverse gives the webview a localhost origin, or install a debug APK.`,
      };
    }
    if (probe.getUserMedia === 'no') {
      return {
        tone: 'bad',
        text: 'No getUserMedia in this webview. The scanner would need the native barcode-scanner plugin, which is one-shot only — that means static codes only, and large PGP keys would need the relay design.',
      };
    }
    if (cameraState === 'failed') {
      return { tone: 'bad', text: `Camera failed to start: ${cameraError}` };
    }
    if (pairingComplete) {
      return { tone: 'good', text: 'Read a complete pairing payload end to end.' };
    }
    if (decodesSucceeded > 0) {
      return {
        tone: 'good',
        text: `Camera and decoder both work — ${decodesSucceeded} decode(s) in ${decodeAttempts} attempts.`,
      };
    }
    if (cameraState !== 'live') {
      return { tone: 'unknown', text: 'Start the camera to finish the check.' };
    }
    if (!isNativeDecoderAvailable()) {
      return {
        tone: 'unknown',
        text: 'No native BarcodeDetector here; scanning uses the bundled jsQR decoder. Point it at a pairing code.',
      };
    }
    return { tone: 'unknown', text: 'Camera is live. Nothing decoded yet.' };
  });

  const stopCamera = () => {
    stopLoop?.();
    stopLoop = null;
    stopFpsCounter?.();
    stopFpsCounter = null;
    decoder?.close();
    decoder = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) video.srcObject = null;
    cameraState = 'idle';
  };

  /**
   * Raw camera frame rate, counted independently of decoding. The decode loop
   * below is scanner.ts's own startScanLoop, so what this screen measures is
   * the code path the real scanner runs, not a private reimplementation of it.
   */
  const startFpsCounter = () => {
    if (!video) return;
    let running = true;
    let frames = 0;
    let windowStart = performance.now();

    const tick = () => {
      if (!running || !video) return;
      frames += 1;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        cameraFps = Math.round((frames * 1000) / (now - windowStart));
        frames = 0;
        windowStart = now;
      }
      queueFrame();
    };

    const queueFrame = () => {
      if (!running || !video) return;
      const element = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => void;
      };
      if (typeof element.requestVideoFrameCallback === 'function') {
        element.requestVideoFrameCallback(tick);
      } else {
        requestAnimationFrame(tick);
      }
    };

    queueFrame();
    stopFpsCounter = () => {
      running = false;
    };
  };

  const onValue = (value: string) => {
    decodesSucceeded += 1;
    lastRawValue = value.slice(0, 48);
    if (decodeFrame(value)) {
      const result = collector.accept(value);
      pairingProgress = { received: result.received, total: result.total };
      if (result.complete) pairingComplete = true;
    }
  };

  const startCamera = async () => {
    if (cameraState === 'starting' || cameraState === 'live') return;
    cameraState = 'starting';
    cameraError = '';
    collector.reset();
    pairingProgress = null;
    pairingComplete = false;
    decodeAttempts = 0;
    decodesSucceeded = 0;

    try {
      stream = await navigator.mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS);

      if (video) {
        video.srcObject = stream;
        await video.play();
      }

      trackInfo = stream.getVideoTracks()[0]?.getSettings() as Record<string, unknown>;
      decoder = await createQrDecoder();
      decoderKind = decoder?.kind ?? 'none';

      cameraState = 'live';
      startFpsCounter();
      if (decoder) {
        stopLoop = startScanLoop({
          decoder,
          source: () => (video && video.readyState >= 2 ? (video as QrFrameSource) : null),
          onValue,
          onDecodePass: () => {
            decodeAttempts += 1;
          },
        });
      }
    } catch (error) {
      // The error NAME is the useful part: NotAllowedError means the user or
      // the OS said no, NotFoundError means no camera, NotReadableError means
      // something else holds it, TypeError usually means insecure context.
      const cause = error as Error;
      cameraError = `${cause.name}: ${cause.message}`;
      // stopCamera resets the phase to idle, so 'failed' must land after it.
      stopCamera();
      cameraState = 'failed';
    }
  };

  const reportText = $derived.by(() => {
    const lines = [
      '# Camera / QR pairing spike',
      ...Object.entries(probe).map(([key, value]) => `${key}: ${value}`),
      `barcodeFormats: ${supportedFormats.join(', ') || 'n/a'}`,
      `cameraState: ${cameraState}`,
      `cameraError: ${cameraError || 'none'}`,
      `trackSettings: ${trackInfo ? JSON.stringify(trackInfo) : 'n/a'}`,
      `decoder: ${decoderKind}`,
      `cameraFps: ${cameraFps}`,
      `decodeAttempts: ${decodeAttempts}`,
      `decodesSucceeded: ${decodesSucceeded}`,
      `pairingProgress: ${pairingProgress ? `${pairingProgress.received}/${pairingProgress.total}` : 'none'}`,
      `pairingComplete: ${yesNo(pairingComplete)}`,
      `verdict: ${verdict.text}`,
    ];
    return lines.join('\n');
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportText);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
    }
  };

  onDestroy(stopCamera);
</script>

<section class="space-y-4 border-t border-border pt-6">
  <header class="space-y-1">
    <h2 class="flex items-center gap-2 text-lg font-semibold">
      <CameraIcon class="h-4 w-4" />
      Camera / QR pairing spike
    </h2>
    <p class="text-sm text-muted-foreground">
      Decides how the pairing scanner gets built. Check the <code>origin</code> line first: a
      <code>localhost</code> or <code>tauri.localhost</code> origin is a secure context and the
      camera can work. A LAN address such as <code>192.168.x.x</code> is not, and the camera is blocked
      there no matter what permissions say.
    </p>
  </header>

  <div class="space-y-1">
    {#each Object.entries(probe) as [key, value] (key)}
      <div class="flex items-center justify-between gap-4 text-sm">
        <MonoLabel>{key}</MonoLabel>
        <span class:text-destructive={value === 'no'}>{value}</span>
      </div>
    {/each}
    {#if supportedFormats.length > 0}
      <div class="flex items-center justify-between gap-4 text-sm">
        <MonoLabel>barcodeFormats</MonoLabel>
        <span>{supportedFormats.join(', ')}</span>
      </div>
    {/if}
  </div>

  <div class="flex flex-wrap gap-2">
    <Button onclick={startCamera} disabled={cameraState === 'starting' || cameraState === 'live'}>
      {cameraState === 'starting' ? 'Starting…' : 'Start camera'}
    </Button>
    <Button variant="ghost" onclick={stopCamera} disabled={cameraState !== 'live'}>Stop</Button>
    <Button variant="ghost" onclick={copy}>
      <ClipboardCopy class="mr-2 h-4 w-4" />
      {copied ? 'Copied' : 'Copy report'}
    </Button>
  </div>

  <!--
    Stats sit ABOVE the preview on purpose. The preview is full width, so
    anything below it is off the bottom of a phone screen exactly when you are
    holding the phone up and need to read the decode counter.
  -->
  {#if cameraState === 'live' || decodeAttempts > 0}
    <div class="space-y-1 text-sm">
      <div class="flex items-center justify-between gap-4">
        <MonoLabel>cameraFps</MonoLabel>
        <span>{cameraFps}</span>
      </div>
      <div class="flex items-center justify-between gap-4">
        <MonoLabel>resolution</MonoLabel>
        <span>{trackInfo ? `${trackInfo.width}x${trackInfo.height}` : 'unknown'}</span>
      </div>
      <div class="flex items-center justify-between gap-4">
        <MonoLabel>decodes</MonoLabel>
        <span>{decodesSucceeded} / {decodeAttempts} attempts</span>
      </div>
      {#if pairingProgress}
        <div class="flex items-center justify-between gap-4">
          <MonoLabel>pairingFrames</MonoLabel>
          <span>{pairingProgress.received} / {pairingProgress.total}</span>
        </div>
      {/if}
      {#if lastRawValue}
        <div class="flex items-center justify-between gap-4">
          <MonoLabel>lastValue</MonoLabel>
          <span class="truncate">{lastRawValue}…</span>
        </div>
      {/if}
    </div>
  {/if}

  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={video}
    class="fe-camera-preview w-full max-w-sm rounded bg-black"
    class:hidden={cameraState !== 'live'}
    playsinline
    muted
    autoplay
  ></video>

  <p class="text-sm">
    <Badge
      variant={verdict.tone === 'good'
        ? 'default'
        : verdict.tone === 'bad'
          ? 'destructive'
          : 'secondary'}
    >
      {verdict.tone}
    </Badge>
    <span class="ml-2">{verdict.text}</span>
  </p>
</section>
