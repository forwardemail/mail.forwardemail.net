/**
 * src/boot.ts imports the app and hands a failed import to index.html's
 * stale-chunk recovery, which clears the caches and reloads. Only a chunk
 * that failed to load is stale: an error the app throws while it first runs
 * (a missing API on an older engine) has to reach the fatal overlay with its
 * stack, or a white screen at launch cannot be diagnosed.
 *
 * The recovery script runs here as index.html ships it, so boot.ts is checked
 * against the chunk-load wording the page itself uses.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const index = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const start = index.indexOf('// Automatic chunk load error recovery.');
const end = index.indexOf('// Show fallback UI if', start);
const recoveryScript = index.slice(start, end);

vi.mock('../../src/utils/device-seal', () => ({
  loadDeviceKey: async () => false,
  sealExistingLocalStorage: () => {},
}));
vi.mock('../../src/utils/crypto-store.js', () => ({
  isEncrypted: () => false,
  isSensitiveLocalKey: () => false,
}));

type Page = {
  __fePageLeaving?: boolean;
  __feIsChunkLoadError?: (reason: unknown) => boolean;
  __feRecoverStaleChunks?: () => void;
};
const page = window as unknown as Page;
let recover: ReturnType<typeof vi.fn>;

// Vitest reports an error thrown by a mock factory wrapped in its own, with
// the original as the cause.
async function bootWithAppThrowing(error: Error): Promise<Error | null> {
  vi.resetModules();
  vi.doMock('../../src/main', () => {
    throw error;
  });
  try {
    await import('../../src/boot');
    return null;
  } catch (err) {
    return err as Error;
  }
}

beforeEach(() => {
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  new Function(recoveryScript)();
  recover = vi.fn();
  page.__feRecoverStaleChunks = recover;
  page.__fePageLeaving = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('../../src/main');
  vi.restoreAllMocks();
});

describe('boot.ts when the app fails to import', () => {
  it('leaves an error the app threw at startup to the fatal overlay', async () => {
    const error = new TypeError("undefined is not a function (near '...x.findLast...')");
    const thrown = await bootWithAppThrowing(error);
    expect(recover).not.toHaveBeenCalled();
    expect(thrown?.cause).toBe(error);
  });

  it('hands a chunk that failed to load to the recovery', async () => {
    const isChunkLoadError = vi.fn(() => true);
    page.__feIsChunkLoadError = isChunkLoadError;
    const thrown = await bootWithAppThrowing(new TypeError('Importing a module script failed.'));
    expect(thrown).toBeNull();
    expect(isChunkLoadError).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the page has no chunk-load check', async () => {
    delete page.__feIsChunkLoadError;
    const error = new TypeError('Importing a module script failed.');
    expect((await bootWithAppThrowing(error))?.cause).toBe(error);
    expect(recover).not.toHaveBeenCalled();
  });
});

describe("index.html's chunk-load check", () => {
  it('knows the wording each engine uses for a module that failed to load', () => {
    const isChunkLoadError = page.__feIsChunkLoadError!;
    for (const message of [
      'Failed to fetch dynamically imported module: https://mail.example.test/assets/main-x.js',
      'error loading dynamically imported module: https://mail.example.test/assets/main-x.js',
      'Importing a module script failed.',
      "'text/html' is not a valid JavaScript MIME type.",
      'Unable to preload CSS for /assets/main-x.css',
      'Loading chunk 12 failed.',
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('does not take an app error for one', () => {
    const isChunkLoadError = page.__feIsChunkLoadError!;
    expect(
      isChunkLoadError(new TypeError("undefined is not a function (near '...x.findLast...')")),
    ).toBe(false);
    expect(isChunkLoadError(new ReferenceError('structuredClone is not defined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
