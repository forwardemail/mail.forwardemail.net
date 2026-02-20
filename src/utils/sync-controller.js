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
const queuedKeys = new Set();
const buildQueueKey = (task) => `${task.type}:${task.folder}`;
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
    await sendSyncTask({
      ...task,
      account: currentAccount,
      pageSize: task.pageSize || settings.pageSize || 50,
      maxMessages: task.maxMessages || settings.maxHeaders,
      pendingDeleteIds: getPendingDeleteIds(),
    });
    if (task.wantBodies) {
      unshiftTask({
        type: 'bodies',
        folder: task.folder,
        bodyLimit: settings.bodyLimit,
        maxMessages: task.maxMessages || settings.maxHeaders,
      });
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
  setStatus({ running: true, current: task, queue: [...queue] });

  // Update progress with current task
  syncProgress.update((p) => ({
    ...p,
    folder: task.folder,
    stage: task.type,
    message: `Syncing ${task.folder}...`,
  }));

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
  setStatus({ running: false, current: null, queue: [...queue] });
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
