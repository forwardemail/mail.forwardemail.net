/**
 * Decrypting through the system gpg, for a key on a hardware token (YubiKey)
 * the app cannot hold. gpg can show a PIN prompt, so it must never run for
 * background work, and only the armored block may cross into Rust. When
 * gpg-agent's pinentry cannot run, the app asks for the PIN, and a wrong PIN
 * must say how many tries the card has left.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  desktop: true,
  store: new Map<string, string>(),
  invoke: vi.fn(),
  accounts: [] as Array<{ email: string }>,
  // What the user answers in the native "Allow GnuPG?" dialog
  userAllows: true,
  requestPgpBlock: vi.fn(),
  requestParseDecrypted: vi.fn(),
}));

vi.mock('../../src/utils/platform.js', () => ({
  get isTauriDesktop() {
    return hoisted.desktop;
  },
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (k: string) => hoisted.store.get(k) ?? null,
    set: (k: string, v: string) => hoisted.store.set(k, v),
    remove: (k: string) => hoisted.store.delete(k),
  },
  Accounts: { getAll: () => hoisted.accounts },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => hoisted.invoke(...a),
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  requestPgpBlock: (...a: unknown[]) => hoisted.requestPgpBlock(...a),
  requestParseDecrypted: (...a: unknown[]) => hoisted.requestParseDecrypted(...a),
}));

const BLOCK = '-----BEGIN PGP MESSAGE-----\nc\n-----END PGP MESSAGE-----';
const PLAINTEXT = 'Content-Type: text/plain\r\n\r\nhi';

async function load() {
  vi.resetModules();
  return import('../../src/utils/pgp-system-gpg');
}

/** invoke() for a token that needs the app's PIN prompt; `goodPin` opens it. */
function cardNeedingPin({ goodPin = '123456', present = true, retries = 3 } = {}) {
  let left = retries;
  hoisted.invoke.mockImplementation(async (cmd: string, args?: { pin?: string | null }) => {
    if (cmd === 'gpg_available') return true;
    if (cmd === 'gpg_card_info') return { present, pinRetries: present ? left : null };
    if (cmd === 'gpg_decrypt') {
      if (!args?.pin) throw { code: 'pinentry', message: 'Inappropriate ioctl for device' };
      if (args.pin !== goodPin) {
        left -= 1;
        throw { code: 'bad_pin', message: 'Bad PIN' };
      }
      return { plaintext: PLAINTEXT, signatureStatus: null, signer: null };
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

beforeEach(() => {
  hoisted.desktop = true;
  hoisted.store.clear();
  hoisted.invoke.mockReset();
  hoisted.accounts = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
  hoisted.userAllows = true;
  hoisted.invoke.mockImplementation(async (cmd: string, args?: { allowed?: boolean }) => {
    if (cmd === 'gpg_available') return true;
    if (cmd === 'gpg_set_allowed') return Boolean(args?.allowed) && hoisted.userAllows;
    if (cmd === 'gpg_decrypt') return { plaintext: PLAINTEXT, signatureStatus: null, signer: null };
    throw new Error(`unexpected ${cmd}`);
  });
  hoisted.requestPgpBlock.mockReset();
  hoisted.requestPgpBlock.mockResolvedValue({ success: true, block: BLOCK });
  hoisted.requestParseDecrypted.mockReset();
  hoisted.requestParseDecrypted.mockResolvedValue({ success: true, body: 'hi', textContent: 'hi' });
});

describe('systemGpgEnabled', () => {
  it('is off until the user turns it on, per account', async () => {
    const { systemGpgEnabled, setSystemGpgEnabled } = await load();
    expect(systemGpgEnabled('a@x.com')).toBe(false);
    expect(await setSystemGpgEnabled('a@x.com', true)).toBe(true);
    expect(systemGpgEnabled('a@x.com')).toBe(true);
    expect(systemGpgEnabled('b@x.com')).toBe(false);
    expect(await setSystemGpgEnabled('a@x.com', false)).toBe(false);
    expect(systemGpgEnabled('a@x.com')).toBe(false);
  });

  it('stays off when the user declines the native confirmation', async () => {
    hoisted.userAllows = false;
    const { systemGpgEnabled, setSystemGpgEnabled } = await load();

    expect(await setSystemGpgEnabled('a@x.com', true)).toBe(false);

    expect(hoisted.invoke).toHaveBeenCalledWith('gpg_set_allowed', { allowed: true });
    expect(systemGpgEnabled('a@x.com')).toBe(false);
  });

  it('stays off when the native side cannot be asked', async () => {
    hoisted.invoke.mockRejectedValue(new Error('command not found'));
    const { systemGpgEnabled, setSystemGpgEnabled } = await load();

    expect(await setSystemGpgEnabled('a@x.com', true)).toBe(false);
    expect(systemGpgEnabled('a@x.com')).toBe(false);
  });

  it('keeps gpg allowed for the app while another account still uses it', async () => {
    const { setSystemGpgEnabled } = await load();
    await setSystemGpgEnabled('a@x.com', true);
    await setSystemGpgEnabled('b@x.com', true);
    hoisted.invoke.mockClear();

    await setSystemGpgEnabled('a@x.com', false);
    expect(hoisted.invoke).not.toHaveBeenCalledWith('gpg_set_allowed', { allowed: false });

    await setSystemGpgEnabled('b@x.com', false);
    expect(hoisted.invoke).toHaveBeenCalledWith('gpg_set_allowed', { allowed: false });
  });

  it('says how to fix it when the option is on but this computer never confirmed it', async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      throw { code: 'not_allowed', message: 'GnuPG is not turned on for this app' };
    });
    const { decryptWithSystemGpg } = await load();

    const result = await decryptWithSystemGpg('raw message');

    expect(result).toMatchObject({ success: false, reason: 'not_allowed' });
    expect(result.message).toMatch(/off and on again/);
  });

  it('is always off outside the desktop app', async () => {
    hoisted.desktop = false;
    hoisted.store.set('pgp_use_system_gpg_a@x.com', 'true');
    const { systemGpgEnabled } = await load();
    expect(systemGpgEnabled('a@x.com')).toBe(false);
  });
});

describe('decryptWithSystemGpg', () => {
  it('sends only the armored block to gpg and parses the plaintext', async () => {
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg('MIME wrapper ' + BLOCK);
    expect(res.success).toBe(true);
    expect(res.body).toBe('hi');
    expect(hoisted.invoke).toHaveBeenCalledWith('gpg_decrypt', { armored: BLOCK, pin: null });
    expect(hoisted.requestParseDecrypted).toHaveBeenCalledWith({
      plaintext: PLAINTEXT,
      signed: false,
      signature: null,
    });
  });

  it('does nothing for background work, which must not raise a PIN prompt', async () => {
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK, { allowPrompt: false });
    expect(res).toEqual({ success: false, reason: 'prompt_not_allowed' });
    expect(hoisted.invoke).not.toHaveBeenCalled();
  });

  it('does nothing outside the desktop app', async () => {
    hoisted.desktop = false;
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK);
    expect(res.reason).toBe('unavailable');
    expect(hoisted.invoke).not.toHaveBeenCalled();
  });

  it('says to insert the card when gpg reports none', async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      throw { code: 'no_card', message: 'Card not present' };
    });
    const { decryptWithSystemGpg, NO_CARD_MESSAGE } = await load();
    const res = await decryptWithSystemGpg(BLOCK);
    expect(res).toEqual({ success: false, reason: 'no_card', message: NO_CARD_MESSAGE });
  });

  it('asks for the PIN when the pinentry cannot run, and passes it to gpg', async () => {
    cardNeedingPin();
    const askPin = vi.fn().mockResolvedValue('123456');
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK, { askPin });
    expect(res.success).toBe(true);
    expect(askPin).toHaveBeenCalledWith({ retries: 3, error: undefined });
    expect(hoisted.invoke).toHaveBeenCalledWith('gpg_decrypt', { armored: BLOCK, pin: '123456' });
  });

  it('does not ask for a PIN when no card is inserted', async () => {
    cardNeedingPin({ present: false });
    const askPin = vi.fn();
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK, { askPin });
    expect(res.reason).toBe('no_card');
    expect(askPin).not.toHaveBeenCalled();
  });

  it('asks again after a wrong PIN, with the tries left', async () => {
    cardNeedingPin();
    const askPin = vi.fn().mockResolvedValueOnce('000000').mockResolvedValueOnce('123456');
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK, { askPin });
    expect(res.success).toBe(true);
    expect(askPin).toHaveBeenLastCalledWith({
      retries: 2,
      error: 'Wrong PIN. 2 tries left before the card blocks the PIN.',
    });
  });

  it('stops when the user cancels the PIN prompt', async () => {
    cardNeedingPin();
    const askPin = vi.fn().mockResolvedValue(null);
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK, { askPin });
    expect(res.reason).toBe('cancelled');
    expect(askPin).toHaveBeenCalledTimes(1);
  });

  it('stops when the last wrong PIN blocks the card', async () => {
    cardNeedingPin({ retries: 1 });
    const askPin = vi.fn().mockResolvedValue('000000');
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK, { askPin });
    expect(res.reason).toBe('pin_blocked');
    expect(askPin).toHaveBeenCalledTimes(1);
  });

  it('carries the signature gpg reported', async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      return { plaintext: 'x', signatureStatus: 'verified', signer: 'a@b.c' };
    });
    const { decryptWithSystemGpg } = await load();
    const res = await decryptWithSystemGpg(BLOCK);
    expect(res.signed).toBe(true);
    expect(res.signature).toEqual({ status: 'verified', signers: ['a@b.c'] });
  });
});

