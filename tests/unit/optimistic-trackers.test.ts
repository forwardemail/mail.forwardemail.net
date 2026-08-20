import { describe, expect, it } from 'vitest';
import {
  createPendingDeleteTracker,
  createPendingFlagTracker,
  createPendingInsertTracker,
  PENDING_DELETE_TTL,
} from '../../src/stores/optimistic-trackers';

// A controllable clock so TTL expiry is deterministic without fake timers.
const makeClock = (start = 0) => {
  const c = { t: start };
  return { now: () => c.t, advance: (ms: number) => (c.t += ms), set: (ms: number) => (c.t = ms) };
};

describe('createPendingDeleteTracker', () => {
  it('filters out messages whose id is pending-deleted', () => {
    const t = createPendingDeleteTracker();
    t.add(['a', 'c']);
    const msgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(t.filter(msgs)).toEqual([{ id: 'b' }]);
  });

  it('returns the same array (no copy) when nothing is pending', () => {
    const t = createPendingDeleteTracker();
    const msgs = [{ id: 'a' }];
    expect(t.filter(msgs)).toBe(msgs);
  });

  it('ignores falsy ids on add', () => {
    const t = createPendingDeleteTracker();
    t.add(['', 'a']);
    expect(t.getIds()).toEqual(['a']);
  });

  it('expires entries after the TTL (pruned on filter/getIds)', () => {
    const clock = makeClock(1000);
    const t = createPendingDeleteTracker({ now: clock.now, ttl: 1000 });
    t.add(['a']);
    // still within TTL
    clock.advance(1000);
    expect(t.getIds()).toEqual(['a']);
    // now past TTL (elapsed 1001 > 1000)
    clock.advance(1);
    expect(t.getIds()).toEqual([]);
    expect(t.filter([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });

  it('confirm() drops ids the server no longer reports (processed), keeps the rest', () => {
    const t = createPendingDeleteTracker();
    t.add(['a', 'b']);
    t.confirm(new Set(['a'])); // server still shows 'a' -> keep; 'b' gone -> processed -> drop
    expect(t.getIds()).toEqual(['a']);
  });

  it('clear() removes everything', () => {
    const t = createPendingDeleteTracker();
    t.add(['a', 'b']);
    t.clear();
    expect(t.getIds()).toEqual([]);
  });

  it('cancel() stops suppressing a single id without waiting out the TTL', () => {
    const t = createPendingDeleteTracker();
    t.add(['a', 'b']);
    t.cancel('a');
    expect(t.getIds()).toEqual(['b']);
    expect(t.filter([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }]);
  });

  it('cancel() on an id that was never pending is a no-op', () => {
    const t = createPendingDeleteTracker();
    t.add(['a']);
    t.cancel('missing');
    expect(t.getIds()).toEqual(['a']);
  });

  it('exposes the shared 5-minute default TTL', () => {
    expect(PENDING_DELETE_TTL).toBe(5 * 60_000);
  });
});

describe('createPendingFlagTracker', () => {
  it('applies stored overrides onto matching messages and strips the internal ts', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_unread: false, flags: ['\\Seen'] });
    const [out] = t.apply([{ id: 'm1', is_unread: true, subject: 'x' }]);
    expect(out).toEqual({ id: 'm1', is_unread: false, flags: ['\\Seen'], subject: 'x' });
    expect(out).not.toHaveProperty('ts');
  });

  it('leaves non-matching messages untouched', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_starred: true });
    expect(t.apply([{ id: 'other', is_starred: false }])).toEqual([
      { id: 'other', is_starred: false },
    ]);
  });

  it('returns the same array when nothing is pending', () => {
    const t = createPendingFlagTracker();
    const msgs = [{ id: 'm1' }];
    expect(t.apply(msgs)).toBe(msgs);
  });

  it('ignores an empty id on add', () => {
    const t = createPendingFlagTracker();
    t.add('', { is_unread: false });
    const msgs = [{ id: '', is_unread: true }];
    // nothing was tracked, so apply is a no-op passthrough
    expect(t.apply(msgs)).toBe(msgs);
  });

  it('expires mutations after the TTL', () => {
    const clock = makeClock(1000);
    const t = createPendingFlagTracker({ now: clock.now, ttl: 1000 });
    t.add('m1', { is_unread: false });
    clock.advance(1001);
    // expired -> not applied
    expect(t.apply([{ id: 'm1', is_unread: true }])).toEqual([{ id: 'm1', is_unread: true }]);
  });

  it('confirm() drops a mutation once the server matches the optimistic is_unread', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_unread: false });
    t.confirm([{ id: 'm1', is_unread: false }]); // server caught up -> stop overriding
    expect(t.apply([{ id: 'm1', is_unread: true }])).toEqual([{ id: 'm1', is_unread: true }]);
  });

  it('confirm() drops a mutation once the server matches the optimistic is_starred', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_starred: true });
    t.confirm([{ id: 'm1', is_starred: true }]);
    expect(t.apply([{ id: 'm1', is_starred: false }])).toEqual([{ id: 'm1', is_starred: false }]);
  });

  it('confirm() keeps the mutation while the server still disagrees', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_unread: false });
    t.confirm([{ id: 'm1', is_unread: true }]); // server hasn't caught up
    const [out] = t.apply([{ id: 'm1', is_unread: true }]);
    expect(out.is_unread).toBe(false); // still overriding
  });

  it('clear() removes everything', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_unread: false });
    t.clear();
    expect(t.apply([{ id: 'm1', is_unread: true }])).toEqual([{ id: 'm1', is_unread: true }]);
  });

  it('cancel() stops overriding a single id without waiting out the TTL', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { is_unread: false });
    t.add('m2', { is_starred: true });
    t.cancel('m1');
    expect(t.apply([{ id: 'm1', is_unread: true }])).toEqual([{ id: 'm1', is_unread: true }]);
    expect(t.apply([{ id: 'm2', is_starred: false }])).toEqual([{ id: 'm2', is_starred: true }]);
  });
});

