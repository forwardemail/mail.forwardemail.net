/**
 * Forward Email – opening what a notification points at
 *
 * Every way a notification can be tapped or clicked ends here: an APNs alert
 * (iOS), an FCM tray notification or a UnifiedPush notification (Android), a
 * local notification the app drew itself (desktop and mobile), a web
 * notification (service worker), and the "View" action on the in-app toast.
 *
 * Tapping used to land on the inbox instead of the message, for several
 * reasons that all had to be fixed together:
 *
 *   - A tap can arrive long before the app can act on it: on a cold start the
 *     page is still booting, and with App Lock enabled the vault is shut until
 *     the PIN is entered. The tap was acted on (or dropped) immediately, so
 *     after unlocking the user was left on the inbox. Here the tap is held
 *     until the app is signed in, unlocked and booted, then acted on once.
 *   - A tap for another signed-in account switched accounts and navigated
 *     150ms later. The switch takes far longer than that (it reads the cache,
 *     resets the stores and selects the new account's inbox), so the switch
 *     overwrote the navigation. Here the navigation waits for the switch.
 *   - Only the newest tap matters: a second tap replaces a pending first one
 *     rather than queueing a string of navigations.
 *   - A pending tap is kept in sessionStorage (its ids only, never a subject
 *     or sender) until it has been opened. On iOS the system can end the
 *     page's process while the PIN pad is up or mid-switch; the app reloads,
 *     and the tap the page had already taken from the native queue was lost.
 *   - New mail delivered to temporary storage has no message id yet. Its
 *     notification carries the subject and sender, and the newest message
 *     that matches them is opened instead of leaving the user on the inbox.
 *
 * The mailbox side of the navigation (#FOLDER/MESSAGE_ID) is handled by
 * Mailbox.svelte, which opens the message even when it is not in the loaded
 * page of the list.
 */

import { Accounts, Local } from './storage.js';
import { sameAccount } from './account-scope';

export interface NotificationOpenTarget {
  /** Email of the account the notification belongs to. */
  account?: string;
  /** Mailbox path (for example INBOX or Work/Projects). */
  folder?: string;
  /** Message id as the API and the message list use it. */
  messageId?: string;
  /** Another app route: /calendar#event=…, /contacts#contact=… */
  appPath?: string;
  /** Subject of the message, to find it when there is no message id. */
  subject?: string;
  /** Sender of the message ("Name <address>"), for the same purpose. */
  sender?: string;
}

export interface NotificationMessageHint {
  folder: string;
  subject: string;
  sender: string;
}

export interface NotificationOpenDeps {
  /** True once the app is signed in, unlocked and booted. */
  isReady: () => boolean;
  /** Switch to another signed-in account; resolves once it is on screen. */
  switchAccount: (email: string) => Promise<unknown>;
  /** SPA navigation (viewModel.navigate). */
  navigate: (path: string) => void;
}

const MAX_FIELD = 255;
// How long a tap stays pending. Long enough to cover a slow boot and the user
// entering a PIN; a tap from much earlier than that is no longer what the user
// is asking for.
const PENDING_TTL_MS = 10 * 60 * 1000;
// Upper bound on waiting for an account switch before navigating anyway.
const SWITCH_DEADLINE_MS = 20_000;
const ALLOWED_APP_PATH = /^\/(?:calendar|contacts)(?:[#?][^\s]*)?$/;
const PENDING_STORAGE_KEY = 'fe_notification_open_pending';
// How long the mailbox looks for the message a hint describes. Mail delivered
// to temporary storage reaches the mailbox once the app has connected.
const HINT_TTL_MS = 30_000;

let deps: NotificationOpenDeps | null = null;
let pending: { target: NotificationOpenTarget; at: number } | null = null;
let flushing = false;
let generation = 0;
let messageHint: (NotificationMessageHint & { at: number }) | null = null;

function savePending(): void {
  try {
    if (pending) {
      const { account, folder, messageId, appPath } = pending.target;
      const target = { account, folder, messageId, appPath };
      sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ target, at: pending.at }));
    } else {
      sessionStorage.removeItem(PENDING_STORAGE_KEY);
    }
  } catch {
    // Private mode or a full quota: the tap still works without a reload.
  }
}

