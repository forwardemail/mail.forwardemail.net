/**
 * Splitting a sealed bundle across one or more QR frames, and collecting them
 * back on the scanning side.
 *
 * A single static code is just the one-frame case of this, so the sender and
 * the scanner have exactly one code path regardless of payload size. Anything
 * that does not fit becomes an animated code the scanner watches until it has
 * every chunk.
 *
 * Frame layout (57-byte header, then chunk data):
 *   0..2    magic 'FE1'
 *   3       format version
 *   4       flags (bit 0: key material is wrapped with a pairing code)
 *   5..20   session id (16 bytes), which doubles as the pairing-code KDF salt
 *   21..52  key material (32 bytes)
 *   53..54  seq   (uint16 big-endian)
 *   55..56  total (uint16 big-endian)
 *
 * The key material rides in every frame rather than only the first. At a
 * 600-byte chunk that is about 5% overhead, and it buys the property that any
 * single frame bootstraps decryption once the rest arrive - no "you missed
 * frame 0, start over".
 *
 * When the pairing-code flag is set the key slot holds the seal key XORed with
 * an Argon2id hash of the code, so the frames alone cannot open the payload.
 * The session id serves as that hash's salt: it is already random per session
 * and already in every frame, so carrying a separate salt would be redundant.
 *
 * Frames are base45-encoded before they reach the QR encoder so that a scanner
 * returning a string rather than bytes (BarcodeDetector.rawValue is a DOMString)
 * round-trips them intact. See base45.ts - at this chunk size it costs nothing.
 *
 * Chunks are plain indexed slices cycled round-robin, not a fountain code. A
 * missed frame simply comes back on the next pass, and indexed chunks are far
 * easier to reason about when a scan misbehaves in the field.
 */
import { decodeBase45, encodeBase45 } from './base45';
import { SEAL_KEY_BYTES, concatBytes, randomBytes } from './seal';

const MAGIC = Uint8Array.of(0x46, 0x45, 0x31); // 'FE1'
const FRAME_VERSION = 2;

export const FLAG_CODE_PROTECTED = 0x01;

const OFFSET_VERSION = 3;
const OFFSET_FLAGS = 4;
const OFFSET_SESSION = 5;
export const SESSION_ID_BYTES = 16;
const OFFSET_KEY = OFFSET_SESSION + SESSION_ID_BYTES;
const OFFSET_SEQ = OFFSET_KEY + SEAL_KEY_BYTES;
const OFFSET_TOTAL = OFFSET_SEQ + 2;

export const FRAME_HEADER_BYTES = OFFSET_TOTAL + 2;

/**
 * Chunk payload size, picked so a whole frame lands on a version 20 QR at
 * error-correction level M - 97 modules, the density measured at a 60% decode
 * rate on a real phone off a laptop screen.
 *
 * 580 rather than a rounder number because the 57-byte header has to fit
 * inside the same symbol: 580 + 57 = 637 bytes, which base45-encodes to 957
 * characters and just fits version 20's alphanumeric capacity. Raising it to
 * 600 tips the symbol to version 21 and quietly costs scan reliability.
 */
export const DEFAULT_CHUNK_BYTES = 580;

/**
 * Refuse to animate beyond this. 256 frames at 600 bytes is a ~150KB bundle;
 * anything that large means something unexpected went in (a profile image, a
 * runaway saved-search list) and a wall of QR frames is not the answer.
 */
export const MAX_FRAMES = 256;

export type DecodedFrame = {
  sessionId: string;
  /** Raw 16-byte session id, used as the pairing-code KDF salt. */
  sessionSalt: Uint8Array;
  /** The seal key, or the wrapped key when codeProtected is true. */
  key: Uint8Array;
  codeProtected: boolean;
  seq: number;
  total: number;
  chunk: Uint8Array;
};

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const newSessionId = (): Uint8Array => randomBytes(SESSION_ID_BYTES);

export function encodeFrames(options: {
  sealed: Uint8Array;
  /** Seal key, or the pairing-code-wrapped key when codeProtected is set. */
  key: Uint8Array;
  sessionId?: Uint8Array;
  chunkBytes?: number;
  codeProtected?: boolean;
}): string[] {
  const { sealed, key } = options;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const sessionId = options.sessionId ?? newSessionId();

  if (key.length !== SEAL_KEY_BYTES) {
    throw new Error(`Seal key must be ${SEAL_KEY_BYTES} bytes`);
  }
  if (sessionId.length !== SESSION_ID_BYTES) {
    throw new Error(`Session id must be ${SESSION_ID_BYTES} bytes`);
  }
  if (chunkBytes < 1) {
    throw new Error('Chunk size must be positive');
  }

  const total = Math.max(1, Math.ceil(sealed.length / chunkBytes));
  if (total > MAX_FRAMES) {
    throw new Error(`Pairing payload needs ${total} frames, more than the ${MAX_FRAMES} limit`);
  }

  const frames: string[] = [];
  for (let seq = 0; seq < total; seq += 1) {
    const chunk = sealed.subarray(seq * chunkBytes, (seq + 1) * chunkBytes);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + chunk.length);
    frame.set(MAGIC, 0);
    frame[OFFSET_VERSION] = FRAME_VERSION;
    frame[OFFSET_FLAGS] = options.codeProtected ? FLAG_CODE_PROTECTED : 0;
    frame.set(sessionId, OFFSET_SESSION);
    frame.set(key, OFFSET_KEY);
    frame[OFFSET_SEQ] = (seq >> 8) & 0xff;
    frame[OFFSET_SEQ + 1] = seq & 0xff;
    frame[OFFSET_TOTAL] = (total >> 8) & 0xff;
    frame[OFFSET_TOTAL + 1] = total & 0xff;
    frame.set(chunk, FRAME_HEADER_BYTES);
    frames.push(encodeBase45(frame));
  }

  return frames;
}

