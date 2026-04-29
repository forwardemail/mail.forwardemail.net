/**
 * Forward Email – WebSocket-based Inbox Updater
 *
 * Drop-in replacement for the polling-based createPollingUpdater().
 * Implements the same InboxUpdater interface (start/stop/destroy) but uses
 * the WebSocket real-time API instead of polling on a 5-minute interval.
 *
 * When the WebSocket receives events, it calls the same store actions
 * (loadMessages, startInitialSync) that the poller used, ensuring
 * seamless integration with the existing Svelte stores.
 *
 * Falls back to polling if WebSocket connection fails repeatedly.
 *
 * Hardening:
 *   - Credentials are read from Local storage only at connect time and
 *     never stored as module-level variables.
 *   - Event data payloads are type-checked before use.
 *   - CustomEvent detail objects are frozen to prevent mutation.
 *   - Fallback polling respects visibility and online state.
 *   - All listeners are tracked and cleaned up on stop/destroy.
 */

import { get } from 'svelte/store';
import { mailboxStore } from '../stores/mailboxStore';
import { Local } from './storage';
import { startInitialSync } from './sync-controller';
import { createWebSocketClient, createReleaseWatcher, WS_EVENTS } from './websocket-client';
import { connectNotifications, requestNotificationPermission } from './notification-manager';
import { isDemoMode } from './demo-mode.js';
import { fetchLabels } from '../stores/settingsStore';

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
 * Uses WebSocket when credentials are available, falls back to polling.
 * @returns {InboxUpdater}
 */
export function createInboxUpdater() {
  return createWebSocketUpdater();
}

/**
 * WebSocket-based updater.
 * @returns {InboxUpdater}
 */
