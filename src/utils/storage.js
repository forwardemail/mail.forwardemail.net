import { db } from './db';
import { warn } from './logger.ts';
import {
  isSensitiveLocalKey,
  isVaultLocked,
  protectLocalValue,
  revealLocalValue,
} from './crypto-store.js';

const PREFIX = 'webmail_';
const ACCOUNTS_KEY = `${PREFIX}accounts`; // List of all logged-in accounts (localStorage - persistent)
const SESSION_ACCOUNTS_KEY = `${PREFIX}session_accounts`; // Session-only accounts (sessionStorage)
const ACTIVE_ACCOUNT_KEY = `${PREFIX}active_account`; // Currently active account email
const PENDING_DELETES_KEY = 'pending_account_deletes';
const META_PENDING_DELETES_KEY = 'pending_account_deletes';

const parseJsonList = (value) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const readPendingDeletesLocal = () => parseJsonList(Local.get(PENDING_DELETES_KEY));

const readPendingDeletesMeta = async () => {
  try {
    const record = await db.meta.get(META_PENDING_DELETES_KEY);
    return Array.isArray(record?.value) ? record.value : [];
  } catch {
    return [];
  }
};

const persistPendingDeletes = async (list) => {
  const next = Array.isArray(list) ? list : [];
  if (next.length > 0) {
    Local.set(PENDING_DELETES_KEY, JSON.stringify(next));
  } else {
    Local.remove(PENDING_DELETES_KEY);
  }

  try {
    await db.meta.put({
      key: META_PENDING_DELETES_KEY,
      value: next,
      updatedAt: Date.now(),
    });
  } catch {
    // ignore meta persistence failures
  }
};

const collectAccountsFromTable = async (table, set) => {
  try {
    const rows = await table.toArray();
    rows.forEach((row) => {
      if (row?.account) set.add(row.account);
    });
  } catch {
    // ignore table scan failures
  }
};

const getCachedAccountIds = async () => {
  const accounts = new Set();
  await collectAccountsFromTable(db.folders, accounts);
  await collectAccountsFromTable(db.settings, accounts);
  await collectAccountsFromTable(db.drafts, accounts);
  await collectAccountsFromTable(db.outbox, accounts);
  await collectAccountsFromTable(db.labels, accounts);
  await collectAccountsFromTable(db.syncManifests, accounts);
  return Array.from(accounts);
};

// Per-account rows in the `meta` table. Keys built as `${prefix}${account}`
// with nothing after the address are deleted by exact key; keys that continue
// past the address carry a trailing `_` so that removing a@x.com does not also
// match a@x.com.au. Writers: mutation-queue.js, contact-cache.js,
// search-service.js, attachment-cache.js and Calendar.svelte.
const META_EXACT_KEY_PREFIXES = [
  'mutation_queue_',
  'contacts_v2_',
  'calendars_',
  'calendar_prefs_',
];
const META_KEY_PREFIXES = ['saved_search_', 'att_blob_', 'calendar_events_'];
const ATTACHMENT_MANIFEST_KEY = 'att_cache_manifest';

const accountKeyVariants = (email) =>
  Array.from(new Set([email, String(email || '').toLowerCase()].filter(Boolean)));

// Lists keys first and then deletes them by primary key. A prefix delete
// through the db worker client has not always honoured startsWith, and an
// explicit key list behaves the same on every backend.
const deleteMetaKeysWithPrefix = async (prefix) => {
  const rows = await db.meta.where('key').startsWith(prefix).toArray();
  const keys = (rows || [])
    .map((row) => row?.key)
    .filter((key) => typeof key === 'string' && key.startsWith(prefix));
  if (keys.length) await db.meta.bulkDelete(keys);
  return keys;
};

const pruneAttachmentManifest = async (removedKeys) => {
  if (!removedKeys.length) return;
  const removed = new Set(removedKeys);
  const record = await db.meta.get(ATTACHMENT_MANIFEST_KEY);
  const manifest = record?.value;
  if (!manifest || !Array.isArray(manifest.entries)) return;
  const entries = manifest.entries.filter((entry) => !removed.has(entry?.key));
  if (entries.length === manifest.entries.length) return;
  const totalBytes = entries.reduce((sum, entry) => sum + (Number(entry?.size) || 0), 0);
  await db.meta.put({
    key: ATTACHMENT_MANIFEST_KEY,
    value: { ...manifest, entries, totalBytes },
    updatedAt: Date.now(),
  });
};

