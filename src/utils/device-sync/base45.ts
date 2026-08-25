/**
 * base45 (RFC 9285) for QR frame payloads.
 *
 * Why not raw byte-mode QR: every decoder we might use on the scanning side
 * hands back a string, not bytes. The Shape Detection API's DetectedBarcode
 * exposes `rawValue` as a DOMString, so binary frames come back mangled
 * through a UTF-8 decode. base45's alphabet is exactly the QR alphanumeric
 * charset, which is the entire reason the encoding exists.
 *
 * It costs nothing. Alphanumeric mode packs two characters into 11 bits, and
 * base45 turns two bytes into three characters - 16 bits of input for 16.5 bits
 * of QR capacity, about 3% over byte mode's 16. Measured at our 600-byte chunk
 * size both encodings land on the same version 20 symbol.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const REVERSE = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) REVERSE.set(ALPHABET[i], i);

export function encodeBase45(bytes: Uint8Array): string {
  let out = '';

  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const value = bytes[i] * 256 + bytes[i + 1];
      out +=
        ALPHABET[value % 45] +
        ALPHABET[Math.floor(value / 45) % 45] +
        ALPHABET[Math.floor(value / 2025)];
    } else {
      const value = bytes[i];
      out += ALPHABET[value % 45] + ALPHABET[Math.floor(value / 45)];
    }
  }

  return out;
}

/**
 * Returns null for anything that is not valid base45 rather than throwing:
 * the caller is a scan loop being fed whatever drifts through the viewfinder,
 * and an unrelated QR code is an ordinary event, not an error.
 */
export function decodeBase45(text: string): Uint8Array | null {
  if (typeof text !== 'string') return null;

  const remainder = text.length % 3;
  // A single trailing character cannot encode anything; RFC 9285 §6 rejects it.
  if (remainder === 1) return null;

  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (remainder === 2 ? 1 : 0));
  let offset = 0;

  for (let i = 0; i < text.length; i += 3) {
    const chunk = text.length - i >= 3 ? 3 : 2;

    let value = 0;
    for (let j = 0; j < chunk; j += 1) {
      const digit = REVERSE.get(text[i + j]);
      if (digit === undefined) return null;
      value += digit * 45 ** j;
    }

    if (chunk === 3) {
      if (value > 0xffff) return null;
      out[offset] = value >> 8;
      out[offset + 1] = value & 0xff;
      offset += 2;
    } else {
      if (value > 0xff) return null;
      out[offset] = value;
      offset += 1;
    }
  }

  return out;
}
