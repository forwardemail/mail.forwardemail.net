// Headers are read with the MIME parser, which misreads its input under
// jsdom's second set of typed-array classes.
// @vitest-environment node
/**
 * Conversations for an account on a custom IMAP server.
 *
 * The Forward Email API gives every row a thread_id. An IMAP row has none:
 * all the app knows is what the message's own headers say. These rows are
 * built from header blocks the way the engine hands them over, stored the
 * way the sync worker stores them, then grouped with the code the message
 * list uses.
 */
import { describe, expect, it } from 'vitest';
import { rowToRecord as engineRowToRecord } from '../../src/backends/imap-mapping';
import { normalizeMessageForCache } from '../../src/utils/sync-helpers';
import { groupIntoConversations } from '../../src/utils/threading';

const header = (lines: string[]) =>
  Buffer.from([...lines, '', ''].join('\r\n'), 'utf8').toString('base64');

const row = (uid: number, lines: string[]) => ({
  uid,
  flags: ['\\Seen'],
  size: 2048,
  internalDate: '2026-11-12T10:00:00Z',
  header: header(lines),
});

const question = row(11, [
  'From: Dana Whitfield <dana@example.com>',
  'To: me@example.org',
  'Subject: Venue for the offsite',
  'Date: Thu, 12 Nov 2026 09:00:00 +0000',
  'Message-ID: <q1@example.com>',
]);
const myReply = row(4, [
  'From: me@example.org',
  'To: Dana Whitfield <dana@example.com>',
  'Subject: Re: Venue for the offsite',
  'Date: Thu, 12 Nov 2026 09:30:00 +0000',
  'Message-ID: <r1@example.org>',
  'In-Reply-To: <q1@example.com>',
  'References: <q1@example.com>',
]);
// Outlook folds References over lines and rewrites the subject.
const followUp = row(12, [
  'From: Dana Whitfield <dana@example.com>',
  'To: me@example.org',
  'Subject: RE: Venue for the offsite [booked]',
  'Date: Thu, 12 Nov 2026 10:00:00 +0000',
  'Message-ID: <q2@example.com>',
  'In-Reply-To: <r1@example.org>',
  'References: <q1@example.com>',
  ' <r1@example.org>',
]);
const unrelated = row(13, [
  'From: Billing <billing@example.net>',
  'To: me@example.org',
  'Subject: Invoice 2026-114',
  'Date: Thu, 12 Nov 2026 11:00:00 +0000',
  'Message-ID: <inv114@example.net>',
]);

type Row = Parameters<typeof engineRowToRecord>[0];
/** A row as the message list holds it: read from the engine, then cached. */
const rowToRecord = async (engineRow: Row, folder: string, uidValidity: number) =>
  normalizeMessageForCache(
    await engineRowToRecord(engineRow, folder, uidValidity),
    folder,
    'me@example.org',
  ) as unknown as Record<string, unknown>;

const idsOf = (conversation: { messages: Array<Record<string, unknown>> }) =>
  conversation.messages.map((m) => m.header_message_id).sort();

describe('threading rows read from an IMAP server', () => {
  it('carries the headers the thread is built from', async () => {
    const record = await rowToRecord(followUp, 'INBOX', 7);
    expect(record.header_message_id).toBe('<q2@example.com>');
    expect(record.in_reply_to).toBe('<r1@example.org>');
    expect(String(record.references).match(/<[^>]+>/g)).toEqual([
      '<q1@example.com>',
      '<r1@example.org>',
    ]);
    expect(record.thread_id).toBeNull();
  });

  it('groups a message with its replies in one folder', async () => {
    const rows = await Promise.all(
      [question, followUp, unrelated].map((r) => rowToRecord(r, 'INBOX', 7)),
    );
    const conversations = groupIntoConversations(rows);

    expect(conversations).toHaveLength(2);
    const thread = conversations.find((c) => c.messages.length === 2);
    expect(thread && idsOf(thread)).toEqual(['<q1@example.com>', '<q2@example.com>']);
  });

  it('joins the reply kept in Sent to the messages in the inbox', async () => {
    const rows = [
      await rowToRecord(question, 'INBOX', 7),
      await rowToRecord(myReply, 'Sent', 3),
      await rowToRecord(followUp, 'INBOX', 7),
    ];
    const conversations = groupIntoConversations(rows);

    expect(conversations).toHaveLength(1);
    expect(idsOf(conversations[0])).toEqual([
      '<q1@example.com>',
      '<q2@example.com>',
      '<r1@example.org>',
    ]);
  });

  it('threads a reply whose parent has not been loaded, by what it refers to', async () => {
    // The question is on an older page. Both later messages name it.
    const rows = [await rowToRecord(myReply, 'Sent', 3), await rowToRecord(followUp, 'INBOX', 7)];
    expect(groupIntoConversations(rows)).toHaveLength(1);
  });

  it('gives messages from the same folder different ids', async () => {
    const a = await rowToRecord(question, 'INBOX', 7);
    const b = await rowToRecord(followUp, 'INBOX', 7);
    const sent = await rowToRecord(myReply, 'Sent', 3);
    expect(new Set([a.id, b.id, sent.id]).size).toBe(3);
  });
});
