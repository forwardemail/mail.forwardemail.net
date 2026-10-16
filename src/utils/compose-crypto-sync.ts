/**
 * Keeps desktop compose windows in step with App Lock in the main window.
 *
 * A compose window has no vault of its own. It gets the IndexedDB key with
 * compose:init, and from then on only knows what the main window tells it
 * here. Without this, a compose window left open while App Lock was turned
 * off kept sealing drafts with the key the main window then threw away.
 */
import { applyExternalLockChange } from './db-crypto-bridge.js';
import { getIdbKeyForComposeWindow } from './crypto-store.js';

export type ComposeLockState = 'locked' | 'unlocked' | 'disabling' | 'off';

const EVENT = 'compose:lock-state';
const isComposeLabel = (label: unknown) =>
  typeof label === 'string' && label.startsWith('compose-');

/** From the main window: tell every open compose window about a change. */
export async function broadcastComposeLockState(state: ComposeLockState) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    if (isComposeLabel(getCurrentWindow().label)) return;
    const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
    const labels = (await getAllWebviewWindows()).map((w) => w.label).filter(isComposeLabel);
    if (!labels.length) return;
    // The key goes only to compose windows, by label, never as a broadcast.
    const idbKey =
      state === 'unlocked' || state === 'disabling'
        ? await getIdbKeyForComposeWindow().catch(() => undefined)
        : undefined;
    const { emitTo } = await import('@tauri-apps/api/event');
    await Promise.all(
      labels.map((label) =>
        emitTo(label, EVENT, { state, ...(idbKey ? { idbKey } : {}) }).catch(() => {}),
      ),
    );
  } catch {
    // Not running under Tauri: there are no compose windows.
  }
}

const decodeKey = (idbKey: unknown) => {
  if (typeof idbKey !== 'string' || !idbKey) return null;
  const binary = atob(idbKey);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Apply one message from the main window. Exported for tests. */
export async function handleComposeLockState(payload: unknown) {
  const { state, idbKey } = (payload || {}) as { state?: ComposeLockState; idbKey?: string };
  if (state !== 'locked' && state !== 'unlocked' && state !== 'disabling' && state !== 'off') {
    return;
  }
  // 'disabling' keeps the key this window already has; a key sent with it is
  // only used when this window had none.
  const rawKey = state === 'unlocked' ? decodeKey(idbKey) : null;
  await applyExternalLockChange({ state, rawKey });
}

/** In a compose window: follow the main window's App Lock changes. */
export async function listenForComposeLockState() {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen(EVENT, (event: { payload: unknown }) => {
      void handleComposeLockState(event.payload);
    });
  } catch {
    // Not running under Tauri
  }
}
