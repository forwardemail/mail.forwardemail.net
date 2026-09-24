/**
 * Post-boot runtime error notifier.
 *
 * Before main.ts bootstraps, the inline script in index.html turns any error
 * into a full-screen diagnostic overlay so a white screen can be understood.
 * After boot that overlay steps aside (it checks window.__appBootstrapped),
 * and this module takes over: the error logger already records every window
 * error and rejection for the Diagnostics page, so all that is left is to
 * tell the user something went wrong without covering a working mailbox.
 *
 * Skips the same noise the overlay skips: errors sanitized to "Script error."
 * by the browser because they came from an injected, non-same-origin script
 * (Firefox for iOS helper scripts, Safari extensions), chunk-load failures
 * that the recovery handler reloads for, resource-load errors, and WebDriver
 * harness chatter. One toast per throttle window keeps an error storm from
 * stacking toasts.
 */

export const RUNTIME_ERROR_TOAST_INTERVAL_MS = 30_000;

export const RUNTIME_ERROR_TOAST_MESSAGE =
  'Something went wrong. Details were saved to Diagnostics in Settings.';

interface ToastHost {
  show?: (message: string, type?: string, options?: unknown) => unknown;
}

interface ErrorLike {
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  error?: unknown;
  target?: unknown;
}

/** Browser-sanitized cross-origin error: no detail, no error object. */
export function isSanitizedForeignError(event: ErrorLike | null | undefined): boolean {
  if (!event || event.error) return false;
  const msg = String(event.message ?? '');
  if (!/^Script error\.?$/i.test(msg)) return false;
  const lineno = typeof event.lineno === 'number' ? event.lineno : 0;
  return !event.filename && !(lineno > 0);
}

/** Chunk 404s are handled by the recovery reload in index.html. */
export function isChunkLoadMessage(message: unknown): boolean {
  return /Failed to fetch dynamically imported module|Loading chunk|error loading dynamically imported module/i.test(
    String(message ?? ''),
  );
}

/** WebDriverIO errors bubble into the page only during e2e runs. */
export function isTestHarnessNoise(message: unknown): boolean {
  const msg = String(message ?? '');
  return (
    /stale element reference/i.test(msg) ||
    /WebDriverError/i.test(msg) ||
    /element click intercepted/i.test(msg) ||
    /no such element/i.test(msg)
  );
}

/**
 * App Lock holds the encrypted cache shut, so background writes that land
 * while it is locked (a sync tick, a WebSocket update) fail with DbLockedError
 * by design and are redone after unlock. Reporting them told the user
 * "Something went wrong" every time the app locked.
 */
export function isLockedDatabaseError(reason: unknown): boolean {
  if (reason && typeof reason === 'object') {
    const { code, name } = reason as { code?: unknown; name?: unknown };
    if (code === 'DB_LOCKED' || name === 'DbLockedError') return true;
  }
  const message =
    (reason as { message?: unknown } | undefined)?.message ?? (reason as unknown) ?? '';
  return /Database is locked: at-rest encryption is enabled/i.test(String(message));
}

function isResourceLoadError(event: ErrorLike): boolean {
  const target = event.target as { tagName?: string } | null | undefined;
  return !!target && typeof target === 'object' && typeof target.tagName === 'string';
}

export interface NotifierOptions {
  now?: () => number;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  intervalMs?: number;
}

/**
 * Install the notifier. Returns a function that removes the listeners.
 */
export function installRuntimeErrorNotifier(
  toasts: ToastHost | null | undefined,
  options: NotifierOptions = {},
): () => void {
  const now = options.now ?? (() => Date.now());
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);
  const intervalMs = options.intervalMs ?? RUNTIME_ERROR_TOAST_INTERVAL_MS;
  if (!target || !toasts || typeof toasts.show !== 'function') return () => {};

  let lastToastAt = -Infinity;

  const notify = () => {
    const t = now();
    if (t - lastToastAt < intervalMs) return;
    lastToastAt = t;
    try {
      toasts.show!(RUNTIME_ERROR_TOAST_MESSAGE, 'error');
    } catch {
      // A failing toast host must not become a second error.
    }
  };

  const onError = (event: Event) => {
    const e = event as unknown as ErrorLike;
    if (isResourceLoadError(e)) return;
    if (isSanitizedForeignError(e)) return;
    const message =
      (e.error as { message?: unknown } | undefined)?.message ?? e.message ?? 'unknown error';
    if (isChunkLoadMessage(message) || isTestHarnessNoise(message)) return;
    if (isLockedDatabaseError(e.error ?? message)) return;
    notify();
  };

  const onRejection = (event: Event) => {
    const reason = (event as unknown as { reason?: unknown }).reason;
    if (isLockedDatabaseError(reason)) {
      // Expected while locked; keep it out of the console as an uncaught error.
      event.preventDefault?.();
      return;
    }
    const message = (reason as { message?: unknown } | undefined)?.message ?? String(reason ?? '');
    if (isChunkLoadMessage(message) || isTestHarnessNoise(message)) return;
    notify();
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
