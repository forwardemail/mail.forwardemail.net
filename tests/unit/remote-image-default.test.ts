/**
 * Remote images are blocked unless the user turned that off, and a body cached
 * while they were allowed is not shown from the cache with its images in place.
 * A sender the user trusts gets its images, never its tracking pixels.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  sanitizeHtml,
  remoteImagesBlockedByDefault,
  restoreBlockedImages,
  REMOTE_IMAGES_BLOCKED_MARKER,
} from '../../src/utils/sanitize.js';
import { cachedBodyNeedsResanitize } from '../../src/stores/mail-service-helpers';
import {
  isTrustedImageSender,
  readTrustedImageSenders,
  trustImageSender,
  untrustImageSender,
} from '../../src/utils/remote-image-trust';
import { Local } from '../../src/utils/storage.js';

// A live src attribute, not the data-original-src a blocked image keeps
const loads = (html: string, url: string) => html.includes(` src="${url}"`);

const NEWSLETTER =
  '<p>Hello</p><img src="https://cdn.example.com/hero.png" width="600" height="300">' +
  '<img src="https://track.example.com/o.gif" width="1" height="1">';

describe('remote image default', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('blocks remote images when the user never chose', () => {
    expect(remoteImagesBlockedByDefault()).toBe(true);
    const out = sanitizeHtml(NEWSLETTER);
    expect(loads(out.html, 'https://cdn.example.com/hero.png')).toBe(false);
    expect(out.blockedRemoteImageCount).toBe(1);
    expect(out.trackingPixelCount).toBe(1);
    expect(out.html).toContain(REMOTE_IMAGES_BLOCKED_MARKER);
  });

  it('loads them when the user turned blocking off', () => {
    Local.set('block_remote_images', 'false');
    expect(remoteImagesBlockedByDefault()).toBe(false);
    const out = sanitizeHtml(NEWSLETTER);
    expect(loads(out.html, 'https://cdn.example.com/hero.png')).toBe(true);
    expect(out.blockedRemoteImageCount).toBe(0);
  });

  it('keeps blocking when the stored value is "true"', () => {
    Local.set('block_remote_images', 'true');
    expect(remoteImagesBlockedByDefault()).toBe(true);
  });
});

describe('cached bodies and the image policy', () => {
  it('re-sanitizes a body cached with images allowed once blocking is on', () => {
    const allowed = sanitizeHtml(NEWSLETTER, { blockRemoteImages: false });
    const cached = {
      body: allowed.html,
      trackingPixelCount: allowed.trackingPixelCount,
    };
    expect(cachedBodyNeedsResanitize(cached, true)).toBe(true);
    expect(cachedBodyNeedsResanitize(cached, false)).toBe(false);
  });

  it('serves a body cached with blocking on as it is', () => {
    const blocked = sanitizeHtml(NEWSLETTER, { blockRemoteImages: true });
    const cached = { body: blocked.html, trackingPixelCount: blocked.trackingPixelCount };
    expect(cachedBodyNeedsResanitize(cached, true)).toBe(false);
  });

  it('still re-sanitizes a raw body from a background writer', () => {
    expect(cachedBodyNeedsResanitize({ body: NEWSLETTER }, false)).toBe(true);
    expect(cachedBodyNeedsResanitize({ body: '' }, true)).toBe(false);
    expect(cachedBodyNeedsResanitize(null, true)).toBe(false);
  });

  it('restoring a blocked body brings back images but not pixels', () => {
    const blocked = sanitizeHtml(NEWSLETTER, { blockRemoteImages: true });
    const restored = restoreBlockedImages(blocked.html);
    expect(loads(restored, 'https://cdn.example.com/hero.png')).toBe(true);
    expect(loads(restored, 'https://track.example.com/o.gif')).toBe(false);
    expect(restored).not.toContain(REMOTE_IMAGES_BLOCKED_MARKER);
  });
});

describe('trusted image senders', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('trusts by bare, lowercased address', () => {
    trustImageSender('News Team <News@Example.com>', 'me@example.org');
    expect(readTrustedImageSenders('me@example.org')).toEqual(['news@example.com']);
    expect(isTrustedImageSender('news@example.com', 'me@example.org')).toBe(true);
    expect(isTrustedImageSender('"Other" <NEWS@example.com>', 'me@example.org')).toBe(true);
  });

  it('keeps each account to its own list', () => {
    trustImageSender('news@example.com', 'me@example.org');
    expect(isTrustedImageSender('news@example.com', 'you@example.org')).toBe(false);
  });

  it('does not add duplicates or junk, and removes', () => {
    trustImageSender('news@example.com', 'a');
    trustImageSender('NEWS@example.com', 'a');
    trustImageSender('not an address', 'a');
    trustImageSender('', 'a');
    expect(readTrustedImageSenders('a')).toEqual(['news@example.com']);
    expect(untrustImageSender('News@Example.com', 'a')).toEqual([]);
    expect(isTrustedImageSender('news@example.com', 'a')).toBe(false);
  });

  it('survives a corrupted stored list', () => {
    Local.set('remote_images_trusted_a', '{not json');
    expect(readTrustedImageSenders('a')).toEqual([]);
    Local.set('remote_images_trusted_a', '["ok@example.com", 5, null]');
    expect(readTrustedImageSenders('a')).toEqual(['ok@example.com']);
  });
});
