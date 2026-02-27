/**
 * Crypto Store - Client-Side Encryption Layer
 *
 * Provides transparent encryption for all data stored in IndexedDB and
 * sensitive values in localStorage using libsodium (XChaCha20-Poly1305).
 *
 * Architecture:
 *   - Envelope encryption: a random Data Encryption Key (DEK) encrypts all data
 *   - The DEK is itself encrypted by a Key Encryption Key (KEK) derived from
 *     the user's PIN (via Argon2id) or passkey (via WebAuthn PRF)
 *   - The encrypted DEK + salt are stored in localStorage (the "vault")
 *   - On unlock the KEK is re-derived, the DEK decrypted, and held in memory
 *   - On lock the DEK is wiped from memory
 *
 * What gets encrypted (non-indexed fields):
 *   - Email bodies, subjects, snippets, from addresses
 *   - Attachment metadata, draft content
 *   - PGP keys and passphrases
 *   - Account credentials in localStorage
 *
 * What stays in plaintext (indexed fields required for queries):
 *   - Primary keys, compound index keys
 *   - Message UIDs, folder paths, timestamps, flags
 */

const VAULT_KEY = 'webmail_crypto_vault';
const LOCK_PREFS_KEY = 'webmail_lock_prefs';
const ENCRYPTED_PREFIX = '\x00ENC\x01';

// Fields that MUST remain unencrypted because they are used as Dexie indexes.
// Derived from the schema in db.worker.ts.
const INDEX_FIELDS_BY_TABLE = {
  accounts: new Set(['id', 'email', 'createdAt', 'updatedAt']),
  folders: new Set(['account', 'path', 'parentPath', 'unread_count', 'specialUse', 'updatedAt']),
  messages: new Set([
    'account',
    'id',
    'folder',
    'date',
    'flags',
    'is_unread',
    'is_unread_index',
    'has_attachment',
    'modseq',
    'updatedAt',
    'bodyIndexed',
    'labels',
  ]),
  messageBodies: new Set([
    'account',
    'id',
    'folder',
    'updatedAt',
    'sanitizedAt',
    'trackingPixelCount',
    'blockedRemoteImageCount',
  ]),
  drafts: new Set(['account', 'id', 'folder', 'updatedAt']),
  searchIndex: new Set(['account', 'key', 'updatedAt']),
  indexMeta: new Set(['account', 'key', 'updatedAt']),
  meta: new Set(['key', 'updatedAt']),
  syncManifests: new Set([
    'account',
    'folder',
    'lastUID',
    'lastSyncAt',
    'pagesFetched',
    'messagesFetched',
    'hasBodiesPass',
    'updatedAt',
  ]),
  labels: new Set(['account', 'id', 'name', 'color', 'createdAt', 'updatedAt']),
  settings: new Set(['account', 'updatedAt']),
  settingsLabels: new Set(['account', 'updatedAt']),
  outbox: new Set([
    'account',
    'id',
    'status',
    'retryCount',
    'nextRetryAt',
    'sendAt',
    'createdAt',
    'updatedAt',
  ]),
};

// Sensitive localStorage keys that should be encrypted when lock is enabled
const SENSITIVE_LOCAL_KEYS = new Set([
  'api_key',
  'alias_auth',
  'authToken',
  // PGP keys are stored as pgp_keys_{email} and pgp_passphrases_{email}
]);

const isSensitiveLocalKey = (key) => {
  if (SENSITIVE_LOCAL_KEYS.has(key)) return true;
  if (key.startsWith('pgp_keys_')) return true;
  if (key.startsWith('pgp_passphrases_')) return true;
  return false;
};

let _sodium = null;
let _dek = null; // Data Encryption Key - held in memory only while unlocked
let _initialized = false;
let _enabled = false;

/**
 * Load and initialize libsodium-wrappers.
 * Cached after first call.
 */
async function getSodium() {
  if (_sodium) return _sodium;
  const mod = await import('libsodium-wrappers');
  const sodium = mod.default || mod;
  await sodium.ready;
  _sodium = sodium;
  return sodium;
}

/**
 * Check whether the crypto vault has been set up (i.e. the user has
 * configured a PIN or passkey at least once).
 */
