import { describe, expect, it } from 'vitest';
import { adjacentContact, listArrowStep, opensContactMenu } from '../../src/utils/contact-list-nav';

const list = [{ id: 'alice' }, { id: 'bob' }, { id: 'carol' }];

describe('moving through the contact list with the arrow keys', () => {
  it('moves one contact down or up from the selected one', () => {
    expect(adjacentContact(list, 'bob', 1)?.id).toBe('carol');
    expect(adjacentContact(list, 'bob', -1)?.id).toBe('alice');
  });

  it('stays put at either end instead of wrapping', () => {
    expect(adjacentContact(list, 'carol', 1)).toBeNull();
    expect(adjacentContact(list, 'alice', -1)).toBeNull();
  });

  it('starts from the top or bottom with nothing selected, or a selection filtered out', () => {
    expect(adjacentContact(list, null, 1)?.id).toBe('alice');
    expect(adjacentContact(list, 'dave', -1)?.id).toBe('carol');
    expect(adjacentContact([], null, 1)).toBeNull();
  });

  it('only takes plain arrow keys outside text fields', () => {
    const input = { tagName: 'INPUT' } as unknown as EventTarget;
    const row = { tagName: 'BUTTON' } as unknown as EventTarget;
    expect(listArrowStep({ key: 'ArrowDown', target: row })).toBe(1);
    expect(listArrowStep({ key: 'ArrowUp', target: row })).toBe(-1);
    expect(listArrowStep({ key: 'ArrowDown', target: input })).toBeNull();
    expect(listArrowStep({ key: 'ArrowDown', shiftKey: true, target: row })).toBeNull();
    expect(listArrowStep({ key: 'ArrowDown', metaKey: true, target: row })).toBeNull();
    expect(listArrowStep({ key: 'j', target: row })).toBeNull();
    const editor = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    expect(listArrowStep({ key: 'ArrowUp', target: editor })).toBeNull();
  });
});

describe('opening the contact menu with a click', () => {
  it('opens on Command-click, not on a plain or Control click', () => {
    expect(opensContactMenu({ metaKey: true, button: 0 })).toBe(true);
    expect(opensContactMenu({ button: 0 })).toBe(false);
    // macOS turns Control-click into a right-click, handled by contextmenu.
    expect(opensContactMenu({ metaKey: false, button: 0 })).toBe(false);
  });
});
