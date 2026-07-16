import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_SWIPE_START_PX,
  EDGE_SWIPE_TRIGGER_PX,
  bindEdgeSwipeBack,
  evaluateEdgeSwipe,
  isEdgeSwipeStart,
} from '../../src/utils/mobile-edge-swipe';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function dispatchTouch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Array<{ clientX: number; clientY: number }> = [],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { configurable: true, value: touches });
  document.dispatchEvent(event);
  return event;
}

describe('mobile edge-swipe evaluation', () => {
  it('accepts only starts inside the left-edge activation zone', () => {
    expect(isEdgeSwipeStart(0)).toBe(true);
    expect(isEdgeSwipeStart(EDGE_SWIPE_START_PX)).toBe(true);
    expect(isEdgeSwipeStart(EDGE_SWIPE_START_PX + 1)).toBe(false);
    expect(isEdgeSwipeStart(-1)).toBe(false);
  });

  it('requires a rightward, horizontally dominant drag past the trigger distance', () => {
    expect(
      evaluateEdgeSwipe({
        startX: 12,
        startY: 120,
        currentX: 12 + EDGE_SWIPE_TRIGGER_PX,
        currentY: 130,
      }).shouldNavigate,
    ).toBe(true);

    expect(
      evaluateEdgeSwipe({
        startX: 12,
        startY: 120,
        currentX: 12 + EDGE_SWIPE_TRIGGER_PX - 1,
        currentY: 120,
      }).shouldNavigate,
    ).toBe(false);

    expect(
      evaluateEdgeSwipe({ startX: 12, startY: 120, currentX: 90, currentY: 200 })
        .hasHorizontalIntent,
    ).toBe(false);

    expect(
      evaluateEdgeSwipe({ startX: 40, startY: 120, currentX: 130, currentY: 120 }).shouldNavigate,
    ).toBe(false);
  });
});

describe('global mobile edge-swipe binding', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = '';
    setViewportWidth(1024);
    vi.restoreAllMocks();
  });

  it('navigates once for an accepted mobile edge drag and prevents native scrolling', () => {
    setViewportWidth(390);
    const onBack = vi.fn();
    cleanups.push(bindEdgeSwipeBack({ onBack }));

    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    const move = dispatchTouch('touchmove', [{ clientX: 90, clientY: 108 }]);
    dispatchTouch('touchend');

    expect(move.defaultPrevented).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not claim vertical pulls, short drags, or non-edge mailbox swipes', () => {
    setViewportWidth(390);
    const onBack = vi.fn();
    cleanups.push(bindEdgeSwipeBack({ onBack }));

    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    const verticalMove = dispatchTouch('touchmove', [{ clientX: 30, clientY: 170 }]);
    dispatchTouch('touchend');

    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    const shortMove = dispatchTouch('touchmove', [{ clientX: 55, clientY: 100 }]);
    dispatchTouch('touchend');

    dispatchTouch('touchstart', [{ clientX: 80, clientY: 100 }]);
    dispatchTouch('touchmove', [{ clientX: 170, clientY: 100 }]);
    dispatchTouch('touchend');

    expect(verticalMove.defaultPrevented).toBe(false);
    expect(shortMove.defaultPrevented).toBe(true);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('is disabled for open overlays, desktop widths, and explicit route guards', () => {
    setViewportWidth(390);
    const onBack = vi.fn();
    cleanups.push(bindEdgeSwipeBack({ isEnabled: () => false, onBack }));

    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    dispatchTouch('touchmove', [{ clientX: 100, clientY: 100 }]);
    dispatchTouch('touchend');

    cleanups.pop()?.();
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>';
    cleanups.push(bindEdgeSwipeBack({ onBack }));
    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    dispatchTouch('touchmove', [{ clientX: 100, clientY: 100 }]);
    dispatchTouch('touchend');

    document.body.innerHTML = '';
    setViewportWidth(1024);
    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    dispatchTouch('touchmove', [{ clientX: 100, clientY: 100 }]);
    dispatchTouch('touchend');

    expect(onBack).not.toHaveBeenCalled();
  });

  it('removes all gesture listeners during cleanup', () => {
    setViewportWidth(390);
    const onBack = vi.fn();
    const cleanup = bindEdgeSwipeBack({ onBack });
    cleanup();

    dispatchTouch('touchstart', [{ clientX: 8, clientY: 100 }]);
    dispatchTouch('touchmove', [{ clientX: 100, clientY: 100 }]);
    dispatchTouch('touchend');

    expect(onBack).not.toHaveBeenCalled();
  });
});
