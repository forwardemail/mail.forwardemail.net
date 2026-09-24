/**
 * One-shot Argon2id derivation off the main thread.
 *
 * The shared cost profile (utils/argon2-kdf.js) allocates 256 MiB of
 * WebAssembly memory and runs for seconds on a phone. On the main thread that
 * froze the PIN pad mid-entry (taps queued up and landed after the check,
 * starting a new PIN) and left a 256 MiB buffer for the garbage collector,
 * which iOS often killed the page for first. The caller terminates this
 * worker after every derivation, which releases that memory immediately.
 */
import { argon2id } from 'hash-wasm';

interface DeriveRequest {
  id: number;
  password: string;
  salt: Uint8Array;
  hashLength: number;
  iterations: number;
  memorySize: number;
  parallelism: number;
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<DeriveRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void;
};

ctx.onmessage = async (event) => {
  const { id, password, salt, hashLength, iterations, memorySize, parallelism } =
    event.data || ({} as DeriveRequest);
  try {
    const result = (await argon2id({
      password,
      salt,
      parallelism,
      iterations,
      memorySize,
      hashLength,
      outputType: 'binary',
    })) as Uint8Array;
    ctx.postMessage({ id, ok: true, result }, [result.buffer as ArrayBuffer]);
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
