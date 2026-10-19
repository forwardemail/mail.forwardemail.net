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

  it('hides a moved row only in the folder it left', () => {
    const t = createPendingDeleteTracker();
    t.add(['a'], { sourceFolder: 'INBOX' });
    // The stale copy in INBOX (server indexer lag) stays hidden
    expect(
      t.filter([
        { id: 'a', folder: 'INBOX' },
        { id: 'b', folder: 'INBOX' },
      ]),
    ).toEqual([{ id: 'b', folder: 'INBOX' }]);
    // Case differences in the folder path do not matter
    expect(t.filter([{ id: 'a', folder: 'inbox' }])).toEqual([]);
    // The copy in the folder it moved to shows
    expect(t.filter([{ id: 'a', folder: 'Archive' }])).toEqual([{ id: 'a', folder: 'Archive' }]);
  });

  it('uses the list folder for rows that do not name one', () => {
    const t = createPendingDeleteTracker();
    t.add(['a'], { sourceFolder: 'INBOX' });
    expect(t.filter([{ id: 'a' }], 'INBOX')).toEqual([]);
    expect(t.filter([{ id: 'a' }], 'Archive')).toEqual([{ id: 'a' }]);
  });

  it('hides a deleted row (no source folder) everywhere', () => {
    const t = createPendingDeleteTracker();
    t.add(['a']);
    expect(t.filter([{ id: 'a', folder: 'Trash' }])).toEqual([]);
  });

  it('is not dropped because a list lacks the id', () => {
    // A page 2 load, a filtered query or another folder all lack the id while
    // the server still lists it in the source folder. Only time ends an entry.
    const clock = makeClock(0);
    const t = createPendingDeleteTracker({ now: clock.now, ttl: 10_000, settleGrace: 1000 });
    t.add(['a'], { sourceFolder: 'INBOX' });
    t.filter([{ id: 'other', folder: 'INBOX' }], 'INBOX');
    expect(t.getIds()).toEqual(['a']);
  });

  it('expires a settled entry after the grace window, counted from settle', () => {
    const clock = makeClock(0);
    const t = createPendingDeleteTracker({ now: clock.now, ttl: 10_000, settleGrace: 1000 });
    t.add(['a'], { sourceFolder: 'INBOX' });
    clock.advance(5000); // a slow request: the grace starts when the server answers
    t.settle(['a']);
    clock.advance(1000);
    expect(t.getIds()).toEqual(['a']);
    clock.advance(1);
    expect(t.getIds()).toEqual([]);
  });

  it('keeps an unsettled (queued) entry for the full TTL', () => {
    const clock = makeClock(0);
    const t = createPendingDeleteTracker({ now: clock.now, ttl: 10_000, settleGrace: 1000 });
    t.add(['a'], { sourceFolder: 'INBOX' });
    clock.advance(5000);
    expect(t.getIds()).toEqual(['a']);
    clock.advance(5001);
    expect(t.getIds()).toEqual([]);
  });

  it('shows a moved row in the target folder until the server lists it there', () => {
    const t = createPendingDeleteTracker();
    const row = { id: 'a', folder: 'Archive', dateMs: 200 };
    t.add(['a'], { sourceFolder: 'INBOX', targetFolder: 'Archive', row });
    const archive = [
      { id: 'x', folder: 'Archive', dateMs: 300 },
      { id: 'y', folder: 'Archive', dateMs: 100 },
    ];
    // In date order, newest first
    expect(t.withMovedIn(archive, 'Archive').map((m) => m.id)).toEqual(['x', 'a', 'y']);
    // Once the server reports it, the server's copy is used
    const indexed = [{ id: 'a', folder: 'Archive', dateMs: 200, uid: 9 }];
    expect(t.withMovedIn(indexed, 'Archive')).toBe(indexed);
    // Not added to other folders
    expect(t.withMovedIn([{ id: 'z', folder: 'INBOX', dateMs: 150 }], 'INBOX')).toHaveLength(1);
  });

  it('leaves a moved row out of a page it is older than', () => {
    const t = createPendingDeleteTracker();
    t.add(['a'], {
      sourceFolder: 'INBOX',
      targetFolder: 'Archive',
      row: { id: 'a', folder: 'Archive', dateMs: 50 },
    });
    const page1 = [
      { id: 'x', folder: 'Archive', dateMs: 300 },
      { id: 'y', folder: 'Archive', dateMs: 100 },
    ];
    expect(t.withMovedIn(page1, 'Archive')).toEqual(page1);
    // An empty folder shows it
    expect(t.withMovedIn([], 'Archive').map((m) => m.id)).toEqual(['a']);
  });

  it('a later move of the same message replaces its entry', () => {
    const t = createPendingDeleteTracker();
    t.add(['a'], { sourceFolder: 'INBOX' });
    // Moved back out of Archive: now the Archive copy is the stale one
    t.add(['a'], { sourceFolder: 'Archive' });
    expect(t.filter([{ id: 'a', folder: 'INBOX' }])).toEqual([{ id: 'a', folder: 'INBOX' }]);
    expect(t.filter([{ id: 'a', folder: 'Archive' }])).toEqual([]);
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

  it('keeps a label change and a read change on the same message together', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { labels: ['work'] });
    t.add('m1', { is_unread: false });
    const [out] = t.apply([{ id: 'm1', is_unread: true, labels: [] }]);
    expect(out).toMatchObject({ is_unread: false, labels: ['work'] });
  });

  it('confirm() keeps a merged change until the server reports every field', () => {
    const t = createPendingFlagTracker();
    t.add('m1', { labels: ['work'], is_unread: false });
    // Read state caught up, labels not yet
    t.confirm([{ id: 'm1', is_unread: false, labels: [] }]);
    expect(t.getIds()).toEqual(['m1']);
    // Labels compare as a set, case-insensitively, as the backend lowercases
    t.confirm([{ id: 'm1', is_unread: false, labels: ['Work'] }]);
    expect(t.getIds()).toEqual([]);
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

describe('createPendingFlagTracker answered flag', () => {
  it('re-applies is_answered and flags over a reloaded list until the server agrees', () => {
    const t = createPendingFlagTracker();
    t.add('a', { is_answered: true, flags: ['\\Seen', '\\Answered'] });
    const reloaded = [{ id: 'a', is_answered: false, flags: ['\\Seen'] }];
    expect(t.apply(reloaded)).toEqual([
      { id: 'a', is_answered: true, flags: ['\\Seen', '\\Answered'] },
    ]);
    t.confirm([{ id: 'a', is_answered: true, flags: ['\\Seen', '\\Answered'] }]);
    expect(t.apply(reloaded)).toBe(reloaded);
  });

  it('keeps overriding while the server still reports the message as unanswered', () => {
    const t = createPendingFlagTracker();
    t.add('a', { is_answered: true });
    t.confirm([{ id: 'a', is_answered: false }]);
    expect(t.apply([{ id: 'a', is_answered: false }])).toEqual([{ id: 'a', is_answered: true }]);
  });
});
