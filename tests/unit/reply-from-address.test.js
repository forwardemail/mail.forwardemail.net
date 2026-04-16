/**
 * Tests for reply "From" address resolution.
 *
 * When replying to a message, the From address must be the user's own
 * account that received the original message (found in To/CC), NOT the
 * sender's address.  Using the sender's address causes the SMTP API to
 * reject with "From header must be equal to ..." errors, especially
 * when replying from a secondary/alias account.
 *
 * These tests verify the address-matching logic extracted from
 * mailboxActions.ts replyTo().
 */

import { describe, it, expect } from 'vitest';
import { normalizeEmail, extractAddressList } from '../../src/utils/address.ts';

/**
 * Determines the correct "from" address for a reply by matching the
 * original message's To/CC recipients against the user's own accounts.
 *
 * This mirrors the logic added to replyTo() in mailboxActions.ts.
 *
 * @param {object} msg - The original message being replied to
 * @param {Set<string>} selfEmails - Set of the user's own email addresses (normalized)
 * @param {string} fallback - Fallback email if no match found
 * @returns {string} The email address to use as From
 */
function computeReplyFromAddress(msg, selfEmails, fallback = '') {
  const toList = extractAddressList(msg, 'to');
  const ccList = extractAddressList(msg, 'cc');
  const allRecipients = [...toList, ...ccList];
  for (const addr of allRecipients) {
    const email = normalizeEmail(addr);
    if (email && selfEmails.has(email)) {
      return email;
    }
  }
  return fallback;
}

describe('computeReplyFromAddress', () => {
  const selfEmails = new Set(['ben@primary.com', 'ben@deliberategentleman.com']);

  it('returns the secondary account when message was sent to it', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'ben@deliberategentleman.com',
      cc: '',
    };
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('ben@deliberategentleman.com');
  });

  it('returns the primary account when message was sent to it', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'ben@primary.com',
      cc: '',
    };
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('ben@primary.com');
  });

  it('finds the user address in CC when not in To', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'someone-else@example.com',
      cc: 'ben@deliberategentleman.com',
    };
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('ben@deliberategentleman.com');
  });

  it('returns fallback when no user address found in To/CC', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'unknown@other.com',
      cc: '',
    };
    expect(computeReplyFromAddress(msg, selfEmails, 'ben@primary.com')).toBe('ben@primary.com');
  });

  it('does NOT return the sender address as from', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'ben@deliberategentleman.com',
      cc: '',
    };
    const result = computeReplyFromAddress(msg, selfEmails);
    expect(result).not.toBe('alice@example.com');
    expect(result).toBe('ben@deliberategentleman.com');
  });

  it('handles multiple recipients and picks the first matching user account', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'ben@deliberategentleman.com, ben@primary.com',
      cc: '',
    };
    // Should pick the first match in To
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('ben@deliberategentleman.com');
  });

  it('handles address objects with name and address fields', () => {
    const msg = {
      from: { name: 'Alice', address: 'alice@example.com' },
      to: [{ name: 'Ben', address: 'ben@deliberategentleman.com' }],
      cc: [],
    };
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('ben@deliberategentleman.com');
  });

  it('handles case-insensitive email matching', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'Ben@DELIBERATEGENTLEMAN.COM',
      cc: '',
    };
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('ben@deliberategentleman.com');
  });

  it('returns empty string when no match and no fallback', () => {
    const msg = {
      from: 'alice@example.com',
      to: 'stranger@unknown.com',
      cc: '',
    };
    expect(computeReplyFromAddress(msg, selfEmails)).toBe('');
  });
});
