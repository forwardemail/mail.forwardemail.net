import { describe, expect, it } from 'vitest';
import {
  normalizeFlagAction,
  normalizeIdentifier,
  normalizeStringList,
  normalizeUidList,
} from '../../src/utils/realtime-payload.js';

describe('realtime payload normalization', () => {
  it('reads UIDs from arrays, JSON strings and comma lists', () => {
    expect(normalizeUidList([3, '4', 3])).toEqual([3, 4]);
    expect(normalizeUidList('[5,6]')).toEqual([5, 6]);
    expect(normalizeUidList('7, 8')).toEqual([7, 8]);
    expect(normalizeUidList(9)).toEqual([9]);
  });

  it('drops anything that is not a positive integer UID', () => {
    expect(normalizeUidList([0, -1, 1.5, 'x', null, {}, [], Number.MAX_VALUE, 2])).toEqual([2]);
    expect(normalizeUidList('[not json')).toEqual([]);
    expect(normalizeUidList({ uids: [1] })).toEqual([]);
    expect(normalizeUidList(undefined)).toEqual([]);
  });

  it('caps the number of UIDs', () => {
    const many = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(normalizeUidList(many, 10)).toEqual(many.slice(0, 10));
  });

  it('reads string lists and bounds each entry', () => {
    expect(normalizeStringList(['\\Seen', ' \\Flagged ', '', '\\Seen', 7])).toEqual([
      '\\Seen',
      '\\Flagged',
      '7',
    ]);
    expect(normalizeStringList('["\\\\Seen"]')).toEqual(['\\Seen']);
    expect(normalizeStringList(['x'.repeat(300)])).toEqual([]);
    expect(normalizeStringList([{ flag: 'x' }])).toEqual([]);
  });

  it('accepts only known flag actions', () => {
    expect(normalizeFlagAction('add')).toBe('add');
    expect(normalizeFlagAction('set')).toBe('set');
    expect(normalizeFlagAction('ADD')).toBe('');
    expect(normalizeFlagAction(['add'])).toBe('');
  });

  it('reads identifiers as bounded strings', () => {
    expect(normalizeIdentifier(' INBOX ')).toBe('INBOX');
    expect(normalizeIdentifier(12)).toBe('12');
    expect(normalizeIdentifier({ path: 'INBOX' })).toBe('');
    expect(normalizeIdentifier('a'.repeat(2000))).toBe('');
  });
});
