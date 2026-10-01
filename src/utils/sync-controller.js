import { writable, derived } from 'svelte/store';
import { accountKey } from './sync-helpers.ts';
import { pickFoldersForScope, getSyncSettings } from './sync-settings.js';
import { syncProgress } from '../stores/mailboxActions';
import {
  sendSyncTask,
  onSyncProgress,
  resetSyncWorkerReady,
  connectSyncSearchPort,
} from './sync-worker-client.js';
import { warn } from './logger.ts';
import { getPendingDeleteIds } from '../stores/mailboxStore';
import { nextBackfillDecision } from '../workers/sync-pure.ts';

let searchPortConnected = false;

const status = writable({
  running: false,
  paused: false,
  current: null,
  queue: [],
  account: null,
  message: '',
});

const progressMap = writable(new Map());

export const syncStatus = derived([status, progressMap], ([$status, $progress]) => ({
  ...$status,
  progress: $progress,
}));

export const syncSummary = derived([status, progressMap], ([$status, $progress]) => {
  if ($status.paused) return 'Sync paused';
  if (!$status.running && !$status.queue.length) return 'Mail synced';
  const current = $status.current;
  if (!current) return 'Syncing...';
  const entry = $progress.get(current.folder);
  if (!entry) return `Syncing ${current.folder}`;
  if (entry.stage === 'metadata') {
    return `Syncing ${current.folder} (${entry.fetched || 0}/${entry.target || '…'} headers)`;
  }
  if (entry.stage === 'bodies') {
    return `Downloading bodies ${entry.completed || 0}/${entry.total || entry.target || '…'}`;
  }
  return `Syncing ${current.folder}`;
});

let queue = [];
let inFlight = false;
let currentAccount = null;
// Consecutive zero-progress backfill batches seen, PER FOLDER — used to cap the
// backfill re-queue loop (see nextBackfillDecision). Reset on progress, done, or
// error. This must be per-folder: a single shared counter let one folder's
// exhausted (empty) batches stop a different folder's backfill mid-history, so
// historical backfill effectively only completed for the Inbox. Keyed by folder
// path; entries are dropped when a folder finishes (no requeue).
const backfillNoProgressStreakByFolder = new Map();
const queuedKeys = new Set();
const buildQueueKey = (task) => `${task.type}:${task.folder}`;
// Max look-ahead bodies warmed per prefetch request. Small on purpose: a tight
// worklist drains fast so it never meaningfully contends with a foreground open.
const PREFETCH_LIMIT = 8;
const pushTask = (task) => {
  const key = buildQueueKey(task);
  if (queuedKeys.has(key)) return false;
  queue.push(task);
  queuedKeys.add(key);
  return true;
};
const unshiftTask = (task) => {
  const key = buildQueueKey(task);
  if (queuedKeys.has(key)) return false;
  queue.unshift(task);
  queuedKeys.add(key);
  return true;
};
onSyncProgress((data) => {
  updateProgress(data.folder, {
    stage: data.stage || data.type,
    fetched: data.fetched,
    inserted: data.inserted,
    updated: data.updated,
    lastUID: data.lastUID,
    target: data.target,
    completed: data.completed,
    total: data.total,
  });
  // Update the global sync progress store
  const stage = data.stage || data.type;
  const current = stage === 'bodies' ? data.completed || 0 : data.fetched || 0;
  const total = data.total || data.target || 0;
  syncProgress.update((p) => ({
    ...p,
    stage,
    folder: data.folder,
    current,
    total,
    message:
      stage === 'bodies'
        ? `Downloading ${data.folder} (${current}/${total})`
        : `Syncing ${data.folder} (${current}${total ? '/' + total : ''})`,
  }));
});

function setStatus(partial) {
  status.update((s) => ({ ...s, ...partial }));
}

function updateProgress(folder, payload) {
  progressMap.update((map) => {
    const next = new Map(map);
    next.set(folder, { ...(next.get(folder) || {}), ...payload });
    return next;
  });
}

