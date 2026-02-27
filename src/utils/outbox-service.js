import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { writable } from 'svelte/store';
import { saveSentCopy } from './sent-copy.js';
import { warn } from './logger.ts';
import { isDemoMode, showDemoBlockedToast } from './demo-mode';

/**
 * Outbox Service
 *
 * Manages offline email sending with automatic retry and exponential backoff.
 *
 * Status flow: pending -> sending -> sent | failed
 *              scheduled -> sending -> sent | failed
 * On failure: retries with exponential backoff up to MAX_RETRIES
 * After MAX_RETRIES: status becomes 'failed' and requires manual retry
 *
 * Scheduled emails: queued with sendAt timestamp, processed when time arrives
 */

// Configuration
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 5000; // 5 seconds
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
const OUTBOX_PREFIX = 'outbox_';

const formatRfc3339 = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

// Outbox state store
export const outboxCount = writable(0);
export const outboxProcessing = writable(false);

// Track if processor is running
let processorRunning = false;
let processorInterval = null;

function getAccount() {
  return Local.get('email') || 'default';
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoff(retryCount) {
  const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
  // Add jitter (0-20% of delay)
  const jitter = delay * Math.random() * 0.2;
  return Math.floor(delay + jitter);
}

/**
 * Queue an email for sending
 * @param {Object} emailData - Email payload (from, to, cc, bcc, subject, html/text, attachments)
 * @param {Object} options - Queue options
 * @param {boolean} options.skipProcess - Skip immediate processing
 * @param {number} options.sendAt - Timestamp for scheduled send (optional)
 * @param {string} options.serverId - Server ID for scheduled emails already submitted to server
 * @returns {Promise<Object>} The queued outbox record
 */
export async function queueEmail(emailData, options = {}) {
  // Block sending in demo mode
  if (isDemoMode()) {
    showDemoBlockedToast('send email');
    const err = new Error('Demo mode: sending is disabled');
    err.isDemo = true;
    throw err;
  }

  const account = getAccount();
  const { skipProcess = false, sendAt = null, serverId = null } = options || {};
  const id = `${OUTBOX_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  // If sendAt is provided and in the future, set status to 'scheduled'
  const isScheduled = sendAt && sendAt > now;

  const record = {
    id,
    account,
    status: isScheduled ? 'scheduled' : 'pending',
    retryCount: 0,
    nextRetryAt: isScheduled ? sendAt : now, // Ready to send immediately or at scheduled time
    sendAt: sendAt || null, // Store the scheduled timestamp
    serverId: serverId || null, // Store server ID for scheduled emails
    lastError: null,
    emailData,
    createdAt: now,
    updatedAt: now,
  };

  await db.outbox.put(record);
  await updateOutboxCount();

  // Only trigger immediate processing if not scheduled and online
  if (!skipProcess && !isScheduled && navigator.onLine) {
    processOutbox();
  }

  return record;
}

/**
 * Get all outbox items for current account
 * @param {Object} options - Filter options
 * @returns {Promise<Array>} Array of outbox records
 */
export async function listOutbox(options = {}) {
  const account = getAccount();
  let query = db.outbox.where('[account+id]').between([account, ''], [account, '\uffff']);

  const items = await query.toArray();

  // Filter by status if specified
  if (options.status) {
    return items.filter((item) => item.status === options.status);
  }

  // Sort by createdAt descending (newest first)
  return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Get pending items ready to retry (includes scheduled emails whose time has arrived)
 */
export async function getPendingOutbox() {
  const account = getAccount();
  const now = Date.now();

  const items = await db.outbox
    .where('[account+id]')
    .between([account, ''], [account, '\uffff'])
    .toArray();

  return items
    .filter((item) => {
      // Include pending items ready for retry
      if (item.status === 'pending' && (item.nextRetryAt || 0) <= now) {
        return true;
      }
      // Include scheduled items whose time has come
      if (item.status === 'scheduled' && item.sendAt && item.sendAt <= now) {
        return true;
      }
      return false;
    })
    .sort((a, b) => (a.nextRetryAt || a.sendAt || 0) - (b.nextRetryAt || b.sendAt || 0));
}

/**
 * Get a single outbox item
 */
export async function getOutboxItem(id) {
  const account = getAccount();
  return db.outbox.get([account, id]);
}

/**
 * Update outbox count store (counts pending + scheduled items)
 */
async function updateOutboxCount() {
  try {
    const items = await listOutbox();
    // Count pending + scheduled (active items that haven't been sent yet)
    const activeCount = items.filter(
      (i) => i.status === 'pending' || i.status === 'scheduled',
    ).length;
    outboxCount.set(activeCount);
  } catch (err) {
    warn('[OutboxService] Failed to update count:', err);
  }
}

/**
 * Save a copy of sent message to Sent folder (client-side workaround)
 * Similar to saveSentCopy in Compose.svelte
 */
async function saveSentCopyToFolder(emailPayload) {
  return saveSentCopy(emailPayload, getAccount(), null);
}

/**
 * Send a single email from outbox
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendOutboxItem(item) {
  const account = getAccount();
  const now = Date.now();

  // If this item was already scheduled on the server, do not send it again.
  if (item.status === 'scheduled' && item.serverId && item.sendAt && item.sendAt <= now) {
    await db.outbox.update([account, item.id], {
      status: 'sent',
      lastError: null,
      updatedAt: now,
    });

    try {
      window.dispatchEvent(
        new CustomEvent('outbox-sent', {
          detail: {
            id: item.id,
            subject: item?.emailData?.subject || '(No subject)',
          },
        }),
      );
    } catch (err) {
      warn('[Outbox] Failed to dispatch send notification', err);
    }

    return { success: true, skipped: true };
  }

  // Mark as sending
  await db.outbox.update([account, item.id], {
    status: 'sending',
    updatedAt: Date.now(),
  });

  try {
    // Build payload - include send_at if this was a scheduled email
    const payload = { ...item.emailData };
    if (item.sendAt) {
      const scheduledDate = formatRfc3339(item.sendAt);
      if (scheduledDate) {
        payload.send_at = scheduledDate;
        payload.date = payload.date || scheduledDate;
      }
    }

    await Remote.request('Emails', payload, { method: 'POST' });

    // Save copy to Sent folder (client-side workaround)
    try {
      await saveSentCopyToFolder(item.emailData);
    } catch (sentErr) {
      console.error('[Outbox] Failed to save sent copy:', sentErr);
      // Don't fail the overall send if saving to Sent fails
    }

    // Success - mark as sent
    await db.outbox.update([account, item.id], {
      status: 'sent',
      lastError: null,
      updatedAt: Date.now(),
    });

    try {
      window.dispatchEvent(
        new CustomEvent('outbox-sent', {
          detail: {
            id: item.id,
            subject: item?.emailData?.subject || '(No subject)',
          },
        }),
      );
    } catch (err) {
      warn('[Outbox] Failed to dispatch send notification', err);
    }

    return { success: true };
  } catch (err) {
    const errorMessage = err.message || 'Send failed';
    const newRetryCount = (item.retryCount || 0) + 1;

    if (newRetryCount >= MAX_RETRIES) {
      // Max retries reached - mark as failed
      await db.outbox.update([account, item.id], {
        status: 'failed',
        retryCount: newRetryCount,
        lastError: errorMessage,
        updatedAt: Date.now(),
      });
    } else {
      // Schedule retry with backoff
      const backoff = calculateBackoff(newRetryCount);
      await db.outbox.update([account, item.id], {
        status: 'pending',
        retryCount: newRetryCount,
        nextRetryAt: Date.now() + backoff,
        lastError: errorMessage,
        updatedAt: Date.now(),
      });
    }

    return { success: false, error: errorMessage };
  }
}

/**
 * Process all pending outbox items
 */
export async function processOutbox() {
  if (!navigator.onLine) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  if (processorRunning) {
    return { processed: 0, sent: 0, failed: 0, skipped: true };
  }

  processorRunning = true;
  outboxProcessing.set(true);

  const results = { processed: 0, sent: 0, failed: 0 };

  try {
    const pending = await getPendingOutbox();

    for (const item of pending) {
      // Check if still online before each send
      if (!navigator.onLine) {
        break;
      }

      try {
        results.processed++;
        const result = await sendOutboxItem(item);

        if (result.success) {
          results.sent++;
        } else {
          results.failed++;
        }
      } catch (err) {
        // Individual item failure shouldn't stop processing other items
        console.error('[OutboxService] Failed to process item:', item.id, err);
        results.failed++;
      }

      // Small delay between sends to avoid overwhelming the server
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (err) {
    console.error('[OutboxService] Process error:', err);
  } finally {
    processorRunning = false;
    outboxProcessing.set(false);
    await updateOutboxCount();
  }

  return results;
}

/**
 * Manually retry a specific failed item
 */
export async function retryOutboxItem(id) {
  const account = getAccount();
  const item = await db.outbox.get([account, id]);

  if (!item) {
    return { success: false, error: 'Item not found' };
  }

  // Reset for retry
  await db.outbox.update([account, id], {
    status: 'pending',
    retryCount: 0,
    nextRetryAt: Date.now(),
    lastError: null,
    updatedAt: Date.now(),
  });

  await updateOutboxCount();

  // Trigger processing
  if (navigator.onLine) {
    return processOutbox();
  }

  return { success: true, queued: true };
}

/**
 * Retry all failed items
 */
export async function retryAllFailed() {
  const account = getAccount();
  const failed = await listOutbox({ status: 'failed' });

  for (const item of failed) {
    await db.outbox.update([account, item.id], {
      status: 'pending',
      retryCount: 0,
      nextRetryAt: Date.now(),
      lastError: null,
      updatedAt: Date.now(),
    });
  }

  await updateOutboxCount();

  if (navigator.onLine) {
    return processOutbox();
  }

  return { queued: failed.length };
}

/**
 * Delete an outbox item (sent or failed)
 */
export async function deleteOutboxItem(id) {
  const account = getAccount();
  await db.outbox.delete([account, id]);
  await updateOutboxCount();
}

/**
 * Cancel a scheduled email
 * Deletes from server (if submitted) and removes from local outbox
 * @param {string} id - Outbox item ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function cancelScheduledEmail(id) {
  const account = getAccount();
  const item = await db.outbox.get([account, id]);

  if (!item) {
    return { success: false, error: 'Item not found' };
  }

  // If the email has a server ID, it was submitted to the server and we must cancel there first
  if (item.serverId) {
    try {
      await Remote.request(
        'EmailCancel',
        {},
        {
          method: 'DELETE',
          pathOverride: `/v1/emails/${item.serverId}`,
        },
      );
    } catch (err) {
      console.error('[OutboxService] Failed to cancel on server:', err);
      // Do NOT remove from local if server cancellation fails - the email may still be sent
      return {
        success: false,
        error: `Failed to cancel on server: ${err.message || 'Unknown error'}. The scheduled email may still be sent.`,
      };
    }
  }

  // Successfully cancelled on server (or no server ID) - now delete from local outbox
  await db.outbox.delete([account, id]);
  await updateOutboxCount();

  return { success: true };
}

/**
 * Delete all sent items (cleanup)
 */
export async function clearSentItems() {
  const account = getAccount();
  const sent = await listOutbox({ status: 'sent' });

  for (const item of sent) {
    await db.outbox.delete([account, item.id]);
  }

  return { deleted: sent.length };
}

/**
 * Start the background processor
 * Checks for pending items periodically and processes when online
 */
export function startOutboxProcessor() {
  if (processorInterval) {
    return; // Already running
  }

  // Process immediately on start
  if (navigator.onLine) {
    processOutbox();
  }

  // Check every 30 seconds for items ready to retry
  processorInterval = setInterval(() => {
    if (navigator.onLine && !processorRunning) {
      processOutbox();
    }
  }, 30000);

  // Listen for online event
  window.addEventListener('online', handleOnline);

  // Update count on start
  updateOutboxCount();
}

/**
 * Stop the background processor
 */
export function stopOutboxProcessor() {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
  }
  window.removeEventListener('online', handleOnline);
}

/**
 * Handle coming back online
 */
function handleOnline() {
  processOutbox();
}

/**
 * Get outbox statistics
 */
export async function getOutboxStats() {
  const items = await listOutbox();

  return {
    total: items.length,
    pending: items.filter((i) => i.status === 'pending').length,
    scheduled: items.filter((i) => i.status === 'scheduled').length,
    sending: items.filter((i) => i.status === 'sending').length,
    sent: items.filter((i) => i.status === 'sent').length,
    failed: items.filter((i) => i.status === 'failed').length,
  };
}

// Export everything as a single object for convenience
export const outboxService = {
  // Stores
  outboxCount,
  outboxProcessing,

  // Queue operations
  queueEmail,
  listOutbox,
  getOutboxItem,
  getPendingOutbox,

  // Send operations
  processOutbox,
  retryOutboxItem,
  retryAllFailed,

  // Cleanup
  deleteOutboxItem,
  cancelScheduledEmail,
  clearSentItems,

  // Background processor
  startOutboxProcessor,
  stopOutboxProcessor,

  // Stats
  getOutboxStats,
};
