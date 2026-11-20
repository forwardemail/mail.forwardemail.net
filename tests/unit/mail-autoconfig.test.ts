/**
 * Looking up server settings for an address, and what sign-in does with an
 * outgoing server found that way. The mail engine is stood in for; the
 * mapping and the sign-in helper are the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  add: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: () => null, set: vi.fn(), remove: vi.fn() },
  Session: { get: () => null, set: vi.fn(), remove: vi.fn() },
  Accounts: {
    getAll: () => [],
    init: vi.fn(),
    add: (...a: unknown[]) => h.add(...a),
    setActive: (...a: unknown[]) => h.setActive(...a),
  },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false }));
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  cleanupDemoAccount: vi.fn(),
}));

import { MailEngineError, setMailEngineForTests } from '../../src/backends/engine-bridge';
import { findMailSettings, suggestionSourceText } from '../../src/backends/autoconfig';
import { signInWithImap } from '../../src/utils/alias-sign-in';
import { resetMailBackendsForTests } from '../../src/backends';

const KIM = 'kim@smallshop.example';

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let engine: (cmd: string, args: Record<string, unknown>) => unknown;
const only = (cmd: string) => calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  h.add.mockReset().mockReturnValue(true);
  h.setActive.mockReset();
  calls = [];
  engine = () => null;
  resetMailBackendsForTests();
  setMailEngineForTests(async (cmd, args = {}) => {
    calls.push({ cmd, args });
    return engine(cmd, args);
  });
});
afterEach(() => {
  vi.useRealTimers();
  setMailEngineForTests(null);
});

describe('looking up settings for an address', () => {
  it('gives the engine the address and nothing else', async () => {
    await findMailSettings(`  ${KIM} `);
    expect(only('mail_autoconfig')[0].args).toEqual({ email: KIM });
  });

  it('returns both servers and where they came from', async () => {
    engine = () => ({
      source: 'provider',
      imap: { host: 'IMAP.bigmail.example', port: 993, security: 'tls', username: KIM },
      smtp: { host: 'smtp.bigmail.example', port: 587, security: 'starttls', username: KIM },
    });
    const found = await findMailSettings(KIM);
    expect(found).toEqual({
      source: 'provider',
      imap: { host: 'imap.bigmail.example', port: 993, security: 'tls', username: KIM },
      smtp: { host: 'smtp.bigmail.example', port: 587, security: 'starttls', username: KIM },
      signInWith: null,
    });
    expect(suggestionSourceText(found!, KIM)).toContain('smallshop.example');
  });

  it('is null when nothing is published', async () => {
    expect(await findMailSettings(KIM)).toBeNull();
  });

  it('drops a server it could not sign in to safely', async () => {
    engine = () => ({
      source: 'domain',
      imap: { host: 'mail.smallshop.example', port: 143, security: 'plain', username: KIM },
      smtp: { host: 'mail.smallshop.example', port: 0, security: 'tls', username: KIM },
    });
    expect(await findMailSettings(KIM)).toBeNull();
  });

  it('says when the server belongs to a provider with its own sign-in page', async () => {
    engine = () => ({
      source: 'directory',
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls', username: 'ada@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls', username: 'ada@gmail.com' },
    });
    expect((await findMailSettings('ada@gmail.com'))?.signInWith).toBe('google');
  });

  it('warns the user to check server names that came from DNS', async () => {
    engine = () => ({
      source: 'dns',
      imap: { host: 'mail.smallshop.example', port: 993, security: 'tls', username: KIM },
      smtp: null,
    });
    const found = await findMailSettings(KIM);
    expect(suggestionSourceText(found!, KIM)).toMatch(/check them/i);
  });

  it('passes on a refusal from the engine', async () => {
    engine = () => {
      throw new MailEngineError('rate', 'Too many lookups. Wait a minute and try again.');
    };
    await expect(findMailSettings(KIM)).rejects.toMatchObject({ kind: 'rate' });
  });
});

describe('signing in with a suggested outgoing server', () => {
  const imap = {
    host: 'imap.bigmail.example',
    port: 993,
    security: 'tls' as const,
    username: KIM,
    password: 'correct horse',
  };
  const suggestedSmtp = {
    host: 'smtp.bigmail.example',
    port: 587,
    security: 'starttls' as const,
    username: 'kim',
  };

  it('saves it when the server takes the same password', async () => {
    await signInWithImap(KIM, imap, { staySignedIn: true, suggestedSmtp });
    expect(only('smtp_test')[0].args).toEqual({
      smtp: { ...suggestedSmtp, password: 'correct horse' },
    });
    expect(h.add).toHaveBeenCalledWith(
      KIM,
      { kind: 'imap', imap, smtp: { ...suggestedSmtp, password: 'correct horse' } },
      true,
    );
  });

  it('signs in without it when the outgoing server refuses the password', async () => {
    engine = (cmd) => {
      if (cmd === 'smtp_test') throw new MailEngineError('auth', 'Authentication failed');
      return null;
    };
    await signInWithImap(KIM, imap, { staySignedIn: true, suggestedSmtp });
    expect(h.add).toHaveBeenCalledWith(KIM, { kind: 'imap', imap }, true);
    expect(h.setActive).toHaveBeenCalledWith(KIM);
  });

  it('does not hold up sign-in for an outgoing server that never answers', async () => {
    vi.useFakeTimers();
    engine = (cmd) => (cmd === 'smtp_test' ? new Promise(() => {}) : null);
    const signedIn = signInWithImap(KIM, imap, { staySignedIn: true, suggestedSmtp });
    await vi.advanceTimersByTimeAsync(10_000);
    await signedIn;
    expect(h.add).toHaveBeenCalledWith(KIM, { kind: 'imap', imap }, true);
  });

  it('never tries the outgoing server when the incoming one refuses the sign-in', async () => {
    engine = (cmd) => {
      if (cmd === 'mail_test') throw new MailEngineError('auth', 'Invalid credentials');
      return null;
    };
    await expect(
      signInWithImap(KIM, imap, { staySignedIn: true, suggestedSmtp }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(only('smtp_test')).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('tests nothing extra when no outgoing server was suggested', async () => {
    await signInWithImap(KIM, imap, { staySignedIn: false });
    expect(only('smtp_test')).toEqual([]);
    expect(h.add).toHaveBeenCalledWith(KIM, { kind: 'imap', imap }, false);
  });
});
