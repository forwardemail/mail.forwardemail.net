import { db } from './db.js';
import { Local } from './storage.js';
import { warn } from './logger.ts';

// Folder priority for eviction (lower = evict first)
const FOLDER_PRIORITY = {
  SPAM: 5,
  JUNK: 5,
  '[Gmail]/Spam': 5,
  TRASH: 10,
  '[Gmail]/Trash': 10,
  ARCHIVE: 50,
  '[Gmail]/All Mail': 50,
  SENT: 80,
  '[Gmail]/Sent Mail': 80,
  DRAFTS: 90,
  '[Gmail]/Drafts': 90,
  INBOX: 100,
};

function getFolderPriority(folder) {
  if (!folder) return 30;
  const upper = folder.toUpperCase();
  return FOLDER_PRIORITY[folder] ?? FOLDER_PRIORITY[upper] ?? 30;
}

// Rows read per eviction scan request, and how many rows one eviction pass
// may delete from each table.
const EVICTION_PAGE_SIZE = 200;
const MAX_BODY_EVICTIONS = 50;
const MAX_MESSAGE_EVICTIONS = 100;

function calculateEvictionScore(body) {
  const priority = getFolderPriority(body.folder);
  const ageMs = Date.now() - (body.updatedAt || 0);
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageScore = Math.max(0, 50 - Math.min(ageHours, 50));
  return priority + ageScore; // Range: 5-150
}

/**
 * CacheManager - Handles IndexedDB quota monitoring, eviction, and statistics
 */
export class CacheManager {
  constructor() {
    this.quotaThreshold = 0.9; // Trigger eviction at 90% usage
    this.evictionTarget = 0.1; // Free 10% of quota when evicting
    this.lastQuotaCheck = 0;
    this.quotaCheckInterval = 60000; // Check every minute
  }

