import { Local } from './storage';
import { warn } from './logger.ts';

// BCP 47 language-region tag in the exact shape Schedule-X validates against:
// two lowercase language letters, a hyphen, two uppercase region letters.
const REGION_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

class I18n {
  constructor() {
    this.translations = {};
    this.currentLocale = 'en';
    this.formattingLocale = undefined; // Full BCP 47 tag for date/number formatting
    this.fallbackLocale = 'en';
    this.changeListeners = [];
  }

  /**
   * Initialize i18n with user's preferred language
   */
  async init() {
    // Detect language from: 1) User settings, 2) Browser, 3) Default to English
    const userLocale = Local.get('locale');
    const browserLocale = this.detectBrowserLocale();
    const locale = userLocale || browserLocale || 'en';

    // Store the full browser locale for date/number formatting
    this.formattingLocale = this.detectFormattingLocale();

    await this.setLocale(locale);
  }

  /**
   * Detect browser's preferred language
   */
  detectBrowserLocale() {
    if (typeof navigator === 'undefined') return 'en';

    const language = navigator.language || navigator.userLanguage;
    if (!language) return 'en';

    // Extract base language code (e.g., 'en' from 'en-US')
    return language.split('-')[0].toLowerCase();
  }

  /**
   * Detect the full BCP 47 locale from the browser for formatting purposes.
   * Unlike detectBrowserLocale(), this preserves the region code (e.g., 'en-GB').
   */
  detectFormattingLocale() {
    if (typeof navigator === 'undefined') return undefined;
    return navigator.language || navigator.userLanguage || undefined;
  }

  /**
   * Get the locale to use for date/number formatting.
   * Returns the full BCP 47 tag (e.g., 'en-GB') or undefined to use browser default.
   */
  getFormattingLocale() {
    return this.formattingLocale;
  }

  /**
   * Set an explicit formatting locale override.
   * Pass 'auto' or undefined to revert to browser detection.
   */
  setFormattingLocale(locale) {
    if (!locale || locale === 'auto') {
      this.formattingLocale = this.detectFormattingLocale();
    } else {
      this.formattingLocale = locale;
    }
    this.notifyChange();
  }

  /**
   * Get a locale in the strict `xx-XX` form (two lowercase language letters,
   * a hyphen, two uppercase region letters) required by libraries like
   * Schedule-X. Schedule-X throws "Invalid locale" for anything else —
   * including the bare "en" some browsers report in navigator.language, a
   * lowercase region ("en-us"), a script subtag ("zh-Hans-CN"), or a numeric
   * region ("es-419") — and that throw crashes the calendar route through the
   * global fatal-error overlay.
   *
   * Normalizes casing and, when a region is missing or non-conformant, derives
   * a likely one via Intl.Locale's CLDR data ("en" -> "en-US", "de" -> "de-DE").
   * Returns undefined when no conformant tag can be produced (e.g. 3-letter
   * languages like "fil") so callers can apply their own default.
   */
  getShortFormattingLocale() {
    const full = this.formattingLocale;
    if (!full) return undefined;
    if (REGION_LOCALE.test(full)) return full;
    try {
      const loc = new Intl.Locale(full).maximize();
      const candidate = `${(loc.language || '').toLowerCase()}-${(loc.region || '').toUpperCase()}`;
      if (REGION_LOCALE.test(candidate)) return candidate;
    } catch {
      // Intl.Locale throws on malformed tags — fall through to undefined.
    }
    return undefined;
  }

  /**
   * Set the current locale and load translations
   */
  async setLocale(locale) {
    try {
      // Try to load the requested locale
      const translations = await this.loadTranslations(locale);
      this.translations = translations;
      this.currentLocale = locale;
      Local.set('locale', locale);

      // Notify listeners
      this.notifyChange();

      return true;
    } catch (error) {
      warn(`Failed to load locale "${locale}", falling back to "${this.fallbackLocale}"`, error);

      // Fall back to English if requested locale fails
      if (locale !== this.fallbackLocale) {
        const fallbackTranslations = await this.loadTranslations(this.fallbackLocale);
        this.translations = fallbackTranslations;
        this.currentLocale = this.fallbackLocale;
      }

      return false;
    }
  }

  /**
   * Load translations for a locale
   */
  async loadTranslations(locale) {
    // Dynamic import of locale file
    try {
      const module = await import(`../locales/${locale}.json`);
      return module.default || module;
    } catch {
      throw new Error(`Locale "${locale}" not found`);
    }
  }

  /**
   * Get a translation by key path (e.g., 'messages.noSubject')
   */
  t(keyPath, params = {}) {
    const keys = keyPath.split('.');
    let value = this.translations;

    // Navigate through nested object
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        warn(`Translation key not found: ${keyPath}`);
        return keyPath; // Return key path if translation not found
      }
    }

    // Handle string interpolation
    if (typeof value === 'string') {
      return this.interpolate(value, params);
    }

    return value;
  }

  /**
   * Interpolate parameters into translation string
   * Example: "Hello {name}" with {name: "World"} => "Hello World"
   */
  interpolate(str, params) {
    return str.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? params[key] : match;
    });
  }

  /**
   * Get current locale
   */
  getLocale() {
    return this.currentLocale;
  }

  /**
   * Get available locales
   */
  getAvailableLocales() {
    // This would be dynamically populated based on available locale files
    return ['en', 'es', 'fr', 'de', 'pt', 'zh', 'ja', 'ko'];
  }

  /**
   * Register a listener for locale changes
   */
  onChange(callback) {
    this.changeListeners.push(callback);
    return () => {
      this.changeListeners = this.changeListeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * Notify all listeners of locale change
   */
  notifyChange() {
    this.changeListeners.forEach((callback) => {
      try {
        callback(this.currentLocale);
      } catch (error) {
        console.error('Error in i18n change listener', error);
      }
    });
  }

  /**
   * Format a number according to locale
   */
  formatNumber(number, options = {}) {
    if (typeof Intl === 'undefined') return number.toString();
    return new Intl.NumberFormat(this.formattingLocale || this.currentLocale, options).format(
      number,
    );
  }

  /**
   * Format a date according to locale
   */
  formatDate(date, options = {}) {
    if (typeof Intl === 'undefined') return date.toString();
    return new Intl.DateTimeFormat(this.formattingLocale || this.currentLocale, options).format(
      date,
    );
  }

  /**
   * Format file size with localized units
   */
  formatFileSize(bytes) {
    if (bytes < 1024) {
      return this.t('storage.bytes', { size: bytes });
    } else if (bytes < 1024 * 1024) {
      return this.t('storage.kilobytes', { size: (bytes / 1024).toFixed(2) });
    } else if (bytes < 1024 * 1024 * 1024) {
      return this.t('storage.megabytes', { size: (bytes / (1024 * 1024)).toFixed(2) });
    } else {
      return this.t('storage.gigabytes', { size: (bytes / (1024 * 1024 * 1024)).toFixed(2) });
    }
  }
}

// Export singleton instance
export const i18n = new I18n();
