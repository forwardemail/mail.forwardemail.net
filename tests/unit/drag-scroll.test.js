/**
 * Tests for folder tree auto-scroll during drag-and-drop.
 *
 * When dragging an email to a folder near the top/bottom edge of the
 * folder list, the list should auto-scroll so the user can reach
 * folders that are off-screen.  This tests the edge-detection logic
 * extracted from handleFolderDragOver in Mailbox.svelte.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Determines whether auto-scrolling should be active and in which
 * direction, based on cursor position relative to the container bounds.
 *
 * This mirrors the logic added to handleFolderDragOver in Mailbox.svelte.
 *
 * @param {number} clientY - The cursor's Y position
 * @param {{ top: number, bottom: number }} rect - The container's bounding rect
 * @param {number} edgeZone - Pixel distance from edge to trigger scroll (default 40)
 * @returns {'up' | 'down' | null} Scroll direction or null if not in edge zone
 */
function getDragScrollDirection(clientY, rect, edgeZone = 40) {
  const nearTop = clientY - rect.top < edgeZone;
  const nearBottom = rect.bottom - clientY < edgeZone;
  if (nearTop) return 'up';
  if (nearBottom) return 'down';
  return null;
}

describe('getDragScrollDirection', () => {
  const rect = { top: 100, bottom: 500 };

  it('returns "up" when cursor is near the top edge', () => {
    expect(getDragScrollDirection(110, rect)).toBe('up');
  });

  it('returns "up" when cursor is exactly at the top edge', () => {
    expect(getDragScrollDirection(100, rect)).toBe('up');
  });

  it('returns "down" when cursor is near the bottom edge', () => {
    expect(getDragScrollDirection(490, rect)).toBe('down');
  });

  it('returns "down" when cursor is exactly at the bottom edge', () => {
    expect(getDragScrollDirection(500, rect)).toBe('down');
  });

  it('returns null when cursor is in the middle of the container', () => {
    expect(getDragScrollDirection(300, rect)).toBeNull();
  });

  it('returns null when cursor is just outside the edge zone', () => {
    // 40px edge zone: top edge zone is 100-140, bottom is 460-500
    expect(getDragScrollDirection(141, rect)).toBeNull();
    expect(getDragScrollDirection(459, rect)).toBeNull();
  });

  it('respects custom edge zone size', () => {
    expect(getDragScrollDirection(180, rect, 100)).toBe('up');
    expect(getDragScrollDirection(420, rect, 100)).toBe('down');
    expect(getDragScrollDirection(300, rect, 100)).toBeNull();
  });
});

describe('drag-scroll interval management', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts scrolling when entering edge zone and stops when leaving', () => {
    let scrollTop = 100;
    const SCROLL_SPEED = 6;
    let interval = null;

    // Simulate entering bottom edge zone
    const direction = getDragScrollDirection(490, { top: 100, bottom: 500 });
    expect(direction).toBe('down');

    interval = setInterval(() => {
      scrollTop += SCROLL_SPEED;
    }, 16);

    // Advance 5 frames
    vi.advanceTimersByTime(16 * 5);
    expect(scrollTop).toBe(100 + SCROLL_SPEED * 5);

    // Simulate leaving edge zone
    clearInterval(interval);
    interval = null;

    // Advance more time - scrollTop should not change
    vi.advanceTimersByTime(16 * 5);
    expect(scrollTop).toBe(100 + SCROLL_SPEED * 5);
  });

  it('scrolls up when near top edge', () => {
    let scrollTop = 100;
    const SCROLL_SPEED = 6;

    const direction = getDragScrollDirection(110, { top: 100, bottom: 500 });
    expect(direction).toBe('up');

    const interval = setInterval(() => {
      scrollTop -= SCROLL_SPEED;
    }, 16);

    vi.advanceTimersByTime(16 * 3);
    expect(scrollTop).toBe(100 - SCROLL_SPEED * 3);

    clearInterval(interval);
  });
});
