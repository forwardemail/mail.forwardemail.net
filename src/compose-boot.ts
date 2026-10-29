/**
 * Entry point for compose.html. Loads the device key before the composer
 * reads anything sealed with it (see boot.ts). The compose window never
 * creates the key: only the main window does, so two windows starting at once
 * cannot store different ones.
 */
import { loadDeviceKey } from './utils/device-seal';

await loadDeviceKey({ create: false });

await import('./compose-main');
