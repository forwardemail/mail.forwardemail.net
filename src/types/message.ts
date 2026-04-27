/**
 * Message-related type definitions
 */

export interface Message {
  id: string;
  account: string;
  folder: string;
  folder_id?: string | null;
  date: number;
  dateMs: number;
  from: string;
  to?: string;
  cc?: string;
  bcc?: string;
  reply_to?: string | null;
  subject: string;
  snippet: string;
  flags: string[];
  is_unread: boolean;
  is_unread_index: number;
  is_starred: boolean;
  is_flagged: boolean;
  has_attachment: boolean;
  modseq?: string | null;
  message_id: string;
  root_id?: string | null;
  thread_id?: string | null;
  uid?: number | null;
  header_message_id?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
  labels: string[];
  bodyIndexed: boolean;
  updatedAt: number;
}

export interface MessageBody {
  id: string;
  account: string;
  body: string;
  rawBody?: string;
  textContent?: string;
  attachments?: Attachment[];
  meta?: MessageMeta;
  cachedAt: number;
}

export interface MessageMeta {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  date?: string | number;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}

export interface Attachment {
  filename?: string;
  contentType?: string;
  mimeType?: string;
  size?: number;
  disposition?: 'inline' | 'attachment';
  cid?: string;
  contentId?: string;
  content?: ArrayBuffer | Uint8Array | string;
  dataUrl?: string;
  partId?: string;
}

export interface ParsedEmail {
  body: string;
  rawBody?: string;
  textContent?: string;
  attachments: Attachment[];
  headers?: Record<string, string>;
}

export interface ImageStatus {
  hasBlockedImages: boolean;
  trackingPixelCount: number;
  blockedRemoteImageCount: number;
}

export interface PgpStatus {
  locked: boolean;
  keyId?: string;
}

export interface Conversation {
  id: string;
  messages: Message[];
  threadId?: string;
  subject?: string;
  participants?: string[];
  latestDate: number;
  unreadCount: number;
  hasAttachment: boolean;
}

export type SortOrder =
  | 'date-desc'
  | 'date-asc'
  | 'from-asc'
  | 'from-desc'
  | 'subject-asc'
  | 'subject-desc';
