import { describe, it, expect } from 'vitest';
import { detectJunkFolder } from '../../src/utils/junk-folder';

// The folder list a new Forward Email account starts with, in the order the
// folder list sorts it (both junk folders rank the same, so Junk comes first).
const forwardEmailDefaults = () => [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { path: 'Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' },
  { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
  { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
  { path: 'Spam', name: 'Spam', specialUse: '\\Junk' },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
];

describe('detectJunkFolder', () => {
  it('prefers Spam when the account has both Spam and Junk flagged as \\Junk', () => {
    expect(detectJunkFolder(forwardEmailDefaults())).toBe('Spam');
  });

  it('uses Junk when the user deleted Spam', () => {
    const list = forwardEmailDefaults().filter((f) => f.path !== 'Spam');
    expect(detectJunkFolder(list)).toBe('Junk');
  });

  it('uses whatever folder the server flags as \\Junk, whatever it is called', () => {
    const list = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Junk E-mail', name: 'Junk E-mail', specialUse: '\\Junk' },
      { path: 'Spam', name: 'Spam' },
    ];
    expect(detectJunkFolder(list)).toBe('Junk E-mail');
  });

  it('falls back to the name when no folder carries a special-use flag', () => {
    expect(
      detectJunkFolder([
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Junk', name: 'Junk' },
        { path: 'Spam', name: 'spam' },
      ]),
    ).toBe('Spam');
    expect(detectJunkFolder([{ path: 'INBOX' }, { path: 'Junk' }])).toBe('Junk');
  });

  it('does not pick a user folder that only contains the word spam', () => {
    expect(detectJunkFolder([{ path: 'INBOX' }, { path: 'Spam reports' }])).toBeNull();
  });

  it('returns null for an empty or missing list', () => {
    expect(detectJunkFolder([])).toBeNull();
    expect(detectJunkFolder(null)).toBeNull();
  });
});
