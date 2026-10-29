// @vitest-environment node
/**
 * Signature checking on decrypt, through the real sync worker and openpgp.
 *
 * A signature is only "verified" when it checks out against a key the user
 * holds (a pinned contact key or their own). A key the user does not hold says
 * nothing, and a signature that fails against a held key is called invalid,
 * never just "signed".
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as openpgp from 'openpgp';

type Row = Record<string, unknown>;

// Node environment (openpgp fails on jsdom's Uint8Array realm); the worker
// module expects a worker global
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).self = globalThis;
});

const posted: Row[] = [];
const onmessage = () => (self as unknown as { onmessage: (event: unknown) => void }).onmessage;

let seq = 0;
async function runTask(task: Row) {
  const taskId = `t${++seq}`;
  onmessage()({ data: { type: 'task', taskId, task } });
  await vi.waitFor(
    () =>
      expect(
        posted.find(
          (m) => m.taskId === taskId && (m.type === 'taskComplete' || m.type === 'taskError'),
        ),
      ).toBeTruthy(),
    { timeout: 15_000 },
  );
  const done = posted.find((m) => m.taskId === taskId && m.type === 'taskComplete') as Row;
  return (done?.summary || done?.result || done) as Row;
}

async function makeKey(email: string) {
  return openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ email }],
    format: 'armored',
  });
}

async function encryptTo(recipientPublic: string, text: string, signerPrivate?: string) {
  const message = await openpgp.createMessage({ text });
  return openpgp.encrypt({
    message,
    encryptionKeys: await openpgp.readKey({ armoredKey: recipientPublic }),
    ...(signerPrivate
      ? { signingKeys: await openpgp.readPrivateKey({ armoredKey: signerPrivate }) }
      : {}),
    format: 'armored',
  });
}

const INNER = 'Content-Type: text/plain; charset=utf-8\r\n\r\nhello there';

let me: Awaited<ReturnType<typeof makeKey>>;
let alice: Awaited<ReturnType<typeof makeKey>>;
let mallory: Awaited<ReturnType<typeof makeKey>>;

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
  [me, alice, mallory] = await Promise.all([
    makeKey('me@x.test'),
    makeKey('alice@example.com'),
    makeKey('mallory@example.com'),
  ]);
  // Alice's public key is pinned; Mallory's is not
  onmessage()({
    data: {
      type: 'pgpKeys',
      keys: [{ name: 'mine', value: me.privateKey }],
      passphrases: {},
      contactKeys: [alice.publicKey],
    },
  });
}, 60_000);

describe('sync worker signature checking', () => {
  it('verifies a signature from a pinned contact and names its address', async () => {
    const raw = await encryptTo(me.publicKey, INNER, alice.privateKey);
    const result = await runTask({ type: 'decryptMessage', raw });
    expect(result.success).toBe(true);
    expect(result.signed).toBe(true);
    expect(result.signature).toEqual({ status: 'verified', signers: ['alice@example.com'] });
  });

  it('verifies a signature made with the user’s own key', async () => {
    const raw = await encryptTo(me.publicKey, INNER, me.privateKey);
    const result = await runTask({ type: 'decryptMessage', raw });
    expect(result.signature).toEqual({ status: 'verified', signers: ['me@x.test'] });
  });

  it('reports a signature from a key the user does not hold as unverified', async () => {
    const raw = await encryptTo(me.publicKey, INNER, mallory.privateKey);
    const result = await runTask({ type: 'decryptMessage', raw });
    expect(result.signed).toBe(true);
    expect(result.signature).toEqual({ status: 'unverified', signers: [] });
  });

  it('reports no signature for an unsigned message', async () => {
    const raw = await encryptTo(me.publicKey, INNER);
    const result = await runTask({ type: 'decryptMessage', raw });
    expect(result.signed).toBe(false);
    expect(result.signature).toBeNull();
  });

  it('says the key was revoked rather than calling the signature invalid', async () => {
    const bob = await makeKey('bob@example.com');
    const { publicKey: revokedBob } = await openpgp.revokeKey({
      key: await openpgp.readPrivateKey({ armoredKey: bob.privateKey }),
      format: 'armored',
    });
    onmessage()({
      data: {
        type: 'pgpKeys',
        keys: [{ name: 'mine', value: me.privateKey }],
        passphrases: {},
        contactKeys: [alice.publicKey, revokedBob],
      },
    });
    const raw = await encryptTo(me.publicKey, INNER, bob.privateKey);
    const result = await runTask({ type: 'decryptMessage', raw });
    expect(result.signature).toEqual({ status: 'revoked', signers: ['bob@example.com'] });
    onmessage()({
      data: {
        type: 'pgpKeys',
        keys: [{ name: 'mine', value: me.privateKey }],
        passphrases: {},
        contactKeys: [alice.publicKey],
      },
    });
  });

  it('calls a signature that fails against a held key invalid', async () => {
    // Alice's real signature, but over other content: the message was changed
    // after she signed it
    const sig = await openpgp.sign({
      message: await openpgp.createMessage({ text: 'Pay 10 EUR' }),
      signingKeys: await openpgp.readPrivateKey({ armoredKey: alice.privateKey }),
      detached: true,
      format: 'object',
    });
    const raw = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'Pay 99 EUR' }),
      encryptionKeys: await openpgp.readKey({ armoredKey: me.publicKey }),
      signature: sig,
      format: 'armored',
    });
    const result = await runTask({ type: 'decryptMessage', raw });
    expect(result.signature).toMatchObject({ status: 'invalid', signers: ['alice@example.com'] });
  });
});
