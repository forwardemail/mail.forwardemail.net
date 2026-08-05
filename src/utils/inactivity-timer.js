/**
 * Inactivity Timer
 *
 * Monitors user activity (mouse, keyboard, touch, scroll) and triggers
 * a callback after a configurable period of inactivity. Used to auto-lock
 * the app when the user walks away.
 *
 * Also handles:
 *   - Lock on app minimize / visibility change (optional)
 *   - Lock on Tauri window focus loss (optional)
 *   - Pause/resume for when the lock screen is already showing
 */

import { getLockPrefs } from './crypto-store.js';
import { isTauri, isTauriMobile } from './platform.js';

const ACTIVITY_EVENTS = [
  'mousedown',
  'mousemove',
  'keydown',
  'keypress',
  'touchstart',
  'touchmove',
  'scroll',
  'wheel',
  'pointerdown',
];

// Throttle activity detection to avoid excessive timer resets
const THROTTLE_MS = 1000;

// Grace period before locking on minimize/hide — prevents locking on brief
// tab switches, notification clicks, or quick app toggles.
const MINIMIZE_GRACE_MS = 30_000; // 30 seconds

let _timer = null;
let _lastActivity = Date.now();
let _onLock = null;
let _paused = false;
let _started = false;
let _throttleTimeout = null;
let _visibilityHandler = null;
let _minimizeGraceTimer = null;
let _tauriUnlisteners = [];

// Track when the app was hidden/blurred so we can check elapsed time on resume.
// This is critical because OS-level suspension (iOS background, laptop sleep)
// prevents setTimeout from firing while the app is inactive.
let _hiddenTimestamp = null;

/**
 * Handle user activity: reset the inactivity timer.
 */
function onActivity() {
  if (_paused || !_started) return;

  const now = Date.now();
  if (now - _lastActivity < THROTTLE_MS) return;
  _lastActivity = now;

  resetTimer();
}

/**
 * Reset the inactivity timer with the current timeout value.
 */
function resetTimer() {
  if (_timer) clearTimeout(_timer);

  const prefs = getLockPrefs();
  const timeoutMs = prefs.timeoutMs || 5 * 60 * 1000;

  if (timeoutMs <= 0) return; // Disabled

  _timer = setTimeout(() => {
    if (!_paused && _started && _onLock) {
      _onLock();
    }
  }, timeoutMs);
}

/**
 * Check if the app should lock after returning from a hidden/blurred state.
 * This handles the case where OS-level suspension prevented the grace timer
 * from firing (iOS background, laptop sleep, Android doze, etc.).
 *
 * @returns {boolean} true if the app was locked
 */
function checkMinimizeLockOnResume() {
  if (!_started || _paused || !_onLock) return false;

  const prefs = getLockPrefs();
  if (!prefs.lockOnMinimize) return false;

  // If we recorded when the app was hidden, check if enough time elapsed
  if (_hiddenTimestamp !== null) {
    const elapsed = Date.now() - _hiddenTimestamp;
    if (elapsed >= MINIMIZE_GRACE_MS) {
      _hiddenTimestamp = null;
      if (_minimizeGraceTimer) {
        clearTimeout(_minimizeGraceTimer);
        _minimizeGraceTimer = null;
      }
      _onLock();
      return true;
    }
  }

  return false;
}

/**
 * Start monitoring for inactivity.
 *
 * @param {Function} onLock - Callback to invoke when inactivity timeout fires
 */