function restorePending(): void {
  if (pending) return;
  try {
    const raw = sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_STORAGE_KEY);
    const saved = JSON.parse(raw) as { target?: unknown; at?: unknown };
    const target = normalizeNotificationTarget(saved?.target);
    const at = Number(saved?.at);
    if (!target || !Number.isFinite(at) || Date.now() - at > PENDING_TTL_MS) return;
    pending = { target, at };
    savePending();
  } catch {
    // Unreadable entry: nothing to restore.
  }
}

function clean(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim()
      .slice(0, MAX_FIELD)
  );
}

/**
 * Validate and normalise a target. Returns null when it names nothing the app
 * can open.
 */
export function normalizeNotificationTarget(input: unknown): NotificationOpenTarget | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const target: NotificationOpenTarget = {};

  const account = clean(raw.account);
  if (account && account.includes('@')) target.account = account;

  let folder = clean(raw.folder);
  if (folder && folder.toUpperCase() === 'INBOX') folder = 'INBOX';
  if (folder) target.folder = folder;

  const messageId = clean(raw.messageId);
  if (messageId && /^[\w.\-:@+=]+$/.test(messageId)) target.messageId = messageId;

  const appPath = clean(raw.appPath);
  if (appPath && ALLOWED_APP_PATH.test(appPath)) target.appPath = appPath;

  // Only needed to find a message that has no id yet.
  if (!target.messageId && !target.appPath) {
    const subject = clean(raw.subject);
    const sender = clean(raw.sender);
    if (subject) target.subject = subject;
    if (sender) target.sender = sender;
  }

  if (!target.folder && !target.messageId && !target.appPath && !target.account) return null;
  return target;
}

/**
 * The path a target navigates to, or '' for "just the account".
 */
export function notificationTargetPath(target: NotificationOpenTarget): string {
  if (target.appPath) return target.appPath;
  if (target.messageId) {
    const folder = target.folder || 'INBOX';
    return `/mailbox#${encodeURIComponent(folder)}/${encodeURIComponent(target.messageId)}`;
  }
  if (target.folder) return `/mailbox#${encodeURIComponent(target.folder)}`;
  return '';
}

/**
 * The signed-in account a notification names, spelled the way the account
 * list stores it, or '' when it is not signed in on this device. The switch
 * compares emails exactly, so "Alice@…" from a notification would not match
 * the stored "alice@…".
 */
function signedInAccount(email: string): string {
  try {
    const accounts = Accounts.getAll() || [];
    if (accounts.length) {
      const match = accounts.find((account: { email?: string }) =>
        sameAccount(account?.email, email),
      );
      return match?.email || '';
    }
  } catch {
    // fall through to the single-account check
  }
  const active = Local.get('email');
  return sameAccount(active, email) ? active : '';
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Act on the pending tap if the app can. Safe to call at any time and from any
 * readiness signal; it does nothing until the app is ready.
 */
export async function flushPendingNotificationOpen(): Promise<boolean> {
  if (!deps || !pending || flushing) return false;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    savePending();
    return false;
  }
  let ready = false;
  try {
    ready = deps.isReady();
  } catch {
    ready = false;
  }
  if (!ready) return false;

  // Taken from memory now; the saved copy stays until it has been opened,
  // so a page that dies during the account switch opens it after reloading.
  const { target } = pending;
  pending = null;
  flushing = true;
  const myGeneration = ++generation;
  try {
    if (target.account && !sameAccount(target.account, Local.get('email'))) {
      const account = signedInAccount(target.account);
      if (!account) {
        // Not an account on this device (it was signed out after the push was
        // sent). Its message ids mean nothing in the account on screen.
        console.warn('[notification-open] ignoring tap for an account not signed in');
        return false;
      }
      await withDeadline(
        Promise.resolve(deps.switchAccount(account)).catch((err) => {
          console.warn('[notification-open] account switch failed:', err);
        }),
        SWITCH_DEADLINE_MS,
      );
      // A newer tap arrived while switching: that one wins.
      if (myGeneration !== generation || pending) return false;
      if (!sameAccount(target.account, Local.get('email'))) return false;
    }

    const path = notificationTargetPath(target);
    messageHint =
      !target.messageId && !target.appPath && (target.subject || target.sender)
        ? {
            folder: target.folder || 'INBOX',
            subject: target.subject || '',
            sender: target.sender || '',
            at: Date.now(),
          }
        : null;
    if (path) deps.navigate(path);
    return true;
  } finally {
    flushing = false;
    // Done with it (or replaced by a newer tap, which is saved instead).
    savePending();
    // A tap that came in while this one was being handled.
    if (pending) queueMicrotask(() => void flushPendingNotificationOpen());
  }
}

