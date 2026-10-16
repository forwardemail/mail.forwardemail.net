/** Type declarations for db-crypto-bridge.js (main-thread glue between App Lock and the DB engine). */

export function initDbCryptoBridge(): Promise<void>;
export function syncDbCryptoState(): Promise<void>;
export function encryptAllIdbData(): Promise<Record<string, number> | null>;
export function decryptAllIdbData(): Promise<Record<string, number> | null>;
export function abandonEncryptedCache(): Promise<void>;
export function setExternalIdbKey(rawKey: Uint8Array | null): Promise<void>;
