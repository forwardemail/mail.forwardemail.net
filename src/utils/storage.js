import { db } from './db';
import { warn } from './logger.ts';

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

export const Local = {
  get(key) {
    try {
      if (TAB_SCOPED_KEYS.has(key)) {
        const prefixedKey = `${PREFIX}${key}`;
        const sessionValue = sessionStorage.getItem(prefixedKey);
        if (sessionValue !== null) {
          // Guard: if sessionStorage somehow contains an encrypted blob,
          // treat it as missing so getAuthHeader() can throw properly.
          if (sessionValue.startsWith(ENCRYPTED_PREFIX)) {
            sessionStorage.removeItem(prefixedKey);
            return null;
          }
          return sessionValue;
        }
        // First read in this tab — copy from localStorage to lock in the account
        const localValue = localStorage.getItem(prefixedKey);
        if (localValue !== null) {
          // Do NOT copy encrypted values — they are unusable without the DEK
          // and would produce garbage auth headers (→ 401).
          if (localValue.startsWith(ENCRYPTED_PREFIX)) {
            return null;
          }
          sessionStorage.setItem(prefixedKey, localValue);
        }
        return localValue;
      }
      return localStorage.getItem(`${PREFIX}${key}`);
    } catch (error) {
      console.error('localStorage.getItem failed:', error);
      return null;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(`${PREFIX}${key}`, value);
      if (TAB_SCOPED_KEYS.has(key)) {
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
      localStorage.removeItem(`${PREFIX}${key}`);
      if (TAB_SCOPED_KEYS.has(key)) {
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
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PREFIX)) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
      // Also clear tab-scoped keys from sessionStorage
      TAB_SCOPED_KEYS.forEach((key) => {
        sessionStorage.removeItem(`${PREFIX}${key}`);
      });
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
      return sessionStorage.getItem(`${PREFIX}${key}`);
    } catch (error) {
      console.error('sessionStorage.getItem failed:', error);
      return null;
    }
  },

  set(key, value) {
    try {
      sessionStorage.setItem(`${PREFIX}${key}`, value);
      return true;
    } catch (error) {
      console.error('sessionStorage.setItem failed:', error);
      return false;
    }
  },

  remove(key) {
    try {
      sessionStorage.removeItem(`${PREFIX}${key}`);
      return true;
    } catch (error) {
      console.error('sessionStorage.removeItem failed:', error);
      return false;
    }
  },

  clear() {
    try {
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
export const Accounts = {
  /**
   * Get persistent accounts from localStorage
   */
  getPersistent() {
    try {
      const data = localStorage.getItem(ACCOUNTS_KEY);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get persistent accounts:', error);
      return [];
    }
  },

  /**
   * Get session-only accounts from sessionStorage
   */
  getSession() {
    try {
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
      // Check sessionStorage first (for session accounts), then localStorage
      return sessionStorage.getItem(ACTIVE_ACCOUNT_KEY) || localStorage.getItem(ACTIVE_ACCOUNT_KEY);
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
      localStorage.setItem(ACTIVE_ACCOUNT_KEY, email);
      sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, email);

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
      const storage = staySignedIn ? localStorage : sessionStorage;
      const storageKey = staySignedIn ? ACCOUNTS_KEY : SESSION_ACCOUNTS_KEY;

      // Get accounts from the appropriate storage
      let accounts = [];
      try {
        const data = storage.getItem(storageKey);
        accounts = data ? JSON.parse(data) : [];
      } catch {
        accounts = [];
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

      storage.setItem(storageKey, JSON.stringify(accounts));

      // If moving from session to persistent (or vice versa), remove from the other storage
      const otherStorage = staySignedIn ? sessionStorage : localStorage;
      const otherKey = staySignedIn ? SESSION_ACCOUNTS_KEY : ACCOUNTS_KEY;
      try {
        const otherData = otherStorage.getItem(otherKey);
        if (otherData) {
          const otherAccounts = JSON.parse(otherData).filter((a) => a.email !== email);
          if (otherAccounts.length > 0) {
            otherStorage.setItem(otherKey, JSON.stringify(otherAccounts));
          } else {
            otherStorage.removeItem(otherKey);
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

      // Remove from persistent storage
      const persistent = this.getPersistent();
      const filteredPersistent = persistent.filter((a) => a.email !== email);
      if (filteredPersistent.length !== persistent.length) {
        found = true;
        if (filteredPersistent.length > 0) {
          localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(filteredPersistent));
        } else {
          localStorage.removeItem(ACCOUNTS_KEY);
        }
      }

      // Remove from session storage
      const session = this.getSession();
      const filteredSession = session.filter((a) => a.email !== email);
      if (filteredSession.length !== session.length) {
        found = true;
        if (filteredSession.length > 0) {
          sessionStorage.setItem(SESSION_ACCOUNTS_KEY, JSON.stringify(filteredSession));
        } else {
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
          localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
          sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY);
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
