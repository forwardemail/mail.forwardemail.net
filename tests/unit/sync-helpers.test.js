import { describe, expect, it } from 'vitest';
import {
  normalizeMessageForCache,
  mergeFlagsAndMetadata,
  didMetadataChange,
} from '../../src/utils/sync-helpers.ts';

describe('sync helpers', () => {
  it('normalizes server message with flags', () => {
    const raw = {
      Uid: 123,
      folder: 'INBOX',
      Subject: 'Hello',
      From: { Display: 'Sender', Email: 'sender@example.com' },
      flags: ['\\Seen', '\\Flagged'],
      has_attachment: true,
      modseq: 5,
      labels: ['work', 'urgent'],
    };

    const normalized = normalizeMessageForCache(raw, 'INBOX', 'acct');

    expect(String(normalized.id)).toBe('123');
    expect(normalized.folder).toBe('INBOX');
    expect(normalized.is_unread).toBe(false);
    expect(normalized.is_starred).toBe(true);
    expect(normalized.modseq).toBe(5);
    expect(normalized.has_attachment).toBe(true);
    expect(normalized.labels).toEqual(['work', 'urgent']);
  });

  it('normalizes keyword maps from the server into labels', () => {
    const raw = {
      id: 'msg-kw',
      uid: 456,
      folder: 'INBOX',
      Subject: 'Keyword label message',
      From: { Display: 'Sender', Email: 'sender@example.com' },
      keywords: {
        work: true,
        urgent: 1,
        ignored: false,
      },
    };

    const normalized = normalizeMessageForCache(raw, 'INBOX', 'acct');

    expect(normalized.labels).toEqual(['work', 'urgent']);
  });

  it('filters out structural keyword keys and system flags from labels', () => {
    const raw = {
      id: 'msg-sys',
      uid: 789,
      folder: 'INBOX',
      Subject: 'System keywords',
      From: { Display: 'Sender', Email: 'sender@example.com' },
      keywords: {
        data: true,
        type: true,
        content: true,
        work: true,
        '\\Seen': true,
        $Forwarded: true,
      },
    };

    const normalized = normalizeMessageForCache(raw, 'INBOX', 'acct');

    expect(normalized.labels).toEqual(['work']);
  });

  it('filters system labels when provided as an array', () => {
    const raw = {
      id: 'msg-arr',
      uid: 321,
      folder: 'INBOX',
      Subject: 'Mixed labels',
      From: { Display: 'Sender', Email: 'sender@example.com' },
      labels: ['data', 'type', 'project-x', '\\Inbox'],
    };

    const normalized = normalizeMessageForCache(raw, 'INBOX', 'acct');

    expect(normalized.labels).toEqual(['project-x']);
  });

  it('detects metadata changes for flags and unread state', () => {
    const existing = {
      id: 1,
      flags: ['\\Seen'],
      is_unread: false,
      is_starred: false,
      modseq: 1,
    };

    const incoming = {
      ...existing,
      flags: ['\\Seen', '\\Flagged'],
      is_starred: true,
      modseq: 2,
    };

    const merged = mergeFlagsAndMetadata(existing, incoming);
    expect(merged.changed).toBe(true);
    expect(merged.record.is_starred).toBe(true);
    expect(merged.record.modseq).toBe(2);
  });

  it('returns false when metadata unchanged', () => {
    const existing = {
      id: 1,
      flags: ['\\Seen'],
      is_unread: false,
      is_starred: false,
      modseq: 3,
    };

    const candidate = {
      ...existing,
    };

    expect(didMetadataChange(candidate, existing)).toBe(false);
  });
});
