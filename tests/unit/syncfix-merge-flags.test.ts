import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/storage.js', () => ({ Local: { get: () => null } }));

const { mergeFlagsAndMetadata, mergeServerRow, normalizeMessageForCache } =
  await import('../../src/utils/sync-helpers.ts');

const cached = {
  id: '64b7f0c2e4b0a1a2b3c4d5e6',
  account: 'me@x.test',
  folder: 'INBOX',
  flags: ['\\Seen'],
  is_unread: false,
  is_unread_index: 0,
  is_starred: false,
  is_flagged: false,
  is_answered: false,
};

describe('mergeFlagsAndMetadata', () => {
  it('picks up a reply sent from another client (\\Answered)', () => {
    const server = normalizeMessageForCache(
      { id: cached.id, flags: ['\\Seen', '\\Answered'], subject: 's' },
      'INBOX',
      'me@x.test',
    );
    const { record, changed } = mergeFlagsAndMetadata(cached, server);
    expect(changed).toBe(true);
    expect(record.is_answered).toBe(true);
  });

  it('keeps is_flagged in step with a star set elsewhere', () => {
    const server = normalizeMessageForCache(
      { id: cached.id, flags: ['\\Seen', '\\Flagged'], subject: 's' },
      'INBOX',
      'me@x.test',
    );
    const { record } = mergeFlagsAndMetadata(cached, server);
    expect(record.is_starred).toBe(true);
    expect(record.is_flagged).toBe(true);
  });

  it('leaves a pending local star in place when the server list predates it', () => {
    const local = { ...cached, flags: ['\\Seen', '\\Flagged'], is_starred: true, is_flagged: true };
    const server = normalizeMessageForCache(
      { id: cached.id, flags: ['\\Seen'], subject: 's' },
      'INBOX',
      'me@x.test',
    );
    const { record, changed } = mergeFlagsAndMetadata(local, server, { is_starred: true });
    expect(changed).toBe(false);
    expect(record).toMatchObject({ is_starred: true, is_flagged: true });
    expect(record.flags).toContain('\\Flagged');
  });

  it('still takes other server changes alongside a pending read change', () => {
    const local = { ...cached, flags: [], is_unread: true, is_unread_index: 1 };
    const server = normalizeMessageForCache(
      { id: cached.id, flags: ['\\Seen', '\\Flagged'], subject: 's' },
      'INBOX',
      'me@x.test',
    );
    const { record } = mergeFlagsAndMetadata(local, server, { is_unread: true });
    expect(record.is_unread).toBe(true);
    expect(record.flags).not.toContain('\\Seen');
    expect(record.is_starred).toBe(true);
  });
});

describe('mergeServerRow', () => {
  it('keeps the decrypted subject and PGP badge over the placeholder from the list', () => {
    const local = { ...cached, subject: 'Merger terms', pgpEncrypted: true, pgpSigned: false };
    const server = normalizeMessageForCache(
      { id: cached.id, flags: ['\\Seen'], subject: '...' },
      'INBOX',
      'me@x.test',
    );
    const merged = mergeServerRow(local, server);
    expect(merged).toMatchObject({ subject: 'Merger terms', pgpEncrypted: true, pgpSigned: false });
  });

  it('takes the server subject for a message that is not encrypted', () => {
    const local = { ...cached, subject: 'Old' };
    const merged = mergeServerRow(local, { ...cached, subject: 'New' });
    expect(merged.subject).toBe('New');
  });
});

describe('pending label changes', () => {
  it('keeps a pending label change over an older server copy', () => {
    const existing = { ...cached, labels: ['work'] };
    const server = { ...cached, labels: [] };
    const { record, changed } = mergeFlagsAndMetadata(existing, server, { labels: ['work'] });
    expect(record.labels).toEqual(['work']);
    expect(changed).toBe(false);
  });

  it('takes the server labels when nothing is pending', () => {
    const existing = { ...cached, labels: ['work'] };
    const server = { ...cached, labels: ['home'] };
    expect(mergeFlagsAndMetadata(existing, server, null).record.labels).toEqual(['home']);
  });
});
