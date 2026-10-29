/**
 * Entry point for index.html.
 *
 * On desktop, sensitive localStorage values are sealed with a key kept in the
 * OS credential store (utils/device-seal.ts). That key has to be loaded before
 * any module reads a credential, and several do so while they are first
 * evaluated (main.ts decides the route at import). So it is loaded here, and
 * the app is imported only after. Elsewhere loadDeviceKey resolves false at
 * once.
 */
import { loadDeviceKey, sealExistingLocalStorage } from './utils/device-seal';
import { isEncrypted, isSensitiveLocalKey } from './utils/crypto-store.js';

if (await loadDeviceKey({ create: true })) {
  // Values written before sealing existed, or while App Lock was on and since
  // turned off, are sealed now.
  sealExistingLocalStorage(isSensitiveLocalKey, isEncrypted);
}

try {
  await import('./main');
} catch (err) {
  // The app chunk did not load. Leaving the page cancels the load, which
  // needs no handling. Otherwise it is almost always a deploy that replaced
  // the chunk this page was built against: index.html's recovery clears the
  // asset caches and reloads, as it did when the app was a static entry.
  const page = window as unknown as {
    __fePageLeaving?: boolean;
    __feRecoverStaleChunks?: () => void;
  };
  if (!page.__fePageLeaving) {
    if (typeof page.__feRecoverStaleChunks !== 'function') throw err;
    console.error('[boot] the app failed to load:', err);
    page.__feRecoverStaleChunks();
  }
}
