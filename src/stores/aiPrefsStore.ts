/**
 * AI Preferences Store
 *
 * Non-secret user preferences for AI behavior. Persisted to localStorage.
 * Distinct from the aiEnabled master switch and the aiProvider availability
 * store — those answer "is AI on?" / "can AI work?"; this answers "how does
 * the user want AI to behave?"
 */

import { writable } from 'svelte/store';

interface PrefsShape {
  /** Show the egress preview modal before every non-loopback request. */
  showEgressPreview: boolean;
}

const STORAGE_KEY = 'webmail_ai_prefs';
const DEFAULT: PrefsShape = { showEgressPreview: false };

const read = (): PrefsShape => {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT, ...parsed };
  } catch {
    return DEFAULT;
  }
};

const internal = writable<PrefsShape>(read());

internal.subscribe((value) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* localStorage may be unavailable — ignore */
  }
});

export const aiPrefs = { subscribe: internal.subscribe };

export const setShowEgressPreview = (value: boolean): void => {
  internal.update((prefs) => ({ ...prefs, showEgressPreview: value }));
};
