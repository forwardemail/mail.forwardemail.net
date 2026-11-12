import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Settings > Appearance > Message format: formatted, plain text when the
// sender included it, or plain text only. The terminal always shows text.

vi.mock('../../src/utils/remote', () => ({ Remote: { request: vi.fn(async () => ({})) } }));
vi.mock('../../src/utils/db', () => ({
  db: {
    settingsLabels: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    settings: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  },
  handleDatabaseError: vi.fn(async () => {}),
}));

import { getMessageFormat, messageViewFor, setSettingValue } from '../../src/stores/settingsStore';
import { Local } from '../../src/utils/storage';
import { apiTextPart } from '../../src/workers/sync-pure';

const terminal = (on: boolean) => {
  const g = globalThis as { __FORWARDEMAIL_TERMINAL__?: boolean };
  if (on) g.__FORWARDEMAIL_TERMINAL__ = true;
  else delete g.__FORWARDEMAIL_TERMINAL__;
};

describe('getMessageFormat', () => {
  beforeEach(() => {
    localStorage.clear();
    Local.set('email', 'me@example.com');
  });
  afterEach(() => terminal(false));

  it('is formatted by default', () => {
    expect(getMessageFormat()).toBe('html');
  });

  it('carries over the earlier "View emails as plain text" switch', async () => {
    await setSettingValue('view_plain_text', true);
    expect(getMessageFormat()).toBe('text');
    // A choice made with the new setting wins over the old switch.
    await setSettingValue('message_format', 'text-first');
    expect(getMessageFormat()).toBe('text-first');
  });

  it('ignores a stored value it does not know', () => {
    Local.set('message_format', 'markdown');
    expect(getMessageFormat()).toBe('html');
  });

  it('is always plain text in the terminal, whatever was saved', async () => {
    await setSettingValue('message_format', 'html');
    terminal(true);
    expect(getMessageFormat()).toBe('text');
  });
});

describe('messageViewFor', () => {
  it('formatted shows the HTML, plain-text part or not', () => {
    expect(messageViewFor('html', 'Hello')).toEqual({ plainText: false });
    expect(messageViewFor('html', '')).toEqual({ plainText: false });
  });

  it('plain text when available uses the sender text, else the HTML', () => {
    expect(messageViewFor('text-first', 'Hello')).toEqual({ plainText: true, text: 'Hello' });
    expect(messageViewFor('text-first', '  \n')).toEqual({ plainText: false });
    expect(messageViewFor('text-first', undefined)).toEqual({ plainText: false });
  });

  it('plain text only uses the sender text, else text made from the HTML', () => {
    expect(messageViewFor('text', 'Hello')).toEqual({ plainText: true, text: 'Hello' });
    expect(messageViewFor('text', '')).toEqual({ plainText: true });
  });
});

describe('apiTextPart', () => {
  it('is the text of a message with no HTML', () => {
    expect(apiTextPart({ text: 'Just text' })).toBe('Just text');
    expect(apiTextPart({ nodemailer: { text: 'Nested' } })).toBe('Nested');
  });

  it('is empty for an HTML message, whose API text may be made from the HTML', () => {
    expect(apiTextPart({ html: '<p>Hi</p>', text: 'Hi' })).toBe('');
    expect(apiTextPart({ nodemailer: { html: '<p>Hi</p>', text: 'Hi' } })).toBe('');
    expect(apiTextPart(null)).toBe('');
  });
});
