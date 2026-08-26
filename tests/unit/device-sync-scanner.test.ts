/**
 * Decoder resolution and the scan loop.
 *
 * The loop is fed whatever drifts through a viewfinder, so the behaviours that
 * matter are the unglamorous ones: a frame that fails to decode is normal and
 * must not stop scanning, and stop() must actually stop - a loop still running
 * after teardown holds the camera open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQrDecoder,
  isNativeDecoderAvailable,
  resolveQrDecoder,
  startScanLoop,
} from '../../src/utils/device-sync/scanner';
import type { QrDecoder, QrFrameSource } from '../../src/utils/device-sync/scanner';

const FRAME = {} as QrFrameSource;

vi.mock('jsqr', () => ({
  default: vi.fn((data: Uint8ClampedArray) =>
    // The stubbed context below tags decodable frames with a marker byte.
    data[0] === 0xfe ? { data: 'FE1-FROM-JSQR' } : null,
  ),
}));

/** A working 2d context, since jsdom's getContext throws without node-canvas. */
const stubCanvasContext = (firstByte: number) => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      data: Uint8ClampedArray.of(firstByte, 0, 0, 255),
      width: 1,
      height: 1,
    })),
  } as unknown as CanvasRenderingContext2D);
};

const VIDEO_FRAME = { videoWidth: 640, videoHeight: 480 } as unknown as QrFrameSource;

const fakeDecoder = (impl: () => Promise<string[]>): QrDecoder => ({
  kind: 'fake',
  decode: impl,
  close: vi.fn(),
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createQrDecoder', () => {
  it('falls back to the bundled jsQR decoder without BarcodeDetector (the iOS case)', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    stubCanvasContext(0xfe);

    expect(isNativeDecoderAvailable()).toBe(false);
    const decoder = await createQrDecoder();
    expect(decoder?.kind).toBe('jsQR');
    await expect(decoder!.decode(VIDEO_FRAME)).resolves.toEqual(['FE1-FROM-JSQR']);
  });

  it('returns nothing for a frame jsQR cannot read, without erroring', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    stubCanvasContext(0x00);

    const decoder = await createQrDecoder();
    await expect(decoder!.decode(VIDEO_FRAME)).resolves.toEqual([]);
  });

  it('skips a frame whose source has no dimensions yet', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    stubCanvasContext(0xfe);

    const decoder = await createQrDecoder();
    const notReady = { videoWidth: 0, videoHeight: 0 } as unknown as QrFrameSource;
    await expect(decoder!.decode(notReady)).resolves.toEqual([]);
  });

  it('falls back to jsQR when the detector cannot do qr_code', async () => {
    // A detector built for an unsupported format throws on first use, not at
    // construction - which would look like a scan that simply never matches.
    vi.stubGlobal('BarcodeDetector', {
      getSupportedFormats: async () => ['ean_13', 'code_128'],
    });
    stubCanvasContext(0xfe);

    const decoder = await createQrDecoder();
    expect(decoder?.kind).toBe('jsQR');
  });

  it('resolves null only when even the fallback cannot run', async () => {
    // jsdom's real getContext throws without node-canvas, which stands in for
    // a webview with no usable 2d context.
    vi.stubGlobal('BarcodeDetector', undefined);
    await expect(createQrDecoder()).resolves.toBeNull();
  });

  it('maps native detections to raw string values', async () => {
    const detect = vi.fn(async () => [{ rawValue: 'FE1-ONE' }, { rawValue: '' }]);
    class FakeDetector {
      detect = detect;
      static getSupportedFormats = async () => ['qr_code'];
    }
    vi.stubGlobal('BarcodeDetector', FakeDetector);

    const decoder = await createQrDecoder();
    expect(decoder?.kind).toBe('BarcodeDetector');
    // Empty rawValues are dropped, not passed on as blank frames.
    await expect(decoder!.decode(FRAME)).resolves.toEqual(['FE1-ONE']);
  });

  it('falls back to jsQR when the format query throws', async () => {
    vi.stubGlobal('BarcodeDetector', {
      getSupportedFormats: async () => {
        throw new Error('nope');
      },
    });
    stubCanvasContext(0xfe);
    const decoder = await createQrDecoder();
    expect(decoder?.kind).toBe('jsQR');
  });
});

describe('resolveQrDecoder', () => {
  const injected = fakeDecoder(async () => ['injected']);

  it('ignores an injected decoder in a normal build', async () => {
    // The gate is the whole point: a shipped binary must have no path to a
    // substituted decoder, whatever is sitting on window.
    vi.stubGlobal('BarcodeDetector', undefined);
    vi.stubGlobal('__feDeviceSyncDecoder', async () => injected);

    await expect(resolveQrDecoder()).resolves.toBeNull();
  });

  it('uses the injected decoder in an e2e build', async () => {
    vi.stubEnv('VITE_E2E', '1');
    vi.stubGlobal('BarcodeDetector', undefined);
    vi.stubGlobal('__feDeviceSyncDecoder', async () => injected);

    await expect(resolveQrDecoder()).resolves.toBe(injected);
  });

  it('falls back to the platform decoder when an e2e build injects nothing', async () => {
    vi.stubEnv('VITE_E2E', '1');
    vi.stubGlobal('BarcodeDetector', undefined);

    await expect(resolveQrDecoder()).resolves.toBeNull();
  });
});

describe('startScanLoop', () => {
  it('reports every decoded value', async () => {
    const values: string[] = [];
    const stop = startScanLoop({
      decoder: fakeDecoder(async () => ['a', 'b']),
      source: () => FRAME,
      onValue: (v) => values.push(v),
    });

    await settle();
    stop();

    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values.slice(0, 2)).toEqual(['a', 'b']);
  });

  it('keeps scanning after a frame fails to decode', async () => {
    let call = 0;
    const values: string[] = [];
    const errors: Error[] = [];

    const stop = startScanLoop({
      decoder: fakeDecoder(async () => {
        call += 1;
        if (call === 1) throw new Error('no code in frame');
        return ['recovered'];
      }),
      source: () => FRAME,
      onValue: (v) => values.push(v),
      onError: (e) => errors.push(e),
    });

    await settle();
    stop();

    expect(errors).toHaveLength(1);
    expect(values).toContain('recovered');
  });

  it('waits without decoding while the source is not ready', async () => {
    const decode = vi.fn(async () => []);
    const stop = startScanLoop({
      decoder: fakeDecoder(decode),
      source: () => null,
      onValue: () => {},
    });

    await settle();
    stop();

    expect(decode).not.toHaveBeenCalled();
  });

  it('stops decoding once stopped, so the camera can be released', async () => {
    const decode = vi.fn(async () => []);
    const stop = startScanLoop({
      decoder: fakeDecoder(decode),
      source: () => FRAME,
      onValue: () => {},
    });

    await settle();
    stop();
    const afterStop = decode.mock.calls.length;

    await settle();
    expect(decode.mock.calls.length).toBe(afterStop);
  });

  it('does not deliver values decoded after stop', async () => {
    const values: string[] = [];
    let release: (v: string[]) => void = () => {};

    const stop = startScanLoop({
      decoder: fakeDecoder(() => new Promise<string[]>((resolve) => (release = resolve))),
      source: () => FRAME,
      onValue: (v) => values.push(v),
    });

    await settle();
    stop();
    // A detection already in flight when stop() lands must not act on its result.
    release(['late']);
    await settle();

    expect(values).toEqual([]);
  });
});
