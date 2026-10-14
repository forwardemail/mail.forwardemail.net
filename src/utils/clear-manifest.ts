/**
 * Kill switch for bad web releases. A deployed /clear-manifest.json with
 * `clear_below: "x.y.z"` makes every client older than that wipe its local
 * data and reload. Runs before any DB or store initialization.
 *
 * Only the web build can use it. The desktop and mobile apps bundle the
 * manifest with the same build, so their version can never be below it.
 */

// Long enough for a slow mobile connection; past that, this boot skips the
// check rather than holding up startup. The next boot checks again.
export const CLEAR_MANIFEST_TIMEOUT_MS = 3000;

/** True when `version` (which may carry a "-hash" suffix) is below `threshold`. */
export const isVersionBelow = (version: string, threshold: string): boolean => {
  const parts = version.split('-')[0].split('.').map(Number);
  const limit = threshold.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((parts[i] || 0) !== (limit[i] || 0)) return (parts[i] || 0) < (limit[i] || 0);
  }
  return false;
};

// Settles once the delete has run, failed or been blocked by another open
// connection; a request that is merely fired can be dropped by a navigation.
const deleteDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });

/** Deletes everything the app stores in this browser or webview, which signs out every account. */
export const clearSiteData = async () => {
  if (typeof indexedDB.databases === 'function') {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((db) => (db.name ? deleteDatabase(db.name) : undefined)));
  } else {
    // Safari fallback: delete the known DB name
    const { DB_NAME } = await import('./db-constants');
    await deleteDatabase(DB_NAME);
  }

  // The desktop and mobile webviews may have no Cache Storage or service
  // worker at all.
  if (typeof caches !== 'undefined') {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map(async (k) => caches.delete(k)));
  }
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.unregister();
  }

  localStorage.clear();
  sessionStorage.clear();
};

/**
 * Fetches the manifest and, when this client is below `clear_below`, wipes
 * site data and reloads (fresh assets carry the new version, so no loop).
 * Returns true when it started that reset.
 */
export const checkClearManifest = async ({
  version = import.meta.env.VITE_PKG_VERSION || '0.0.0',
  timeoutMs = CLEAR_MANIFEST_TIMEOUT_MS,
  fetchImpl = fetch,
  clear = clearSiteData,
  reload = () => globalThis.location.reload(),
}: {
  version?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  clear?: () => Promise<void>;
  reload?: () => void;
} = {}): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('/clear-manifest.json', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const manifest = await res.json();
    if (!manifest?.clear_below || !isVersionBelow(version, manifest.clear_below)) return false;

    console.warn(
      '[clear-manifest] Client version %s is below %s, clearing site data',
      version,
      manifest.clear_below,
    );
    await clear();
    reload();
    return true;
  } catch {
    // Fetch failed, timed out or the manifest did not parse: carry on.
    return false;
  } finally {
    clearTimeout(timer);
  }
};