function isVaultConfigured() {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return false;
    const vault = JSON.parse(raw);
    return Boolean(vault && vault.encryptedDek);
  } catch {
    return false;
  }
}

/**
 * Check whether app lock is enabled in user preferences.
 */
function isLockEnabled() {
  try {
    const raw = localStorage.getItem(LOCK_PREFS_KEY);
    if (!raw) return false;
    const prefs = JSON.parse(raw);
    return prefs.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Get lock preferences (timeout, lock-on-minimize, etc.)
 */
function getLockPrefs() {
  try {
    const raw = localStorage.getItem(LOCK_PREFS_KEY);
    if (!raw) {
      return {
        enabled: false,
        timeoutMs: 5 * 60 * 1000, // default 5 minutes
        lockOnMinimize: false,
        pinLength: 6,
        hasPasskey: false,
      };
    }
    return JSON.parse(raw);
  } catch {
    return {
      enabled: false,
      timeoutMs: 5 * 60 * 1000,
      lockOnMinimize: false,
      pinLength: 6,
      hasPasskey: false,
    };
  }
}

/**
 * Save lock preferences.
 */
function setLockPrefs(prefs) {
  try {
    localStorage.setItem(LOCK_PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.error('[crypto-store] Failed to save lock prefs:', err);
  }
}

// =========================================================================
// Key Derivation
// =========================================================================

/**
 * Derive a 256-bit Key Encryption Key from a PIN using Argon2id.
 *
 * @param {string} pin - The user's PIN
 * @param {Uint8Array} salt - 16-byte salt (stored in the vault)
 * @returns {Promise<Uint8Array>} 32-byte KEK
 */
// Argon2id salt length (matches libsodium crypto_pwhash_SALTBYTES)
const ARGON2_SALT_BYTES = 16;

async function deriveKekFromPin(pin, salt) {
  const { argon2id } = await import('hash-wasm');
  if (!pin || typeof pin !== 'string') {
    throw new Error('PIN is required');
  }
  if (!salt || salt.length !== ARGON2_SALT_BYTES) {
    throw new Error('Invalid salt');
  }
  // Argon2id with moderate parameters (matches libsodium OPSLIMIT_MODERATE / MEMLIMIT_MODERATE)
  const hashHex = await argon2id({
    password: pin,
    salt,
    parallelism: 1,
    iterations: 3, // OPSLIMIT_MODERATE
    memorySize: 262144, // MEMLIMIT_MODERATE = 256 MiB in KiB
    hashLength: 32, // crypto_secretbox_KEYBYTES
    outputType: 'hex',
  });
  // Convert hex string to Uint8Array
  const kek = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    kek[i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  return kek;
}

/**
 * Derive a 256-bit KEK from a WebAuthn PRF output.
 *
 * The PRF extension returns a raw secret; we feed it through HKDF
 * (implemented via crypto_generichash / BLAKE2b) to produce a
 * fixed-length key.
 *
 * @param {Uint8Array} prfOutput - Raw PRF secret from WebAuthn
 * @returns {Promise<Uint8Array>} 32-byte KEK
 */
async function deriveKekFromPrf(prfOutput) {
  const sodium = await getSodium();
  if (!prfOutput || prfOutput.length < 16) {
    throw new Error('PRF output too short');
  }
  // BLAKE2b-256 keyed hash acts as a KDF
  return sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    prfOutput,
    // Use a fixed context string as the key for domain separation
    sodium.from_string('ForwardEmail-CryptoStore-KEK-v1'),
  );
}

// =========================================================================
// Vault Management
// =========================================================================

/**
 * Create a new vault: generate a random DEK, encrypt it with the KEK,
 * and store the result in localStorage.
 *
 * @param {Uint8Array} kek - 32-byte Key Encryption Key
 * @returns {Promise<void>}
 */
async function createVault(kek) {
  const sodium = await getSodium();

  // Generate random DEK
  const dek = sodium.crypto_secretbox_keygen();

  // Encrypt DEK with KEK
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encryptedDek = sodium.crypto_secretbox_easy(dek, nonce, kek);

  // Generate a new salt for future PIN derivations
  const salt = sodium.randombytes_buf(ARGON2_SALT_BYTES);

  const vault = {
    encryptedDek: sodium.to_base64(encryptedDek),
    nonce: sodium.to_base64(nonce),
    salt: sodium.to_base64(salt),
    version: 1,
    createdAt: Date.now(),
  };

  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));

  // Hold DEK in memory
  _dek = dek;
  _enabled = true;
  _initialized = true;
}

/**
 * Open an existing vault by decrypting the DEK with the provided KEK.
 *
 * @param {Uint8Array} kek - 32-byte Key Encryption Key
 * @returns {Promise<boolean>} true if unlock succeeded
 */
async function openVault(kek) {
  const sodium = await getSodium();
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) throw new Error('No vault found');

  const vault = JSON.parse(raw);
  if (!vault.encryptedDek || !vault.nonce) {
    throw new Error('Corrupt vault');
  }

  const encryptedDek = sodium.from_base64(vault.encryptedDek);
  const nonce = sodium.from_base64(vault.nonce);

  try {
    const dek = sodium.crypto_secretbox_open_easy(encryptedDek, nonce, kek);
    _dek = dek;
    _enabled = true;
    _initialized = true;
    return true;
  } catch {
    // Wrong PIN / passkey — decryption failed
    return false;
  }
}

