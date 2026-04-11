/**
 * Gmail-style email threading utilities
 *
 * This module implements conversation grouping similar to Gmail:
 * 1. Primary grouping by Message-ID, In-Reply-To, and References headers
 * 2. Deduplication by Message-ID
 * 3. Cross-folder threading (Inbox + Sent + Archive)
 */
import { extractEmail } from './address.js';
import type { Message } from '$types';

type MessageLike = Partial<Message> & {
  nodemailer?: {
    headers?: Record<string, string>;
    Headers?: Record<string, string>;
  };
  [key: string]: unknown;
};

export interface ConversationResult {
  id: string;
  messages: MessageLike[];
  subject: string;
  displaySubject: string;
  participants: string[];
  labels: string[];
  hasUnread: boolean;
  hasAttachment: boolean;
  hasReply: boolean;
  latestDate: Date | null;
  latestUid: number | null;
  messageCount: number;
  snippet: string;
  latestFrom: string;
}

interface ConversationAccumulator {
  id: string;
  messages: MessageLike[];
  subject: string;
  participants: Set<string>;
  labelsSet: Set<string>;
  hasUnread: boolean;
  hasAttachment: boolean;
  hasReply: boolean;
  latestDate: Date | null;
  latestUid: number | null;
  messageCount: number;
}

export interface TreeNode {
  message: MessageLike;
  children: TreeNode[];
  parent: TreeNode | null;
}

export interface ConversationTree {
  root: TreeNode[];
  messageMap: Map<string, TreeNode>;
}

export interface FlattenedMessage extends MessageLike {
  depth: number;
  hasChildren: boolean;
}

/**
 * Normalize a subject line for comparison
 * Removes Re:, Fwd:, etc. prefixes and extra whitespace
 */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject || typeof subject !== 'string') return '';

  let normalized = subject.trim();

  // Remove common reply/forward prefixes (case insensitive, localized)
  const prefixes = [
    'Re:',
    'RE:',
    're:',
    'Fwd:',
    'FW:',
    'Fw:',
    'Forward:',
    'FWD:',
    'fwd:',
    'AW:',
    'Aw:',
    'aw:', // German
    'SV:',
    'Sv:',
    'sv:', // Swedish
    'VS:',
    'Vs:',
    'vs:', // Norwegian
    'R:',
    'RIF:',
    'Rif:', // Italian
    'Enc:',
    'ENC:', // Spanish
    'Antw:',
    'ANTW:', // Dutch
    'TR:',
    'Tr:',
    'tr:', // Turkish
    'Ref:',
    'REF:',
    'ref:', // Reference
  ];

  let changed = true;
  while (changed) {
    changed = false;
    const before = normalized;

    for (const prefix of prefixes) {
      // Handle multiple prefixes like "Re: Re: Fwd:"
      const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
      normalized = normalized.replace(regex, '');
    }

    // Remove brackets like [External], [SPAM], etc.
    normalized = normalized.replace(/^\[[^\]]*\]\s*/g, '');

    // Trim whitespace
    normalized = normalized.trim();

    if (normalized !== before) {
      changed = true;
    }
  }

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Parse References header into array of Message-IDs
 */
export function parseReferences(references: string | string[] | null | undefined): string[] {
  if (!references) return [];

  if (Array.isArray(references)) return references;

  if (typeof references !== 'string') return [];

  // References format: "<msg1@domain> <msg2@domain> <msg3@domain>"
  const matches = references.match(/<[^>]+>/g);
  if (!matches) return [];

  return matches.map((ref) => ref.trim());
}

function getHeaderValue(message: MessageLike | null | undefined, key: string): string | null {
  if (!message || !key) return null;
  const headers = message.nodemailer?.headers || message.nodemailer?.Headers;
  if (!headers) return null;
  const lowerKey = String(key).toLowerCase();
  return (
    headers[lowerKey] ||
    headers[lowerKey.toUpperCase()] ||
    headers[key] ||
    headers[key.toLowerCase()] ||
    null
  );
}

function getMessageId(message: MessageLike | null | undefined): string | null {
  if (!message) return null;
  return (
    (message.message_id as string) ||
    (message.messageId as string) ||
    (message.header_message_id as string) ||
    (message.headerMessageId as string) ||
    (message['Message-ID'] as string) ||
    getHeaderValue(message, 'message-id') ||
    (message.id as string) ||
    null
  );
}

function getInReplyTo(message: MessageLike | null | undefined): string | null {
  if (!message) return null;
  return (
    (message.in_reply_to as string) ||
    (message.inReplyTo as string) ||
    (message['In-Reply-To'] as string) ||
    getHeaderValue(message, 'in-reply-to') ||
    null
  );
}

function getReferences(message: MessageLike | null | undefined): string[] {
  if (!message) return [];
  return parseReferences(
    (message.references as string) ||
      (message.References as string) ||
      getHeaderValue(message, 'references'),
  );
}

/**
 * Simple string hash function for generating conversation IDs
 */
