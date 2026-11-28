import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

import {
  basicCredential,
  buildAliasAuthHeader,
  buildApiKeyAuthHeader,
  getAuthHeader,
} from '../../src/utils/auth.ts';
import { Local } from '../../src/utils/storage';

beforeEach(() => {
  vi.mocked(Local.get).mockReset();
});

describe('buildAliasAuthHeader', () => {
  it('returns Basic header for valid aliasAuth', () => {
    const result = buildAliasAuthHeader('user:pass');
    expect(result).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('returns empty string for null/undefined', () => {
    expect(buildAliasAuthHeader(null)).toBe('');
    expect(buildAliasAuthHeader(undefined)).toBe('');
  });

  it('throws when required and no aliasAuth', () => {
    expect(() => buildAliasAuthHeader(null, { required: true })).toThrow('Authorization required');
  });

  it('rejects encrypted alias_auth blobs', () => {
    // Encrypted values start with \x00ENC\x01 — they should be treated as missing
    const encrypted = '\x00ENC\x01someciphertext';
    expect(buildAliasAuthHeader(encrypted)).toBe('');
  });

  it('throws when required and alias_auth is encrypted', () => {
    const encrypted = '\x00ENC\x01someciphertext';
    expect(() => buildAliasAuthHeader(encrypted, { required: true })).toThrow(
      'Authorization required',
    );
  });

  it('rejects alias_auth without colon separator', () => {
    // alias_auth must be "email:password" — a value without colon is corrupt
    expect(buildAliasAuthHeader('no-colon-here')).toBe('');
  });
});

describe('buildApiKeyAuthHeader', () => {
  it('returns Basic header with key:colon format', () => {
    const result = buildApiKeyAuthHeader('my-api-key');
    expect(result).toBe(`Basic ${btoa('my-api-key:')}`);
  });

  it('returns empty string for null/undefined', () => {
    expect(buildApiKeyAuthHeader(null)).toBe('');
    expect(buildApiKeyAuthHeader(undefined)).toBe('');
  });

  it('rejects encrypted api_key blobs', () => {
    const encrypted = '\x00ENC\x01someciphertext';
    expect(buildApiKeyAuthHeader(encrypted)).toBe('');
  });
});

describe('getAuthHeader', () => {
  it('uses aliasAuth when available', () => {
    vi.mocked(Local.get).mockImplementation((key) => (key === 'alias_auth' ? 'user:pass' : null));
    const result = getAuthHeader();
    expect(result).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('falls back to apiKey when no aliasAuth', () => {
    vi.mocked(Local.get).mockImplementation((key) => (key === 'api_key' ? 'my-key' : null));
    const result = getAuthHeader();
    expect(result).toBe(`Basic ${btoa('my-key:')}`);
  });

  it('skips apiKey when allowApiKey is false', () => {
    vi.mocked(Local.get).mockImplementation((key) => (key === 'api_key' ? 'my-key' : null));
    const result = getAuthHeader({ allowApiKey: false });
    expect(result).toBe('');
  });

  it('throws when required and no auth available', () => {
    vi.mocked(Local.get).mockReturnValue(null);
    expect(() => getAuthHeader({ required: true })).toThrow('Authorization required');
  });

  it('returns empty when nothing available and not required', () => {
    vi.mocked(Local.get).mockReturnValue(null);
    expect(getAuthHeader()).toBe('');
  });

  it('treats encrypted alias_auth as missing and falls back to apiKey', () => {
    vi.mocked(Local.get).mockImplementation((key) => {
      if (key === 'alias_auth') return '\x00ENC\x01encrypted-blob';
      if (key === 'api_key') return 'fallback-key';
      return null;
    });
    const result = getAuthHeader();
    expect(result).toBe(`Basic ${btoa('fallback-key:')}`);
  });

  it('treats encrypted alias_auth and encrypted apiKey both as missing', () => {
    vi.mocked(Local.get).mockImplementation((key) => {
      if (key === 'alias_auth') return '\x00ENC\x01encrypted-alias';
      if (key === 'api_key') return '\x00ENC\x01encrypted-key';
      return null;
    });
    expect(getAuthHeader()).toBe('');
  });

  it('throws when required and all credentials are encrypted', () => {
    vi.mocked(Local.get).mockImplementation((key) => {
      if (key === 'alias_auth') return '\x00ENC\x01encrypted-alias';
      if (key === 'api_key') return '\x00ENC\x01encrypted-key';
      return null;
    });
    expect(() => getAuthHeader({ required: true })).toThrow('Authorization required');
  });

  it('rejects alias_auth without colon and falls back to apiKey', () => {
    vi.mocked(Local.get).mockImplementation((key) => {
      if (key === 'alias_auth') return 'corrupt-no-colon';
      if (key === 'api_key') return 'good-key';
      return null;
    });
    const result = getAuthHeader();
    expect(result).toBe(`Basic ${btoa('good-key:')}`);
  });
});

// What the API does with the header: base64 to bytes, bytes read as UTF-8.
const readAsServer = (header) =>
  new TextDecoder('utf-8').decode(
    Uint8Array.from(atob(header.replace(/^Basic /, '')), (c) => c.charCodeAt(0)),
  );

describe('credentials that are not ASCII', () => {
  it('sends an address at an internationalized domain as the server reads it', () => {
    // mail.forwardemail.net issue #154: the "æ" arrived as U+FFFD and the
    // domain was looked up as xn--prstehaven-6k10d.dk
    const header = buildAliasAuthHeader('user@præstehaven.dk:secret');
    expect(readAsServer(header)).toBe('user@præstehaven.dk:secret');
    expect(readAsServer(header)).not.toContain('\uFFFD');
  });

  it('sends a domain outside Latin-1, which used to throw', () => {
    const header = buildAliasAuthHeader('user@日本語.jp:secret');
    expect(readAsServer(header)).toBe('user@日本語.jp:secret');
  });

  it('sends a password with accents and emoji', () => {
    const header = buildAliasAuthHeader('user@example.com:pässwörd🔑');
    expect(readAsServer(header)).toBe('user@example.com:pässwörd🔑');
  });

  it('leaves an ASCII credential exactly as it was', () => {
    expect(basicCredential('user@example.com:abc123XYZ')).toBe(btoa('user@example.com:abc123XYZ'));
  });
});