/**
 * Get the salt stored in the vault (needed for PIN derivation).
 */
function getVaultSalt() {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const vault = JSON.parse(raw);
    if (!vault.salt) return null;
    // Lazy-load sodium for from_base64
    // Since this is sync and sodium may not be loaded yet, return the base64
    return vault.salt;
  } catch {
    return null;
  }
}

/**
 * Get the vault salt as a Uint8Array (async, loads sodium if needed).
 */
async function getVaultSaltBytes() {
  const sodium = await getSodium();
  const b64 = getVaultSalt();
  if (!b64) return null;
  return sodium.from_base64(b64);
}

/**
 * Lock the app: wipe the DEK from memory.
 */
function lock() {
  if (_dek) {
    // Best-effort memory wipe
    try {
      _dek.fill(0);
    } catch {
      // Uint8Array.fill may throw in some edge cases
    }
    _dek = null;
  }
}

/**
 * Check if the store is currently unlocked (DEK in memory).
 */
function isUnlocked() {
  return _dek !== null && _enabled;
}

/**
 * Check if encryption is enabled and initialized.
 */
function isEnabled() {
  return _enabled && _initialized;
}

// =========================================================================
// Setup Flows
// =========================================================================

/**
 * Set up app lock with a PIN.
 * Creates the vault and encrypts the DEK.
 *
 * @param {string} pin - User's chosen PIN
 * @returns {Promise<void>}
 */
async function setupWithPin(pin) {
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(ARGON2_SALT_BYTES);

  // Temporarily store salt for createVault
  const tempVault = {
    salt: sodium.to_base64(salt),
    version: 1,
    createdAt: Date.now(),
  };
  localStorage.setItem(VAULT_KEY, JSON.stringify(tempVault));

  const kek = await deriveKekFromPin(pin, salt);
  await createVault(kek);

  // Re-encrypt the vault with the correct salt
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encryptedDek = sodium.crypto_secretbox_easy(_dek, nonce, kek);

  const vault = {
    encryptedDek: sodium.to_base64(encryptedDek),
    nonce: sodium.to_base64(nonce),
    salt: sodium.to_base64(salt),
    version: 1,
    createdAt: Date.now(),
  };
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));

  // Encrypt existing sensitive localStorage values
  await encryptExistingLocalStorage();
}

/**
 * Set up or add passkey unlock (WebAuthn PRF).
 *
 * If a vault already exists and is unlocked (DEK in memory), the existing
 * DEK is re-wrapped with the passkey-derived KEK and stored as a second
 * envelope (`passkeyEncryptedDek`) alongside the PIN envelope. This
 * allows both PIN and passkey to unlock the same underlying DEK.
 *
 * If no vault exists yet, a fresh vault is created (passkey-only mode).
 *
 * @param {Uint8Array} prfOutput - PRF secret from WebAuthn authentication
 * @returns {Promise<void>}
 */
