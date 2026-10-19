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
  // The value a pending frame will set; update() builds on it, so an update
  // made within the frame does not bring back what the removal took out.
  let pendingValue: T = initial;
  // Ids the pending frame removes. get() and $store still return the old list
  // until the frame runs, so a caller that does get() then set() within the
  // frame (markMessageRead after an archive, for one) hands back a list that
  // still holds the removed rows. Those ids are stripped from any set() made
  // while the frame is pending, so the removal is not undone.
  let pendingRemovedIds: Set<unknown> | null = null;

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
    pendingRemovedIds = null;
  }

  const idOf = (item: unknown): unknown =>
    item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;

  /** Ids present in `current` and missing from `next`, or null if none. */
  function removedIds(current: unknown[], next: unknown[]): Set<unknown> | null {
    const kept = new Set(next.map(idOf));
    const removed = new Set<unknown>();
    for (const item of current) {
      const id = idOf(item);
      if (id !== undefined && id !== null && !kept.has(id)) removed.add(id);
    }
    return removed.size ? removed : null;
  }

  /** Drops rows a pending removal took out from a value built on the old list. */
  function withoutPendingRemovals(value: T): T {
    if (pendingFrame === null || !pendingRemovedIds || !Array.isArray(value)) return value;
    const ids = pendingRemovedIds;
    const next = value.filter((item) => !ids.has(idOf(item)));
    return (next.length === value.length ? value : next) as T;
  }

  const deferredSet = (incoming: T): void => {
    const value = withoutPendingRemovals(incoming);
    // Always cancel a pending frame so the latest value wins
    cancelPending();

    if (isRemoval(value)) {
      // Defer removals to next animation frame
      if (typeof requestAnimationFrame === 'function') {
        pendingValue = value;
        pendingRemovedIds = removedIds(get(inner) as unknown[], value as unknown[]);
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          pendingRemovedIds = null;
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
    const current = pendingFrame !== null ? pendingValue : get(inner);
    const next = updater(current);
    // Unchanged: keep any pending frame as it is
    if (next === current) return;
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
