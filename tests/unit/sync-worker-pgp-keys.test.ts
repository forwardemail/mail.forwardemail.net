/**
 * PGP key handling in the sync worker. Unlocking a key runs its S2K
 * derivation (100ms or more, far more for argon2), so a key already unlocked
 * must not be derived again on every message open, and a key unlocked for
 * this session only must survive a key refresh that carries no passphrase.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const pgp = vi.hoisted(() => ({
  decryptKey: vi.fn(async ({ privateKey }: { privateKey: Row }) => ({
    ...privateKey,
    isDecrypted: () => true,
  })),
}));

vi.mock('openpgp', () => ({
  readPrivateKey: vi.fn(async ({ armoredKey }: { armoredKey: string }) => ({
    isDecrypted: () => false,
    getFingerprint: () => `fp-${armoredKey}`,
  })),
  decryptKey: (args: { privateKey: Row }) => pgp.decryptKey(args),
}));

const posted: Row[] = [];
const onmessage = () => (self as unknown as { onmessage: (event: unknown) => void }).onmessage;

let seq = 0;
async function unlock(payload: Row) {
  const requestId = `u${++seq}`;
  onmessage()({ data: { type: 'request', requestId, action: 'unlockPgpKey', payload } });
  await vi.waitFor(() =>
    expect(
      posted.find((m) => m.requestId === requestId && m.type === 'requestComplete'),
    ).toBeTruthy(),
  );
  return posted.find((m) => m.requestId === requestId)?.result as Row;
}

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  (self as unknown as { postMessage: (msg: Row) => void }).postMessage = (msg) => {
    posted.push(msg);
  };
  await import('../../src/workers/sync.worker.ts');
  onmessage()({
    data: {
      type: 'init',
      config: { apiBase: 'https://api.example.com', account: 'me@x.test', authHeader: 'Basic x' },
    },
  });
});

beforeEach(() => {
  pgp.decryptKey.mockClear();
});

describe('sync worker PGP keys', () => {
  it('does not derive a key again once it is unlocked', async () => {
    const first = await unlock({ keyName: 'k1', keyValue: 'K1', passphrase: 'pw' });
    expect(first.success).toBe(true);
    const second = await unlock({ keyName: 'k1', keyValue: 'K1', passphrase: 'pw' });
    expect(second).toMatchObject({ success: true, alreadyUnlocked: true });
    expect(pgp.decryptKey).toHaveBeenCalledTimes(1);
  });

  it('keeps a session-unlocked key through a key refresh with no passphrase', async () => {
    await unlock({ keyName: 'k2', keyValue: 'K2', passphrase: 'pw' });
    // Settings refreshes the key set; this key's passphrase was not remembered
    onmessage()({
      data: { type: 'pgpKeys', keys: [{ name: 'k2', value: 'K2' }], passphrases: {} },
    });
    // No passphrase now: still unlocked, so no prompt is needed
    const after = await unlock({ keyName: 'k2', keyValue: 'K2' });
    expect(after).toMatchObject({ success: true, alreadyUnlocked: true });
  });

  it('still asks for a passphrase for a key never unlocked', async () => {
    const result = await unlock({ keyName: 'k3', keyValue: 'K3' });
    expect(result).toMatchObject({ success: false, needsPassphrase: true });
  });
});
