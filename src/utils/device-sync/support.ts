/**
 * Where QR device pairing is offered.
 *
 * One predicate rather than scattered platform checks, so enabling a platform
 * is a single edit and every entry point moves together - a scanner button
 * that cannot work is worse than no button, and a half-gated feature is how
 * you end up with one.
 */
import { isTauriIOS } from '../platform.js';

/**
 * iOS is excluded until a bundled QR decoder ships. WebKit has no
 * BarcodeDetector, so createQrDecoder() resolves to null there and the scanner
 * can only report that it cannot scan. The sender half would technically work
 * on iOS - rendering a code needs no camera - but shipping half the feature on
 * one platform is more confusing than shipping none of it, so both halves stay
 * hidden together.
 *
 * To enable: land a decoder in scanner.ts, then delete this exclusion.
 */
export function isDevicePairingSupported(): boolean {
  return !isTauriIOS;
}
