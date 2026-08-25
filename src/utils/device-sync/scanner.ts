/**
 * QR decoding for the pairing scanner.
 *
 * The decoder is deliberately behind a tiny interface. Android has a native
 * BarcodeDetector (measured: present, with qr_code among its formats), while
 * WebKit has none, so iOS will need a bundled decoder - jsQR or zxing-wasm -
 * dropped in here without the scanner UI knowing which one it got.
 *
 * Every decoder returns STRINGS, which is why frames are base45 rather than
 * raw byte mode: DetectedBarcode.rawValue is a DOMString and binary payloads do
 * not survive it. See base45.ts.
 */

/**
 * What a decoder can read. Spelled out rather than using DOM's CanvasImageSource
 * alias, which is type-only and so invisible to ESLint's no-undef.
 */
export type QrFrameSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

export type QrDecoder = {
  /** Which implementation answered, for diagnostics. */
  readonly kind: string;
  decode(source: QrFrameSource): Promise<string[]>;
  close(): void;
};

type BarcodeDetectorLike = {
  detect: (source: QrFrameSource) => Promise<{ rawValue: string }[]>;
};

type BarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

const getDetectorCtor = (): BarcodeDetectorCtor | undefined =>
  (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;

export const isNativeDecoderAvailable = (): boolean => Boolean(getDetectorCtor());

/**
 * Resolve a decoder for this platform, or null when none is available.
 *
 * Null is a real answer the caller must handle - it means "this build cannot
 * scan here" - rather than something to paper over with a broken loop.
 */
export async function createQrDecoder(): Promise<QrDecoder | null> {
  const ctor = getDetectorCtor();
  if (!ctor) return null;

  // Ask before constructing: a detector built for an unsupported format throws
  // on first use rather than at construction, which would surface as a scan
  // that silently never matches.
  if (typeof ctor.getSupportedFormats === 'function') {
    try {
      const formats = await ctor.getSupportedFormats();
      if (!formats.includes('qr_code')) return null;
    } catch {
      return null;
    }
  }

  const detector = new ctor({ formats: ['qr_code'] });
  return {
    kind: 'BarcodeDetector',
    async decode(source: QrFrameSource): Promise<string[]> {
      const found = await detector.detect(source);
      return found.map((entry) => entry.rawValue).filter(Boolean);
    },
    close() {
      // Nothing to release; the native detector is garbage collected.
    },
  };
}

/**
 * Resolve the decoder the scanner should use.
 *
 * Identical to createQrDecoder() in a shipped build. In a `pnpm build:e2e`
 * build it first offers an injection point, so the mobile e2e suite can drive
 * the whole pairing flow - viewfinder, frame assembly, confirmation, write -
 * without a physical camera pointed at a physical screen.
 *
 * Gated on the build flag rather than on a runtime check so a released binary
 * has no path to a substituted decoder at all, whatever is on `window`.
 */
export async function resolveQrDecoder(): Promise<QrDecoder | null> {
  if (import.meta.env?.VITE_E2E) {
    const injected = (globalThis as { __feDeviceSyncDecoder?: () => Promise<QrDecoder | null> })
      .__feDeviceSyncDecoder;
    if (typeof injected === 'function') return injected();
  }
  return createQrDecoder();
}

/**
 * The camera configuration both pairing surfaces open. The continuous-focus
 * constraint came out of real device testing (a phone parks focus at the wrong
 * distance on a dense code and never recovers) and lives here once so the
 * diagnostics spike keeps measuring the same camera the scanner uses.
 * Advanced constraints are ignored where unsupported.
 */
export const QR_CAMERA_CONSTRAINTS = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    // focusMode is a real constraint on Android but missing from lib.dom's
    // types, so this object is spelled out structurally rather than cast to
    // MediaStreamConstraints (a type-only DOM name ESLint cannot see anyway).
    // It is assignable at every getUserMedia call site.
    advanced: [{ focusMode: 'continuous' }],
  },
};

export type ScanLoopOptions = {
  decoder: QrDecoder;
  /** The current frame, or null while the source is not ready yet. */
  source: () => QrFrameSource | null;
  onValue: (value: string) => void;
  onError?: (error: Error) => void;
  /** Called after every completed detection pass with how many codes it saw. */
  onDecodePass?: (foundCount: number) => void;
  /** Pause between detection passes. Detection latency dominates anyway. */
  idleMs?: number;
};

/**
 * Run detection in its own loop, independent of the video's frame callbacks.
 *
 * The spike measured detection at ~91ms against a 30fps camera. Driving
 * detection from requestVideoFrameCallback throttled capture to match, so the
 * loop samples whatever frame is current instead: the video decodes at its own
 * rate and each pass reads the freshest one.
 *
 * Returns a stop function. Safe to call more than once.
 */
export function startScanLoop(options: ScanLoopOptions): () => void {
  const { decoder, source, onValue, onError } = options;
  const idleMs = options.idleMs ?? 0;
  let running = true;

  const run = async () => {
    while (running) {
      const frame = source();
      if (!frame) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }

      try {
        const values = await decoder.decode(frame);
        if (!running) break;
        options.onDecodePass?.(values.length);
        for (const value of values) onValue(value);
      } catch (cause) {
        // A frame that does not decode is the normal case, not a failure. Only
        // surface it if the caller asked, and never stop the loop for it.
        onError?.(cause as Error);
      }

      // Always yield a MACROtask, never just a microtask. A decoder that
      // resolves synchronously would otherwise spin this loop without ever
      // letting timers or input run, wedging the UI - the same failure mode as
      // an unawaited worker call blocking the main thread.
      await new Promise((resolve) => setTimeout(resolve, idleMs));
    }
  };

  void run();

  return () => {
    running = false;
  };
}
