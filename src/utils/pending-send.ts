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
  emailData?: Record<string, unknown>;
  /** Set when the body was too large to keep next to the outbox copy. */
  emailDataOmitted?: boolean;
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
  retryInMs?: number;
}

export interface PendingSendQueueOptions {
  storage?: PendingSendStorage;
  now?: () => number;
  setTimer?: (fn: () => void | Promise<void>, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  submit: (record: PendingSendRecord) => Promise<SubmitResult>;
  deleteDrafts: (record: PendingSendRecord) => Promise<void>;
  onError?: (record: PendingSendRecord, error: string) => void;
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

function writeRecords(storage: PendingSendStorage, records: PendingSendRecord[]) {
  try {
    if (!records.length) {
      storage.removeItem(PENDING_SEND_STORAGE_KEY);
      return;
    }
    storage.setItem(PENDING_SEND_STORAGE_KEY, serialize(records));
  } catch {
    try {
      const slim = records.map((record) => ({
        ...record,
        emailData: undefined,
        emailDataOmitted: true,
      }));
      storage.setItem(PENDING_SEND_STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // Storage can be blocked (private mode, quota). The outbox row is the
      // other copy; losing this index must not throw out of Send.
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
    emailData: input.emailData,
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

  const persist = () => writeRecords(storage, records);

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
      options.onSchedule?.(next.dueAt);
    } catch {
      // A native wake is a backstop. The JS timer and the visibility flush
      // still run when it can't be armed.
    }
  };

  const flushDueNow = async () => {
    if (stopped) return;
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
      if (result.permanent) {
        records = records.filter((row) => row.id !== current.id);
        persist();
        try {
          options.onError?.(current, result.error || 'Send failed');
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
          options.onError?.(current, result.error || 'Send failed');
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

  const listen = (target: EventTarget, type: string, fn: () => void) => {
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

export function cancelPendingSend(id: string): PendingSendRecord | null {
  if (!attached) return null;
  return attached.cancel(id);
}

export function getAttachedPendingSendQueue(): PendingSendQueue | null {
  return attached;
}
