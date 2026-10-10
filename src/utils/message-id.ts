/**
 * Message-IDs made by the client, so the message delivered to recipients and
 * the copy filed in Sent carry the same one. Left to the server, each request
 * gets its own, and replies (which point at the delivered message) no longer
 * thread with the Sent copy in Thunderbird or any other IMAP client.
 */

const randomPart = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * A new `<random@domain>` Message-ID, using the domain of the From address
 * (which may be a full `Name <user@example.com>` header).
 */
export const createMessageId = (fromAddress: string | null | undefined): string => {
  const match = String(fromAddress ?? '').match(/@([^\s>@]+)>?\s*$/);
  const domain = match?.[1]?.toLowerCase() || 'forwardemail.net';
  return `<${randomPart()}@${domain}>`;
};

/** True when the API refused a send because it already has this exact email. */
export const isEmailAlreadyExistsError = (error: unknown): boolean =>
  /email already exists with the same message-id/i.test(
    String((error as { message?: string })?.message || ''),
  );
