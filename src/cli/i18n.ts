/**
 * Text the terminal code shows, in the app's language.
 *
 * The strings live in src/locales with the app's own, under "terminal". The
 * app's i18n instance (handed over by app-entry.ts) translates them once it
 * has loaded; before that, or for a key a locale lacks, the English text is
 * used.
 */
import en from '../locales/en.json';

interface Translator {
  t(key: string, params?: Record<string, unknown>): unknown;
}

const interpolate = (text: string, params: Record<string, unknown>) =>
  text.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined ? match : String(params[name]),
  );

function english(key: string): string {
  let value: unknown = en;
  for (const part of key.split('.')) {
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : null;
  }
  return typeof value === 'string' ? value : key;
}

/** The text for `key` (a path such as terminal.attach.attached), filled in. */
export function tr(key: string, params: Record<string, unknown> = {}): string {
  const i18n = (globalThis as Record<string, unknown>).__forwardemailI18n as Translator | undefined;
  let text: unknown;
  try {
    text = i18n?.t(key, params);
  } catch {
    text = null;
  }
  if (typeof text === 'string' && text && text !== key) return text;
  return interpolate(english(key), params);
}
