import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { warn } from './logger.ts';

/**
 * Contact Cache
 *
 * Caches contacts in the IndexedDB `meta` table per-account.
 * Returns cached contacts instantly for offline compose autocomplete,
 * and refreshes from the API in the background when online.
 */

const CONTACT_KEY_PREFIX = 'contacts_';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getAccount() {
  return Local.get('email') || 'default';
}

function cacheKey(account) {
  return `${CONTACT_KEY_PREFIX}${account}`;
}

/**
 * Read cached contacts for the given account from IndexedDB.
 */
async function readCache(account) {
  try {
    const record = await db.meta.get(cacheKey(account || getAccount()));
    if (!record?.value) return null;
    return {
      contacts: Array.isArray(record.value) ? record.value : [],
      updatedAt: record.updatedAt || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Write contacts to the cache for the given account.
 */
async function writeCache(account, contacts) {
  const key = cacheKey(account || getAccount());
  await db.meta.put({ key, value: contacts, updatedAt: Date.now() });
}

/**
 * Normalize a contact from the API response.
 */
function normalizeContact(raw) {
  if (!raw) return null;
  const email = (raw.email || raw.Email || '').trim();
  if (!email) return null;
  return {
    id: raw.id || raw.Id || email,
    email,
    name:
      raw.name || raw.Name || raw.firstName
        ? [raw.firstName, raw.lastName].filter(Boolean).join(' ')
        : '',
    avatar: raw.avatar || '',
    company: raw.company || '',
  };
}

/**
 * Sort contacts alphabetically by name, falling back to email.
 */
function sortContacts(contacts) {
  return contacts.sort((a, b) => {
    const nameA = (a.name || a.email || '').toLowerCase();
    const nameB = (b.name || b.email || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

/**
 * Fetch contacts from the API and update the cache.
 */
async function fetchAndCache(account) {
  const res = await Remote.request('Contacts', { limit: 500 });
  const list = Array.isArray(res) ? res : res?.Result || res?.contacts || [];
  const contacts = sortContacts((list || []).map(normalizeContact).filter(Boolean));
  await writeCache(account, contacts).catch(() => {});
  return contacts;
}

/**
 * Get contacts for the current account.
 *
 * Returns cached contacts instantly. If stale or missing, fetches from
 * the API in the background (or foreground if no cache exists).
 *
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh] - Skip cache and fetch from API
 * @returns {Promise<Array>} Array of normalized contact objects
 */
export async function getContacts(options = {}) {
  const account = getAccount();
  const { forceRefresh = false } = options;

  if (!forceRefresh) {
    const cached = await readCache(account);
    if (cached) {
      const isStale = Date.now() - cached.updatedAt > CACHE_TTL_MS;
      if (isStale && navigator.onLine) {
        // Background refresh — return stale data immediately
        fetchAndCache(account).catch(() => {});
      }
      return sortContacts(cached.contacts);
    }
  }

  // No cache — must fetch
  if (!navigator.onLine) return [];

  try {
    return await fetchAndCache(account);
  } catch (err) {
    warn('[contact-cache] Failed to fetch contacts', err);
    return [];
  }
}

/**
 * Invalidate the contact cache for the current account.
 * Call this after creating, updating, or deleting contacts
 * to ensure the cache reflects the latest server state.
 */
export async function invalidateCache() {
  const account = getAccount();
  const key = cacheKey(account);
  try {
    await db.meta.delete(key);
  } catch {
    // Ignore errors during cache invalidation
  }
}

/**
 * Merge recently-used addresses into the cache.
 * Called after sending an email to keep autocomplete fresh.
 */
export async function mergeRecentAddresses(addresses) {
  if (!addresses?.length) return;
  const account = getAccount();
  const cached = await readCache(account);
  const existing = cached?.contacts || [];
  const emailSet = new Set(existing.map((c) => c.email.toLowerCase()));
  const newContacts = [];

  for (const addr of addresses) {
    const email = (typeof addr === 'string' ? addr : addr?.email || '').trim();
    if (!email || emailSet.has(email.toLowerCase())) continue;
    emailSet.add(email.toLowerCase());
    newContacts.push({
      id: email,
      email,
      name: typeof addr === 'object' ? addr.name || '' : '',
      avatar: '',
      company: '',
    });
  }

  if (newContacts.length) {
    await writeCache(account, [...existing, ...newContacts]).catch(() => {});
  }
}
