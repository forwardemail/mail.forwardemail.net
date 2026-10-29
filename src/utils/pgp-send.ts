/**
 * Turn a composed message into an encrypted `raw` payload for POST /v1/emails.
 *
 * The API accepts a complete RFC 5322 message in `raw` and passes it through
 * untouched, which is what makes client-side encryption possible at all: the
 * server never sees the plaintext.
 */
import {
  buildInnerMime,
  buildPgpMimeMessage,
  buildPgpSignedMessage,
  type MessageParts,
} from './pgp-mime';
import { normalizeAddress, recipientKeyCoverage, readRecipientKeys } from './pgp-recipients';
import { requestPgpEncryption, requestPgpSignature } from './sync-worker-client.js';

export interface EncryptedSendInput extends MessageParts {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}

export interface EncryptedSendResult {
  ok: boolean;
  /** The payload to POST when ok. */
  payload?: { raw: string };
  signed?: boolean;
  reason?:
    | 'no_recipients'
    | 'bcc_unsupported'
    | 'missing_keys'
    | 'encrypt_failed'
    | 'no_signing_key'
    | 'sign_failed';
  missing?: string[];
  message?: string;
}

/**
 * Every address the ciphertext must be readable by.
 *
 * Bcc is deliberately absent. For a raw message the API rebuilds the delivery
 * envelope from the To/Cc/Bcc headers it parses, and it does not accept a
 * separate envelope on /v1/emails. A Bcc recipient therefore has to be either
 * in a header (visible to everyone, so no longer blind) or undelivered.
 * buildEncryptedPayload refuses the send instead of picking one silently.
 */
export function collectRecipients(input: EncryptedSendInput): string[] {
  const all = [...(input.to || []), ...(input.cc || [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of all) {
    const email = normalizeAddress(entry);
    if (email && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

/**
 * Build the encrypted payload, or explain why it cannot be built.
 *
 * Returns rather than throws for the two user-fixable cases (no recipients, a
 * recipient with no pinned key) so the composer can name the addresses that
 * are blocking the send instead of showing a generic failure.
 */
export async function buildEncryptedPayload(
  input: EncryptedSendInput,
  { account, sign = true }: { account?: string; sign?: boolean } = {},
): Promise<EncryptedSendResult> {
  if ((input.bcc || []).some((entry) => normalizeAddress(entry))) {
    return {
      ok: false,
      reason: 'bcc_unsupported',
      message: 'Bcc is not available for encrypted messages. Move those recipients to To or Cc.',
    };
  }

  const recipients = collectRecipients(input);
  if (!recipients.length) {
    return { ok: false, reason: 'no_recipients', message: 'Add a recipient first.' };
  }

  const coverage = recipientKeyCoverage(recipients, account);
  if (coverage.missing.length) {
    return {
      ok: false,
      reason: 'missing_keys',
      missing: coverage.missing,
      message: `No public key for ${coverage.missing.join(', ')}.`,
    };
  }

  // Include the sender's own key when one is pinned for their address, so the
  // copy saved to Sent is readable. Without it the user cannot read their own
  // sent mail — the single most common complaint about client-side encryption.
  const senderEmail = normalizeAddress(input.from);
  const armoredKeys = readRecipientKeys(account)
    .filter((k) => {
      const email = normalizeAddress(k.email);
      return recipients.includes(email) || email === senderEmail;
    })
    .map((k) => k.armored);

  const inner = buildInnerMime({
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });

  let result;
  try {
    result = await requestPgpEncryption({ plaintext: inner, recipientKeys: armoredKeys, sign });
  } catch (err) {
    // An unguarded worker await here is what wedges the compose UI, so the
    // failure is turned into a value the caller can surface.
    return {
      ok: false,
      reason: 'encrypt_failed',
      message: (err as Error)?.message || 'Encryption failed',
    };
  }

  if (!result?.success || !result.armored) {
    return {
      ok: false,
      reason: 'encrypt_failed',
      message: result?.message || 'Encryption failed',
    };
  }

  const raw = buildPgpMimeMessage(result.armored, {
    from: input.from,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    replyTo: input.replyTo,
    inReplyTo: input.inReplyTo,
    references: input.references,
    messageId: input.messageId,
  });

  return { ok: true, signed: Boolean(result.signed), payload: { raw } };
}

/**
 * Build a signed but not encrypted payload (RFC 3156 multipart/signed).
 *
 * Anyone can read it; a recipient holding the sender's public key can check
 * that it came from that key and was not changed. Like an encrypted send it
 * goes out as `raw`, so Bcc is refused for the same reason.
 */
export async function buildSignedPayload(input: EncryptedSendInput): Promise<EncryptedSendResult> {
  if ((input.bcc || []).some((entry) => normalizeAddress(entry))) {
    return {
      ok: false,
      reason: 'bcc_unsupported',
      message: 'Bcc is not available for signed messages. Move those recipients to To or Cc.',
    };
  }
  if (!collectRecipients(input).length) {
    return { ok: false, reason: 'no_recipients', message: 'Add a recipient first.' };
  }

  const entity = buildInnerMime({
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });

  let result;
  try {
    result = await requestPgpSignature({
      plaintext: entity,
      from: normalizeAddress(input.from),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'sign_failed',
      message: (err as Error)?.message || 'Signing failed',
    };
  }

  if (!result?.success || !result.signature) {
    return {
      ok: false,
      reason: result?.reason === 'no_signing_key' ? 'no_signing_key' : 'sign_failed',
      message: result?.message || 'Signing failed',
    };
  }

  const raw = buildPgpSignedMessage(entity, result.signature, result.micalg, {
    from: input.from,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    replyTo: input.replyTo,
    inReplyTo: input.inReplyTo,
    references: input.references,
    messageId: input.messageId,
  });

  return { ok: true, signed: true, payload: { raw } };
}
