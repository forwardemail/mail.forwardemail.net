import { describe, it, expect } from 'vitest';
import {
  normalizeSubject,
  getConversationId,
  groupIntoConversations,
  deduplicateMessages,
  hasAnsweredFlag,
} from '../../src/utils/threading';

describe('threading utils', () => {
  it('normalizes subjects by stripping reply/forward prefixes and brackets', () => {
    expect(normalizeSubject('Re: Fwd: [External]  Hello world  ')).toBe('Hello world');
    expect(normalizeSubject('AW:   Test')).toBe('Test');
    expect(normalizeSubject('   ')).toBe('');
  });

  it('generates matching conversation ids for header-linked messages', () => {
    const root = { message_id: '<root@example.com>', subject: 'Topic' };
    const child = { in_reply_to: '<root@example.com>', subject: 'Re: Topic' };

    const rootId = getConversationId(root);
    const childId = getConversationId(child);

    // Both reference the same Message-ID so they share a conversation
    expect(childId).toBe(rootId);
  });

  it('does not group by subject alone (no subject-based fallback)', () => {
    const root = { message_id: '<root@example.com>', subject: 'Topic' };
    const unlinked = { id: 'orphan', subject: 'RE: topic' };

    const rootId = getConversationId(root);
    const unlinkedId = getConversationId(unlinked);

    // Without header links, subject match alone does not create a conversation
    expect(unlinkedId).not.toBe(rootId);
  });

  it('groups header-linked messages into conversations and tracks unread and counts', () => {
    const messages = [
      {
        id: '1',
        message_id: '<1@x>',
        subject: 'Status Update',
        date: '2024-01-01',
        is_unread: true,
      },
      {
        id: '2',
        in_reply_to: '<1@x>',
        subject: 'Re: Status Update',
        date: '2024-01-02',
        is_unread: false,
      },
      {
        id: '3',
        subject: 'Re: Status Update',
        date: '2024-01-03',
        is_unread: false,
      },
      {
        id: '4',
        message_id: '<4@x>',
        subject: 'Different thread',
        date: '2024-01-04',
        is_unread: true,
      },
    ];

    const deduped = deduplicateMessages(messages);
    const conversations = groupIntoConversations(deduped);

    // Message 3 has no header links, so it becomes its own conversation (3 total)
    expect(conversations.length).toBe(3);

    const status = conversations.find((c) => c.displaySubject === 'Status Update');
    expect(status?.messages.length).toBe(2);
    expect(status?.hasUnread).toBe(true);
    expect(status?.messageCount).toBe(2);

    const different = conversations.find((c) => c.displaySubject === 'Different thread');
    expect(different?.messages.length).toBe(1);
    expect(different?.hasUnread).toBe(true);
  });
});

// Rows as the lightweight list stores them: the server sends thread_id and
// the Message-ID, but no In-Reply-To or References.
const lightweightRow = (id, threadId, subject, dateMs, folder = 'INBOX') => ({
  id,
  message_id: `<${id}@example.com>`,
  header_message_id: `<${id}@example.com>`,
  thread_id: threadId,
  in_reply_to: null,
  references: null,
  subject,
  folder,
  dateMs,
});

describe('groupIntoConversations with server threads', () => {
  it('groups lightweight rows that share a thread_id across folders', () => {
    const grouped = groupIntoConversations([
      lightweightRow('c', 'thread-1', 'Re: Plans', 3000),
      lightweightRow('b', 'thread-1', 'Re: Plans', 2000, 'Sent'),
      lightweightRow('a', 'thread-1', 'Plans', 1000),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps different threads apart even with the same subject', () => {
    const grouped = groupIntoConversations([
      lightweightRow('a', 'thread-1', 'Invoice', 2000),
      lightweightRow('b', 'thread-2', 'Invoice', 1000),
    ]);

    expect(grouped).toHaveLength(2);
  });

  it('joins a header-linked cached row and a thread-only row in one conversation', () => {
    // Newest first, as the list is sorted. The cached reply has headers but
    // no thread_id; the newer row only has the thread; the root has both.
    const grouped = groupIntoConversations([
      lightweightRow('c', 'thread-1', 'Re: Plans', 3000),
      {
        id: 'b',
        message_id: '<b@example.com>',
        in_reply_to: '<a@example.com>',
        references: '<a@example.com>',
        subject: 'Re: Plans',
        dateMs: 2000,
      },
      { ...lightweightRow('a', 'thread-1', 'Plans', 1000) },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].messageCount).toBe(3);
  });

  it('keeps the id of the conversation seen first when two are merged', () => {
    const newest = lightweightRow('c', 'thread-1', 'Re: Plans', 3000);
    const alone = groupIntoConversations([newest]);
    const merged = groupIntoConversations([
      newest,
      { id: 'b', message_id: '<b@example.com>', in_reply_to: '<a@example.com>', dateMs: 2000 },
      lightweightRow('a', 'thread-1', 'Plans', 1000),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(alone[0].id);
  });
});

describe('groupIntoConversations conversation ids', () => {
  it('keeps the id when a new reply arrives at the top of the thread', () => {
    const before = groupIntoConversations([
      lightweightRow('b', 'thread-1', 'Re: Plans', 2000),
      lightweightRow('a', 'thread-1', 'Plans', 1000),
    ]);
    const after = groupIntoConversations([
      lightweightRow('c', 'thread-1', 'Re: Plans', 3000),
      lightweightRow('b', 'thread-1', 'Re: Plans', 2000),
      lightweightRow('a', 'thread-1', 'Plans', 1000),
    ]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });

  it('keeps the id when the newest row has headers but no thread_id', () => {
    // A just-sent reply inserted before the server indexed it: it links by
    // In-Reply-To only, and it sorts first.
    const before = groupIntoConversations([
      { ...lightweightRow('b', 'thread-1', 'Plans', 2000), message_id: '<b@example.com>' },
    ]);
    const after = groupIntoConversations([
      { id: 'x', message_id: '<x@example.com>', in_reply_to: '<b@example.com>', dateMs: 3000 },
      { ...lightweightRow('b', 'thread-1', 'Plans', 2000), message_id: '<b@example.com>' },
    ]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });
});

describe('hasAnsweredFlag', () => {
  it('reads the IMAP flag case-insensitively and the derived fields', () => {
    expect(hasAnsweredFlag({ flags: ['\\Seen', '\\Answered'] })).toBe(true);
    expect(hasAnsweredFlag({ flags: ['\\answered'] })).toBe(true);
    expect(hasAnsweredFlag({ Flags: ['\\Answered'] })).toBe(true);
    expect(hasAnsweredFlag({ is_answered: true })).toBe(true);
    expect(hasAnsweredFlag({ flags: ['\\Seen'] })).toBe(false);
    expect(hasAnsweredFlag({ flags: 'not-an-array' })).toBe(false);
    expect(hasAnsweredFlag(null)).toBe(false);
  });
});
