import { db } from './db';
import { warn } from './logger.ts';
import {
  isSensitiveLocalKey,
  isLockEnabled,
  isVaultConfigured,
  isUnlocked,
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
        // Clean up account-specific meta entries (mutation queue, contacts, saved searches)
        db.meta.where('key').startsWith(`mutation_queue_${email}`).delete(),
        db.meta.where('key').startsWith(`contacts_${email}`).delete(),
        db.meta.where('key').startsWith(`saved_search_${email}_`).delete(),
      ]);
    },
  );
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

export const Local = {
  get(key) {
    try {
      if (!hasLocalStorage) return null;
      if (TAB_SCOPED_KEYS.has(key)) {
        const prefixedKey = `${PREFIX}${key}`;
        const sessionValue = hasSessionStorage
          ? sessionStorage.getItem(prefixedKey)
          : null;
        if (sessionValue !== null) {
          // Guard: if sessionStorage somehow contains an encrypted blob,
          // treat it as missing so getAuthHeader() can throw properly.
          if (sessionValue.startsWith(ENCRYPTED_PREFIX)) {
            if (hasSessionStorage) sessionStorage.removeItem(prefixedKey);
            return null;
          }
          return sessionValue;
        }
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
      localStorage.setItem(`${PREFIX}${key}`, protectLocalValue(key, value));
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
      localStorage.removeItem(`${PREFIX}${key}`);
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

/**
 * Reconcile cached account data with local account list.
 * Orphaned account data is scheduled for cleanup.
 */
export async function reconcileOrphanedAccountData() {
  const knownAccounts = new Set(
    Accounts.getAll()
      .map((account) => account?.email)
      .filter(Boolean),
  );
  const activeEmail = Local.get('email');
  if (activeEmail) knownAccounts.add(activeEmail);

  const pending = new Set([...readPendingDeletesLocal(), ...(await readPendingDeletesMeta())]);
  const cachedAccounts = await getCachedAccountIds();
  const orphans = cachedAccounts.filter(
    (account) => account && !knownAccounts.has(account) && !pending.has(account),
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
// The vault is configured+enabled but the DEK is not in memory: encrypted
// values are unreadable, so account-list writes must be refused to avoid
// clobbering the (unreadable) stored list.
const isVaultLocked = () => isLockEnabled() && isVaultConfigured() && !isUnlocked();

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
      const sessionVal = hasSessionStorage
        ? sessionStorage.getItem(ACTIVE_ACCOUNT_KEY)
        : null;
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
      const account = accounts.find((a) => a.email === email);

      if (!account) {
        return false;
      }

      // Store active account in both storages for compatibility
      if (hasLocalStorage) localStorage.setItem(ACTIVE_ACCOUNT_KEY, email);
      if (hasSessionStorage) sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, email);

      // Load account credentials into appropriate storage
      const storage = account.persistent ? Local : Session;
      storage.set('email', account.email);
      if (account.apiKey) storage.set('api_key', account.apiKey);
      else storage.remove('api_key');
      if (account.aliasAuth) storage.set('alias_auth', account.aliasAuth);
      else storage.remove('alias_auth');

      // Also set in Local for API compatibility (Remote.js reads from Local)
      Local.set('email', account.email);
      if (account.aliasAuth) Local.set('alias_auth', account.aliasAuth);

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

      const existingIndex = accounts.findIndex((a) => a.email === email);

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
          const filtered = otherAccounts.filter((a) => a.email !== email);
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

      // Remove from persistent storage (refuse while the vault is locked;
      // getPersistent would read [] and the write would clobber the list)
      if (hasLocalStorage && isVaultLocked() && localStorage.getItem(ACCOUNTS_KEY)) {
        warn('Cannot remove persistent account while the vault is locked');
        return false;
      }
      const persistent = this.getPersistent();
      const filteredPersistent = persistent.filter((a) => a.email !== email);
      if (filteredPersistent.length !== persistent.length) {
        found = true;
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
      const filteredSession = session.filter((a) => a.email !== email);
      if (filteredSession.length !== session.length) {
        found = true;
        if (filteredSession.length > 0 && hasSessionStorage) {
          sessionStorage.setItem(SESSION_ACCOUNTS_KEY, JSON.stringify(filteredSession));
        } else if (hasSessionStorage) {
          sessionStorage.removeItem(SESSION_ACCOUNTS_KEY);
        }
      }

      if (!found) {
        warn('Account not found:', email);
        return false;
      }

      // If this was the active account, switch to another or clear active
      const activeAccount = this.getActive();
      const remaining = this.getAll();

      if (activeAccount === email) {
        if (remaining.length > 0) {
          this.setActive(remaining[0].email);
        } else {
          if (hasLocalStorage) localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
          if (hasSessionStorage) sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY);
          Local.clear();
          Session.clear();
        }
      }

      // Clean up PGP keys and passphrases for this account
      Local.remove(`pgp_keys_${email}`);
      Local.remove(`pgp_passphrases_${email}`);

      // Clear IndexedDB cache for this account if requested
      if (clearCache) {
        const pending = Array.from(new Set([...readPendingDeletesLocal(), email]));
        await persistPendingDeletes(pending);
        await clearAccountCacheData(email);
        const nextPending = pending.filter((item) => item !== email);
        await persistPendingDeletes(nextPending);
      }

      return true;
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
    return accounts.some((a) => a.email === email);
  },

  /**
   * Check if an account is persistent (stay signed in)
   */
  isPersistent(email) {
    const persistent = this.getPersistent();
    return persistent.some((a) => a.email === email);
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

      // Check if we have old-style credentials but no accounts list
      const existingAccounts = this.getAll();
      const email = Local.get('email');
      const staySignedIn = Local.get('signMe') === '1';

      if (email && existingAccounts.length === 0) {
        // Migrate from old system
        this.add(
          email,
          {
            apiKey: Local.get('api_key'),
            aliasAuth: Local.get('alias_auth'),
          },
          staySignedIn,
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
