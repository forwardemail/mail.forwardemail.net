/**
 * navigator.onLine and the online/offline events for the terminal client.
 *
 * A browser tells the webmail when the network goes away; that is what
 * holds drafts, queued changes and outgoing mail locally and sends them once
 * the connection is back (utils/network-status.js, draft-service.js,
 * mutation-queue.js, outbox-service.js). Here a request that fails for lack
 * of a network marks the client offline, and from then on the API host is
 * tried every few seconds until it answers, which marks it online again.
 */
import net from 'node:net';
import type { AnyRecord } from './types';

const NETWORK_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Whether a fetch rejection means the network (not the server) failed. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  if (!cause) return false;
  if (cause.code && NETWORK_ERRORS.has(cause.code)) return true;
  return Boolean(cause.errors?.some((inner) => inner.code && NETWORK_ERRORS.has(inner.code)));
}

/** Resolves true when a TCP connection to host:port opens within the timeout. */
export function canConnect(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function installNetwork(
  win: AnyRecord,
  options: {
    probe: () => Promise<boolean>;
    intervalMs?: number;
  },
) {
  let online = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  const intervalMs = options.intervalMs ?? 5000;

  Object.defineProperty(win.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });

  const setOnline = (next: boolean) => {
    if (next === online) return;
    online = next;
    if (online && timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!online && !timer) {
      timer = setInterval(() => {
        options.probe().then(
          (reachable) => reachable && setOnline(true),
          () => {},
        );
      }, intervalMs);
      timer.unref?.();
    }
    win.dispatchEvent(new win.Event(online ? 'online' : 'offline'));
  };

  return {
    isOnline: () => online,
    setOnline,
    /** Wraps fetch so its outcome says whether the network is there. */
    wrapFetch(fetchImpl: typeof fetch): typeof fetch {
      return ((input: RequestInfo | URL, init?: RequestInit) =>
        fetchImpl(input, init).then(
          (response) => {
            setOnline(true);
            return response;
          },
          (error: unknown) => {
            if (isNetworkError(error)) setOnline(false);
            throw error;
          },
        )) as typeof fetch;
    },
  };
}