async function setupWithPasskey(prfOutput) {
  const sodium = await getSodium();
  const kek = await deriveKekFromPrf(prfOutput);

  if (_dek && isVaultConfigured()) {
    // Vault already exists and is unlocked — add passkey as additional unlock
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const encryptedDek = sodium.crypto_secretbox_easy(_dek, nonce, kek);

    const raw = localStorage.getItem(VAULT_KEY);
    const vault = JSON.parse(raw);
    vault.passkeyEncryptedDek = sodium.to_base64(encryptedDek);
    vault.passkeyNonce = sodium.to_base64(nonce);
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } else {
    // No vault yet — create one from scratch with passkey
    await createVault(kek);
    await encryptExistingLocalStorage();
  }
}

/**
 * Unlock with PIN.
 *
 * @param {string} pin - User's PIN
 * @returns {Promise<boolean>} true if unlock succeeded
 */
async function unlockWithPin(pin) {
  const salt = await getVaultSaltBytes();
  if (!salt) throw new Error('No vault salt found');
  const kek = await deriveKekFromPin(pin, salt);
  return openVault(kek);
}

/**
 * Unlock with passkey PRF output.
 *
 * Checks for a passkey-specific envelope (`passkeyEncryptedDek`) first.
 * Falls back to the main envelope for passkey-only vaults.
 *
 * @param {Uint8Array} prfOutput - PRF secret from WebAuthn authentication
 * @returns {Promise<boolean>} true if unlock succeeded
 */
async function unlockWithPasskey(prfOutput) {
  const sodium = await getSodium();
  const kek = await deriveKekFromPrf(prfOutput);

  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) throw new Error('No vault found');
  const vault = JSON.parse(raw);

  // Try passkey-specific envelope first (dual-unlock vault)
  if (vault.passkeyEncryptedDek && vault.passkeyNonce) {
    try {
      const encDek = sodium.from_base64(vault.passkeyEncryptedDek);
      const nonce = sodium.from_base64(vault.passkeyNonce);
      const dek = sodium.crypto_secretbox_open_easy(encDek, nonce, kek);
      if (dek) {
        _dek = dek;
        _enabled = true;
        _initialized = true;
        return true;
      }
    } catch {
      // Decryption failed — wrong PRF or corrupted envelope
      return false;
    }
  }

  // Fallback: try the main envelope (passkey-only vault without separate envelope)
  return openVault(kek);
}

/**
 * Change the PIN (re-encrypt the DEK with a new KEK).
 *
 * @param {string} oldPin - Current PIN
 * @param {string} newPin - New PIN
 * @returns {Promise<boolean>} true if change succeeded
 */
async function changePin(oldPin, newPin) {
  const sodium = await getSodium();

  // Verify old PIN
  const oldSalt = await getVaultSaltBytes();
  if (!oldSalt) throw new Error('No vault found');
  const oldKek = await deriveKekFromPin(oldPin, oldSalt);
  const unlocked = await openVault(oldKek);
  if (!unlocked) return false;

  // Re-encrypt with new PIN
  const newSalt = sodium.randombytes_buf(ARGON2_SALT_BYTES);
  const newKek = await deriveKekFromPin(newPin, newSalt);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encryptedDek = sodium.crypto_secretbox_easy(_dek, nonce, newKek);

  const vault = {
    encryptedDek: sodium.to_base64(encryptedDek),
    nonce: sodium.to_base64(nonce),
    salt: sodium.to_base64(newSalt),
    version: 1,
    createdAt: Date.now(),
  };
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  return true;
}

/**
 * Remove the passkey envelope from the vault without affecting PIN unlock.
 * Called when the user removes their passkey from settings.
 */
function removePasskeyEnvelope() {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return;
    const vault = JSON.parse(raw);
    delete vault.passkeyEncryptedDek;
    delete vault.passkeyNonce;
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } catch {
    // ignore
  }
}

/**
 * Disable app lock entirely. Decrypts all data and removes the vault.
 *
 * @returns {Promise<void>}
 */
async function disableLock() {
  if (_dek) {
    await decryptExistingLocalStorage();
  }
  localStorage.removeItem(VAULT_KEY);
  lock();
  _enabled = false;
  _initialized = false;
  setLockPrefs({ ...getLockPrefs(), enabled: false });
}

// =========================================================================
// Data Encryption / Decryption
// =========================================================================