describe('signWithSystemGpg', () => {
  it('passes the data, signer and recipient keys to gpg', async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      if (cmd === 'gpg_sign') return { armored: 'SIG', micalg: 'pgp-sha256' };
      throw new Error(`unexpected ${cmd}`);
    });
    const { signWithSystemGpg } = await load();
    const res = await signWithSystemGpg({ data: 'body', signer: 'a@x.com', recipientKeys: ['K'] });
    expect(res).toEqual({ success: true, armored: 'SIG', micalg: 'pgp-sha256' });
    expect(hoisted.invoke).toHaveBeenCalledWith('gpg_sign', {
      data: 'body',
      signer: 'a@x.com',
      recipientKeys: ['K'],
      pin: null,
    });
  });

  it('asks for the PIN when the pinentry cannot run, as for decryption', async () => {
    let left = 3;
    hoisted.invoke.mockImplementation(async (cmd: string, args?: { pin?: string | null }) => {
      if (cmd === 'gpg_available') return true;
      if (cmd === 'gpg_card_info') return { present: true, pinRetries: left };
      if (cmd === 'gpg_sign') {
        if (!args?.pin) throw { code: 'pinentry', message: 'Inappropriate ioctl for device' };
        if (args.pin !== '123456') {
          left -= 1;
          throw { code: 'bad_pin', message: 'Bad PIN' };
        }
        return { armored: 'SIG', micalg: null };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const askPin = vi.fn().mockResolvedValueOnce('000000').mockResolvedValueOnce('123456');
    const { signWithSystemGpg } = await load();
    const res = await signWithSystemGpg({ data: 'body', signer: 'a@x.com', askPin });
    expect(res).toEqual({ success: true, armored: 'SIG', micalg: undefined });
    expect(askPin).toHaveBeenLastCalledWith({
      retries: 2,
      error: 'Wrong PIN. 2 tries left before the card blocks the PIN.',
    });
  });

  it('names the address when the keyring has no key for it', async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      throw { code: 'no_secret_key', message: 'signing failed: No secret key' };
    });
    const { signWithSystemGpg } = await load();
    const res = await signWithSystemGpg({ data: 'body', signer: 'a@x.com' });
    expect(res.reason).toBe('no_secret_key');
    expect(res.message).toContain('a@x.com');
  });

  it('does nothing outside the desktop app', async () => {
    hoisted.desktop = false;
    const { signWithSystemGpg } = await load();
    const res = await signWithSystemGpg({ data: 'body', signer: 'a@x.com' });
    expect(res.reason).toBe('unavailable');
    expect(hoisted.invoke).not.toHaveBeenCalled();
  });
});

describe('verifyWithSystemGpg', () => {
  it("maps gpg's result to a signature check", async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      if (cmd === 'gpg_verify') return { signatureStatus: 'verified', signer: 'a@x.com' };
      throw new Error(`unexpected ${cmd}`);
    });
    const { verifyWithSystemGpg } = await load();
    const res = await verifyWithSystemGpg({ signed: 'body', signature: 'SIG' });
    expect(res).toEqual({ status: 'verified', signers: ['a@x.com'] });
    expect(hoisted.invoke).toHaveBeenCalledWith('gpg_verify', { signed: 'body', signature: 'SIG' });
  });

  it('gives null when gpg found no signature or failed', async () => {
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gpg_available') return true;
      throw { code: 'failed', message: 'x' };
    });
    const { verifyWithSystemGpg } = await load();
    expect(await verifyWithSystemGpg({ signed: 'body', signature: 'SIG' })).toBeNull();
  });
});
