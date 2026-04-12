/**
 * Friendly date formatting for message timestamps.
 * - Today: "4:59 PM"
 * - Yesterday: "Yesterday 4:59 PM"
 * - Older: "12/4/2025 4:59 PM"
 */

import { i18n } from './i18n';

type DateInput = Date | string | number | null | undefined;

// Lazily-created formatters keyed by locale so they respect i18n.getFormattingLocale().
// Cached per locale string to avoid re-creating on every call.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = i18n.getFormattingLocale();
  const cacheKey = `${locale ?? ''}:${key}`;
  let fmt = formatterCache.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(cacheKey, fmt);
  }
  return fmt;
}

const timeOptions: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
};

const dateOptions: Intl.DateTimeFormatOptions = {
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
};

const monthDayOptions: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
};

const monthDayYearOptions: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
};

const readerDateTimeOptions: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

export function toDate(value: DateInput): Date | null {
  if (value instanceof Date) return value;
  if (value === undefined || value === null) return null;
  // Treat empty string and 0 as missing values rather than the Unix epoch
  if (value === '' || value === 0) return null;

  const num = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'number' || (Number.isFinite(num) && num !== 0)) {
    const ts = typeof value === 'number' ? value : num;
    return new Date(ts < 1e12 ? ts * 1000 : ts);
  }

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return parsed;

  return null;
}

export function formatFriendlyDate(value: DateInput, now: Date = new Date()): string {
  try {
    const date = toDate(value);
    if (!date || !Number.isFinite(date.getTime())) {
      return typeof value === 'string' ? value : '';
    }

    const target = new Date(date);
    const current = new Date(now);

    const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const targetDay = startOfDay(target);
    const currentDay = startOfDay(current);

    const msInDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((currentDay.getTime() - targetDay.getTime()) / msInDay);

    const timePart = getFormatter('time', timeOptions).format(target);
    if (diffDays === 0) {
      return timePart;
    }
    if (diffDays === 1) {
      return `Yesterday ${timePart}`;
    }

    const datePart = getFormatter('date', dateOptions).format(target);
    return `${datePart} ${timePart}`;
  } catch {
    return '';
  }
}

/**
 * Gmail-style compact date formatting for conversation lists
 * - Today: "4:59 PM"
 * - This year: "Nov 29"
 * - Other years: "Nov 29 2022"
 */
export function formatCompactDate(value: DateInput, now: Date = new Date()): string {
  try {
    const date = toDate(value);
    if (!date || !Number.isFinite(date.getTime())) {
      return typeof value === 'string' ? value : '';
    }

    const target = new Date(date);
    const current = new Date(now);

    const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const targetDay = startOfDay(target);
    const currentDay = startOfDay(current);

    const msInDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((currentDay.getTime() - targetDay.getTime()) / msInDay);

    // Today: show time
    if (diffDays === 0) {
      return getFormatter('time', timeOptions).format(target);
    }

    // Same year: show "Nov 29"
    if (target.getFullYear() === current.getFullYear()) {
      return getFormatter('monthDay', monthDayOptions).format(target);
    }

    // Different year: show "Nov 29 2022"
    return getFormatter('monthDayYear', monthDayYearOptions).format(target);
  } catch {
    return '';
  }
}

/**
 * Reader date formatting with explicit date + time
 * - "Dec 16, 2024, 4:59 PM"
 */
export function formatReaderDate(value: DateInput): string {
  try {
    const date = toDate(value);
    if (!date || !Number.isFinite(date.getTime())) {
      return typeof value === 'string' ? value : '';
    }

    return getFormatter('readerDateTime', readerDateTimeOptions).format(date);
  } catch {
    return '';
  }
}
