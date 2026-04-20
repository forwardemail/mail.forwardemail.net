/**
 * deferredWritable – a Svelte writable store wrapper that automatically defers
 * `.set()` calls through `requestAnimationFrame` when the new value is an array
 * shorter than the current one (i.e. items were removed).
 *
 * ## Why
 *
 * On macOS 26+ WebKit (used by Tauri's WKWebView), synchronous store mutations
 * that remove DOM nodes can race with pending `dispatchSetObscuredContentInsets`
 * calls inside the webview compositor.  The compositor holds a stale pointer to
 * a DOM node that Svelte just destroyed, causing a use-after-free crash
 * (`EXC_BAD_ACCESS` / `KERN_INVALID_ADDRESS`).
 *
 * Deferring the store update by one animation frame gives the compositor time to
 * finish its layout pass before Svelte removes the nodes.
 *
 * ## Behaviour
 *
 * | Mutation kind              | Timing              |
 * |----------------------------|---------------------|
 * | Array grows or same length | Synchronous         |
 * | Array shrinks (removals)   | `requestAnimationFrame` |
 * | Non-array value            | Synchronous         |
 * | `.setImmediate()`          | Always synchronous  |
 *
 * The `.subscribe()`, `.update()`, and Svelte `$store` syntax work identically
 * to a regular `writable`.  `.update()` is also deferred when the callback
 * returns a shorter array.
 *
 * @module
 */

import { writable, get } from 'svelte/store';
import type { Writable, Updater } from 'svelte/store';

/** Extended Writable that adds `.setImmediate()` for bypass. */
export interface DeferredWritable<T> extends Writable<T> {
  /**
   * Set the value synchronously, bypassing the deferral logic.
   * Use this during full-page navigations or when no DOM is rendered.
   */
  setImmediate: (value: T) => void;
}

/**
 * Create a deferred writable store.
 *
 * @param initial  The initial value (typically `[]` for message lists).
 * @returns A Svelte-compatible writable with automatic removal deferral.
 */
export function deferredWritable<T>(initial: T): DeferredWritable<T> {
  const inner: Writable<T> = writable(initial);
  let pendingFrame: number | null = null;

  /**
   * Returns true when `next` is a shorter array than the current value,
   * meaning DOM nodes will be destroyed and the update should be deferred.
   */
  function isRemoval(next: T): boolean {
    const current = get(inner);
    return Array.isArray(current) && Array.isArray(next) && next.length < current.length;
  }

  /** Cancel any pending deferred update. */
  function cancelPending(): void {
    if (pendingFrame !== null) {
      // Guard for SSR / test environments where cancelAnimationFrame may not exist
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingFrame);
      }
      pendingFrame = null;
    }
  }

  const deferredSet = (value: T): void => {
    // Always cancel a pending frame so the latest value wins
    cancelPending();

    if (isRemoval(value)) {
      // Defer removals to next animation frame
      if (typeof requestAnimationFrame === 'function') {
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          inner.set(value);
        });
      } else {
        // Fallback for SSR / test environments without rAF
        inner.set(value);
      }
    } else {
      // Additions and replacements are synchronous
      inner.set(value);
    }
  };

  const deferredUpdate = (updater: Updater<T>): void => {
    const current = get(inner);
    const next = updater(current);
    deferredSet(next);
  };

  return {
    subscribe: inner.subscribe,
    set: deferredSet,
    update: deferredUpdate,
    setImmediate: (value: T): void => {
      cancelPending();
      inner.set(value);
    },
  };
}