function simpleHash(str: string | null | undefined): string {
  if (!str) return '0';

  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return Math.abs(hash).toString(36);
}

/**
 * Generate a stable conversation ID from message headers
 */
export function getConversationId(message: MessageLike): string {
  const messageId = getMessageId(message);
  const inReplyTo = getInReplyTo(message);
  const references = getReferences(message);

  // 1. Use root of References chain (first/oldest message)
  if (references.length > 0) {
    return simpleHash(references[0]);
  }

  // 2. Use In-Reply-To
  if (inReplyTo) {
    return simpleHash(inReplyTo);
  }

  // 3. Use Message-ID itself (new conversation)
  if (messageId) {
    return simpleHash(messageId);
  }

  // Last resort: use message UID
  return simpleHash(
    (message.id as string) ||
      (message.uid as string) ||
      (message.Uid as string) ||
      String(Date.now()),
  );
}

const normalizeUidValue = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeSortDate = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value < 10000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const getMessageUidValue = (message: MessageLike | null | undefined): number | null =>
  normalizeUidValue(
    message?.uid ??
      message?.Uid ??
      message?.id ??
      message?.message_id ??
      message?.messageId ??
      null,
  );

const getMessageDateValue = (message: MessageLike | null | undefined): number =>
  normalizeSortDate(message?.dateMs ?? message?.date ?? message?.Date ?? null);

/**
 * Group messages into conversations (two-pass algorithm for better threading)
 */
export function groupIntoConversations(messages: MessageLike[]): ConversationResult[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const messageIdToConvId = new Map<string, string>();
  const conversationMap = new Map<string, ConversationAccumulator>();

  const hasAnsweredFlag = (message: MessageLike | null | undefined): boolean => {
    if (!message) return false;
    if (message.is_answered || message.is_replied || message.isAnswered || message.isReplied) {
      return true;
    }
    const rawFlags = (message.flags as string[]) || (message.Flags as string[]) || [];
    const flags = Array.isArray(rawFlags) ? rawFlags : [];
    return flags.some((flag) => String(flag).toLowerCase() === '\\answered');
  };

  // First pass: assign conversation IDs and build lookup map
  for (const message of messages) {
    const messageId = getMessageId(message);
    const references = getReferences(message);
    const inReplyTo = getInReplyTo(message);

    let convId: string;

    // 1. Check if we're replying to a known message
    if (inReplyTo && messageIdToConvId.has(inReplyTo)) {
      convId = messageIdToConvId.get(inReplyTo)!;
    }
    // 2. Check references chain
    else if (references.length > 0) {
      const knownRef = references.find((ref) => messageIdToConvId.has(ref));
      if (knownRef) {
        convId = messageIdToConvId.get(knownRef)!;
      } else {
        convId = simpleHash(references[0]);
      }
    }
    // 3. Use In-Reply-To hash
    else if (inReplyTo) {
      convId = simpleHash(inReplyTo);
    } else {
      convId = simpleHash(
        messageId || (message.id as string) || (message.uid as string) || String(Date.now()),
      );
    }

    if (messageId) {
      messageIdToConvId.set(messageId, convId);
    }

    if (!conversationMap.has(convId)) {
      conversationMap.set(convId, {
        id: convId,
        messages: [],
        subject: normalizeSubject((message.subject as string) || (message.Subject as string) || ''),
        participants: new Set(),
        labelsSet: new Set(),
        hasUnread: false,
        hasAttachment: false,
        hasReply: false,
        latestDate: null,
        latestUid: null,
        messageCount: 0,
      });
    }

    const conversation = conversationMap.get(convId)!;
    conversation.messages.push(message);
    conversation.messageCount++;

    const rawLabels =
      (message.labels as string[]) ||
      (message.label_ids as string[]) ||
      (message.labelIds as string[]) ||
      [];
    const labels = Array.isArray(rawLabels)
      ? rawLabels
      : typeof rawLabels === 'string'
        ? rawLabels.split(',').map((l: string) => l.trim())
        : [];
    labels.filter(Boolean).forEach((lbl) => conversation.labelsSet.add(String(lbl)));

    const from = extractEmail((message.from as string) || (message.From as string));
    if (from) conversation.participants.add(from);

    if (message.is_unread) {
      conversation.hasUnread = true;
    }

    // Only use the \Answered IMAP flag (set on messages the user replied to).
    // Generic In-Reply-To/References headers fire for every reply in a thread
    // (including from other people), so we don't use those here.
    // The conversation-grouper also augments hasReply via the replyTargets
    // index built from Sent folder messages.
    if (hasAnsweredFlag(message)) {
      conversation.hasReply = true;
    }

    if (
      message.has_attachment === true ||
      message.has_attachment === 1 ||
      message.has_attachment === '1' ||
      (Array.isArray(message.attachments) && message.attachments.length > 0)
    ) {
      conversation.hasAttachment = true;
    }

    const messageDate = new Date(
      (message.dateMs as number) || (message.date as number) || (message.Date as number) || 0,
    );
    if (!conversation.latestDate || messageDate > conversation.latestDate) {
      conversation.latestDate = messageDate;
    }

    const messageUid = getMessageUidValue(message);
    if (
      messageUid != null &&
      (conversation.latestUid == null || messageUid > conversation.latestUid)
    ) {
      conversation.latestUid = messageUid;
    }
  }

  // Second pass: sort messages within each conversation
  const results: ConversationResult[] = [];

  for (const conversation of conversationMap.values()) {
    conversation.messages.sort((a, b) => {
      const dateA = getMessageDateValue(a);
      const dateB = getMessageDateValue(b);
      if (dateA !== dateB) return dateA - dateB;
      const aUid = getMessageUidValue(a);
      const bUid = getMessageUidValue(b);
      if (aUid != null && bUid != null) return aUid - bUid;
      if (aUid != null) return -1;
      if (bUid != null) return 1;
      return 0;
    });

    const messageWithSubject = conversation.messages.find((m) => m.subject || m.Subject);
    const displaySubject = messageWithSubject
      ? (messageWithSubject.subject as string) || (messageWithSubject.Subject as string)
      : '(No subject)';

    const latestMessage = conversation.messages[conversation.messages.length - 1];
    const snippet = (latestMessage.snippet as string) || (latestMessage.preview as string) || '';
    const fromValue = (latestMessage.from as string) || (latestMessage.From as string) || '';
    const latestFrom = fromValue && fromValue.trim() ? fromValue : '';

    results.push({
      id: conversation.id,
      messages: conversation.messages,
      subject: conversation.subject,
      displaySubject,
      participants: Array.from(conversation.participants),
      labels: Array.from(conversation.labelsSet),
      hasUnread: conversation.hasUnread,
      hasAttachment: conversation.hasAttachment,
      hasReply: conversation.hasReply,
      latestDate: conversation.latestDate,
      latestUid: conversation.latestUid,
      messageCount: conversation.messageCount,
      snippet,
      latestFrom,
    });
  }

  // Sort conversations by latest date
  results.sort((a, b) => {
    const aDate = normalizeSortDate(a.latestDate);
    const bDate = normalizeSortDate(b.latestDate);
    if (aDate !== bDate) return bDate - aDate;
    const aUid = normalizeUidValue(a.latestUid);
    const bUid = normalizeUidValue(b.latestUid);
    if (aUid != null && bUid != null) return bUid - aUid;
    if (aUid != null) return -1;
    if (bUid != null) return 1;
    return 0;
  });

  return results;
}

