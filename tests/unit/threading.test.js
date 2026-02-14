import { describe, it, expect } from 'vitest';
import {
  normalizeSubject,
  getConversationId,
  groupIntoConversations,
  deduplicateMessages,
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
