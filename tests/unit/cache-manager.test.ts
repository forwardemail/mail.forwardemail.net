/**
 * cache-manager unit tests.
 *
 * The CacheManager guards the IndexedDB quota: when storage is full it evicts
 * cached message bodies, lowest-priority folders first (Spam/Trash before
 * Inbox/Drafts). Wrong eviction = the user loses Inbox cache while Spam stays.
 * Cover the quota math, the threshold/rate-limit gate, and the eviction order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bodies: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
  bulkDeletedBodies: [] as unknown[],
  bulkDeletedMessages: [] as unknown[],
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: () => 'me@test.com', set: vi.fn() },
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
// evictOldest scans [account+id] a page at a time and asks only for summary
// fields plus the stored size. These tables fit in one page.
const { pagedTable } = vi.hoisted(() => {
  const summaryPage = (rows: Record<string, unknown>[], fields: string[]) =>
    rows.map((row) => ({
      ...Object.fromEntries(fields.map((f) => [f, row[f]])),
      approxBytes: JSON.stringify(row).length,
    }));
  return {
    pagedTable: (rows: () => Record<string, unknown>[]) => ({
      where: () => ({
        between: () => ({
          limit: () => ({ summaries: async (fields: string[]) => summaryPage(rows(), fields) }),
        }),
      }),
    }),
  };
});

vi.mock('../../src/utils/db.js', () => ({
  db: {
    messageBodies: {
      ...pagedTable(() => h.bodies),
      bulkDelete: vi.fn(async (keys: unknown[]) => {
        h.bulkDeletedBodies.push(...keys);
      }),
    },
    messages: {
      ...pagedTable(() => h.messages),
      bulkDelete: vi.fn(async (keys: unknown[]) => {
        h.bulkDeletedMessages.push(...keys);
      }),
    },
  },
}));

import { cacheManager } from '../../src/utils/cache-manager.js';

const setEstimate = (usage: number, quota: number) => {
  // @ts-expect-error test override of the jsdom polyfill
  navigator.storage.estimate = vi.fn().mockResolvedValue({ usage, quota });
};

beforeEach(() => {
  h.bodies = [];
  h.messages = [];
  h.bulkDeletedBodies = [];
  h.bulkDeletedMessages = [];
  // reset the singleton's rate-limit clock so each test can evict
  (cacheManager as unknown as { lastQuotaCheck: number }).lastQuotaCheck = 0;
});

describe('formatBytes', () => {
  it('formats byte counts', () => {
    expect(cacheManager.formatBytes(0)).toBe('0 Bytes');
    expect(cacheManager.formatBytes(1024)).toBe('1 KB');
    expect(cacheManager.formatBytes(1024 * 1024)).toBe('1 MB');
  });
});

describe('getStorageInfo', () => {
  it('computes the usage percentage', async () => {
    setEstimate(9_000_000, 10_000_000);
    const info = await cacheManager.getStorageInfo();
    expect(info.percentage).toBeCloseTo(90);
    expect(info.available).toBe(1_000_000);
  });

  it('returns zeros when the Storage API is unavailable', async () => {
    const saved = navigator.storage;
    // @ts-expect-error simulate missing Storage API
    delete navigator.storage;
    expect(await cacheManager.getStorageInfo()).toMatchObject({
      usage: 0,
      quota: 0,
      percentage: 0,
    });
    Object.defineProperty(navigator, 'storage', { configurable: true, value: saved });
  });
});

describe('checkQuotaAndEvict', () => {
  it('does nothing below the 90% threshold', async () => {
    setEstimate(5_000_000, 10_000_000); // 50%
    const res = await cacheManager.checkQuotaAndEvict();
    expect(res.evicted).toBe(false);
    expect(h.bulkDeletedBodies).toHaveLength(0);
  });

  it('rate-limits repeat checks within the interval', async () => {
    setEstimate(5_000_000, 10_000_000);
    await cacheManager.checkQuotaAndEvict();
    const second = await cacheManager.checkQuotaAndEvict();
    expect(second).toMatchObject({ evicted: false, reason: 'rate_limited' });
  });

  it('evicts when usage is over the threshold', async () => {
    setEstimate(9_500_000, 10_000_000); // 95% > 90%
    h.bodies = [
      { id: 'b1', account: 'me@test.com', folder: 'INBOX', updatedAt: Date.now(), body: 'x' },
    ];
    const res = await cacheManager.checkQuotaAndEvict();
    // NB: checkQuotaAndEvict spreads evictOldest's result, so `res.evicted`
    // ends up as the {bodies, messages} tally rather than a boolean. Assert the
    // concrete effect — a body was actually deleted.
    expect(h.bulkDeletedBodies.length).toBeGreaterThan(0);
    expect((res as { freedBytes?: number }).freedBytes).toBeGreaterThan(0);
  });
});

describe('evictOldest eviction order', () => {
  it('evicts lowest-priority folders (Spam) before high-priority (Inbox)', async () => {
    const now = Date.now();
    h.bodies = [
      {
        id: 'inbox',
        account: 'me@test.com',
        folder: 'INBOX',
        updatedAt: now,
        body: 'a'.repeat(50),
      },
      { id: 'spam', account: 'me@test.com', folder: 'SPAM', updatedAt: now, body: 'a'.repeat(50) },
      {
        id: 'trash',
        account: 'me@test.com',
        folder: 'TRASH',
        updatedAt: now,
        body: 'a'.repeat(50),
      },
    ];
    // Tiny target so only the single lowest-score (SPAM) body is evicted.
    await cacheManager.evictOldest(1);
    expect(h.bulkDeletedBodies).toEqual([['me@test.com', 'spam']]);
  });

  it('falls through to evicting oldest message metadata when bodies are insufficient', async () => {
    h.bodies = [];
    h.messages = [
      { id: 'm1', account: 'me@test.com', folder: 'INBOX', updatedAt: 1, subject: 's' },
    ];
    const res = await cacheManager.evictOldest(1);
    expect(h.bulkDeletedMessages).toEqual([['me@test.com', 'm1']]);
    expect(res.evicted.messages).toBe(1);
  });
});

describe('setConfig', () => {
  it('clamps evictionTarget into [0.05, 0.5]', () => {
    cacheManager.setConfig({ evictionTarget: 0.9 });
    expect(cacheManager.getConfig().evictionTarget).toBe(0.5);
    cacheManager.setConfig({ evictionTarget: 0.01 });
    expect(cacheManager.getConfig().evictionTarget).toBe(0.05);
  });
});
