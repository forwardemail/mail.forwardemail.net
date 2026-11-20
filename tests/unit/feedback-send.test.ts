/**
 * Feedback is an email to Forward Email support. An account on a custom mail
 * server has nothing to do with the Forward Email API, so its report leaves
 * as an ordinary message through its own outgoing server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  local: {} as Record<string, string | null>,
  accounts: [] as Array<Record<string, unknown>>,
  remoteRequest: vi.fn(),
  queueEmail: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => h.local[key] ?? null },
  Accounts: { getAll: () => h.accounts },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/outbox-service', () => ({
  queueEmail: (...a: unknown[]) => h.queueEmail(...a),
}));

import { customServerSender, sendFeedback } from '../../src/utils/feedback-send';

const SERVER = {
  host: 'mail.example.org',
  port: 993,
  security: 'tls',
  username: 'me',
  password: 'pw',
};

beforeEach(() => {
  h.local = {};
  h.accounts = [];
  h.remoteRequest.mockReset().mockResolvedValue({});
  h.queueEmail.mockReset().mockResolvedValue({ id: 'outbox_1' });
});

describe('from a Forward Email account', () => {
  it('goes through the API as before', async () => {
    h.local = { email: 'ada@example.com', alias_auth: 'ada@example.com:secret' };
    h.accounts = [{ email: 'ada@example.com', aliasAuth: 'ada@example.com:secret' }];

    expect(await sendFeedback('[Bug] Crash', 'details')).toBe('api');
    expect(customServerSender()).toBeNull();
    expect(h.remoteRequest).toHaveBeenCalledWith(
      'Emails',
      expect.objectContaining({ from: 'ada@example.com', to: ['support@forwardemail.net'] }),
      { method: 'POST' },
    );
    expect(h.queueEmail).not.toHaveBeenCalled();
  });
});

describe('from an account on a custom mail server', () => {
  beforeEach(() => {
    h.local = { email: 'me@example.org' };
  });

  it('is sent as a normal message through its own outgoing server', async () => {
    h.accounts = [
      { email: 'me@example.org', kind: 'imap', imap: SERVER, smtp: { ...SERVER, port: 465 } },
    ];

    expect(await sendFeedback('[Bug] Crash', 'details')).toBe('outbox');
    expect(customServerSender()).toBe('me@example.org');
    expect(h.queueEmail).toHaveBeenCalledWith({
      from: 'me@example.org',
      to: ['support@forwardemail.net'],
      subject: '[Bug] Crash',
      text: 'details',
      // A copy in Sent: the user can see exactly what left their mailbox.
      save_sent: true,
    });
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('says an outgoing server is needed instead of trying the API', async () => {
    h.accounts = [{ email: 'me@example.org', kind: 'imap', imap: SERVER }];

    await expect(sendFeedback('[Bug] Crash', 'details')).rejects.toThrow(
      'me@example.org has no outgoing server. Add one in Settings, then send again.',
    );
    expect(h.queueEmail).not.toHaveBeenCalled();
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });
});
