/**
 * Sending the feedback report.
 *
 * Feedback is an email to Forward Email support. A Forward Email account
 * sends it through the API. An account on a custom mail server has no
 * Forward Email credentials, so the report goes out like any other message
 * the user writes: from their address, through their own outgoing server,
 * with a copy in their Sent folder. Nothing is sent until they press Send.
 */

import { Remote } from './remote';
import { Local } from './storage';
import { queueEmail } from './outbox-service';
import { imapSettingsFor } from '../backends/imap-account';
import { MISSING_OUTGOING_SERVER, transportFor } from '../backends/smtp-account';

export const FEEDBACK_ADDRESS = 'support@forwardemail.net';

/** The signed-in address when its mail is on a custom server, else null. */
export function customServerSender(): string | null {
  const email = String(Local.get('email') || '');
  return email && imapSettingsFor(email) ? email : null;
}

/**
 * Send the report. Resolves with how it went out: 'api' once the server has
 * accepted it, 'outbox' once it is queued for the account's own server.
 */
export async function sendFeedback(subject: string, text: string): Promise<'api' | 'outbox'> {
  const custom = customServerSender();
  if (custom) {
    if (transportFor(custom) !== 'smtp') throw new Error(MISSING_OUTGOING_SERVER(custom));
    await queueEmail({ from: custom, to: [FEEDBACK_ADDRESS], subject, text, save_sent: true });
    return 'outbox';
  }

  const aliasAuth = String(Local.get('alias_auth') || '');
  const aliasEmail = aliasAuth.includes(':') ? aliasAuth.split(':')[0] : aliasAuth;
  const from = aliasEmail || Local.get('email') || 'webmail-feedback@forwardemail.net';
  await Remote.request(
    'Emails',
    { from, to: [FEEDBACK_ADDRESS], subject, text, has_attachment: false },
    { method: 'POST' },
  );
  return 'api';
}
