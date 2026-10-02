/**
 * Every locale carries every string the English locale has, with the same
 * {placeholders}, so no screen falls back to a key path in one language.
 */
import fs from 'node:fs';
import path from 'node:path';

const localesDir = path.resolve(__dirname, '../../src/locales');
const read = (file) => JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));

function flatten(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flatten(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(value)]],
  );
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const english = new Map(flatten(read('en.json')));
const others = fs
  .readdirSync(localesDir)
  .filter((file) => file.endsWith('.json') && file !== 'en.json');

describe('locale files', () => {
  it('include the browser notification strings', () => {
    expect([...english.keys()].filter((key) => key.startsWith('browserNotifications.'))).toEqual([
      'browserNotifications.pushNotReceiving',
      'browserNotifications.fallbackActive',
      'browserNotifications.pushServiceHint',
      'browserNotifications.needsPermission',
      'browserNotifications.allow',
      'browserNotifications.blocked',
      'browserNotifications.unavailable',
      'browserNotifications.allowed',
      'browserNotifications.notAllowed',
    ]);
  });

  it.each(others)('%s has every English key, translated, with the same placeholders', (file) => {
    const translated = new Map(flatten(read(file)));
    for (const [key, text] of english) {
      expect(translated.has(key), `${file} is missing ${key}`).toBe(true);
      expect(placeholders(translated.get(key)), `${file} ${key}`).toEqual(placeholders(text));
      if (key.startsWith('browserNotifications.')) {
        expect(translated.get(key), `${file} ${key} is untranslated`).not.toBe(text);
      }
    }
  });
});
