import { describe, it, expect, afterEach } from 'vitest';
import { i18n } from '../../src/utils/i18n';

// Schedule-X's translate() throws "Invalid locale: <x>" unless the tag matches
// /^[a-z]{2}-[A-Z]{2}$/ exactly. That throw is uncaught during the calendar's
// synchronous render and blanks the whole app via the global fatal overlay, so
// getShortFormattingLocale() must only ever emit a conformant tag (or
// undefined, which the call site defaults to 'en-US').
const SCHEDULE_X_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

describe('i18n.getShortFormattingLocale', () => {
  afterEach(() => {
    // setFormattingLocale(undefined) reverts to browser detection.
    i18n.setFormattingLocale(undefined);
  });

  it('upgrades a bare language to a region tag (the crash repro)', () => {
    i18n.setFormattingLocale('en');
    const out = i18n.getShortFormattingLocale();
    expect(out).toBe('en-US');
    expect(out).toMatch(SCHEDULE_X_LOCALE);
  });

  it('passes a conformant tag through unchanged', () => {
    i18n.setFormattingLocale('en-GB');
    expect(i18n.getShortFormattingLocale()).toBe('en-GB');
  });

  it('normalizes a lowercase region', () => {
    i18n.setFormattingLocale('en-us');
    expect(i18n.getShortFormattingLocale()).toBe('en-US');
  });

  it('drops a script subtag and keeps the region', () => {
    i18n.setFormattingLocale('zh-Hans-CN');
    const out = i18n.getShortFormattingLocale();
    expect(out).toBe('zh-CN');
    expect(out).toMatch(SCHEDULE_X_LOCALE);
  });

  it('derives a region for other bare languages', () => {
    i18n.setFormattingLocale('de');
    expect(i18n.getShortFormattingLocale()).toBe('de-DE');
  });

  it('returns undefined for tags that cannot be made conformant', () => {
    // Numeric region (es-419) and 3-letter language (fil) can never match the
    // 2-letter/2-letter shape; caller falls back to its own default.
    i18n.setFormattingLocale('es-419');
    expect(i18n.getShortFormattingLocale()).toBeUndefined();
    i18n.setFormattingLocale('fil');
    expect(i18n.getShortFormattingLocale()).toBeUndefined();
  });

  it('returns undefined when no formatting locale is set', () => {
    i18n.formattingLocale = undefined;
    expect(i18n.getShortFormattingLocale()).toBeUndefined();
  });

  it('never emits a non-conformant tag for a broad set of inputs', () => {
    for (const input of ['en', 'fr', 'pt', 'EN-us', 'en-GB', 'zh-Hans-CN', 'de']) {
      i18n.setFormattingLocale(input);
      const out = i18n.getShortFormattingLocale();
      if (out !== undefined) expect(out).toMatch(SCHEDULE_X_LOCALE);
    }
  });
});
