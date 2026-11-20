// The Sent copy is checked by reading it back with the MIME parser, which
// misreads its input under jsdom's second set of typed-array classes.
// @vitest-environment node
/**
 * Sending from an account that has its own outgoing server.
 *
 * The outbox hands the message to the mail engine instead of the Forward
 * Email API. The engine is stood in for here; everything from the queued
 * item to the commands the engine receives is the real code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';

const h = vi.hoisted(() => ({
  activeEmail: 'ada@example.com',
  accounts: [] as Array<Record<string, unknown>>,
  outbox: new Map<string, Record<string, unknown>>(),
  folders: [] as Array<Record<string, unknown>>,
  remoteRequest: vi.fn(),
  events: [] as string[],
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn((key: string) => (key === 'email' ? h.activeEmail : null)) },
  Accounts: { getAll: () => h.accounts },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false }));
vi.mock('../../src/utils/remote', () => ({
  getRequestTimeout: () => 60_000,
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: () => '',
  getAuthHeaderForAccount: (email: string) =>
    h.accounts.find((a) => a.email === email)?.aliasAuth ? 'Basic YWRhOnB3' : '',
}));
vi.mock('../../src/utils/catchall-credentials', () => ({ buildCatchallAuthHeader: () => '' }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  showDemoBlockedToast: vi.fn(),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));
vi.mock('../../src/utils/answered-flag.ts', () => ({ markOriginalAnswered: vi.fn() }));
vi.mock('../../src/utils/sync-core.js', () => ({
  withNamedLock: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('../../src/stores/folderStore.ts', () => ({
  folders: { subscribe: (run: (v: unknown[]) => void) => (run([]), () => {}) },
}));
vi.mock('../../src/utils/db', () => ({
  db: {
    outbox: {
      put: vi.fn(async (r: Record<string, unknown>) => h.outbox.set(String(r.id), r)),
      get: vi.fn(async ([, id]: [string, string]) => h.outbox.get(id)),
      update: vi.fn(async ([, id]: [string, string], changes: Record<string, unknown>) => {
        const cur = h.outbox.get(id);
        if (cur) h.outbox.set(id, { ...cur, ...changes });
      }),
      where: () => ({ between: () => ({ toArray: async () => [...h.outbox.values()] }) }),
    },
    folders: { where: () => ({ equals: () => ({ toArray: async () => h.folders }) }) },
  },
}));

import { processOutbox, queueEmail, scheduleEmail } from '../../src/utils/outbox-service.js';
import { MailEngineError, setMailEngineForTests } from '../../src/backends/imap-engine';
import { resetMailBackendsForTests } from '../../src/backends';
import { sentNeedsReadingAgain } from '../../src/backends/smtp-send';

const SMTP = {
  host: 'smtp.example.com',
  port: 465,
  security: 'tls',
  username: 'ada@example.com',
  password: 'outgoing secret',
};
const IMAP = { ...SMTP, host: 'imap.example.com', port: 993, password: 'incoming secret' };

const email = {
  from: '"Ada Lovelace" <ada@example.com>',
  to: ['Charles Babbage <charles@example.org>'],
  bcc: ['quiet@example.net'],
  subject: 'Notes on the engine',
  text: 'The engine weaves algebraic patterns.',
  html: '<p>The engine weaves algebraic patterns.</p>',
  messageId: '<n1@example.com>',
};

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let failSend: MailEngineError | null = null;

const decode = (b64: unknown) => Uint8Array.from(Buffer.from(String(b64), 'base64'));
const only = (cmd: string) => calls.filter((c) => c.cmd === cmd);
const item = () => [...h.outbox.values()][0];

beforeEach(() => {
  h.activeEmail = 'ada@example.com';
  h.accounts = [];
  h.outbox.clear();
  h.folders = [];
  h.remoteRequest.mockReset().mockResolvedValue({ id: 'api-1' });
  calls = [];
  failSend = null;
  resetMailBackendsForTests();
  setMailEngineForTests(async (cmd, args = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'smtp_open') return 'smtp-handle-1';
    if (cmd === 'mail_open') return 'imap-handle-1';
    if (cmd === 'smtp_send' && failSend) throw failSend;
    if (cmd === 'imap_folders') {
      return [
        { path: 'INBOX', delimiter: '/' },
        { path: 'Sent Items', delimiter: '/', specialUse: '\\Sent' },
      ];
    }
    return null;
  });
});

describe('a Forward Email account with its own outgoing server', () => {
  beforeEach(() => {
    h.accounts = [{ email: 'ada@example.com', aliasAuth: 'ada@example.com:pw', smtp: SMTP }];
  });

  it('sends through that server and not through the API', async () => {
    await queueEmail(email, { skipProcess: true });
    expect(await processOutbox()).toMatchObject({ sent: 1, failed: 0 });

    expect(only('smtp_open')).toEqual([{ cmd: 'smtp_open', args: { smtp: SMTP } }]);
    const [send] = only('smtp_send');
    expect(send.args).toMatchObject({
      handle: 'smtp-handle-1',
      from: 'ada@example.com',
      recipients: ['charles@example.org', 'quiet@example.net'],
    });
    const sent = await PostalMime.parse(decode(send.args.message));
    expect(sent.subject).toBe('Notes on the engine');
    expect(sent.text?.trim()).toBe('The engine weaves algebraic patterns.');
    expect(sent.bcc ?? []).toEqual([]);

    expect(h.remoteRequest.mock.calls.filter(([action]) => action === 'Emails')).toEqual([]);
    expect(item().status).toBe('sent');
  });

  it('files the Sent copy in the Forward Email mailbox', async () => {
    await queueEmail(email, { skipProcess: true });
    await processOutbox();

    const copies = h.remoteRequest.mock.calls.filter(([action]) => action === 'MessageCreate');
    expect(copies).toHaveLength(1);
    expect(copies[0][1]).toMatchObject({ subject: 'Notes on the engine', flags: ['\\Seen'] });
    expect(only('imap_append')).toEqual([]);
  });

  it('keeps a scheduled message here, since no server will hold it', async () => {
    const sendAt = Date.now() + 3_600_000;
    const result = await scheduleEmail(email, sendAt);

    expect(result.serverScheduled).toBe(false);
    expect(h.remoteRequest).not.toHaveBeenCalled();
    expect(item()).toMatchObject({ status: 'scheduled', sendAt, serverScheduled: false });
    // Not due yet, so nothing goes out.
    await processOutbox();
    expect(only('smtp_send')).toEqual([]);
  });

  it('names the address the server refused and does not try again', async () => {
    failSend = new MailEngineError('recipient', '550 5.1.1 no such user', 0);
    await queueEmail(email, { skipProcess: true });
    expect(await processOutbox()).toMatchObject({ sent: 0, failed: 1 });

    expect(item().status).toBe('failed');
    expect(item().lastError).toBe('The server refused charles@example.org: 550 5.1.1 no such user');
    expect(h.remoteRequest.mock.calls.filter(([action]) => action === 'MessageCreate')).toEqual([]);
  });

  it('does not resend a message the server may already have', async () => {
    failSend = new MailEngineError('unconfirmed', 'The server did not confirm the message.');
    await queueEmail(email, { skipProcess: true });
    await processOutbox();

    expect(item().status).toBe('failed');
    expect(item().lastError).toMatch(/may have been sent/);
    await processOutbox();
    expect(only('smtp_send')).toHaveLength(1);
  });

  it('tries again later when the server could not be reached', async () => {
    failSend = new MailEngineError('network', 'Could not connect');
    await queueEmail(email, { skipProcess: true });
    await processOutbox();

    expect(item()).toMatchObject({ status: 'pending', retryCount: 1 });
    expect(Number(item().nextRetryAt)).toBeGreaterThan(Date.now());
  });
});

describe('an account on a custom IMAP server', () => {
  it('sends by SMTP and saves the copy, Bcc included, to its Sent folder', async () => {
    h.accounts = [{ email: 'ada@example.com', kind: 'imap', imap: IMAP, smtp: SMTP }];
    h.folders = [{ path: 'Sent Items', specialUse: '\\Sent' }];
    await queueEmail(email, { skipProcess: true });
    expect(await processOutbox()).toMatchObject({ sent: 1 });

    expect(only('smtp_send')).toHaveLength(1);
    const [append] = only('imap_append');
    expect(append.args).toMatchObject({
      handle: 'imap-handle-1',
      folder: 'Sent Items',
      flags: ['\\Seen'],
    });
    const copy = await PostalMime.parse(decode(append.args.message));
    expect(copy.messageId).toBe('<n1@example.com>');
    expect(copy.bcc).toEqual([{ name: '', address: 'quiet@example.net' }]);
    // The copy is the message that went out, not a second build of it.
    const sent = await PostalMime.parse(decode(only('smtp_send')[0].args.message));
    expect(copy.date).toBe(sent.date);
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  // Nothing from the server says the copy arrived, so the outbox's own
  // "sent" event is what makes the main window read Sent again.
  describe('telling the app to read Sent again', () => {
    const sentEvents = async (payload: Record<string, unknown>, options = {}) => {
      const seen: Array<Record<string, unknown>> = [];
      const target = new EventTarget();
      target.addEventListener('outbox-sent', (e) => seen.push((e as CustomEvent).detail));
      vi.stubGlobal('window', target);
      try {
        await queueEmail(payload, { skipProcess: true, ...options });
        await processOutbox();
      } finally {
        vi.unstubAllGlobals();
      }
      return seen;
    };

    it('only once the copy is on the server', async () => {
      h.accounts = [{ email: 'ada@example.com', kind: 'imap', imap: IMAP, smtp: SMTP }];
      let appendsWhenTold = -1;
      const target = new EventTarget();
      target.addEventListener('outbox-sent', () => {
        appendsWhenTold = only('imap_append').length;
      });
      vi.stubGlobal('window', target);
      try {
        await queueEmail(email, { skipProcess: true });
        await processOutbox();
      } finally {
        vi.unstubAllGlobals();
      }
      expect(appendsWhenTold).toBe(1);
    });

    it('for the account on screen', async () => {
      h.accounts = [{ email: 'ada@example.com', kind: 'imap', imap: IMAP, smtp: SMTP }];
      const [detail] = await sentEvents(email);
      expect(detail).toMatchObject({ account: 'ada@example.com', savedSent: true });
      expect(sentNeedsReadingAgain(detail, 'Ada@Example.com')).toBe(true);
    });

    it('not for a message sent as an account that is not on screen', async () => {
      h.accounts = [
        { email: 'ada@example.com', aliasAuth: 'ada@example.com:pw' },
        { email: 'grace@example.net', kind: 'imap', imap: IMAP, smtp: SMTP },
      ];
      const [detail] = await sentEvents(
        { ...email, from: 'grace@example.net' },
        { sendAs: 'grace@example.net' },
      );
      expect(detail.account).toBe('grace@example.net');
      expect(sentNeedsReadingAgain(detail, 'ada@example.com')).toBe(false);
    });

    it('not for a message that asked for no Sent copy', async () => {
      h.accounts = [{ email: 'ada@example.com', kind: 'imap', imap: IMAP, smtp: SMTP }];
      const [detail] = await sentEvents({ ...email, save_sent: false });
      expect(only('imap_append')).toEqual([]);
      expect(sentNeedsReadingAgain(detail, 'ada@example.com')).toBe(false);
    });

    it('not for a Forward Email account, whose socket reports the copy', async () => {
      h.accounts = [{ email: 'ada@example.com', aliasAuth: 'ada@example.com:pw', smtp: SMTP }];
      const [detail] = await sentEvents(email);
      expect(sentNeedsReadingAgain(detail, 'ada@example.com')).toBe(false);
    });
  });

  it('leaves the Sent copy to a server that files one itself', async () => {
    h.accounts = [
      {
        email: 'ada@example.com',
        kind: 'imap',
        imap: { ...IMAP, host: 'imap.gmail.com' },
        smtp: { ...SMTP, host: 'smtp.gmail.com' },
      },
    ];
    await queueEmail(email, { skipProcess: true });
    expect(await processOutbox()).toMatchObject({ sent: 1 });
    expect(only('imap_append')).toEqual([]);
  });

  it('cannot send until it has an outgoing server, and says so', async () => {
    h.accounts = [{ email: 'ada@example.com', kind: 'imap', imap: IMAP }];
    await queueEmail(email, { skipProcess: true });
    expect(await processOutbox()).toMatchObject({ sent: 0, failed: 1 });

    expect(item().status).toBe('failed');
    expect(item().lastError).toBe(
      'ada@example.com has no outgoing server. Add one in Settings, then send again.',
    );
    expect(only('smtp_send')).toEqual([]);
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });
});

describe('sending as another signed-in account', () => {
  it('uses the outgoing server of the account in From, not of the one on screen', async () => {
    h.accounts = [
      { email: 'ada@example.com', aliasAuth: 'ada@example.com:pw' },
      { email: 'work@example.net', aliasAuth: 'work@example.net:pw', smtp: SMTP },
    ];
    await queueEmail(
      { ...email, from: 'work@example.net' },
      { skipProcess: true, sendAs: 'work@example.net' },
    );
    expect(await processOutbox()).toMatchObject({ sent: 1 });

    expect(only('smtp_send')[0].args).toMatchObject({ from: 'work@example.net' });
    expect(h.remoteRequest.mock.calls.filter(([action]) => action === 'Emails')).toEqual([]);
  });
});
