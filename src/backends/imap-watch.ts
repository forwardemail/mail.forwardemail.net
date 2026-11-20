/**
 * Live new mail for an account on a custom IMAP server.
 *
 * A Forward Email account hears about new mail over its WebSocket. An IMAP
 * account has none, so the mail engine keeps a connection parked on the
 * inbox (IMAP IDLE, src-tauri/src/mail/watch.rs) and sends "mail:changed"
 * when the server says the folder changed. The event carries no mail: this
 * module reads the top of the inbox through the usual commands, tells the
 * rest of the app the inbox changed, and announces what is new.
 */

import { isActiveAccount } from '../utils/account-scope';
import { accountForMailHandle } from './imap-engine';
import { ImapBackend } from './imap';
import { getMailBackend } from './index';
import type { ServerRecord } from './types';

/** Fired on the window when a watched inbox changed. detail: { account } */
export const INBOX_CHANGED_EVENT = 'mail:inbox-changed';

/** How far down the inbox to look for mail that arrived since the last look. */
const NEWEST = 15;

type Announce = (data: Record<string, unknown>, opts: { otherAccount: boolean }) => unknown;

interface Seen {
  /** The folder's UIDVALIDITY, from the message ids. A new one restarts the count. */
  uidValidity: string;
  uid: number;
}

const seen = new Map<string, Seen>();
const chains = new Map<string, Promise<void>>();
let listening: Promise<void> | null = null;
let announce: Announce | null = null;

const key = (account: string) => account.toLowerCase();

/** `imap-<uidvalidity>-<uid>-<folder>` */
const validityOf = (row: ServerRecord): string => String(row?.id ?? '').split('-')[1] || '';

async function newest(account: string): Promise<ServerRecord[]> {
  const backend = getMailBackend(account);
  if (!(backend instanceof ImapBackend) || !backend.isReady()) return [];
  const page = await backend.listMessages({ folder: 'INBOX', page: 1, limit: NEWEST });
  return page.rows || [];
}

/**
 * Look at the top of the inbox and announce what arrived since the last
 * look. The first look only records where the inbox stands: mail that was
 * already there when the app started is not news.
 */
async function check(account: string): Promise<void> {
  const rows = await newest(account);
  if (!rows.length) return;
  const uidValidity = validityOf(rows[0]);
  const top = Math.max(...rows.map((row) => Number(row.uid) || 0));
  const before = seen.get(key(account));
  seen.set(key(account), { uidValidity, uid: top });
  if (!before || before.uidValidity !== uidValidity) return;
  const fresh = rows
    .filter((row) => (Number(row.uid) || 0) > before.uid)
    .sort((a, b) => Number(a.uid) - Number(b.uid));
  if (!fresh.length) return;
  if (!announce) {
    const manager = await import('../utils/notification-manager');
    announce = manager.announceNewMail as Announce;
  }
  for (const message of fresh) {
    await announce(
      { _account: account, mailbox: 'INBOX', message },
      { otherAccount: !isActiveAccount(account) },
    );
  }
}

/** One look at a time per account; a change during a look queues one more. */
function queueCheck(account: string): Promise<void> {
  const run = (chains.get(key(account)) || Promise.resolve()).then(() =>
    check(account).catch((err) => {
      console.warn('[imap-watch] could not read the inbox after a change', err);
    }),
  );
  chains.set(key(account), run);
  return run;
}

/** The engine said an account's inbox changed. Exported for tests. */
export async function handleMailChanged(payload: unknown): Promise<void> {
  const handle = (payload as { handle?: unknown } | null)?.handle;
  if (typeof handle !== 'string') return;
  const account = await accountForMailHandle(handle);
  if (!account) return;
  try {
    globalThis.dispatchEvent?.(new CustomEvent(INBOX_CHANGED_EVENT, { detail: { account } }));
  } catch {
    // No window to tell.
  }
  await queueCheck(account);
}

function listen(): Promise<void> {
  if (!listening) {
    listening = import('@tauri-apps/api/event')
      .then(({ listen: on }) =>
        on('mail:changed', (event) => void handleMailChanged(event.payload)),
      )
      .then(() => undefined)
      .catch(() => {
        // Not in the desktop app, so there is no engine to hear from.
        listening = null;
      });
  }
  return listening;
}

/**
 * Start watching an IMAP account's inbox. Safe to call often: the engine
 * keeps one watcher per account, and calling again after the app process
 * restarted starts it again.
 */
export async function ensureInboxWatch(account: string): Promise<void> {
  const backend = getMailBackend(account);
  if (!(backend instanceof ImapBackend) || !backend.isReady()) return;
  await listen();
  await backend.watchInbox();
  if (!seen.has(key(account))) await queueCheck(account);
}

/** Test seam. */
export function resetInboxWatchForTests(announcer: Announce | null = null): void {
  seen.clear();
  chains.clear();
  listening = null;
  announce = announcer;
}
