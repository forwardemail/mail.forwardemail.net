import { createPerfTracer } from './perf-logger.ts';
import { deduplicateMessages, groupIntoConversations } from './threading';
import { sortConversations } from './message-sort.ts';

const getMessageHeaderId = (message) =>
  message?.header_message_id || message?.message_id || message?.id || null;

const buildConversationPreviewMessages = (conv, replyIndex) => {
  const base = Array.isArray(conv?.messages) ? conv.messages.slice() : [];
  if (!base.length || !(replyIndex instanceof Map)) return base;

  const seen = new Set();
  const combined = [];
  base.forEach((msg) => {
    const id = getMessageHeaderId(msg);
    if (id) seen.add(id);
    combined.push(msg);
  });

  base.forEach((msg) => {
    const id = getMessageHeaderId(msg);
    if (!id) return;
    const replies = replyIndex.get(id);
    if (!Array.isArray(replies)) return;
    replies.forEach((reply) => {
      const replyId = getMessageHeaderId(reply);
      if (!replyId || seen.has(replyId)) return;
      seen.add(replyId);
      combined.push(reply);
    });
  });

  combined.sort((a, b) => {
    const aDate = a?.date ?? a?.dateMs ?? 0;
    const bDate = b?.date ?? b?.dateMs ?? 0;
    return aDate - bDate;
  });
  return combined;
};

const normalizeMessages = (messages) => (Array.isArray(messages) ? messages : []);

export const createConversationGrouper = () => {
  let conversationCache = new Map();

  return (messages, sortOrder, replyTargets, replyMessageIndex) => {
    const list = normalizeMessages(messages);
    const tracer = createPerfTracer('threading.compute', {
      count: list?.length || 0,
      sort: sortOrder,
    });
    const prevCache = conversationCache;
    const nextCache = new Map();
    const targetSet = replyTargets instanceof Set ? replyTargets : new Set();
    const replyIndex = replyMessageIndex instanceof Map ? replyMessageIndex : new Map();

    tracer.stage('group_start');
    const grouped = groupIntoConversations(list);
    tracer.stage('group_end', { conversations: grouped.length });

    const stable = grouped.map((conv) => {
      conv.messages = deduplicateMessages(conv.messages);
      conv.is_unread = conv.hasUnread;
      if (targetSet.size) {
        conv.hasReply = conv.messages.some((message) =>
          targetSet.has(message?.header_message_id || message?.message_id || message?.id),
        );
      }
      const previewMessages = buildConversationPreviewMessages(conv, replyIndex);
      conv.previewMessages = previewMessages;
      conv.messageCount = previewMessages.length || conv.messages.length;

      const existing = prevCache.get(conv.id);
      const merged = existing ? { ...existing, ...conv } : conv;
      nextCache.set(conv.id, merged);
      return merged;
    });

    conversationCache = nextCache;
    tracer.end({ conversations: stable.length });
    return sortConversations(stable, sortOrder);
  };
};
