/**
 * Send a composed message through an account's own outgoing server, and keep
 * the copy for Sent.
 */

import { buildMimeMessage, type BuiltMessage, type OutgoingEmail } from '../utils/mime-message';
import { MailEngineError } from './imap-engine';
import { smtpSend } from './smtp-engine';
import { smtpSettingsFor } from './smtp-account';
import { imapSettingsFor } from './imap-account';
import { getMailBackend } from './index';
import { ImapBackend } from './imap';

/** Build the message and hand it to the account's outgoing server. */
export async function sendThroughSmtp(
  account: string,
  email: OutgoingEmail,
): Promise<BuiltMessage> {
  let built: BuiltMessage;
  try {
    built = buildMimeMessage(email);
  } catch (err) {
    // Nothing a retry would change.
    throw new MailEngineError('input', (err as Error)?.message || 'The message could not be built');
  }
  try {
    await smtpSend(account, { from: built.from, recipients: built.recipients, raw: built.raw });
  } catch (err) {
    // The engine keeps addresses out of its messages; say which one here.
    if (err instanceof MailEngineError && err.kind === 'recipient') {
      const address = built.recipients[err.recipient ?? -1];
      if (address) {
        throw new MailEngineError(
          'recipient',
          `The server refused ${address}: ${err.message}`,
          err.recipient,
        );
      }
    }
    throw err;
  }
  return built;
}

// Gmail files everything sent through its server in Sent itself. A second
// copy from here would show every message twice.
const SERVER_KEEPS_SENT = /(^|\.)(gmail|googlemail)\.com$/i;

export function serverKeepsSentCopy(account: string): boolean {
  const smtp = smtpSettingsFor(account);
  return Boolean(smtp && SERVER_KEEPS_SENT.test(smtp.host));
}

/**
 * Save a sent message into the Sent folder of an account on a custom IMAP
 * server. `built` is the message as it was sent, when this app sent it.
 */
export async function appendSentCopy(
  account: string,
  folder: string,
  email: OutgoingEmail,
  built?: BuiltMessage | null,
): Promise<void> {
  if (serverKeepsSentCopy(account)) return;
  const backend = getMailBackend(account);
  if (!(backend instanceof ImapBackend)) {
    throw new Error('This account is not connected to its mail server');
  }
  const message = built ?? buildMimeMessage(email);
  await backend.appendMessage(folder, message.sentCopy, ['\\Seen']);
}

/**
 * Whether the app has to read Sent again after the outbox sent a message.
 * The Forward Email socket reports the new copy by itself. A custom IMAP
 * server is only watched for its inbox. Another account's Sent folder loads
 * fresh when the user switches to it, so only the one on screen counts.
 */
export function sentNeedsReadingAgain(
  sent: { account?: string | null; savedSent?: boolean } | null | undefined,
  activeAccount: string | null | undefined,
): boolean {
  const account = String(sent?.account || '').toLowerCase();
  if (!account || !sent?.savedSent) return false;
  if (account !== String(activeAccount || '').toLowerCase()) return false;
  return Boolean(imapSettingsFor(account));
}
