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
 * verdict is cached in localStorage so the penalty is one page per install, and
 * it is keyed by apiBase so pointing at a different (or upgraded) server
 * re-probes instead of inheriting a stale verdict.
 *
 * A false positive is harmless in a way a false negative would not be: it only
 * costs server time, never a blank sender.
 */

import { Local } from './storage.js';
import { config } from '../config.js';

const STORAGE_KEY = 'api_lightweight_addresses';

// Cached in module memory so the hot path (every list request) doesn't hit
// localStorage. `null` = not yet read this session.
let verdict: boolean | null = null;

const currentKey = (): string => String(config.apiBase || '');

/**
 * True while we still believe this server returns address fields on lightweight
 * responses. Optimistic by default: we only give up on proof.
 */
export function lightweightListSupported(): boolean {
  if (verdict !== null) return verdict;
  try {
    const stored = Local.get(STORAGE_KEY);
    // Stored as "<apiBase>". Presence means "this server strips addresses".
    verdict = stored !== currentKey();
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
  try {
    Local.set(STORAGE_KEY, currentKey());
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
}
