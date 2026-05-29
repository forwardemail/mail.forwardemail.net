import { describe, it, expect } from 'vitest';
// Loading this classic script attaches `normalizeMessageRecord` to the global,
// exactly as the service worker receives it via importScripts.
import '../../public/sw-message-normalize.js';
import { normalizeMessageForCache } from '../../src/utils/sync-helpers.ts';

type MsgRecord = Record<string, unknown>;
// Reuse the canonical function's own parameter type for raw inputs.
type RawArg = Parameters<typeof normalizeMessageForCache>[0];

// The service-worker normalizer, as the SW sees it (attached to the global).
const swNormalize = (
  globalThis as {
    normalizeMessageRecord?: (raw: RawArg, folder?: string, account?: string) => MsgRecord;
  }
).normalizeMessageRecord as (raw: RawArg, folder?: string, account?: string) => MsgRecord;

// Fields where the two sync paths MUST agree, or a message ends up looking
// different (or unqueryable) depending on which path populated the cache:
// identity, the Dexie indexes, flags, threading and labels.
const DATA_INTEGRITY_FIELDS = [
  'id',
  'account',
  'folder',
  'folder_id',
  'date',
  'dateMs',
  'flags',
  'is_unread',
  'is_unread_index',
  'is_starred',
  'is_flagged',
  'has_attachment',
  'message_id',
  'header_message_id',
  'thread_id',
  'root_id',
  'uid',
  'references',
  'in_reply_to',
  'labels',
  'bodyIndexed',
] as const;

const ACCOUNT = 'user@example.com';
const FOLDER = 'INBOX';

// Raw API records exercising the known divergences (id priority, date-field
// ordering, label extraction, attachment-by-array, header-derived ids, etc.).
const FIXTURES: Array<{ name: string; raw: RawArg }> = [
  {
    name: 'server id + uid, flags, labels, attachments, header-derived ids',
    raw: {
      id: 'srv-1',
      Uid: 42,
      folder: 'INBOX',
      created_at: '2024-01-02T03:04:05.000Z',
      Subject: 'Hello there',
      flags: ['\\Seen', '\\Flagged'],
      labels: ['Work', 'Personal'],
      thread_id: 'thread-1',
      folder_id: 'fid-1',
      modseq: '1000',
      attachments: [{ filename: 'a.pdf' }],
      nodemailer: {
        headers: {
          'message-id': '<m1@example.com>',
          'in-reply-to': '<r0@example.com>',
          references: '<a@example.com> <b@example.com>',
        },
      },
    },
  },
  {
    name: 'uid-only id, unread fallback, no flags',
    raw: {
      Uid: 7,
      folder: 'Archive',
      date: '2023-05-05T00:00:00.000Z',
      subject: 'No server id',
      is_unread: false,
    },
  },
  {
    name: 'both date and Date present (field-ordering)',
    raw: {
      id: 'srv-3',
      folder: 'INBOX',
      date: '2023-01-01T00:00:00.000Z',
      Date: '2024-06-06T00:00:00.000Z',
      subject: 'Ordering',
      flags: [],
    },
  },
];

describe('message normalization contract: SW vs canonical', () => {
  it('exposes the service-worker normalizer as a global', () => {
    expect(typeof swNormalize).toBe('function');
  });

  for (const { name, raw } of FIXTURES) {
    it(`agrees on data-integrity fields — ${name}`, () => {
      const canonical = normalizeMessageForCache(raw, FOLDER, ACCOUNT) as unknown as MsgRecord;
      const sw = swNormalize(raw, FOLDER, ACCOUNT);
      for (const field of DATA_INTEGRITY_FIELDS) {
        expect(sw[field], `field "${field}"`).toEqual(canonical[field]);
      }
    });
  }
});