describe('createPendingInsertTracker', () => {
  it('re-injects a pending insert missing from the list, at the front', () => {
    const t = createPendingInsertTracker();
    t.add({ id: 'sent1', dateMs: 100, subject: 'hi' });
    const out = t.apply([{ id: 'a', dateMs: 50 }]);
    expect(out).toEqual([
      { id: 'sent1', dateMs: 100, subject: 'hi' },
      { id: 'a', dateMs: 50 },
    ]);
  });

  it('does not duplicate an insert the server now reports', () => {
    const t = createPendingInsertTracker();
    t.add({ id: 'sent1', dateMs: 100 });
    const server = [{ id: 'sent1', dateMs: 100, subject: 'authoritative' }];
    // Already present -> passthrough, no optimistic copy prepended.
    expect(t.apply(server)).toBe(server);
  });

  it('orders multiple pending inserts newest-first', () => {
    const t = createPendingInsertTracker();
    t.add({ id: 'older', dateMs: 100 });
    t.add({ id: 'newer', dateMs: 200 });
    const out = t.apply([{ id: 'a', dateMs: 50 }]);
    expect(out.map((m) => m.id)).toEqual(['newer', 'older', 'a']);
  });

  it('returns the same array (no copy) when nothing is pending', () => {
    const t = createPendingInsertTracker();
    const msgs = [{ id: 'a' }];
    expect(t.apply(msgs)).toBe(msgs);
  });

  it('ignores an entry with no id on add', () => {
    const t = createPendingInsertTracker();
    t.add({ dateMs: 1 });
    expect(t.getIds()).toEqual([]);
  });

  it('confirm() drops an insert once the server reports its id (mirror of delete)', () => {
    const t = createPendingInsertTracker();
    t.add({ id: 'sent1', dateMs: 100 });
    t.confirm(new Set(['sent1'])); // server now indexes it -> stop re-injecting
    expect(t.getIds()).toEqual([]);
    const msgs = [{ id: 'a' }];
    expect(t.apply(msgs)).toBe(msgs);
  });

  it('confirm() keeps an insert the server has not indexed yet', () => {
    const t = createPendingInsertTracker();
    t.add({ id: 'sent1', dateMs: 100 });
    t.confirm(new Set(['other'])); // server hasn't caught up
    expect(t.getIds()).toEqual(['sent1']);
  });

  it('expires inserts after the TTL', () => {
    const clock = makeClock(1000);
    const t = createPendingInsertTracker({ now: clock.now, ttl: 1000 });
    t.add({ id: 'sent1', dateMs: 100 });
    clock.advance(1001);
    expect(t.getIds()).toEqual([]);
    const msgs = [{ id: 'a' }];
    expect(t.apply(msgs)).toBe(msgs);
  });

  it('clear() removes everything', () => {
    const t = createPendingInsertTracker();
    t.add({ id: 'sent1', dateMs: 100 });
    t.clear();
    expect(t.getIds()).toEqual([]);
  });
});
