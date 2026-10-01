/**
 * Changes to a message's flags and labels are sent as what changed, next to
 * the whole list, so the server applies only the change and does not undo
 * what another client (Thunderbird, another device) did in the meantime.
 */
import { describe, expect, it } from 'vitest';
import {
  flagChangeBody,
  labelChangeBody,
  queuedToggleBody,
} from '../../src/utils/message-changes.ts';

describe('flagChangeBody', () => {
  it('sends the whole list and the change', () => {
    expect(flagChangeBody(['\\Seen', '\\Flagged'], { add: ['\\Seen'] })).toEqual({
      flags: ['\\Seen', '\\Flagged'],
      flags_add: ['\\Seen'],
    });
    expect(flagChangeBody(['\\Flagged'], { remove: ['\\Seen'] })).toEqual({
      flags: ['\\Flagged'],
      flags_remove: ['\\Seen'],
    });
  });

  it('leaves out an empty change', () => {
    expect(flagChangeBody(['\\Seen'])).toEqual({ flags: ['\\Seen'] });
    expect(flagChangeBody(undefined, { add: [], remove: [] })).toEqual({ flags: [] });
  });
});

describe('labelChangeBody', () => {
  it('sends the labels added and removed, as stored (lowercase)', () => {
    expect(labelChangeBody(['work', 'Travel'], ['work', 'urgent'])).toEqual({
      labels: ['work', 'Travel'],
      labels_add: ['travel'],
      labels_remove: ['urgent'],
    });
  });

  it('sends only the whole list without the labels from before', () => {
    // a change queued by an older release has no previousLabels
    expect(labelChangeBody(['work'])).toEqual({ labels: ['work'] });
  });

  it('sends no change when the labels are the same', () => {
    expect(labelChangeBody(['Work'], ['work'])).toEqual({ labels: ['Work'] });
  });
});

describe('queuedToggleBody', () => {
  // the queued payload keeps the state from before the toggle
  it('marks an unread message read', () => {
    expect(queuedToggleBody('toggleRead', { isUnread: true, flags: ['\\Flagged'] })).toEqual({
      flags: ['\\Flagged', '\\Seen'],
      flags_add: ['\\Seen'],
    });
  });

  it('marks a read message unread', () => {
    expect(queuedToggleBody('toggleRead', { isUnread: false, flags: ['\\Seen'] })).toEqual({
      flags: [],
      flags_remove: ['\\Seen'],
    });
  });

  it('stars and unstars', () => {
    expect(queuedToggleBody('toggleStar', { isStarred: false, flags: ['\\Seen'] })).toEqual({
      flags: ['\\Seen', '\\Flagged'],
      flags_add: ['\\Flagged'],
    });
    expect(queuedToggleBody('toggleStar', { isStarred: true, flags: ['\\Flagged'] })).toEqual({
      flags: [],
      flags_remove: ['\\Flagged'],
    });
  });
});
