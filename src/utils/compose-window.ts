/**
 * Compose Window Manager (Tauri Desktop Only)
 *
 * Opens compose in a separate native OS window via Tauri's WebviewWindow API.
 * Each compose window is fully independent — own webview, own state.
 *
 * Uses a handshake protocol:
 *   1. Main window creates compose window and stores prefill in pendingInits map
 *   2. Compose window mounts, then emits `compose:ready` with its label
 *   3. Main window receives `compose:ready`, sends `compose:init` with the stored prefill
 *
 * This avoids race conditions from fixed-delay timers.
 */

import { Local } from './storage';

let composeCounter = 0;

// Pending init data keyed by window label — consumed on compose:ready
const pendingInits = new Map<
  string,
  { action: string; prefill: Record<string, unknown>; auth: Record<string, string> }
>();

/**
 * Collect auth credentials from localStorage to pass to compose windows.
 * On Windows, WebView2 may isolate storage per webview, so compose windows
 * need auth credentials sent explicitly via Tauri events.
 */
function collectAuth(): Record<string, string> {
  return {
    alias_auth: Local.get('alias_auth') || '',
    api_key: Local.get('api_key') || '',
    email: Local.get('email') || '',
    authToken: Local.get('authToken') || '',
  };
}

export interface ComposeWindowOptions {
  action?: 'open' | 'reply' | 'forward';
  prefill?: Record<string, unknown>;
}

/**
 * Start listening for compose:ready events from compose windows.
 * Must be called once at app startup (from main.ts).
 */
export async function initComposeWindowListener() {
  try {
    const { listen, emitTo } = await import('@tauri-apps/api/event');

    listen('compose:ready', (event) => {
      const label = (event.payload as { label?: string })?.label;
      if (!label) return;

      const initData = pendingInits.get(label);
      pendingInits.delete(label);

      // Send init data to the compose window that just signaled ready
      emitTo(label, 'compose:init', initData || { action: 'open', prefill: {} });
    });
  } catch {
    // Not in Tauri — no-op
  }
}

/**
 * Open a new compose window. Returns the window label.
 */
export async function openComposeWindow(options?: ComposeWindowOptions): Promise<string | null> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

    const label = `compose-${Date.now()}-${++composeCounter}`;

    // Store init data for when the window signals ready.
    // Include auth credentials for Windows WebView2 compatibility
    // (WebView2 may isolate localStorage per webview).
    pendingInits.set(label, {
      action: options?.action || 'open',
      prefill: options?.prefill || {},
      auth: collectAuth(),
    });

    // Defer WebviewWindow creation off the current AppKit event tick.
    // macOS 26+ WebKit crashes inside WebPageProxy::dispatchSetObscuredContentInsets
    // when a webview is constructed synchronously from a click handler; yielding
    // to the next tick lets the originating event finish dispatching first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const win = new WebviewWindow(label, {
      title:
        options?.action === 'reply'
          ? 'Reply — Forward Email'
          : options?.action === 'forward'
            ? 'Forward — Forward Email'
            : 'Compose — Forward Email',
      width: 800,
      height: 700,
      minWidth: 500,
      minHeight: 400,
      center: true,
      resizable: true,
      url: 'compose.html',
    });

    win.once('tauri://error', (e) => {
      console.error('[compose-window] Failed to create window:', e);
      pendingInits.delete(label);
    });

    return label;
  } catch (err) {
    console.error('[compose-window] Tauri API not available:', err);
    return null;
  }
}
