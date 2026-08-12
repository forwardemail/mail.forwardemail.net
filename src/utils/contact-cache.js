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

// v2 stores one autocomplete entry for every CardDAV EMAIL property. Bumping
// the key prevents a fresh legacy one-address cache from masking secondary
// addresses for up to its old TTL after users upgrade.
const CONTACT_KEY_PREFIX = 'contacts_v2_';
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
 * Extract EMAIL values from raw vCard content. This is a compatibility fallback
 * for CardDAV clients that use grouped properties (for example item1.EMAIL),
 * which older server indexes may not expose in the structured emails array.
 */
function getVCardEmails(content) {
  if (typeof content !== 'string' || !content) return [];
  const lines = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (/^[ \t]/.test(rawLine) && lines.length) {
      lines[lines.length - 1] += rawLine.slice(1);
    } else {
      lines.push(rawLine);
    }
  }

  return lines.flatMap((line) => {
    const colonIndex = line.indexOf(':');
    if (colonIndex < 1) return [];
    const key = line.slice(0, colonIndex).split(';')[0].split('.').pop()?.toUpperCase();
    if (key !== 'EMAIL') return [];
    const value = line
      .slice(colonIndex + 1)
      .replace(/^mailto:/i, '')
      .trim();
    return value ? [value] : [];
  });
}

/**
 * Return all unique, non-empty email addresses attached to a contact response.
 * The API exposes CardDAV EMAIL properties as an array, while old caches and
 * a few legacy callers may still use a flat email/Email property.
 */
function getContactEmails(raw) {
  const seen = new Set();
  const emails = [];
  const values = [
    ...(Array.isArray(raw?.emails) ? raw.emails : []),
    ...(Array.isArray(raw?.Emails) ? raw.Emails : []),
    raw?.email,
    raw?.Email,
    ...getVCardEmails(raw && raw.content),
  ];

  for (const value of values) {
    const email = (typeof value === 'object' ? value?.value || '' : value || '').trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }

  return emails;
}

/**
 * Normalize a contact from the API response into one autocomplete entry per
 * address. A CardDAV contact is one person, but each EMAIL property must be
 * individually searchable and selectable when composing a message.
 */
function normalizeContact(raw) {
  if (!raw) return [];

  const emails = getContactEmails(raw);
  if (!emails.length) return [];

  // API returns full_name; also handle name/Name/firstName+lastName
  let name = raw.full_name || raw.name || raw.Name || '';
  if (!name && raw.firstName) {
    name = [raw.firstName, raw.lastName].filter(Boolean).join(' ');
  }

  const contactId = String(raw.id || raw.Id || emails[0]);
  return emails.map((email) => ({
    // Keep cache IDs unique even when multiple entries represent one contact.
    id: `${contactId}:${email.toLowerCase()}`,
    contactId,
    email,
    name,
    avatar: raw.avatar || '',
    company: raw.company || '',
  }));
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

  const contacts = sortContacts(allContacts.flatMap(normalizeContact));
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
  const updated = cached.contacts.filter(
    (contact) => String(contact.contactId || contact.id || '') !== String(contactId),
  );
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
  const normalized = normalizeContact(contact);
  if (!normalized.length) return;
  const account = getAccount();
  const cached = await readCache(account);
  const existing = cached?.contacts || [];
  const contactId = normalized[0].contactId;
  // Remove all old entries for this contact before inserting its current list
  // of addresses. Fall back to id for caches written before contactId existed.
  const updated = [
    ...existing.filter((entry) => String(entry.contactId || entry.id || '') !== contactId),
    ...normalized,
  ];
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
  const entries = contacts.flatMap(normalizeContact);
  if (!entries.length) return;
  const account = getAccount();
  const cached = await readCache(account);
  const existing = cached?.contacts || [];
  const contactIds = new Set(entries.map((entry) => entry.contactId));
  const updated = [
    ...existing.filter((entry) => !contactIds.has(String(entry.contactId || entry.id || ''))),
    ...entries,
  ];
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
