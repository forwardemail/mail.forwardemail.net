import { resolveObjectURL } from 'node:buffer';
import { Worker as NodeWorker } from 'node:worker_threads';

/**
 * Web Worker for the terminal build, on a real thread.
 *
 * The webmail bundles its workers inline (`?worker&inline`), so each one
 * arrives as a blob: or data: URL holding a self-contained script. Each runs
 * in a Node worker thread behind the bootstrap in ./worker-thread.ts, which
 * gives it a WorkerGlobalScope. Database, sync and search work therefore
 * stays off the thread that draws the terminal, as it stays off a browser's
 * main thread, and nothing has to be located on disk at runtime.
 *
 * Messages are structured-cloned in both directions, and transferred
 * MessagePorts arrive as `event.ports`.
 */

type Listener = (event: unknown) => void;

export interface WorkerOptions {
  href: () => string;
  log: string | null;
}

let options: WorkerOptions = { href: () => 'https://mail.forwardemail.net/', log: null };

export function configureWorkers(next: WorkerOptions) {
  options = next;
}

// Resolved synchronously: Vite's wrapper revokes the blob URL right after
// the constructor returns.
function loadScript(url: string): Promise<string> {
  if (url.startsWith('blob:')) {
    const blob = resolveObjectURL(url);
    if (!blob) return Promise.reject(new Error(`Worker script not found: ${url}`));
    return blob.text();
  }

  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    return Promise.resolve(
      meta.endsWith(';base64')
        ? Buffer.from(body, 'base64').toString('utf8')
        : decodeURIComponent(body),
    );
  }

  return Promise.reject(
    new Error(`Only inline workers are supported in the terminal (got ${url})`),
  );
}

function transferList(transfer?: unknown[] | { transfer?: unknown[] }) {
  return (Array.isArray(transfer) ? transfer : (transfer?.transfer ?? [])) as unknown[];
}

export class ThreadWorker {
  onmessage: Listener | null = null;
  onmessageerror: Listener | null = null;
  onerror: Listener | null = null;
  #listeners = new Map<string, Set<Listener>>();
  #wrapped = new WeakMap<object, Listener>();
  #thread: NodeWorker | null = null;
  #queue: Array<[unknown, unknown[]]> = [];
  #terminated = false;

  constructor(url: string | URL, init: { name?: string } = {}) {
    const name = init.name ?? '';
    loadScript(String(url)).then(
      (code) => {
        if (this.#terminated) return;
        // The bootstrap runs in its own scope: its bundled modules declare
        // top-level names (fake-indexeddb's Event) that would otherwise
        // shadow the globals of the worker code that follows.
        const source = `(function () {\n${__forwardemailWorkerBootstrap}\n})();\n${code}`;
        const thread = new NodeWorker(source, {
          eval: true,
          name,
          workerData: {
            name,
            href: options.href(),
            log: options.log,
            api: (globalThis as Record<string, unknown>).__FORWARDEMAIL_API_URL__,
          },
          stdout: true,
          stderr: true,
        });
        thread.stdout.resume();
        thread.stderr.resume();
        thread.on('message', (message: { data: unknown; ports: MessagePort[] }) => {
          this.#dispatch({
            type: 'message',
            data: message?.data,
            ports: message?.ports ?? [],
            target: this,
            currentTarget: this,
          });
        });
        thread.on('messageerror', (error) => {
          this.#dispatch({ type: 'messageerror', data: error, target: this });
        });
        thread.on('error', (error) => this.#error(error));
        thread.unref();
        this.#thread = thread;
        for (const [data, list] of this.#queue.splice(0)) this.#send(data, list);
      },
      (error) => this.#error(error),
    );
  }

  postMessage(data: unknown, transfer?: unknown[] | { transfer?: unknown[] }): void {
    if (this.#terminated) return;
    const list = transferList(transfer);
    if (!this.#thread) {
      this.#queue.push([data, list]);
      return;
    }
    this.#send(data, list);
  }

  #send(data: unknown, list: unknown[]) {
    const ports = list.filter((item) => item instanceof MessagePort);
    try {
      this.#thread!.postMessage({ data, ports }, list as never);
    } catch (error) {
      this.#dispatch({ type: 'messageerror', data: error, target: this });
    }
  }

  terminate(): void {
    this.#terminated = true;
    this.#queue = [];
    void this.#thread?.terminate();
  }

  addEventListener(type: string, listener: Listener | { handleEvent: Listener } | null): void {
    if (!listener) return;
    let fn = listener as Listener;
    if (typeof listener !== 'function') {
      fn = this.#wrapped.get(listener) ?? ((event) => listener.handleEvent(event));
      this.#wrapped.set(listener, fn);
    }
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, listener: Listener | { handleEvent: Listener } | null): void {
    if (!listener) return;
    const fn = typeof listener === 'function' ? listener : this.#wrapped.get(listener);
    if (fn) this.#listeners.get(type)?.delete(fn);
  }

  dispatchEvent(event: { type: string }): boolean {
    this.#dispatch(event as { type: string } & Record<string, unknown>);
    return true;
  }

  #dispatch(event: { type: string } & Record<string, unknown>) {
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof handler === 'function') handler.call(this, event);
    for (const listener of [...(this.#listeners.get(event.type) ?? [])]) {
      listener.call(this, event);
    }
  }

  #error(error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[worker]', err);
    this.#dispatch({
      type: 'error',
      message: err.message,
      error: err,
      filename: '',
      lineno: 0,
      colno: 0,
      target: this,
      preventDefault() {},
    });
  }
}
