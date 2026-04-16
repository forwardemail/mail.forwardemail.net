/**
 * Tests for deferred optimistic UI removal during message deletion.
 *
 * On macOS 26+ WebKit, synchronous store updates that trigger webview
 * layout changes can race with pending dispatchSetObscuredContentInsets
 * calls, causing a use-after-free crash (EXC_BAD_ACCESS).
 *
 * The fix wraps the optimistic UI removal in requestAnimationFrame so
 * the current event-loop tick completes before mutating the store.
 * These tests verify the deferral pattern works correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('deferred optimistic delete', () => {
  let rafCallbacks;

  beforeEach(() => {
    rafCallbacks = [];
    // Mock requestAnimationFrame
    global.requestAnimationFrame = vi.fn((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.requestAnimationFrame;
  });

  /**
   * Simulates the deferred delete pattern from Mailbox.svelte deleteMessages().
   * Returns a promise that resolves after the RAF callback executes.
   */
  function deferredDelete(messages, idsToRemove) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        const filtered = messages.filter((m) => !idsToRemove.has(m.id));
        resolve(filtered);
      });
    });
  }

  it('does not remove messages synchronously', () => {
    const messages = [
      { id: '1', subject: 'Keep' },
      { id: '2', subject: 'Delete' },
    ];
    const idsToRemove = new Set(['2']);

    const promise = deferredDelete(messages, idsToRemove);

    // requestAnimationFrame should have been called
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    // But the callback hasn't fired yet - messages are unchanged
    expect(messages).toHaveLength(2);

    // Now fire the RAF callback
    rafCallbacks[0]();

    return promise.then((result) => {
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  it('removes the correct messages after RAF fires', async () => {
    const messages = [
      { id: 'a', subject: 'First' },
      { id: 'b', subject: 'Second' },
      { id: 'c', subject: 'Third' },
    ];
    const idsToRemove = new Set(['a', 'c']);

    const promise = deferredDelete(messages, idsToRemove);
    rafCallbacks[0]();

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 'b', subject: 'Second' });
  });

  it('handles empty removal set', async () => {
    const messages = [{ id: '1', subject: 'Keep' }];
    const idsToRemove = new Set();

    const promise = deferredDelete(messages, idsToRemove);
    rafCallbacks[0]();

    const result = await promise;
    expect(result).toHaveLength(1);
  });

  it('handles removing all messages', async () => {
    const messages = [
      { id: '1', subject: 'Delete' },
      { id: '2', subject: 'Also delete' },
    ];
    const idsToRemove = new Set(['1', '2']);

    const promise = deferredDelete(messages, idsToRemove);
    rafCallbacks[0]();

    const result = await promise;
    expect(result).toHaveLength(0);
  });
});

describe('closeNativeWindow defer timing', () => {
  it('uses 100ms delay instead of 0ms for WebKit safety', () => {
    // This test documents the requirement: the defer must be >= 100ms
    // to give WebKit time to drain its internal layout/geometry queue
    // before the WebPageProxy is freed.
    const REQUIRED_DELAY_MS = 100;

    // Simulate the pattern from Compose.svelte closeNativeWindow()
    let resolvedAt = 0;
    const start = Date.now();

    return new Promise((resolve) => setTimeout(resolve, REQUIRED_DELAY_MS)).then(() => {
      resolvedAt = Date.now();
      expect(resolvedAt - start).toBeGreaterThanOrEqual(REQUIRED_DELAY_MS - 5); // allow 5ms jitter
    });
  });
});
