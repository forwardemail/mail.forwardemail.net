import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

import {
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
});
