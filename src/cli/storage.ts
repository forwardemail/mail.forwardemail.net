import fs from 'node:fs';
import path from 'node:path';

const kData = Symbol('data');

/**
 * Web Storage backed by a JSON file, so `localStorage` survives between runs
 * the way it does in a browser profile. The file is private to the user
 * (0600) because the webmail keeps its session in localStorage.
 *
 * Writes are coalesced and flushed synchronously on exit, so a burst of
 * setItem() calls costs one write.
 */
export class FileStorage {
  [kData]: Map<string, string>;
  #file: string | null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(file: string | null) {
    this.#file = file;
    this[kData] = new Map();
    if (file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            this[kData].set(key, String(value));
          }
        }
      } catch {
        // missing or unreadable file starts empty, like a fresh profile
      }

      process.once('exit', () => this.flush());
    }
  }

  get length(): number {
    return this[kData].size;
  }

  key(index: number): string | null {
    return [...this[kData].keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    const value = this[kData].get(String(key));
    return value === undefined ? null : value;
  }

  setItem(key: string, value: unknown): void {
    this[kData].set(String(key), String(value));
    this.#schedule();
  }

  removeItem(key: string): void {
    if (this[kData].delete(String(key))) this.#schedule();
  }

  clear(): void {
    if (this[kData].size === 0) return;
    this[kData].clear();
    this.#schedule();
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (!this.#file) return;
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this[kData])), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  #schedule(): void {
    if (!this.#file || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      try {
        this.flush();
      } catch (error) {
        console.error('[forwardemail] could not save local storage:', error);
      }
    }, 50);
    this.#timer.unref?.();
  }
}

/**
 * Browsers expose stored keys as properties (`localStorage.foo`); a Proxy
 * gives the file-backed storage the same shape.
 */
export function createStorage(file: string | null): Storage {
  const storage = new FileStorage(file);
  return new Proxy(storage, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return target.getItem(prop) ?? undefined;
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.set(target, prop, value);
      target.setItem(prop, value);
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string') target.removeItem(prop);
      return true;
    },
    has(target, prop) {
      return typeof prop === 'string' ? target[kData].has(prop) || prop in target : prop in target;
    },
    ownKeys(target) {
      return [...target[kData].keys()];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && target[kData].has(prop)) {
        return { value: target[kData].get(prop), enumerable: true, configurable: true };
      }
      return undefined;
    },
  }) as unknown as Storage;
}
