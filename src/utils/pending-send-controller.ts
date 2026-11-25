/**
 * Runs the pending-send queue from the main window.
 *
 * Compose only writes the record (see persistPendingSend). Submitting,
 * deleting the draft, and waking a hidden webview happen here, so none of
 * it depends on the compose component still being mounted.
 */

import { deleteDraft } from './draft-service';
import { createPendingSendQueue, type PendingSendRecord, type SubmitResult } from './pending-send';
import { commitHeldSend, getOutboxItem, queueEmail } from './outbox-service';

declare global {
  var __feFlushPendingSends: ((reason?: string) => void) | undefined;
  var __fePendingSendHidden: (() => void) | undefined;
}

type FlushReason = 'quit' | string | undefined;

let starting: Promise<void> | null = null;
let queue: ReturnType<typeof createPendingSendQueue> | null = null;

function dispatch(name: string, detail: unknown) {
  try {
    globalThis.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    // The main window listens when it can. The queue itself has already
    // updated storage.
  }
}

async function discardDrafts(record: PendingSendRecord): Promise<void> {
  const account = record.account || 'default';
  if (record.draftId) {
    try {
      await deleteDraft(record.draftId, { account });
    } catch (error) {
      console.warn('[pending-send] Failed to delete the local draft after send:', error);
    }
  }

  const ids = new Set<string>();
  if (record.sourceMessageId) ids.add(record.sourceMessageId);
  if (record.serverDraftId && record.serverDraftId !== record.sourceMessageId) {
    ids.add(record.serverDraftId);
  }
  if (!ids.size) return;

  const [{ Remote }, { db }, { getAuthHeaderForAccount }] = await Promise.all([
    import('./remote'),
    import('./db'),
    import('./auth'),
  ]);
  const authHeader = getAuthHeaderForAccount(account) || undefined;
  for (const id of ids) {
    try {
      await Remote.request(
        'MessageDelete',
        {},
        {
          method: 'DELETE',
          pathOverride: `/v1/messages/${encodeURIComponent(id)}?permanent=1`,
          authHeader,
        },
      );
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status !== 404) {
        console.warn('[pending-send] Failed to delete the server draft after send:', error);
      }
    }
    try {
      await db.messages.where('[account+id]').equals([account, id]).delete();
    } catch {
      // The server copy is the one that mattered.
    }
  }
}

async function submitRecord(record: PendingSendRecord): Promise<SubmitResult> {
  const account = record.account || 'default';
  let item = await getOutboxItem(record.id, account);
  // The row was written and is gone again: Undo removed it, or its account
  // signed out. Putting it back from this record is how an undone message
  // was sent anyway.
  if (!item && record.queued) return { ok: false, gone: true };
  // Send was pressed and the page died before the outbox write finished.
  // This record is then the only copy of the message.
  if (!item && record.emailData) {
    item = await queueEmail(record.emailData, {
      id: record.id,
      account,
      undoHold: true,
      holdUntil: record.dueAt,
      skipProcess: true,
      draftId: record.draftId,
      serverDraftId: record.serverDraftId,
      sourceMessageId: record.sourceMessageId,
      sendAs: record.sendAs,
    });
  }
  if (!item) {
    return {
      ok: false,
      permanent: true,
      error: 'The message to send was not saved on this device',
    };
  }
  return commitHeldSend(account, record.id);
}

async function finishQuit() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('complete_pending_send_flush');
  } catch {
    // Browser, or the command isn't available. Quitting still falls through
    // on the native timeout, and anything still held is sent on next launch.
  }
}

let armedFor = 0;

async function armNativeWake(dueAt: number) {
  if (!dueAt || dueAt === armedFor) return;
  const tauri = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!tauri) return;
  armedFor = dueAt;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('arm_pending_send_wake', { dueAtMs: dueAt });
  } catch {
    armedFor = 0;
  }
}

async function onFlushRequest(reason?: FlushReason) {
  if (!queue) {
    if (reason === 'quit') await finishQuit();
    return;
  }
  if (reason === 'quit') await queue.flushAll();
  else await queue.flushDue();
  if (reason === 'quit') await finishQuit();
}

function installHooks() {
  const g = globalThis as typeof globalThis & {
    __feFlushPendingSends?: (reason?: FlushReason) => void;
    __fePendingSendHidden?: () => void;
  };
  g.__feFlushPendingSends = (reason) => {
    void onFlushRequest(reason);
  };
  g.__fePendingSendHidden = () => {
    queue?.keepAliveWhileHidden();
  };
}

installHooks();

export function startPendingSendController(): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    queue = createPendingSendQueue({
      attach: true,
      submit: submitRecord,
      deleteDrafts: discardDrafts,
      onCommitted: (record) => dispatch('pending-send-committed', record),
      onError: (record, error, willRetry) =>
        dispatch('pending-send-failed', { record, error, willRetry }),
      onSchedule: (dueAt) => {
        void armNativeWake(dueAt);
      },
      document: typeof document !== 'undefined' ? document : null,
      window: typeof window !== 'undefined' ? window : null,
    });
    globalThis.addEventListener('outbox-sent', (event) => {
      const detail = (event as CustomEvent)?.detail || {};
      const owned = detail?.id ? queue?.list().find((row) => row.id === detail.id) : undefined;
      // A flush already in flight finishes the draft delete and the
      // committed event itself. This covers the outbox interval sending
      // the row while the undo timer was still waiting.
      if (owned?.phase === 'submitting') return;
      if (owned) {
        queue?.complete(owned.id);
        dispatch('pending-send-committed', owned);
      }
      if (!detail?.draftId && !detail?.serverDraftId && !detail?.sourceMessageId) return;
      void discardDrafts({
        id: detail.id,
        account: detail.account || owned?.account || 'default',
        dueAt: 0,
        subject: detail.subject || owned?.subject || '',
        draftId: detail.draftId ?? owned?.draftId,
        serverDraftId: detail.serverDraftId ?? owned?.serverDraftId,
        sourceMessageId: detail.sourceMessageId ?? owned?.sourceMessageId,
        createdAt: 0,
        phase: 'held',
      });
    });
    await queue.start();
  })();
  return starting;
}

export async function adoptPendingSend(record: PendingSendRecord | null | undefined) {
  if (!record?.id) return;
  if (!queue) await startPendingSendController();
  // The composer hands the record over after its outbox write. When this
  // window can see that row, the row is the message and no second copy is
  // kept in localStorage. A compose window with its own database is the
  // case where the record has to carry the message.
  let queued = Boolean(record.queued);
  if (!queued) {
    try {
      queued = Boolean(await getOutboxItem(record.id, record.account || 'default'));
    } catch {
      queued = false;
    }
  }
  queue?.enqueue({ ...record, queued });
}

export function syncPendingSends() {
  queue?.reload();
}
