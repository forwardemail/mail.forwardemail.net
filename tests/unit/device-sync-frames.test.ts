/**
 * Frame splitting/collection for QR device pairing.
 *
 * A single static QR is the one-frame case of the same path an animated code
 * takes, so these tests care most about the awkward cases the camera actually
 * produces: frames out of order, the same frame a dozen times, an unrelated QR
 * drifting through the viewfinder, and the user hitting Regenerate halfway
 * through a scan.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  DEFAULT_CHUNK_BYTES,
  FRAME_HEADER_BYTES,
  FrameCollector,
  MAX_FRAMES,
  decodeFrame,
  encodeFrames,
  newSessionId,
} from '../../src/utils/device-sync/frames';
import { generateSealKey } from '../../src/utils/device-sync/seal';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const payload = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 7 + 11) % 256);

const collectAll = (frames: Uint8Array[]) => {
  const collector = new FrameCollector();
  let last;
  for (const frame of frames) last = collector.accept(frame);
  return { collector, last };
};

describe('device-sync frames', () => {
  it('puts a small payload in a single frame', () => {
    const sealed = payload(200);
    const key = generateSealKey();
    const frames = encodeFrames({ sealed, key });

    expect(frames).toHaveLength(1);
    // base45 turns every PAIR of bytes into 3 characters; a lone trailing byte
    // costs 2, not 3.
    const raw = FRAME_HEADER_BYTES + 200;
    expect(frames[0].length).toBe(Math.floor(raw / 2) * 3 + (raw % 2) * 2);

    const { collector, last } = collectAll(frames);
    expect(last?.complete).toBe(true);
    expect(collector.assemble().sealed).toEqual(sealed);
    expect(collector.assemble().key).toEqual(key);
  });

  it('round-trips a payload that needs many frames', () => {
    const sealed = payload(DEFAULT_CHUNK_BYTES * 4 + 137);
    const key = generateSealKey();
    const frames = encodeFrames({ sealed, key });

    expect(frames).toHaveLength(5);
    expect(collectAll(frames).collector.assemble().sealed).toEqual(sealed);
  });

  it('reassembles frames arriving out of order', () => {
    const sealed = payload(DEFAULT_CHUNK_BYTES * 3 + 1);
    const key = generateSealKey();
    const frames = encodeFrames({ sealed, key });

    const shuffled = [frames[2], frames[0], frames[3], frames[1]];
    expect(collectAll(shuffled).collector.assemble().sealed).toEqual(sealed);
  });

  it('survives the same frames cycling repeatedly', () => {
    const sealed = payload(DEFAULT_CHUNK_BYTES * 2);
    const key = generateSealKey();
    const frames = encodeFrames({ sealed, key });

    const collector = new FrameCollector();
    collector.accept(frames[0]);
    const repeat = collector.accept(frames[0]);

    expect(repeat.accepted).toBe(false);
    expect(repeat.received).toBe(1);
    expect(repeat.complete).toBe(false);

    collector.accept(frames[1]);
    expect(collector.complete).toBe(true);
    expect(collector.assemble().sealed).toEqual(sealed);
  });

  it('reports which frames are still missing', () => {
    const sealed = payload(DEFAULT_CHUNK_BYTES * 3);
    const frames = encodeFrames({ sealed, key: generateSealKey() });

    const collector = new FrameCollector();
    collector.accept(frames[1]);

    expect(collector.missing).toEqual([0, 2]);
    expect(collector.progress).toEqual({ received: 1, total: 3 });
  });

  it('ignores QR codes that are not ours', () => {
    const collector = new FrameCollector();

    for (const foreign of [
      'WIFI:S:CoffeeShop;T:WPA;P:latte123;;',
      'https://example.com',
      '',
      'FE1', // our magic, but nowhere near a full header
      'not base45 lowercase',
    ]) {
      expect(decodeFrame(foreign)).toBeNull();
      expect(collector.accept(foreign).accepted).toBe(false);
    }
    expect(collector.progress).toEqual({ received: 0, total: 0 });
  });

  it('discards progress when a different pairing session appears', () => {
    // The user hit Regenerate on the desktop mid-scan. Blending chunks from two
    // payloads would produce ciphertext that fails to open with no explanation.
    const key = generateSealKey();
    const first = encodeFrames({
      sealed: payload(DEFAULT_CHUNK_BYTES * 3),
      key,
      sessionId: newSessionId(),
    });
    const secondSealed = payload(DEFAULT_CHUNK_BYTES * 2);
    const second = encodeFrames({ sealed: secondSealed, key, sessionId: newSessionId() });

    const collector = new FrameCollector();
    collector.accept(first[0]);
    collector.accept(first[1]);

    const crossover = collector.accept(second[0]);
    expect(crossover.restarted).toBe(true);
    expect(crossover.received).toBe(1);
    expect(crossover.total).toBe(2);

    collector.accept(second[1]);
    expect(collector.assemble().sealed).toEqual(secondSealed);
  });

  it('refuses to assemble before every frame has arrived', () => {
    const frames = encodeFrames({
      sealed: payload(DEFAULT_CHUNK_BYTES * 2),
      key: generateSealKey(),
    });
    const collector = new FrameCollector();
    collector.accept(frames[0]);

    expect(() => collector.assemble()).toThrow(/incomplete/i);
  });

  it('emits only characters the QR alphanumeric mode can encode', () => {
    const frames = encodeFrames({ sealed: payload(700), key: generateSealKey() });
    // Anything outside this set forces the encoder into byte mode and costs a
    // larger symbol; anything non-ASCII would not survive a scanner that
    // returns a string.
    for (const frame of frames) expect(frame).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  });

  it('carries the seal key on every frame so no single one is mandatory', () => {
    const key = generateSealKey();
    const frames = encodeFrames({ sealed: payload(DEFAULT_CHUNK_BYTES * 3), key });

    for (const frame of frames) {
      expect(decodeFrame(frame)!.key).toEqual(key);
    }
  });

  it('keeps an RSA-4096-sized bundle to a scannable number of frames', () => {
    // A 4096-bit private key is ~3.2KB armored, and sealing adds a little.
    const frames = encodeFrames({ sealed: payload(3400), key: generateSealKey() });

    expect(frames.length).toBeLessThanOrEqual(6);
    // Every frame must stay inside what a phone can lock onto off a laptop
    // screen. Measured: a 644-byte frame is exactly a version 20 symbol at
    // error-correction level M, in alphanumeric mode, same as byte mode.
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(1000);
  });

  it('carries the pairing-code flag and the salt through a round trip', () => {
    const key = generateSealKey();
    const sessionId = newSessionId();

    const plain = encodeFrames({ sealed: payload(300), key, sessionId });
    expect(decodeFrame(plain[0])!.codeProtected).toBe(false);

    const protectedFrames = encodeFrames({
      sealed: payload(300),
      key,
      sessionId,
      codeProtected: true,
    });
    const decoded = decodeFrame(protectedFrames[0])!;
    expect(decoded.codeProtected).toBe(true);
    // The session id doubles as the pairing-code KDF salt, so it has to survive
    // intact rather than only as a session label.
    expect(decoded.sessionSalt).toEqual(sessionId);
    expect(decoded.sessionSalt).toHaveLength(16);
  });

  it('reports code protection to the collector before assembly completes', () => {
    const frames = encodeFrames({
      sealed: payload(DEFAULT_CHUNK_BYTES * 2),
      key: generateSealKey(),
      codeProtected: true,
    });
    const collector = new FrameCollector();
    collector.accept(frames[0]);

    // The scanner needs to know a code is required from the FIRST frame, so it
    // can stop the camera and prompt rather than waiting for every chunk.
    expect(collector.requiresPairingCode).toBe(true);
  });

  it('refuses a payload too large to animate', () => {
    expect(() =>
      encodeFrames({
        sealed: payload(DEFAULT_CHUNK_BYTES * (MAX_FRAMES + 1)),
        key: generateSealKey(),
      }),
    ).toThrow(/frames/i);
  });
});
