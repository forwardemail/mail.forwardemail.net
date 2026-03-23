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
import { isTauri } from './platform.js';

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

  // Register activity listeners
  for (const event of ACTIVITY_EVENTS) {
    document.addEventListener(event, onActivity, { passive: true, capture: true });
  }

  // Visibility change handler
  _visibilityHandler = () => {
    if (_paused) return;

    if (document.hidden) {
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
      // User returned — cancel the minimize grace timer
      if (_minimizeGraceTimer) {
        clearTimeout(_minimizeGraceTimer);
        _minimizeGraceTimer = null;
      }

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
 */
async function setupTauriListeners() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();

    // Lock on window blur/focus
    const unlistenBlur = await appWindow.onFocusChanged(({ payload: focused }) => {
      if (!_started || _paused) return;

      if (!focused) {
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
      } else {
        if (_minimizeGraceTimer) {
          clearTimeout(_minimizeGraceTimer);
          _minimizeGraceTimer = null;
        }

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
      }
    });
    _tauriUnlisteners.push(unlistenBlur);
  } catch {
    // Not in Tauri context
  }
}

/**
 * Stop monitoring for inactivity.
 */
function stop() {
  _started = false;
  _paused = false;

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
