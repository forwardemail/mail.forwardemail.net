import { describe, it, expect, vi } from 'vitest';
import {
  activateOnKeys,
  storeToStore,
  storeToWritableStore,
  chooseStore,
  chooseWritableStore,
  dedupeMessages,
  resolveDeleteTargets,
  nextCandidate,
  getVisibleFolders,
} from '../../../../src/svelte/mailbox/utils/mailbox-helpers';
import { get } from 'svelte/store';

describe('mailbox-helpers', () => {
  describe('activateOnKeys', () => {
    it('executes action on Enter key', () => {
      const action = vi.fn();
      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      activateOnKeys(event, action);

      expect(action).toHaveBeenCalledOnce();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('executes action on Space key', () => {
      const action = vi.fn();
      const event = {
        key: ' ',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      activateOnKeys(event, action);

      expect(action).toHaveBeenCalledOnce();
    });

    it('does not execute action on other keys', () => {
      const action = vi.fn();
      const event = {
        key: 'a',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      activateOnKeys(event, action);

      expect(action).not.toHaveBeenCalled();
    });

    it('handles null event gracefully', () => {
      const action = vi.fn();
      activateOnKeys(null, action);
      expect(action).not.toHaveBeenCalled();
    });
  });

  describe('storeToStore', () => {
    it('returns store if valid', () => {
      const mockStore = {
        subscribe: vi.fn(),
      };

      const result = storeToStore(mockStore);

      expect(result).toBe(mockStore);
    });

    it('returns fallback store if invalid', () => {
      const result = storeToStore(null, 'fallback');

      // Should be a readable store
      expect(result.subscribe).toBeDefined();
      expect(typeof result.subscribe).toBe('function');

      // Should have fallback value
      const unsub = result.subscribe((value) => {
        expect(value).toBe('fallback');
      });
      unsub();
    });
  });

  describe('storeToWritableStore', () => {
    it('returns store if valid', () => {
      const mockStore = {
        subscribe: vi.fn(),
        set: vi.fn(),
      };

      const result = storeToWritableStore(mockStore);

      expect(result).toBe(mockStore);
    });

    it('returns fallback writable store if invalid', () => {
      const result = storeToWritableStore(null, 'fallback');

      // Should be a writable store
      expect(result.subscribe).toBeDefined();
      expect(result.set).toBeDefined();
      expect(result.update).toBeDefined();

      // Should have fallback value
      expect(get(result)).toBe('fallback');

      // Should be able to set value
      result.set('new value');
      expect(get(result)).toBe('new value');
    });
  });

  describe('chooseStore', () => {
    it('returns primary store if valid', () => {
      const primary = { subscribe: vi.fn() };
      const fallback = { subscribe: vi.fn() };

      const result = chooseStore(primary, fallback, 'default');

      expect(result).toBe(primary);
    });

    it('returns fallback store if primary invalid', () => {
      const fallback = { subscribe: vi.fn() };

      const result = chooseStore(null, fallback, 'default');

      expect(result).toBe(fallback);
    });

    it('returns default store if both invalid', () => {
      const result = chooseStore(null, null, 'default');

      expect(result.subscribe).toBeDefined();
      const unsub = result.subscribe((value) => {
        expect(value).toBe('default');
      });
      unsub();
    });
  });

  describe('chooseWritableStore', () => {
    it('returns primary store if valid', () => {
      const primary = { subscribe: vi.fn(), set: vi.fn() };
      const fallback = { subscribe: vi.fn(), set: vi.fn() };

      const result = chooseWritableStore(primary, fallback, 'default');

      expect(result).toBe(primary);
    });

    it('returns fallback store if primary invalid', () => {
      const fallback = { subscribe: vi.fn(), set: vi.fn() };

      const result = chooseWritableStore(null, fallback, 'default');

      expect(result).toBe(fallback);
    });

    it('returns default writable store if both invalid', () => {
      const result = chooseWritableStore(null, null, 'default');

      expect(result.subscribe).toBeDefined();
      expect(result.set).toBeDefined();
      expect(get(result)).toBe('default');
    });
  });

  describe('dedupeMessages', () => {
    it('removes duplicate messages by ID', () => {
      const messages = [
        { id: 'msg-1', subject: 'Test 1' },
        { id: 'msg-2', subject: 'Test 2' },
        { id: 'msg-1', subject: 'Test 1 Duplicate' },
        { id: 'msg-3', subject: 'Test 3' },
      ];

      const result = dedupeMessages(messages);

      expect(result).toHaveLength(3);
      expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('filters out messages without ID', () => {
      const messages = [
        { id: 'msg-1', subject: 'Test 1' },
        { subject: 'No ID' },
        { id: 'msg-2', subject: 'Test 2' },
      ];

      const result = dedupeMessages(messages);

      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('handles empty array', () => {
      expect(dedupeMessages([])).toEqual([]);
    });

    it('handles null/undefined', () => {
      expect(dedupeMessages(null)).toEqual([]);
      expect(dedupeMessages(undefined)).toEqual([]);
    });
  });

  describe('resolveDeleteTargets', () => {
    it('flattens conversations into messages', () => {
      const items = [
        {
          id: 'conv-1',
          messages: [
            { id: 'msg-1', subject: 'Test 1' },
            { id: 'msg-2', subject: 'Test 2' },
          ],
        },
        { id: 'msg-3', subject: 'Test 3' },
      ];

      const result = resolveDeleteTargets(items);

      expect(result).toHaveLength(3);
      expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('deduplicates flattened messages', () => {
      const items = [
        {
          id: 'conv-1',
          messages: [
            { id: 'msg-1', subject: 'Test 1' },
            { id: 'msg-2', subject: 'Test 2' },
          ],
        },
        { id: 'msg-1', subject: 'Test 1 Duplicate' },
      ];

      const result = resolveDeleteTargets(items);

      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('handles null items', () => {
      const items = [null, { id: 'msg-1' }, undefined];

      const result = resolveDeleteTargets(items);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-1');
    });
  });

  describe('nextCandidate', () => {
    it('returns next item in threaded mode', () => {
      const list = [{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }];

      const result = nextCandidate({
        list,
        threadingEnabled: true,
        selectedConversation: { id: 'conv-1' },
        selectedMessage: null,
      });

      expect(result.id).toBe('conv-2');
    });

    it('returns previous item if at end of list', () => {
      const list = [{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }];

      const result = nextCandidate({
        list,
        threadingEnabled: true,
        selectedConversation: { id: 'conv-3' },
        selectedMessage: null,
      });

      expect(result.id).toBe('conv-2');
    });

    it('returns first item if none selected', () => {
      const list = [{ id: 'conv-1' }, { id: 'conv-2' }];

      const result = nextCandidate({
        list,
        threadingEnabled: true,
        selectedConversation: null,
        selectedMessage: null,
      });

      expect(result.id).toBe('conv-1');
    });

    it('returns null for empty list', () => {
      const result = nextCandidate({
        list: [],
        threadingEnabled: true,
        selectedConversation: null,
        selectedMessage: null,
      });

      expect(result).toBeNull();
    });

    it('works in non-threaded mode', () => {
      const list = [{ id: 'msg-1' }, { id: 'msg-2' }, { id: 'msg-3' }];

      const result = nextCandidate({
        list,
        threadingEnabled: false,
        selectedConversation: null,
        selectedMessage: { id: 'msg-1' },
      });

      expect(result.id).toBe('msg-2');
    });
  });
});

describe('getVisibleFolders', () => {
  const folders = [
    { path: 'INBOX', level: 0 },
    { path: 'Work', level: 0 },
    { path: 'Work/Clients', level: 1 },
    { path: 'Work/Clients/Acme', level: 2 },
    // its parent "Old" was deleted; IMAP keeps the folders below it
    { path: 'Old/2024', level: 1 },
  ];
  const paths = (list) => list.map((folder) => folder.path);

  it('shows a subfolder when its parents are expanded', () => {
    expect(paths(getVisibleFolders(folders, new Set()))).toEqual(['INBOX', 'Work', 'Old/2024']);
    expect(paths(getVisibleFolders(folders, new Set(['Work'])))).toEqual([
      'INBOX',
      'Work',
      'Work/Clients',
      'Old/2024',
    ]);
    expect(paths(getVisibleFolders(folders, new Set(['Work', 'Work/Clients'])))).toEqual(
      paths(folders),
    );
  });

  it('shows a subfolder whose parent is not a folder, which cannot be expanded', () => {
    expect(paths(getVisibleFolders(folders, new Set()))).toContain('Old/2024');
  });
});
