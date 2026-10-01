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
});