async function runTask(task) {
  const settings = getSyncSettings();
  if (task.type === 'metadata') {
    await sendSyncTask(
      {
        ...task,
        account: currentAccount,
        pageSize: task.pageSize || settings.pageSize || 50,
        maxMessages: task.maxMessages || settings.maxHeaders,
        pendingDeleteIds: getPendingDeleteIds(),
      },
      { timeout: 120_000 },
    );
    if (task.wantBodies) {
      unshiftTask({
        type: 'bodies',
        folder: task.folder,
        bodyLimit: settings.bodyLimit,
        maxMessages: task.maxMessages || settings.maxHeaders,
      });
    }
    // Forward sync just stopped at the sync_max_headers cap. Schedule a
    // low-priority backfill so older history fills in over time. Appended
    // (not unshifted) so it sits behind any other queued work, and
    // re-enqueued in small batches so the queue interleaves naturally
    // with user-triggered tasks (folder switch, manual refresh).
    pushTask({
      type: 'backfill',
      folder: task.folder,
      pageSize: task.pageSize || settings.pageSize || 50,
    });
  } else if (task.type === 'backfill') {
    let result;
    try {
      result = await sendSyncTask(
        {
          ...task,
          account: currentAccount,
          pageSize: task.pageSize || settings.pageSize || 50,
          pendingDeleteIds: getPendingDeleteIds(),
        },
        { timeout: 120_000 },
      );
    } catch (err) {
      // Backfill is best-effort. On error, don't loop — let the next
      // metadata sync (folder switch, manual refresh) re-trigger it.
      warn('[sync-controller] backfill task failed', err);
      backfillNoProgressStreakByFolder.delete(task.folder);
      return;
    }
    // Re-queue the next batch only while the worker reports !done AND batches
    // keep making progress. nextBackfillDecision caps consecutive zero-page
    // batches so a misbehaving worker can't spin the queue forever. The append
    // (pushTask) ensures any user-triggered work queued during this batch runs
    // first.
    const folderStreak = backfillNoProgressStreakByFolder.get(task.folder) || 0;
    const decision = nextBackfillDecision(result, folderStreak);
    if (decision.requeue) {
      backfillNoProgressStreakByFolder.set(task.folder, decision.noProgressStreak);
      pushTask({
        type: 'backfill',
        folder: task.folder,
        pageSize: task.pageSize || settings.pageSize || 50,
      });
    } else {
      // Folder finished (done or capped) — drop its counter so it doesn't leak.
      backfillNoProgressStreakByFolder.delete(task.folder);
    }
  } else if (task.type === 'bodies') {
    await sendSyncTask(
      {
        ...task,
        account: currentAccount,
        limit: task.bodyLimit || settings.bodyLimit,
        maxMessages: task.maxMessages || settings.maxHeaders,
      },
      { timeout: 60000 },
    );
  } else if (task.type === 'prefetch') {
    // ID-targeted look-ahead body warm. limit is bounded by the id count so the
    // worker never fans out beyond what we asked for.
    await sendSyncTask(
      {
        ...task,
        account: currentAccount,
        limit: Math.min(task.messageIds?.length || PREFETCH_LIMIT, PREFETCH_LIMIT),
      },
      { timeout: 60000 },
    );
  }
}

async function pump() {
  if (inFlight) return;
  const currentStatus = getStatusSnapshot();
  if (currentStatus.paused) return;
  if (!queue.length) {
    setStatus({ running: false, current: null, message: queue.length ? 'Waiting' : 'Idle' });
    // Sync complete - update progress store
    syncProgress.update((p) => {
      if (p.active) {
        return { active: false, stage: '', folder: '', current: 0, total: 0, message: '' };
      }
      return p;
    });
    return;
  }

  const task = queue.shift();
  const taskAccount = currentAccount;
  queuedKeys.delete(buildQueueKey(task));
  // Prefetch is a silent look-ahead: it must not flip the sync status to
  // "running" or paint "Syncing…" in the progress UI on every selection.
  const silent = task.type === 'prefetch';
  if (silent) {
    setStatus({ queue: [...queue] });
  } else {
    setStatus({ running: true, current: task, queue: [...queue] });

    // Update progress with current task
    syncProgress.update((p) => ({
      ...p,
      folder: task.folder,
      stage: task.type,
      message: `Syncing ${task.folder}...`,
    }));
  }

  inFlight = true;
  try {
    await runTask(task);
  } catch (err) {
    // Suppress expected errors from account switches
    if (err?.message !== 'Account switched') {
      warn('[sync-controller] task failed', err);
    }
  } finally {
    inFlight = false;
  }
  // If account changed while the task was in-flight, stop processing the stale queue
  if (currentAccount !== taskAccount) {
    setStatus({ running: false, current: null, queue: [] });
    return;
  }
  setStatus(silent ? { queue: [...queue] } : { running: false, current: null, queue: [...queue] });
  setTimeout(pump, 30); // yield to UI
}

