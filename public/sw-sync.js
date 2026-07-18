/* Background sync helper for fetching folders/messages into IndexedDB.
 *
 * Imported by workbox-generated sw.js via workbox.config.cjs importScripts.
 * This file is plain JS (no bundler) and uses bare IndexedDB APIs to avoid
 * pulling in Dexie inside the service worker.
 */

(() => {
  // IMPORTANT: Must match src/utils/db-constants.ts SCHEMA_VERSION.
  // The main app uses `webmail-cache-v${SCHEMA_VERSION}` in production.
  const SCHEMA_VERSION = 1;
  const DB_NAME = `webmail-cache-v${SCHEMA_VERSION}`;
  const MANIFEST_STORE = 'syncManifests';
  const MESSAGES_STORE = 'messages';
  const BODIES_STORE = 'messageBodies';
  const FOLDERS_STORE = 'folders';
  const META_STORE = 'meta';
  // Written by src/utils/db-crypto-bridge.js. When App Lock is enabled the
  // main app stores message data encrypted (a key this SW never has), so
  // background content sync must not write plaintext records behind it.
  const APP_LOCK_FLAG_KEY = 'app_lock_enabled';
  const state = new Map(); // folderKey -> { cancelled, running }
  const LOG = false;

  // Track every successful IDBDatabase handle so a `close-idb` message
  // from the main app (during recovery) can force all of them closed —
  // otherwise `indexedDB.deleteDatabase()` on the main thread stays
  // blocked waiting for the SW's handles to release.
  const openDbHandles = new Set();
  let allowOpen = true;
  // Safety net: if `close-idb` arrives but the matching `reopen-idb` never does
  // (older client, lost message, tab closed mid-recovery), auto re-enable opens
  // so background sync isn't disabled forever. Cleared when `reopen-idb` lands.
  let reopenSafetyTimer = null;
  const REOPEN_SAFETY_MS = 10000;

  const DEFAULT_PAGE_SIZE = 100;

  const postToClients = async (payload) => {
    const clientsList = await self.clients.matchAll({ type: 'window' });
    clientsList.forEach((client) => client.postMessage(payload));
  };

  /**
   * Open database with robust error handling
   * - Handles VersionError gracefully by opening without version
   * - Handles blocked state with retry logic
   * - Falls back to read-only mode if necessary
   */
  const openDb = () =>
    new Promise((resolve, reject) => {
      if (!allowOpen) {
        reject(new Error('SW IDB closed for recovery — try again after reopen'));
        return;
      }
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelay = 500;

      const attemptOpen = () => {
        // Open without forcing a version to avoid VersionError when users already have a newer schema.
        const req = indexedDB.open(DB_NAME);

        req.onupgradeneeded = (event) => {
          const db = req.result;
          // Only create stores if this is a fresh database (version 0 -> 1)
          // Don't try to create stores during upgrades from higher versions
          if (event.oldVersion === 0 || !db.objectStoreNames.contains(MANIFEST_STORE)) {
            try {
              db.createObjectStore(MANIFEST_STORE, { keyPath: ['account', 'folder'] });
            } catch (err) {
              LOG && console.warn('[SW sync] Could not create manifest store:', err.message);
              // Don't reject - the store might already exist
            }
          }
        };

        req.onsuccess = () => {
          const db = req.result;
          openDbHandles.add(db);

          // Handle version change events (another tab upgrading the database)
          db.onversionchange = () => {
            LOG && console.log('[SW sync] Database version change detected, closing connection');
            db.close();
            openDbHandles.delete(db);
          };

          // If manifest store is missing (older DB), upgrade by bumping version by 1.
          if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
            const nextVersion = db.version + 1;
            db.close();
            const upgradeReq = indexedDB.open(DB_NAME, nextVersion);

            upgradeReq.onupgradeneeded = () => {
              const udb = upgradeReq.result;
              if (!udb.objectStoreNames.contains(MANIFEST_STORE)) {
                try {
                  udb.createObjectStore(MANIFEST_STORE, { keyPath: ['account', 'folder'] });
                } catch (err) {
                  LOG &&
                    console.warn(
                      '[SW sync] Could not create manifest store during upgrade:',
                      err.message,
                    );
                }
              }
            };

            upgradeReq.onsuccess = () => {
              const udb = upgradeReq.result;
              openDbHandles.add(udb);
              udb.onversionchange = () => {
                LOG &&
                  console.log('[SW sync] Database version change detected, closing connection');
                udb.close();
                openDbHandles.delete(udb);
              };
              resolve(udb);
            };

            upgradeReq.onerror = () => {
              const error = upgradeReq.error;
              console.error('[SW sync] IndexedDB upgrade failed:', error);
              // If upgrade failed due to version error, try to use the database anyway
              if (error?.name === 'VersionError') {
                LOG && console.log('[SW sync] Retrying open without version requirement');
                const retryReq = indexedDB.open(DB_NAME);
                retryReq.onsuccess = () => {
                  const rdb = retryReq.result;
                  openDbHandles.add(rdb);
                  rdb.onversionchange = () => {
                    LOG &&
                      console.log('[SW sync] Database version change detected, closing connection');
                    rdb.close();
                    openDbHandles.delete(rdb);
                  };
                  resolve(rdb);
                };
                retryReq.onerror = () => reject(retryReq.error);
              } else {
                reject(error || new Error('IndexedDB upgrade failed'));
              }
            };

            upgradeReq.onblocked = () => {
              LOG &&
                console.warn(
                  '[SW sync] IndexedDB upgrade blocked, waiting for connections to close',
                );
              // Don't reject immediately - wait for unblock
            };

            return;
          }

          resolve(db);
        };

        req.onerror = () => {
          const error = req.error;
          console.error('[SW sync] IndexedDB open failed:', error);

          // Retry on certain errors
          if (
            retryCount < maxRetries &&
            (error?.name === 'AbortError' || error?.name === 'UnknownError')
          ) {
            retryCount++;
            LOG &&
              console.log(`[SW sync] Retrying database open (attempt ${retryCount}/${maxRetries})`);
            setTimeout(attemptOpen, retryDelay * retryCount);
            return;
          }

          reject(error || new Error('IndexedDB open failed'));
        };

        req.onblocked = () => {
          LOG && console.warn('[SW sync] IndexedDB open blocked; will retry on next message');
          // Don't reject - the open might still succeed after other connections close

          // Set a timeout to reject if we stay blocked too long
          setTimeout(() => {
            if (req.readyState === 'pending') {
              console.error('[SW sync] IndexedDB open blocked for too long');
              reject(new Error('IndexedDB open blocked'));
            }
          }, 10000); // 10 second timeout
        };
      };

      attemptOpen();
    });

  /**
   * Execute a function with access to database stores
   * Includes robust error handling and fallback mechanisms
   */
  const withStore = async (storeNames, mode, fn) => {
    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.error('[SW sync] Failed to open database:', err);
      // Notify main thread about database issues
      await postToClients({
        type: 'dbError',
        error: err.message,
        errorName: err.name,
        recoverable: ['VersionError', 'InvalidStateError', 'NotFoundError'].includes(err.name),
      });
      throw err;
    }

    return new Promise((resolve, reject) => {
      // Verify the required stores exist
      const missingStores = storeNames.filter((name) => !db.objectStoreNames.contains(name));
      if (missingStores.length > 0) {
        console.error('[SW sync] Missing object stores:', missingStores);
        // Notify main thread that stores are missing (schema mismatch)
        postToClients({
          type: 'dbError',
          error: `Missing object stores: ${missingStores.join(', ')}`,
          errorName: 'NotFoundError',
          recoverable: true,
        });
        reject(new Error(`Missing object stores: ${missingStores.join(', ')}`));
        return;
      }

      try {
        const tx = db.transaction(storeNames, mode);

        tx.oncomplete = () => resolve();

        tx.onerror = () => {
          const error = tx.error;
          console.error('[SW sync] Transaction error:', error);
          reject(error || new Error('Transaction failed'));
        };

        tx.onabort = () => {
          const error = tx.error;
          console.error('[SW sync] Transaction aborted:', error);
          reject(error || new Error('Transaction aborted'));
        };

        fn(tx);
      } catch (err) {
        console.error('[SW sync] Error creating transaction:', err);
        reject(err);
      }
    });
  };

  const readManifest = async (account, folder) => {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(MANIFEST_STORE, 'readonly');
        const store = tx.objectStore(MANIFEST_STORE);
        const req = store.get([account, folder]);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      LOG && console.warn('[SW sync] readManifest failed', err);
      return null;
    }
  };

  const writeManifest = async (manifest) => {
    const toWrite = {
      ...manifest,
      updatedAt: Date.now(),
    };
    await withStore([MANIFEST_STORE], 'readwrite', (tx) => {
      tx.objectStore(MANIFEST_STORE).put(toWrite);
    });
  };

  const isCancelled = (folderKey) => state.get(folderKey)?.cancelled;

  // Message normalization lives in the shared sw-message-normalize.js
  // (loaded first via workbox importScripts) so the SW and the canonical
  // src/utils/sync-helpers.ts agree on the data-integrity fields. See that file
  // and tests/unit/message-normalize-contract.test.ts.
  const normalizeMessage = (raw, account, folder) =>
    self.normalizeMessageRecord(raw, folder, account);

  const writeMessages = async (messages) => {
    if (!messages?.length) return;
    await withStore([MESSAGES_STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(MESSAGES_STORE);
      messages.forEach((msg) => store.put(msg));
    });
  };

  const writeBodies = async (bodies) => {
    if (!bodies?.length) return;
    await withStore([BODIES_STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(BODIES_STORE);
      bodies.forEach((body) => store.put(body));
    });
  };

  const fetchMessageDetail = async (apiBase, headers, messageId, folder) => {
    const url = `${trimApiBase(apiBase)}/v1/messages/${encodeURIComponent(messageId)}?folder=${encodeURIComponent(folder)}`;
    return fetchJson(url, headers);
  };

  const fetchBodiesForMessages = async (messages, { apiBase, headers, accountId, folderId }) => {
    const bodies = [];
    for (const msg of messages) {
      if (!msg?.id) continue;
      if (isCancelled(`${accountId}:${folderId}`)) break;
      try {
        const detail = await fetchMessageDetail(apiBase, headers, msg.id, folderId);
        const result = detail?.Result || detail || {};
        const serverText =
          result?.Plain ||
          result?.text ||
          result?.body ||
          result?.preview ||
          result?.nodemailer?.text ||
          result?.nodemailer?.preview ||
          '';
        const rawBody =
          result?.html ||
          result?.Html ||
          result?.textAsHtml ||
          result?.nodemailer?.html ||
          result?.nodemailer?.textAsHtml ||
          serverText ||
          msg.snippet ||
          '';
        const detailAttachments = result?.nodemailer?.attachments || result?.attachments || [];
        const attachments = (detailAttachments || []).map((att) => ({
          name: att.name || att.filename,
          filename: att.filename,
          size: att.size,
          contentId: att.cid || att.contentId,
          href: att.url || '',
          contentType: att.contentType || att.mimeType || att.type,
        }));
        bodies.push({
          account: accountId,
          id: msg.id,
          folder: folderId,
          body: rawBody,
          textContent: serverText || rawBody,
          attachments,
          updatedAt: Date.now(),
        });
      } catch (err) {
        LOG && console.warn('[SW sync] fetch body failed', err);
      }
    }
    if (bodies.length) {
      await writeBodies(bodies);
    }
  };

  const fetchJson = async (url, headers) => {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Request failed ${res.status}: ${text}`);
    }
    return res.json();
  };

  const trimApiBase = (apiBase = '') => {
    if (!apiBase) return '';
    return apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
  };

  const fetchFolders = async (apiBase, headers) => {
    return fetchJson(`${trimApiBase(apiBase)}/v1/folders`, headers);
  };

  const fetchMessagesPage = async (apiBase, headers, folder, page, limit) => {
    const url = new URL(`${trimApiBase(apiBase)}/v1/messages`);
    url.searchParams.set('folder', folder);
    url.searchParams.set('page', page);
    url.searchParams.set('limit', limit);
    // Use lightweight mode to skip expensive MIME rebuild + attachment fetching.
    // Bodies are fetched separately in the fetchBodiesForMessages() pass.
    url.searchParams.set('lightweight', 'true');
    return fetchJson(url.toString(), headers);
  };

  /**
   * True when the main app has App Lock (at-rest encryption) enabled.
   * Read from the plaintext meta flag; on any error default to false so a
   * missing flag never disables background sync for the common case.
   */
  const isAppLockEnabled = async () => {
    try {
      const db = await openDb();
      if (!db.objectStoreNames.contains(META_STORE)) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).get(APP_LOCK_FLAG_KEY);
        req.onsuccess = () => resolve(req.result?.value === true);
        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  };

  const startSync = async (opts) => {
    const {
      accountId,
      folderId,
      fetchBodies = false,
      apiBase,
      authToken,
      pageSize = DEFAULT_PAGE_SIZE,
      maxMessages,
    } = opts;

    if (await isAppLockEnabled()) {
      LOG && console.log('[SW sync] Skipped: App Lock at-rest encryption is enabled');
      await postToClients({
        type: 'syncProgress',
        folderId,
        status: 'skipped-app-lock',
        pagesDone: 0,
        messagesDone: 0,
      });
      return;
    }
    const folderKey = `${accountId}:${folderId}`;
    state.set(folderKey, { cancelled: false, running: true });
    await postToClients({
      type: 'syncProgress',
      folderId,
      status: 'running',
      pagesDone: 0,
      messagesDone: 0,
    });

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers.Authorization = `Basic ${btoa(authToken)}`;
    }

    try {
      if (!authToken) throw new Error('Missing auth token for sync');
      const cleanedApiBase = trimApiBase(apiBase);
      LOG && console.log('[SW sync] start', { accountId, folderId, fetchBodies });
      // Step 1: ensure folders are cached (best effort)
      try {
        const folderRes = await fetchFolders(cleanedApiBase, headers);
        const list = folderRes?.Result || folderRes?.folders || folderRes || [];
        if (Array.isArray(list) && list.length) {
          await withStore([FOLDERS_STORE], 'readwrite', (tx) => {
            const store = tx.objectStore(FOLDERS_STORE);
            list.forEach((f) => {
              const path = f.path || f.name || f.Path || f.Name;
              if (!path) return;
              store.put({
                account: accountId,
                path,
                name: f.name || f.Name || path,
                unread_count: f.unread_count || f.Unread || 0,
                specialUse: f.specialUse || f.SpecialUse,
                updatedAt: Date.now(),
              });
            });
          });
        }
      } catch (err) {
        LOG && console.warn('[SW sync] folder fetch skipped', err);
      }

      // Always start from page 1 to keep list fresh
      let manifest = {
        account: accountId,
        folder: folderId,
        lastUID: null,
        lastSyncAt: Date.now(),
        pagesFetched: 0,
        messagesFetched: 0,
        hasBodiesPass: false,
      };

      let page = 1;
      let totalMessages = manifest.messagesFetched || 0;
      let continuePaging = true;

      while (continuePaging) {
        if (isCancelled(folderKey)) {
          await postToClients({
            type: 'syncCancelled',
            folderId,
            pagesDone: manifest.pagesFetched,
            messagesDone: manifest.messagesFetched,
          });
          state.set(folderKey, { cancelled: false, running: false });
          return;
        }

        const res = await fetchMessagesPage(cleanedApiBase, headers, folderId, page, pageSize);
        const list =
          res?.Result?.List || res?.Result?.list || res?.Result || res?.List || res || [];
        if (!Array.isArray(list) || !list.length) {
          continuePaging = false;
          break;
        }

        const mapped = list.map((raw) => normalizeMessage(raw, accountId, folderId));
        await writeMessages(mapped);
        if (fetchBodies) {
          await fetchBodiesForMessages(mapped, {
            apiBase: cleanedApiBase,
            headers,
            accountId,
            folderId,
          });
        }

        manifest = {
          ...manifest,
          lastSyncAt: Date.now(),
          pagesFetched: page,
          messagesFetched: totalMessages + mapped.length,
          lastUID: mapped[0]?.id || manifest.lastUID,
        };
        await writeManifest(manifest);
        await postToClients({
          type: 'syncProgress',
          folderId,
          status: 'running',
          pagesDone: manifest.pagesFetched,
          messagesDone: manifest.messagesFetched,
          lastUID: manifest.lastUID,
        });

        totalMessages += mapped.length;
        page += 1;

        if (maxMessages && totalMessages >= maxMessages) break;
      }

      await postToClients({
        type: 'syncComplete',
        folderId,
        messagesDone: manifest.messagesFetched,
        lastUID: manifest.lastUID,
        lastSyncAt: manifest.lastSyncAt,
      });
      state.set(folderKey, { cancelled: false, running: false });
    } catch (err) {
      console.error('[SW sync] sync failed', err);
      await postToClients({
        type: 'syncProgress',
        folderId,
        status: 'error',
        error: err.message,
        pagesDone: 0,
        messagesDone: 0,
      });
      state.set(folderKey, { cancelled: false, running: false });
    }
  };

  // ── Background Sync: process offline mutation queue ──────────────────
  // (META_STORE is declared with the other store names at the top.)
  const MUTATION_QUEUE_PREFIX = 'mutation_queue_';
  const MUTATION_MAX_RETRIES = 5;

  /**
   * Read all mutation queue entries from the meta store.
   * Returns an array of { key, queue } objects.
   */
  const readAllMutationQueues = async () => {
    const db = await openDb();
    if (!db.objectStoreNames.contains(META_STORE)) return [];

    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const store = tx.objectStore(META_STORE);
      const results = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        const record = cursor.value;
        if (
          record?.key &&
          typeof record.key === 'string' &&
          record.key.startsWith(MUTATION_QUEUE_PREFIX) &&
          Array.isArray(record.value)
        ) {
          results.push({ key: record.key, queue: record.value });
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  };

  /**
   * Write a mutation queue back to the meta store.
   */
  const writeMutationQueue = async (key, queue) => {
    const db = await openDb();
    if (!db.objectStoreNames.contains(META_STORE)) return;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      store.put({ key, value: queue, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  /**
   * Fetch with a timeout to prevent hung requests from blocking the mutation queue.
   */
  const MUTATION_FETCH_TIMEOUT_MS = 30_000;
  const fetchWithTimeout = (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MUTATION_FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  };

  /**
   * Execute a single mutation via fetch from the SW context.
   */
  const executeMutationSW = async (mutation) => {
    const { type, payload, apiBase, authHeader } = mutation;
    if (!apiBase || !authHeader) return false;

    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader,
    };

    const msgPath = `/v1/messages/${encodeURIComponent(payload.messageId)}`;

    switch (type) {
      case 'toggleRead': {
        const flags = payload.isUnread
          ? (payload.flags || []).filter((f) => f !== '\\Seen')
          : [...(payload.flags || []), '\\Seen'];
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ flags, folder: payload.folder }),
        });
        return res.ok;
      }
      case 'toggleStar': {
        const flags = payload.isStarred
          ? (payload.flags || []).filter((f) => f !== '\\Flagged')
          : [...(payload.flags || []), '\\Flagged'];
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ flags, folder: payload.folder }),
        });
        return res.ok;
      }
      case 'move': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ folder: payload.targetFolder }),
        });
        return res.ok;
      }
      case 'delete': {
        const path = payload.permanent ? `${msgPath}?permanent=1` : msgPath;
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: 'DELETE',
          headers,
        });
        return res.ok;
      }
      case 'label': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ labels: payload.labels }),
        });
        return res.ok;
      }
      default:
        return false;
    }
  };

  /**
   * Process all mutation queues from IndexedDB.
   * Called by the Background Sync event when connectivity returns.
   */
  const processMutationsSW = async () => {
    let queues;
    try {
      queues = await readAllMutationQueues();
    } catch (err) {
      LOG && console.warn('[SW sync] Failed to read mutation queues', err);
      return;
    }

    for (const { key, queue } of queues) {
      let modified = false;
      for (const mutation of queue) {
        if (mutation.status === 'completed') continue;
        if (mutation.status === 'failed' && mutation.retryCount >= MUTATION_MAX_RETRIES) continue;
        if (mutation.nextRetryAt && Date.now() < mutation.nextRetryAt) continue;

        mutation.status = 'processing';
        modified = true;

        try {
          const ok = await executeMutationSW(mutation);
          mutation.status = ok ? 'completed' : 'failed';
          if (!ok) mutation.retryCount = (mutation.retryCount || 0) + 1;
        } catch {
          mutation.retryCount = (mutation.retryCount || 0) + 1;
          mutation.status = mutation.retryCount >= MUTATION_MAX_RETRIES ? 'failed' : 'pending';
        }
      }

      if (modified) {
        const remaining = queue.filter((m) => m.status !== 'completed');
        try {
          await writeMutationQueue(key, remaining);
        } catch (err) {
          LOG && console.warn('[SW sync] Failed to write mutation queue', err);
        }
      }
    }

    // Notify open tabs to refresh their queue count
    await postToClients({ type: 'mutationQueueProcessed' });
  };

  // Background Sync event — fired when connectivity returns
  self.addEventListener('sync', (event) => {
    if (event.tag === 'mutation-queue') {
      event.waitUntil(processMutationsSW());
    }
  });

  self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (!data.type) return;
    if (data.type === 'startSync') {
      startSync(data);
    } else if (data.type === 'cancelSync') {
      const key = `${data.accountId}:${data.folderId}`;
      const current = state.get(key) || {};
      current.cancelled = true;
      state.set(key, current);
    } else if (data.type === 'syncStatus') {
      readManifest(data.accountId, data.folderId).then((manifest) => {
        postToClients({
          type: 'syncProgress',
          folderId: data.folderId,
          status: 'idle',
          pagesDone: manifest?.pagesFetched || 0,
          messagesDone: manifest?.messagesFetched || 0,
          lastUID: manifest?.lastUID || null,
          lastSyncAt: manifest?.lastSyncAt || null,
        });
      });
    } else if (data.type === 'close-idb') {
      // Main app is about to call indexedDB.deleteDatabase() for recovery.
      // Close every tracked handle so the delete isn't blocked by us.
      // allowOpen=false refuses any in-flight openDb() calls until reopened.
      allowOpen = false;
      openDbHandles.forEach((db) => {
        try {
          db.close();
        } catch {
          /* ignore — browser will close on worker teardown */
        }
      });
      openDbHandles.clear();
      clearTimeout(reopenSafetyTimer);
      reopenSafetyTimer = setTimeout(() => {
        allowOpen = true;
      }, REOPEN_SAFETY_MS);
      event.ports?.[0]?.postMessage?.({ ok: true });
    } else if (data.type === 'reopen-idb') {
      clearTimeout(reopenSafetyTimer);
      reopenSafetyTimer = null;
      allowOpen = true;
      event.ports?.[0]?.postMessage?.({ ok: true });
    }
  });
})();
