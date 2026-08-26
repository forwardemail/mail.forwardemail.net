/**
 * QR device pairing.
 *
 * Moves an account, its PGP keys and its portable device settings from webmail
 * or the desktop app to a phone by way of a scanned code. Everything travels
 * inside the code itself - nothing passes through a server - so a bundle too
 * large for one QR becomes an animated sequence of frames instead.
 */
export type {
  DeviceSyncAccount,
  DeviceSyncBuckets,
  DeviceSyncBundle,
  DeviceSyncPgp,
  DeviceSyncSource,
  PgpKeyEntry,
  SavedSearchEntry,
} from './types';

export {
  BUNDLE_VERSION,
  DEFAULT_TTL_SECONDS,
  DeviceSyncError,
  SEAL_KEY_BYTES,
  generateSealKey,
  openSealedBundle,
  sealBundle,
} from './seal';
export type { DeviceSyncErrorCode } from './seal';

export {
  DEFAULT_CHUNK_BYTES,
  FLAG_CODE_PROTECTED,
  FRAME_HEADER_BYTES,
  FrameCollector,
  MAX_FRAMES,
  decodeFrame,
  encodeFrames,
  newSessionId,
} from './frames';
export type { DecodedFrame, FrameAcceptResult } from './frames';

export { decodeBase45, encodeBase45 } from './base45';

export { applyPlan, collectBundle, planImport, readCurrentState } from './bundle';
export type { ApplyResult, CollectBundleOptions, CurrentState, ImportPlan } from './bundle';

export {
  QR_CAMERA_CONSTRAINTS,
  createQrDecoder,
  isNativeDecoderAvailable,
  resolveQrDecoder,
  startScanLoop,
} from './scanner';
export type { QrDecoder, QrFrameSource, ScanLoopOptions } from './scanner';

export { summarizePgpKeys } from './pgp-summary';
export type { PgpKeySummary } from './pgp-summary';

export {
  PAIRING_CODE_LENGTH,
  derivePairingKey,
  formatPairingCode,
  generatePairingCode,
  isPairingCodeComplete,
  normalizePairingCode,
  unwrapSealKey,
  wrapSealKey,
} from './pairing-code';
