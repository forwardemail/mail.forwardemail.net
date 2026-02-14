import { describe, it, expect } from 'vitest';
import {
  sortMessages,
  sortConversations,
  normalizeSortDate,
  normalizeSortUid,
  getMessageUidValue,
} from '../../src/utils/message-sort.ts';

describe('normalizeSortDate', () => {
  it('returns 0 for null/undefined', () => {
    expect(normalizeSortDate(null)).toBe(0);
    expect(normalizeSortDate(undefined)).toBe(0);
  });

  it('converts Date object to timestamp', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    expect(normalizeSortDate(d)).toBe(d.getTime());
  });

  it('converts ISO string to timestamp', () => {
    const ts = normalizeSortDate('2024-06-15T12:00:00Z');
    expect(ts).toBe(new Date('2024-06-15T12:00:00Z').getTime());
  });

  it('converts epoch seconds to milliseconds', () => {
    const epochSec = 1718452800; // < 10 billion, treated as seconds
    expect(normalizeSortDate(epochSec)).toBe(epochSec * 1000);
  });

  it('keeps epoch milliseconds as-is', () => {
    const epochMs = 1718452800000; // > 10 billion, already ms
    expect(normalizeSortDate(epochMs)).toBe(epochMs);
  });

  it('returns 0 for invalid strings', () => {
    expect(normalizeSortDate('not-a-date')).toBe(0);
  });
});

describe('normalizeSortUid', () => {
  it('returns number as-is', () => {
    expect(normalizeSortUid(42)).toBe(42);
  });

  it('parses numeric strings', () => {
    expect(normalizeSortUid('123')).toBe(123);
  });

  it('returns null for non-numeric strings', () => {
    expect(normalizeSortUid('abc')).toBeNull();
    expect(normalizeSortUid('')).toBeNull();
    expect(normalizeSortUid('12.5')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(normalizeSortUid(null)).toBeNull();
    expect(normalizeSortUid(undefined)).toBeNull();
  });

  it('returns null for Infinity/NaN', () => {
    expect(normalizeSortUid(Infinity)).toBeNull();
    expect(normalizeSortUid(NaN)).toBeNull();
  });
});

describe('getMessageUidValue', () => {
  it('returns uid from message', () => {
    expect(getMessageUidValue({ uid: 42 })).toBe(42);
  });

  it('falls back through uid → Uid → id → message_id → messageId', () => {
    expect(getMessageUidValue({ Uid: 10 })).toBe(10);
    expect(getMessageUidValue({ id: 5 })).toBe(5);
    expect(getMessageUidValue({ message_id: 7 })).toBe(7);
    expect(getMessageUidValue({ messageId: 9 })).toBe(9);
  });

  it('returns null for null/undefined', () => {
    expect(getMessageUidValue(null)).toBeNull();
    expect(getMessageUidValue(undefined)).toBeNull();
  });
});

describe('sortMessages', () => {
  const msgs = [
    { id: 1, date: '2024-01-03', subject: 'Charlie', from: 'carol@x.com' },
    { id: 2, date: '2024-01-01', subject: 'Alpha', from: 'alice@x.com' },
    { id: 3, date: '2024-01-02', subject: 'Bravo', from: 'bob@x.com' },
  ];

  it('sorts newest first by default', () => {
    const sorted = sortMessages([...msgs]);
    expect(sorted[0].id).toBe(1);
    expect(sorted[2].id).toBe(2);
  });

  it('sorts oldest first', () => {
    const sorted = sortMessages([...msgs], 'oldest');
    expect(sorted[0].id).toBe(2);
    expect(sorted[2].id).toBe(1);
  });

  it('sorts by subject', () => {
    const sorted = sortMessages([...msgs], 'subject');
    expect(sorted[0].subject).toBe('Alpha');
    expect(sorted[1].subject).toBe('Bravo');
    expect(sorted[2].subject).toBe('Charlie');
  });

  it('sorts by sender', () => {
    const sorted = sortMessages([...msgs], 'sender');
    expect(sorted[0].from).toBe('alice@x.com');
    expect(sorted[1].from).toBe('bob@x.com');
    expect(sorted[2].from).toBe('carol@x.com');
  });

  it('returns empty array for empty input', () => {
    expect(sortMessages([])).toEqual([]);
  });

  it('uses uid as tiebreaker for same date', () => {
    const sameDate = [
      { uid: 10, date: '2024-01-01' },
      { uid: 5, date: '2024-01-01' },
    ];
    const sorted = sortMessages(sameDate, 'newest');
    expect(sorted[0].uid).toBe(10);
    expect(sorted[1].uid).toBe(5);
  });
});

describe('sortConversations', () => {
  const convs = [
    { id: 'c1', latestDate: '2024-01-03', displaySubject: 'Zulu', latestFrom: 'carol@x.com' },
    { id: 'c2', latestDate: '2024-01-01', displaySubject: 'Alpha', latestFrom: 'alice@x.com' },
    { id: 'c3', latestDate: '2024-01-02', displaySubject: 'Mike', latestFrom: 'bob@x.com' },
  ];

  it('sorts newest first by default', () => {
    const sorted = sortConversations([...convs]);
    expect(sorted[0].id).toBe('c1');
    expect(sorted[2].id).toBe('c2');
  });

  it('sorts oldest first', () => {
    const sorted = sortConversations([...convs], 'oldest');
    expect(sorted[0].id).toBe('c2');
    expect(sorted[2].id).toBe('c1');
  });

  it('sorts by subject', () => {
    const sorted = sortConversations([...convs], 'subject');
    expect(sorted[0].displaySubject).toBe('Alpha');
    expect(sorted[2].displaySubject).toBe('Zulu');
  });

  it('sorts by sender (latestFrom)', () => {
    const sorted = sortConversations([...convs], 'sender');
    expect(sorted[0].latestFrom).toBe('alice@x.com');
    expect(sorted[2].latestFrom).toBe('carol@x.com');
  });
});