function createWebSocketUpdater() {
  let wsClient = null;
  let releaseWatcher = null;
  let notifCleanup = null;
  let fallbackTimer = null;
  let destroyed = false;
  let started = false;
  let visibilityHandler = null;
  let lastSettingsSync = 0;
  let lastCaldavResync = 0;
  const wsUnsubs = [];

  // Refresh the current folder — polls whatever the user is viewing, not just INBOX.
  // Removed navigator.onLine guard (unreliable on Linux) — let fetch fail naturally.
  function refreshCurrentFolder() {
    if (document.visibilityState !== 'visible') return;

    const currentFolder = get(mailboxStore.state.selectedFolder);
    if (!currentFolder) return;

    const account = Local.get('email') || 'default';

    // Invalidate in-memory cache so loadMessages fetches fresh data
    if (typeof mailboxStore.actions.invalidateFolderInMemCache === 'function') {
      mailboxStore.actions.invalidateFolderInMemCache(account, currentFolder);
    }
    // Skip loadMessages when search is active — search results use searchResults
    // store, not messages. Calling loadMessages during search can cause the UI
    // to briefly flash "no results" as the derived filteredMessages re-evaluates.
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
   *
   * Previously this only called startInitialSync(), which fetches metadata
   * in the background via the sync worker.  The sync worker completion
   * eventually triggers scheduleSyncRefresh → loadMessages(), but ONLY if
   * the sync worker is connected AND the task completes before the user
   * navigates away.  For newly created aliases with no prior sync state,
   * the sync worker may not have enough context to produce a taskComplete
   * event, leaving the UI stale.
   *
   * The fix: always call loadMessages() directly when the WebSocket tells
   * us something changed.  This ensures the API is queried immediately and
   * the message list updates regardless of sync worker state.
   */
  function refreshFolder(folderIdentifier) {
    if (!isNonEmptyString(folderIdentifier)) return;

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
    // If we matched a folder, compare paths. If we couldn't match (e.g.,
    // ObjectId not found in folders list), assume the current folder might
    // be affected and refresh anyway — better to over-refresh than miss
    // a new message.
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
      if (!wsClient?.connected) {
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

      // Read credentials at connect time only — never store them.
      // The app stores alias_auth as "email:password" (password may contain colons).
      const email = Local.get('email');
      const aliasAuth = Local.get('alias_auth') || '';
      const colonIdx = aliasAuth.indexOf(':');
      const password = colonIdx !== -1 ? aliasAuth.slice(colonIdx + 1) : '';
      const demoMode = isDemoMode();

      // Demo mode is intentionally offline and backed by local fake data.
      // Skip realtime sockets and notification permission requests there so
      // local browser QA stays quiet and the app does not try to reach the
      // production websocket endpoint with demo credentials.
      if (!demoMode) {
        releaseWatcher = createReleaseWatcher();
        releaseWatcher.on(WS_EVENTS.NEW_RELEASE, (data) => {
          if (data && typeof data === 'object') {
            dispatchFrozen('fe:new-release', data);
          }
        });
        releaseWatcher.connect();
      }

      // If we have credentials, start the authenticated WebSocket
      if (!demoMode && isNonEmptyString(email) && isNonEmptyString(password)) {
        wsClient = createWebSocketClient({ email, password });

        // Wire up IMAP events to store refreshes
        wsUnsubs.push(
          wsClient.on(WS_EVENTS.NEW_MESSAGE, (data) => {
            const mailbox = safeString(data?.mailbox, 'INBOX');
            refreshFolder(mailbox);
          }),
        );

        wsUnsubs.push(
          wsClient.on(WS_EVENTS.MESSAGES_MOVED, (data) => {
            if (data && typeof data === 'object') {
              refreshFolder(safeString(data.sourceMailbox));
              refreshFolder(safeString(data.destinationMailbox));
            }
          }),
        );

        wsUnsubs.push(
          wsClient.on(WS_EVENTS.MESSAGES_COPIED, (data) => {
            if (data && typeof data === 'object') {
              refreshFolder(safeString(data.destinationMailbox));
            }
          }),
        );

        wsUnsubs.push(
          wsClient.on(WS_EVENTS.FLAGS_UPDATED, (data) => {
            if (data && typeof data === 'object') {
              refreshFolder(safeString(data.mailbox));
            }
          }),
        );

        wsUnsubs.push(
          wsClient.on(WS_EVENTS.MESSAGES_EXPUNGED, (data) => {
            if (data && typeof data === 'object') {
              refreshFolder(safeString(data.mailbox));
            }
          }),
        );

        // Folder structure changes — reload folder list
        wsUnsubs.push(
          wsClient.on(WS_EVENTS.MAILBOX_CREATED, () => {
            mailboxStore.actions.loadFolders?.();
          }),
        );
        wsUnsubs.push(
          wsClient.on(WS_EVENTS.MAILBOX_DELETED, () => {
            mailboxStore.actions.loadFolders?.();
          }),
        );
        wsUnsubs.push(
          wsClient.on(WS_EVENTS.MAILBOX_RENAMED, () => {
            mailboxStore.actions.loadFolders?.();
          }),
        );

        // CalDAV events
        for (const evt of [
          WS_EVENTS.CALENDAR_CREATED,
          WS_EVENTS.CALENDAR_UPDATED,
          WS_EVENTS.CALENDAR_DELETED,
        ]) {
          wsUnsubs.push(
            wsClient.on(evt, (data) => {
              if (data && typeof data === 'object') {
                dispatchFrozen('fe:calendar-changed', data);
              }
            }),
          );
        }

        for (const evt of [
          WS_EVENTS.CALENDAR_EVENT_CREATED,
          WS_EVENTS.CALENDAR_EVENT_UPDATED,
          WS_EVENTS.CALENDAR_EVENT_DELETED,
        ]) {
          wsUnsubs.push(
            wsClient.on(evt, (data) => {
              if (data && typeof data === 'object') {
                dispatchFrozen('fe:calendar-event-changed', data);
              }
            }),
          );
        }

        // CardDAV events
        for (const evt of [WS_EVENTS.ADDRESS_BOOK_CREATED, WS_EVENTS.ADDRESS_BOOK_DELETED]) {
          wsUnsubs.push(
            wsClient.on(evt, (data) => {
              if (data && typeof data === 'object') {
                dispatchFrozen('fe:contacts-changed', data);
              }
            }),
          );
        }

        for (const evt of [
          WS_EVENTS.CONTACT_CREATED,
          WS_EVENTS.CONTACT_UPDATED,
          WS_EVENTS.CONTACT_DELETED,
        ]) {
          wsUnsubs.push(
            wsClient.on(evt, (data) => {
              if (data && typeof data === 'object') {
                dispatchFrozen('fe:contact-changed', data);
              }
            }),
          );
        }

        // Dispatch auth failure to the app so it can show a toast / prompt re-login
        wsUnsubs.push(
          wsClient.on('_authFailed', () => {
            window.dispatchEvent(new CustomEvent('fe:auth-failed'));
          }),
        );

        // Ensure fallback polling stays active if WS gives up reconnecting
        wsUnsubs.push(
          wsClient.on('_maxReconnectsReached', () => {
            console.warn('[updater] WebSocket gave up reconnecting, relying on polling');
            startFallbackPoll();
          }),
        );

        // Connect notification manager and request permission
        notifCleanup = connectNotifications(wsClient);
        requestNotificationPermission();

        wsClient.connect();
      }

      // When the app becomes visible: refresh messages, reconnect WS if needed,
      // and re-sync labels/settings. Covers mobile background return, Linux
      // suspend/resume, browser tab switch, and Wayland desktop switching.
      visibilityHandler = () => {
        if (document.hidden || destroyed || !started) return;

        // 1. Always refresh the current folder when user returns
        refreshCurrentFolder();

        // 2. If WS is disconnected, reset counter and reconnect immediately
        if (wsClient && !wsClient.connected) {
          wsClient.reconnect();
        }

        // 3. Reconcile calendar + contacts. Any CalDAV/CardDAV events that
        // fired while the WS was paused (mobile background, desktop sleep)
        // are lost — without this, calendar events/tasks created on another
        // client only appear after a full app restart.
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

      // Start fallback polling whenever we have credentials,
      // even if the WebSocket connection fails to establish.
      if (!demoMode && isNonEmptyString(email) && isNonEmptyString(password)) {
        startFallbackPoll();
      }
    },

    /**
     * Expose the authenticated WebSocket client so callers (e.g. the
     * auto-updater or push notification manager) can subscribe to events.
     */
    getWsClient() {
      return wsClient;
    },

    stop() {
      started = false;
      stopFallbackPoll();
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
      if (wsClient) {
        // Unsubscribe all WS event listeners before destroying
        for (const unsub of wsUnsubs) {
          if (typeof unsub === 'function') unsub();
        }
        wsUnsubs.length = 0;
        wsClient.destroy();
        wsClient = null;
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
