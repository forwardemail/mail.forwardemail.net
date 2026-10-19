import { describe, expect, it } from 'vitest';
import { reuseUnchangedRows, sameReplyIndex } from '../../src/stores/mailbox-store-helpers';

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  folder: 'INBOX',
  subject: `Subject ${id}`,
  is_unread: false,
  flags: ['\\Seen'],
  labels: [],
  ...extra,
});

describe('reuseUnchangedRows', () => {
  it('keeps the previous array when a refresh brings the same mail', () => {
    const prev = [row('a'), row('b')];
    // New objects from the network or the cache, same content
    expect(reuseUnchangedRows(prev, [row('a'), row('b')])).toBe(prev);
  });

  it('keeps unchanged row objects and takes the changed one', () => {
    const prev = [row('a'), row('b')];
    const next = reuseUnchangedRows(prev, [row('a'), row('b', { is_unread: true })]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next[1].is_unread).toBe(true);
  });

  it('notices changes inside flags and labels', () => {
    const prev = [row('a')];
    expect(reuseUnchangedRows(prev, [row('a', { flags: ['\\Seen', '\\Flagged'] })])[0]).not.toBe(
      prev[0],
    );
    expect(reuseUnchangedRows(prev, [row('a', { labels: ['work'] })])[0]).not.toBe(prev[0]);
  });

  it('ignores fields nothing on screen reads, such as updatedAt', () => {
    const prev = [row('a', { updatedAt: 1 })];
    expect(reuseUnchangedRows(prev, [row('a', { updatedAt: 2 })])).toBe(prev);
  });

  it('follows the new order and membership', () => {
    const prev = [row('a'), row('b')];
    const next = reuseUnchangedRows(prev, [row('c'), row('a')]);
    expect(next.map((m) => m.id)).toEqual(['c', 'a']);
    expect(next[1]).toBe(prev[0]);
  });
});

describe('sameReplyIndex', () => {
  it('compares targets and the reply ids under each', () => {
    const targets = new Set(['<x>']);
    const index = new Map([['<x>', [{ id: 's1' }]]]);
    expect(
      sameReplyIndex(targets, index, new Set(['<x>']), new Map([['<x>', [{ id: 's1' }]]])),
    ).toBe(true);
    expect(
      sameReplyIndex(targets, index, new Set(['<x>']), new Map([['<x>', [{ id: 's2' }]]])),
    ).toBe(false);
    expect(sameReplyIndex(targets, index, new Set(['<y>']), index)).toBe(false);
  });
});
