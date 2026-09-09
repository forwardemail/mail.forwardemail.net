import { describe, it, expect } from 'vitest';
import { parseCalendarHashTarget, consumedCalendarHash } from '../../src/utils/calendar-hash';

describe('parseCalendarHashTarget', () => {
  it('reads event and task targets', () => {
    expect(parseCalendarHashTarget('#event=abc')).toEqual({ kind: 'event', id: 'abc' });
    expect(parseCalendarHashTarget('#task=t%2F1')).toEqual({ kind: 'task', id: 't/1' });
    expect(parseCalendarHashTarget('#EVENT=abc&x=1')).toEqual({ kind: 'event', id: 'abc' });
  });
  it('ignores section hashes and garbage', () => {
    expect(parseCalendarHashTarget('')).toBeNull();
    expect(parseCalendarHashTarget('#calendar')).toBeNull();
    expect(parseCalendarHashTarget('#tasks')).toBeNull();
    expect(parseCalendarHashTarget('#event=')).toBeNull();
  });
  it('keeps a malformed percent-encoding as-is', () => {
    expect(parseCalendarHashTarget('#event=%E0%A4%A')).toEqual({ kind: 'event', id: '%E0%A4%A' });
  });
});

describe('consumedCalendarHash', () => {
  it('replaces the target with the section hash so the view does not flip', () => {
    expect(consumedCalendarHash('calendar')).toBe('#calendar');
    expect(consumedCalendarHash('tasks')).toBe('#tasks');
  });
  it('yields a hash the parser no longer treats as a target', () => {
    expect(parseCalendarHashTarget(consumedCalendarHash('calendar'))).toBeNull();
    expect(parseCalendarHashTarget(consumedCalendarHash('tasks'))).toBeNull();
  });
});
