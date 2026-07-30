import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cachedBody: null as Record<string, unknown> | null,
  cachePut: vi.fn(),
  remoteRequest: vi.fn(),
  sendSyncRequest: vi.fn(),
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
  Local: {
    get: vi.fn((key: string) => {
      if (key === 'email') return 'reader@example.com';
      return null;
    }),
  },
}));

vi.mock('../../src/utils/remote.js', () => ({
  Remote: { request: mocks.remoteRequest },
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: mocks.sendSyncRequest,
  refreshSyncWorkerPgpKeys: vi.fn(),
  requestPgpDecryption: vi.fn(),
  unlockPgpKey: vi.fn(),
  requestParsing: vi.fn(),
}));

vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: vi.fn(() => ({
    stage: vi.fn(),
    end: vi.fn(),
  })),
}));

vi.mock('../../src/utils/logger.ts', () => ({
  warn: vi.fn(),
}));

import { mailService } from '../../src/stores/mailService';

const message = {
  id: 'message-123',
  folder: 'INBOX',
  from: 'Unknown',
  subject: 'test subject',
  snippet: 'test message',
  date: Date.UTC(2026, 6, 29, 23, 58),
  flags: [],
};

const detailMeta = {
  nodemailer: {
    from: {
      text: 'Shaun Warman <shaunw.dev@gmail.com>',
      value: [{ name: 'Shaun Warman', address: 'shaunw.dev@gmail.com' }],
    },
    to: {
      text: 'shaun@warman.life',
      value: [{ address: 'shaun@warman.life' }],
    },
    subject: 'test subject',
    headers: {
      received: 'from mail-pf1-f180.google.com by mx1.forwardemail.net with TLS version=TLSv1.3',
      'authentication-results': 'spf=pass dkim=pass dmarc=pass',
      'dkim-signature': 'v=1; d=gmail.com;',
    },
  },
};

describe('sync worker detail metadata contract', () => {
  const workerSource = readFileSync(path.join(process.cwd(), 'src/workers/sync.worker.ts'), 'utf8');

  it('persists and returns parsed metadata for network and cached body results', () => {
    expect({
      acceptsMeta: workerSource.includes(
        'const persistBody = async (body, textContent, attachments = [], meta = null) => {',
      ),
      cachesMeta: /attachments,\s+meta,\s+updatedAt: Date\.now\(\)/.test(workerSource),
      returnsMeta: /attachments,\s+meta,\s+};/.test(workerSource),
      cachedHitReturnsMeta:
        /attachments: cached\.attachments \|\| \[\],\s+meta: [^\n]*cached[^\n]*\.meta \|\| null,/.test(
          workerSource,
        ),
      forwardsApiResult: workerSource.includes(
        'return await persistBody(body, textContent, attachments, result);',
      ),
      encryptedResponseReturnsMeta: /pgpLocked:\s*true,\s+raw,\s+meta:\s*result\s*[,}]/.test(
        workerSource,
      ),
    }).toEqual({
      acceptsMeta: true,
      cachesMeta: true,
      returnsMeta: true,
      cachedHitReturnsMeta: true,
      forwardsApiResult: true,
      encryptedResponseReturnsMeta: true,
    });
  });
});

describe('mailService worker detail metadata delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cachedBody = null;
    mocks.cachePut.mockImplementation(async (record) => {
      mocks.cachedBody = record;
    });
    mocks.remoteRequest.mockRejectedValue(new Error('worker result must not refetch the message'));
  });

  it('delivers cached metadata to the reader without starting another request', async () => {
    mocks.cachedBody = {
      id: 'message-123',
      account: 'reader@example.com',
      body: '<p>cached test message</p>',
      attachments: [],
      meta: detailMeta,
      trackingPixelCount: 0,
      blockedRemoteImageCount: 0,
    };
    const onBody = vi.fn();
    const onMeta = vi.fn();

    await mailService.loadMessageDetail(message as never, { onBody, onMeta });

    expect(onBody).toHaveBeenCalledWith(expect.stringContaining('cached test message'));
    expect(onMeta).toHaveBeenCalledWith(detailMeta);
    expect(mocks.sendSyncRequest).not.toHaveBeenCalled();
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it('delivers worker metadata to the reader and persists it with the body cache', async () => {
    mocks.sendSyncRequest.mockResolvedValue({
      body: '<p>test message</p>',
      attachments: [],
      meta: detailMeta,
    });
    const onBody = vi.fn();
    const onMeta = vi.fn();

    await mailService.loadMessageDetail(message as never, { onBody, onMeta });

    expect(onBody).toHaveBeenCalledWith(expect.stringContaining('test message'));
    expect(onMeta).toHaveBeenCalledWith(detailMeta);
    expect(mocks.cachePut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'message-123',
        account: 'reader@example.com',
        meta: detailMeta,
      }),
    );
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it('delivers metadata to every caller sharing an in-flight detail request', async () => {
    let resolveWorker: (value: Record<string, unknown>) => void = () => {};
    mocks.sendSyncRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveWorker = resolve;
      }),
    );
    const firstOnMeta = vi.fn();
    const secondOnMeta = vi.fn();

    const firstLoad = mailService.loadMessageDetail(message as never, {
      onBody: vi.fn(),
      onMeta: firstOnMeta,
    });
    await vi.waitFor(() => expect(mocks.sendSyncRequest).toHaveBeenCalledTimes(1));

    const secondLoad = mailService.loadMessageDetail(message as never, {
      onBody: vi.fn(),
      onMeta: secondOnMeta,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    mocks.cachedBody = {
      id: 'message-123',
      account: 'reader@example.com',
      body: '<p>test message</p>',
      attachments: [],
      meta: detailMeta,
      trackingPixelCount: 0,
      blockedRemoteImageCount: 0,
    };
    resolveWorker({
      body: '<p>test message</p>',
      attachments: [],
      meta: detailMeta,
    });

    await Promise.all([firstLoad, secondLoad]);

    expect(mocks.sendSyncRequest).toHaveBeenCalledTimes(1);
    expect(firstOnMeta).toHaveBeenCalledWith(detailMeta);
    expect(secondOnMeta).toHaveBeenCalledWith(detailMeta);
  });
});
