/**
 * Pending undo-sends.
 *
 * Pressing Send with an undo delay used to arm a setTimeout in the compose
 * window and delete the draft immediately. On the macOS desktop app that
 * timer lives in a WKWebView: hiding the window, switching apps, or tearing
 * the composer down suspends or drops it, so the message never left the
 * device while Drafts had already been cleared.
 *
 * The queue below is written the moment Send is pressed (localStorage, so
 * the write finishes before any await) and is driven by whoever calls
 * start() — the main window, not the compose component. A late timer, a
 * visibility or focus change, a relaunch, or quit all run the same flush.
 * The draft is removed only after submit reports success.
 */

export const PENDING_SEND_STORAGE_KEY = 'webmail_pending_sends';

const MAX_STORED_CHARS = 1_500_000;

export interface PendingSendStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingSendRecord {
  id: string;
  account: string;
  dueAt: number;
  subject: string;
  /**
   * The message, kept here only until the outbox has its own copy (queued).
   * It covers the moment between pressing Send and that write finishing.
   */
  emailData?: Record<string, unknown>;
  /** Set when the body was too large to keep next to the outbox copy. */
  emailDataOmitted?: boolean;
  /**
   * The outbox row for this send was written. From then on that row is the
   * message: if it is gone, the send was undone or its account signed out,
   * and it must not be put back from this record.
   */
  queued?: boolean;
  draftId?: string | null;
  serverDraftId?: string | null;
  sourceMessageId?: string | null;
  archive?: boolean;
  ownerAccount?: string | null;
  replyToMessageId?: string | null;
  replyToMessageFolder?: string | null;
  sendAs?: string | null;
  createdAt: number;
  phase: 'held' | 'submitting';
  nextAttemptAt?: number;
  lastError?: string;
  notified?: boolean;
}

export interface NewPendingSend {
  id?: string;
  account: string;
  dueAt: number;
  subject?: string;
  emailData?: Record<string, unknown>;
  queued?: boolean;
  draftId?: string | null;
  serverDraftId?: string | null;
  sourceMessageId?: string | null;
  archive?: boolean;
  replyToMessageId?: string | null;
  replyToMessageFolder?: string | null;
  sendAs?: string | null;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
  /** The account isn't ready. Try again; this is not a failure to show. */
  deferred?: boolean;
  /** The server rejected the message. Stop automatic retries. */
  permanent?: boolean;
  /**
   * The outbox row was removed (Undo, sign-out). Nothing is left to send and
   * nothing went wrong: drop the record without reporting an error.
   */
  gone?: boolean;
  retryInMs?: number;
}

