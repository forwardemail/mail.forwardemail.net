/**
 * Template variable substitution.
 *
 * Supported tokens: {{sender.name}}, {{sender.email}}, {{subject}}, {{date}}
 * Unknown tokens are left as-is so users can see what typed wrong.
 */

import { extractDisplayName } from './address.ts';
import { formatFriendlyDate } from './date';

export interface TemplateVarSource {
  from?: string | null;
  subject?: string | null;
  date?: string | number | Date | null;
}

function extractEmail(from: string): string {
  const match = from.match(/<\s*([^>]+)\s*>/);
  if (match) return match[1].trim();
  return from.trim();
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^(?:re|fwd?|fw)\s*:\s*/i, '').trim();
}

export function resolveTemplateVars(body: string, source: TemplateVarSource): string {
  if (!body) return '';
  const from = source.from || '';
  const senderName = from ? extractDisplayName(from) : '';
  const senderEmail = from ? extractEmail(from) : '';
  const subject = source.subject ? stripReplyPrefix(source.subject) : '';
  const date = source.date ? formatFriendlyDate(source.date) : '';

  return body
    .replaceAll('{{sender.name}}', senderName || senderEmail || '')
    .replaceAll('{{sender.email}}', senderEmail || '')
    .replaceAll('{{subject}}', subject)
    .replaceAll('{{date}}', date);
}