const clearAccountMetaData = async (email) => {
  const exactKeys = [];
  for (const variant of accountKeyVariants(email)) {
    for (const prefix of META_EXACT_KEY_PREFIXES) exactKeys.push(`${prefix}${variant}`);
  }
  await db.meta.bulkDelete(exactKeys);

  const removedAttachmentKeys = [];
  for (const variant of accountKeyVariants(email)) {
    for (const prefix of META_KEY_PREFIXES) {
      const removed = await deleteMetaKeysWithPrefix(`${prefix}${variant}_`);
      if (prefix === 'att_blob_') removedAttachmentKeys.push(...removed);
    }
  }
  await pruneAttachmentManifest(removedAttachmentKeys);
};

// Per-account localStorage values, all stored as `${name}${account}`. The
// profile keys are written lowercased (settingsStore.ts); the rest use the
// account string as stored, so both spellings are removed.
const ACCOUNT_LOCAL_KEY_PREFIXES = [
  'pgp_keys_',
  'pgp_passphrases_',
  'pgp_recipients_',
  'signature_',
  'signature_html_',
  'signature_enabled_',
  'profile_name_',
  'profile_image_',
  'archive_folder_',
  'sent_folder_',
  'drafts_folder_',
  'trash_folder_',
  'junk_folder_',
  'font_',
  'spam_report_address_',
  'spam_report_delete_',
  'prefetch_folders_',
  'default_calendar_id_',
];

const clearAccountLocalData = (email) => {
  for (const variant of accountKeyVariants(email)) {
    for (const prefix of ACCOUNT_LOCAL_KEY_PREFIXES) Local.remove(`${prefix}${variant}`);
  }
};

/**
 * Remove the locally saved PGP material (private keys and their passphrases)
 * for one account, leaving every other account and setting alone.
 */
export const clearAccountPgpData = (email) => {
  if (!email) return;
  for (const variant of accountKeyVariants(email)) {
    Local.remove(`pgp_keys_${variant}`);
    Local.remove(`pgp_passphrases_${variant}`);
  }
};

const clearAccountCacheData = async (email) => {
  await db.transaction(
    'rw',
    [
      db.folders,
      db.messages,
      db.messageBodies,
      db.searchIndex,
      db.indexMeta,
      db.drafts,
      db.settings,
      db.settingsLabels,
      db.outbox,
      db.labels,
      db.syncManifests,
      db.meta,
    ],
    async () => {
      await Promise.all([
        db.folders.where('account').equals(email).delete(),
        db.messages.where('account').equals(email).delete(),
        db.messageBodies.where('account').equals(email).delete(),
        db.searchIndex.where('account').equals(email).delete(),
        db.indexMeta.where('account').equals(email).delete(),
        db.drafts.where('account').equals(email).delete(),
        db.settings.where('account').equals(email).delete(),
        db.settingsLabels.where('account').equals(email).delete(),
        db.outbox.where('account').equals(email).delete(),
        db.labels.where('account').equals(email).delete(),
        db.syncManifests.where('account').equals(email).delete(),
      ]);
    },
  );
  await clearAccountMetaData(email);
};

const cleanupAccountList = async (accounts) => {
  if (!accounts.length) return { cleaned: [], remaining: [] };

  const cleaned = [];
  const remaining = [];

  for (const email of accounts) {
    try {
      await clearAccountCacheData(email);
      cleaned.push(email);
    } catch (error) {
      warn('Failed to clean account data:', email, error);
      remaining.push(email);
    }
  }

  return { cleaned, remaining };
};

// Keys that should be isolated per-tab via sessionStorage so that
// multiple tabs can stay logged into different accounts independently.
const TAB_SCOPED_KEYS = new Set(['email', 'alias_auth', 'api_key', 'authToken']);

// Encrypted localStorage values start with this prefix (crypto-store.js).
// If sessionStorage was cleared (e.g. by the browser under memory pressure)
// and the localStorage fallback returns an encrypted blob, we must NOT copy
// it to sessionStorage or return it — doing so would send garbage auth
// headers to the API, causing persistent 401 errors.
const ENCRYPTED_PREFIX = '\x00ENC\x01';

