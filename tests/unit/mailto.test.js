import { describe, it, expect } from 'vitest';
import { parseMailto, mailtoToPrefill } from '../../src/utils/mailto.js';

describe('parseMailto', () => {
  it('returns defaults for empty input', () => {
    const result = parseMailto('');
    expect(result.to).toEqual([]);
    expect(result.cc).toEqual([]);
    expect(result.bcc).toEqual([]);
    expect(result.subject).toBe('');
    expect(result.body).toBe('');
  });

  it('parses simple mailto with one recipient', () => {
    const result = parseMailto('mailto:alice@example.com');
    expect(result.to).toEqual(['alice@example.com']);
  });

  it('parses mailto without scheme prefix', () => {
    const result = parseMailto('alice@example.com');
    expect(result.to).toEqual(['alice@example.com']);
  });

  it('parses subject and body query params', () => {
    const result = parseMailto('mailto:alice@x.com?subject=Hello&body=World');
    expect(result.to).toEqual(['alice@x.com']);
    expect(result.subject).toBe('Hello');
    expect(result.body).toBe('World');
  });

  it('handles URL-encoded values', () => {
    const result = parseMailto('mailto:alice@x.com?subject=Hello%20World&body=Line%201');
    expect(result.subject).toBe('Hello World');
    expect(result.body).toBe('Line 1');
  });

  it('parses cc and bcc', () => {
    const result = parseMailto('mailto:alice@x.com?cc=bob@x.com&bcc=carol@x.com');
    expect(result.to).toEqual(['alice@x.com']);
    expect(result.cc).toEqual(['bob@x.com']);
    expect(result.bcc).toEqual(['carol@x.com']);
  });

  it('parses multiple to recipients via query param', () => {
    const result = parseMailto('mailto:alice@x.com?to=bob@x.com');
    expect(result.to).toContain('alice@x.com');
    expect(result.to).toContain('bob@x.com');
  });

  it('deduplicates addresses', () => {
    const result = parseMailto('mailto:alice@x.com?to=alice@x.com');
    expect(result.to).toHaveLength(1);
  });

  it('parses comma-separated addresses', () => {
    const result = parseMailto('mailto:alice@x.com,bob@x.com');
    expect(result.to).toHaveLength(2);
  });

  it('parses reply-to and in-reply-to', () => {
    const result = parseMailto('mailto:a@x.com?reply-to=reply@x.com&in-reply-to=%3Cmsg123%3E');
    expect(result.replyTo).toBe('reply@x.com');
    expect(result.inReplyTo).toBe('<msg123>');
  });

  it('stores unknown params in other', () => {
    const result = parseMailto('mailto:a@x.com?x-custom=value');
    expect(result.other['x-custom']).toEqual(['value']);
  });

  it('preserves raw input', () => {
    const input = 'mailto:test@example.com';
    expect(parseMailto(input).raw).toBe(input);
  });
});

describe('mailtoToPrefill', () => {
  it('converts parsed mailto to compose prefill', () => {
    const parsed = parseMailto('mailto:alice@x.com?subject=Test&body=Content&cc=bob@x.com');
    const prefill = mailtoToPrefill(parsed);
    expect(prefill.to).toEqual(['alice@x.com']);
    expect(prefill.cc).toEqual(['bob@x.com']);
    expect(prefill.subject).toBe('Test');
    expect(prefill.text).toBe('Content');
    expect(prefill.body).toBe('Content');
  });

  it('returns defaults for empty parsed object', () => {
    const prefill = mailtoToPrefill({});
    expect(prefill.to).toEqual([]);
    expect(prefill.cc).toEqual([]);
    expect(prefill.bcc).toEqual([]);
    expect(prefill.subject).toBe('');
    expect(prefill.text).toBe('');
  });
});
