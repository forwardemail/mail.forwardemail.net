/**
 * The mail backend seam (docs/custom-imap-smtp-architecture.md).
 *
 * Every account talks to its mail server through one of these. Today the only
 * one is the Forward Email REST API. The interface grows one group of calls at
 * a time, as each group of call sites moves off Remote and raw fetch: message
 * changes are here now, and lists, reading, sending and live updates follow.
 */

export type BackendKind = 'forwardemail' | 'imap' | 'demo';

/**
 * What a backend can do. The UI asks these questions and never asks which
 * kind of backend an account has.
 */
export interface BackendCapabilities {
  calendar: boolean;
  contacts: boolean;
  filters: boolean;
  /** The server holds a message until its send time. */
  scheduledSend: boolean;
  /** The server sends push notifications for new mail. */
  serverPush: boolean;
  /** The server files a copy in Sent on its own after a send. */
  serverSavesSent: boolean;
  /** Settings and the label list are saved on the server. */
  settingsSync: boolean;
  /** Where a label's name and color live: 'keywords' means on this device. */
  labels: 'server' | 'keywords';
  serverSearch: boolean;
  /** 'arrival' means the server can only list newest first. */
  serverSort: 'any' | 'arrival';
  /** Who can send queued changes: the service worker too, or only an open app. */
  offlineReplay: 'service-worker' | 'foreground';
  /** The server may say how much storage is used and allowed. */
  quota: boolean;
  /** More storage is bought from Forward Email, so the meter links to billing. */
  storagePlan: boolean;
  /**
   * How many messages of a selection the store changes at a time. Each one
   * is its own request to the Forward Email API, so a few run side by side.
   * An IMAP server takes a whole selection in one command, so the store
   * hands over as many as that command may name.
   */
  changesAtOnce: number;
}

/**
 * A change to a message's flags.
 *
 * `add` and `remove` are what changed. `flags` is the whole list this client
 * has after the change, for servers that can only replace the list. Leave it
 * out when the client does not know the message's flags: sending a guessed
 * list would replace every flag the message has.
 */
export interface FlagChange {
  add?: string[];
  remove?: string[];
  flags?: string[] | null;
}

/**
 * A change to a message's labels: the list after the change and, when known,
 * the list before it, so only the difference is applied on the server.
 */
export interface LabelChange {
  labels: string[];
  previous?: string[] | null;
}

/**
 * Old message id to new message id. Empty when ids do not change on a move
 * (the Forward Email API). An IMAP move gives the message a new id.
 */
export type IdRemap = Record<string, string>;

/**
 * The id the server knows a message by. The API has returned both strings and
 * numbers over time and cached rows hold either (see getMessageApiId).
 */
export type MessageId = string | number;

export interface MailMutations {
  changeFlags(id: MessageId, change: FlagChange): Promise<void>;
  changeLabels(id: MessageId, change: LabelChange): Promise<void>;
  moveMessage(id: MessageId, destFolder: string): Promise<IdRemap>;
  /**
   * Deleting to Trash is a move on a server where that changes the id, so it
   * answers like one. Nothing, or an empty map, when the id is unchanged.
   */
  deleteMessage(id: MessageId, opts?: { permanent?: boolean }): Promise<IdRemap | void>;
}

/**
 * A message or folder as the server sent it, before the client normalizes it.
 * The fields differ by server and by API version, so they are not typed here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerRecord = Record<string, any>;

/** One page of a folder's message list. */
export interface MessageListPage {
  rows: ServerRecord[];
  /** How many messages the folder holds, when the server said. */
  total: number | null;
  /** The server answered that nothing changed since the token in the query. */
  notModified: boolean;
}

/**
 * Whether a message is still on the server.
 *
 * 'rejected' means the credentials were refused, so nothing was learned about
 * the message. 'unknown' is any other failed answer. A found message whose
 * answer could not be read has a null detail.
 */
export type MessageCheck =
  | { state: 'found'; detail: ServerRecord | null }
  | { state: 'gone' }
  | { state: 'rejected' }
  | { state: 'unknown' };

/**
 * Reading mail. The sync worker is the caller.
 *
 * The list query is still the Forward Email API's own (folder, page, limit,
 * since_modseq and so on). It becomes a folder and an opaque cursor when a
 * second kind of server needs it.
 */
export interface MailReads {
  listFolders(): Promise<ServerRecord[]>;
  listMessages(query: Record<string, unknown>): Promise<MessageListPage>;
  /**
   * One message as the server holds it. `raw` asks for the original source as
   * well. A failed request throws with the server's `status`.
   */
  getMessage(id: MessageId, opts?: { folder?: string; raw?: boolean }): Promise<ServerRecord>;
  checkMessage(id: MessageId): Promise<MessageCheck>;
}

/**
 * Changes to the folder list. A folder is named by the id on its row, which
 * for some servers is its path.
 */
export interface FolderOps {
  listFolders(): Promise<ServerRecord[]>;
  /** One folder with the details the list leaves out, such as its flags. */
  getFolder(id: MessageId): Promise<ServerRecord>;
  createFolder(path: string): Promise<void>;
  /** The folders inside it move with it. */
  renameFolder(id: MessageId, newPath: string): Promise<void>;
  deleteFolder(id: MessageId): Promise<void>;
}

export interface ListRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
  /** Name for the request in performance traces. */
  perfLabel?: string;
}

export interface MessageRequestOptions {
  folder?: string;
  /** The message's source as well as (or, for some servers, instead of) the parsed parts. */
  raw?: boolean;
  /** The source as a downloadable .eml. */
  eml?: boolean;
  /** 'text' for the source as plain text, not wrapped in an answer. */
  responseAs?: 'text';
  signal?: AbortSignal;
}

export interface MailBackend extends MailMutations, FolderOps {
  /**
   * One message, as the server answered. Like requestMessageList, the callers
   * on the main thread read the answer's shape themselves.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestMessage(id: MessageId, opts?: MessageRequestOptions): Promise<any>;

  /**
   * A page of messages, as the server answered. The callers on the main
   * thread still read the answer's shape themselves (a list, a wrapped list,
   * or nothing for "no change"), so it is passed through untouched. It joins
   * MailReads.listMessages once those callers share one reader.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestMessageList(query: object, opts?: ListRequestOptions): Promise<any>;

  readonly kind: BackendKind;
  /** The account this backend acts as. It never acts as another one. */
  readonly account: string;
  readonly capabilities: BackendCapabilities;
  /**
   * False while the account's credentials cannot be read (signed out, or the
   * app is locked). Calls made then throw BackendNotReadyError.
   */
  isReady(): boolean;
  /**
   * What goes on a queued change so the service worker can send it while the
   * app is closed, or null when this account's changes are only ever sent by
   * the app itself. The mutation queue copies it onto the record as it is.
   */
  backgroundReplay(): BackgroundReplay | null;
}

/** The REST endpoint and credentials a queued change is replayed with. */
export interface BackgroundReplay {
  apiBase: string;
  authHeader: string;
}

/** The account's credentials are not available right now. */
export class BackendNotReadyError extends Error {
  readonly code = 'BACKEND_NOT_READY';
  constructor(account: string) {
    super(`No credentials available for ${account || 'this account'}`);
    this.name = 'BackendNotReadyError';
  }
}