// Guard: in Web Worker contexts (sync.worker.ts) or when macOS firewall
// blocks WebKit storage access, localStorage/sessionStorage may not exist.
// Return safe defaults without logging noisy console errors.
const hasLocalStorage = typeof localStorage !== 'undefined';
const hasSessionStorage = typeof sessionStorage !== 'undefined';

// Tab-scoped keys that authenticate requests. `email` is tab-scoped too but
// names the account rather than proving it.
const CREDENTIAL_KEYS = new Set(['alias_auth', 'api_key', 'authToken']);

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const readSessionAccountList = () => {
  try {
    if (!hasSessionStorage) return [];
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_ACCOUNTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * True when `email` was signed in without "Stay signed in" in this tab. Such
 * an account's credentials must only ever live in sessionStorage.
 */
const isSessionOnlyAccount = (email) => {
  const target = normalizeEmail(email);
  if (!target) return false;
  return readSessionAccountList().some((account) => normalizeEmail(account?.email) === target);
};

const tabEmail = () => {
  if (!hasSessionStorage) return null;
  const value = sessionStorage.getItem(`${PREFIX}email`);
  return value && !value.startsWith(ENCRYPTED_PREFIX) ? value : null;
};

// The account a tab-scoped write belongs to: the address being written for
// `email` itself, otherwise the account this tab is locked to.
const tabScopedOwner = (key, value) => (key === 'email' ? value : tabEmail());

/**
 * Whether this tab may adopt the credentials held in localStorage.
 *
 * localStorage holds one credential set, for the persistent account that was
 * activated last in any tab. A tab that is already locked to an account must
 * not pick up that set when it belongs to someone else: a missing alias_auth
 * in an API-key tab would otherwise be filled with another tab's alias
 * password, and every request would then go out as that alias. A tab locked
 * to a session-only account never reads credentials from localStorage at all.
 */
export const localCredentialsBelongToTab = () => {
  try {
    const owner = tabEmail();
    if (!owner) return true;
    if (isSessionOnlyAccount(owner)) return false;
    if (!hasLocalStorage) return false;
    return normalizeEmail(localStorage.getItem(`${PREFIX}email`)) === normalizeEmail(owner);
  } catch {
    return false;
  }
};

export const Local = {
  get(key) {
    try {
      if (!hasLocalStorage) return null;
      if (TAB_SCOPED_KEYS.has(key)) {
        const prefixedKey = `${PREFIX}${key}`;
        const sessionValue = hasSessionStorage ? sessionStorage.getItem(prefixedKey) : null;
        if (sessionValue !== null) {
          // Guard: if sessionStorage somehow contains an encrypted blob,
          // treat it as missing so getAuthHeader() can throw properly.
          if (sessionValue.startsWith(ENCRYPTED_PREFIX)) {
            if (hasSessionStorage) sessionStorage.removeItem(prefixedKey);
            return null;
          }
          return sessionValue;
        }
        if (CREDENTIAL_KEYS.has(key) && !localCredentialsBelongToTab()) return null;
        // First read in this tab — copy from localStorage to lock in the account
        const localValue = localStorage.getItem(prefixedKey);
        if (localValue !== null) {
          if (localValue.startsWith(ENCRYPTED_PREFIX)) {
            // Decrypt when the vault is unlocked; while locked the value is
            // unusable (returning it would send garbage auth headers → 401).
            const revealed = revealLocalValue(localValue);
            if (revealed === null) return null;
            if (hasSessionStorage) sessionStorage.setItem(prefixedKey, revealed);
            return revealed;
          }
          if (hasSessionStorage) sessionStorage.setItem(prefixedKey, localValue);
        }
        return localValue;
      }
      const value = localStorage.getItem(`${PREFIX}${key}`);
      if (value !== null && value.startsWith(ENCRYPTED_PREFIX) && isSensitiveLocalKey(key)) {
        return revealLocalValue(value);
      }
      return value;
    } catch (error) {
      console.error('localStorage.getItem failed:', error);
      return null;
    }
  },

  set(key, value) {
    try {
      if (!hasLocalStorage) return false;
      // Sensitive keys (credentials, PGP material, the accounts list) are
      // encrypted at rest whenever the App Lock vault is unlocked, not just
      // in the one-time setup sweep. Tab-scoped sessionStorage keeps the
      // plaintext copy (same model as restoreSessionCredentials).
      //
      // A session-only account ("Stay signed in" off) keeps its tab-scoped
      // keys in sessionStorage alone, so nothing survives a restart.
      const sessionOnly =
        TAB_SCOPED_KEYS.has(key) && isSessionOnlyAccount(tabScopedOwner(key, value));
      if (!sessionOnly) {
        localStorage.setItem(`${PREFIX}${key}`, protectLocalValue(key, value));
      }
      if (TAB_SCOPED_KEYS.has(key) && hasSessionStorage) {
        sessionStorage.setItem(`${PREFIX}${key}`, value);
      }
      return true;
    } catch (error) {
      console.error('localStorage.setItem failed:', error);
      return false;
    }
  },

  remove(key) {
    try {
      if (!hasLocalStorage) return false;
      // The localStorage copy belongs to the last persistent account, not to a
      // session-only one, so a session-only tab leaves it alone.
      const sessionOnly = TAB_SCOPED_KEYS.has(key) && isSessionOnlyAccount(tabEmail());
      if (!sessionOnly) localStorage.removeItem(`${PREFIX}${key}`);
      if (TAB_SCOPED_KEYS.has(key) && hasSessionStorage) {
        sessionStorage.removeItem(`${PREFIX}${key}`);
      }
      return true;
    } catch (error) {
      console.error('localStorage.removeItem failed:', error);
      return false;
    }
  },

  clear() {
    try {
      if (!hasLocalStorage) return false;
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PREFIX)) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
      // Also clear tab-scoped keys from sessionStorage
      if (hasSessionStorage) {
        TAB_SCOPED_KEYS.forEach((key) => {
          sessionStorage.removeItem(`${PREFIX}${key}`);
        });
      }
      return true;
    } catch (error) {
      console.error('localStorage.clear failed:', error);
      return false;
    }
  },
};

