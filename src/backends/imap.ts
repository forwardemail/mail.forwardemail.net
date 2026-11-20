/**
 * A custom IMAP server as a mail backend.
 *
 * Every call goes to the Rust mail engine, which holds the connection. This
 * class maps between the engine's answers and the records the app reads, and
 * keeps the one piece of state that needs: the server's folder list, for the
 * path separator and the Trash folder.
 */

import { labelChangeBody } from '../utils/message-changes';
import { mailCommand, mailEngineAvailable, MailEngineError, mailHandleFor } from './imap-engine';
import { imapSettingsFor } from './imap-account';
import PostalMime from 'postal-mime';
import { IMAP_CAPABILITIES } from './capabilities';
import {
  bytesToBase64,
  decodePart,
  folderToRecord,
  headerBytes,
  imapMessageId,
  metaFromHeader,
  parseHeaderBlock,
  parseImapMessageId,
  rowToRecord,
  toClientPath,
  toServerPath,
  type EngineFolder,
  type EngineRow,
  type ImapMessageRef,
} from './imap-mapping';
import {
  BackendNotReadyError,
  type FlagChange,
  type IdRemap,
  type LabelChange,
  type MailBackend,
  type MailReads,
  type MessageCheck,
  type MessageRequestOptions,
  type MessageId,
  type MessageListPage,
  type ServerRecord,
} from './types';

interface EngineFound {
  uidValidity?: number | null;
  uids: number[];
}

interface EngineLocated {
  uidValidity?: number | null;
  uid: number;
}

/** One message of a batch move (Moved in src-tauri/src/mail/imap.rs). */
interface EngineMoved {
  uid: number;
  located?: EngineLocated | null;
}

/** Changes waiting to go to the engine as one command. */
interface Batch<T> {
  waiting: Array<{
    uid: number;
    resolve: (answer: T | undefined) => void;
    reject: (err: unknown) => void;
  }>;
  send: (uids: number[]) => Promise<Map<number, T> | void>;
}

/** The engine takes at most 250 messages in one command. */
const MAX_BATCH = 200;

/** The engine's search fields (SearchQuery in src-tauri/src/mail/imap.rs). */
interface ImapSearch {
  text?: string;
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  unseen?: boolean;
  flagged?: boolean;
  since?: string;
  before?: string;
  hasAttachment?: boolean;
}

const MAX_PAGE_ROWS = 250;
const MAX_SEARCH_FOLDERS = 15;

const day = (value: unknown): string | undefined => {
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
};

/**
 * The search and filters in a list query, as the engine takes them. Null for
 * a plain list. The query's names are the Forward Email API's (see
 * buildServerSearchParams), since the callers still write it that way.
 */
export function searchFromQuery(query: Record<string, unknown>): ImapSearch | null {
  const text = (key: string) => {
    const value = typeof query[key] === 'string' ? (query[key] as string).trim() : '';
    return value || undefined;
  };
  const search: ImapSearch = {
    text: text('search'),
    subject: text('subject'),
    from: text('from'),
    to: text('to'),
    body: text('body'),
    ...(query.is_unread ? { unseen: true } : {}),
    ...(query.is_flagged ? { flagged: true } : {}),
    ...(query.has_attachments || query.has_attachment ? { hasAttachment: true } : {}),
    ...(query.since ? { since: day(query.since) } : {}),
    ...(query.before ? { before: day(query.before) } : {}),
  };
  const used = Object.fromEntries(Object.entries(search).filter(([, v]) => v !== undefined));
  return Object.keys(used).length ? (used as ImapSearch) : null;
}

interface EnginePage {
  total: number;
  uidValidity?: number | null;
  /** The folder's change counter, on a server that keeps one (CONDSTORE). */
  highestModseq?: string | null;
  rows: EngineRow[];
}

/** What is new or changed in a folder (Changes in src-tauri/src/mail/imap.rs). */
interface EngineChanges {
  uidValidity?: number | null;
  highestModseq: string;
  uids: number[];
}

