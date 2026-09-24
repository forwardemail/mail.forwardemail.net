/**
 * Argon2id runs in a throwaway worker.
 *
 * The derivation allocates 256 MiB and takes seconds on a phone. On the main
 * thread it froze the PIN pad and left the buffer for the garbage collector,
 * which iOS often answered by killing the page right after an unlock. These
 * tests pin the worker path: same key as the main thread, worker terminated
 * after every call (success or failure), and a main-thread fallback only when
 * the worker cannot start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { argon2id } from 'hash-wasm';

const w = vi.hoisted(() => ({
  instances: [] as Array<{ terminate: ReturnType<typeof vi.fn>; posted: unknown[] }>,
  mode: 'ok' as 'ok' | 'fail' | 'crash' | 'unavailable',
}));

vi.mock('../../src/workers/argon2.worker.ts?worker&inline', () => {
  class FakeArgon2Worker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    posted: unknown[] = [];

    constructor() {
      if (w.mode === 'unavailable') throw new Error('blob: URLs are blocked');
      w.instances.push(this);
    }

    postMessage(message: {
      id: number;
      password: string;
      salt: Uint8Array;
      hashLength: number;
      iterations: number;
      memorySize: number;
      parallelism: number;
    }) {
      this.posted.push(message);
      queueMicrotask(async () => {
        if (w.mode === 'crash') {
          this.onerror?.({ message: 'worker crashed', preventDefault: () => {} });
          return;
        }
        if (w.mode === 'fail') {
          this.onmessage?.({ data: { id: message.id, ok: false, error: 'out of memory' } });
          return;
        }
        const result = await argon2id({
          password: message.password,
          salt: message.salt,
          iterations: message.iterations,
          memorySize: message.memorySize,
          parallelism: message.parallelism,
          hashLength: message.hashLength,
          outputType: 'binary',
        });
        this.onmessage?.({ data: { id: message.id, ok: true, result } });
      });
    }
  }
  return { default: FakeArgon2Worker };
});

const SALT = new Uint8Array(16).map((_, i) => i + 1);

beforeEach(() => {
  w.instances.length = 0;
  w.mode = 'ok';
  vi.stubGlobal('Worker', class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deriveArgon2Key', () => {
  it('derives the same key as the fixed cost profile, in a worker it then terminates', async () => {
    const { deriveArgon2Key } = await import('../../src/utils/argon2-kdf.js');

    const key = await deriveArgon2Key('123456', SALT);

    const expected = await argon2id({
      password: '123456',
      salt: SALT,
      parallelism: 1,
      iterations: 3,
      memorySize: 262144,
      hashLength: 32,
      outputType: 'binary',
    });
    expect(Array.from(key)).toEqual(Array.from(expected));
    expect(w.instances).toHaveLength(1);
    expect(w.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(w.instances[0].posted[0]).toMatchObject({
      iterations: 3,
      memorySize: 262144,
      parallelism: 1,
    });
  }, 60_000);

  it('terminates the worker and reports a derivation failure', async () => {
    w.mode = 'fail';
    const { deriveArgon2Key } = await import('../../src/utils/argon2-kdf.js');

    await expect(deriveArgon2Key('123456', SALT)).rejects.toThrow('out of memory');
    expect(w.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the main thread when the worker cannot start', async () => {
    w.mode = 'unavailable';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deriveArgon2Key } = await import('../../src/utils/argon2-kdf.js');

    const key = await deriveArgon2Key('123456', SALT, 16);

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(16);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  }, 60_000);

  it('falls back to the main thread when the worker script errors', async () => {
    w.mode = 'crash';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deriveArgon2Key } = await import('../../src/utils/argon2-kdf.js');

    const key = await deriveArgon2Key('123456', SALT, 16);

    expect(key).toHaveLength(16);
    expect(w.instances[0].terminate).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  }, 60_000);

  it('never detaches the caller salt', async () => {
    const { deriveArgon2Key } = await import('../../src/utils/argon2-kdf.js');
    const salt = new Uint8Array(SALT);

    await deriveArgon2Key('123456', salt);

    expect(salt.byteLength).toBe(16);
    expect((w.instances[0].posted[0] as { salt: Uint8Array }).salt).not.toBe(salt);
  }, 60_000);
});