function getStatusSnapshot() {
  let snapshot;
  status.subscribe((s) => {
    snapshot = s;
  })();
  return snapshot;
}

function prioritizeFolders(folders = []) {
  if (!folders?.length) return [];
  const inboxFirst = [...folders];
  inboxFirst.sort((a, b) => {
    const aPath = (a.path || a.name || '').toUpperCase();
    const bPath = (b.path || b.name || '').toUpperCase();
    if (aPath === 'INBOX') return -1;
    if (bPath === 'INBOX') return 1;
    return aPath.localeCompare(bPath);
  });
  return inboxFirst;
}

export function startInitialSync(account, folders = [], options = {}) {
  const normalizedAccount = accountKey(account);
  const resetQueue = currentAccount && currentAccount !== normalizedAccount;
  currentAccount = normalizedAccount;
  if (resetQueue) {
    queue = [];
    queuedKeys.clear();
    progressMap.set(new Map());
    resetSyncWorkerReady();
  }
  const settings = getSyncSettings();
  const scopedFolders = pickFoldersForScope(folders, settings.scope);
  const targets = prioritizeFolders(scopedFolders);

  const tasks = targets.map((f) => ({
    type: 'metadata',
    folder: f.path || f.name,
    pageSize: options.pageSize || 50,
    maxMessages: options.maxMessages || settings.maxHeaders,
    wantBodies: options.wantBodies || false,
  }));

  tasks.forEach((task) => pushTask(task));
  setStatus({ account: currentAccount, queue: [...queue] });

  // Update sync progress store and show toast
  if (tasks.length > 0) {
    syncProgress.set({
      active: true,
      stage: 'metadata',
      folder: tasks[0]?.folder || '',
      current: 0,
      total: tasks.length,
      message: 'Starting sync...',
    });
  }

  pump();
}

export function queueBodiesForFolder(folder, account, opts = {}) {
  const settings = getSyncSettings();
  const normalizedAccount = accountKey(account || currentAccount);
  if (currentAccount && currentAccount !== normalizedAccount) {
    queue = [];
    queuedKeys.clear();
    progressMap.set(new Map());
    resetSyncWorkerReady();
  }
  currentAccount = normalizedAccount;
  if (!folder) return;
  pushTask({
    type: 'bodies',
    folder,
    bodyLimit: opts.bodyLimit || settings.bodyLimit,
    maxMessages: opts.maxMessages || settings.maxHeaders,
  });
  setStatus({ account: currentAccount, queue: [...queue] });
  pump();
}

/**
 * Warm the bodies of specific messages the user is likely to open next
 * (adjacent rows, viewport, hover). ID-targeted and silent: it never drives the
 * sync status UI and writes only to db.messageBodies, so the foreground reader
 * later finds a warm cache entry instead of doing a cold network fetch.
 *
 * Replace-on-navigate: each call drops any still-queued prefetch task so the
 * newest navigation target wins (the type:folder dedup key would otherwise
 * silently drop the second request). Any already-in-flight prefetch is tiny and
 * just finishes. Triggered only from imperative selection/scroll/hover handlers
 * — never a reactive $effect — to avoid the select→load→effect→select loop that
 * disabled the original prefetch.
 */
