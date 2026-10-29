/**
 * Remove click-tracking parameters from a link before it is opened.
 *
 * Only parameters whose sole job is attribution are removed (utm_*, the ad
 * click ids, the mailing-list click ids). Anything else in the query is left
 * as it is: a parameter that looks like tracking can be what a page needs to
 * work, and a link that breaks is worse than one that tracks.
 *
 * Off unless the user turns on `strip_link_tracking`, so links open exactly
 * as written by default.
 */
import { Local } from './storage.js';

const EXACT = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
]);

const isTrackingParam = (name: string) => {
  const key = name.toLowerCase();
  return key.startsWith('utm_') || EXACT.has(key);
};

export interface StrippedLink {
  url: string;
  removed: string[];
}

/** The link without its tracking parameters. Non-http(s) links come back unchanged. */
export function stripTrackingParams(href: string): StrippedLink {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { url: href, removed: [] };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { url: href, removed: [] };

  const removed = [...new Set([...url.searchParams.keys()].filter(isTrackingParam))];
  if (!removed.length) return { url: href, removed };
  for (const name of removed) url.searchParams.delete(name);
  return { url: url.toString(), removed };
}

export function linkTrackingStripEnabled(): boolean {
  return Local.get('strip_link_tracking') === 'true';
}

/** The link to open: stripped when the user turned that on, else as written. */
export function linkToOpen(href: string): string {
  return linkTrackingStripEnabled() ? stripTrackingParams(href).url : href;
}
