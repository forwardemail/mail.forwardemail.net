/**
 * Worker message type definitions
 */

// Sync Worker Messages
export type SyncWorkerMessageType =
  | 'init'
  | 'sync'
  | 'metadata'
  | 'bodies'
  | 'fetchMessage'
  | 'parseMessage'
  | 'decryptPgp'
  | 'unlockPgpKey'
  | 'refreshPgpKeys'
  | 'terminate';

export interface SyncWorkerMessage {
  id: number;
  type: SyncWorkerMessageType;
  account?: string;
  folder?: string;
  pageSize?: number;
  messageId?: string;
  raw?: string | ArrayBuffer;
  passphrase?: string;
  keys?: string[];
}

export interface SyncWorkerResponse {
  id: number;
  ok: boolean;
  type?: string;
  result?: unknown;
  error?: string;
  progress?: SyncProgress;
}

export interface SyncProgress {
  phase: 'metadata' | 'bodies' | 'complete';
  current: number;
  total: number;
  folder?: string;
}

// Database Worker Messages
export type DbWorkerAction =
  | 'init'
  | 'get'
  | 'put'
  | 'delete'
  | 'bulkGet'
  | 'bulkPut'
  | 'bulkDelete'
  | 'queryEquals'
  | 'queryEqualsDelete'
  | 'queryRange'
  | 'count'
  | 'clear'
  | 'transaction'
  | 'getInfo'
  | 'reset'
  | 'clearCache';

export interface DbWorkerMessage {
  id: number;
  action: DbWorkerAction;
  table?: string;
  payload?: DbWorkerPayload;
}

export interface DbWorkerPayload {
  key?: string | string[] | number | number[];
  keys?: (string | string[] | number | number[])[];
  record?: Record<string, unknown>;
  records?: Record<string, unknown>[];
  index?: string;
  value?: unknown;
  range?: {
    lower?: unknown;
    upper?: unknown;
    lowerOpen?: boolean;
    upperOpen?: boolean;
  };
}

export interface DbWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// Search Worker Messages
export type SearchWorkerMessageType =
  'init' | 'index' | 'search' | 'remove' | 'clear' | 'getStats' | 'terminate';

export interface SearchWorkerMessage {
  id: number;
  type: SearchWorkerMessageType;
  documents?: SearchDocument[];
  query?: string;
  options?: SearchOptions;
  ids?: string[];
}

export interface SearchDocument {
  id: string;
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  snippet?: string;
  date?: number;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  fields?: string[];
  boost?: Record<string, number>;
  fuzzy?: boolean | number;
}

export interface SearchWorkerResponse {
  id: number;
  ok: boolean;
  results?: SearchResult[];
  stats?: SearchStats;
  error?: string;
}

export interface SearchResult {
  id: string;
  score: number;
  matches?: Record<string, string[]>;
}

export interface SearchStats {
  documentCount: number;
  indexSize: number;
  lastUpdated: number;
}
