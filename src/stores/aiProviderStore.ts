/**
 * AI Provider Availability Store
 *
 * Tracks whether the user has at least one provider configured. UI surfaces
 * (message-view sparkles, ⋯ dropdown entries, floating panel) gate on this
 * in addition to `aiEnabled` — a feature that can't actually run shouldn't
 * advertise itself.
 *
 * The store populates lazily on first subscribe (so it doesn't race the
 * db.worker init at app startup), and refreshes on demand when the Settings
 * UI saves or deletes a provider.
 */

import { writable, derived } from 'svelte/store';
import { listProviders } from '../ai/keystore-web';

const providerCount = writable<number | null>(null);
let inFlight: Promise<void> | null = null;

const loadCount = async (): Promise<void> => {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const providers = await listProviders();
      providerCount.set(providers.length);
    } catch (err) {
      // db.worker may not be ready yet on first call — keep the store at
      // null so `hasProvider` stays false until a real read succeeds.
      console.warn('[aiProviderStore] listProviders failed', err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};

/** Re-read providers from storage. Called after save/delete in Settings. */
export const refreshProviders = (): Promise<void> => loadCount();

/** True once at least one provider has been configured. */
export const hasProvider = derived(providerCount, ($count) => ($count ?? 0) > 0);

export const configuredProviderCount = derived(providerCount, ($count) => $count ?? 0);

// Kick off the initial load lazily when the first subscriber attaches.
let bootstrapped = false;
const bootstrap = () => {
  if (bootstrapped) return;
  bootstrapped = true;
  void loadCount();
};
hasProvider.subscribe(() => bootstrap());
