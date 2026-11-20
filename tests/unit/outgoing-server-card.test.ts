/**
 * The Outgoing server card in Settings, mounted for real. Its first version
 * re-ran its own setup effect until Svelte gave up, which took the whole
 * window down, so the card is rendered here rather than reasoned about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const h = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  setSmtp: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: () => null },
  Accounts: {
    getAll: () => h.accounts,
    setSmtp: (email: string, smtp: unknown) => h.setSmtp(email, smtp),
  },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: true }));
vi.mock('../../src/utils/frame-isolation-probe', () => ({
  probeOpaqueFrameSupport: () => Promise.resolve(true),
}));

import OutgoingServerCard from '../../src/svelte/components/OutgoingServerCard.svelte';
import { MailEngineError, setMailEngineForTests } from '../../src/backends/imap-engine';

const IMAP = {
  host: 'imap.example.org',
  port: 993,
  security: 'tls',
  username: 'alice@example.org',
  password: 'incoming secret',
};

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let rejectTest: MailEngineError | null = null;
let engineOn = true;
let card: ReturnType<typeof mount> | null = null;
let toasts: string[] = [];

const show = async (account: string) => {
  card = mount(OutgoingServerCard, {
    target: document.body,
    props: { account, onToast: (message: string) => toasts.push(message) },
  });
  // The card waits for the frame probe before it shows anything.
  await tick();
  await tick();
  flushSync();
};
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await tick();
  flushSync();
};

beforeEach(() => {
  h.accounts = [];
  h.setSmtp.mockReset().mockReturnValue(true);
  calls = [];
  toasts = [];
  rejectTest = null;
  engineOn = true;
  setMailEngineForTests(async (cmd, args = {}) => {
    if (cmd === 'mail_enabled') return engineOn;
    calls.push({ cmd, args });
    if (cmd === 'smtp_test' && rejectTest) throw rejectTest;
    return null;
  });
});
afterEach(() => {
  if (card) unmount(card);
  card = null;
  document.body.innerHTML = '';
});

describe('OutgoingServerCard', () => {
  it('opens the form for an IMAP account, guessed from its incoming server', async () => {
    h.accounts = [{ email: 'alice@example.org', kind: 'imap', imap: IMAP }];
    await show('alice@example.org');

    expect(field('smtp-host').value).toBe('smtp.example.org');
    expect(field('smtp-port').value).toBe('465');
    expect(field('smtp-username').value).toBe('alice@example.org');
    // A saved password is never put back on screen.
    expect(field('smtp-password').value).toBe('');
  });

  it('saves only after the server accepts the sign-in, reusing the incoming password', async () => {
    h.accounts = [{ email: 'alice@example.org', kind: 'imap', imap: IMAP }];
    await show('alice@example.org');

    button('Save').click();
    await settle();

    const expected = {
      host: 'smtp.example.org',
      port: 465,
      security: 'tls',
      username: 'alice@example.org',
      password: 'incoming secret',
    };
    expect(calls.filter((c) => c.cmd === 'smtp_test')).toEqual([
      { cmd: 'smtp_test', args: { smtp: expected } },
    ]);
    expect(h.setSmtp).toHaveBeenCalledWith('alice@example.org', expected);
    expect(toasts).toEqual(['alice@example.org now sends through smtp.example.org']);
    expect(document.querySelector('[data-testid="outgoing-server-saved"]')?.textContent).toContain(
      'smtp.example.org:465',
    );
  });

  it('saves nothing when the server refuses the sign-in', async () => {
    h.accounts = [{ email: 'alice@example.org', kind: 'imap', imap: IMAP }];
    rejectTest = new MailEngineError('auth', '535 5.7.8 authentication failed');
    await show('alice@example.org');

    button('Save').click();
    await settle();

    expect(h.setSmtp).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'did not accept that username and password',
    );
  });

  it('offers a Forward Email account the choice without opening the form', async () => {
    h.accounts = [{ email: 'bob@example.com', aliasAuth: 'bob@example.com:pw' }];
    await show('bob@example.com');

    expect(document.querySelector('[data-testid="outgoing-server-add"]')).not.toBeNull();
    expect(field('smtp-host')).toBeNull();
  });

  it('shows a saved server without its password', async () => {
    h.accounts = [
      {
        email: 'bob@example.com',
        aliasAuth: 'bob@example.com:pw',
        smtp: { ...IMAP, host: 'smtp.fastmail.com', port: 587, security: 'starttls' },
      },
    ];
    await show('bob@example.com');

    const saved = document.querySelector('[data-testid="outgoing-server-saved"]');
    expect(saved?.textContent).toContain('smtp.fastmail.com:587');
    expect(saved?.textContent).toContain('STARTTLS');
    expect(document.body.textContent).not.toContain('incoming secret');
  });
  it('offers nothing in a build that has the mail engine switched off', async () => {
    engineOn = false;
    h.accounts = [{ email: 'alice@example.org', kind: 'imap', imap: IMAP }];
    await show('alice@example.org');
    await settle();

    expect(document.querySelector('[data-testid="outgoing-server"]')).toBeNull();
    expect(calls).toEqual([]);
  });
});
