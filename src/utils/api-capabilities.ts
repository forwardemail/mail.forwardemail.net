/**
 * Runtime capability detection for the message API.
 *
 * `?lightweight=true` tells the server to skip the MIME rebuild and attachment
 * fetch for list responses, a large win since that work is per-message. Older
 * API builds implement it by omitting the parsed `nodemailer` object *and*
 * nothing else, so the response carries no From/To/Cc at all and every row in
 * the list renders with an empty sender. Newer builds surface those headers from
 * the stored header array, which costs no extra I/O.
 *
 * Rather than pin the client to one server version, ask for lightweight and
 * watch what comes back: a non-empty page where NOT ONE message yields a sender
 * proves this server strips addresses, so stop asking for lightweight. The
 * verdict is cached in localStorage so the penalty is one page now and then
 * rather than one per list request. It records the apiBase, when it was made
 * and the app version, and only holds for the same server, the same app build
 * and VERDICT_TTL_MS. A server fixed at the same URL is probed again within a
 * week, and so is every server after an app update.
 *
 * A false positive is harmless in a way a false negative would not be: it only
 * costs server time, never a blank sender.
 */

import { Local } from './storage.js';
import { config } from '../config.js';

const STORAGE_KEY = 'api_lightweight_addresses';

// How long a "this server strips addresses" verdict is trusted before the
// next list request probes lightweight again.
export const VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredVerdict {
  apiBase: string;
  at: number;
  appVersion: string;
}

// Cached in module memory so the hot path (every list request) doesn't hit
// localStorage. `null` = not yet read this session.
let verdict: boolean | null = null;
// When the in-memory verdict has to be read again, so a session left open past
// the TTL also probes again.
let verdictExpiresAt = Infinity;

const currentKey = (): string => String(config.apiBase || '');

const currentAppVersion = (): string =>
  String(import.meta.env.VITE_PKG_VERSION || import.meta.env.VITE_APP_VERSION || '');

// Older builds stored the bare apiBase string with no date or version. That
// shape fails to parse here and is treated as stale, so it gets re-probed.
function readStoredVerdict(): StoredVerdict | null {
  const raw = Local.get(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.apiBase !== 'string' || typeof parsed.at !== 'number') return null;
    return { apiBase: parsed.apiBase, at: parsed.at, appVersion: String(parsed.appVersion ?? '') };
  } catch {
    return null;
  }
}

function verdictStillHolds(stored: StoredVerdict | null): boolean {
  if (!stored) return false;
  if (stored.apiBase !== currentKey()) return false;
  if (stored.appVersion !== currentAppVersion()) return false;
  const age = Date.now() - stored.at;
  return age >= 0 && age < VERDICT_TTL_MS;
}

/**
 * True while we still believe this server returns address fields on lightweight
 * responses. Optimistic by default: we only give up on proof.
 */
export function lightweightListSupported(): boolean {
  if (verdict !== null && Date.now() < verdictExpiresAt) return verdict;
  verdict = true;
  verdictExpiresAt = Infinity;
  try {
    // A stored verdict that still holds means "this server strips addresses".
    const stored = readStoredVerdict();
    if (stored && verdictStillHolds(stored)) {
      verdict = false;
      verdictExpiresAt = stored.at + VERDICT_TTL_MS;
    }
  } catch {
    verdict = true;
  }
  return verdict;
}

/**
 * Record what a lightweight list response actually contained. Pass the messages
 * after normalization, so `from` is the display string the UI would render.
 *
 * Returns true when this call flipped the verdict, letting the caller react
 * (e.g. re-fetch the page now that it knows to ask for the full shape).
 */
export function noteLightweightListResponse(
  messages: Array<{ from?: unknown }> | null | undefined,
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (verdict === false) return false;

  const anySender = messages.some(
    (msg) => typeof msg?.from === 'string' && (msg.from as string).trim().length > 0,
  );
  if (anySender) return false;

  verdict = false;
  verdictExpiresAt = Date.now() + VERDICT_TTL_MS;
  try {
    const stored: StoredVerdict = {
      apiBase: currentKey(),
      at: Date.now(),
      appVersion: currentAppVersion(),
    };
    Local.set(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Memory-only verdict still holds for this session.
  }
  console.warn(
    '[api-capabilities] lightweight list responses carry no sender on this server, ' +
      'requesting full message shape from now on',
  );
  return true;
}

/** Test seam: drop the cached verdict so the next call re-reads storage. */
export function resetLightweightSupportForTests(): void {
  verdict = null;
  verdictExpiresAt = Infinity;
}
