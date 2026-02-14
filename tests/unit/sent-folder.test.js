import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn(() => ''),
}));

import { resolveSentFolder } from '../../src/utils/sent-folder.js';
import { getEffectiveSettingValue } from '../../src/stores/settingsStore';

describe('resolveSentFolder', () => {
  it('returns user preference when set', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValueOnce('My Sent');
    expect(resolveSentFolder()).toBe('My Sent');
  });

  it('finds folder with specialUse \\Sent flag', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    const folders = [
      { path: 'INBOX', name: 'Inbox' },
      { path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' },
    ];
    expect(resolveSentFolder(null, folders)).toBe('[Gmail]/Sent Mail');
  });

  it('prefers "Sent Mail" over "Sent" by name', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    const folders = [
      { path: 'Sent', name: 'Sent' },
      { path: 'Sent Mail', name: 'Sent Mail' },
    ];
    expect(resolveSentFolder(null, folders)).toBe('Sent Mail');
  });

  it('prefers "Sent Items" over "Sent"', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    const folders = [
      { path: 'Sent', name: 'Sent' },
      { path: 'Sent Items', name: 'Sent Items' },
    ];
    expect(resolveSentFolder(null, folders)).toBe('Sent Items');
  });

  it('falls back to "Sent" path match', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    const folders = [
      { path: 'INBOX', name: 'Inbox' },
      { path: 'Sent', name: 'Sent' },
    ];
    expect(resolveSentFolder(null, folders)).toBe('Sent');
  });

  it('returns "Sent" as last resort when no folders match', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    const folders = [
      { path: 'INBOX', name: 'Inbox' },
      { path: 'Drafts', name: 'Drafts' },
    ];
    expect(resolveSentFolder(null, folders)).toBe('Sent');
  });

  it('returns "Sent" when no folder list provided', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    expect(resolveSentFolder()).toBe('Sent');
  });

  it('is case-insensitive for name matching', () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('');
    const folders = [{ path: 'sent', name: 'sent' }];
    expect(resolveSentFolder(null, folders)).toBe('sent');
  });
});
