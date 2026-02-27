/**
 * Passkey Authentication Module
 *
 * Provides WebAuthn passkey registration and authentication using
 * @passwordless-id/webauthn (https://github.com/passwordless-id/webauthn).
 * Supports the PRF extension to derive encryption keys directly from
 * passkey authentication, enabling the crypto-store to unlock without a PIN.
 *
 * Flow:
 *   1. Registration: user creates a passkey → immediately authenticates
 *      with it to obtain PRF output → crypto-store vault is created
 *      with PRF-derived KEK. (PRF outputs are only available during
 *      authentication/get, not registration/create.)
 *   2. Authentication: user authenticates with passkey → PRF secret
 *      is extracted → crypto-store vault is unlocked
 *
 * The credential ID and public key are stored in localStorage so
 * that authentication can present the correct allowCredentials list.
 *
 * Security considerations:
 *   - Credentials are scoped to the current origin (RP ID)
 *   - PRF salt is a fixed, per-vault value (stored alongside credential)
 *   - Challenge is always a fresh random value (replay protection)
 *   - User verification is required for both registration and auth
 *
 * @passwordless-id/webauthn API notes:
 *   - The library's register() and authenticate() accept a `customProperties`
 *     object that is spread into the underlying publicKey options. This is
 *     how we pass the PRF `extensions` to the browser's WebAuthn API.
 *   - Challenges must be base64url-encoded (no padding).
 */

import { client } from '@passwordless-id/webauthn';
import { getSodium } from './crypto-store.js';

const PASSKEY_CREDENTIAL_KEY = 'webmail_passkey_credential';
const PRF_SALT_KEY = 'webmail_passkey_prf_salt';

// Fixed PRF salt label for domain separation
const PRF_SALT_LABEL = 'ForwardEmail-AppLock-PRF-v1';

/**
 * Check if WebAuthn is available in this environment.
 */
function isWebAuthnAvailable() {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  );
}

/**
 * Check if the platform supports the PRF extension.
 * This is needed for passkey-based encryption key derivation.
 */
