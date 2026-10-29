/**
 * Senders whose remote images load without asking, per account.
 *
 * Remote images are blocked by default because loading one tells the sender
 * when the message was read and from what IP address. For a newsletter the
 * user reads every week that is a cost they may choose to accept, once, for
 * that sender, instead of pressing Load Images on every issue.
 *
 * The From address is whatever the sender wrote, so trusting it only decides
 * what the reader fetches. It is never used to decide anything about safety.
 * Tracking pixels stay blocked for trusted senders too.
 */
import { Local } from './storage.js';
import { extractEmail } from './address';

const activeAccount = (): string => Local.get('email') || 'default';

const storageKey = (account?: string) => `remote_images_trusted_${account || activeAccount()}`;

export function readTrustedImageSenders(account?: string): string[] {
  try {
    const parsed = JSON.parse(Local.get(storageKey(account)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value) => typeof value === 'string' && value.includes('@'));
  } catch {
    return [];
  }
}

function writeTrustedImageSenders(senders: string[], account?: string): void {
  Local.set(storageKey(account), JSON.stringify(senders));
}

function normalizeSender(from: unknown): string {
  return extractEmail(from as Parameters<typeof extractEmail>[0])
    .trim()
    .toLowerCase();
}

export function isTrustedImageSender(from: unknown, account?: string): boolean {
  const address = normalizeSender(from);
  if (!address) return false;
  return readTrustedImageSenders(account).includes(address);
}

export function trustImageSender(from: unknown, account?: string): string[] {
  const address = normalizeSender(from);
  const current = readTrustedImageSenders(account);
  if (!address || !address.includes('@') || current.includes(address)) return current;
  const next = [...current, address].sort();
  writeTrustedImageSenders(next, account);
  return next;
}

export function untrustImageSender(from: unknown, account?: string): string[] {
  const address = normalizeSender(from);
  const next = readTrustedImageSenders(account).filter((value) => value !== address);
  writeTrustedImageSenders(next, account);
  return next;
}