/**
 * Session storage wrapper - for non-persistent (session-only) data
 * Data is cleared when the browser tab/window closes
 */
export const Session = {
  get(key) {
    try {
      if (!hasSessionStorage) return null;
      return sessionStorage.getItem(`${PREFIX}${key}`);
    } catch (error) {
      console.error('sessionStorage.getItem failed:', error);
      return null;
    }
  },

  set(key, value) {
    try {
      if (!hasSessionStorage) return false;
      sessionStorage.setItem(`${PREFIX}${key}`, value);
      return true;
    } catch (error) {
      console.error('sessionStorage.setItem failed:', error);
      return false;
    }
  },

  remove(key) {
    try {
      if (!hasSessionStorage) return false;
      sessionStorage.removeItem(`${PREFIX}${key}`);
      return true;
    } catch (error) {
      console.error('sessionStorage.removeItem failed:', error);
      return false;
    }
  },

  clear() {
    try {
      if (!hasSessionStorage) return false;
      const keysToRemove = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith(PREFIX)) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => sessionStorage.removeItem(key));
      return true;
    } catch (error) {
      console.error('sessionStorage.clear failed:', error);
      return false;
    }
  },
};

/**
 * Clean up any accounts marked for deletion.
 * Intended to run on startup to finalize partial deletes.
 */
export async function cleanupPendingAccountDeletes() {
  const localPending = readPendingDeletesLocal();
  const metaPending = await readPendingDeletesMeta();
  const pending = Array.from(new Set([...localPending, ...metaPending])).filter(Boolean);

  const { cleaned, remaining } = await cleanupAccountList(pending);
  await persistPendingDeletes(remaining);
  return { cleaned, remaining };
}

// Session-only accounts register a lease in localStorage, keyed by a hash of
// the address rather than the address itself, and refresh it while their tab
// is open. Other tabs read it before treating that account's cache as
// orphaned. A tab that is closed without signing out stops refreshing, so its
// cache becomes eligible for cleanup once the lease runs out.
const SESSION_LEASES_KEY = `${PREFIX}session_account_leases`;
const SESSION_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;
let sessionLeaseTimer = null;

