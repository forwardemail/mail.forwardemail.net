/**
 * Accounts signed in through their provider's sign-in page. The mail engine
 * (and so the provider) is stood in for; the token handling, the engine
 * bridges and the sign-in helper are the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  setOAuth: vi.fn(),
  add: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: () => null, set: vi.fn(), remove: vi.fn() },
  Session: { get: () => null, set: vi.fn(), remove: vi.fn() },
  Accounts: {
    getAll: () => h.accounts,
    init: vi.fn(),
    add: (...a: unknown[]) => h.add(...a),
    setActive: (...a: unknown[]) => h.setActive(...a),
    setOAuth: (...a: unknown[]) => h.setOAuth(...a),
  },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false }));
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  cleanupDemoAccount: vi.fn(),
}));

import { MailEngineError, setMailEngineForTests } from '../../src/backends/engine-bridge';
import { mailCommand } from '../../src/backends/imap-engine';
import { smtpSend } from '../../src/backends/smtp-engine';
import {
  accessTokenFor,
  forgetAllAccessTokens,
  listOAuthProviders,
  oauthLinkFor,
  rememberAccessToken,
  withCredentials,
} from '../../src/backends/oauth';
import { signInWithOAuth } from '../../src/utils/alias-sign-in';
import { resetMailBackendsForTests } from '../../src/backends';

const ADA = 'ada@gmail.example';
const signIn = { username: ADA, password: '', auth: 'xoauth2' };
const gmail = () => ({
  email: ADA,
  kind: 'imap',
  imap: { host: 'imap.gmail.com', port: 993, security: 'tls', ...signIn },
  smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls', ...signIn },
  oauth: { provider: 'google', refreshToken: 'refresh-1' },
});

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let issued = 0;
let refreshAnswer: (args: Record<string, unknown>) => unknown;
let engine: (cmd: string, args: Record<string, unknown>) => unknown;
const only = (cmd: string) => calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-17T10:00:00Z') });
  h.accounts = [gmail()];
  h.setOAuth.mockReset().mockReturnValue(true);
  h.add.mockReset().mockReturnValue(true);
  h.setActive.mockReset();
  calls = [];
  issued = 0;
  refreshAnswer = () => ({ accessToken: `access-${(issued += 1)}`, expiresIn: 3600 });
  engine = () => null;
  resetMailBackendsForTests();
  setMailEngineForTests(async (cmd, args = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'oauth_refresh') return refreshAnswer(args);
    return engine(cmd, args);
  });
});
afterEach(() => {
  vi.useRealTimers();
  setMailEngineForTests(null);
});

describe('an access token', () => {
  it('is fetched with the saved sign-in and reused until it is about to run out', async () => {
    expect(await accessTokenFor(ADA)).toBe('access-1');
    expect(only('oauth_refresh')[0].args).toEqual({
      provider: 'google',
      refreshToken: 'refresh-1',
    });

    vi.advanceTimersByTime(50 * 60 * 1000);
    expect(await accessTokenFor(ADA)).toBe('access-1');
    expect(only('oauth_refresh')).toHaveLength(1);

    // An hour's token with under two minutes left is not handed out.
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(await accessTokenFor(ADA)).toBe('access-2');
  });

  it('is renewed once when several commands ask at the same moment', async () => {
    const tokens = await Promise.all([
      accessTokenFor(ADA),
      accessTokenFor(ADA),
      accessTokenFor(ADA),
    ]);
    expect(tokens).toEqual(['access-1', 'access-1', 'access-1']);
    expect(only('oauth_refresh')).toHaveLength(1);
  });

  // Microsoft replaces the long-lived token each time it is used.
  it('saves a replaced long-lived token before the new access token is used', async () => {
    refreshAnswer = () => ({ accessToken: 'access-1', refreshToken: 'refresh-2', expiresIn: 3600 });

    await accessTokenFor(ADA);

    expect(h.setOAuth).toHaveBeenCalledWith(ADA, { provider: 'google', refreshToken: 'refresh-2' });
  });

  it('is not handed out when the replaced long-lived token could not be saved', async () => {
    refreshAnswer = () => ({ accessToken: 'access-1', refreshToken: 'refresh-2', expiresIn: 3600 });
    h.setOAuth.mockReturnValue(false);

    await expect(accessTokenFor(ADA)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('is gone from memory when the app locks', async () => {
    await accessTokenFor(ADA);
    forgetAllAccessTokens();
    expect(await accessTokenFor(ADA)).toBe('access-2');
  });

  it('cannot be had for an account with no saved sign-in', async () => {
    h.accounts = [{ ...gmail(), oauth: undefined }];
    expect(oauthLinkFor(ADA)).toBeNull();
    await expect(accessTokenFor(ADA)).rejects.toMatchObject({ kind: 'auth' });
    h.accounts = [{ ...gmail(), oauth: { provider: 'someone-else', refreshToken: 'x' } }];
    expect(oauthLinkFor(ADA)).toBeNull();
  });

  it('goes where the password would be, and a password account is left alone', async () => {
    rememberAccessToken(ADA, { accessToken: 'just-issued', expiresIn: 3600 });
    expect(await withCredentials(ADA, gmail().imap as never)).toMatchObject({
      password: 'just-issued',
      auth: 'xoauth2',
    });
    const plain = {
      host: 'imap.example.org',
      port: 993,
      security: 'tls',
      username: 'a',
      password: 'pw',
    };
    expect(await withCredentials('a@example.org', plain as never)).toBe(plain);
    expect(only('oauth_refresh')).toEqual([]);
  });
});

describe('the mail engine for a token account', () => {
  it('signs in to IMAP with the token', async () => {
    engine = (cmd) => (cmd === 'mail_open' ? 'handle-1' : ['INBOX']);

    await mailCommand(ADA, 'imap_folders');

    expect(only('mail_open')[0].args).toEqual({
      imap: {
        host: 'imap.gmail.com',
        port: 993,
        security: 'tls',
        username: ADA,
        password: 'access-1',
        auth: 'xoauth2',
      },
    });
  });

  it('gets a new token and signs in again when the server refuses an old one', async () => {
    let opens = 0;
    engine = (cmd) => {
      if (cmd === 'mail_open') return `handle-${(opens += 1)}`;
      // The connection dropped and the engine signed in again with the token
      // it was given an hour ago.
      if (cmd === 'imap_folders' && opens === 1)
        throw new MailEngineError('auth', 'Invalid credentials');
      return ['INBOX'];
    };

    expect(await mailCommand(ADA, 'imap_folders')).toEqual(['INBOX']);

    expect(only('mail_open').map((c) => (c.args.imap as { password: string }).password)).toEqual([
      'access-1',
      'access-2',
    ]);
  });

  it('does not retry a refused password, which would only be refused again', async () => {
    h.accounts = [
      {
        email: 'bob@example.org',
        kind: 'imap',
        imap: {
          host: 'imap.example.org',
          port: 993,
          security: 'tls',
          username: 'bob',
          password: 'wrong',
        },
      },
    ];
    engine = (cmd) => {
      if (cmd === 'mail_open') throw new MailEngineError('auth', 'LOGIN failed');
      return null;
    };

    await expect(mailCommand('bob@example.org', 'imap_folders')).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(only('mail_open')).toHaveLength(1);
  });

  it('tells the user to sign in again when the saved sign-in was revoked', async () => {
    refreshAnswer = () => {
      throw new MailEngineError('auth', '400 Token has been expired or revoked.');
    };

    await expect(mailCommand(ADA, 'imap_folders')).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    expect(only('mail_open')).toEqual([]);
  });

  it('sends with the token, and with a new one when the first has run out', async () => {
    let sends = 0;
    engine = (cmd) => {
      if (cmd === 'smtp_open') return `smtp-${only('smtp_open').length}`;
      if (cmd === 'smtp_send' && (sends += 1) === 1)
        throw new MailEngineError('auth', '535 token expired');
      return null;
    };

    await smtpSend(ADA, { from: ADA, recipients: ['bob@example.org'], raw: new Uint8Array([65]) });

    expect(only('smtp_open').map((c) => (c.args.smtp as { password: string }).password)).toEqual([
      'access-1',
      'access-2',
    ]);
    expect(only('smtp_send')).toHaveLength(2);
  });
});

describe('signing in through a provider', () => {
  const answer = {
    accessToken: 'first-access',
    refreshToken: 'refresh-9',
    expiresIn: 3599,
    email: ADA,
  };

  it('checks the mail server with the new token and saves the account with both servers', async () => {
    h.accounts = [];
    engine = (cmd) => (cmd === 'oauth_sign_in' ? answer : null);

    expect(await signInWithOAuth('google', { staySignedIn: true })).toBe(ADA);

    expect(only('oauth_sign_in')[0].args).toEqual({ provider: 'google' });
    expect(only('mail_test')[0].args).toEqual({
      imap: {
        host: 'imap.gmail.com',
        port: 993,
        security: 'tls',
        username: ADA,
        password: 'first-access',
        auth: 'xoauth2',
      },
    });
    // Saved without any token in the server settings: only the long-lived one, apart.
    expect(h.add).toHaveBeenCalledWith(
      ADA,
      {
        kind: 'imap',
        imap: { host: 'imap.gmail.com', port: 993, security: 'tls', ...signIn },
        smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls', ...signIn },
        oauth: { provider: 'google', refreshToken: 'refresh-9' },
      },
      true,
    );
    expect(h.setActive).toHaveBeenCalledWith(ADA);
  });

  it('uses the Microsoft servers for a Microsoft sign-in', async () => {
    engine = (cmd) =>
      cmd === 'oauth_sign_in' ? { ...answer, email: 'ada@outlook.example' } : null;

    await signInWithOAuth('microsoft', { staySignedIn: false });

    expect(h.add.mock.calls[0][1]).toMatchObject({
      imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
      oauth: { provider: 'microsoft' },
    });
  });

  it('saves nothing when the mail server refuses the token', async () => {
    engine = (cmd) => {
      if (cmd === 'oauth_sign_in') return answer;
      if (cmd === 'mail_test')
        throw new MailEngineError('auth', 'IMAP access is disabled for this account');
      return null;
    };

    await expect(signInWithOAuth('google', { staySignedIn: true })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('saves nothing when the provider does not say who signed in', async () => {
    engine = (cmd) => (cmd === 'oauth_sign_in' ? { ...answer, email: null } : null);

    await expect(signInWithOAuth('google', { staySignedIn: true })).rejects.toThrow(
      /which account/,
    );
    expect(only('mail_test')).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('passes on a declined sign-in', async () => {
    engine = (cmd) => {
      if (cmd === 'oauth_sign_in')
        throw new MailEngineError('denied', 'The sign-in was not completed (access_denied)');
      return null;
    };
    await expect(signInWithOAuth('google', { staySignedIn: true })).rejects.toMatchObject({
      kind: 'denied',
    });
  });

  it('offers only the providers the engine knows and this app has servers for', async () => {
    engine = (cmd) => (cmd === 'oauth_providers' ? ['google', 'someone-else'] : null);
    expect(await listOAuthProviders()).toEqual(['google']);
    engine = () => {
      throw new Error('command oauth_providers not found');
    };
    expect(await listOAuthProviders()).toEqual([]);
  });
});
