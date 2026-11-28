import { describe, expect, it } from 'vitest';
import { normalizeReaderAdvance, READER_ADVANCE_OPTIONS } from '../../src/utils/reader-advance';
import { SETTINGS_REGISTRY } from '../../src/stores/settingsRegistry';

describe('reader_advance setting', () => {
  it('keeps each choice the Settings page offers', () => {
    for (const { value } of READER_ADVANCE_OPTIONS) {
      expect(normalizeReaderAdvance(value)).toBe(value);
    }
  });

  it('falls back to the old behaviour for anything else', () => {
    for (const stored of [null, undefined, '', 'next', 'LIST', 3, {}]) {
      expect(normalizeReaderAdvance(stored)).toBe('auto');
    }
  });

  it('is read from and written to local storage as one of the choices', () => {
    const setting = SETTINGS_REGISTRY.reader_advance;
    expect(setting.defaultValue).toBe('auto');
    expect(setting.localParse?.('list')).toBe('list');
    expect(setting.localParse?.('garbage')).toBe('auto');
    expect(setting.localSerialize?.('above')).toBe('above');
    expect(setting.localSerialize?.(null)).toBe('auto');
  });
});
