/**
 * Decrypt and sign with the system GnuPG (desktop app only), for a key on a
 * hardware token such as a YubiKey.
 *
 * Such a key never leaves the token, so the worker's openpgp.js cannot use
 * it. The desktop app can hand the message to the local `gpg`
 * (src-tauri/src/gpg.rs), whose gpg-agent talks to the token. The user turns
 * this on per device in Settings ("Use a YubiKey or smartcard").
 *
 * That setting is kept here in the webview, so the native side does not rely
 * on it: its gpg commands stay off until the user agrees in a native dialog
 * (gpg_set_allowed). Otherwise any script that got to run in this page could
 * decrypt and sign with the keys gpg holds.
 *
 * The PIN: gpg-agent's own pinentry is tried first (it may already hold the
 * PIN, or show a graphical prompt). When that pinentry cannot run in a GUI
 * app (a terminal-only pinentry), the caller's `askPin` asks for it and gpg
 * gets it through loopback pinentry. The PIN is never stored.
 *
 * Only the armored ciphertext crosses into Rust; the worker finds it in a
 * PGP/MIME message and parses the plaintext gpg returns, as it does for its
 * own decryptions.
 */
import { isTauriDesktop } from './platform.js';
import { Accounts, Local } from './storage.js';
import { requestPgpBlock, requestParseDecrypted } from './sync-worker-client.js';
import type { Attachment, PgpSignatureCheck } from '../types';

export interface SystemGpgResult {
  success: boolean;
  body?: string;
  textContent?: string;
  textPart?: string;
  attachments?: Attachment[];
  subject?: string;
  signed?: boolean;
  signature?: PgpSignatureCheck | null;
  reason?: string;
  message?: string;
}

interface GpgDecryptResponse {
  plaintext: string;
  signatureStatus: PgpSignatureCheck['status'] | null;
  signer: string | null;
}

interface GpgError {
  code: string;
  message: string;
}

interface GpgCardInfo {
  present: boolean;
  pinRetries: number | null;
}

/** Ask the user for the card PIN; null when they cancel. */
export type AskPin = (request: {
  retries: number | null;
  error?: string;
}) => Promise<string | null>;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const settingKey = (account: string) => `pgp_use_system_gpg_${account}`;

/** Whether the user turned on the YubiKey / smartcard option for `account`. */
export function systemGpgEnabled(account: string): boolean {
  if (!isTauriDesktop || !account) return false;
  return Local.get(settingKey(account)) === 'true';
}

