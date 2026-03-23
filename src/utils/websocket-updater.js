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
import { fetchLabels } from '../stores/settingsStore';

// ── Constants ──────────────────────────────────────────────────────────────
const FALLBACK_POLL_INTERVAL_MS = 300_000; // 5 min fallback — WebSocket handles real-time
const SETTINGS_SYNC_THROTTLE_MS = 30_000; // Throttle visibility-based settings sync

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
  const wsUnsubs = [];

  // Refresh the INBOX view (same logic as the old poller tick)
  function refreshInbox() {
    if (document.visibilityState !== 'visible') return;
    if (!navigator.onLine) return;

    const currentFolder = get(mailboxStore.state.selectedFolder);
    if (currentFolder !== 'INBOX') return;

    mailboxStore.actions.loadMessages();

    const account = Local.get('email') || 'default';
    const folders = get(mailboxStore.state.folders) || [];
    const inbox = folders.find((f) => f.path?.toUpperCase?.() === 'INBOX');
    if (inbox) {
      startInitialSync(account, [inbox], { wantBodies: false });
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
    // Match by folder id first (server sends MongoDB ObjectIds), then by path
    const folder =
      folders.find((f) => String(f.id) === folderIdentifier) ||
      folders.find((f) => f.path?.toUpperCase?.() === folderIdentifier.toUpperCase());

    // Always kick off a background metadata sync for the affected folder
    if (folder) {
      startInitialSync(account, [folder], { wantBodies: false });
    }

    // If the user is currently viewing the affected folder, also reload
    // the message list immediately so the UI reflects the change.
    const folderPath = folder?.path || folderIdentifier;
    if (currentFolder && currentFolder.toUpperCase() === folderPath.toUpperCase()) {
      // Invalidate the in-memory folder cache so loadMessages() doesn't
      // return stale cached data.
      if (typeof mailboxStore.actions.invalidateFolderInMemCache === 'function') {
        mailboxStore.actions.invalidateFolderInMemCache(account, currentFolder);
      }
      mailboxStore.actions.loadMessages();
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
        refreshInbox();
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

      // Always start the release watcher (no auth needed)
      releaseWatcher = createReleaseWatcher();
      releaseWatcher.on(WS_EVENTS.NEW_RELEASE, (data) => {
        if (data && typeof data === 'object') {
          dispatchFrozen('fe:new-release', data);
        }
      });
      releaseWatcher.connect();

      // If we have credentials, start the authenticated WebSocket
      if (isNonEmptyString(email) && isNonEmptyString(password)) {
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

        // Connect notification manager and request permission
        notifCleanup = connectNotifications(wsClient);
        requestNotificationPermission();

        wsClient.connect();
      }

      // Re-sync labels/settings when the app becomes visible (handles
      // cross-client label creation — e.g. webmail ↔ desktop).
      visibilityHandler = () => {
        if (document.hidden || destroyed || !started) return;
        const now = Date.now();
        if (now - lastSettingsSync < SETTINGS_SYNC_THROTTLE_MS) return;
        lastSettingsSync = now;
        fetchLabels(true, { force: true }).catch(() => {});
      };
      document.addEventListener('visibilitychange', visibilityHandler);

      // Start fallback polling whenever we have credentials,
      // even if the WebSocket connection fails to establish.
      if (isNonEmptyString(email) && isNonEmptyString(password)) {
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
