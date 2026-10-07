/**
 * Forward Email – which signed-in account a server alias id belongs to
 *
 * Push payloads name their account only by `alias_id`. The push registration
 * response is one source of that mapping (see push-notifications.js), but it
 * is missing for an account whose registration has not run on this device
 * yet: notifications were off when it signed in, the token request failed,
 * or the app was updated from a build that did not keep the id. A tap on such
 * an account's notification then opened in whichever account was on screen,
 * where its message id names nothing.
 *
 * Every WebSocket connection learns the same id when it authenticates
 * ({ event: 'connected', aliasId }), and there is one connection per signed-in
 * account. This keeps what they report.
 */

import { Accounts, Local } from './storage';

const STORAGE_KEY = 'alias_accounts';
const MAX_ENTRIES = 50;

function read() {
  try {
    const raw = Local.get(STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

function signedIn(email) {
  const wanted = String(email || '').toLowerCase();
  if (!wanted) return '';
  try {
    const accounts = Accounts.getAll() || [];
    const match = accounts.find((account) => String(account?.email || '').toLowerCase() === wanted);
    if (match?.email) return match.email;
  } catch {
    // fall through to the active account
  }
  const active = Local.get('email');
  return active && String(active).toLowerCase() === wanted ? active : '';
}

/** Record that an account's connection authenticated as an alias id. */
export function rememberAccountAlias(email, aliasId) {
  if (typeof email !== 'string' || !email.includes('@')) return;
  if (typeof aliasId !== 'string' || !aliasId || aliasId.length > 64) return;
  const map = read();
  if (map[aliasId] === email) return;
  // One id per account, and none for accounts signed out since.
  for (const [id, owner] of Object.entries(map)) {
    if (owner === email || !signedIn(owner)) delete map[id];
  }
  map[aliasId] = email;
  const entries = Object.entries(map);
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_ENTRIES)));
  try {
    Local.set(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage full: the push registration map still applies.
  }
}

/**
 * The signed-in account whose connection reported this alias id, or '' when
 * none did or that account has been signed out since.
 */
export function accountForAlias(aliasId) {
  if (typeof aliasId !== 'string' || !aliasId) return '';
  const email = read()[aliasId];
  return typeof email === 'string' ? signedIn(email) : '';
}
