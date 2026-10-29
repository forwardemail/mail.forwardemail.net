/**
 * Generate a PGP key pair for the signed-in address.
 *
 * Version 4 keys on Curve25519 (EdDSA signing, ECDH encryption). openpgp's
 * newer RFC 9580 version 6 keys are not read by GnuPG 2.2/2.4 or by most
 * clients yet, so a v6 key would leave the user with a key nobody can encrypt
 * to. openpgp is loaded on demand; it is large, and only this screen needs it
 * on the main thread.
 */

export interface GeneratedPgpKey {
  privateKey: string;
  publicKey: string;
  revocationCertificate: string;
  fingerprint: string;
}

export const MIN_PASSPHRASE_LENGTH = 8;

export async function generatePgpKeyPair({
  name,
  email,
  passphrase,
}: {
  name?: string;
  email: string;
  passphrase: string;
}): Promise<GeneratedPgpKey> {
  const address = String(email || '').trim();
  if (!address.includes('@')) throw new Error('A key needs the email address it belongs to.');
  if (String(passphrase || '').length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }

  const openpgp = await import('openpgp');
  const displayName = String(name || '').trim();
  const { privateKey, publicKey, revocationCertificate } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [displayName ? { name: displayName, email: address } : { email: address }],
    passphrase,
    format: 'armored',
  });
  const parsed = await openpgp.readKey({ armoredKey: publicKey });
  return {
    privateKey,
    publicKey,
    revocationCertificate,
    fingerprint: parsed.getFingerprint().toUpperCase(),
  };
}
