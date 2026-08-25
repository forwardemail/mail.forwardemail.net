/**
 * Receiving half of QR device pairing, driven end to end without a camera.
 *
 * The decoder is injected, so these tests feed REAL frames produced by the real
 * sender path - sealBundle → encodeFrames - and assert on what the confirmation
 * screen discloses and what actually gets written. That injection point is also
 * how the mobile e2e suite drives this without a physical camera.
 *
 * The rule being protected: nothing is persisted until the user confirms.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { webcrypto } from 'node:crypto';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  // jsdom media elements never become ready, so the scan loop would never read
  // a frame. Present them as playable.
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => 4,
  });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

const localMap = new Map<string, string>();
let accountRows: { email: string; aliasAuth?: string | null }[] = [];
const addSpy = vi.fn();
const setActiveSpy = vi.fn();

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (k: string) => (localMap.has(k) ? localMap.get(k)! : null),
    set: (k: string, v: string) => localMap.set(k, v),
    remove: (k: string) => localMap.delete(k),
  },
  Accounts: {
    getAll: () => accountRows,
    add: (email: string, creds: unknown) => {
      addSpy(email, creds);
      accountRows = [...accountRows, { email }];
      return true;
    },
    setActive: (email: string) => {
      setActiveSpy(email);
      return true;
    },
  },
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      where: () => ({ startsWith: () => ({ toArray: async () => [] }) }),
      put: async () => {},
    },
  },
}));

vi.mock('openpgp', () => ({
  readKey: async ({ armoredKey }: { armoredKey: string }) => {
    if (!armoredKey.includes('PRIVATE KEY')) throw new Error('Unreadable key');
    return {
      getFingerprint: () => 'aabbccddeeff00112233445566778899aabbccdd',
      getAlgorithmInfo: () => ({ algorithm: 'rsa', bits: 4096 }),
      getUserIDs: () => ['Shaun <shaun@example.com>'],
      isPrivate: () => true,
    };
  },
}));

const ScanPairingCode = (await import('../../src/svelte/components/ScanPairingCode.svelte'))
  .default;
const { sealBundle } = await import('../../src/utils/device-sync/seal');
const { encodeFrames, newSessionId } = await import('../../src/utils/device-sync/frames');
const { wrapSealKey } = await import('../../src/utils/device-sync/pairing-code');
import type { QrDecoder } from '../../src/utils/device-sync/scanner';

const ACCOUNT = 'user@example.com';
const KEY = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nAAAA\n-----END PGP PRIVATE KEY BLOCK-----';

const PAIRING_CODE = 'A7K29QMX';

/** Frames whose seal key is wrapped with a pairing code, as the sender emits. */
const makeProtectedFrames = async () => {
  const now = Math.floor(Date.now() / 1000);
  const bundle = {
    v: 1,
    iat: now,
    exp: now + 180,
    src: { app: 'desktop' as const, os: 'macos' },
    account: { email: ACCOUNT, aliasAuth: `${ACCOUNT}:pw`, apiKey: null },
  };
  const { key, sealed } = await sealBundle(bundle as never);
  const sessionId = newSessionId();
  const wrapped = await wrapSealKey(key, PAIRING_CODE, sessionId);
  return encodeFrames({ sealed, key: wrapped, sessionId, codeProtected: true });
};

const makeFrames = async (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const bundle = {
    v: 1,
    iat: now,
    exp: now + 180,
    src: { app: 'desktop' as const, os: 'macos' },
    account: { email: ACCOUNT, aliasAuth: `${ACCOUNT}:pw`, apiKey: null },
    pgp: { keys: [{ name: 'work', value: KEY }], passphrases: {} },
    settings: { theme: 'dark' },
    ...overrides,
  };
  const { key, sealed } = await sealBundle(bundle as never);
  return encodeFrames({ sealed, key });
};

/** A decoder that replays prepared frames, one per decode pass. */
const replayDecoder = (frames: string[]): (() => Promise<QrDecoder>) => {
  let i = 0;
  return async () => ({
    kind: 'replay',
    decode: async () => (i < frames.length ? [frames[i++]] : []),
    close: vi.fn(),
  });
};

const grantCamera = () => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
};

const denyCamera = (name: string) => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name })),
    },
  });
};

afterEach(() => {
  cleanup();
  localMap.clear();
  accountRows = [];
  addSpy.mockClear();
  setActiveSpy.mockClear();
});