/**
 * Parse one scanned frame. Returns null rather than throwing for anything that
 * simply is not one of our frames - a camera pointed at a wifi QR should be
 * ignored quietly, not surfaced as an error.
 */
export function decodeFrame(text: string | null | undefined): DecodedFrame | null {
  if (!text) return null;
  const bytes = decodeBase45(text);
  if (!bytes || bytes.length <= FRAME_HEADER_BYTES) return null;
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) return null;
  if (bytes[OFFSET_VERSION] !== FRAME_VERSION) return null;

  const seq = (bytes[OFFSET_SEQ] << 8) | bytes[OFFSET_SEQ + 1];
  const total = (bytes[OFFSET_TOTAL] << 8) | bytes[OFFSET_TOTAL + 1];
  if (total < 1 || total > MAX_FRAMES || seq >= total) return null;

  const sessionSalt = bytes.slice(OFFSET_SESSION, OFFSET_SESSION + SESSION_ID_BYTES);
  return {
    sessionId: bytesToHex(sessionSalt),
    sessionSalt,
    key: bytes.slice(OFFSET_KEY, OFFSET_KEY + SEAL_KEY_BYTES),
    codeProtected: (bytes[OFFSET_FLAGS] & FLAG_CODE_PROTECTED) !== 0,
    seq,
    total,
    chunk: bytes.slice(FRAME_HEADER_BYTES),
  };
}

export type FrameAcceptResult = {
  /** False when the frame was not ours, or was a duplicate of one already held. */
  accepted: boolean;
  /** True when a different pairing session appeared and progress was discarded. */
  restarted: boolean;
  received: number;
  total: number;
  complete: boolean;
};

const IGNORED: FrameAcceptResult = Object.freeze({
  accepted: false,
  restarted: false,
  received: 0,
  total: 0,
  complete: false,
});

/**
 * Accumulates frames until every chunk of one session has been seen.
 *
 * Seeing a frame from a different session resets progress instead of mixing
 * the two. That is the "user hit Regenerate on the desktop halfway through"
 * case, and silently blending chunks from two payloads would produce a
 * ciphertext that fails to open with no explanation.
 */
export class FrameCollector {
  private sessionId: string | null = null;
  private total = 0;
  private key: Uint8Array | null = null;
  private sessionSalt: Uint8Array | null = null;
  private codeProtected = false;
  private chunks = new Map<number, Uint8Array>();

  accept(text: string | null | undefined): FrameAcceptResult {
    const frame = decodeFrame(text);
    if (!frame) return IGNORED;

    let restarted = false;
    if (this.sessionId !== frame.sessionId) {
      restarted = this.sessionId !== null;
      this.reset();
      this.sessionId = frame.sessionId;
      this.total = frame.total;
      this.key = frame.key;
      this.sessionSalt = frame.sessionSalt;
      this.codeProtected = frame.codeProtected;
    }

    const isNew = !this.chunks.has(frame.seq);
    if (isNew) this.chunks.set(frame.seq, frame.chunk);

    return {
      accepted: isNew,
      restarted,
      received: this.chunks.size,
      total: this.total,
      complete: this.chunks.size === this.total,
    };
  }

  get complete(): boolean {
    return this.total > 0 && this.chunks.size === this.total;
  }

  get progress(): { received: number; total: number } {
    return { received: this.chunks.size, total: this.total };
  }

  /** Missing sequence numbers, for a "still waiting on 3 of 12" hint. */
  get missing(): number[] {
    const out: number[] = [];
    for (let seq = 0; seq < this.total; seq += 1) {
      if (!this.chunks.has(seq)) out.push(seq);
    }
    return out;
  }

  /** True once any frame has been seen and it declared code protection. */
  get requiresPairingCode(): boolean {
    return this.codeProtected;
  }

  assemble(): {
    sealed: Uint8Array;
    key: Uint8Array;
    sessionSalt: Uint8Array;
    codeProtected: boolean;
  } {
    if (!this.complete || !this.key || !this.sessionSalt) {
      throw new Error('Pairing frames are incomplete');
    }
    const ordered: Uint8Array[] = [];
    for (let seq = 0; seq < this.total; seq += 1) {
      ordered.push(this.chunks.get(seq)!);
    }
    return {
      sealed: concatBytes(ordered),
      key: this.key,
      sessionSalt: this.sessionSalt,
      codeProtected: this.codeProtected,
    };
  }

  reset(): void {
    this.sessionId = null;
    this.total = 0;
    this.key = null;
    this.sessionSalt = null;
    this.codeProtected = false;
    this.chunks = new Map();
  }
}
