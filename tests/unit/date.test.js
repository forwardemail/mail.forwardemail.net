import { describe, it, expect } from 'vitest';
import { formatFriendlyDate } from '../../src/utils/date';

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