  /**
   * Get current storage usage and quota
   */
  async getStorageInfo() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) {
        return { usage: 0, quota: 0, percentage: 0, available: 0 };
      }

      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;
      const percentage = quota > 0 ? (usage / quota) * 100 : 0;
      const available = quota - usage;

      return {
        usage,
        quota,
        percentage,
        available,
        usageFormatted: this.formatBytes(usage),
        quotaFormatted: this.formatBytes(quota),
        availableFormatted: this.formatBytes(available),
      };
    } catch (error) {
      console.error('[CacheManager] Failed to get storage info:', error);
      return { usage: 0, quota: 0, percentage: 0, available: 0 };
    }
  }

  /**
   * Get detailed cache statistics per table
   */
  async getCacheStatistics() {
    const account = Local.get('email') || 'default';

    try {
      const [foldersCount, messagesCount, bodiesCount, draftsCount, searchIndexCount, outboxCount] =
        await Promise.all([
          db.folders.where('account').equals(account).count(),
          db.messages.where('account').equals(account).count(),
          db.messageBodies.where('account').equals(account).count(),
          db.drafts.where('account').equals(account).count(),
          db.searchIndex.where('account').equals(account).count(),
          db.outbox.where('account').equals(account).count(),
        ]);

      // Estimate sizes (sample-based for performance)
      const messageSamples = await db.messages.where('account').equals(account).limit(50).toArray();
      const bodySamples = await db.messageBodies
        .where('account')
        .equals(account)
        .limit(20)
        .toArray();

      const avgMessageSize =
        messageSamples.length > 0
          ? messageSamples.reduce((sum, m) => sum + JSON.stringify(m).length, 0) /
            messageSamples.length
          : 200;

      const avgBodySize =
        bodySamples.length > 0
          ? bodySamples.reduce((sum, b) => sum + JSON.stringify(b).length, 0) / bodySamples.length
          : 30000;

      const estimatedMessagesSize = messagesCount * avgMessageSize;
      const estimatedBodiesSize = bodiesCount * avgBodySize;
      const estimatedTotalSize = estimatedMessagesSize + estimatedBodiesSize;

      return {
        account,
        counts: {
          folders: foldersCount,
          messages: messagesCount,
          bodies: bodiesCount,
          drafts: draftsCount,
          searchIndex: searchIndexCount,
          outbox: outboxCount,
        },
        sizes: {
          messages: estimatedMessagesSize,
          bodies: estimatedBodiesSize,
          total: estimatedTotalSize,
          messagesFormatted: this.formatBytes(estimatedMessagesSize),
          bodiesFormatted: this.formatBytes(estimatedBodiesSize),
          totalFormatted: this.formatBytes(estimatedTotalSize),
        },
        averages: {
          messageSize: Math.round(avgMessageSize),
          bodySize: Math.round(avgBodySize),
          messageSizeFormatted: this.formatBytes(avgMessageSize),
          bodySizeFormatted: this.formatBytes(avgBodySize),
        },
      };
    } catch (error) {
      console.error('[CacheManager] Failed to get cache statistics:', error);
      return null;
    }
  }

  /**
   * Check quota and trigger eviction if needed
   */
  async checkQuotaAndEvict() {
    const now = Date.now();
    // Rate limit quota checks
    if (now - this.lastQuotaCheck < this.quotaCheckInterval) {
      return { evicted: false, reason: 'rate_limited' };
    }
    this.lastQuotaCheck = now;

    const info = await this.getStorageInfo();
    const usagePercent = info.percentage / 100;

    if (usagePercent < this.quotaThreshold) {
      return { evicted: false, usage: info.percentage, threshold: this.quotaThreshold * 100 };
    }

    warn(`[CacheManager] Quota usage at ${info.percentage.toFixed(1)}%, triggering eviction`);

    const targetBytes = info.quota * this.evictionTarget;
    const result = await this.evictOldest(targetBytes);

    return {
      evicted: true,
      usage: info.percentage,
      threshold: this.quotaThreshold * 100,
      ...result,
    };
  }

  /**
   * Evict cached data using priority-based scoring to free up space.
   * Lower priority folders (SPAM, TRASH) are evicted before higher priority ones (INBOX, DRAFTS).
   *
   * The cache can be many gigabytes, so it is scanned a page at a time along
   * the [account+id] index, keeping only the best few eviction candidates in
   * memory. Only plaintext summary fields and stored sizes are read; bodies
   * are never decrypted or loaded as a whole.
   */
  async evictOldest(targetBytes) {
    const account = Local.get('email') || 'default';
    let freedBytes = 0;
    const evicted = { bodies: 0, messages: 0 };

    try {
      // Strategy 1: the lowest-scored bodies (low-priority folders, oldest first)
      const bodyCandidates = await this.collectLowest(
        'messageBodies',
        account,
        ['id', 'folder', 'updatedAt'],
        MAX_BODY_EVICTIONS,
        (row) => calculateEvictionScore(row),
      );

      const bodiesToDelete = [];
      for (const body of bodyCandidates) {
        if (freedBytes >= targetBytes) break;
        bodiesToDelete.push([account, body.id]);
        freedBytes += body.approxBytes || 0;
        evicted.bodies++;
      }

      if (bodiesToDelete.length > 0) {
        await db.messageBodies.bulkDelete(bodiesToDelete);
      }

      // Strategy 2: If still need more space, remove oldest message metadata
      if (freedBytes < targetBytes) {
        const oldMessages = await this.collectLowest(
          'messages',
          account,
          ['id', 'updatedAt'],
          MAX_MESSAGE_EVICTIONS,
          (row) => row.updatedAt || 0,
        );

        const messagesToDelete = [];
        for (const msg of oldMessages) {
          if (freedBytes >= targetBytes) break;
          messagesToDelete.push([account, msg.id]);
          freedBytes += msg.approxBytes || 0;
          evicted.messages++;
        }

        if (messagesToDelete.length > 0) {
          await db.messages.bulkDelete(messagesToDelete);
        }
      }

      return {
        freedBytes,
        freedBytesFormatted: this.formatBytes(freedBytes),
        evicted,
      };
    } catch (error) {
      console.error('[CacheManager] Eviction failed:', error);
      return { freedBytes: 0, evicted, error: error.message };
    }
  }

  /**
   * Walk one account's rows of `table` in pages (keyset paging on
   * [account+id]) and return the `limit` rows with the lowest `score`,
   * lowest first. Memory stays at one page plus `limit` summaries.
   */
  async collectLowest(table, account, fields, limit, score) {
    const best = [];
    let lastId = null;
    for (;;) {
      // Number ids sort before strings in IndexedDB, -Infinity before both;
      // an empty array sorts after every string, closing the account range.
      const lower = lastId === null ? [account, -Infinity] : [account, lastId];
      const page = await db[table]
        .where('[account+id]')
        .between(lower, [account, []], lastId === null, false)
        .limit(EVICTION_PAGE_SIZE)
        .summaries(fields);
      if (!Array.isArray(page) || !page.length) break;
      for (const row of page) {
        best.push({ ...row, score: score(row) });
      }
      best.sort((a, b) => a.score - b.score);
      if (best.length > limit) best.length = limit;
      if (page.length < EVICTION_PAGE_SIZE) break;
      lastId = page[page.length - 1].id;
    }
    return best;
  }

  /**
   * Clear all cache data
   */
  async clearAllCache() {
    try {
      await Promise.all([
        db.folders.clear(),
        db.messages.clear(),
        db.messageBodies.clear(),
        db.searchIndex.clear(),
        db.indexMeta.clear(),
        db.drafts.clear(),
        db.outbox.clear(),
        // Note: meta table intentionally kept (contains settings)
      ]);

      return { success: true };
    } catch (error) {
      console.error('[CacheManager] Failed to clear cache:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear cache for specific account
   */
  async clearAccountCache(accountEmail) {
    try {
      await db.transaction(
        'rw',
        [
          db.folders,
          db.messages,
          db.messageBodies,
          db.searchIndex,
          db.indexMeta,
          db.drafts,
          db.outbox,
        ],
        async () => {
          await Promise.all([
            db.folders.where('account').equals(accountEmail).delete(),
            db.messages.where('account').equals(accountEmail).delete(),
            db.messageBodies.where('account').equals(accountEmail).delete(),
            db.searchIndex.where('account').equals(accountEmail).delete(),
            db.indexMeta.where('account').equals(accountEmail).delete(),
            db.drafts.where('account').equals(accountEmail).delete(),
            db.outbox.where('account').equals(accountEmail).delete(),
          ]);
        },
      );

      return { success: true };
    } catch (error) {
      console.error(`[CacheManager] Failed to clear cache for account ${accountEmail}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get cache configuration
   */
  getConfig() {
    return {
      quotaThreshold: this.quotaThreshold,
      evictionTarget: this.evictionTarget,
      quotaCheckInterval: this.quotaCheckInterval,
      bodyTTL: 24 * 60 * 60 * 1000, // 24 hours
    };
  }

  /**
   * Update cache configuration
   */
  setConfig(config) {
    if (config.quotaThreshold !== undefined) {
      this.quotaThreshold = Math.max(0.5, Math.min(0.99, config.quotaThreshold));
    }
    if (config.evictionTarget !== undefined) {
      this.evictionTarget = Math.max(0.05, Math.min(0.5, config.evictionTarget));
    }
    if (config.quotaCheckInterval !== undefined) {
      this.quotaCheckInterval = Math.max(10000, config.quotaCheckInterval);
    }

    // Persist config
    Local.set('cache_config', JSON.stringify(this.getConfig()));
  }

  /**
   * Load config from localStorage
   */
  loadConfig() {
    try {
      const stored = Local.get('cache_config');
      if (stored) {
        const config = JSON.parse(stored);
        this.setConfig(config);
      }
    } catch (error) {
      console.error('[CacheManager] Failed to load config:', error);
    }
  }

  /**
   * Format bytes to human-readable string
   */
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
}

// Singleton instance
export const cacheManager = new CacheManager();
cacheManager.loadConfig();