/* global PublicKeyCredential */
async function isPrfSupported() {
  if (!isWebAuthnAvailable()) return false;
  try {
    // Check if PublicKeyCredential.getClientCapabilities exists (Chrome 133+)
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities();
      // Chrome uses 'extension:prf', spec also allows 'prf' or 'hmac-secret'
      return (
        caps?.['extension:prf'] === true || caps?.prf === true || caps?.['hmac-secret'] === true
      );
    }
    // Fallback: assume PRF might be supported and let registration fail gracefully
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a passkey credential has been registered.
 */
function hasPasskeyCredential() {
  try {
    const raw = localStorage.getItem(PASSKEY_CREDENTIAL_KEY);
    return raw !== null;
  } catch {
    return false;
  }
}

/**
 * Get the stored passkey credential.
 */
function getStoredCredential() {
  try {
    const raw = localStorage.getItem(PASSKEY_CREDENTIAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Generate a cryptographically random challenge as base64url (no padding).
 * @passwordless-id/webauthn requires the challenge to be base64url-encoded.
 */
async function generateChallenge() {
  const sodium = await getSodium();
  const bytes = sodium.randombytes_buf(32);
  // Use URLSAFE_NO_PADDING variant for @passwordless-id/webauthn compatibility
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Get or create the PRF salt for this device.
 * The salt is stored in localStorage and used as the PRF input
 * during both registration and authentication.
 * Returns a Uint8Array suitable for the PRF extension's eval.first field.
 */
async function getPrfSalt() {
  const sodium = await getSodium();
  let b64 = localStorage.getItem(PRF_SALT_KEY);
  if (!b64) {
    const salt = sodium.randombytes_buf(32);
    b64 = sodium.to_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING);
    localStorage.setItem(PRF_SALT_KEY, b64);
  }
  // Combine the fixed label with the per-device salt and return as Uint8Array
  // The PRF extension expects a BufferSource (ArrayBuffer or TypedArray)
  return sodium.from_string(PRF_SALT_LABEL + b64);
}

/**
 * Build the PRF extensions object for the WebAuthn API.
 * This is passed via customProperties so @passwordless-id/webauthn
 * spreads it into the publicKey options.
 *
 * @param {Uint8Array} prfSalt - The PRF salt as a Uint8Array
 * @returns {Object} customProperties with extensions.prf
 */
function buildPrfCustomProperties(prfSalt) {
  return {
    extensions: {
      prf: {
        eval: {
          first: prfSalt,
        },
      },
    },
  };
}

/**
 * Extract the PRF output from a WebAuthn response's clientExtensionResults.
 *
 * @param {Object} clientExtensionResults - The extension results from the credential
 * @param {Object} sodium - The loaded libsodium instance
 * @returns {Uint8Array|null} The PRF output bytes, or null if not available
 */
function extractPrfOutput(clientExtensionResults, sodium) {
  const prfResults = clientExtensionResults?.prf?.results;
  if (!prfResults?.first) return null;

  const prfResult = prfResults.first;
  if (prfResult instanceof ArrayBuffer) {
    return new Uint8Array(prfResult);
  }
  if (ArrayBuffer.isView(prfResult)) {
    return new Uint8Array(prfResult.buffer, prfResult.byteOffset, prfResult.byteLength);
  }
  if (typeof prfResult === 'string') {
    // Some implementations return base64url-encoded strings
    try {
      return sodium.from_base64(prfResult, sodium.base64_variants.URLSAFE_NO_PADDING);
    } catch {
      return sodium.from_base64(prfResult);
    }
  }
  return null;
}

/**
 * Register a new passkey for app lock.
 *
 * Step 1: Register the credential (WebAuthn create). PRF is requested via
 *         extensions so the authenticator knows to enable it, but the actual
 *         PRF output is NOT returned during registration.
 * Step 2: Immediately authenticate with the new credential (WebAuthn get)
 *         to obtain the PRF output needed for key derivation.
 *
 * @param {string} displayName - Display name for the credential (e.g. user's email)
 * @returns {Promise<{credential: Object, prfOutput: Uint8Array|null}>}
 */
async function registerPasskey(displayName) {
  if (!isWebAuthnAvailable()) {
    throw new Error('WebAuthn is not available in this environment');
  }

  await getSodium();
  const challenge = await generateChallenge();
  const prfSalt = await getPrfSalt();

  // Step 1: Register the credential with PRF extension enabled
  const registration = await client.register({
    user: displayName || 'Forward Email User',
    challenge,
    hints: ['client-device'],
    userVerification: 'required',
    discoverable: 'preferred',
    customProperties: buildPrfCustomProperties(prfSalt),
  });

  // Store credential info for the immediate authentication step
  const credentialData = {
    id: registration.id,
    publicKey: registration.response?.publicKey || null,
    algorithm: registration.response?.publicKeyAlgorithm || null,
    transports: registration.response?.transports || [],
    registeredAt: Date.now(),
  };
  localStorage.setItem(PASSKEY_CREDENTIAL_KEY, JSON.stringify(credentialData));

  // Step 2: Immediately authenticate to obtain the PRF output.
  // PRF secrets are only returned during authentication (get), not
  // registration (create). This is a second biometric/PIN prompt.
  let prfOutput = null;
  try {
    const authResult = await authenticatePasskey();
    prfOutput = authResult.prfOutput;
  } catch (err) {
    // If the follow-up authentication fails, clean up the stored credential
    // so the user isn't left in a half-registered state.
    localStorage.removeItem(PASSKEY_CREDENTIAL_KEY);
    throw new Error(
      'Passkey was registered but PRF authentication failed. Please try again. ' +
        (err?.message || ''),
    );
  }

  return { credential: credentialData, prfOutput };
}

/**
 * Authenticate with an existing passkey.
 *
 * Uses @passwordless-id/webauthn's client.authenticate() with the PRF extension
 * passed via customProperties.
 *
 * @returns {Promise<{success: boolean, prfOutput: Uint8Array|null}>}
 */
async function authenticatePasskey() {
  if (!isWebAuthnAvailable()) {
    throw new Error('WebAuthn is not available in this environment');
  }

  const sodium = await getSodium();
  const challenge = await generateChallenge();
  const prfSalt = await getPrfSalt();
  const stored = getStoredCredential();

  const authOptions = {
    challenge,
    userVerification: 'required',
    // PRF extension must go through customProperties to reach the WebAuthn API
    customProperties: buildPrfCustomProperties(prfSalt),
  };

  // If we have a stored credential, use allowCredentials
  // @passwordless-id/webauthn accepts either string IDs or {id, transports} objects
  if (stored?.id) {
    authOptions.allowCredentials = [
      {
        id: stored.id,
        transports: stored.transports || [],
      },
    ];
  }

  const authentication = await client.authenticate(authOptions);

  // Extract PRF output
  const prfOutput = extractPrfOutput(authentication.clientExtensionResults, sodium);

  return { success: true, prfOutput };
}

/**
 * Remove the stored passkey credential.
 */
function removePasskeyCredential() {
  localStorage.removeItem(PASSKEY_CREDENTIAL_KEY);
  localStorage.removeItem(PRF_SALT_KEY);
}

export {
  isWebAuthnAvailable,
  isPrfSupported,
  hasPasskeyCredential,
  getStoredCredential,
  registerPasskey,
  authenticatePasskey,
  removePasskeyCredential,
  generateChallenge,
};