export function prefetchMessages(folder, account, ids = []) {
  if (!folder) return;
  const messageIds = (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, PREFETCH_LIMIT);
  if (!messageIds.length) return;

  const normalizedAccount = accountKey(account || currentAccount);
  // Don't seed a stale account's queue; account switches reset the queue elsewhere.
  if (currentAccount && currentAccount !== normalizedAccount) return;
  currentAccount = normalizedAccount;

  // Drop any pending (not-yet-started) prefetch task so the latest target wins.
  queue = queue.filter((t) => {
    if (t.type === 'prefetch') {
      queuedKeys.delete(buildQueueKey(t));
      return false;
    }
    return true;
  });

  // Front of queue: prefetch is time-sensitive (the user is looking at this list
  // now) and small, so it runs ahead of low-priority backfill.
  unshiftTask({ type: 'prefetch', folder, account: normalizedAccount, messageIds });
  setStatus({ queue: [...queue] });
  pump();
}

export function syncFolderOnDemand(folder, account, opts = {}) {
  const settings = getSyncSettings();
  const normalizedAccount = accountKey(account || currentAccount);
  if (currentAccount && currentAccount !== normalizedAccount) {
    queue = [];
    queuedKeys.clear();
    progressMap.set(new Map());
    resetSyncWorkerReady();
  }
  currentAccount = normalizedAccount;
  if (!folder) return;

  // Queue metadata sync for the folder (high priority - add to front)
  const metadataTask = {
    type: 'metadata',
    folder,
    pageSize: opts.pageSize || settings.pageSize || 50,
    maxMessages: opts.maxMessages || settings.maxHeaders || 300,
    wantBodies: opts.wantBodies || false,
  };

  // Add to front of queue for immediate processing
  unshiftTask(metadataTask);
  setStatus({ account: currentAccount, queue: [...queue] });

  // Update sync progress to show we're syncing this folder
  syncProgress.set({
    active: true,
    stage: 'metadata',
    folder,
    current: 0,
    total: 0,
    message: `Syncing ${folder}...`,
  });

  pump();
}

/**
 * Metadata sync for a folder another client just changed. It goes to the
 * front of the queue, ahead of queued backfill (moving a copy already queued
 * further back), and ignores the sync scope: the scope limits background
 * sync, not a change the user is waiting to see.
 */
export function syncFolderForEvent(account, folder) {
  const folderPath = typeof folder === 'string' ? folder : folder?.path || folder?.name;
  if (!folderPath || typeof folderPath !== 'string') return;
  const settings = getSyncSettings();
  const normalizedAccount = accountKey(account || currentAccount);
  if (currentAccount && currentAccount !== normalizedAccount) {
    queue = [];
    queuedKeys.clear();
    progressMap.set(new Map());
    resetSyncWorkerReady();
  }
  currentAccount = normalizedAccount;

  const key = buildQueueKey({ type: 'metadata', folder: folderPath });
  const queued = queue.find((t) => buildQueueKey(t) === key);
  if (queued) {
    queue = queue.filter((t) => t !== queued);
    queuedKeys.delete(key);
  }
  unshiftTask(
    queued || {
      type: 'metadata',
      folder: folderPath,
      pageSize: settings.pageSize || 50,
      maxMessages: settings.maxHeaders,
      wantBodies: false,
    },
  );
  setStatus({ account: currentAccount, queue: [...queue] });
  pump();
}

export function pauseSync() {
  setStatus({ paused: true, running: false });
}

export function resumeSync() {
  setStatus({ paused: false });
  setTimeout(pump, 0);
}

/**
 * Connect the sync worker to the search worker via MessageChannel.
 * This allows sync worker to push index updates directly to the search worker.
 * @param {SearchWorkerClient} searchWorkerClient - The search worker client instance
 */
export async function connectSearchWorker(searchWorkerClient) {
  if (searchPortConnected) return;

  try {
    await connectSyncSearchPort(searchWorkerClient);
    searchPortConnected = true;
  } catch (err) {
    warn('[sync-controller] Failed to connect search worker', err);
  }
}
