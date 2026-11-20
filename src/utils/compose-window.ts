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

import { get } from 'svelte/store';
import { Local } from './storage';
import { folders as foldersStore } from '../stores/folderStore';
import { resolveSentFolder } from './sent-folder';
import { getIdbKeyForComposeWindow } from './crypto-store.js';
import { listOutboxSenders } from '../backends/smtp-account';
import { listImapAccounts } from '../backends/imap-account';

let composeCounter = 0;

// Pending init data keyed by window label — consumed on compose:ready
const pendingInits = new Map<
  string,
  {
    action: string;
    prefill: Record<string, unknown>;
    auth: Record<string, string>;
    sentFolder: string;
    undoSendDelay: string;
    outboxSenders: string[];
    engineAccounts: string[];
  }
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

// The prefill crosses the Tauri IPC bridge as JSON. Forwarded attachments ride
// along as base64, and an oversized one would stall or fail that hand-off with
// nothing to tell the user why. Past this point, drop them and say so.
const MAX_PREFILL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function withinPrefillBudget(prefill: Record<string, unknown>): Record<string, unknown> {
  const attachments = prefill?.attachments;
  if (!Array.isArray(attachments) || !attachments.length) return prefill;

  const total = attachments.reduce(
    (sum: number, att) => sum + ((att as { content?: string })?.content?.length || 0),
    0,
  );
  if (total <= MAX_PREFILL_ATTACHMENT_BYTES) return prefill;

  console.warn('[compose-window] Forwarded attachments too large for the window hand-off', total);
  globalThis.dispatchEvent(
    new CustomEvent('fe:compose-attachments-dropped', { detail: { bytes: total } }),
  );
  return { ...prefill, attachments: [] };
}

/**
 * Start listening for compose:ready events from compose windows.
 * Must be called once at app startup (from main.ts).
 */
export async function initComposeWindowListener() {
  try {
    const { listen, emitTo } = await import('@tauri-apps/api/event');

    listen('compose:ready', async (event) => {
      const label = (event.payload as { label?: string })?.label;
      if (!label) return;

      const initData = pendingInits.get(label);
      pendingInits.delete(label);

      // Under App Lock the compose window needs the IndexedDB key to seal its
      // drafts and outbox; without it, it refuses to write them. Read now, not
      // when the window was opened, so a lock in between sends no key.
      const idbKey = await getIdbKeyForComposeWindow().catch(() => undefined);

      // Send init data to the compose window that just signaled ready
      emitTo(label, 'compose:init', {
        ...(initData || { action: 'open', prefill: {} }),
        ...(idbKey ? { idbKey } : {}),
      });
    });

    // A compose window may not use the mail engine, so for an account on a
    // custom IMAP server it asks this window to save or remove its draft.
    // The draft itself is read from the database, never from the event.
    listen('compose:save-draft', async (event) => {
      const { label, requestId, account, id } = (event.payload || {}) as DraftRequest;
      if (!isComposeLabel(label) || !account || !id) return;
      let error: string | null = null;
      try {
        const { saveDraftForComposeWindow } = await import('./draft-service');
        await saveDraftForComposeWindow(account, id);
      } catch (err) {
        error = (err as Error)?.message || 'Draft sync failed';
      }
      emitTo(label, 'compose:draft-saved', { requestId, error }).catch(() => {});
    });
    listen('compose:remove-draft', async (event) => {
      const { label, account, id } = (event.payload || {}) as DraftRequest;
      if (!isComposeLabel(label) || !account || !id) return;
      try {
        const [{ getMailBackend }, { ImapBackend }, { db }] = await Promise.all([
          import('../backends'),
          import('../backends/imap'),
          import('./db'),
        ]);
        const backend = getMailBackend(account);
        if (!(backend instanceof ImapBackend)) return;
        await backend.removeDraft(id);
        await db.messages.where('[account+id]').equals([account, id]).delete();
      } catch (err) {
        // 404: already gone.
        if ((err as { status?: number })?.status !== 404) {
          console.warn('[compose-window] could not remove a draft for a compose window', err);
        }
      }
    });
  } catch {
    // Not in Tauri — no-op
  }
}

interface DraftRequest {
  label?: string;
  requestId?: string;
  account?: string;
  id?: string;
}

const isComposeLabel = (label: unknown): label is string =>
  typeof label === 'string' && /^compose-\d+-\d+$/.test(label);

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
    // Resolve the Sent folder here in the main window — it has the folder
    // store + settings hydrated; the compose window has neither, so it can't
    // resolve this itself and would otherwise fall back to a bare "Sent".
    pendingInits.set(label, {
      action: options?.action || 'open',
      prefill: withinPrefillBudget(options?.prefill || {}),
      auth: collectAuth(),
      sentFolder: resolveSentFolder(Local.get('email') || 'default', get(foldersStore)),
      // WebView2 isolates localStorage per webview, so the compose window can't
      // read this device setting itself. Pass it through so undo-send behaves
      // the same in a separate window as it does inline.
      undoSendDelay: Local.get('undo_send_delay') || '0',
      // Accounts whose mail goes out through their own server. The compose
      // window queues their messages for this window to send, and cannot
      // always read the account list to know which they are.
      outboxSenders: listOutboxSenders(),
      // Accounts on a custom IMAP server: this window saves their drafts.
      engineAccounts: listImapAccounts(),
    });

    // Defer WebviewWindow creation off the current AppKit event tick.
    // macOS 26+ WebKit crashes inside WebPageProxy::dispatchSetObscuredContentInsets
    // when a webview is constructed synchronously from a click handler; yielding
    // to the next tick lets the originating event finish dispatching first.
    // 0ms was insufficient on 26.3+ (the AppKit event hasn't fully drained);
    // 50ms matches the working close-side delay in Compose.svelte.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const win = new WebviewWindow(label, {
      title:
        options?.action === 'reply'
          ? 'Reply | Forward Email'
          : options?.action === 'forward'
            ? 'Forward | Forward Email'
            : 'Compose | Forward Email',
      width: 800,
      height: 700,
      minWidth: 500,
      minHeight: 400,
      center: true,
      resizable: true,
      dragDropEnabled: false,
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
