/**
 * Compose Window Entry Point (Tauri Desktop Only)
 *
 * Lightweight entry that mounts only the Compose component in a separate
 * Tauri window. Communicates with the main window via Tauri events.
 */

// Styles
import './styles/base.css';
import './styles/tokens.css';
import './styles/components/index.css';
import './styles/main.css';

import { mount } from 'svelte';
import Compose from './svelte/Compose.svelte';
import { createToastHost } from './svelte/toastsHost';
import { getEffectiveSettingValue } from './stores/settingsStore';
import { loadUserContent } from './stores/userContentStore';
import { ensureDbReady } from './utils/db';

// Block <input type="file"> — WebKit's runOpenPanel crashes Tauri on macOS.
// File picking uses Tauri's dialog plugin instead (see file-picker.ts).
document.addEventListener(
  'click',
  (e) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type === 'file') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);

// Apply theme from localStorage (shared with main window)
function applyTheme() {
  const theme = getEffectiveSettingValue('theme') || 'system';
  const prefersDark =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', isDark);
}

applyTheme();

// Toast host
const toastsRoot = document.getElementById('toasts-root');
const toasts = toastsRoot ? createToastHost(toastsRoot) : { show: () => {}, dismiss: () => {} };

// Compose API reference
let composeApi: Record<string, unknown> = {};

// Mount Compose component
const composeRoot = document.getElementById('compose-root');
if (composeRoot) {
  mount(Compose, {
    target: composeRoot,
    props: {
      nativeWindow: true,
      toasts,
      registerApi: (api: Record<string, unknown>) => {
        composeApi = api;
        initFromTauriEvent();
      },
      onSent: async (result?: {
        archive?: boolean;
        queued?: boolean;
        draftId?: string;
        serverDraftId?: string;
        sourceMessageId?: string;
        sentCopyPayload?: Record<string, unknown>;
      }) => {
        // Notify main window about the send so it can clean up the draft
        // (the compose webview can't access IDB / db worker reliably).
        try {
          const { emit } = await import('@tauri-apps/api/event');
          await emit('compose:sent', result || {});
        } catch {
          // Not in Tauri context — ignore
        }
        // Close this window after a brief delay for the toast to show
        setTimeout(async () => {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            getCurrentWindow().close();
          } catch {
            window.close();
          }
        }, 500);
      },
    },
  });
}

/**
 * Set up Tauri event handshake with the main window.
 *
 * Protocol:
 *   1. Listen for `compose:init` (main window sends prefill data)
 *   2. Emit `compose:ready` with our window label so the main window knows we're listening
 *   3. Main window responds with `compose:init` containing the prefill
 *
 * Fallback: if no init event arrives within 2s, open a blank compose.
 */
async function initFromTauriEvent() {
  try {
    const { listen, emit } = await import('@tauri-apps/api/event');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');

    let initialized = false;

    // Listen for prefill data from the main window
    listen('compose:init', async (event: { payload: unknown }) => {
      if (initialized) return;
      initialized = true;

      const { action, prefill, auth } = event.payload as {
        action?: string;
        prefill?: Record<string, unknown>;
        auth?: Record<string, string>;
      };

      // Inject auth credentials into storage for this webview.
      // On Windows, WebView2 may isolate storage per webview, so the
      // compose window needs credentials passed explicitly from main.
      // Keys must use the 'webmail_' prefix to match the Local utility.
      if (auth) {
        const PREFIX = 'webmail_';
        for (const [key, value] of Object.entries(auth)) {
          if (value) {
            try {
              const prefixedKey = `${PREFIX}${key}`;
              localStorage.setItem(prefixedKey, value);
              sessionStorage.setItem(prefixedKey, value);
            } catch {
              // Storage may be unavailable
            }
          }
        }
      }

      // Load templates and signatures for this compose window before
      // opening — auth credentials above must land first so the active
      // account resolves correctly. The compose window has its own
      // JS context, so the db worker must be initialized here too.
      await ensureDbReady().catch(() => false);
      await loadUserContent().catch(() => {});

      if (action === 'reply' && typeof composeApi.reply === 'function') {
        composeApi.reply(prefill);
      } else if (action === 'forward' && typeof composeApi.forward === 'function') {
        composeApi.forward(prefill);
      } else if (typeof composeApi.open === 'function') {
        composeApi.open(prefill);
      }
    });

    // Signal to main window that we're ready to receive init data
    const label = getCurrentWindow().label;
    emit('compose:ready', { label });

    // Fallback: if main window doesn't respond within 2s, open blank compose
    setTimeout(() => {
      if (!initialized) {
        initialized = true;
        if (typeof composeApi.open === 'function') composeApi.open();
      }
    }, 2000);
  } catch {
    // Not in Tauri — open blank compose immediately
    if (typeof composeApi.open === 'function') composeApi.open();
  }
}