function start(onLock) {
  if (_started) stop();

  _onLock = onLock;
  _started = true;
  _paused = false;
  _lastActivity = Date.now();
  _hiddenTimestamp = null;

  // Register activity listeners
  for (const event of ACTIVITY_EVENTS) {
    document.addEventListener(event, onActivity, { passive: true, capture: true });
  }

  // Visibility change handler
  _visibilityHandler = () => {
    if (_paused) return;

    if (document.hidden) {
      // Record the timestamp when the app was hidden
      _hiddenTimestamp = Date.now();

      // Lock-on-minimize: start grace period so brief tab switches don't trigger
      const prefs = getLockPrefs();
      if (prefs.lockOnMinimize && !_minimizeGraceTimer && _onLock) {
        _minimizeGraceTimer = setTimeout(() => {
          _minimizeGraceTimer = null;
          if (document.hidden && !_paused && _started && _onLock) {
            _onLock();
          }
        }, MINIMIZE_GRACE_MS);
      }
    } else {
      // User returned — check if the grace period elapsed while suspended.
      // On iOS/Android and during laptop sleep, setTimeout is frozen by the OS,
      // so the grace timer may not have fired even though enough time passed.
      if (checkMinimizeLockOnResume()) return;

      // Cancel the minimize grace timer (user returned within grace period)
      if (_minimizeGraceTimer) {
        clearTimeout(_minimizeGraceTimer);
        _minimizeGraceTimer = null;
      }
      _hiddenTimestamp = null;

      // Check if the inactivity timeout elapsed while the tab was hidden.
      // Browsers throttle setTimeout in hidden tabs (Chrome fires at most
      // once per minute), so a short timeout (e.g. 30s) may not have fired.
      // Enforce it now that the user is back.
      if (_started && _onLock) {
        const prefs = getLockPrefs();
        const timeoutMs = prefs.timeoutMs || 5 * 60 * 1000;
        if (timeoutMs > 0 && Date.now() - _lastActivity >= timeoutMs) {
          _onLock();
          return;
        }
      }

      // Tab is visible again — reset the timer with remaining time
      resetTimer();
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  // Tauri-specific: listen for window blur/focus events
  if (isTauri) {
    setupTauriListeners();
  }

  resetTimer();
}

/**
 * Set up Tauri-specific window event listeners.
 * Uses the event API (tauri://focus, tauri://blur) which works on both
 * desktop and mobile, plus onFocusChanged as a belt-and-suspenders approach.
 */
async function setupTauriListeners() {
  try {
    const { listen } = await import('@tauri-apps/api/event');

    // Listen for tauri://blur (app loses focus / goes to background)
    const unlistenBlur = await listen('tauri://blur', () => {
      if (!_started || _paused) return;

      // Record the timestamp (same as visibilitychange hidden)
      if (_hiddenTimestamp === null) {
        _hiddenTimestamp = Date.now();
      }

      // Lock-on-minimize: start grace period
      const prefs = getLockPrefs();
      if (prefs.lockOnMinimize && !_minimizeGraceTimer && _onLock) {
        _minimizeGraceTimer = setTimeout(() => {
          _minimizeGraceTimer = null;
          if (!_paused && _started && _onLock) {
            _onLock();
          }
        }, MINIMIZE_GRACE_MS);
      }
    });
    _tauriUnlisteners.push(unlistenBlur);

    // Listen for tauri://focus (app gains focus / returns to foreground)
    const unlistenFocus = await listen('tauri://focus', () => {
      if (!_started || _paused) return;

      // Check if the grace period elapsed while the app was suspended
      if (checkMinimizeLockOnResume()) return;

      // Cancel the minimize grace timer (user returned within grace period)
      if (_minimizeGraceTimer) {
        clearTimeout(_minimizeGraceTimer);
        _minimizeGraceTimer = null;
      }
      _hiddenTimestamp = null;

      // Check if inactivity timeout elapsed while window was unfocused
      if (_onLock) {
        const prefs = getLockPrefs();
        const timeoutMs = prefs.timeoutMs || 5 * 60 * 1000;
        if (timeoutMs > 0 && Date.now() - _lastActivity >= timeoutMs) {
          _onLock();
          return;
        }
      }

      resetTimer();
    });
    _tauriUnlisteners.push(unlistenFocus);
  } catch {
    // Not in Tauri context or event API unavailable
  }

  // On mobile, also listen for native lifecycle events dispatched by
  // SceneDelegate.swift (iOS) which are more reliable than tauri://focus/blur
  if (isTauriMobile) {
    setupNativeLifecycleListeners();
  }
}

/**
 * Set up listeners for native lifecycle events dispatched from iOS SceneDelegate
 * and Android activity lifecycle. These are custom DOM events injected via
 * evaluateJavaScript from the native side, providing a reliable signal that
 * the app has actually gone to/from background (not just lost window focus).
 */
function setupNativeLifecycleListeners() {
  const handleBackground = () => {
    if (!_started || _paused) return;

    if (_hiddenTimestamp === null) {
      _hiddenTimestamp = Date.now();
    }

    const prefs = getLockPrefs();
    if (prefs.lockOnMinimize && !_minimizeGraceTimer && _onLock) {
      _minimizeGraceTimer = setTimeout(() => {
        _minimizeGraceTimer = null;
        if (!_paused && _started && _onLock) {
          _onLock();
        }
      }, MINIMIZE_GRACE_MS);
    }
  };

  const handleForeground = () => {
    if (!_started || _paused) return;

    if (checkMinimizeLockOnResume()) return;

    if (_minimizeGraceTimer) {
      clearTimeout(_minimizeGraceTimer);
      _minimizeGraceTimer = null;
    }
    _hiddenTimestamp = null;

    if (_onLock) {
      const prefs = getLockPrefs();
      const timeoutMs = prefs.timeoutMs || 5 * 60 * 1000;
      if (timeoutMs > 0 && Date.now() - _lastActivity >= timeoutMs) {
        _onLock();
        return;
      }
    }

    resetTimer();
  };

  window.addEventListener('fe:app-background', handleBackground);
  window.addEventListener('fe:app-foreground', handleForeground);

  _tauriUnlisteners.push(() => {
    window.removeEventListener('fe:app-background', handleBackground);
    window.removeEventListener('fe:app-foreground', handleForeground);
  });
}

/**
 * Stop monitoring for inactivity.
 */
function stop() {
  _started = false;
  _paused = false;
  _hiddenTimestamp = null;

  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }

  if (_throttleTimeout) {
    clearTimeout(_throttleTimeout);
    _throttleTimeout = null;
  }

  if (_minimizeGraceTimer) {
    clearTimeout(_minimizeGraceTimer);
    _minimizeGraceTimer = null;
  }

  for (const event of ACTIVITY_EVENTS) {
    document.removeEventListener(event, onActivity, { capture: true });
  }

  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  // Clean up Tauri listeners
  for (const unlisten of _tauriUnlisteners) {
    try {
      unlisten();
    } catch {
      // ignore
    }
  }
  _tauriUnlisteners = [];

  _onLock = null;
}

/**
 * Pause the timer (e.g. when lock screen is already showing).
 */
function pause() {
  _paused = true;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  if (_minimizeGraceTimer) {
    clearTimeout(_minimizeGraceTimer);
    _minimizeGraceTimer = null;
  }
}

/**
 * Resume the timer after a pause.
 */
function resume() {
  _paused = false;
  _lastActivity = Date.now();
  _hiddenTimestamp = null;
  if (_started) {
    resetTimer();
  }
}

/**
 * Check if the timer is currently running.
 */
function isRunning() {
  return _started && !_paused;
}

/**
 * Get the time remaining until auto-lock (in ms).
 */
function getTimeRemaining() {
  if (!_started || _paused) return Infinity;
  const prefs = getLockPrefs();
  const timeoutMs = prefs.timeoutMs || 5 * 60 * 1000;
  const elapsed = Date.now() - _lastActivity;
  return Math.max(0, timeoutMs - elapsed);
}

/**
 * Call when lock preferences change to immediately apply the new timeout.
 */
function onPrefsChanged() {
  if (_started && !_paused) {
    resetTimer();
  }
}

export { start, stop, pause, resume, resetTimer, isRunning, getTimeRemaining, onPrefsChanged };
