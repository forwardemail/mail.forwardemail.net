/**
 * Signing in to another account ("add account") while one is signed in: the
 * credential check goes through the real Remote.request, and its failures
 * belong to the account being signed in, not to the signed-in session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({ config: { apiBase: 'https://api.example.com' } }));
vi.mock('../../src/utils/error-logger.ts', () => ({ logApiError: vi.fn() }));
vi.mock('../../src/utils/perf-logger.ts', () => ({ logPerfEvent: vi.fn() }));
vi.mock('../../src/utils/demo-mode', () => ({
  interceptDemoRequest: vi.fn(() => ({ handled: false })),
  isDemoMode: vi.fn(() => false),
  cleanupDemoAccount: vi.fn(),
}));
vi.mock('../../src/utils/db', () => ({
  db: {
    meta: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../src/utils/crypto-store.js', () => ({
  isSensitiveLocalKey: () => false,
  isVaultLocked: () => false,
  protectLocalValue: (_key, value) => value,
  revealLocalValue: (value) => value,
}));

const { Local } = await import('../../src/utils/storage.js');
const { buildAliasAuthHeader } = await import('../../src/utils/auth.ts');
const { Remote } = await import('../../src/utils/remote.js');
const { signInWithAliasPassword } = await import('../../src/utils/alias-sign-in.ts');

const ACTIVE = 'me@example.com:right-password';
const ACTIVE_HEADER = buildAliasAuthHeader(ACTIVE);

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

// The signed-in account always works; `otherResponse` answers everyone else.
let otherResponse;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Local.set('email', 'me@example.com');
  Local.set('alias_auth', ACTIVE);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request) =>
      request.headers.get('authorization') === ACTIVE_HEADER
        ? json(200, [{ path: 'INBOX' }])
        : otherResponse(),
    ),
  );
});

describe('signInWithAliasPassword while another account is signed in', () => {
  it('does not end the signed-in session on wrong passwords', async () => {
    otherResponse = () => json(401, { message: 'Invalid password' });
    const expired = vi.fn();
    window.addEventListener('fe:auth-expired', expired);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        signInWithAliasPassword('other@example.com', 'wrong', { staySignedIn: true }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    window.removeEventListener('fe:auth-expired', expired);

    expect(expired).not.toHaveBeenCalled();
    expect(Local.get('alias_auth')).toBe(ACTIVE);
  });

  it("keeps a sign-in's 429 to that sign-in and shows the server's message", async () => {
    otherResponse = () =>
      json(429, { message: 'Too many failed attempts' }, { 'Retry-After': '900' });

    await expect(
      signInWithAliasPassword('other@example.com', 'wrong', { staySignedIn: true }),
    ).rejects.toMatchObject({ status: 429, message: 'Too many failed attempts' });

    // the signed-in account's loads are not held back
    await expect(Remote.request('MessageList', { folder: 'INBOX' })).resolves.toEqual([
      { path: 'INBOX' },
    ]);
    // and the next attempt reaches the server instead of failing locally
    await expect(
      signInWithAliasPassword('other@example.com', 'wrong', { staySignedIn: true }),
    ).rejects.toMatchObject({ status: 429, message: 'Too many failed attempts' });
  });
});
