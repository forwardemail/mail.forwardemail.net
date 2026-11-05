/**
 * The reader caches a body as sanitized, so a body read while remote images
 * were blocked is cached with them blocked. Once the user turns blocking off,
 * that cached copy must show its images, report none blocked, and lose the
 * marker that puts the image CSP on the email frame.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cachedBody: null as Record<string, unknown> | null,
  local: {} as Record<string, string>,
}));

vi.mock('../../src/utils/db.js', () => ({
  db: {
    messageBodies: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({ first: vi.fn(async () => mocks.cachedBody) })),
      })),
      put: vi.fn(),
    },
  },
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: vi.fn((key: string) => mocks.local[key] ?? null),
    set: vi.fn(),
  },
}));

vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn(),
  refreshSyncWorkerPgpKeys: vi.fn(),
  requestPgpDecryption: vi.fn(),
  unlockPgpKey: vi.fn(),
  requestParsing: vi.fn(),
}));

vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: vi.fn(() => ({ stage: vi.fn(), end: vi.fn() })),
}));

vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

import { mailService } from '../../src/stores/mailService';
import { REMOTE_IMAGES_BLOCKED_MARKER, sanitizeHtml } from '../../src/utils/sanitize.js';

const HERO = 'https://cdn.example.test/hero.png';
const PIXEL = 'https://track.example.test/o.gif';

// Cached as the reader caches it while blocking is on
function cacheBlockedBody() {
  const blocked = sanitizeHtml(
    `<p>Hi</p><img src="${HERO}" width="600" height="300"><img src="${PIXEL}" width="1" height="1">`,
    { blockRemoteImages: true, blockTrackingPixels: true },
  );
  mocks.cachedBody = {
    id: 'm1',
    account: 'reader@example.com',
    body: blocked.html,
    trackingPixelCount: blocked.trackingPixelCount,
    blockedRemoteImageCount: blocked.blockedRemoteImageCount,
    attachments: [],
    meta: { nodemailer: { headers: {} } },
  };
}

async function read() {
  let body = '';
  let status: Record<string, unknown> | null = null;
  await mailService.loadMessageDetail(
    { id: 'm1', folder: 'INBOX', from: 'News <news@example.test>', flags: [] } as never,
    {
      onBody: (html: string) => (body = html),
      onImageStatus: (s: unknown) => (status = s as Record<string, unknown>),
    },
  );
  return { body, status };
}

describe('a cached body and the remote image setting', () => {
  beforeEach(() => {
    mocks.local = { email: 'reader@example.com' };
    cacheBlockedBody();
  });

  it('shows the images of a body cached while blocking was on, once it is off', async () => {
    mocks.local.block_remote_images = 'false';
    const { body, status } = await read();
    expect(body).toContain(` src="${HERO}"`);
    expect(body).not.toContain(REMOTE_IMAGES_BLOCKED_MARKER);
    // Tracking pixels stay blocked: that is a setting of its own
    expect(body).not.toContain(` src="${PIXEL}"`);
    expect(status).toMatchObject({
      hasBlockedImages: true,
      blockedRemoteImageCount: 0,
      trackingPixelCount: 1,
    });
  });

  it('keeps them blocked while blocking is on', async () => {
    const { body, status } = await read();
    expect(body).not.toContain(` src="${HERO}"`);
    expect(body).toContain(REMOTE_IMAGES_BLOCKED_MARKER);
    expect(status).toMatchObject({ blockedRemoteImageCount: 1, trackingPixelCount: 1 });
  });
});
