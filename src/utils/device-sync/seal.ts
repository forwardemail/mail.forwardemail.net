/**
 * Sealing and opening the device-pairing bundle.
 *
 * AES-256-GCM through WebCrypto, matching db-crypto.ts rather than the
 * libsodium path in crypto-store.js. Three reasons: the scanner screen on a
 * phone should not pull in libsodium to open a single payload, WebCrypto is
 * already a hard requirement of the cache layer so it costs nothing new, and
 * it behaves in every context this code runs in.
 *
 * Sealed layout:
 *   iv (12 bytes) || ciphertext || tag
 *
 * The plaintext under that is one format byte followed by the bundle JSON,
 * optionally deflate-raw compressed. The byte exists so a sender without
 * CompressionStream still produces something every reader can open.
 *
 * Note on PGP keys and compression: an earlier draft de-armored keys to raw
 * binary before sealing to dodge base64's 33% expansion. Measured against
 * deflate it is not worth the extra failure mode - deflate over base64 text
 * recovers almost exactly the same 6-bits-per-8 that de-armoring would, so an
 * RSA-4096 key lands within a few percent either way. Keys travel armored.
 */
import type { DeviceSyncBundle } from './types';

const IV_BYTES = 12;
export const SEAL_KEY_BYTES = 32;

export const FORMAT_JSON = 0x01;
export const FORMAT_JSON_DEFLATE = 0x02;

export const BUNDLE_VERSION = 1;
export const DEFAULT_TTL_SECONDS = 180;

export type DeviceSyncErrorCode =
  | 'NO_CRYPTO'
  | 'BAD_FORMAT'
  | 'BAD_KEY'
  | 'EXPIRED'
  | 'UNSUPPORTED_VERSION';

export class DeviceSyncError extends Error {
  code: DeviceSyncErrorCode;

  constructor(code: DeviceSyncErrorCode, message: string) {
    super(message);
    this.name = 'DeviceSyncError';
    this.code = code;
  }
}

const getCrypto = (): Crypto => {
  const value = globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new DeviceSyncError('NO_CRYPTO', 'WebCrypto is unavailable in this context');
  }
  return value;
};

export const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const randomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length);
  getCrypto().getRandomValues(out);
  return out;
};

export const generateSealKey = (): Uint8Array => randomBytes(SEAL_KEY_BYTES);

const hasCompressionStream = (): boolean =>
  typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function' &&
  typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';

type ByteStream = { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };

async function pumpStream(bytes: Uint8Array, stream: ByteStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Writes are not awaited before the reader below starts draining, so a
  // payload larger than the stream's internal queue cannot stall here.
  void writer.write(bytes).catch(() => {});
  void writer.close().catch(() => {});

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concatBytes(chunks);
}

const deflateRaw = (bytes: Uint8Array): Promise<Uint8Array> =>
  pumpStream(bytes, new CompressionStream('deflate-raw') as unknown as ByteStream);

const inflateRaw = (bytes: Uint8Array): Promise<Uint8Array> =>
  pumpStream(bytes, new DecompressionStream('deflate-raw') as unknown as ByteStream);

const importKey = (key: Uint8Array): Promise<CryptoKey> => {
  if (!(key instanceof Uint8Array) || key.length !== SEAL_KEY_BYTES) {
    throw new DeviceSyncError('BAD_KEY', `Seal key must be ${SEAL_KEY_BYTES} bytes`);
  }
  return getCrypto().subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
};

/**
 * Build the plaintext body: format byte + (optionally deflated) JSON.
 * Compression is skipped when it does not actually help, which is the common
 * case for a settings-only bundle small enough to fit one frame anyway.
 */
