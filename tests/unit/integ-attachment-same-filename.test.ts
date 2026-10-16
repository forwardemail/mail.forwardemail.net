/**
 * A scanner or a forwarded thread can put two attachments with the same
 * filename in one message. The attachment blob cache used to key on the
 * filename alone, so downloading the second one handed back the first one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const env = vi.hoisted(() => ({
  meta: new Map<string, Row>(),
  cachedBody: undefined as Row | undefined,
  serverAttachments: [] as Row[],
  offline: false,
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  isTauriDesktop: false,
  isTauriMobile: false,
}));
vi.mock('../../src/utils/file-picker', () => ({ isMacOSPlatform: false }));
vi.mock('../../src/utils/db.js', () => ({
  db: {
    meta: {
      get: async (key: string) => env.meta.get(key),
      put: async (record: Row) => {
        env.meta.set(record.key as string, record);
      },
      delete: async (key: string) => {
        env.meta.delete(key);
      },
    },
    messageBodies: {
      where: () => ({ equals: () => ({ first: async () => env.cachedBody }) }),
    },
  },
}));
vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: (key: string) => (key === 'email' ? 'me@x.test' : null) },
}));
vi.mock('../../src/utils/remote.js', () => ({
  Remote: {
    request: vi.fn(async () => {
      if (env.offline) throw new TypeError('Failed to fetch');
      return { Result: { id: 'm1', nodemailer: { attachments: env.serverAttachments } } };
    }),
  },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn(),
  refreshSyncWorkerPgpKeys: vi.fn(),
  requestPgpDecryption: vi.fn(),
  unlockPgpKey: vi.fn(),
  requestParsing: vi.fn(),
}));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: vi.fn(() => ({ stage: vi.fn(), end: vi.fn() })),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

import { mailService } from '../../src/stores/mailService';

// Two scans the same device named the same way, as the API returns them
// (Buffer JSON content, no content id).
const scanOne = 'first page of the lease';
const scanTwo = 'second page of the lease, signed';
const bufferJson = (text: string) => ({
  type: 'Buffer',
  data: [...new TextEncoder().encode(text)],
});
const serverRows = () => [
  {
    filename: 'scan.pdf',
    contentType: 'application/pdf',
    size: scanOne.length,
    content: bufferJson(scanOne),
  },
  {
    filename: 'scan.pdf',
    contentType: 'application/pdf',
    size: scanTwo.length,
    content: bufferJson(scanTwo),
  },
];
// What the reader shows (sanitized, no content).
const shown = (size: number) => ({
  name: 'scan.pdf',
  filename: 'scan.pdf',
  size,
  contentType: 'application/pdf',
  disposition: 'attachment',
  needsDownload: true,
});
const message = { id: 'm1', folder: 'INBOX' };

let downloads: string[] = [];
const decode = (href: string) => atob(href.slice(href.indexOf(',') + 1));

async function download(size: number) {
  const before = downloads.length;
  await mailService.downloadAttachment(shown(size) as never, message as never);
  await vi.waitFor(() => expect(downloads.length).toBe(before + 1));
  // Let the background cache write land before the next download.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return decode(downloads[downloads.length - 1]);
}

beforeEach(() => {
  env.meta.clear();
  env.cachedBody = undefined;
  env.serverAttachments = serverRows();
  env.offline = false;
  downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.href);
  });
});

describe('downloading attachments that share a filename', () => {
  it('gives each attachment its own content when nothing is cached yet', async () => {
    expect(await download(scanOne.length)).toBe(scanOne);
    expect(await download(scanTwo.length)).toBe(scanTwo);
  });

  it('serves each one from the blob cache offline without mixing them up', async () => {
    // The reader cached the message body with its attachment list (no content).
    env.cachedBody = {
      id: 'm1',
      account: 'me@x.test',
      attachments: serverRows().map(({ content: _content, ...rest }) => ({
        ...rest,
        name: 'scan.pdf',
      })),
    };
    expect(await download(scanTwo.length)).toBe(scanTwo);
    expect(await download(scanOne.length)).toBe(scanOne);

    env.offline = true;
    expect(await download(scanOne.length)).toBe(scanOne);
    expect(await download(scanTwo.length)).toBe(scanTwo);
  });
});
