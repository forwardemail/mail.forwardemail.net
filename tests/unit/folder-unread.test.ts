import { describe, expect, it } from 'vitest';
import {
  createUnreadAnchors,
  needsUnreadReconcile,
  planUnreadReconcile,
  RECONCILE_MAX_UNREAD,
} from '../../src/stores/folder-unread';

const ME = 'me@test.com';

describe('unread badge', () => {
  it('is the server count, moved by reads and unreads made here', () => {
    const anchors = createUnreadAnchors();
    // Server says 37; this device has 12 of them cached.
    expect(anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 12 })).toBe(37);
    // Two read here.
    expect(anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 10 })).toBe(35);
    // The next folder list already counts those two.
    expect(anchors.display(ME, 'INBOX', { server: 35, at: 2, local: 10 })).toBe(35);
  });

  it('ignores older history that sync caches', () => {
    const anchors = createUnreadAnchors();
    anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 12 });
    anchors.rebase(ME, 'INBOX', 400);
    expect(anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 400 })).toBe(37);
    // A read after that still counts.
    expect(anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 399 })).toBe(36);
  });

  it('stays between zero and the folder total', () => {
    const anchors = createUnreadAnchors();
    anchors.display(ME, 'INBOX', { server: 3, at: 1, local: 10 });
    expect(anchors.display(ME, 'INBOX', { server: 3, at: 1, local: 0 })).toBe(0);
    expect(anchors.display(ME, 'INBOX', { server: 3, at: 1, local: 20, total: 5 })).toBe(5);
  });

  it('keeps accounts apart', () => {
    const anchors = createUnreadAnchors();
    anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 12 });
    expect(anchors.display('other@test.com', 'INBOX', { server: 4, at: 1, local: 4 })).toBe(4);
    anchors.rebase('other@test.com', 'INBOX', 100);
    expect(anchors.display(ME, 'INBOX', { server: 37, at: 1, local: 12 })).toBe(37);
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