function accountsOnThisDevice(): string[] {
  try {
    const list = (Accounts?.getAll?.() || []) as Array<{ email?: string }>;
    return list.map((entry) => entry?.email || '').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Turn the option on or off for `account`. Turning it on asks the user in a
 * native dialog, once per device. Returns whether it is on afterwards, which
 * is false when they declined.
 */
export async function setSystemGpgEnabled(account: string, enabled: boolean): Promise<boolean> {
  if (!account) return false;
  if (!enabled) {
    Local.remove(settingKey(account));
    // The native switch is for the whole app. It stays on while another
    // account on this device still uses the token.
    const stillUsed = accountsOnThisDevice().some(
      (other) => other !== account && Local.get(settingKey(other)) === 'true',
    );
    if (!stillUsed && isTauriDesktop) {
      try {
        const invoke = await getInvoke();
        await invoke<boolean>('gpg_set_allowed', { allowed: false });
      } catch (err) {
        console.warn('[pgp-system-gpg] could not turn gpg off on the native side:', err);
      }
    }
    return false;
  }
  if (!isTauriDesktop) return false;
  let allowed = false;
  try {
    const invoke = await getInvoke();
    allowed = (await invoke<boolean>('gpg_set_allowed', { allowed: true })) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) return false;
  Local.set(settingKey(account), 'true');
  return true;
}

let available: Promise<boolean> | null = null;

async function getInvoke(): Promise<Invoke> {
  // Imported lazily: in web builds the Tauri API is external (see device-seal.ts).
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as Invoke;
}

/** Whether this is the desktop app and a gpg binary was found. Cached. */
export function systemGpgAvailable(): Promise<boolean> {
  if (!isTauriDesktop) return Promise.resolve(false);
  if (!available) {
    available = getInvoke()
      .then((invoke) => invoke<boolean>('gpg_available'))
      .catch(() => false);
  }
  return available;
}

export function signatureFromGpg(res: GpgDecryptResponse): {
  signed: boolean;
  signature: PgpSignatureCheck | null;
} {
  if (!res.signatureStatus) return { signed: false, signature: null };
  return {
    signed: true,
    signature: {
      status: res.signatureStatus,
      signers: res.signer ? [res.signer] : [],
    },
  };
}

function asGpgError(err: unknown): GpgError {
  if (err && typeof err === 'object' && 'code' in err) {
    const e = err as Partial<GpgError>;
    return { code: String(e.code), message: String(e.message || '') };
  }
  return { code: 'failed', message: String(err) };
}

export const NO_CARD_MESSAGE = 'Insert your YubiKey or smartcard, then choose Retry Decryption.';

function failure(err: GpgError): SystemGpgResult {
  switch (err.code) {
    case 'no_card':
      return { success: false, reason: 'no_card', message: NO_CARD_MESSAGE };
    case 'no_secret_key':
      return {
        success: false,
        reason: 'no_secret_key',
        message:
          'This message is not encrypted to your YubiKey, smartcard or any key in your GnuPG keyring.',
      };
    case 'not_allowed':
      // The option is on here but was never confirmed on this computer (a
      // restored profile, or the confirmation was withdrawn)
      return {
        success: false,
        reason: 'not_allowed',
        message:
          'GnuPG is turned off for this app. In Settings, turn "Use a YubiKey or smartcard (GnuPG)" off and on again.',
      };
    default:
      return { success: false, reason: err.code, message: err.message || 'gpg could not decrypt' };
  }
}

async function cardInfo(invoke: Invoke): Promise<GpgCardInfo> {
  try {
    return await invoke<GpgCardInfo>('gpg_card_info');
  } catch {
    return { present: false, pinRetries: null };
  }
}

function retriesText(retries: number | null): string {
  if (retries == null) return '';
  return retries === 1
    ? ' 1 try left before the card blocks the PIN.'
    : ` ${retries} tries left before the card blocks the PIN.`;
}

type PinOutcome<T> = { ok: true; value: T } | { ok: false; result: SystemGpgResult };

/**
 * Run a gpg operation that may need the card PIN: first with gpg-agent's own
 * pinentry, then, when that cannot run here, with a PIN from `askPin`, asked
 * again after a wrong one with the tries left.
 */
async function withCardPin<T>(
  invoke: Invoke,
  run: (pin: string | null) => Promise<T>,
  askPin?: AskPin,
): Promise<PinOutcome<T>> {
  try {
    return { ok: true, value: await run(null) };
  } catch (err) {
    const gpgErr = asGpgError(err);
    if (gpgErr.code !== 'pinentry') return { ok: false, result: failure(gpgErr) };

    // gpg-agent's pinentry could not run here. Ask for the PIN ourselves,
    // after checking a card is there to ask it for.
    const card = await cardInfo(invoke);
    if (!card.present) return { ok: false, result: failure({ code: 'no_card', message: '' }) };
    if (card.pinRetries === 0) {
      return {
        ok: false,
        result: {
          success: false,
          reason: 'pin_blocked',
          message: 'The card PIN is blocked. Unblock it with your admin PIN or reset code.',
        },
      };
    }
    if (!askPin) return { ok: false, result: failure(gpgErr) };

    let retries = card.pinRetries;
    let error: string | undefined;
    for (;;) {
      const pin = await askPin({ retries, error });
      if (!pin) {
        return {
          ok: false,
          result: { success: false, reason: 'cancelled', message: 'PIN entry cancelled.' },
        };
      }
      try {
        return { ok: true, value: await run(pin) };
      } catch (retryErr) {
        const e = asGpgError(retryErr);
        if (e.code !== 'bad_pin') return { ok: false, result: failure(e) };
        retries = (await cardInfo(invoke)).pinRetries;
        if (retries === 0) {
          return {
            ok: false,
            result: {
              success: false,
              reason: 'pin_blocked',
              message: 'Wrong PIN. The card PIN is now blocked.',
            },
          };
        }
        error = `Wrong PIN.${retriesText(retries)}`;
      }
    }
  }
}

const NOT_FOUND: SystemGpgResult = {
  success: false,
  reason: 'unavailable',
  message: 'GnuPG (gpg) was not found on this computer.',
};

/**
 * Decrypt `raw` (inline armor or a whole PGP/MIME message) with the system
 * gpg. The token may wait for a PIN or a touch, so background work passes
 * `allowPrompt: false` and this then does nothing.
 */
export async function decryptWithSystemGpg(
  raw: string,
  { allowPrompt = true, askPin }: { allowPrompt?: boolean; askPin?: AskPin } = {},
): Promise<SystemGpgResult> {
  if (!allowPrompt) return { success: false, reason: 'prompt_not_allowed' };
  if (!raw || !(await systemGpgAvailable())) return NOT_FOUND;

  const found = await requestPgpBlock(raw).catch(() => null);
  if (!found?.success || !found.block) {
    return { success: false, reason: 'no_armor', message: found?.error };
  }

  const invoke = await getInvoke();
  const outcome = await withCardPin(
    invoke,
    (pin) => invoke<GpgDecryptResponse>('gpg_decrypt', { armored: found.block, pin }),
    askPin,
  );
  if (!outcome.ok) return outcome.result;
  const res = outcome.value;
  if (!res) return failure({ code: 'failed', message: 'gpg returned nothing' });

  const { signed, signature } = signatureFromGpg(res);
  const parsed = await requestParseDecrypted({ plaintext: res.plaintext, signed, signature });
  if (!parsed?.success) {
    return { success: false, reason: 'parse_failed', message: parsed?.message };
  }
  return {
    success: true,
    body: parsed.body,
    textContent: parsed.textContent,
    textPart: typeof parsed.textPart === 'string' ? parsed.textPart : '',
    attachments: parsed.attachments,
    subject: typeof parsed.subject === 'string' ? parsed.subject : undefined,
    signed,
    signature,
  };
}

export interface SystemGpgSignResult {
  success: boolean;
  /** A detached signature, or with recipient keys the encrypted message. */
  armored?: string;
  /** RFC 3156 micalg for a detached signature, e.g. "pgp-sha512". */
  micalg?: string;
  reason?: string;
  message?: string;
}

/**
 * Sign an outgoing message with the system gpg, as `signer` (the From
 * address; gpg's default key when the keyring has none for it). With
 * `recipientKeys` (armored public keys) the message is also encrypted to
 * them, in one OpenPGP message, as the app does with its own keys.
 */
export async function signWithSystemGpg({
  data,
  signer,
  recipientKeys = [],
  askPin,
}: {
  data: string;
  signer: string;
  recipientKeys?: string[];
  askPin?: AskPin;
}): Promise<SystemGpgSignResult> {
  if (!data || !(await systemGpgAvailable())) return NOT_FOUND;
  const invoke = await getInvoke();
  const outcome = await withCardPin(
    invoke,
    (pin) =>
      invoke<{ armored: string; micalg: string | null }>('gpg_sign', {
        data,
        signer,
        recipientKeys,
        pin,
      }),
    askPin,
  );
  if (!outcome.ok) {
    const { reason, message } = outcome.result;
    if (reason === 'no_secret_key') {
      return {
        success: false,
        reason,
        message: `No secret key in your GnuPG keyring or YubiKey to sign as ${signer}.`,
      };
    }
    return { success: false, reason, message };
  }
  const res = outcome.value;
  if (!res?.armored) return { success: false, reason: 'failed', message: 'gpg returned nothing' };
  return { success: true, armored: res.armored, micalg: res.micalg || undefined };
}

/**
 * Check a signed-only message's signature against the user's GnuPG keyring,
 * where a token user keeps their own and their contacts' public keys. Null
 * when gpg is not available or could not check it.
 */
export async function verifyWithSystemGpg({
  signed,
  signature,
}: {
  signed: string;
  signature: string;
}): Promise<PgpSignatureCheck | null> {
  if (!signed || !signature || !(await systemGpgAvailable())) return null;
  try {
    const invoke = await getInvoke();
    const res = await invoke<{
      signatureStatus: PgpSignatureCheck['status'] | null;
      signer: string | null;
    }>('gpg_verify', { signed, signature });
    if (!res?.signatureStatus) return null;
    return signatureFromGpg({ plaintext: '', ...res }).signature;
  } catch {
    return null;
  }
}

export { retriesText as pinRetriesText };