describe('<ScanPairingCode />', () => {
  it('discloses the account and key fingerprint before writing anything', async () => {
    grantCamera();
    const frames = await makeFrames();
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone: vi.fn(), createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText('Add this account?')).toBeInTheDocument(), {
      timeout: 3000,
    });

    expect(screen.getByText(ACCOUNT)).toBeInTheDocument();
    expect(screen.getByText(/CCDD/)).toBeInTheDocument();
    expect(screen.getByText(/rsa 4096/)).toBeInTheDocument();

    // The whole point: still nothing on disk at the confirmation step.
    expect(addSpy).not.toHaveBeenCalled();
    expect(localMap.size).toBe(0);
  });

  it('writes only after the user confirms', async () => {
    grantCamera();
    const onDone = vi.fn();
    const frames = await makeFrames();
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone, createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText('Add this account?')).toBeInTheDocument(), {
      timeout: 3000,
    });
    await fireEvent.click(screen.getByRole('button', { name: /add account/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(addSpy).toHaveBeenCalledWith(ACCOUNT, { aliasAuth: `${ACCOUNT}:pw`, apiKey: null });
    expect(setActiveSpy).toHaveBeenCalledWith(ACCOUNT);
    expect(JSON.parse(localMap.get(`pgp_keys_${ACCOUNT}`)!)).toEqual([
      { name: 'work', value: KEY },
    ]);
    expect(localMap.get('theme')).toBe('dark');
  });

  it('writes nothing when the user cancels at the confirmation step', async () => {
    grantCamera();
    const onCancel = vi.fn();
    const frames = await makeFrames();
    render(ScanPairingCode, {
      props: { onCancel, onDone: vi.fn(), createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText('Add this account?')).toBeInTheDocument(), {
      timeout: 3000,
    });
    await fireEvent.click(screen.getAllByRole('button', { name: /cancel/i })[0]);

    expect(onCancel).toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(localMap.size).toBe(0);
  });

  it('names expiry specifically rather than as a generic read failure', async () => {
    grantCamera();
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const frames = await makeFrames({ iat: stale - 180, exp: stale });
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone: vi.fn(), createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText(/has expired/i)).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('explains a denied camera instead of showing a dead viewfinder', async () => {
    denyCamera('NotAllowedError');
    render(ScanPairingCode, {
      props: {
        onCancel: vi.fn(),
        onDone: vi.fn(),
        createDecoder: replayDecoder(await makeFrames()),
      },
    });

    await waitFor(() => expect(screen.getByText(/camera access was denied/i)).toBeInTheDocument());
  });

  it('demands the pairing code before it will open a protected bundle', async () => {
    grantCamera();
    const frames = await makeProtectedFrames();
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone: vi.fn(), createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText(/enter the pairing code/i)).toBeInTheDocument(), {
      timeout: 3000,
    });

    // Scanning alone got us nowhere: no account details, nothing written.
    expect(screen.queryByText('Add this account?')).toBeNull();
    expect(screen.queryByText(ACCOUNT)).toBeNull();
    expect(addSpy).not.toHaveBeenCalled();
  }, 20_000);

  it('opens the bundle once the right code is entered', async () => {
    grantCamera();
    const frames = await makeProtectedFrames();
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone: vi.fn(), createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText(/enter the pairing code/i)).toBeInTheDocument(), {
      timeout: 3000,
    });
    await fireEvent.input(screen.getByPlaceholderText('XXXX-XXXX'), {
      target: { value: 'a7k2-9qmx' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText('Add this account?')).toBeInTheDocument(), {
      timeout: 30_000,
    });
    expect(screen.getByText(ACCOUNT)).toBeInTheDocument();
  }, 60_000);

  it('sends a wrong code back to the prompt instead of a dead end', async () => {
    grantCamera();
    const frames = await makeProtectedFrames();
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone: vi.fn(), createDecoder: replayDecoder(frames) },
    });

    await waitFor(() => expect(screen.getByText(/enter the pairing code/i)).toBeInTheDocument(), {
      timeout: 3000,
    });
    await fireEvent.input(screen.getByPlaceholderText('XXXX-XXXX'), {
      target: { value: 'A7K2-9QMY' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/did not work/i)).toBeInTheDocument(), {
      timeout: 30_000,
    });
    // Still on the code screen, still nothing written.
    expect(screen.getByPlaceholderText('XXXX-XXXX')).toBeInTheDocument();
    expect(addSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('says so when the platform has no decoder at all (the iOS case)', async () => {
    grantCamera();
    render(ScanPairingCode, {
      props: { onCancel: vi.fn(), onDone: vi.fn(), createDecoder: async () => null },
    });

    await waitFor(() => expect(screen.getByText(/cannot scan qr codes yet/i)).toBeInTheDocument());
  });
});