const leaseId = (email) => {
  // FNV-1a. Only needs to tell accounts apart; a collision just keeps a cache
  // around longer.
  const text = normalizeEmail(email);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

const readSessionLeases = () => {
  try {
    if (!hasLocalStorage) return {};
    const parsed = JSON.parse(localStorage.getItem(SESSION_LEASES_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writeSessionLeases = (leases) => {
  try {
    if (!hasLocalStorage) return;
    if (Object.keys(leases).length) {
      localStorage.setItem(SESSION_LEASES_KEY, JSON.stringify(leases));
    } else {
      localStorage.removeItem(SESSION_LEASES_KEY);
    }
  } catch {
    // A missing lease only means another tab may clean this cache early.
  }
};

const refreshSessionLeases = () => {
  const session = readSessionAccountList();
  const now = Date.now();
  const leases = readSessionLeases();
  for (const [id, seen] of Object.entries(leases)) {
    if (typeof seen !== 'number' || now - seen >= SESSION_LEASE_TTL_MS) delete leases[id];
  }
  for (const account of session) {
    if (account?.email) leases[leaseId(account.email)] = now;
  }
  writeSessionLeases(leases);
  return session.length;
};

const keepSessionLeasesAlive = () => {
  const count = refreshSessionLeases();
  if (count && !sessionLeaseTimer && typeof setInterval === 'function') {
    sessionLeaseTimer = setInterval(() => {
      if (!refreshSessionLeases() && sessionLeaseTimer) {
        clearInterval(sessionLeaseTimer);
        sessionLeaseTimer = null;
      }
    }, SESSION_LEASE_HEARTBEAT_MS);
  }
};

const dropSessionLease = (email) => {
  const leases = readSessionLeases();
  const id = leaseId(email);
  if (!(id in leases)) return;
  delete leases[id];
  writeSessionLeases(leases);
};

/**
 * Reconcile cached account data with local account list.
 * Orphaned account data is scheduled for cleanup.
 */
export async function reconcileOrphanedAccountData() {
  // While the vault is locked the account list decrypts to nothing, so every
  // account except the active one would look orphaned and have its whole
  // cached mailbox deleted. Wait until the list can actually be read.
  if (isVaultLocked()) {
    return { orphans: [], cleaned: [], remaining: [] };
  }

  const knownAccounts = new Set(
    Accounts.getAll()
      .map((account) => normalizeEmail(account?.email))
      .filter(Boolean),
  );
  const activeEmail = normalizeEmail(Local.get('email'));
  if (activeEmail) knownAccounts.add(activeEmail);

  // Session-only accounts signed in from another tab are invisible here (their
  // list lives in that tab's sessionStorage). Their lease in localStorage says
  // they are still alive, so their cache is not ours to delete.
  const leases = readSessionLeases();
  const now = Date.now();
  const isLeased = (account) => {
    const seen = leases[leaseId(account)];
    return typeof seen === 'number' && now - seen < SESSION_LEASE_TTL_MS;
  };

  const pending = new Set([...readPendingDeletesLocal(), ...(await readPendingDeletesMeta())]);
  const cachedAccounts = await getCachedAccountIds();
  const orphans = cachedAccounts.filter(
    (account) =>
      account &&
      !knownAccounts.has(normalizeEmail(account)) &&
      !pending.has(account) &&
      !isLeased(account),
  );

  if (!orphans.length) {
    return { orphans: [], cleaned: [], remaining: [] };
  }

  await persistPendingDeletes([...pending, ...orphans]);
  const cleanup = await cleanupPendingAccountDeletes();
  return { orphans, ...cleanup };
}

/**
 * Multi-Account Management
 * Handles multiple logged-in accounts with account-scoped storage
 * Supports both persistent (localStorage) and session-only (sessionStorage) accounts
 */
/**
 * Read an accounts list, transparently decrypting the localStorage copy.
 * Returns null when the value is encrypted and the vault is locked,
 * distinct from [] so writers can refuse to overwrite it.
 */
const readAccountsList = (storage, storageKey) => {
  try {
    const data = storage.getItem(storageKey);
    if (!data) return [];
    const text = data.startsWith(ENCRYPTED_PREFIX) ? revealLocalValue(data) : data;
    if (text === null) return null;
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Failed to read accounts list:', error);
    return [];
  }
};

/**
 * Write an accounts list. The persistent (localStorage) copy is encrypted
 * whenever the vault is unlocked; sessionStorage stays plaintext for its
 * tab lifetime, matching the tab-scoped credential model.
 */
const writeAccountsList = (storage, storageKey, accounts) => {
  const json = JSON.stringify(accounts);
  const value = storage === localStorage ? protectLocalValue('accounts', json) : json;
  storage.setItem(storageKey, value);
};

export const Accounts = {
  /**
   * Get persistent accounts from localStorage
   */
  getPersistent() {
    if (!hasLocalStorage) return [];
    const list = readAccountsList(localStorage, ACCOUNTS_KEY);
    return list === null ? [] : list;
  },

  /**
   * Get session-only accounts from sessionStorage
   */
  getSession() {
    try {
      if (!hasSessionStorage) return [];
      const data = sessionStorage.getItem(SESSION_ACCOUNTS_KEY);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get session accounts:', error);
      return [];
    }
  },

  /**
   * Get list of all logged-in accounts (both persistent and session)
   * Returns array of account objects: [{ email, apiKey, aliasAuth, addedAt, persistent }]
   */
  getAll() {
    const persistent = this.getPersistent().map((a) => ({ ...a, persistent: true }));
    const session = this.getSession().map((a) => ({ ...a, persistent: false }));
    // Merge, preferring persistent accounts if same email exists in both
    const emails = new Set(persistent.map((a) => a.email));
    const sessionOnly = session.filter((a) => !emails.has(a.email));
    return [...persistent, ...sessionOnly];
  },

  /**
   * Get currently active account email
   */
  getActive() {
    try {
      if (!hasLocalStorage && !hasSessionStorage) return null;
      // Check sessionStorage first (for session accounts), then localStorage
      const sessionVal = hasSessionStorage ? sessionStorage.getItem(ACTIVE_ACCOUNT_KEY) : null;
      return sessionVal || (hasLocalStorage ? localStorage.getItem(ACTIVE_ACCOUNT_KEY) : null);
    } catch (error) {
      console.error('Failed to get active account:', error);
      return null;
    }
  },

  /**
   * Set active account and load its credentials into appropriate storage
   */
  setActive(email) {
    try {
      const accounts = this.getAll();
      const target = normalizeEmail(email);
      const account = accounts.find((a) => normalizeEmail(a.email) === target);

      if (!account) {
        return false;
      }

      // The tab always records its active account. localStorage only does so
      // for persistent accounts: it is what a restart comes back to, and a
      // session-only account must not be remembered past this tab.
      if (hasLocalStorage && account.persistent) {
        localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.email);
      }
      if (hasSessionStorage) sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, account.email);
      if (!account.persistent) keepSessionLeasesAlive();

      // Load account credentials into appropriate storage
      const storage = account.persistent ? Local : Session;
      storage.set('email', account.email);
      if (account.apiKey) storage.set('api_key', account.apiKey);
      else storage.remove('api_key');
      if (account.aliasAuth) storage.set('alias_auth', account.aliasAuth);
      else storage.remove('alias_auth');

      // Also set in Local for API compatibility (Remote.js reads from Local).
      //
      // Every credential key is written unconditionally — set when the incoming
      // account has one, REMOVED when it does not. Only writing the keys the
      // new account happens to own leaves the previous account's credentials
      // behind: getAuthHeader() falls back from alias_auth to api_key, so an
      // account that authenticates by API key would inherit the alias password
      // of whoever was active before it and issue every request as them.
      Local.set('email', account.email);
      if (account.aliasAuth) Local.set('alias_auth', account.aliasAuth);
      else Local.remove('alias_auth');
      if (account.apiKey) Local.set('api_key', account.apiKey);
      else Local.remove('api_key');

      return true;
    } catch (error) {
      console.error('Failed to set active account:', error);
      return false;
    }
  },

  /**
   * Add or update an account
   * @param {string} email - Account email
   * @param {Object} credentials - Account credentials (apiKey, aliasAuth)
   * @param {boolean} staySignedIn - If true, store in localStorage (persistent); if false, sessionStorage
   */
  add(email, credentials = {}, staySignedIn = true) {
    try {
      if (staySignedIn && !hasLocalStorage) return false;
      if (!staySignedIn && !hasSessionStorage) return false;
      const storage = staySignedIn ? localStorage : sessionStorage;
      const storageKey = staySignedIn ? ACCOUNTS_KEY : SESSION_ACCOUNTS_KEY;

      // Get accounts from the appropriate storage
      const accounts = readAccountsList(storage, storageKey);
      if (accounts === null) {
        // Encrypted list + locked vault: writing now would replace every
        // stored account with just this one. Refuse; retry after unlock.
        warn('Cannot modify accounts while the vault is locked');
        return false;
      }

      const existingIndex = accounts.findIndex(
        (a) => normalizeEmail(a.email) === normalizeEmail(email),
      );

      const accountData = {
        email,
        apiKey: credentials.apiKey || credentials.api_key || null,
        aliasAuth: credentials.aliasAuth || credentials.alias_auth || null,
        addedAt: existingIndex >= 0 ? accounts[existingIndex].addedAt : Date.now(),
        lastActive: Date.now(),
      };

      if (existingIndex >= 0) {
        accounts[existingIndex] = accountData;
      } else {
        accounts.push(accountData);
      }

      writeAccountsList(storage, storageKey, accounts);

      // If moving from session to persistent (or vice versa), remove from the other storage
      const otherAvailable = staySignedIn ? hasSessionStorage : hasLocalStorage;
      const otherStorage = staySignedIn ? sessionStorage : localStorage;
      const otherKey = staySignedIn ? SESSION_ACCOUNTS_KEY : ACCOUNTS_KEY;
      try {
        if (!otherAvailable) throw new Error('skip');
        const otherAccounts = readAccountsList(otherStorage, otherKey);
        if (otherAccounts !== null && otherAccounts.length) {
          const filtered = otherAccounts.filter(
            (a) => normalizeEmail(a.email) !== normalizeEmail(email),
          );
          if (filtered.length !== otherAccounts.length) {
            if (filtered.length > 0) {
              writeAccountsList(otherStorage, otherKey, filtered);
            } else {
              otherStorage.removeItem(otherKey);
            }
          }
        }
      } catch {
        // Ignore cleanup errors
      }

      if (!staySignedIn) keepSessionLeasesAlive();

      return true;
    } catch (error) {
      console.error('Failed to add account:', error);
      return false;
    }
  },

  /**
   * Remove an account and its associated data
   * @param {string} email - Account email to remove
   * @param {boolean} clearCache - Whether to clear IndexedDB cache for this account
   */
  async remove(email, clearCache = true) {
    try {
      // Remove from both storages
      let found = false;
      const target = normalizeEmail(email);
      const keep = (a) => normalizeEmail(a.email) !== target;
      // Per-account data is keyed by the address as it was stored, which may
      // differ in case from the one passed in.
      const storedEmails = new Set([email]);

      // Remove from persistent storage (refuse while the vault is locked;
      // getPersistent would read [] and the write would clobber the list)
      if (hasLocalStorage && isVaultLocked() && localStorage.getItem(ACCOUNTS_KEY)) {
        warn('Cannot remove persistent account while the vault is locked');
        return false;
      }
      const persistent = this.getPersistent();
      const filteredPersistent = persistent.filter(keep);
      if (filteredPersistent.length !== persistent.length) {
        found = true;
        persistent.filter((a) => !keep(a)).forEach((a) => storedEmails.add(a.email));
        if (hasLocalStorage) {
          if (filteredPersistent.length > 0) {
            writeAccountsList(localStorage, ACCOUNTS_KEY, filteredPersistent);
          } else {
            localStorage.removeItem(ACCOUNTS_KEY);
          }
        }
      }

      // Remove from session storage
      const session = this.getSession();
      const filteredSession = session.filter(keep);
      if (filteredSession.length !== session.length) {
        found = true;
        session.filter((a) => !keep(a)).forEach((a) => storedEmails.add(a.email));
        if (filteredSession.length > 0 && hasSessionStorage) {
          sessionStorage.setItem(SESSION_ACCOUNTS_KEY, JSON.stringify(filteredSession));
        } else if (hasSessionStorage) {
          sessionStorage.removeItem(SESSION_ACCOUNTS_KEY);
        }
      }
      dropSessionLease(email);

      if (found) {
        // If this was the active account, switch to another or clear active
        const activeAccount = this.getActive();
        const remaining = this.getAll();

        if (normalizeEmail(activeAccount) === target) {
          if (remaining.length > 0) {
            this.setActive(remaining[0].email);
          } else {
            if (hasLocalStorage) localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
            if (hasSessionStorage) sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY);
            Local.clear();
            Session.clear();
          }
        }
      } else {
        // Still clear what this account left behind: a caller asking to
        // remove it wants its data gone even if the list entry already is.
        warn('Account not found:', email);
      }

      // Clean up PGP keys, signatures, profile and other per-account values
      for (const stored of storedEmails) clearAccountLocalData(stored);

      // Clear IndexedDB cache for this account if requested
      if (clearCache) {
        for (const stored of storedEmails) {
          const pending = Array.from(new Set([...readPendingDeletesLocal(), stored]));
          await persistPendingDeletes(pending);
          await clearAccountCacheData(stored);
          const nextPending = pending.filter((item) => item !== stored);
          await persistPendingDeletes(nextPending);
        }
      }

      return found;
    } catch (error) {
      console.error('Failed to remove account:', error);
      return false;
    }
  },

  /**
   * Check if an account exists
   */
  exists(email) {
    const accounts = this.getAll();
    return accounts.some((a) => normalizeEmail(a.email) === normalizeEmail(email));
  },

  /**
   * Check if an account is persistent (stay signed in)
   */
  isPersistent(email) {
    const persistent = this.getPersistent();
    return persistent.some((a) => normalizeEmail(a.email) === normalizeEmail(email));
  },

  /**
   * Initialize account system
   * Migrates from old single-account system to multi-account
   */
  init() {
    try {
      // While the vault is locked the accounts list is unreadable; a
      // migration pass here would see "no accounts" and rebuild the list
      // from (also unreadable) credentials. Skip; bootstrap re-runs flows
      // after unlock.
      if (isVaultLocked()) return true;

      // Older builds wrote session-only credentials to localStorage as well.
      // Anything there that no persistent account owns, written by a sign-in
      // that said "Stay signed in: off", is such a leftover, and adopting it
      // would sign that account back in. Without that answer (builds from
      // before the setting, or an older single-account sign-in) the
      // credentials are the user's real sign-in and are migrated below.
      const signMe = Local.get('signMe');
      const persistentAccounts = this.getPersistent();
      const storedEmail = hasLocalStorage ? localStorage.getItem(`${PREFIX}email`) : null;
      const ownedByPersistent = persistentAccounts.some(
        (a) => normalizeEmail(a.email) === normalizeEmail(storedEmail),
      );
      const isLegacySingleAccount = persistentAccounts.length === 0 && signMe !== '0';
      if (storedEmail && !ownedByPersistent && !isLegacySingleAccount) {
        for (const key of ['email', ...CREDENTIAL_KEYS]) localStorage.removeItem(`${PREFIX}${key}`);
        if (
          normalizeEmail(localStorage.getItem(ACTIVE_ACCOUNT_KEY)) === normalizeEmail(storedEmail)
        ) {
          localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
        }
      }

      // Check if we have old-style credentials but no accounts list
      const existingAccounts = this.getAll();
      const email = Local.get('email');

      if (email && existingAccounts.length === 0) {
        // Migrate from old system
        this.add(
          email,
          {
            apiKey: Local.get('api_key'),
            aliasAuth: Local.get('alias_auth'),
          },
          // Credentials found in localStorage were kept across restarts, so
          // they stay that way unless the sign-in said otherwise.
          signMe !== '0',
        );

        this.setActive(email);
      }

      return true;
    } catch (error) {
      console.error('Failed to initialize accounts:', error);
      return false;
    }
  },
};

// A reload keeps sessionStorage, so a tab that already holds session-only
// accounts resumes refreshing their leases.
if (hasSessionStorage && hasLocalStorage && typeof window !== 'undefined') {
  try {
    if (readSessionAccountList().length) keepSessionLeasesAlive();
  } catch {
    // Storage blocked; nothing to keep alive.
  }
}
