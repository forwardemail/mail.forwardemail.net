import {
  createUnreadDeltas,
  isCompleteUnreadListing,
  needsUnreadReconcile,
  planUnreadReconcile,
  RECONCILE_MAX_UNREAD,
  UNREAD_DELTA_TTL_MS,
} from '../../src/stores/folder-unread';

const ME = 'me@test.com';

const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, tick: (ms = 1) => (t += ms) };
};

describe('unread badge', () => {
  it('is the server count, moved by reads made here until the server has them', () => {
    const c = clock();
    const deltas = createUnreadDeltas({ now: c.now });
    expect(deltas.adjust(ME, 'INBOX', { server: 37, fetchedAt: c.now() })).toBe(37);

    deltas.read(ME, 'm1', 'INBOX', false);
    deltas.read(ME, 'm2', 'INBOX', false);
    c.tick();
    // A list fetched while the reads were on their way still says 37.
    expect(deltas.adjust(ME, 'INBOX', { server: 37, fetchedAt: c.now() })).toBe(35);

    deltas.settle(ME, 'm1');
    deltas.settle(ME, 'm2');
    c.tick();
    // The next list counts them; they are not taken off twice.
    expect(deltas.adjust(ME, 'INBOX', { server: 35, fetchedAt: c.now() })).toBe(35);
  });

  it('does not move when cached history changes, only when this device acts', () => {
    const deltas = createUnreadDeltas();
    // Nothing noted: whatever sync writes, the badge is the server count.
    expect(deltas.adjust(ME, 'INBOX', { server: 37, fetchedAt: 5 })).toBe(37);
  });

  it('counts a read then unread of the same message once', () => {
    const deltas = createUnreadDeltas();
    deltas.read(ME, 'm1', 'INBOX', false);
    deltas.read(ME, 'm1', 'INBOX', true);
    expect(deltas.adjust(ME, 'INBOX', { server: 10, fetchedAt: 0 })).toBe(10);
  });

  it('moves an unread message from one badge to the other, and a delete takes it off', () => {
    const deltas = createUnreadDeltas();
    deltas.move(ME, 'm1', 'INBOX', 'Archive', true);
    deltas.move(ME, 'm2', 'INBOX', null, true);
    deltas.move(ME, 'm3', 'INBOX', 'Archive', false);
    expect(deltas.adjust(ME, 'INBOX', { server: 10, fetchedAt: 0 })).toBe(8);
    expect(deltas.adjust(ME, 'Archive', { server: 0, fetchedAt: 0 })).toBe(1);
  });

  it('keeps a change in a list read back from the cache', () => {
    const c = clock();
    const deltas = createUnreadDeltas({ now: c.now });
    deltas.read(ME, 'm1', 'INBOX', false);
    deltas.settle(ME, 'm1');
    // The cached list's time is unknown, so it may predate the read.
    expect(deltas.adjust(ME, 'INBOX', { server: 4, fetchedAt: 0 })).toBe(3);
  });

  it('forgets a change rolled back after it failed', () => {
    const deltas = createUnreadDeltas();
    deltas.read(ME, 'm1', 'INBOX', false);
    deltas.drop(ME, 'm1');
    expect(deltas.adjust(ME, 'INBOX', { server: 4, fetchedAt: 0 })).toBe(4);
  });

  it('forgets changes the server never confirmed after a while', () => {
    const c = clock();
    const deltas = createUnreadDeltas({ now: c.now });
    deltas.read(ME, 'm1', 'INBOX', false);
    c.tick(UNREAD_DELTA_TTL_MS + 1);
    expect(deltas.adjust(ME, 'INBOX', { server: 4, fetchedAt: 0 })).toBe(4);
  });

  it('lists the changes still on their way', () => {
    const deltas = createUnreadDeltas();
    deltas.read(ME, 'm1', 'INBOX', false);
    deltas.read(ME, 'm2', 'INBOX', false);
    deltas.settle(ME, 'm2');
    expect(deltas.unsettledIds(ME)).toEqual(['m1']);
  });

  it('stays between zero and the folder total', () => {
    const deltas = createUnreadDeltas();
    deltas.read(ME, 'm1', 'INBOX', false);
    expect(deltas.adjust(ME, 'INBOX', { server: 0, fetchedAt: 0 })).toBe(0);
    deltas.read(ME, 'm2', 'INBOX', true);
    deltas.read(ME, 'm3', 'INBOX', true);
    expect(deltas.adjust(ME, 'INBOX', { server: 5, fetchedAt: 0, total: 5 })).toBe(5);
  });

  it('keeps accounts apart', () => {
    const deltas = createUnreadDeltas();
    deltas.read('other@test.com', 'm1', 'INBOX', false);
    expect(deltas.adjust(ME, 'INBOX', { server: 37, fetchedAt: 0 })).toBe(37);
    expect(deltas.adjust('other@test.com', 'INBOX', { server: 4, fetchedAt: 0 })).toBe(3);
  });

  it('treats INBOX in any case as the same folder when told to', () => {
    const deltas = createUnreadDeltas({
      samePath: (a, b) => a === b || (a.toUpperCase() === 'INBOX' && b.toUpperCase() === 'INBOX'),
    });
    deltas.read(ME, 'm1', 'Inbox', false);
    expect(deltas.adjust(ME, 'INBOX', { server: 2, fetchedAt: 0 })).toBe(1);
  });
});

describe('unread listing', () => {
  it('is only complete when it adds up to the count', () => {
    expect(isCompleteUnreadListing(37, 37)).toBe(true);
    expect(isCompleteUnreadListing(0, 37)).toBe(false);
    expect(isCompleteUnreadListing(36, 37)).toBe(false);
    expect(isCompleteUnreadListing(0, 0)).toBe(true);
  });
});

describe('which folders to check against the server', () => {
  it('checks a folder with more unread cached than the server has', () => {
    expect(needsUnreadReconcile({ server: 37, local: 14127, selected: false })).toBe(true);
  });

  it('only checks fewer cached unread in the folder that is open', () => {
    expect(needsUnreadReconcile({ server: 37, local: 12, selected: false })).toBe(false);
    expect(needsUnreadReconcile({ server: 37, local: 12, selected: true })).toBe(true);
    expect(needsUnreadReconcile({ server: 37, local: 37, selected: true })).toBe(false);
  });

  it('skips a folder with too many unread to list', () => {
    expect(
      needsUnreadReconcile({ server: RECONCILE_MAX_UNREAD + 1, local: 14127, selected: true }),
    ).toBe(false);
  });
});

describe('reconcile plan', () => {
  it('reads what the server has read and unreads what it has unread, except pending ids', () => {
    const plan = planUnreadReconcile({
      localUnreadIds: ['a', 'b', 'c'],
      serverUnreadIds: new Set(['c', 'd', 'e']),
      skip: new Set(['b', 'e']),
    });
    expect(plan).toEqual({ markRead: ['a'], markUnread: ['d'] });
  });
});
