import { describe, it, expect } from 'vitest';
import { formatFriendlyDate, formatReaderDate, toDate } from '../../src/utils/date';

describe('toDate', () => {
  // 2000-08-02T03:12:24Z. In milliseconds this is below 1e12, which is
  // 2001-09-09T01:46:40Z, so it must not be mistaken for seconds.
  const ms2000 = Date.UTC(2000, 7, 2, 3, 12, 24);

  it('reads millisecond timestamps before September 2001 as milliseconds', () => {
    expect(toDate(ms2000).toISOString()).toBe('2000-08-02T03:12:24.000Z');
    expect(toDate(String(ms2000)).toISOString()).toBe('2000-08-02T03:12:24.000Z');
  });

  it('still reads second timestamps as seconds', () => {
    expect(toDate(ms2000 / 1000).toISOString()).toBe('2000-08-02T03:12:24.000Z');
    expect(toDate(1764867568).toISOString()).toBe('2025-12-04T16:59:28.000Z');
  });

  it('reads current millisecond timestamps as milliseconds', () => {
    expect(toDate(1764867568000).toISOString()).toBe('2025-12-04T16:59:28.000Z');
  });

  it('formats an old message in its real year', () => {
    expect(formatReaderDate(ms2000)).toMatch(/2000/);
  });
});

describe('formatFriendlyDate', () => {
  const base = new Date('2025-12-04T16:59:28Z'); // Thu

  it('formats today as time only', () => {
    const now = new Date(base);
    expect(formatFriendlyDate(base, now)).toMatch(/\d{1,2}:\d{2}\s[AP]M/);
  });

  it('formats yesterday with label', () => {
    const yesterday = new Date('2025-12-03T16:00:00Z');
    const now = new Date('2025-12-04T10:00:00Z');
    expect(formatFriendlyDate(yesterday, now)).toMatch(/Yesterday .*M/);
  });

  it('falls back to full date for older days', () => {
    const older = new Date('2025-11-30T10:00:00Z');
    const now = new Date('2025-12-04T10:00:00Z');
    const formatted = formatFriendlyDate(older, now);
    expect(formatted).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it('returns raw string for unparseable string input', () => {
    expect(formatFriendlyDate('not-a-date')).toBe('not-a-date');
  });
});
