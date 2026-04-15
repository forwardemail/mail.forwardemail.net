import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { redact, hashEmail, fnv1a32, REDACTION_VERSION } from '../../src/utils/redaction';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../fixtures/redaction-cases.json');
const fixture: {
  version: number;
  cases: { name: string; input: string; expected: string }[];
} = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('redaction — fixture parity (shared with Rust)', () => {
  it('fixture version matches module version', () => {
    expect(fixture.version).toBe(REDACTION_VERSION);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(redact(c.input)).toBe(c.expected);
    });
  }
});

describe('redact — non-string inputs', () => {
  it('returns empty string for undefined', () => {
    expect(redact(undefined)).toBe('');
  });
  it('returns empty string for null', () => {
    expect(redact(null)).toBe('');
  });
  it('returns empty string for empty string', () => {
    expect(redact('')).toBe('');
  });
});

describe('fnv1a32 / hashEmail', () => {
  it('produces stable 8-char hex for known inputs', () => {
    expect(hashEmail('user@example.com')).toBe('ddaa05fb');
    expect(hashEmail('shaun@forwardemail.net')).toBe('3192f268');
  });
  it('is case-insensitive', () => {
    expect(hashEmail('Alice@Example.COM')).toBe(hashEmail('alice@example.com'));
  });
  it('zero-pads short hashes to 8 chars', () => {
    const h = hashEmail('a@b.io');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
  it('returns a 32-bit unsigned integer', () => {
    const h = fnv1a32('arbitrary string');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
