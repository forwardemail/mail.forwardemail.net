/**
 * Reader header/body sync regression guard.
 *
 * The reader header (subject/from/to/date, bound to `$selectedMessage`) is set
 * synchronously on selection, while the body (`$messageBody`) is delivered
 * asynchronously via mailService's `onBody` callback. A 500ms cache-hit
 * debounce used to skip `onBody` purely on recency — so rapidly selecting
 * A → B → A within the window skipped the final A's body re-render, leaving
 * B's body (or a cleared/blank one) under A's header until the window elapsed
 * ("out of sync while scrolling; fixed by going back and forth").
 *
 * `shouldDebounceBodyRender` is the decision the fix routes both debounce sites
 * through: skip ONLY when the same message was hit recently AND its body is
 * still the one displayed (`lastDeliveredKey`). These tests pin that contract.
 */
import { describe, expect, it } from 'vitest';
import { shouldDebounceBodyRender } from '../../src/stores/mailService';

const WINDOW = 500;

/**
 * Faithfully model the production state machine around the debounce: a load
 * either SKIPS the body (debounced → onBody not called) or DELIVERS it and, in
 * lockstep, records the hit time + marks this message as the one now on screen
 * — exactly the `recentCacheHits.set(...)` + `lastDeliveredBodyKey = ...` pair
 * that runs on every real delivery in mailService.
 */
function makeReader() {
  const hits = new Map<string, number>();
  let lastDelivered: string | null = null;
  return {
    /** True if the body was DELIVERED (onBody fires); false if debounced/skipped. */
    load(key: string, nowMs: number): boolean {
      if (shouldDebounceBodyRender(key, nowMs, hits, lastDelivered, WINDOW)) {
        return false;
      }
      hits.set(key, nowMs);
      lastDelivered = key;
      return true;
    },
    get displayed(): string | null {
      return lastDelivered;
    },
  };
}

describe('shouldDebounceBodyRender — reader header/body sync', () => {
  it('skips a genuine immediate repeat load of the SAME message (preserves the optimization)', () => {
    const r = makeReader();
    expect(r.load('acct:A', 1000)).toBe(true); // first load delivers
    expect(r.load('acct:A', 1100)).toBe(false); // 100ms later, same msg, still shown → skip
  });

  it('re-delivers the body when a DIFFERENT message was shown in between (the bug)', () => {
    const r = makeReader();
    // A → B → A, all inside the 500ms window. Pre-fix, the final A was skipped,
    // leaving B's body under A's header. It MUST re-deliver now.
    expect(r.load('acct:A', 1000)).toBe(true);
    expect(r.load('acct:B', 1100)).toBe(true);
    expect(r.load('acct:A', 1200)).toBe(true); // regression guard
    expect(r.displayed).toBe('acct:A'); // body now matches the A header
  });

  it('re-delivers once the debounce window has elapsed for the same message', () => {
    const r = makeReader();
    expect(r.load('acct:A', 1000)).toBe(true);
    expect(r.load('acct:A', 1000 + WINDOW)).toBe(true); // window elapsed → not "recent"
  });

  it('never debounces a first-ever load, and a null displayed key (post-reset) cannot match', () => {
    const r = makeReader();
    expect(r.load('acct:A', 5000)).toBe(true); // first sighting of the key
    // After account switch the state is cleared (lastDeliveredBodyKey = null);
    // null can never equal a cacheKey, so the next load always delivers.
    expect(
      shouldDebounceBodyRender('acct:A', 5001, new Map([['acct:A', 5000]]), null, WINDOW),
    ).toBe(false);
  });

  it('debounces only inside the window AND only when that message is still displayed', () => {
    const hits = new Map<string, number>([['acct:A', 1000]]);
    // recent + same message still displayed → skip
    expect(shouldDebounceBodyRender('acct:A', 1200, hits, 'acct:A', WINDOW)).toBe(true);
    // recent, but a different message is displayed → deliver
    expect(shouldDebounceBodyRender('acct:A', 1200, hits, 'acct:B', WINDOW)).toBe(false);
    // same message displayed, but the window has elapsed → deliver
    expect(shouldDebounceBodyRender('acct:A', 1500, hits, 'acct:A', WINDOW)).toBe(false);
  });
});
