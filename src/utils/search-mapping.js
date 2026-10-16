import { capIndexedBody, indexableBodyText } from './search-body-text.js';

export const mapMessageToDoc = (msg = {}, bodyText = '') => ({
  id: msg.id,
  folder: msg.folder || '',
  subject: msg.subject || '',
  from: msg.from || '',
  to: msg.to || '',
  cc: msg.cc || '',
  snippet: msg.snippet || '',
  date: msg.date || msg.dateMs || '',
  body: bodyText ? capIndexedBody(bodyText) : indexableBodyText(msg),
  labels: msg.labels || msg.label_ids || msg.labelIds || [],
});