async function packPlaintext(bundle: DeviceSyncBundle): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(bundle));

  if (hasCompressionStream()) {
    try {
      const deflated = await deflateRaw(json);
      if (deflated.length < json.length) {
        return concatBytes([Uint8Array.of(FORMAT_JSON_DEFLATE), deflated]);
      }
    } catch {
      // Fall through to the uncompressed encoding; a bigger payload only costs
      // extra frames, while failing the export outright costs the feature.
    }
  }

  return concatBytes([Uint8Array.of(FORMAT_JSON), json]);
}

async function unpackPlaintext(plaintext: Uint8Array): Promise<unknown> {
  if (plaintext.length < 2) {
    throw new DeviceSyncError('BAD_FORMAT', 'Sealed payload is truncated');
  }

  const format = plaintext[0];
  const body = plaintext.subarray(1);

  let json: Uint8Array;
  if (format === FORMAT_JSON) {
    json = body;
  } else if (format === FORMAT_JSON_DEFLATE) {
    if (!hasCompressionStream()) {
      throw new DeviceSyncError(
        'BAD_FORMAT',
        'Pairing code is compressed but this device cannot decompress it',
      );
    }
    try {
      json = await inflateRaw(body);
    } catch {
      throw new DeviceSyncError('BAD_FORMAT', 'Pairing code payload could not be decompressed');
    }
  } else {
    throw new DeviceSyncError('BAD_FORMAT', `Unknown payload format 0x${format.toString(16)}`);
  }

  try {
    return JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new DeviceSyncError('BAD_FORMAT', 'Pairing code payload is not valid JSON');
  }
}

function assertBundleShape(value: unknown): asserts value is DeviceSyncBundle {
  const bundle = value as DeviceSyncBundle | null;
  if (!bundle || typeof bundle !== 'object') {
    throw new DeviceSyncError('BAD_FORMAT', 'Pairing payload is not an object');
  }
  if (bundle.v !== BUNDLE_VERSION) {
    throw new DeviceSyncError(
      'UNSUPPORTED_VERSION',
      `This pairing code was made by a newer version of the app (format ${String(bundle.v)})`,
    );
  }
  if (typeof bundle.exp !== 'number' || !Number.isFinite(bundle.exp)) {
    throw new DeviceSyncError('BAD_FORMAT', 'Pairing payload has no expiry');
  }
}

export async function sealBundle(
  bundle: DeviceSyncBundle,
  options: { key?: Uint8Array } = {},
): Promise<{ key: Uint8Array; sealed: Uint8Array }> {
  const key = options.key ?? generateSealKey();
  const cryptoKey = await importKey(key);
  const iv = randomBytes(IV_BYTES);
  const plaintext = await packPlaintext(bundle);

  const ciphertext = new Uint8Array(
    await getCrypto().subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext),
  );

  return { key, sealed: concatBytes([iv, ciphertext]) };
}

/**
 * Open a sealed bundle. Expiry is enforced here rather than left to the UI so
 * that every caller - scanner, tests, a future relay path - fails the same way
 * on a stale code.
 */
export async function openSealedBundle(
  sealed: Uint8Array,
  key: Uint8Array,
  options: { now?: number; ignoreExpiry?: boolean } = {},
): Promise<DeviceSyncBundle> {
  if (!(sealed instanceof Uint8Array) || sealed.length <= IV_BYTES) {
    throw new DeviceSyncError('BAD_FORMAT', 'Sealed payload is truncated');
  }

  const cryptoKey = await importKey(key);
  const iv = sealed.subarray(0, IV_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES);

  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await getCrypto().subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext),
    );
  } catch {
    // AES-GCM authenticates, so this covers both a wrong key and a tampered or
    // misread payload. They are indistinguishable and the user response to
    // both is the same: scan again.
    throw new DeviceSyncError('BAD_KEY', 'Pairing code could not be decrypted');
  }

  const parsed = await unpackPlaintext(plaintext);
  assertBundleShape(parsed);

  if (!options.ignoreExpiry) {
    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
    if (nowSeconds > parsed.exp) {
      throw new DeviceSyncError('EXPIRED', 'This pairing code has expired');
    }
  }

  return parsed;
}
