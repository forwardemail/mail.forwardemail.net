import { describe, it, expect } from 'vitest';
import { parseReferences } from '../../src/utils/threading';

/**
 * Tests for reply email threading — ensures In-Reply-To and References
 * headers are built correctly per RFC 2822 when replying to messages.
 */
describe('Reply threading — References header construction', () => {
  /**
   * Helper that mirrors the logic in mailboxActions.ts replyTo()
   * for building the References header from a parent message.
   */
  function buildReferences(msg) {
    const inReplyTo =
      msg?.message_id || msg?.messageId || msg?.header_message_id || msg?.headerMessageId || '';

    const parentRefs = parseReferences(msg?.references || msg?.References);
    const normalizedInReplyTo = inReplyTo
      ? inReplyTo.startsWith('<')
        ? inReplyTo
        : `<${inReplyTo}>`
      : '';
    const refsArray = [...parentRefs];
    if (normalizedInReplyTo && !refsArray.includes(normalizedInReplyTo)) {
      refsArray.push(normalizedInReplyTo);
    }
    return refsArray.join(' ');
  }

  it('should build references from a message with no prior references', () => {
    const msg = {
      message_id: '<abc123@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<abc123@example.com>');
  });

  it('should append message_id to existing references chain', () => {
    const msg = {
      message_id: '<msg3@example.com>',
      references: '<msg1@example.com> <msg2@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<msg1@example.com> <msg2@example.com> <msg3@example.com>');
  });

  it('should not duplicate message_id if already in references', () => {
    const msg = {
      message_id: '<msg2@example.com>',
      references: '<msg1@example.com> <msg2@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<msg1@example.com> <msg2@example.com>');
  });

  it('should add angle brackets to bare message_id', () => {
    const msg = {
      message_id: 'bare-id@example.com',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<bare-id@example.com>');
  });

  it('should handle message with empty references', () => {
    const msg = {
      message_id: '<first@example.com>',
      references: '',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<first@example.com>');
  });

  it('should handle message with null references', () => {
    const msg = {
      message_id: '<first@example.com>',
      references: null,
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<first@example.com>');
  });

  it('should handle message with no message_id', () => {
    const msg = {
      references: '<msg1@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<msg1@example.com>');
  });

  it('should handle completely empty message', () => {
    const msg = {};
    const refs = buildReferences(msg);
    expect(refs).toBe('');
  });

  it('should handle null message', () => {
    const refs = buildReferences(null);
    expect(refs).toBe('');
  });

  it('should build a long thread chain correctly', () => {
    const msg = {
      message_id: '<msg5@example.com>',
      references: '<msg1@example.com> <msg2@example.com> <msg3@example.com> <msg4@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe(
      '<msg1@example.com> <msg2@example.com> <msg3@example.com> <msg4@example.com> <msg5@example.com>',
    );
  });

  it('should prefer message_id over messageId', () => {
    const msg = {
      message_id: '<preferred@example.com>',
      messageId: '<fallback@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<preferred@example.com>');
  });

  it('should fall back to header_message_id', () => {
    const msg = {
      header_message_id: '<header@example.com>',
    };
    const refs = buildReferences(msg);
    expect(refs).toBe('<header@example.com>');
  });
});

describe('parseReferences', () => {
  it('should parse space-separated message IDs', () => {
    const result = parseReferences('<a@b.com> <c@d.com>');
    expect(result).toEqual(['<a@b.com>', '<c@d.com>']);
  });

  it('should return empty array for null', () => {
    expect(parseReferences(null)).toEqual([]);
  });

  it('should return empty array for undefined', () => {
    expect(parseReferences(undefined)).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    expect(parseReferences('')).toEqual([]);
  });

  it('should pass through arrays', () => {
    const arr = ['<a@b.com>', '<c@d.com>'];
    expect(parseReferences(arr)).toBe(arr);
  });

  it('should handle single reference', () => {
    expect(parseReferences('<single@example.com>')).toEqual(['<single@example.com>']);
  });
});
