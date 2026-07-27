/**
 * Forward Email – WebSocket-based Inbox Updater (Multi-Account)
 *
 * Uses the WebSocket manager to maintain real-time connections for ALL
 * signed-in accounts simultaneously.  Events from any account trigger
 * appropriate UI updates:
 *   - Active account events → immediate folder refresh + notifications
 *   - Non-active account events → notifications + badge updates only
 *
 * Falls back to polling if all WebSocket connections fail repeatedly.
 *
 * Hardening:
 *   - Credentials are never stored as module-level variables.
 *   - Event data payloads are type-checked before use.
 *   - CustomEvent detail objects are frozen to prevent mutation.
 *   - Fallback polling respects visibility and online state.
 *   - All listeners are tracked and cleaned up on stop/destroy.
 */

import { get } from 'svelte/store';
import { mailboxStore } from '../stores/mailboxStore';
import { Local } from './storage';
import { startInitialSync } from './sync-controller';
import { createReleaseWatcher, WS_EVENTS } from './websocket-client';
import {
  connectMultiAccountNotifications,
  requestNotificationPermission,
} from './notification-manager';
import { isDemoMode } from './demo-mode.js';
import { fetchLabels } from '../stores/settingsStore';
import { getWebSocketManager, destroyWebSocketManager } from './websocket-manager.js';
import { createRealtimeEventCoalescer } from './realtime-event-coalescer.js';

// ── Constants ──────────────────────────────────────────────────────────────
const FALLBACK_POLL_INTERVAL_MS = 60_000; // 1 min fallback when WS disconnected
const SETTINGS_SYNC_THROTTLE_MS = 30_000; // Throttle visibility-based settings sync
const CALDAV_RESYNC_THROTTLE_MS = 30_000; // Throttle visibility-based calendar/contacts reload

/**
 * @typedef {Object} InboxUpdater
 * @property {() => void} start  - Begin monitoring for inbox updates
 * @property {() => void} stop   - Pause monitoring (resumable)
 * @property {() => void} destroy - Tear down completely (not resumable)
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function safeString(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Dispatch a frozen CustomEvent on window.
 * Freezing prevents downstream code from mutating the event payload.
 */
function dispatchFrozen(eventName, detail) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: Object.freeze({ ...detail }) }));
}

/**
 * Factory — returns the active updater implementation.
 * Uses WebSocket manager for multi-account real-time updates.
 * @returns {InboxUpdater}
 */
export function createInboxUpdater() {
  return createWebSocketUpdater();
}

/**
 * WebSocket-based updater (multi-account).
 * @returns {InboxUpdater}
 */