export interface PendingSendQueueOptions {
  storage?: PendingSendStorage;
  now?: () => number;
  setTimer?: (fn: () => void | Promise<void>, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  submit: (record: PendingSendRecord) => Promise<SubmitResult>;
  deleteDrafts: (record: PendingSendRecord) => Promise<void>;
  /** `willRetry` is false once automatic attempts have stopped. */
  onError?: (record: PendingSendRecord, error: string, willRetry: boolean) => void;
  onCommitted?: (record: PendingSendRecord) => void;
  /** Soonest held deadline, so a native timer can wake a suspended webview. */
  onSchedule?: (dueAt: number) => void;
  document?: Document | null;
  window?: Window | null;
  /** When true, persistPendingSend and undo go through this queue. */
  attach?: boolean;
}

export interface PendingSendQueue {
  enqueue(input: NewPendingSend): PendingSendRecord;
  /** Drop a held send and hand it back. A send already in flight is left alone. */
  cancel(id: string): PendingSendRecord | null;
  /** Remove a record after something else (the outbox) finished it. */
  complete(id: string): void;
  /** The outbox has the message now: stop keeping a second copy of it here. */
  markQueued(id: string): void;
  /** Forget every send of an account that signed out. */
  dropAccount(account: string): void;
  list(): PendingSendRecord[];
  flushDue(): Promise<void>;
  /** Quit: every held send is due now. */
  flushAll(): Promise<void>;
  /** Overdue rows from a previous launch. */
  recover(): Promise<void>;
  /** The window was hidden. Keep the send; don't treat that as cancel or quit. */
  keepAliveWhileHidden(): void;
  start(): Promise<void>;
  /** Drop timers and listeners. Stored sends stay so another queue can run them. */
  stop(): void;
  reload(): void;
}

let attached: PendingSendQueue | null = null;

function defaultStorage(): PendingSendStorage {
  if (typeof localStorage !== 'undefined') return localStorage;
  const mem = new Map<string, string>();
  return {
    getItem: (key) => (mem.has(key) ? mem.get(key)! : null),
    setItem: (key, value) => {
      mem.set(key, value);
    },
    removeItem: (key) => {
      mem.delete(key);
    },
  };
}

export function createPendingSendId(now = Date.now()): string {
  return `outbox_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

function slimEmail(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data;
  if (!Array.isArray(data.attachments)) return data;
  return {
    ...data,
    attachments: data.attachments.map((att) => {
      if (!att || typeof att !== 'object') return att;
      const copy = { ...(att as Record<string, unknown>) };
      delete copy.content;
      delete copy.data;
      return copy;
    }),
  };
}

function serialize(records: PendingSendRecord[]): string {
  const full = JSON.stringify(records);
  if (full.length <= MAX_STORED_CHARS) return full;
  const slim = records.map((record) => ({ ...record, emailData: slimEmail(record.emailData) }));
  const slimmed = JSON.stringify(slim);
  if (slimmed.length <= MAX_STORED_CHARS) return slimmed;
  return JSON.stringify(
    slim.map((record) => ({ ...record, emailData: undefined, emailDataOmitted: true })),
  );
}

function readRecords(storage: PendingSendStorage): PendingSendRecord[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_SEND_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => row && typeof row.id === 'string' && typeof row.dueAt === 'number')
      .map((row) => {
        const record = row as PendingSendRecord;
        // A submit that died with the page has to be tried again. The outbox
        // treats a duplicate Message-ID as the original send succeeding.
        if (record.phase === 'submitting') record.phase = 'held';
        if (record.phase !== 'held') record.phase = 'held';
        return record;
      });
  } catch {
    return [];
  }
}

/**
 * The ids storage holds right now, or null when storage cannot be read. Null
 * and an empty set are different answers: only the second says a send was
 * removed.
 */
function readStoredIds(storage: PendingSendStorage): Set<string> | null {
  try {
    const raw = storage.getItem(PENDING_SEND_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.map((row) => row?.id).filter((id) => typeof id === 'string'));
  } catch {
    return null;
  }
}

/** Returns whether storage now holds these records. */
function writeRecords(storage: PendingSendStorage, records: PendingSendRecord[]): boolean {
  try {
    if (!records.length) {
      storage.removeItem(PENDING_SEND_STORAGE_KEY);
      return true;
    }
    storage.setItem(PENDING_SEND_STORAGE_KEY, serialize(records));
    return true;
  } catch {
    try {
      const slim = records.map((record) => ({
        ...record,
        emailData: undefined,
        emailDataOmitted: true,
      }));
      storage.setItem(PENDING_SEND_STORAGE_KEY, JSON.stringify(slim));
      return true;
    } catch {
      // Storage can be blocked (private mode, quota). The outbox row is the
      // other copy; losing this index must not throw out of Send.
      return false;
    }
  }
}

function toRecord(input: NewPendingSend, now: number): PendingSendRecord {
  const id = input.id || createPendingSendId(now);
  return {
    id,
    account: input.account || 'default',
    dueAt: input.dueAt,
    subject: input.subject || '(No subject)',
    // Once the outbox holds the message this record is only its deadline
    emailData: input.queued ? undefined : input.emailData,
    queued: Boolean(input.queued),
    draftId: input.draftId || null,
    serverDraftId: input.serverDraftId || null,
    sourceMessageId: input.sourceMessageId || null,
    archive: Boolean(input.archive),
    ownerAccount: input.account || null,
    replyToMessageId: input.replyToMessageId || null,
    replyToMessageFolder: input.replyToMessageFolder || null,
    sendAs: input.sendAs || null,
    createdAt: now,
    phase: 'held',
  };
}

export function createPendingSendQueue(options: PendingSendQueueOptions): PendingSendQueue {
  const storage = options.storage || defaultStorage();
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer || ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let records = readRecords(storage);
  let timer: unknown = null;
  let stopped = false;
  let flushChain: Promise<void> = Promise.resolve();
  const unlistens: Array<() => void> = [];

  // False after a write that did not reach storage. Storage then says
  // nothing about which sends were removed elsewhere.
  let storageTrusted = true;

  const persist = () => {
    storageTrusted = writeRecords(storage, records);
  };

  // Another tab's Undo, or a sign-out, removes a send from storage. This
  // queue may still hold it from when it loaded, and sending from that copy
  // is how an undone message went out anyway. A send in flight is left to
  // finish: its outbox row decides what happens to it.
  const dropRemovedElsewhere = () => {
    if (!storageTrusted) return;
    const stored = readStoredIds(storage);
    if (!stored) return;
    records = records.filter((record) => record.phase === 'submitting' || stored.has(record.id));
  };

  const schedule = () => {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    if (stopped) return;
    // A failed attempt stays held with nextAttemptAt in the future. Waking on
    // dueAt alone would schedule a 0ms timer that immediately re-arms itself.
    const wakeAt = (record: PendingSendRecord) => Math.max(record.dueAt, record.nextAttemptAt || 0);
    const next = records
      .filter((record) => record.phase === 'held')
      .sort((a, b) => wakeAt(a) - wakeAt(b))[0];
    if (!next) return;
    const delay = Math.max(0, wakeAt(next) - now());
    timer = setTimer(() => {
      if (stopped) return;
      return flushDue();
    }, delay);
    try {
      // The time of the next attempt, which for a retry is after dueAt
      options.onSchedule?.(wakeAt(next));
    } catch {
      // A native wake is a backstop. The JS timer and the visibility flush
      // still run when it can't be armed.
    }
  };

  const flushDueNow = async () => {
    if (stopped) return;
    dropRemovedElsewhere();
    const t = now();
    const due = records.filter(
      (record) => record.phase === 'held' && record.dueAt <= t && (record.nextAttemptAt || 0) <= t,
    );
    for (const snapshot of due) {
      const record = records.find((row) => row.id === snapshot.id && row.phase === 'held');
      if (!record) continue;
      record.phase = 'submitting';
      persist();
      let result: SubmitResult;
      try {
        result = await options.submit(record);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : 'Send failed',
        };
      }
      const current = records.find((row) => row.id === record.id);
      if (!current) continue;
      if (result.ok) {
        try {
          await options.deleteDrafts(current);
        } catch {
          // The message is already accepted. A draft that won't delete is
          // worse to retry the send over than to leave in Drafts.
        }
        records = records.filter((row) => row.id !== current.id);
        persist();
        try {
          options.onCommitted?.(current);
        } catch {
          // The send succeeded. A toast or archive failure doesn't put it back.
        }
        continue;
      }
      if (result.gone) {
        records = records.filter((row) => row.id !== current.id);
        persist();
        continue;
      }
      if (result.permanent) {
        records = records.filter((row) => row.id !== current.id);
        persist();
        try {
          options.onError?.(current, result.error || 'Send failed', false);
        } catch {
          // The caller shows the error. Swallow a listener bug.
        }
        continue;
      }
      current.phase = 'held';
      current.lastError = result.error;
      current.nextAttemptAt = now() + (result.retryInMs || (result.deferred ? 5_000 : 15_000));
      if (!result.deferred && !current.notified) {
        current.notified = true;
        try {
          options.onError?.(current, result.error || 'Send failed', true);
        } catch {
          // same as above
        }
      }
      persist();
    }
  };

  const flushDue = () => {
    const run = flushChain.then(flushDueNow, flushDueNow);
    flushChain = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      schedule();
    });
  };

  const listen = (target: EventTarget, type: string, fn: (event: Event) => void) => {
    target.addEventListener(type, fn);
    unlistens.push(() => target.removeEventListener(type, fn));
  };

  const queue: PendingSendQueue = {
    enqueue(input) {
      const existing = input.id ? records.find((row) => row.id === input.id) : undefined;
      // A send already on the wire must not be replaced with a fresh hold.
      // That would let a second flush post the same message again.
      if (existing?.phase === 'submitting') return existing;
      const record = toRecord(input, now());
      records = records.filter((row) => row.id !== record.id).concat(record);
      persist();
      schedule();
      return record;
    },
    cancel(id) {
      const record = records.find((row) => row.id === id && row.phase === 'held');
      if (!record) return null;
      records = records.filter((row) => row.id !== id);
      persist();
      schedule();
      return record;
    },
    complete(id) {
      if (!records.some((row) => row.id === id)) return;
      records = records.filter((row) => row.id !== id);
      persist();
      schedule();
    },
    markQueued(id) {
      const record = records.find((row) => row.id === id);
      if (!record || (record.queued && !record.emailData)) return;
      record.queued = true;
      delete record.emailData;
      delete record.emailDataOmitted;
      persist();
    },
    dropAccount(account) {
      if (!records.some((row) => row.account === account)) return;
      // One in flight is dropped too: its outbox row is gone with the account
      records = records.filter((row) => row.account !== account);
      persist();
      schedule();
    },
    list() {
      return records.map((record) => ({ ...record }));
    },
    flushDue,
    async flushAll() {
      const t = now();
      for (const record of records) {
        if (record.phase !== 'held') continue;
        record.dueAt = t;
        record.nextAttemptAt = 0;
      }
      persist();
      await flushDue();
    },
    recover: () => flushDue(),
    keepAliveWhileHidden() {
      // Hiding the window is not undo and not quit. Re-arm whatever the
      // webview may have suspended; overdue work waits for a wake or a flush.
      schedule();
    },
    async start() {
      stopped = false;
      const doc = options.document;
      if (doc) {
        listen(doc, 'visibilitychange', () => {
          if (doc.visibilityState === 'hidden') {
            queue.keepAliveWhileHidden();
            return;
          }
          if (doc.visibilityState === 'visible') void flushDue();
        });
      }
      const view = options.window;
      if (view) {
        listen(view, 'focus', () => {
          void flushDue();
        });
        listen(view, 'pageshow', () => {
          void flushDue();
        });
        // Another tab added, sent or undid a send
        listen(view, 'storage', (event) => {
          const key = (event as StorageEvent).key;
          if (key === PENDING_SEND_STORAGE_KEY || key === null) queue.reload();
        });
      }
      schedule();
      await flushDue();
    },
    stop() {
      stopped = true;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      for (const unlisten of unlistens.splice(0)) unlisten();
      if (attached === queue) attached = null;
    },
    reload() {
      // Nothing to learn from a storage this queue could not write to
      if (!storageTrusted) return;
      const incoming = readRecords(storage);
      const live = new Map(records.map((record) => [record.id, record]));
      // A submit this process already started keeps its in-memory phase.
      // Storage is allowed to say "held" for that id (a killed page is
      // rewritten that way on read) without starting a second send.
      records = incoming.map((record) => {
        const current = live.get(record.id);
        if (current?.phase === 'submitting') return current;
        return record;
      });
      schedule();
    },
  };

  if (options.attach) attached = queue;
  return queue;
}

/** Write a pending send before any await. Uses the live queue when the main window owns one. */
export function persistPendingSend(
  input: NewPendingSend,
  storage?: PendingSendStorage,
): PendingSendRecord {
  if (attached && !storage) return attached.enqueue(input);
  const store = storage || defaultStorage();
  const now = Date.now();
  const record = toRecord(input, now);
  const records = readRecords(store)
    .filter((row) => row.id !== record.id)
    .concat(record);
  writeRecords(store, records);
  return record;
}

export function forgetPendingSend(id: string, storage?: PendingSendStorage) {
  if (attached && !storage) {
    attached.complete(id);
    return;
  }
  const store = storage || defaultStorage();
  writeRecords(
    store,
    readRecords(store).filter((row) => row.id !== id),
  );
}

/** The outbox row exists: keep only the deadline here, not the message. */
export function markPendingSendQueued(id: string, storage?: PendingSendStorage) {
  if (attached && !storage) {
    attached.markQueued(id);
    return;
  }
  const store = storage || defaultStorage();
  const records = readRecords(store);
  const record = records.find((row) => row.id === id);
  if (!record) return;
  record.queued = true;
  delete record.emailData;
  delete record.emailDataOmitted;
  writeRecords(store, records);
}

/** An account signed out: none of its held sends may go out later. */
export function dropPendingSendsForAccount(account: string, storage?: PendingSendStorage) {
  if (!account) return;
  if (attached && !storage) {
    attached.dropAccount(account);
    return;
  }
  const store = storage || defaultStorage();
  const records = readRecords(store);
  if (!records.some((row) => row.account === account)) return;
  writeRecords(
    store,
    records.filter((row) => row.account !== account),
  );
}

export function cancelPendingSend(id: string): PendingSendRecord | null {
  if (!attached) return null;
  return attached.cancel(id);
}

export function getAttachedPendingSendQueue(): PendingSendQueue | null {
  return attached;
}
