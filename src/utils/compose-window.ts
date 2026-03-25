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

let composeCounter = 0;

// Pending init data keyed by window label — consumed on compose:ready
const pendingInits = new Map<string, { action: string; prefill: Record<string, unknown> }>();

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

    // Store init data for when the window signals ready
    pendingInits.set(label, {
      action: options?.action || 'open',
      prefill: options?.prefill || {},
    });

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
