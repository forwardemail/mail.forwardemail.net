/**
 * AI Enabled Store
 *
 * Master on/off for every AI surface in the app. Default is OFF — users
 * explicitly opt in in Settings → AI. When disabled:
 *   - Floating sparkles button does not render
 *   - In-message action bar sparkles button does not render
 *   - ⋯ dropdown AI entries do not render
 *   - Ask AI panel ignores `openAIPanel()` intents
 *   - AskAIPanel does not subscribe to message / body stores
 *
 * Persisted to localStorage as a plain boolean. Not encrypted — the flag
 * itself isn't sensitive. Provider keys still go through crypto-store.
 */

import { writable } from 'svelte/store';

const STORAGE_KEY = 'webmail_ai_enabled';

const readInitial = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

const internal = writable<boolean>(readInitial());

// Persist every change.
internal.subscribe((value) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    /* localStorage may be unavailable (private mode etc.) — ignore */
  }
});

export const aiEnabled = {
  subscribe: internal.subscribe,
};

export const setAIEnabled = (value: boolean): void => {
  internal.set(value);
};

/** Synchronous read of the current value — for non-reactive callers. */
export const isAIEnabled = (): boolean => readInitial();
