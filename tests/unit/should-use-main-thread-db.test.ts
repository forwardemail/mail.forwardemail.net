/**
 * shouldUseMainThreadDb() — the WebKitGTK detection that gates the whole Linux
 * db fix. WebKitGTK (Tauri's Linux desktop WebView) stalls IndexedDB inside Web
 * Workers under the tauri:// scheme, intermittently per page load, so we skip
 * the worker outright there and run the engine on the main thread. macOS
 * (WKWebView), Windows (WebView2) and Android (Chromium WebView) keep the
 * worker. A silent UA-detection regression would re-break Linux without any
 * other test noticing, so pin the matrix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Importing db-worker-client pulls in the inlined db.worker via Vite's
// `?worker&inline`; stub it so the unit test never tries to spawn a real Worker.
vi.mock('../../src/workers/db.worker.ts?worker&inline', () => ({
  default: class {
    postMessage() {}
    terminate() {}
    addEventListener() {}
  },
}));

import { shouldUseMainThreadDb } from '../../src/utils/db-worker-client.js';

function withEnv(ua: string, tauri: boolean, fn: () => void) {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: unknown };
  const hadTauri = '__TAURI_INTERNALS__' in g;
  const prevTauri = g.__TAURI_INTERNALS__;
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: ua, configurable: true });
  if (tauri) g.__TAURI_INTERNALS__ = {};
  else delete g.__TAURI_INTERNALS__;
  try {
    fn();
  } finally {
    if (hadTauri) g.__TAURI_INTERNALS__ = prevTauri;
    else delete g.__TAURI_INTERNALS__;
  }
}

// Real user agents observed from each platform's WebView.
const UA = {
  webkitGtkLinux:
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15',
  macWk: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/120.0',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0',
};

describe('shouldUseMainThreadDb', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true on WebKitGTK/Linux desktop under Tauri', () => {
    withEnv(UA.webkitGtkLinux, true, () => expect(shouldUseMainThreadDb()).toBe(true));
  });

  it('is false on macOS (WKWebView) under Tauri', () => {
    withEnv(UA.macWk, true, () => expect(shouldUseMainThreadDb()).toBe(false));
  });

  it('is false on Windows (WebView2) under Tauri', () => {
    withEnv(UA.windows, true, () => expect(shouldUseMainThreadDb()).toBe(false));
  });

  it('is false on Android (Chromium WebView, Linux-in-UA but Android)', () => {
    withEnv(UA.android, true, () => expect(shouldUseMainThreadDb()).toBe(false));
  });

  it('is false on a Linux UA when NOT running under Tauri (plain browser/PWA)', () => {
    withEnv(UA.webkitGtkLinux, false, () => expect(shouldUseMainThreadDb()).toBe(false));
  });
});
