/**
 * The conversation grouper combines two sources for the "replied" indicator:
 * the \Answered flag on the folder's own messages, and the Sent-derived reply
 * index (message ids that a Sent message replied to). A regression made the
 * second overwrite the first whenever the index was non-empty, which on any
 * active inbox is always, so replies made moments ago by this client, or by
 * another user of the same shared account, never showed an indicator.
 */
import { describe, it, expect } from 'vitest';
import { createConversationGrouper } from '../../src/utils/conversation-grouper.js';

const msg = (overrides) => ({
  id: overrides.id,
  header_message_id: `<${overrides.id}@example.com>`,
  subject: overrides.subject || 'Support request',
  from: 'customer@example.com',
  date: overrides.date ?? 1_700_000_000_000,
  dateMs: overrides.date ?? 1_700_000_000_000,
  folder: 'INBOX',
  flags: overrides.flags || [],
  ...overrides,
});

const groupOne = (messages, targets = new Set(), index = new Map()) => {
  const group = createConversationGrouper();
  const convs = group(messages, 'date_desc', targets, index);
  return convs;
};

describe('conversation grouper reply indicator', () => {
  it('keeps hasReply from the \\Answered flag when the reply index is non-empty but unrelated', () => {
    const answered = msg({ id: 'a', flags: ['\\Seen', '\\Answered'] });
    const other = msg({ id: 'b', subject: 'Unrelated' });
    // A busy Sent folder: targets exist, but none point at message "a".
    const targets = new Set(['<zzz@example.com>']);
    const convs = groupOne([answered, other], targets);
    const convA = convs.find((c) => c.messages.some((m) => m.id === 'a'));
    const convB = convs.find((c) => c.messages.some((m) => m.id === 'b'));
    expect(convA.hasReply).toBe(true);
    expect(convB.hasReply).toBeFalsy();
  });

  it('sets hasReply from the reply index when the flag is absent', () => {
    const unflagged = msg({ id: 'a' });
    const targets = new Set(['<a@example.com>']);
    const [conv] = groupOne([unflagged], targets);
    expect(conv.hasReply).toBe(true);
  });

  it('honours a lowercase \\answered flag as delivered by some servers', () => {
    const answered = msg({ id: 'a', flags: ['\\seen', '\\answered'] });
    const targets = new Set(['<zzz@example.com>']);
    const [conv] = groupOne([answered], targets);
    expect(conv.hasReply).toBe(true);
  });

  it('counts Sent replies from the index into messageCount', () => {
    const original = msg({ id: 'a' });
    const reply = {
      id: 'sent-1',
      header_message_id: '<sent-1@example.com>',
      in_reply_to: '<a@example.com>',
      folder: 'Sent',
      date: 1_700_000_100_000,
      dateMs: 1_700_000_100_000,
      flags: ['\\Seen'],
    };
    const targets = new Set(['<a@example.com>']);
    const index = new Map([['<a@example.com>', [reply]]]);
    const [conv] = groupOne([original], targets, index);
    expect(conv.messageCount).toBe(2);
    expect(conv.hasReply).toBe(true);
  });
});
