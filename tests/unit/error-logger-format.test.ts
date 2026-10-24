/**
 * error-logger: console.error arguments reached support reports through
 * String(), so an event logged by the CSP handler showed up as
 * "[object SecurityPolicyViolationEvent]" and an error lost its stack.
 */
import { describe, expect, it } from 'vitest';

import { formatConsoleArg } from '../../src/utils/error-logger.ts';

describe('formatConsoleArg', () => {
  it('keeps strings as they are', () => {
    expect(formatConsoleArg('Sync failed')).toBe('Sync failed');
  });

  it('includes the name, message and stack of an error', () => {
    const error = new TypeError('bad thing');
    const text = formatConsoleArg(error);
    expect(text.startsWith('TypeError: bad thing')).toBe(true);
    expect(text.split('\n').length).toBeGreaterThan(1);
  });

  it('adds the message to a WebKit-style stack of frames only', () => {
    const error = new Error('lost');
    error.stack = 'load@tauri://localhost/assets/index.js:1:2';
    expect(formatConsoleArg(error)).toBe('Error: lost\nload@tauri://localhost/assets/index.js:1:2');
  });

  it('describes an event by its type and fields instead of [object Event]', () => {
    const event = new Event('securitypolicyviolation');
    Object.assign(event, {
      effectiveDirective: 'connect-src',
      blockedURI: 'https://example.invalid',
    });
    const text = formatConsoleArg(event);
    expect(text).not.toContain('[object');
    expect(text).toContain('(securitypolicyviolation)');
    expect(text).toContain('effectiveDirective=connect-src');
    expect(text).toContain('blockedURI=https://example.invalid');
  });

  it('describes objects shallowly and bounded', () => {
    const big = { folder: 'INBOX', count: 3, ok: false, rows: new Array(20_000).fill({}) };
    expect(formatConsoleArg(big)).toBe(
      '{"folder":"INBOX","count":3,"ok":false,"rows":Array(20000)}',
    );
    expect(formatConsoleArg(new Array(5))).toBe('Array(5)');
    const long = formatConsoleArg({ text: 'x'.repeat(10_000) });
    expect(long.length).toBeLessThan(300);
  });

  it('handles circular objects and other values', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(formatConsoleArg(circular)).toBe('{"name":"loop","self":{…}}');
    expect(formatConsoleArg(undefined)).toBe('undefined');
    expect(formatConsoleArg(42)).toBe('42');
  });
});
