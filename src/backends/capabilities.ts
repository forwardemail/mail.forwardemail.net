/**
 * What an account's server can do, without building its backend.
 *
 * The UI asks this to decide what to show: an account on a custom IMAP server
 * has mail and nothing else, so its Contacts, Calendar and Filters would only
 * ever show an error.
 */

import { imapSettingsFor } from './imap-account';
import type { BackendCapabilities } from './types';

export const FORWARD_EMAIL_CAPABILITIES: Readonly<BackendCapabilities> = Object.freeze({
  calendar: true,
  contacts: true,
  filters: true,
  scheduledSend: true,
  serverPush: true,
  serverSavesSent: true,
  settingsSync: true,
  labels: 'server',
  serverSearch: true,
  serverSort: 'any',
  offlineReplay: 'service-worker',
  quota: true,
  storagePlan: true,
  changesAtOnce: 8,
});

export const IMAP_CAPABILITIES: Readonly<BackendCapabilities> = Object.freeze({
  calendar: false,
  contacts: false,
  filters: false,
  scheduledSend: false,
  serverPush: false,
  serverSavesSent: false,
  settingsSync: false,
  labels: 'keywords',
  serverSearch: false,
  serverSort: 'arrival',
  offlineReplay: 'foreground',
  // Where the server has the QUOTA extension and sets a limit (imap_storage).
  quota: true,
  storagePlan: false,
  changesAtOnce: 200,
});

export function capabilitiesFor(account?: string | null): Readonly<BackendCapabilities> {
  return imapSettingsFor(account) ? IMAP_CAPABILITIES : FORWARD_EMAIL_CAPABILITIES;
}