function createWebSocketUpdater() {
  let wsManager = null;
  let releaseWatcher = null;
  let notifCleanup = null;
  let fallbackTimer = null;
  let destroyed = false;
  let started = false;
  let visibilityHandler = null;
  let lastSettingsSync = 0;
  let lastCaldavResync = 0;
  const wsUnsubs = [];

  /**
   * Check if an event is for the currently active account.
   * Events for the active account trigger immediate UI refresh.
   * Events for other accounts only trigger notifications/badges.
   */
  function isActiveAccount(eventData) {
    const activeEmail = (Local.get('email') || '').toLowerCase();
    const eventAccount = (eventData?._account || '').toLowerCase();
    // If no account tag or matches active, treat as active
    return !eventAccount || eventAccount === activeEmail;
  }

  // Refresh the current folder — polls whatever the user is viewing, not just INBOX.
  function refreshCurrentFolder() {
    if (document.visibilityState !== 'visible') return;

    const currentFolder = get(mailboxStore.state.selectedFolder);
    if (!currentFolder) return;

    const account = Local.get('email') || 'default';

    // Invalidate in-memory cache so loadMessages fetches fresh data
    if (typeof mailboxStore.actions.invalidateFolderInMemCache === 'function') {
      mailboxStore.actions.invalidateFolderInMemCache(account, currentFolder);
    }
    // Skip loadMessages when search is active
    if (!get(mailboxStore.state.searchActive)) {
      mailboxStore.actions.loadMessages();
    }

    // Background metadata sync for the current folder
    const folders = get(mailboxStore.state.folders) || [];
    const folder = folders.find((f) => f.path?.toUpperCase?.() === currentFolder.toUpperCase());
    if (folder) {
      startInitialSync(account, [folder], { wantBodies: false });
    }

    // Always update sidebar unread counts
    if (typeof mailboxStore.actions.updateFolderUnreadCounts === 'function') {
      mailboxStore.actions.updateFolderUnreadCounts();
    }
  }

  /**
   * Refresh a specific folder — triggers both a background metadata sync
   * AND an immediate loadMessages() call so the UI updates right away.
   * Only refreshes the UI if the event is for the active account.
   */
  function refreshFolder(folderIdentifier, eventData) {
    if (!isNonEmptyString(folderIdentifier)) return;

    // Only refresh the visible UI for the active account's events
    if (!isActiveAccount(eventData)) return;

    const currentFolder = get(mailboxStore.state.selectedFolder);
    const account = Local.get('email') || 'default';
    const folders = get(mailboxStore.state.folders) || [];

    // Match by folder id (server sends MongoDB ObjectIds), _id, or path
    const folder =
      folders.find((f) => String(f.id) === folderIdentifier) ||
      folders.find((f) => String(f._id) === folderIdentifier) ||
      folders.find((f) => f.path?.toUpperCase?.() === folderIdentifier.toUpperCase());

    // Always kick off a background metadata sync for the matched folder
    if (folder) {
      startInitialSync(account, [folder], { wantBodies: false });
    }

    // Determine if the affected folder matches what the user is viewing.
    const folderPath = folder?.path;
    const affectsCurrentFolder = !currentFolder
      ? false
      : folderPath
        ? currentFolder.toUpperCase() === folderPath.toUpperCase()
        : true; // Unknown folder — refresh current view as safety net

    if (affectsCurrentFolder) {
      if (typeof mailboxStore.actions.invalidateFolderInMemCache === 'function') {
        mailboxStore.actions.invalidateFolderInMemCache(account, currentFolder);
      }
      if (!get(mailboxStore.state.searchActive)) {
        mailboxStore.actions.loadMessages();
      }
    }

    // Always update sidebar unread counts
    if (typeof mailboxStore.actions.updateFolderUnreadCounts === 'function') {
      mailboxStore.actions.updateFolderUnreadCounts();
    }
  }

  // Start fallback polling (if WS is disconnected)
  function startFallbackPoll() {
    stopFallbackPoll();
    fallbackTimer = setInterval(() => {
      if (!wsManager?.anyConnected) {
        refreshCurrentFolder();
      }
    }, FALLBACK_POLL_INTERVAL_MS);
  }

  function stopFallbackPoll() {
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  }

  return {
    start() {
      if (destroyed || started) return;
      started = true;

      const demoMode = isDemoMode();
      const email = Local.get('email');
      const aliasAuth = Local.get('alias_auth') || '';
      const hasCredentials = isNonEmptyString(email) && isNonEmptyString(aliasAuth);

      // Demo mode is intentionally offline and backed by local fake data.
      if (!demoMode) {
        releaseWatcher = createReleaseWatcher();
        releaseWatcher.on(WS_EVENTS.NEW_RELEASE, (data) => {
          if (data && typeof data === 'object') {
            dispatchFrozen('fe:new-release', data);
          }
        });
        releaseWatcher.connect();
      }

      // If we have credentials, start the multi-account WebSocket manager
      if (!demoMode && hasCredentials) {
        wsManager = getWebSocketManager();
        wsManager.reconcile(); // Connect ALL signed-in accounts

        // WebSocket and native push carry the same logical events.  Register
        // every data refresh behind one coalescer so each side effect runs once.
        const updateHandlers = new Map();
        const updateCoalescer = createRealtimeEventCoalescer({
          onEvent(eventName, data) {
            updateHandlers.get(eventName)?.(data);
          },
        });
        const registerUpdateHandler = (eventName, handler) => {
          updateHandlers.set(eventName, handler);
          wsUnsubs.push(
            wsManager.on(eventName, (data) => updateCoalescer.handleWebSocket(eventName, data)),
          );
        };

        registerUpdateHandler(WS_EVENTS.NEW_MESSAGE, (data) => {
          refreshFolder(safeString(data?.mailbox, 'INBOX'), data);
        });
        registerUpdateHandler(WS_EVENTS.MESSAGES_MOVED, (data) => {
          if (!data || typeof data !== 'object') return;
          refreshFolder(safeString(data.sourceMailbox), data);
          refreshFolder(safeString(data.destinationMailbox), data);
        });
        registerUpdateHandler(WS_EVENTS.MESSAGES_COPIED, (data) => {
          if (data && typeof data === 'object') {
            refreshFolder(safeString(data.destinationMailbox), data);
          }
        });
        for (const eventName of [
          WS_EVENTS.FLAGS_UPDATED,
          WS_EVENTS.LABELS_UPDATED,
          WS_EVENTS.MESSAGES_EXPUNGED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (data && typeof data === 'object') refreshFolder(safeString(data.mailbox), data);
          });
        }

        for (const eventName of [
          WS_EVENTS.MAILBOX_CREATED,
          WS_EVENTS.MAILBOX_DELETED,
          WS_EVENTS.MAILBOX_RENAMED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            // Only refresh folder list for active account events
            if (isActiveAccount(data)) {
              mailboxStore.actions.loadFolders?.();
            }
          });
        }

        for (const eventName of [
          WS_EVENTS.CALENDAR_CREATED,
          WS_EVENTS.CALENDAR_UPDATED,
          WS_EVENTS.CALENDAR_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (data && typeof data === 'object') dispatchFrozen('fe:calendar-changed', data);
          });
        }
        for (const eventName of [
          WS_EVENTS.CALENDAR_EVENT_CREATED,
          WS_EVENTS.CALENDAR_EVENT_UPDATED,
          WS_EVENTS.CALENDAR_EVENT_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (!data || typeof data !== 'object') return;
            dispatchFrozen('fe:calendar-event-changed', { type: eventName, payload: data });
          });
        }

        for (const eventName of [WS_EVENTS.ADDRESS_BOOK_CREATED, WS_EVENTS.ADDRESS_BOOK_DELETED]) {
          registerUpdateHandler(eventName, (data) => {
            if (data && typeof data === 'object') dispatchFrozen('fe:contacts-changed', data);
          });
        }
        for (const eventName of [
          WS_EVENTS.CONTACT_CREATED,
          WS_EVENTS.CONTACT_UPDATED,
          WS_EVENTS.CONTACT_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (data && typeof data === 'object') dispatchFrozen('fe:contact-changed', data);
          });
        }

        const pushUpdateHandler = (event) => {
          const payload = event?.detail;
          if (!updateHandlers.has(payload?.event)) return;
          if (payload.displayedBySystem === true) return;
          updateCoalescer.handlePush(payload);
        };
        window.addEventListener('fe:push-notification', pushUpdateHandler);
        wsUnsubs.push(() => {
          window.removeEventListener('fe:push-notification', pushUpdateHandler);
          updateCoalescer.destroy();
        });

        // Dispatch auth failure to the app
        wsUnsubs.push(
          wsManager.on('_authFailed', (data) => {
            window.dispatchEvent(
              new CustomEvent('fe:auth-failed', {
                detail: { account: data?._account },
              }),
            );
          }),
        );

        // Ensure fallback polling stays active if all WS connections give up
        wsUnsubs.push(
          wsManager.on('_maxReconnectsReached', () => {
            console.warn('[updater] WebSocket gave up reconnecting, relying on polling');
            startFallbackPoll();
          }),
        );

        // Connect notification manager for ALL accounts via the manager
        notifCleanup = connectMultiAccountNotifications(wsManager);
        requestNotificationPermission();

        startFallbackPoll();
      }

      // When the app becomes visible: refresh messages, reconnect WS if needed,
      // and re-sync labels/settings.
      visibilityHandler = () => {
        if (document.hidden || destroyed || !started) return;

        // 1. Always refresh the current folder when user returns
        refreshCurrentFolder();

        // 2. Reconnect any disconnected WebSocket clients
        if (wsManager) {
          wsManager.reconcile(); // Also picks up any newly added accounts
          wsManager.reconnectAll();
        }

        // 3. Reconcile calendar + contacts
        const now = Date.now();
        if (now - lastCaldavResync >= CALDAV_RESYNC_THROTTLE_MS) {
          lastCaldavResync = now;
          dispatchFrozen('fe:calendar-changed', { source: 'visibility' });
          dispatchFrozen('fe:contacts-changed', { source: 'visibility' });
        }

        // 4. Re-sync labels/settings (throttled to avoid hammering)
        if (now - lastSettingsSync < SETTINGS_SYNC_THROTTLE_MS) return;
        lastSettingsSync = now;
        fetchLabels(true, { force: true }).catch(() => {});
      };
      document.addEventListener('visibilitychange', visibilityHandler);
    },

    /**
     * Expose the WebSocket manager so callers can subscribe to events.
     */
    getWsManager() {
      return wsManager;
    },

    /**
     * Legacy compatibility: expose a client for the active account.
     * @deprecated Use getWsManager() instead.
     */
    getWsClient() {
      if (!wsManager) return null;
      const email = Local.get('email');
      return email ? wsManager.getClient(email) : null;
    },

    stop() {
      started = false;
      stopFallbackPoll();
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }

      // Unsubscribe all event listeners
      for (const unsub of wsUnsubs) {
        if (typeof unsub === 'function') unsub();
      }
      wsUnsubs.length = 0;

      // Destroy the WebSocket manager (disconnects all accounts)
      if (wsManager) {
        destroyWebSocketManager();
        wsManager = null;
      }

      if (notifCleanup) {
        try {
          notifCleanup();
        } catch {
          /* ignore cleanup errors */
        }
        notifCleanup = null;
      }
      // Keep release watcher running
    },

    destroy() {
      this.stop();
      destroyed = true;
      if (releaseWatcher) {
        releaseWatcher.destroy();
        releaseWatcher = null;
      }
    },
  };
}
