import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  messages,
  markMessageAnsweredInStore,
  setAnsweredFlagHook,
} from '../../src/stores/messageStore';

describe('markMessageAnsweredInStore', () => {
  beforeEach(() => {
    setAnsweredFlagHook(null);
    messages.set([
      { id: 'a', flags: ['\\Seen'], subject: 'one' },
      { id: 'b', flags: ['\\Seen', '\\Answered'], is_answered: true, subject: 'two' },
    ] as never);
  });

  it('adds \\Answered and is_answered to the visible message', () => {
    markMessageAnsweredInStore('a');
    const a = get(messages).find((m) => m.id === 'a');
    expect(a?.flags).toEqual(['\\Seen', '\\Answered']);
    expect(a?.is_answered).toBe(true);
  });

  it('hands the full flag list to the hook when the message is on screen', () => {
    const hook = vi.fn();
    setAnsweredFlagHook(hook);
    markMessageAnsweredInStore('a');
    expect(hook).toHaveBeenCalledWith('a', ['\\Seen', '\\Answered']);
  });

  it('hands null flags to the hook when the message is not in the list', () => {
    const hook = vi.fn();
    setAnsweredFlagHook(hook);
    markMessageAnsweredInStore('not-loaded');
    expect(hook).toHaveBeenCalledWith('not-loaded', null);
    expect(get(messages)).toHaveLength(2);
  });

  it('is a no-op for an empty id and survives a throwing hook', () => {
    const hook = vi.fn(() => {
      throw new Error('boom');
    });
    setAnsweredFlagHook(hook);
    markMessageAnsweredInStore('');
    expect(hook).not.toHaveBeenCalled();
    expect(() => markMessageAnsweredInStore('a')).not.toThrow();
  });
});