/**
 * Where a folder's changes were last read up to, as the sync pass keeps it:
 * `<uidValidity>:<change counter>`. The counter means nothing once the
 * folder's UIDVALIDITY changes, so the two travel together. The counter is
 * kept as text: it does not fit a JavaScript number.
 */
export function changeToken(uidValidity: unknown, counter: unknown): string | null {
  const validity = Number(uidValidity);
  const text = String(counter ?? '');
  if (!Number.isInteger(validity) || validity <= 0 || !/^\d+$/.test(text)) return null;
  return `${validity}:${text}`;
}

function parseChangeToken(token: unknown): { uidValidity: number; counter: string } | null {
  const match = /^(\d+):(\d+)$/.exec(typeof token === 'string' ? token : '');
  return match ? { uidValidity: Number(match[1]), counter: match[2] } : null;
}

/** A request this kind of account cannot answer yet. Callers treat it as a failed request. */
export class UnsupportedForAccountError extends Error {
  readonly code = 'UNSUPPORTED_FOR_ACCOUNT';
  constructor(what: string) {
    super(`${what} is not available for this account yet`);
    this.name = 'UnsupportedForAccountError';
  }
}

const TRASH_NAMES = /^(trash|deleted items|deleted messages|deleted|bin)$/i;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export class ImapBackend implements MailBackend, MailReads {
  readonly kind = 'imap' as const;
  readonly capabilities = IMAP_CAPABILITIES;

  private folders: EngineFolder[] | null = null;
  private loadingFolders: Promise<EngineFolder[]> | null = null;
  private batches = new Map<string, Batch<unknown>>();
  private sending: Promise<void> = Promise.resolve();
  private changesRead: { key: string; changes: EngineChanges } | null = null;

  constructor(readonly account: string) {}

  isReady(): boolean {
    return mailEngineAvailable() && Boolean(imapSettingsFor(this.account));
  }

  /** Only the app can reach the mail engine, so nothing is replayed without it. */
  backgroundReplay(): null {
    return null;
  }

  private run<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.isReady()) return Promise.reject(new BackendNotReadyError(this.account));
    return mailCommand<T>(this.account, cmd, args);
  }

  private async loadFolders(): Promise<EngineFolder[]> {
    if (!this.loadingFolders) {
      this.loadingFolders = this.run<EngineFolder[]>('imap_folders')
        .then((list) => {
          this.folders = Array.isArray(list) ? list : [];
          return this.folders;
        })
        .finally(() => {
          this.loadingFolders = null;
        });
    }
    return this.loadingFolders;
  }

  private async knownFolders(): Promise<EngineFolder[]> {
    return this.folders || this.loadFolders();
  }

  /** The server's own name for a folder the app knows by its "/" path. */
  private async serverPath(clientPath: string): Promise<string> {
    const folders = await this.knownFolders();
    const wanted = clientPath.toUpperCase() === 'INBOX' ? 'INBOX' : clientPath;
    const match = folders.find((f) => folderToRecord(f).path === wanted);
    if (match) return match.path;
    // A folder not in the list yet (just created): use the separator the
    // server's other folders use.
    const delimiter = folders.find((f) => f.delimiter)?.delimiter || '/';
    return toServerPath(clientPath, delimiter);
  }

  private async trashPath(): Promise<string | null> {
    const folders = await this.knownFolders();
    const trash =
      folders.find((f) => f.specialUse === 'trash') ||
      folders.find((f) => TRASH_NAMES.test(toClientPath(f.path, f.delimiter || '/')));
    return trash ? trash.path : null;
  }

  private ref(id: MessageId): ImapMessageRef {
    const ref = parseImapMessageId(id);
    if (!ref) throw new MailEngineError('missing', 'That message is not on this server');
    return ref;
  }

  // ---- folders ----

  async listFolders(): Promise<ServerRecord[]> {
    const folders = await this.loadFolders();
    return folders.filter((f) => f.selectable).map(folderToRecord);
  }

  async getFolder(id: MessageId): Promise<ServerRecord> {
    const folders = await this.knownFolders();
    const match = folders.map(folderToRecord).find((f) => f.id === String(id));
    // IMAP folders carry no flags of their own.
    return { ...(match || { id: String(id), path: String(id) }), flags: [] };
  }

  async createFolder(path: string): Promise<void> {
    await this.run('imap_create_folder', { path: await this.serverPath(path) });
    this.folders = null;
  }

  async renameFolder(id: MessageId, newPath: string): Promise<void> {
    await this.run('imap_rename_folder', {
      from: await this.serverPath(String(id)),
      to: await this.serverPath(newPath),
    });
    this.folders = null;
  }

  async deleteFolder(id: MessageId): Promise<void> {
    await this.run('imap_delete_folder', { path: await this.serverPath(String(id)) });
    this.folders = null;
  }

  // ---- lists ----

  /** One page of a folder, newest first. */
  private async folderPage(folder: string, page: number, limit: number): Promise<MessageListPage> {
    const result = await this.run<EnginePage>('imap_rows', {
      folder: await this.serverPath(folder),
      page,
      limit,
    });
    const uidValidity = Number(result.uidValidity) || 0;
    // Every row is as the folder was at this count. The sync pass keeps it
    // and next time asks only for what changed after it (changedPage).
    const token = changeToken(uidValidity, result.highestModseq);
    const rows = await Promise.all(
      (result.rows || []).map(async (row) => ({
        ...(await rowToRecord(row, folder, uidValidity)),
        ...(token ? { modseq: token } : {}),
      })),
    );
    return { rows, total: Number.isFinite(result.total) ? result.total : null, notModified: false };
  }

  /**
   * One page of what is new or changed in a folder since `since`, newest
   * first. Null when that cannot be answered (no change counter on this
   * server, or the folder was rebuilt), and the caller lists the folder.
   *
   * With nothing changed, this is one command to the server and no rows.
   * Without it, every pass read the newest page again, headers and all, and
   * never saw a flag that changed further down.
   */
  private async changedPage(
    folder: string,
    since: string,
    page: number,
    limit: number,
  ): Promise<MessageListPage | null> {
    const asked = parseChangeToken(since);
    if (!asked) return null;
    const serverFolder = await this.serverPath(folder);
    const key = `${folder}\n${since}`;
    // Later pages cut the list the first page read. Read again, a change
    // made in between would shift the cut and a message would be skipped.
    let changes = page > 1 && this.changesRead?.key === key ? this.changesRead.changes : null;
    if (!changes) {
      const read = await this.run<EngineChanges | null>('imap_changes', {
        folder: serverFolder,
        since: asked.counter,
      });
      if (!read || Number(read.uidValidity) !== asked.uidValidity) return null;
      changes = { ...read, uids: Array.isArray(read.uids) ? read.uids : [] };
      this.changesRead = { key, changes };
    }
    const wanted = changes.uids.slice((page - 1) * limit, page * limit);
    if (!wanted.length) {
      this.changesRead = null;
      return { rows: [], total: changes.uids.length, notModified: page === 1 };
    }
    const result = await this.run<EnginePage>('imap_rows_for', {
      folder: serverFolder,
      uids: wanted,
    });
    const token = changeToken(asked.uidValidity, changes.highestModseq);
    const rows = await Promise.all(
      (result.rows || []).map(async (row) => ({
        ...(await rowToRecord(row, folder, asked.uidValidity)),
        ...(token ? { modseq: token } : {}),
      })),
    );
    return { rows, total: changes.uids.length, notModified: false };
  }

  /**
   * One page of the messages in a folder that match a search, newest first.
   * The server answers a search with UIDs only, so the page's rows are a
   * second request.
   */
  private async searchPage(
    folder: string,
    search: ImapSearch,
    page: number,
    limit: number,
  ): Promise<MessageListPage> {
    const serverFolder = await this.serverPath(folder);
    const found = await this.run<EngineFound>('imap_search', {
      folder: serverFolder,
      query: search,
    });
    const uids = Array.isArray(found?.uids) ? found.uids : [];
    const wanted = uids.slice((page - 1) * limit, page * limit);
    if (!wanted.length) return { rows: [], total: uids.length, notModified: false };
    const result = await this.run<EnginePage>('imap_rows_for', {
      folder: serverFolder,
      uids: wanted,
    });
    const uidValidity = Number(result.uidValidity ?? found.uidValidity) || 0;
    const rows = await Promise.all(
      (result.rows || []).map((row) => rowToRecord(row, folder, uidValidity)),
    );
    return { rows, total: uids.length, notModified: false };
  }

  /** The folders a search with no folder named looks in: all but Trash and Junk. */
  private async searchableFolders(): Promise<string[]> {
    const folders = await this.knownFolders();
    return folders
      .filter((f) => f.selectable && f.specialUse !== 'trash' && f.specialUse !== 'junk')
      .map((f) => folderToRecord(f).path)
      .filter((path) => !TRASH_NAMES.test(path))
      .slice(0, MAX_SEARCH_FOLDERS);
  }

  async listMessages(query: Record<string, unknown>): Promise<MessageListPage> {
    const page = Math.max(1, Number(query.page) || 1);
    // The engine answers at most this many rows at once.
    const limit = Math.min(MAX_PAGE_ROWS, Math.max(1, Number(query.limit) || 50));
    const search = searchFromQuery(query);
    const folder = query.folder ? String(query.folder) : '';

    // A plain list. The server lists newest first and nothing else; the list
    // sorts the rows it has loaded, so a sort order is not refused.
    if (!search) {
      const changed = query.since_modseq
        ? await this.changedPage(folder || 'INBOX', String(query.since_modseq), page, limit)
        : null;
      return changed ?? this.folderPage(folder || 'INBOX', page, limit);
    }
    if (folder) return this.searchPage(folder, search, page, limit);

    // A search of the whole mailbox. IMAP searches one folder at a time, so
    // each is asked in turn until the page is full.
    const rows: ServerRecord[] = [];
    let total = 0;
    for (const path of await this.searchableFolders()) {
      const found = await this.searchPage(path, search, 1, limit);
      total += found.total || 0;
      rows.push(...found.rows);
      if (rows.length >= limit) break;
    }
    return { rows: rows.slice(0, limit), total, notModified: false };
  }

  async requestMessageList(query: object): Promise<ServerRecord[]> {
    const { rows } = await this.listMessages(query as Record<string, unknown>);
    return rows;
  }

  // ---- reading ----

  /** A message's bytes. `whole` asks for every attachment too, however large. */
  private async messageBytes(id: MessageId, whole: boolean): Promise<Uint8Array> {
    const ref = this.ref(id);
    const buffer = await this.run<ArrayBuffer | number[]>(whole ? 'imap_raw' : 'imap_message', {
      folder: await this.serverPath(ref.folder),
      uid: ref.uid,
    });
    // The engine answers with raw bytes; an older bridge gives a number list.
    return Array.isArray(buffer) ? Uint8Array.from(buffer) : new Uint8Array(buffer);
  }

  /**
   * A message's source, for the reader to parse. A large message comes
   * without its attachments: each one holds a marker (leanPartOf) and is
   * fetched with getPart when it is opened. `whole` asks for all of it.
   */
  async getMessage(
    id: MessageId,
    { whole = false }: { folder?: string; raw?: boolean; whole?: boolean } = {},
  ): Promise<ServerRecord> {
    const ref = this.ref(id);
    const bytes = await this.messageBytes(id, whole);
    const parsed = await parseHeaderBlock(headerBytes(bytes));
    return {
      id: String(id),
      uid: ref.uid,
      folder: ref.folder,
      subject: parsed.subject,
      // The reader takes a message's source as text.
      raw: new TextDecoder().decode(bytes),
      nodemailer: metaFromHeader(parsed),
    };
  }

  /** One attachment of a message, by the section number its marker named. */
  async getPart(id: MessageId, section: string, encoding: string): Promise<Uint8Array> {
    const ref = this.ref(id);
    const buffer = await this.run<ArrayBuffer | number[]>('imap_part', {
      folder: await this.serverPath(ref.folder),
      uid: ref.uid,
      section,
    });
    const bytes = Array.isArray(buffer) ? Uint8Array.from(buffer) : new Uint8Array(buffer);
    return decodePart(bytes, encoding);
  }

  /**
   * A message the way the Forward Email API answers for one, for the callers
   * on the main thread that still read that shape: the parsed body and every
   * attachment with its content (`raw: false`), or the source alone.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async requestMessage(id: MessageId, opts: MessageRequestOptions = {}): Promise<any> {
    if (opts.eml || opts.responseAs === 'text') {
      return new TextDecoder().decode(await this.messageBytes(id, true));
    }
    if (opts.raw) return this.getMessage(id);

    const ref = this.ref(id);
    const bytes = await this.messageBytes(id, true);
    const [header, email, row] = await Promise.all([
      parseHeaderBlock(headerBytes(bytes)),
      PostalMime.parse(bytes),
      this.run<EngineRow | null>('imap_row', {
        folder: await this.serverPath(ref.folder),
        uid: ref.uid,
      }).catch(() => null),
    ]);
    const attachments = (email.attachments || []).map((att) => {
      const content =
        typeof att.content === 'string'
          ? new TextEncoder().encode(att.content)
          : new Uint8Array(att.content);
      return {
        filename: att.filename || undefined,
        contentType: att.mimeType || 'application/octet-stream',
        contentDisposition: att.disposition || 'attachment',
        ...(att.contentId ? { cid: att.contentId.replace(/^<|>$/g, '') } : {}),
        size: content.byteLength,
        content,
      };
    });
    const listed = row ? await rowToRecord(row, ref.folder, ref.uidValidity) : {};
    return {
      ...listed,
      id: String(id),
      uid: ref.uid,
      folder: ref.folder,
      folder_path: ref.folder,
      subject: header.subject,
      html: email.html || undefined,
      text: email.text || undefined,
      attachments,
      nodemailer: {
        ...metaFromHeader(header),
        html: email.html || undefined,
        text: email.text || undefined,
        attachments,
      },
    };
  }

  async checkMessage(id: MessageId): Promise<MessageCheck> {
    const ref = parseImapMessageId(id);
    // An id from another kind of account says nothing about this server.
    if (!ref) return { state: 'unknown' };
    try {
      const row = await this.run<EngineRow | null>('imap_row', {
        folder: await this.serverPath(ref.folder),
        uid: ref.uid,
      });
      if (!row) return { state: 'gone' };
      return { state: 'found', detail: await rowToRecord(row, ref.folder, ref.uidValidity) };
    } catch (err) {
      if (err instanceof MailEngineError && err.kind === 'auth') return { state: 'rejected' };
      if (err instanceof MailEngineError && err.kind === 'server') return { state: 'unknown' };
      throw err;
    }
  }

  // ---- changes ----

  /**
   * Send changes that are asked for together as one command.
   *
   * The app changes messages one at a time, and for a selection it asks for
   * all of them at once. Sent one by one, each costs the server several
   * commands on a connection that runs one at a time, so a few dozen
   * messages took the better part of a minute. Calls with the same key are
   * handed to `send` as one list instead, and each caller gets its own
   * message's answer, or the batch's error.
   */
  private together<T>(
    key: string,
    uid: number,
    send: (uids: number[]) => Promise<Map<number, T> | void>,
  ): Promise<T | undefined> {
    let batch = this.batches.get(key) as Batch<T> | undefined;
    if (!batch) {
      const created: Batch<T> = { waiting: [], send };
      batch = created;
      this.batches.set(key, created as Batch<unknown>);
      // A batch stays open until its turn comes. The first one goes out
      // straight away; whatever is asked for while it is on the wire joins
      // the next, so changes that arrive a moment apart still go together.
      this.sending = this.sending.then(() => {
        this.batches.delete(key);
        return this.sendBatch(created);
      });
    }
    const waiting = batch.waiting;
    return new Promise((resolve, reject) => waiting.push({ uid, resolve, reject }));
  }

  private async sendBatch<T>(batch: Batch<T>): Promise<void> {
    for (let at = 0; at < batch.waiting.length; at += MAX_BATCH) {
      const part = batch.waiting.slice(at, at + MAX_BATCH);
      try {
        const answers = await batch.send([...new Set(part.map((w) => w.uid))]);
        for (const w of part) w.resolve(answers ? answers.get(w.uid) : undefined);
      } catch (err) {
        for (const w of part) w.reject(err);
      }
    }
  }

  private async store(id: MessageId, add: string[], remove: string[]): Promise<void> {
    if (!add.length && !remove.length) return;
    const ref = this.ref(id);
    await this.together<void>(
      `store\n${ref.folder}\n${JSON.stringify([add, remove])}`,
      ref.uid,
      async (uids) => {
        await this.run('imap_store_many', {
          folder: await this.serverPath(ref.folder),
          uids,
          add,
          remove,
        });
      },
    );
  }

  changeFlags(id: MessageId, change: FlagChange): Promise<void> {
    return this.store(id, strings(change.add), strings(change.remove));
  }

  changeLabels(id: MessageId, change: LabelChange): Promise<void> {
    const diff = labelChangeBody(change.labels, change.previous ?? undefined) as {
      labels_add?: string[];
      labels_remove?: string[];
    };
    return this.store(id, strings(diff.labels_add), strings(diff.labels_remove));
  }

  /** Move messages out of one folder. `destination` is the server's name for it. */
  private async moveMany(
    folder: string,
    uids: number[],
    destination: string,
  ): Promise<Map<number, EngineLocated | null>> {
    const moved = await this.run<EngineMoved[] | null>('imap_move_many', {
      folder,
      uids,
      destination,
    });
    return new Map((moved || []).map((one) => [one.uid, one.located ?? null]));
  }

  async moveMessage(id: MessageId, destFolder: string): Promise<IdRemap> {
    const ref = this.ref(id);
    const located = await this.together<EngineLocated | null>(
      `move\n${ref.folder}\n${destFolder}`,
      ref.uid,
      async (uids) =>
        this.moveMany(await this.serverPath(ref.folder), uids, await this.serverPath(destFolder)),
    );
    return this.remapTo(id, destFolder, located ?? null);
  }

  /**
   * A moved message has a new id, because its folder and its number in that
   * folder are both part of the id. The engine looks the message up in its
   * new folder; when it cannot (no Message-ID), the map is empty, the next
   * sync of that folder finds the message and the old row is pruned.
   */
  private remapTo(id: MessageId, folder: string, located: EngineLocated | null): IdRemap {
    const next = this.locatedId(folder, located);
    return next && next !== String(id) ? { [String(id)]: next } : {};
  }

  private locatedId(folder: string, located: EngineLocated | null | undefined): string | null {
    const uid = Number(located?.uid);
    const uidValidity = Number(located?.uidValidity);
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(uidValidity)) return null;
    const path = folder.toUpperCase() === 'INBOX' ? 'INBOX' : folder;
    return imapMessageId({ uidValidity, uid, folder: path });
  }

  async deleteMessage(id: MessageId, { permanent = false } = {}): Promise<IdRemap> {
    const ref = this.ref(id);
    // Where the message went, when deleting it meant moving it to Trash.
    const binned = await this.together<{ folder: string; located: EngineLocated | null }>(
      `delete\n${permanent ? 'for good' : 'to trash'}\n${ref.folder}`,
      ref.uid,
      async (uids) => {
        const folder = await this.serverPath(ref.folder);
        const trash = permanent ? null : await this.trashPath();
        if (!trash || trash === folder) {
          await this.run('imap_delete_many', { folder, uids });
          return undefined;
        }
        const moved = await this.moveMany(folder, uids, trash);
        const folders = await this.knownFolders();
        const delimiter = folders.find((f) => f.path === trash)?.delimiter || '/';
        const trashFolder = toClientPath(trash, delimiter);
        return new Map([...moved].map(([uid, located]) => [uid, { folder: trashFolder, located }]));
      },
    );
    return binned ? this.remapTo(id, binned.folder, binned.located) : {};
  }

  /**
   * Save a whole message into a folder, for a Sent copy or a draft. Answers
   * with the saved message's id when the server could be asked for it.
   */
  async appendMessage(
    folder: string,
    raw: Uint8Array,
    flags: string[] = [],
  ): Promise<string | null> {
    const saved = await this.run<EngineLocated | null>('imap_append', {
      folder: await this.serverPath(folder),
      flags,
      message: bytesToBase64(raw),
    });
    return this.locatedId(folder, saved);
  }

  /** The server's Drafts folder as the app names it, or the name given when it has none. */
  private async draftsFolder(fallback: string): Promise<string> {
    const folders = await this.knownFolders();
    const drafts =
      folders.find((f) => f.specialUse === 'drafts') ||
      folders.find((f) => /^(inbox[./])?drafts?$/i.test(toClientPath(f.path, f.delimiter || '/')));
    return drafts ? folderToRecord(drafts).path : fallback;
  }

  /**
   * Save a draft, replacing the copy saved before. IMAP cannot change a
   * message, so the new copy is saved first and the old one removed after:
   * a failure in between leaves two drafts, never none.
   */
  async saveDraft(
    raw: Uint8Array,
    { previousId = null, folder = 'Drafts' }: { previousId?: string | null; folder?: string } = {},
  ): Promise<string | null> {
    const target = await this.draftsFolder(folder);
    const flags = ['\\Draft', '\\Seen'];
    let id: string | null;
    try {
      id = await this.appendMessage(target, raw, flags);
    } catch (err) {
      // A server with no Drafts folder yet refuses the save. Make one, once.
      if (!(err instanceof MailEngineError) || err.kind !== 'server') throw err;
      const known = (await this.loadFolders()).some((f) => folderToRecord(f).path === target);
      if (known) throw err;
      await this.createFolder(target);
      id = await this.appendMessage(target, raw, flags);
    }
    const previous = previousId ? parseImapMessageId(previousId) : null;
    // Only ever out of the Drafts folder. The id comes from the draft's row
    // in the local database, and a wrong one must not cost a real message.
    if (previous && previousId !== id && previous.folder === target) {
      // Removed for good, not moved to Trash: it is an old version of this draft.
      await this.run('imap_delete', {
        folder: await this.serverPath(previous.folder),
        uid: previous.uid,
      });
    }
    return id;
  }

  /**
   * How much of the mailbox's storage is used, in bytes. Null when the
   * server has no quota extension or sets no limit.
   */
  async storage(): Promise<{ used: number; total: number } | null> {
    const answer = await this.run<{ used?: number; total?: number } | null>('imap_storage');
    const used = Number(answer?.used);
    const total = Number(answer?.total);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0) return null;
    return { used, total };
  }

  /**
   * Remove a draft for good, on behalf of a compose window. Anything outside
   * the Drafts folder is refused: the request comes from another window.
   */
  async removeDraft(id: MessageId): Promise<void> {
    const ref = this.ref(id);
    if (ref.folder !== (await this.draftsFolder('Drafts'))) {
      throw new MailEngineError('input', 'That message is not a draft');
    }
    await this.run('imap_delete', { folder: await this.serverPath(ref.folder), uid: ref.uid });
  }

  /**
   * Ask the engine to say when the inbox changes (imap-watch.ts listens).
   * Answers with the engine's handle for this account, which is how its
   * events name the account.
   */
  async watchInbox(): Promise<string> {
    await this.run('mail_watch');
    return mailHandleFor(this.account);
  }
}
