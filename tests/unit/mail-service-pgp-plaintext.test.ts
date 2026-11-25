/**
 * Decrypted PGP mail is written to the body cache only while App Lock
 * encrypts that cache (pgp-plaintext-policy.ts). The reader still shows it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appLock: false,
  cachedBody: null as Record<string, unknown> | null,
  cachePut: vi.fn(),
  remoteRequest: vi.fn(),
  sendSyncRequest: vi.fn(),
}));

vi.mock('../../src/utils/pgp-plaintext-policy', () => ({
  pgpPlaintextMayPersist: () => mocks.appLock,
}));

vi.mock('../../src/utils/db.js', () => ({
  db: {
    messageBodies: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: vi.fn(async () => mocks.cachedBody),
        })),
      })),
      put: mocks.cachePut,
    },
  },
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: vi.fn((key: string) => (key === 'email' ? 'reader@example.com' : null)) },
  Accounts: { getAll: () => [] },
}));

vi.mock('../../src/utils/remote.js', () => ({
  Remote: { request: mocks.remoteRequest },
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: mocks.sendSyncRequest,
  refreshSyncWorkerPgpKeys: vi.fn(),
  requestPgpDecryption: vi.fn(),
  requestPgpBlock: vi.fn(),
  requestParseDecrypted: vi.fn(),
  unlockPgpKey: vi.fn(),
  requestParsing: vi.fn(),
}));

vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: vi.fn(() => ({ stage: vi.fn(), end: vi.fn() })),
}));

vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

import { mailService } from '../../src/stores/mailService';

const SECRET = 'the merger closes on Friday';

// What the sync worker hands the reader for a message it decrypted
const decryptedByWorker = () => ({
  body: `<p>${SECRET}</p>`,
  textPart: SECRET,
  attachments: [],
  meta: {},
  pgp: { encrypted: true },
});

const message = (id: string) => ({
  id,
  folder: 'INBOX',
  from: 'ada@example.com',
  subject: '...',
  date: Date.UTC(2026, 10, 20, 9, 0),
  flags: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appLock = false;
  mocks.cachedBody = null;
  mocks.cachePut.mockResolvedValue(undefined);
  mocks.remoteRequest.mockRejectedValue(new Error('the worker result is enough'));
});

describe('reader cache of decrypted PGP mail', () => {
  it('shows a decrypted message without writing it to disk when App Lock is off', async () => {
    mocks.sendSyncRequest.mockResolvedValue(decryptedByWorker());
    const onBody = vi.fn();

    await mailService.loadMessageDetail(message('pgp-no-lock') as never, { onBody });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onBody).toHaveBeenCalledWith(expect.stringContaining(SECRET), expect.anything());
    expect(mocks.cachePut).not.toHaveBeenCalled();
  });

  it('caches a decrypted message while App Lock encrypts the cache', async () => {
    mocks.appLock = true;
    mocks.sendSyncRequest.mockResolvedValue(decryptedByWorker());

    await mailService.loadMessageDetail(message('pgp-with-lock') as never, { onBody: vi.fn() });

    await vi.waitFor(() =>
      expect(mocks.cachePut).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pgp-with-lock', pgpDecrypted: true }),
      ),
    );
  });

  it('still caches mail that was never encrypted when App Lock is off', async () => {
    mocks.sendSyncRequest.mockResolvedValue({
      body: '<p>lunch at noon?</p>',
      attachments: [],
      meta: {},
    });

    await mailService.loadMessageDetail(message('plain-no-lock') as never, { onBody: vi.fn() });

    await vi.waitFor(() =>
      expect(mocks.cachePut).toHaveBeenCalledWith(expect.objectContaining({ id: 'plain-no-lock' })),
    );
  });
});
