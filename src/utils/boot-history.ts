/**
 * A short history of page loads, for the diagnostics report.
 *
 * When iOS kills the web content process (usually for memory) the app
 * reloads the page, and a page that keeps dying looks to the user like a
 * screen that keeps flashing. Nothing in the page sees the kill itself, so
 * each load records whether the page before it was still on screen when it
 * ended. A page the user put in the background and the system later closed
 * is normal; one that ended while visible was a crash or a forced reload.
 */

const HISTORY_KEY = 'fe_boot_history';
const VISIBLE_KEY = 'fe_page_visible';
const RECOVERED_PENDING_KEY = 'fe_boot_recovered_pending';

// When this page's own load was recorded, so a later mark finds its entry
let thisLoad: number | null = null;
const MAX_ENTRIES = 30;

export interface BootEntry {
  /** When the page loaded (ms since epoch) */
  at: number;
  /** The page before this one ended while on screen. Null for the first load. */
  previousEndedOnScreen: boolean | null;
  /** The iOS app reloaded this page after the system ended the one before */
  rendererRecovered?: boolean;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStorage = (): KeyValueStore | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readBootHistory(storage = defaultStorage()): BootEntry[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((e) => e && typeof e.at === 'number').slice(-MAX_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

/** Record this page load. Call once, early in boot. */
export function recordBoot(storage = defaultStorage(), now = Date.now()): BootEntry | null {
  if (!storage) return null;
  try {
    const marker = storage.getItem(VISIBLE_KEY);
    const entry: BootEntry = {
      at: now,
      previousEndedOnScreen: marker === null ? null : marker === '1',
    };
    if (storage.getItem(RECOVERED_PENDING_KEY)) {
      entry.rendererRecovered = true;
      storage.setItem(RECOVERED_PENDING_KEY, '');
    }
    thisLoad = now;
    const history = [...readBootHistory(storage), entry].slice(-MAX_ENTRIES);
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
    storage.setItem(VISIBLE_KEY, '1');
    return entry;
  } catch {
    return null;
  }
}

/**
 * Mark this load as a recovery reload. The native side says so as soon as the
 * page has loaded, which can be before or after recordBoot runs.
 */
export function markRendererRecovered(storage = defaultStorage()) {
  if (!storage) return;
  try {
    if (thisLoad === null) {
      // recordBoot has not run yet; it picks this up
      storage.setItem(RECOVERED_PENDING_KEY, '1');
      return;
    }
    const history = readBootHistory(storage);
    const entry = history.find((e) => e.at === thisLoad);
    if (entry && !entry.rendererRecovered) {
      entry.rendererRecovered = true;
      storage.setItem(HISTORY_KEY, JSON.stringify(history));
    }
  } catch {
    /* the report is just less precise */
  }
}

/**
 * Keep the on-screen marker current. Hidden and pagehide clear it, so a page
 * closed while in the background, or unloaded normally, does not count.
 */
export function trackPageVisibility(storage = defaultStorage()) {
  if (!storage || typeof document === 'undefined') return;
  const set = (visible: boolean) => {
    try {
      storage.setItem(VISIBLE_KEY, visible ? '1' : '0');
    } catch {
      /* storage full or blocked; the next report is just less precise */
    }
  };
  document.addEventListener('visibilitychange', () => set(document.visibilityState === 'visible'));
  globalThis.addEventListener('pagehide', () => set(false));
}

/** Loads within the window, and how many followed a page that died on screen */
export function summarizeBootHistory(
  history: BootEntry[],
  now = Date.now(),
  windowMs = 60 * 60_000,
) {
  const recent = history.filter((e) => now - e.at <= windowMs);
  return {
    loads: recent.length,
    endedOnScreen: recent.filter((e) => e.previousEndedOnScreen === true).length,
    recovered: recent.filter((e) => e.rendererRecovered === true).length,
  };
}
