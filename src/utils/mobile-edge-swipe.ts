export const EDGE_SWIPE_START_PX = 24;
export const EDGE_SWIPE_TRIGGER_PX = 72;
export const EDGE_SWIPE_INTENT_PX = 12;
export const EDGE_SWIPE_HORIZONTAL_RATIO = 1.5;

export type EdgeSwipeSample = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export type EdgeSwipeEvaluation = {
  deltaX: number;
  deltaY: number;
  isEdgeStart: boolean;
  hasHorizontalIntent: boolean;
  shouldNavigate: boolean;
};

export function evaluateEdgeSwipe(sample: EdgeSwipeSample): EdgeSwipeEvaluation {
  const deltaX = sample.currentX - sample.startX;
  const deltaY = sample.currentY - sample.startY;
  const absoluteY = Math.abs(deltaY);
  const isEdgeStart = sample.startX >= 0 && sample.startX <= EDGE_SWIPE_START_PX;
  const hasHorizontalIntent =
    isEdgeStart &&
    deltaX >= EDGE_SWIPE_INTENT_PX &&
    deltaX > absoluteY * EDGE_SWIPE_HORIZONTAL_RATIO;
  const shouldNavigate = hasHorizontalIntent && deltaX >= EDGE_SWIPE_TRIGGER_PX;

  return {
    deltaX,
    deltaY,
    isEdgeStart,
    hasHorizontalIntent,
    shouldNavigate,
  };
}

export function isEdgeSwipeStart(startX: number): boolean {
  return startX >= 0 && startX <= EDGE_SWIPE_START_PX;
}

type BindEdgeSwipeBackOptions = {
  isEnabled?: () => boolean;
  onBack: () => void;
};

type GestureState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  possible: boolean;
  tracking: boolean;
};

const initialState = (): GestureState => ({
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  possible: false,
  tracking: false,
});

function hasBlockingOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], .fe-modal-backdrop, .fe-bottom-sheet-backdrop, [data-edge-swipe-block="true"]',
    ),
  );
}

export function bindEdgeSwipeBack({
  isEnabled = () => true,
  onBack,
}: BindEdgeSwipeBackOptions): () => void {
  let state = initialState();

  const reset = () => {
    state = initialState();
  };

  const handleTouchStart = (event: TouchEvent) => {
    reset();
    if (
      event.touches.length !== 1 ||
      !isEnabled() ||
      hasBlockingOverlay() ||
      window.innerWidth > 768
    ) {
      return;
    }

    const touch = event.touches[0];
    if (!isEdgeSwipeStart(touch.clientX)) return;

    state = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      possible: true,
      tracking: false,
    };
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (!state.possible || event.touches.length !== 1) return;

    const touch = event.touches[0];
    state.currentX = touch.clientX;
    state.currentY = touch.clientY;
    const evaluation = evaluateEdgeSwipe(state);

    if (evaluation.deltaX < 0 || Math.abs(evaluation.deltaY) > Math.max(24, evaluation.deltaX)) {
      reset();
      return;
    }

    if (evaluation.hasHorizontalIntent) {
      state.tracking = true;
      event.preventDefault();
    }
  };

  const handleTouchEnd = () => {
    if (!state.possible) return;
    const shouldNavigate = state.tracking && evaluateEdgeSwipe(state).shouldNavigate;
    reset();
    if (shouldNavigate) onBack();
  };

  document.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
  document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
  document.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', reset, { passive: true, capture: true });

  return () => {
    document.removeEventListener('touchstart', handleTouchStart, true);
    document.removeEventListener('touchmove', handleTouchMove, true);
    document.removeEventListener('touchend', handleTouchEnd, true);
    document.removeEventListener('touchcancel', reset, true);
  };
}
