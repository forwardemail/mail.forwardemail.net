import Dexie from 'dexie';
import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { getAuthHeaderForAccount } from './auth';
import { warn } from './logger.ts';
import { isOnline } from './network-status';
import { extractDisplayName, isValidEmail, normalizeEmail, recipientsToList } from './address.ts';
import { normalizeMessageForCache } from './sync-helpers';
import { lightweightListSupported } from './api-capabilities';
import { isDemoMode } from './demo-mode';

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
  // Authenticate every page as the account the cache entry is for. Reading the
  // active credentials per request let a refresh that outlived an account
  // switch file the new account's contacts under the old one.
  const authHeader = getAuthHeaderForAccount(account);
  if (!authHeader) {
    throw new Error('No credentials available for this account');
  }

  const allContacts = [];

  for (let page = 1; page < 10_000; page += 1) {
    const res = await Remote.request(
      'Contacts',
      {
        page,
        limit: CONTACTS_PAGE_SIZE,
      },
      { authHeader },
    );
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

// ---------------------------------------------------------------------------
// Recent recipients
//
// Everyone the account has written to, read from the Sent folder plus the
// addresses of messages sent from this device (an offline or scheduled send is
// not in Sent yet). Kept apart from the contacts cache, which every refresh
// replaces with the server's address book.
// ---------------------------------------------------------------------------

// Not under contacts_: that family is a re-fetchable copy of the server's
// address book, cleared on App Lock changes and skipped by recovery, while
// these are kept only on this device.
const RECENT_KEY_PREFIX = 'recent_recipients_v1_';
const RECENT_MAX_ENTRIES = 1000;
const SENT_SCAN_LIMIT = 1000;
const SENT_PAGE_SIZE = 200;
// How often Sent is fetched from the server for this cache when the mailbox
// has not synced it (the folder was never opened on this device).
const SENT_FETCH_TTL_MS = 6 * 60 * 60 * 1000;
const SENT_MEMO_TTL_MS = 60 * 1000;
const SENT_FIELDS = ['to', 'cc', 'bcc', 'date'];

const sentMemo = new Map();
const sentFetches = new Map();

function recentKey(account) {
  return `${RECENT_KEY_PREFIX}${account}`;
}

// The row holds the recipients sent from this device (value) and when each
// Sent folder was last fetched from the server for this cache (sentFetchedAt).
async function readRecentRecord(account) {
  try {
    const record = await db.meta.get(recentKey(account));
    return {
      value: Array.isArray(record?.value) ? record.value : [],
      sentFetchedAt:
        record?.sentFetchedAt && typeof record.sentFetchedAt === 'object'
          ? record.sentFetchedAt
          : {},
    };
  } catch {
    return { value: [], sentFetchedAt: {} };
  }
}

async function readRecent(account) {
  return (await readRecentRecord(account)).value;
}

async function writeRecentRecord(account, changes) {
  const record = { ...(await readRecentRecord(account)), ...changes };
  await db.meta.put({ key: recentKey(account), ...record, updatedAt: Date.now() });
}

/**
 * Parse a stored address field ("Name <a@x>, b@y", an address object or a
 * list of them) into `{ email, name }` pairs with valid, lowercased addresses.
 */
export function parseRecipients(value) {
  const out = [];
  for (const item of recipientsToList(value)) {
    const email = normalizeEmail(item);
    if (!isValidEmail(email)) continue;
    const display = extractDisplayName(item).trim();
    const name = display && normalizeEmail(display) !== email ? display : '';
    out.push({ email, name });
  }
  return out;
}

function tally(map, addresses, at) {
  for (const { email, name } of addresses) {
    const entry = map.get(email) || { email, name: '', count: 0, lastUsed: 0 };
    entry.count += 1;
    if (at >= entry.lastUsed) {
      entry.lastUsed = at;
      if (name) entry.name = name;
    } else if (!entry.name && name) {
      entry.name = name;
    }
    map.set(email, entry);
  }
}

// One count per message, however often an address appears in it.
function uniqueByEmail(addresses) {
  const seen = new Set();
  return addresses.filter(({ email }) => !seen.has(email) && seen.add(email));
}

function tallyMessages(messages) {
  const map = new Map();
  for (const msg of messages || []) {
    const at = Number(msg?.date) || Date.parse(msg?.date) || 0;
    const addresses = [
      ...parseRecipients(msg?.to),
      ...parseRecipients(msg?.cc),
      ...parseRecipients(msg?.bcc),
    ];
    tally(map, uniqueByEmail(addresses), at);
  }
  return map;
}

function readCachedSent(account, sentFolder, fields = SENT_FIELDS) {
  return db.messages
    .where('[account+folder+date]')
    .between([account, sentFolder, Dexie.minKey], [account, sentFolder, Dexie.maxKey], true, true)
    .reverse()
    .limit(SENT_SCAN_LIMIT)
    .pickFields(fields)
    .catch(() => []);
}

// One page of the newest Sent messages from the server. Lightweight only when
// this server keeps address fields on lightweight lists: these rows are
// cached and must carry recipients.
async function fetchSentPage(account, sentFolder, page) {
  // With no stored header the active account's credentials are used (and demo
  // mode answers), so that is only allowed for the active account.
  const authHeader = getAuthHeaderForAccount(account);
  if (!authHeader && account !== getAccount()) {
    throw new Error('No credentials available for this account');
  }
  const res = await Remote.request(
    'MessageList',
    {
      folder: sentFolder,
      page,
      limit: SENT_PAGE_SIZE,
      ...(lightweightListSupported() ? { lightweight: true } : {}),
    },
    { method: 'GET', pathOverride: '/v1/messages', ...(authHeader ? { authHeader } : {}) },
  );
  const list = Array.isArray(res)
    ? res
    : res?.data || res?.messages || res?.Result?.List || res?.Result || [];
  return Array.isArray(list) ? list : [];
}

// After a failed fetch, try again in this long rather than on every folder load.
const SENT_RETRY_MS = 15 * 60 * 1000;
// A forced fetch (compose found nothing cached) still waits this long between tries.
const SENT_FORCE_MIN_MS = 60 * 1000;

/**
 * Fetch the account's Sent folder from the server into the local message
 * cache, so recipients are suggested even when Sent was never opened on this
 * device. At most once per SENT_FETCH_TTL_MS per folder. Pages are fetched
 * newest first and stop at one that brings nothing new. A message already
 * cached in any folder (the mailbox sync owns it: it may have just been moved
 * or be waiting on the server) is left as it is, as are ids in skipIds
 * (deletes still on their way to the server).
 *
 * @param {Object} [options]
 * @param {string|null} [options.sentFolder]
 * @param {boolean} [options.force] - fetch even if fetched recently
 * @param {string} [options.account] - defaults to the active account
 * @param {Array<string>} [options.skipIds]
 * @returns {Promise<number>} how many messages were added
 */
export function cacheSentRecipients({
  sentFolder = null,
  force = false,
  account = null,
  skipIds = [],
} = {}) {
  if (!sentFolder || !isOnline() || isDemoMode()) return Promise.resolve(0);
  // A load started for one account keeps its credentials across a switch.
  account = account || getAccount();
  const key = `${account}\n${sentFolder}`;
  if (sentFetches.has(key)) return sentFetches.get(key);
  let added = 0;
  const markFetched = async (at) => {
    const { sentFetchedAt } = await readRecentRecord(account);
    await writeRecentRecord(account, { sentFetchedAt: { ...sentFetchedAt, [sentFolder]: at } });
  };
  const run = (async () => {
    const { sentFetchedAt } = await readRecentRecord(account);
    const age = Date.now() - (Number(sentFetchedAt[sentFolder]) || 0);
    if (age < (force ? SENT_FORCE_MIN_MS : SENT_FETCH_TTL_MS)) return 0;
    const skip = new Set(skipIds.map(String));
    for (let page = 1; page * SENT_PAGE_SIZE <= SENT_SCAN_LIMIT; page += 1) {
      const items = await fetchSentPage(account, sentFolder, page);
      const rows = items
        .map((item) => normalizeMessageForCache(item, sentFolder, account))
        .filter((msg) => msg?.id && !skip.has(String(msg.id)));
      const existing = rows.length
        ? await db.messages.bulkGet(rows.map((msg) => [account, msg.id]))
        : [];
      const fresh = rows.filter((_, i) => !existing[i]);
      if (fresh.length) {
        await db.messages.bulkPut(fresh);
        added += fresh.length;
      }
      if (items.length < SENT_PAGE_SIZE || !fresh.length) break;
    }
    await markFetched(Date.now());
    return added;
  })()
    .catch(async (err) => {
      warn('[contact-cache] Failed to cache sent messages for autocomplete', err);
      // Pages already written stay. Try again later, not on every folder load.
      await markFetched(Date.now() - SENT_FETCH_TTL_MS + SENT_RETRY_MS).catch(() => {});
      return added;
    })
    .then((count) => {
      if (count) sentMemo.delete(key);
      return count;
    })
    .finally(() => sentFetches.delete(key));
  sentFetches.set(key, run);
  return run;
}

async function readSentMessages(account, sentFolder) {
  let rows = await readCachedSent(account, sentFolder);
  if (rows?.length || !isOnline()) return rows || [];

  // Nothing cached yet: fetch Sent now and read it back.
  if (isDemoMode()) {
    // Demo messages are never written to the cache.
    const items = await fetchSentPage(account, sentFolder, 1).catch(() => []);
    return items.map((item) => normalizeMessageForCache(item, sentFolder, account));
  }
  if (await cacheSentRecipients({ sentFolder, force: true })) {
    rows = await readCachedSent(account, sentFolder);
  }
  return rows || [];
}

/**
 * Everyone the current account has sent mail to, most used first.
 *
 * @param {Object} [options]
 * @param {string|null} [options.sentFolder] - path of the Sent folder
 * @returns {Promise<Array<{email: string, name: string, count: number, lastUsed: number}>>}
 */
export async function getRecentRecipients({ sentFolder = null } = {}) {
  const account = getAccount();
  const map = new Map();

  if (sentFolder) {
    const memoKey = `${account}\n${sentFolder}`;
    let memo = sentMemo.get(memoKey);
    if (!memo || Date.now() - memo.at > SENT_MEMO_TTL_MS) {
      memo = { at: Date.now(), promise: readSentMessages(account, sentFolder).then(tallyMessages) };
      sentMemo.set(memoKey, memo);
    }
    for (const entry of (await memo.promise).values()) map.set(entry.email, { ...entry });
  }

  // A message sent here also lands in Sent, so take the larger of the two
  // counts rather than adding them.
  for (const stored of await readRecent(account)) {
    const email = normalizeEmail(stored?.email);
    if (!isValidEmail(email)) continue;
    const entry = map.get(email);
    if (!entry) {
      map.set(email, {
        email,
        name: stored.name || '',
        count: stored.count || 1,
        lastUsed: stored.lastUsed || 0,
      });
      continue;
    }
    entry.count = Math.max(entry.count, stored.count || 1);
    if ((stored.lastUsed || 0) > entry.lastUsed) {
      entry.lastUsed = stored.lastUsed;
      if (stored.name) entry.name = stored.name;
    }
    if (!entry.name && stored.name) entry.name = stored.name;
  }

  return [...map.values()].sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
}

/**
 * Record the recipients of a message sent from this device so they are
 * suggested right away, before the Sent folder syncs and while offline.
 */
export async function mergeRecentAddresses(addresses) {
  const parsed = uniqueByEmail(
    (addresses || []).flatMap((addr) =>
      parseRecipients(
        typeof addr === 'string' ? addr : addr?.name ? `${addr.name} <${addr.email}>` : addr?.email,
      ),
    ),
  );
  if (!parsed.length) return;
  const account = getAccount();
  const map = new Map((await readRecent(account)).map((entry) => [entry.email, entry]));
  tally(map, parsed, Date.now());
  const entries = [...map.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, RECENT_MAX_ENTRIES);
  await writeRecentRecord(account, { value: entries });
  sentMemo.clear();
}

/**
 * One autocomplete list from the address book and the people mail was sent
 * to. A saved contact keeps its name and company; usage comes from Sent.
 */
export function mergeRecipientSources(contacts = [], recents = []) {
  const map = new Map();
  for (const contact of contacts) {
    const email = normalizeEmail(contact?.email);
    if (!email || map.has(email)) continue;
    map.set(email, {
      email: String(contact.email).trim(),
      name: contact.name || '',
      company: contact.company || '',
      count: 0,
      lastUsed: 0,
      isContact: true,
    });
  }
  for (const recent of recents) {
    const email = normalizeEmail(recent?.email);
    if (!email) continue;
    const entry = map.get(email);
    if (entry) {
      entry.count = recent.count || 0;
      entry.lastUsed = recent.lastUsed || 0;
      if (!entry.name) entry.name = recent.name || '';
    } else {
      map.set(email, {
        email,
        name: recent.name || '',
        company: '',
        count: recent.count || 0,
        lastUsed: recent.lastUsed || 0,
        isContact: false,
      });
    }
  }
  return [...map.values()];
}

/**
 * Suggestions for what has been typed so far. Every word must match the name,
 * address or company. Matches at the start of a word come first, then the
 * people written to most, then the most recent, then saved contacts.
 *
 * @param {Array} entries - from mergeRecipientSources
 * @param {string} query
 * @param {Object} [options]
 * @param {string[]} [options.exclude] - addresses already added
 * @param {number} [options.limit]
 */
export function searchRecipients(entries, query, { exclude = [], limit = 8 } = {}) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const terms = q.split(/[\s,;<>"]+/).filter(Boolean);
  if (!terms.length) return [];
  const excluded = new Set(exclude.map((value) => normalizeEmail(value)).filter(Boolean));
  const matches = [];

  for (const entry of entries || []) {
    const email = String(entry?.email || '').toLowerCase();
    if (!email || excluded.has(email)) continue;
    const name = String(entry.name || '').toLowerCase();
    const company = String(entry.company || '').toLowerCase();
    const haystack = `${name} ${email} ${company}`;
    if (!terms.every((term) => haystack.includes(term))) continue;
    const words = `${name} ${company} ${email.replace(/[@._+-]/g, ' ')}`.split(/\s+/);
    const startsWord =
      email.startsWith(q) || name.startsWith(q) || words.some((w) => w.startsWith(terms[0]));
    matches.push({ entry, rank: startsWord ? 0 : 1 });
  }

  return matches
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.entry.count || 0) - (a.entry.count || 0) ||
        (b.entry.lastUsed || 0) - (a.entry.lastUsed || 0) ||
        Number(Boolean(b.entry.isContact)) - Number(Boolean(a.entry.isContact)) ||
        (a.entry.name || a.entry.email).localeCompare(b.entry.name || b.entry.email),
    )
    .slice(0, limit)
    .map((match) => match.entry);
}
