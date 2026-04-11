import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { warn } from './logger.ts';
import { isOnline } from './network-status';

/**
 * Contact Cache
 *
 * Caches contacts in the IndexedDB `meta` table per-account.
 * Returns cached contacts instantly for offline compose autocomplete,
 * and refreshes from the API in the background when online.
 */

const CONTACT_KEY_PREFIX = 'contacts_';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CONTACTS_PAGE_SIZE = 500;

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

  // API returns emails as array of {value, type} objects;
  // also handle legacy flat email/Email string fields
  let email = '';
  if (Array.isArray(raw.emails) && raw.emails.length > 0) {
    email = (raw.emails[0].value || '').trim();
  } else {
    email = (raw.email || raw.Email || '').trim();
  }

  if (!email) return null;

  // API returns full_name; also handle name/Name/firstName+lastName
  let name = raw.full_name || raw.name || raw.Name || '';
  if (!name && raw.firstName) {
    name = [raw.firstName, raw.lastName].filter(Boolean).join(' ');
  }

  return {
    id: raw.id || raw.Id || email,
    email,
    name,
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
 * Extract a contacts list from the API response.
 */
function getContactsList(response) {
  if (Array.isArray(response)) return response;
  return response?.Result || response?.contacts || [];
}

/**
 * Fetch contacts from the API and update the cache.
 */
async function fetchAndCache(account) {
  const allContacts = [];

  for (let page = 1; page < 10_000; page += 1) {
    const res = await Remote.request('Contacts', {
      page,
      limit: CONTACTS_PAGE_SIZE,
    });
    const list = getContactsList(res);
    allContacts.push(...list);

    if (list.length < CONTACTS_PAGE_SIZE) {
      break;
    }
  }

  const contacts = sortContacts(allContacts.map(normalizeContact).filter(Boolean));
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
      if (isStale && isOnline()) {
        // Background refresh — return stale data immediately
        fetchAndCache(account).catch(() => {});
      }
      return sortContacts(cached.contacts);
    }
  }

  // No cache — must fetch
  if (!isOnline()) return [];

  try {
    return await fetchAndCache(account);
  } catch (err) {
    warn('[contact-cache] Failed to fetch contacts', err);
    return [];
  }
}

/**
 * Remove a single contact from the cache by ID.
 * Call this after deleting a contact.
 *
 * @param {string} contactId - The ID of the contact to remove
 */
export async function removeContactFromCache(contactId) {
  if (!contactId) return;
  const account = getAccount();
  const cached = await readCache(account);
  if (!cached?.contacts?.length) return;
  const updated = cached.contacts.filter((c) => c.id !== contactId);
  if (updated.length !== cached.contacts.length) {
    await writeCache(account, updated).catch(() => {});
  }
}

/**
 * Insert or update a single contact in the cache.
 * Call this after creating or updating a contact.
 *
 * @param {Object} contact - Normalized contact object with at least { id, email, name }
 */
export async function upsertContactInCache(contact) {
  if (!contact?.id) return;
  const normalized = normalizeContact(contact) || contact;
  const account = getAccount();
  const cached = await readCache(account);
  const existing = cached?.contacts || [];
  const idx = existing.findIndex((c) => c.id === normalized.id);
  let updated;
  if (idx >= 0) {
    updated = [...existing];
    updated[idx] = { ...existing[idx], ...normalized };
  } else {
    updated = [...existing, normalized];
  }
  await writeCache(account, sortContacts(updated)).catch(() => {});
}

/**
 * Insert or update multiple contacts in the cache.
 * Call this after bulk import.
 *
 * @param {Array} contacts - Array of normalized contact objects
 */
export async function upsertMultipleContactsInCache(contacts) {
  if (!contacts?.length) return;
  const account = getAccount();
  const cached = await readCache(account);
  const existing = cached?.contacts || [];
  const idMap = new Map(existing.map((c, i) => [c.id, i]));
  const updated = [...existing];
  for (const contact of contacts) {
    const normalized = normalizeContact(contact) || contact;
    if (!normalized?.id) continue;
    const idx = idMap.get(normalized.id);
    if (idx !== undefined) {
      updated[idx] = { ...updated[idx], ...normalized };
    } else {
      updated.push(normalized);
      idMap.set(normalized.id, updated.length - 1);
    }
  }
  await writeCache(account, sortContacts(updated)).catch(() => {});
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