/**
 * Deduplicate messages by unique server ID (uid/id).
 * Falls back to Message-ID + folder to avoid collapsing forwarded emails
 * that share the same Message-ID header but are distinct messages.
 */
export function deduplicateMessages(messages: MessageLike[]): MessageLike[] {
  if (!Array.isArray(messages)) return [];

  const seen = new Set<string>();
  const unique: MessageLike[] = [];

  for (const message of messages) {
    // Prefer server-assigned unique ID — distinct per message per folder
    const uid = message?.uid ?? message?.Uid ?? message?.id;
    const folder = message?.folder ?? message?.Folder ?? '';
    let key: string | null = null;

    if (uid != null) {
      key = `${folder}:${uid}`;
    } else {
      // Fallback: Message-ID + folder so forwarded copies aren't collapsed
      const messageId = getMessageId(message);
      if (messageId) {
        key = `${folder}:${messageId}`;
      }
    }

    if (!key) {
      unique.push(message);
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(message);
  }

  return unique;
}

/**
 * Build a conversation tree structure (for nested display)
 */
export function buildConversationTree(messages: MessageLike[]): ConversationTree {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { root: [], messageMap: new Map() };
  }

  const messageMap = new Map<string, TreeNode>();
  const root: TreeNode[] = [];

  // First pass: create nodes
  for (const message of messages) {
    const node: TreeNode = {
      message,
      children: [],
      parent: null,
    };

    const messageId = getMessageId(message);
    if (messageId) {
      messageMap.set(messageId, node);
    }
  }

  // Second pass: build tree
  for (const message of messages) {
    const messageId = getMessageId(message);
    if (!messageId) continue;

    const node = messageMap.get(messageId);
    if (!node) continue;

    const inReplyTo = getInReplyTo(message);

    if (inReplyTo) {
      const parentNode = messageMap.get(inReplyTo);
      if (parentNode) {
        node.parent = parentNode;
        parentNode.children.push(node);
      } else {
        root.push(node);
      }
    } else {
      root.push(node);
    }
  }

  return { root, messageMap };
}

/**
 * Flatten a conversation tree for display
 */
export function flattenConversationTree(tree: ConversationTree): FlattenedMessage[] {
  const flattened: FlattenedMessage[] = [];

  function traverse(node: TreeNode, depth: number = 0): void {
    flattened.push({
      ...node.message,
      depth,
      hasChildren: node.children.length > 0,
    });

    for (const child of node.children) {
      traverse(child, depth + 1);
    }
  }

  for (const rootNode of tree.root) {
    traverse(rootNode);
  }

  return flattened;
}