/**
 * Encrypt a value using the DEK.
 * Returns a base64 string prefixed with ENCRYPTED_PREFIX.
 *
 * @param {*} value - Any JSON-serializable value
 * @returns {string} Encrypted string
 */
function encryptValue(value) {
  if (!_dek) throw new Error('Store is locked');
  if (value === null || value === undefined) return value;

  const sodium = _sodium;
  if (!sodium) throw new Error('Sodium not initialized');

  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, _dek);

  // Pack nonce + ciphertext and base64-encode
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);

  return ENCRYPTED_PREFIX + sodium.to_base64(packed);
}

/**
 * Decrypt a value that was encrypted with encryptValue.
 *
 * @param {string} encrypted - Encrypted string (with ENCRYPTED_PREFIX)
 * @returns {*} Decrypted value (parsed from JSON if applicable)
 */
function decryptValue(encrypted) {
  if (!_dek) throw new Error('Store is locked');
  if (encrypted === null || encrypted === undefined) return encrypted;
  if (typeof encrypted !== 'string') return encrypted;
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) return encrypted;

  const sodium = _sodium;
  if (!sodium) throw new Error('Sodium not initialized');

  const b64 = encrypted.slice(ENCRYPTED_PREFIX.length);
  const packed = sodium.from_base64(b64);

  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  if (packed.length < nonceLen + 1) {
    throw new Error('Encrypted data too short');
  }

  const nonce = packed.slice(0, nonceLen);
  const ciphertext = packed.slice(nonceLen);

  const plaintext = sodium.to_string(sodium.crypto_secretbox_open_easy(ciphertext, nonce, _dek));

  // Try to parse as JSON; if it fails, return the raw string
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

/**
 * Check if a value is encrypted.
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

// =========================================================================
// IndexedDB Record Encryption
// =========================================================================

/**
 * Encrypt non-indexed fields of a database record.
 *
 * @param {string} table - Table name
 * @param {Object} record - The record to encrypt
 * @returns {Object} Record with sensitive fields encrypted
 */
function encryptRecord(table, record) {
  if (!_enabled || !_dek || !record) return record;

  const indexFields = INDEX_FIELDS_BY_TABLE[table];
  if (!indexFields) return record; // Unknown table, don't encrypt

  const encrypted = {};
  for (const [key, value] of Object.entries(record)) {
    if (indexFields.has(key) || value === null || value === undefined) {
      encrypted[key] = value;
    } else {
      encrypted[key] = encryptValue(value);
    }
  }
  return encrypted;
}

/**
 * Decrypt non-indexed fields of a database record.
 *
 * @param {string} table - Table name
 * @param {Object} record - The record to decrypt
 * @returns {Object} Record with sensitive fields decrypted
 */
function decryptRecord(table, record) {
  if (!_enabled || !_dek || !record) return record;

  const indexFields = INDEX_FIELDS_BY_TABLE[table];
  if (!indexFields) return record;

  const decrypted = {};
  for (const [key, value] of Object.entries(record)) {
    if (indexFields.has(key) || !isEncrypted(value)) {
      decrypted[key] = value;
    } else {
      try {
        decrypted[key] = decryptValue(value);
      } catch (err) {
        console.error(`[crypto-store] Failed to decrypt field ${table}.${key}:`, err);
        decrypted[key] = value; // Return encrypted value on failure
      }
    }
  }
  return decrypted;
}

/**
 * Encrypt an array of records.
 */
function encryptRecords(table, records) {
  if (!_enabled || !_dek || !Array.isArray(records)) return records;
  return records.map((r) => encryptRecord(table, r));
}

/**
 * Decrypt an array of records.
 */
function decryptRecords(table, records) {
  if (!_enabled || !_dek || !Array.isArray(records)) return records;
  return records.map((r) => decryptRecord(table, r));
}

// =========================================================================
// localStorage Encryption
// =========================================================================

/**
 * Encrypt all existing sensitive localStorage values.
 * Called once during setup.
 */
