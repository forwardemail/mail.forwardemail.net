/**
 * QR decoding for the pairing scanner.
 *
 * The decoder is deliberately behind a tiny interface. Android has a native
 * BarcodeDetector (measured: present, with qr_code among its formats), while
 * WebKit has none, so iOS falls back to the bundled jsQR decoder. The scanner
 * UI never knows which one it got.
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
 * Bundled decoder for engines without BarcodeDetector, which in practice means
 * WKWebView. Rasterises the current frame onto an offscreen canvas and hands
 * the pixels to jsQR, the same library the Playwright e2e uses to read the
 * sender's canvas, so both sides of the test matrix exercise one decoder.
 *
 * jsQR is imported lazily: platforms with a native detector never load it.
 */
async function createJsQrDecoder(): Promise<QrDecoder | null> {
  let jsQR: typeof import('jsqr').default;
  try {
    jsQR = (await import('jsqr')).default;
  } catch {
    return null;
  }

  let canvas: HTMLCanvasElement;
  let context: CanvasRenderingContext2D | null;
  try {
    canvas = document.createElement('canvas');
    context = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    // Some webviews throw from getContext rather than returning null; either
    // way the fallback cannot run here.
    return null;
  }
  if (!context) return null;

  // Bounds the per-frame cost. A version 20 symbol needs far less than this,
  // and jsQR's runtime grows with pixel count, not with symbol density.
  const MAX_DIMENSION = 1024;

  return {
    kind: 'jsQR',
    async decode(source: QrFrameSource): Promise<string[]> {
      const width = 'videoWidth' in source ? source.videoWidth : source.width;
      const height = 'videoHeight' in source ? source.videoHeight : source.height;
      if (!width || !height) return [];

      const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      context.drawImage(source, 0, 0, w, h);
      const image = context.getImageData(0, 0, w, h);
      // The sender always paints dark modules on a white quiet zone, so the
      // inverted pass would be pure wasted work; skipping it roughly halves
      // the decode time.
      const found = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
      return found?.data ? [found.data] : [];
    },
    close() {
      // The canvas is garbage collected with the closure.
    },
  };
}

/**
 * Resolve a decoder for this platform: the native BarcodeDetector where it
 * exists and can do QR, the bundled jsQR decoder otherwise. Null only when
 * even the fallback cannot run (no canvas 2d context, import failure), which
 * the caller must still surface as "this build cannot scan here".
 */
export async function createQrDecoder(): Promise<QrDecoder | null> {
  const ctor = getDetectorCtor();
  if (!ctor) return createJsQrDecoder();

  // Ask before constructing: a detector built for an unsupported format throws
  // on first use rather than at construction, which would surface as a scan
  // that silently never matches.
  if (typeof ctor.getSupportedFormats === 'function') {
    try {
      const formats = await ctor.getSupportedFormats();
      if (!formats.includes('qr_code')) return createJsQrDecoder();
    } catch {
      return createJsQrDecoder();
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
