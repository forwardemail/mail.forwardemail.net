/**
 * Spam reporting helpers.
 *
 * The Report spam action forwards the offending message as a message/rfc822
 * attachment to a configurable address (abuse@forwardemail.net by default),
 * then deletes the message. These helpers are pure so they can be unit
 * tested without pulling in the store layer.
 */

export const DEFAULT_SPAM_REPORT_ADDRESS = 'abuse@forwardemail.net';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidReportAddress = (value) => EMAIL_RE.test(String(value || '').trim());

/**
 * Returns the configured report address, falling back to the default when
 * the stored value is empty or not a plausible email address.
 */
export const resolveSpamReportAddress = (raw) => {
  const value = String(raw || '').trim();
  return isValidReportAddress(value) ? value : DEFAULT_SPAM_REPORT_ADDRESS;
};

/**
 * Formats the many from/to shapes the API returns into a display string.
 */
export const formatAddressForReport = (from) => {
  if (!from) return 'Unknown sender';
  if (typeof from === 'string') return from;
  if (Array.isArray(from)) return from.map(formatAddressForReport).join(', ');
  const email = from.address || from.email || '';
  const name = from.name || from.displayName || '';
  if (name && email) return `${name} <${email}>`;
  if (email) return email;
  if (Array.isArray(from.value)) return formatAddressForReport(from.value);
  if (from.text) return from.text;
  return 'Unknown sender';
};

/**
 * Base64-encodes arbitrary text (UTF-8 safe, chunked to avoid call-stack
 * limits on large messages).
 */
export const base64EncodeUtf8 = (text) => {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

/**
 * Builds the outbox email payload for a spam report.
 *
 * When the raw RFC822 source is available it is attached as original.eml so
 * the abuse team gets full headers. Otherwise the rendered text content is
 * included inline as a degraded fallback.
 */
export const buildSpamReportEmail = ({
  reportAddress,
  fromAddress,
  message,
  eml,
  fallbackText,
}) => {
  const address = resolveSpamReportAddress(reportAddress);
  const subject = message?.subject || '(No subject)';
  const sender = formatAddressForReport(message?.from);
  const date = message?.date || message?.received_at || message?.receivedAt || '';

  const lines = [
    'This message was reported as spam from Forward Email webmail.',
    '',
    `Original sender: ${sender}`,
    `Original subject: ${subject}`,
  ];
  if (date) lines.push(`Original date: ${date}`);
  lines.push('');
  if (eml) {
    lines.push('The original message is attached as original.eml.');
  } else {
    lines.push('The original raw message was unavailable; rendered content follows.');
    lines.push('');
    lines.push('----- Original message -----');
    lines.push(String(fallbackText || '(no content available)'));
  }

  const payload = {
    from: fromAddress,
    to: [address],
    subject: `Fwd: ${subject}`,
    text: lines.join('\n'),
    // Keep spam content out of the Sent folder (client and server side).
    save_sent: false,
  };

  if (eml) {
    payload.attachments = [
      {
        filename: 'original.eml',
        contentType: 'message/rfc822',
        content: base64EncodeUtf8(eml),
        encoding: 'base64',
      },
    ];
    payload.has_attachment = true;
  }

  return payload;
};