async function encryptExistingLocalStorage() {
  if (!_dek) return;
  const prefix = 'webmail_';
  for (let i = 0; i < localStorage.length; i++) {
    const fullKey = localStorage.key(i);
    if (!fullKey || !fullKey.startsWith(prefix)) continue;
    const key = fullKey.slice(prefix.length);
    if (!isSensitiveLocalKey(key)) continue;

    const value = localStorage.getItem(fullKey);
    if (value && !isEncrypted(value)) {
      try {
        localStorage.setItem(fullKey, encryptValue(value));
      } catch (err) {
        console.error(`[crypto-store] Failed to encrypt localStorage key ${key}:`, err);
      }
    }
  }
}

/**
 * Decrypt all sensitive localStorage values back to plaintext.
 * Called when disabling lock.
 */
async function decryptExistingLocalStorage() {
  if (!_dek) return;
  const prefix = 'webmail_';
  for (let i = 0; i < localStorage.length; i++) {
    const fullKey = localStorage.key(i);
    if (!fullKey || !fullKey.startsWith(prefix)) continue;
    const key = fullKey.slice(prefix.length);
    if (!isSensitiveLocalKey(key)) continue;

    const value = localStorage.getItem(fullKey);
    if (value && isEncrypted(value)) {
      try {
        const decrypted = decryptValue(value);
        localStorage.setItem(
          fullKey,
          typeof decrypted === 'string' ? decrypted : JSON.stringify(decrypted),
        );
      } catch (err) {
        console.error(`[crypto-store] Failed to decrypt localStorage key ${key}:`, err);
      }
    }
  }
}

/**
 * Read a sensitive localStorage value, decrypting if necessary.
 */
function readSensitiveLocal(key) {
  const prefix = 'webmail_';
  const value = localStorage.getItem(`${prefix}${key}`);
  if (!value) return value;
  if (isEncrypted(value) && _dek) {
    try {
      return decryptValue(value);
    } catch {
      return null; // Cannot decrypt — locked or wrong key
    }
  }
  return value;
}

/**
 * Write a sensitive localStorage value, encrypting if lock is enabled.
 */
function writeSensitiveLocal(key, value) {
  const prefix = 'webmail_';
  if (_enabled && _dek && isSensitiveLocalKey(key)) {
    localStorage.setItem(`${prefix}${key}`, encryptValue(value));
  } else {
    localStorage.setItem(`${prefix}${key}`, value);
  }
}

// =========================================================================
// Re-encryption (for migrating existing unencrypted data)
// =========================================================================

/**
 * Re-encrypt all existing IndexedDB data.
 * This is called after initial setup to encrypt data that was previously
 * stored in plaintext. It must be called from the db worker context
 * or via a message to the db worker.
 *
 * Returns a function that the db worker can call for each table.
 */
function createReEncryptor() {
  if (!_enabled || !_dek) {
    return null;
  }

  return {
    shouldEncrypt: (table, record) => {
      if (!record) return false;
      const indexFields = INDEX_FIELDS_BY_TABLE[table];
      if (!indexFields) return false;
      // Check if any non-index field is not yet encrypted
      for (const [key, value] of Object.entries(record)) {
        if (!indexFields.has(key) && value !== null && value !== undefined && !isEncrypted(value)) {
          return true;
        }
      }
      return false;
    },
    encrypt: (table, record) => encryptRecord(table, record),
  };
}

// =========================================================================
// Exports
// =========================================================================

export {
  // Initialization & status
  isVaultConfigured,
  isLockEnabled,
  isUnlocked,
  isEnabled,
  getSodium,

  // Lock preferences
  getLockPrefs,
  setLockPrefs,

  // Setup flows
  setupWithPin,
  setupWithPasskey,

  // Unlock flows
  unlockWithPin,
  unlockWithPasskey,

  // Lock & key management
  lock,
  changePin,
  disableLock,
  removePasskeyEnvelope,

  // Vault info
  getVaultSalt,
  getVaultSaltBytes,

  // Data encryption (for db worker integration)
  encryptRecord,
  decryptRecord,
  encryptRecords,
  decryptRecords,
  encryptValue,
  decryptValue,
  isEncrypted,

  // localStorage encryption
  readSensitiveLocal,
  writeSensitiveLocal,
  isSensitiveLocalKey,

  // Re-encryption
  createReEncryptor,

  // Key derivation (exposed for passkey-auth module)
  deriveKekFromPin,
  deriveKekFromPrf,
  openVault,
};
