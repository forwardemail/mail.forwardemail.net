import { describe, expect, it } from 'vitest';
import {
  isValidDexieKeyFallback,
  coerceLabelList,
  hasFromValue,
  getMessageKey,
  mergeMessagePages,
} from '../../src/stores/mailbox-store-helpers';

describe('isValidDexieKeyFallback', () => {
  it('accepts strings, finite numbers, and Dates', () => {
    expect(isValidDexieKeyFallback('abc')).toBe(true);
    expect(isValidDexieKeyFallback('')).toBe(true);
    expect(isValidDexieKeyFallback(0)).toBe(true);
    expect(isValidDexieKeyFallback(-1)).toBe(true);
    expect(isValidDexieKeyFallback(1.5)).toBe(true);
    expect(isValidDexieKeyFallback(new Date())).toBe(true);
  });

  it('rejects null/undefined, non-finite numbers, booleans, and plain objects', () => {
    expect(isValidDexieKeyFallback(null)).toBe(false);
    expect(isValidDexieKeyFallback(undefined)).toBe(false);
    expect(isValidDexieKeyFallback(NaN)).toBe(false);
    expect(isValidDexieKeyFallback(Infinity)).toBe(false);
    expect(isValidDexieKeyFallback(true)).toBe(false);
    expect(isValidDexieKeyFallback({})).toBe(false);
  });

  it('validates arrays recursively (compound keys)', () => {
    expect(isValidDexieKeyFallback(['account', 123])).toBe(true);
    expect(isValidDexieKeyFallback([])).toBe(true); // [].every === true
    expect(isValidDexieKeyFallback(['account', null])).toBe(false);
    expect(isValidDexieKeyFallback(['account', ['nested', 1]])).toBe(true);
    expect(isValidDexieKeyFallback(['account', NaN])).toBe(false);
  });
});

describe('coerceLabelList', () => {
  it('trims and filters an array of labels', () => {
    expect(coerceLabelList([' Work ', 'Home', ''])).toEqual(['Work', 'Home']);
  });

  it('splits a comma-separated string', () => {
    expect(coerceLabelList('Work, Home ,, Travel')).toEqual(['Work', 'Home', 'Travel']);
  });

  it('drops the literal "[]" placeholder (any inner whitespace)', () => {
    expect(coerceLabelList(['[]', '[ ]', 'Work'])).toEqual(['Work']);
    expect(coerceLabelList('[]')).toEqual([]);
  });

  it('coerces non-string array entries and drops null/empty', () => {
    expect(coerceLabelList([5, null, undefined, 'ok'])).toEqual(['5', 'ok']);
  });

  it('returns [] for non-array/non-string input', () => {
    expect(coerceLabelList(null)).toEqual([]);
    expect(coerceLabelList(undefined)).toEqual([]);
    expect(coerceLabelList(42)).toEqual([]);
    expect(coerceLabelList({})).toEqual([]);
  });
});

describe('hasFromValue', () => {
  it('is true only for a non-blank string', () => {
    expect(hasFromValue('a@b.com')).toBe(true);
    expect(hasFromValue('   x  ')).toBe(true);
  });

  it('is false for blank strings and non-strings', () => {
    expect(hasFromValue('')).toBe(false);
    expect(hasFromValue('   ')).toBe(false);
    expect(hasFromValue(null)).toBe(false);
    expect(hasFromValue(undefined)).toBe(false);
    expect(hasFromValue(123)).toBe(false);
  });
});

describe('getMessageKey', () => {
  it('prefers id, then uid/Uid/uidnext', () => {
    expect(getMessageKey({ id: 'a', uid: 'b' })).toBe('a');
    expect(getMessageKey({ uid: 'b' })).toBe('b');
    expect(getMessageKey({ Uid: 'c' })).toBe('c');
    expect(getMessageKey({ uidnext: 'd' })).toBe('d');
  });

  it('treats id 0 as a real key (nullish, not falsy, semantics)', () => {
    expect(getMessageKey({ id: 0 })).toBe(0);
  });

  it('falls back to folder-scoped Message-ID when no id/uid', () => {
    expect(getMessageKey({ message_id: '<x@host>', folder: 'INBOX' })).toBe('INBOX:<x@host>');
    expect(getMessageKey({ messageId: '<y@host>' })).toBe(':<y@host>'); // no folder
    expect(getMessageKey({ 'Message-ID': '<z@host>', folder: 'Sent' })).toBe('Sent:<z@host>');
    expect(getMessageKey({ header_message_id: '<h@host>', folder: 'A' })).toBe('A:<h@host>');
  });

  it('scopes Message-ID by folder so forwarded copies do not collapse', () => {
    const a = getMessageKey({ message_id: '<same@host>', folder: 'INBOX' });
    const b = getMessageKey({ message_id: '<same@host>', folder: 'Archive' });
    expect(a).not.toBe(b);
  });

  it('returns null when nothing identifies the message', () => {
    expect(getMessageKey({})).toBeNull();
    expect(getMessageKey(null)).toBeNull();
    expect(getMessageKey(undefined)).toBeNull();
  });
});

describe('mergeMessagePages', () => {
  it('concatenates with existing first, dropping incoming duplicates by key', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const incoming = [{ id: 'b' }, { id: 'c' }];
    expect(mergeMessagePages(existing, incoming)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('keeps the existing copy when a key collides (first write wins)', () => {
    const existing = [{ id: 'a', from: 'old' }];
    const incoming = [{ id: 'a', from: 'new' }];
    expect(mergeMessagePages(existing, incoming)).toEqual([{ id: 'a', from: 'old' }]);
  });

  it('always keeps messages with no derivable key', () => {
    const a = { subject: 'one' };
    const b = { subject: 'two' };
    expect(mergeMessagePages([a], [b])).toEqual([a, b]);
  });

  it('dedups within a single page too', () => {
    expect(mergeMessagePages([{ id: 'a' }, { id: 'a' }], [])).toEqual([{ id: 'a' }]);
  });

  it('handles empty/omitted arguments', () => {
    expect(mergeMessagePages()).toEqual([]);
    expect(mergeMessagePages([], [])).toEqual([]);
    expect(mergeMessagePages([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });
});
