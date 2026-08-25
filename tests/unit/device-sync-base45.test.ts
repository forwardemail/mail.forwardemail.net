/**
 * base45 codec (RFC 9285).
 *
 * Frames go through this so a scanner that returns a string rather than bytes
 * round-trips them intact. The decoder is fed whatever drifts through a camera
 * viewfinder, so rejecting junk cleanly matters as much as encoding correctly.
 */
import { describe, expect, it } from 'vitest';
import { decodeBase45, encodeBase45 } from '../../src/utils/device-sync/base45';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('base45', () => {
  it('matches the RFC 9285 test vectors', () => {
    expect(encodeBase45(new TextEncoder().encode('AB'))).toBe('BB8');
    expect(encodeBase45(new TextEncoder().encode('Hello!!'))).toBe('%69 VD92EX0');
    expect(encodeBase45(new TextEncoder().encode('base-45'))).toBe('UJCLQE7W581');
  });

  it('decodes the RFC 9285 test vectors', () => {
    const decode = (text: string) => new TextDecoder().decode(decodeBase45(text)!);

    expect(decode('BB8')).toBe('AB');
    expect(decode('%69 VD92EX0')).toBe('Hello!!');
    expect(decode('UJCLQE7W581')).toBe('base-45');
  });

  it('round-trips every byte value at both parities', () => {
    const even = Uint8Array.from({ length: 256 }, (_, i) => i);
    const odd = Uint8Array.from({ length: 255 }, (_, i) => i);

    expect(decodeBase45(encodeBase45(even))).toEqual(even);
    expect(decodeBase45(encodeBase45(odd))).toEqual(odd);
  });

  it('round-trips an empty payload', () => {
    expect(encodeBase45(bytes())).toBe('');
    expect(decodeBase45('')).toEqual(bytes());
  });

  it('rejects characters outside the alphabet', () => {
    // Lowercase is the common case: a decoder that normalised case, or an
    // unrelated QR carrying a URL.
    expect(decodeBase45('bb8')).toBeNull();
    expect(decodeBase45('https://example.com')).toBeNull();
    expect(decodeBase45('BB8!')).toBeNull();
  });

  it('rejects a lone trailing character, which encodes nothing', () => {
    expect(decodeBase45('BB8B')).toBeNull();
  });

  it('rejects triples that overflow two bytes', () => {
    // Three characters can carry up to 91124, well past what two bytes hold,
    // so everything above 0xffff has to be refused rather than wrapped.
    expect(decodeBase45('FGW')).toEqual(bytes(0xff, 0xff));
    expect(decodeBase45('GGW')).toBeNull();
  });

  it('rejects a pair that overflows one byte', () => {
    expect(decodeBase45('U5')).toEqual(bytes(0xff));
    expect(decodeBase45('V5')).toBeNull();
  });

  it('costs three characters per two bytes', () => {
    expect(encodeBase45(new Uint8Array(600))).toHaveLength(900);
    expect(encodeBase45(new Uint8Array(601))).toHaveLength(902);
  });
});
