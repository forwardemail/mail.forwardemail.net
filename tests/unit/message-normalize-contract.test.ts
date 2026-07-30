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

// The SW normalizer is now a bundle of the canonical function (#4b), so the two
// outputs must be byte-for-byte identical — not just agree on a field subset.
// `updatedAt` is the lone legitimate difference: it's stamped Date.now() per
// call, so two invocations differ. Strip it before comparing.
const stripVolatile = (m: MsgRecord): MsgRecord => {
  const clone = { ...m };
  delete clone.updatedAt;
  return clone;
};

const ACCOUNT = 'user@example.com';
const FOLDER = 'INBOX';

const LIGHTWEIGHT_API_RAW: RawArg = {
  id: 'srv-lightweight',
  folder_path: 'INBOX',
  internal_date: '2026-07-30T03:43:35.707Z',
  subject: 'Lightweight Identity Metadata',
  flags: [],
  from: [{ address: 'sender@example.com', name: 'Sender Name' }],
  to: [{ address: 'to@example.com', name: '' }],
  cc: [{ address: 'cc@example.com', name: '' }],
  bcc: [{ address: 'bcc@example.com', name: '' }],
  reply_to: [{ address: 'replies@example.com', name: '' }],
};

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
  // The fixtures below exercise the fields the OLD hand-maintained SW normalizer
  // got wrong (best-effort: no MIME-decode, no HTML-strip, partial from). With
  // the bundled canonical they now reach full parity — these would have failed
  // the deep-equality before #4b.
  {
    name: 'MIME-encoded subject + HTML-only body (snippet via strip)',
    raw: {
      id: 'srv-4',
      folder: 'INBOX',
      Subject: '=?UTF-8?B?SGVsbG8sIHdvcmxkIQ==?=',
      html: '<style>.x{color:red}</style><p>Hi <b>there</b>,&nbsp;how are you?</p>',
      from: '"Jane Doe" <jane@example.com>',
      flags: ['\\Seen'],
    },
  },
  {
    name: 'from/to/cc objects + reply-to + nodemailer text snippet',
    raw: {
      id: 'srv-5',
      folder: 'INBOX',
      subject: 'Recipients',
      from: { name: 'Acme', address: 'noreply@acme.test' },
      to: [{ address: 'a@x.test' }, { name: 'Bee', address: 'b@x.test' }],
      cc: 'c@x.test',
      replyTo: { address: 'reply@acme.test' },
      nodemailer: { text: 'plain text body for the snippet' },
      flags: [],
    },
  },
  {
    name: 'captured lightweight API identity shape without MIME data',
    raw: LIGHTWEIGHT_API_RAW,
  },
  {
    name: 'mixed visible + hidden labels (hidden-label filtering)',
    raw: {
      id: 'srv-6',
      folder: 'INBOX',
      subject: 'Labels',
      labels: ['Work', '\\Important', 'Personal', '[]'],
      flags: ['\\Seen'],
    },
  },
];

describe('message normalization contract: SW bundle === canonical', () => {
  it('exposes the service-worker normalizer as a global', () => {
    expect(typeof swNormalize).toBe('function');
  });

  it('normalizes every identity field from the lightweight API response', () => {
    const normalized = normalizeMessageForCache(LIGHTWEIGHT_API_RAW, FOLDER, ACCOUNT);

    expect(normalized).toMatchObject({
      from: 'Sender Name <sender@example.com>',
      to: 'to@example.com',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      reply_to: 'replies@example.com',
      subject: 'Lightweight Identity Metadata',
    });
  });

  for (const { name, raw } of FIXTURES) {
    it(`matches the canonical normalizer exactly — ${name}`, () => {
      const canonical = normalizeMessageForCache(raw, FOLDER, ACCOUNT) as unknown as MsgRecord;
      const sw = swNormalize(raw, FOLDER, ACCOUNT);
      // Full structural equality — the SW bundle is the canonical function, so
      // every field (including the once-divergent subject/snippet/from) agrees.
      expect(stripVolatile(sw)).toEqual(stripVolatile(canonical));
    });
  }
});
