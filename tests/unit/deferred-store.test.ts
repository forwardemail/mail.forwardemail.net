import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { deferredWritable } from '../../src/utils/deferred-store';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

describe('deferredWritable', () => {
  it('defers a removal to the next frame', async () => {
    const store = deferredWritable([1, 2, 3]);
    store.set([1, 2]);
    expect(get(store)).toEqual([1, 2, 3]);
    await nextFrame();
    expect(get(store)).toEqual([1, 2]);
  });

  it('builds an update on a removal still waiting for its frame', async () => {
    // Two changes within one frame, such as an expunge followed by a flag
    // change, must not bring back the removed row.
    const store = deferredWritable([1, 2, 3]);
    store.set([1, 2]);
    store.update((list) => list.map((n) => n * 10));
    await nextFrame();
    expect(get(store)).toEqual([10, 20]);
  });

  it('leaves a pending removal alone when an update changes nothing', async () => {
    const store = deferredWritable([1, 2, 3]);
    store.set([1]);
    store.update((list) => list);
    expect(get(store)).toEqual([1, 2, 3]);
    await nextFrame();
    expect(get(store)).toEqual([1]);
  });

  it('does not undo a pending removal when a set() is built on the old list', async () => {
    // Archive removes row 2, then markMessageRead on the next row reads the
    // list with get(), which still has row 2 until the frame runs, and sets a
    // same-length copy. Row 2 must stay gone.
    const store = deferredWritable([{ id: 1 }, { id: 2, read: false }, { id: 3, read: false }]);
    store.set([{ id: 1 }, { id: 3, read: false }]);
    const stale = get(store);
    expect(stale.map((m) => m.id)).toEqual([1, 2, 3]);
    store.set(stale.map((m) => (m.id === 3 ? { ...m, read: true } : m)));
    await nextFrame();
    expect(get(store)).toEqual([{ id: 1 }, { id: 3, read: true }]);
  });

  it('keeps every removal when two are made in the same frame', async () => {
    const store = deferredWritable([{ id: 1 }, { id: 2 }, { id: 3 }]);
    store.set([{ id: 1 }, { id: 3 }]);
    // The second caller also read the stale list and only removed its own row.
    store.set([{ id: 1 }, { id: 2 }]);
    await nextFrame();
    expect(get(store)).toEqual([{ id: 1 }]);
  });

  it('lets a row come back once the removal frame has run', async () => {
    const store = deferredWritable([{ id: 1 }, { id: 2 }]);
    store.set([{ id: 1 }]);
    await nextFrame();
    // A rollback after a failed move restores the row.
    store.set([{ id: 1 }, { id: 2 }]);
    expect(get(store)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('setImmediate drops the pending removal and its ids', async () => {
    const store = deferredWritable([{ id: 1 }, { id: 2 }]);
    store.set([{ id: 1 }]);
    store.setImmediate([{ id: 1 }, { id: 2 }]);
    store.set([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await nextFrame();
    expect(get(store)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});
