/**
 * Runs first in every Web Worker thread (see ./worker.ts), before the
 * worker's own script. It turns the thread's global scope into a
 * WorkerGlobalScope as far as the webmail's workers need one: `self`,
 * postMessage and message events with transferred ports, IndexedDB, and a
 * console that does not write over the terminal.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { format } from 'node:util';
import * as fakeIndexedDB from 'fake-indexeddb';

type Listener = (event: MessageEvent) => void;

const g = globalThis as unknown as Record<string, unknown>;
const target = new EventTarget();
const data = (workerData ?? {}) as {
  name?: string;
  href?: string;
  log?: string | null;
  api?: string;
};

// `self instanceof WorkerGlobalScope` is how the app tells it is in a worker.
class WorkerGlobalScope {
  static [Symbol.hasInstance](value: unknown) {
    return value === globalThis;
  }
}

let onmessage: Listener | null = null;

Object.assign(g, fakeIndexedDB, {
  // The API server chosen with --api, as the main thread has it.
  __FORWARDEMAIL_API_URL__: data.api,
  self: globalThis,
  name: data.name ?? '',
  WorkerGlobalScope,
  DedicatedWorkerGlobalScope: WorkerGlobalScope,
  location: new URL(data.href ?? 'https://mail.forwardemail.net/'),
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
  postMessage(message: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }) {
    const list = (Array.isArray(transfer) ? transfer : (transfer?.transfer ?? [])) as unknown[];
    const ports = list.filter((item) => item instanceof MessagePort);
    parentPort!.postMessage({ data: message, ports }, list as never);
  },
  close() {
    process.exit(0);
  },
  importScripts() {
    throw new Error('importScripts() is not available in the terminal');
  },
});
delete g.default;
Object.defineProperty(g, 'onmessage', {
  configurable: true,
  get: () => onmessage,
  set: (value) => {
    onmessage = typeof value === 'function' ? value : null;
  },
});

parentPort!.on('message', (message: { data: unknown; ports: MessagePort[] }) => {
  const event = new MessageEvent('message', { data: message.data, ports: message.ports ?? [] });
  onmessage?.call(globalThis, event);
  target.dispatchEvent(event);
});

// Worker output goes to the log file when debugging, and nowhere otherwise.
const log = data.log;
const fd = log ? fs.openSync(log, 'a', 0o600) : null;
for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table']) {
  (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
    if (fd === null) return;
    const line = `${new Date().toISOString()} ${method.toUpperCase()} [worker ${data.name ?? ''}] ${format(...args)}\n`;
    try {
      fs.writeSync(fd, line);
    } catch {
      // ignore
    }
  };
}