/**
 * Open what a notification points at, now or as soon as the app is able to.
 */
export function openNotificationTarget(input: unknown): boolean {
  const target = normalizeNotificationTarget(input);
  if (!target) return false;
  pending = { target, at: Date.now() };
  savePending();
  generation++;
  void flushPendingNotificationOpen();
  return true;
}

/**
 * Wire the router to the app. Called once from main.ts; flushes anything that
 * was tapped before the app was ready.
 */
export function configureNotificationOpen(next: NotificationOpenDeps): void {
  deps = next;
  // A tap taken before the page was reloaded.
  restorePending();
  void flushPendingNotificationOpen();
}

/**
 * The message a just-opened notification describes without an id, for the
 * mailbox to look for. Read once.
 */
export function takeNotificationMessageHint(): NotificationMessageHint | null {
  const hint = messageHint;
  messageHint = null;
  if (!hint || Date.now() - hint.at > HINT_TTL_MS) return null;
  return { folder: hint.folder, subject: hint.subject, sender: hint.sender };
}

function normalizeSubject(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

function addresses(value: unknown): string[] {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value && typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = '';
    }
  }
  return (text.match(/[^\s<>"',;:()[\]{}]+@[^\s<>"',;:()[\]{}]+/g) || []).map((a) =>
    a.toLowerCase(),
  );
}

/**
 * Whether a message in the list is the one a hint describes: the same subject
 * (its start, when the notification cut it short) and a sender with the same
 * address.
 */
export function messageMatchesHint(
  message: { subject?: unknown; from?: unknown } | null | undefined,
  hint: NotificationMessageHint | null | undefined,
): boolean {
  if (!message || !hint) return false;
  const subject = normalizeSubject(hint.subject);
  const senders = addresses(hint.sender);
  if (!subject && !senders.length) return false;
  if (subject) {
    const listed = normalizeSubject(message.subject);
    const truncated = hint.subject.length >= MAX_FIELD;
    if (truncated ? !listed.startsWith(subject) : listed !== subject) return false;
  }
  if (senders.length) {
    const from = addresses(message.from);
    if (!senders.some((address) => from.includes(address))) return false;
  }
  return true;
}

/**
 * Map a remote push payload (APNs userInfo, FCM data, UnifiedPush body, all of
 * which carry the same fields from the server's buildPayload) to a target.
 * `account` is the email resolved from the payload's alias_id, when known.
 */
export function pushDataToTarget(
  data: Record<string, unknown> | null | undefined,
  account = '',
): NotificationOpenTarget | null {
  if (!data || typeof data !== 'object') return null;
  const event = clean(data.event) || clean(data.type);
  const id = clean(data.message_id) || clean(data.id) || clean(data.uid);
  const base: Record<string, unknown> = account ? { account } : {};

  if (/^calendar/i.test(event)) {
    const hash = id ? `#event=${encodeURIComponent(id)}` : '';
    return normalizeNotificationTarget({ ...base, appPath: `/calendar${hash}` });
  }
  if (/^(?:contact|addressBook)/i.test(event)) {
    const hash = id ? `#contact=${encodeURIComponent(id)}` : '';
    return normalizeNotificationTarget({ ...base, appPath: `/contacts${hash}` });
  }
  if (/^mailbox/i.test(event)) {
    return normalizeNotificationTarget({ ...base, folder: 'INBOX' });
  }

  // newMessage and anything unrecognised: the message, or the folder it
  // arrived in, or the inbox. Without an id (mail delivered to temporary
  // storage) the subject and sender identify it.
  return normalizeNotificationTarget({
    ...base,
    folder: clean(data.mailbox) || clean(data.folder) || 'INBOX',
    messageId: id,
    subject: clean(data.subject),
    sender: clean(data.sender) || clean(data.from),
  });
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse an in-app location: `/mailbox#FOLDER/ID`, `#FOLDER/ID` (the older
 * notification `path`), `/calendar#…` or `/contacts#…`.
 */
function locationToTarget(location: string, account = ''): NotificationOpenTarget | null {
  const base: Record<string, unknown> = account ? { account } : {};
  if (/^\/(?:calendar|contacts)/i.test(location)) {
    return normalizeNotificationTarget({ ...base, appPath: location });
  }
  const hashIndex = location.indexOf('#');
  if (hashIndex === -1) return normalizeNotificationTarget({ ...base, folder: 'INBOX' });
  const hash = location.slice(hashIndex + 1).split('?')[0];
  const slash = hash.indexOf('/');
  const folder = decode(slash > 0 ? hash.slice(0, slash) : hash);
  const messageId = slash > 0 ? decode(hash.slice(slash + 1)) : '';
  // #folders, #settings, #calendar and #contacts were used as generic
  // destinations; none of them is a mailbox.
  if (/^(?:folders|settings|notes)$/i.test(folder)) {
    return normalizeNotificationTarget({ ...base, folder: 'INBOX' });
  }
  if (/^(?:calendar|contacts)$/i.test(folder)) {
    return normalizeNotificationTarget({ ...base, appPath: `/${folder.toLowerCase()}` });
  }
  return normalizeNotificationTarget({ ...base, folder: folder || 'INBOX', messageId });
}

/**
 * Map a forwardemail:// deep link that points into the app to a target, or
 * null when the link is something else (for example a mailto: link).
 */
export function deepLinkToTarget(url: unknown): NotificationOpenTarget | null {
  if (typeof url !== 'string') return null;
  const match = /^forwardemail:\/\/(.*)$/i.exec(url.trim());
  if (!match) return null;
  const rest = `/${match[1]}`;
  if (!/^\/(?:mailbox|calendar|contacts)(?:[/#?]|$)/i.test(rest)) return null;
  if (/^\/mailbox\/(?:settings|profile)/i.test(rest)) return null;
  return locationToTarget(rest);
}

/**
 * Map the `data` (or Tauri `extra`) attached to a notification the app drew
 * itself to a target. Understands the current shape ({account, folder,
 * messageId, appPath}) and the older one ({account, path, url, uid}).
 */
export function notificationDataToTarget(data: unknown): NotificationOpenTarget | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const account = clean(raw.account);
  if (raw.folder || raw.messageId || raw.appPath) {
    return normalizeNotificationTarget(raw);
  }
  const url = clean(raw.url);
  const fromUrl = deepLinkToTarget(url);
  if (fromUrl) return normalizeNotificationTarget({ ...fromUrl, account });
  const path = clean(raw.path);
  if (path) return locationToTarget(path, account);
  return account ? normalizeNotificationTarget({ account }) : null;
}

/**
 * A notification opened in a fresh browser window (web) carries its target in
 * the URL: /mailbox?fe_notify=<json>#… . Read it, remove it from the address
 * bar, and queue it.
 */
export function consumeNotificationTargetFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get('fe_notify');
    if (!raw) return false;
    url.searchParams.delete('fe_notify');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    // The service worker opens this window itself, so it has no referrer. A
    // link followed from a page (which could switch the viewer's account) has
    // one and is ignored.
    if (typeof document !== 'undefined' && document.referrer) return false;
    return openNotificationTarget(JSON.parse(raw));
  } catch {
    return false;
  }
}

/** Test helper. */
export function __resetNotificationOpenForTests(): void {
  deps = null;
  pending = null;
  flushing = false;
  generation = 0;
  messageHint = null;
  savePending();
}
