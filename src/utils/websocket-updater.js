/**
 * Forward Email – WebSocket-based Inbox Updater (Multi-Account)
 *
 * Uses the WebSocket manager to maintain real-time connections for ALL
 * signed-in accounts simultaneously, but only the account on screen affects
 * what the user sees:
 *   - Every event that names messages (expunged, moved, flags, labels) or
 *     folders is applied to that account's cache directly, so rows beyond the
 *     first page, other folders and other accounts stay current
 *   - Active account events also update the visible list, search results and
 *     reader, then refresh the folder from the server
 *   - Non-active account views reload when the user switches to them
 *
 * Catches up after a reconnect or a dropped message, and falls back to
 * polling while the active account has no live connection.
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
import { Accounts, Local } from './storage';
import { isVaultLocked } from './crypto-store.js';
import { isActiveAccount } from './account-scope.ts';
import { syncFolderForEvent } from './sync-controller';
import { createReleaseWatcher, WS_EVENTS } from './websocket-client';
import {
  connectMultiAccountNotifications,
  initNotificationPermission,
} from './notification-manager';
import { isDemoMode } from './demo-mode.js';
import { fetchLabels } from '../stores/settingsStore';
import { getWebSocketManager, destroyWebSocketManager } from './websocket-manager.js';
import { createRealtimeEventCoalescer } from './realtime-event-coalescer.js';
import {
  MAX_REALTIME_UIDS,
  normalizeFlagAction,
  normalizeIdentifier,
  normalizeStringList,
  normalizeUidList,
} from './realtime-payload.js';

// ── Constants ──────────────────────────────────────────────────────────────
const FALLBACK_POLL_INTERVAL_MS = 60_000; // 1 min fallback when WS disconnected
const SETTINGS_SYNC_THROTTLE_MS = 30_000; // Throttle visibility-based settings sync
const CALDAV_RESYNC_THROTTLE_MS = 30_000; // Throttle visibility-based calendar/contacts reload
const CATCH_UP_DELAY_MS = 2_000; // Collapse reconnect and dropped-message catch-ups

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
  let forceReconnectHandler = null;
  let lastSettingsSync = 0;
  let lastCaldavResync = 0;
  const wsUnsubs = [];

  /**
   * Check if an event is for the currently active account.
   * Only the active account's events touch the visible UI; another account's
   * data is refreshed the next time the user switches to it.
   *
   * Push payloads have their `_account` resolved from `alias_id` before they
   * reach here (see dispatchPushPayload), so an untagged event now means a
   * single-account install or a legacy registration — treated as active so
   * those installs keep updating.
   */
  function isActiveAccountEvent(eventData) {
    return isActiveAccount(eventData?._account, { treatUnknownAsActive: true });
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
      mailboxStore.actions.loadMessages({ refresh: true });
    }

    // Background metadata sync for the current folder
    const folders = get(mailboxStore.state.folders) || [];
    const folder = folders.find((f) => f.path?.toUpperCase?.() === currentFolder.toUpperCase());
    if (folder) {
      syncFolderForEvent(account, folder);
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
  function refreshFolder(folderIdentifier, eventData, pathHint = '') {
    if (!isNonEmptyString(folderIdentifier) && !isNonEmptyString(pathHint)) return;

    // Only refresh the visible UI for the active account's events
    if (!isActiveAccountEvent(eventData)) return;

    const currentFolder = get(mailboxStore.state.selectedFolder);
    const account = Local.get('email') || 'default';
    const folders = get(mailboxStore.state.folders) || [];
    const identifier = isNonEmptyString(folderIdentifier) ? folderIdentifier : pathHint;

    // Match by folder id (server sends MongoDB ObjectIds), _id, or path
    const folder =
      folders.find((f) => String(f.id) === identifier) ||
      folders.find((f) => String(f._id) === identifier) ||
      folders.find((f) => f.path?.toUpperCase?.() === identifier.toUpperCase()) ||
      (isNonEmptyString(pathHint)
        ? folders.find((f) => f.path?.toUpperCase?.() === pathHint.toUpperCase())
        : null);

    // Always kick off a background metadata sync for the matched folder,
    // ahead of any queued background work
    if (folder) {
      syncFolderForEvent(account, folder);
    }

    // Determine if the affected folder matches what the user is viewing.
    const folderPath = folder?.path || (isNonEmptyString(pathHint) ? pathHint : '');
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
        mailboxStore.actions.loadMessages({ refresh: true });
      }
    }

    // Always update sidebar unread counts
    if (typeof mailboxStore.actions.updateFolderUnreadCounts === 'function') {
      mailboxStore.actions.updateFolderUnreadCounts();
    }
  }

  /**
   * The account whose cache an event may change: the tagged account, or the
   * active one for an untagged event when only one account is signed in.
   * With several accounts an untagged push (alias not mapped yet) could name
   * another account's mailbox, so it only refreshes and changes nothing.
   */
  function eventAccount(eventData) {
    if (!isNonEmptyString(eventData?._account)) {
      let signedIn = [];
      try {
        signedIn = Accounts.getAll() || [];
      } catch {
        signedIn = [];
      }
      return signedIn.length > 1 ? '' : Local.get('email') || 'default';
    }
    if (isActiveAccountEvent(eventData)) return Local.get('email') || 'default';
    return eventData._account;
  }

  /**
   * Apply the change an event describes (`apply` receives the account and the
   * resolved folder path), then refresh the affected folders. The refresh
   * waits for the change, so it does not read back rows the change removes.
   */
  function applyThenRefresh(eventData, mailbox, path, apply, refresh) {
    const account = eventAccount(eventData);
    if (!account || typeof mailboxStore.actions.resolveRealtimeFolder !== 'function') {
      refresh();
      return;
    }

    Promise.resolve()
      .then(async () => {
        const folder = await mailboxStore.actions.resolveRealtimeFolder(account, mailbox, path);
        await apply(account, folder);
      })
      .catch((err) => console.warn('[updater] Failed to apply realtime change:', err))
      .finally(refresh);
  }

  // UIDs and message ids an event names, validated and capped.
  function readMessageRefs(uidsValue, idsValue) {
    return {
      uids: normalizeUidList(uidsValue),
      ids: normalizeStringList(idsValue, MAX_REALTIME_UIDS),
    };
  }

  function handleMessagesExpunged(data) {
    if (!data || typeof data !== 'object') return;
    const mailbox = normalizeIdentifier(data.mailbox);
    const path = normalizeIdentifier(data.path);
    const { uids, ids } = readMessageRefs(data.uids, data.ids);
    const refresh = () => refreshFolder(mailbox, data, path);
    if (!uids.length && !ids.length) {
      refresh();
      return;
    }

    applyThenRefresh(
      data,
      mailbox,
      path,
      (account, folder) =>
        mailboxStore.actions.removeRemoteMessages?.({ account, folder, uids, ids }),
      refresh,
    );
  }

  function handleMessagesMoved(data) {
    if (!data || typeof data !== 'object') return;
    const source = normalizeIdentifier(data.sourceMailbox ?? data.source_mailbox);
    const sourcePath = normalizeIdentifier(data.sourcePath ?? data.source_path);
    const destination = normalizeIdentifier(data.destinationMailbox ?? data.destination_mailbox);
    const destinationPath = normalizeIdentifier(data.destinationPath ?? data.destination_path);
    const { uids, ids } = readMessageRefs(data.sourceUid ?? data.source_uid ?? data.uids, data.ids);
    // In step with sourceUid: the cached rows move with their new UID
    const destinationUids = normalizeUidList(data.destinationUid ?? data.destination_uid);
    const refresh = () => {
      refreshFolder(source, data, sourcePath);
      refreshFolder(destination, data, destinationPath);
    };
    if (!uids.length && !ids.length) {
      refresh();
      return;
    }

    applyThenRefresh(
      data,
      source,
      sourcePath,
      async (account, folder) => {
        const destinationFolder =
          destination || destinationPath
            ? await mailboxStore.actions.resolveRealtimeFolder(
                account,
                destination,
                destinationPath,
              )
            : '';
        return mailboxStore.actions.removeRemoteMessages?.({
          account,
          folder,
          uids,
          ids,
          destinationFolder,
          moved: true,
          destinationUids:
            destinationUids.length === uids.length || destinationUids.length === ids.length
              ? destinationUids
              : [],
        });
      },
      refresh,
    );
  }

  function handleFlagsOrLabels(eventName, data) {
    if (!data || typeof data !== 'object') return;
    const mailbox = normalizeIdentifier(data.mailbox);
    const path = normalizeIdentifier(data.path);
    const action = normalizeFlagAction(data.action);
    const isFlags = eventName === WS_EVENTS.FLAGS_UPDATED;
    const rawValues = isFlags ? data.flags : data.labels;
    const values = normalizeStringList(rawValues);
    const { uids, ids } = readMessageRefs(data.uids, data.ids);
    const refresh = () => refreshFolder(mailbox, data, path);
    // 'set' with an empty list clears every flag or label, but only when the
    // list is there: older servers send 'set' without it, which says nothing
    // about the new values. Add and remove need something to add or remove.
    const hasList =
      Array.isArray(rawValues) || (typeof rawValues === 'string' && rawValues.trim() !== '');
    const actionable =
      action && (values.length || (action === 'set' && hasList)) && (uids.length || ids.length);
    if (!actionable) {
      refresh();
      return;
    }

    applyThenRefresh(
      data,
      mailbox,
      path,
      (account, folder) =>
        isFlags
          ? mailboxStore.actions.applyRemoteFlags?.({
              account,
              folder,
              uids,
              ids,
              action,
              flags: values,
            })
          : mailboxStore.actions.applyRemoteLabels?.({
              account,
              folder,
              uids,
              ids,
              action,
              labels: values,
            }),
      refresh,
    );
  }

  function handleMailboxEvent(eventName, data) {
    if (!data || typeof data !== 'object') return;
    const account = eventAccount(data);
    const active = isActiveAccountEvent(data);
    let change = null;
    if (eventName === WS_EVENTS.MAILBOX_RENAMED) {
      const oldPath = normalizeIdentifier(data.oldPath ?? data.old_path);
      const newPath = normalizeIdentifier(data.newPath ?? data.new_path);
      if (oldPath && newPath) change = { type: 'renamed', oldPath, newPath };
    } else if (eventName === WS_EVENTS.MAILBOX_DELETED) {
      const path = normalizeIdentifier(data.path ?? data.mailbox?.path);
      if (path) change = { type: 'deleted', path };
    } else if (eventName === WS_EVENTS.MAILBOX_CREATED) {
      const path = normalizeIdentifier(data.path ?? data.mailbox?.path);
      if (path) change = { type: 'created', path };
    }

    if (change && account) {
      Promise.resolve(
        mailboxStore.actions.applyRemoteMailboxChange?.({ account, ...change }),
      ).catch((err) => console.warn('[updater] Failed to apply folder change:', err));
    }

    // Forced: a list fetched within the folder cache window predates this change
    if (active) mailboxStore.actions.loadFolders?.({ force: true });
  }

  // Catch up on anything a dropped message or a reconnect may have missed.
  let catchUpTimer = null;
  function scheduleCatchUp() {
    if (catchUpTimer) clearTimeout(catchUpTimer);
    catchUpTimer = setTimeout(() => {
      catchUpTimer = null;
      if (destroyed || !started) return;
      mailboxStore.actions.loadFolders?.({ force: true })?.catch?.(() => {});
      refreshCurrentFolder();
    }, CATCH_UP_DELAY_MS);
  }

  function activeAccountConnected() {
    const email = Local.get('email');
    const client = email ? wsManager?.getClient?.(email) : null;
    return Boolean(client?.connected);
  }

  // Start fallback polling (while the active account has no live socket)
  function startFallbackPoll() {
    stopFallbackPoll();
    fallbackTimer = setInterval(() => {
      if (!activeAccountConnected()) {
        refreshCurrentFolder();
      }
    }, FALLBACK_POLL_INTERVAL_MS);
  }

  function stopFallbackPoll() {
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    if (catchUpTimer) {
      clearTimeout(catchUpTimer);
      catchUpTimer = null;
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
      // stop() keeps the watcher alive on purpose, so a later start() must
      // reuse it rather than open a second socket next to the first.
      if (!demoMode && !releaseWatcher) {
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
        registerUpdateHandler(WS_EVENTS.MESSAGES_MOVED, handleMessagesMoved);
        registerUpdateHandler(WS_EVENTS.MESSAGES_COPIED, (data) => {
          if (data && typeof data === 'object') {
            refreshFolder(
              safeString(data.destinationMailbox),
              data,
              normalizeIdentifier(data.destinationPath),
            );
          }
        });
        registerUpdateHandler(WS_EVENTS.MESSAGES_EXPUNGED, handleMessagesExpunged);
        for (const eventName of [WS_EVENTS.FLAGS_UPDATED, WS_EVENTS.LABELS_UPDATED]) {
          registerUpdateHandler(eventName, (data) => handleFlagsOrLabels(eventName, data));
        }

        for (const eventName of [
          WS_EVENTS.MAILBOX_CREATED,
          WS_EVENTS.MAILBOX_DELETED,
          WS_EVENTS.MAILBOX_RENAMED,
        ]) {
          registerUpdateHandler(eventName, (data) => handleMailboxEvent(eventName, data));
        }

        // The calendar and contacts views show the active account only, and
        // match items by iCal or vCard UID, which another account can share.
        // Another account's views load fresh when the user switches to it.
        const isActiveObjectEvent = (data) =>
          Boolean(data) && typeof data === 'object' && isActiveAccountEvent(data);
        for (const eventName of [
          WS_EVENTS.CALENDAR_CREATED,
          WS_EVENTS.CALENDAR_UPDATED,
          WS_EVENTS.CALENDAR_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (isActiveObjectEvent(data)) dispatchFrozen('fe:calendar-changed', data);
          });
        }
        for (const eventName of [
          WS_EVENTS.CALENDAR_EVENT_CREATED,
          WS_EVENTS.CALENDAR_EVENT_UPDATED,
          WS_EVENTS.CALENDAR_EVENT_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (!isActiveObjectEvent(data)) return;
            dispatchFrozen('fe:calendar-event-changed', { type: eventName, payload: data });
          });
        }

        for (const eventName of [
          WS_EVENTS.ADDRESS_BOOK_CREATED,
          WS_EVENTS.ADDRESS_BOOK_UPDATED,
          WS_EVENTS.ADDRESS_BOOK_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (isActiveObjectEvent(data)) dispatchFrozen('fe:contacts-changed', data);
          });
        }
        for (const eventName of [
          WS_EVENTS.CONTACT_CREATED,
          WS_EVENTS.CONTACT_UPDATED,
          WS_EVENTS.CONTACT_DELETED,
        ]) {
          registerUpdateHandler(eventName, (data) => {
            if (isActiveObjectEvent(data)) dispatchFrozen('fe:contact-changed', data);
          });
        }

        // A push the system displayed (app in the background) still carries a
        // data change; only its alert is already handled.
        const pushUpdateHandler = (event) => {
          const payload = event?.detail;
          if (!updateHandlers.has(payload?.event)) return;
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

        // After a reconnect, events sent while the socket was down are gone.
        // The first connection needs no catch-up: the initial load covers it.
        const disconnectedAccounts = new Set();
        wsUnsubs.push(
          wsManager.on('_disconnected', (data) => {
            if (isNonEmptyString(data?._account)) disconnectedAccounts.add(data._account);
          }),
          wsManager.on('_authenticated', (data) => {
            if (!isNonEmptyString(data?._account)) return;
            if (!disconnectedAccounts.delete(data._account)) return;
            // Another account's view reloads in full when the user switches to it.
            if (isActiveAccountEvent(data)) scheduleCatchUp();
          }),
          // An event dropped for size or rate cannot be replayed: refresh instead.
          wsManager.on('_messageDropped', (data) => {
            if (isActiveAccountEvent(data)) scheduleCatchUp();
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
        initNotificationPermission().catch(() => {});

        startFallbackPoll();
      }

      // When the app becomes visible: refresh messages, reconnect WS if needed,
      // and re-sync labels/settings.
      visibilityHandler = () => {
        if (document.hidden || destroyed || !started) return;

        // Coming back to a locked app is the one case where none of this can
        // work: the account list and credentials are sealed, so reconcile()
        // would see nobody to connect and tear down every live socket instead.
        // The unlock path re-runs this via fe:force-reconnect.
        if (isVaultLocked()) return;

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

      // Explicit "the app can authenticate again" signal, sent by the mobile
      // resume path and after an app-lock unlock. Both are moments when the
      // sockets are down and no visibilitychange is coming to revive them.
      forceReconnectHandler = () => {
        if (destroyed || !started || isVaultLocked()) return;
        refreshCurrentFolder();
        if (wsManager) {
          wsManager.reconcile();
          wsManager.reconnectAll();
        }
      };
      globalThis.addEventListener('fe:force-reconnect', forceReconnectHandler);
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
      if (forceReconnectHandler) {
        globalThis.removeEventListener('fe:force-reconnect', forceReconnectHandler);
        forceReconnectHandler = null;
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
