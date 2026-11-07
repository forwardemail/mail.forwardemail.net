/**
 * One-click unsubscribe (RFC 8058) is sent by the service worker, because
 * the page's CSP allows connections to the Forward Email API only. This runs
 * the real public/sw-sync.js in a service-worker-shaped context: it must send
 * only the POST RFC 8058 defines, without cookies or a referrer, to a public
 * https host, and only when a top-level window of the app asks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'public/sw-sync.js'), 'utf8');

const ORIGIN = 'https://mail.example.com';
const URL_ONE_CLICK = 'https://news.example.com/u?id=1';

function loadServiceWorker(fetch) {
  const handlers = {};
  const self = {
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    clients: { matchAll: vi.fn(async () => []) },
  };
  vm.runInNewContext(source, {
    self,
    URL,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch,
    indexedDB: {},
  });
  return handlers;
}

const appWindow = { type: 'window', frameType: 'top-level', url: `${ORIGIN}/mailbox` };

// what the service worker replied (and the request it sent, if any)
async function ask(handlers, url, from = appWindow) {
  const port = { postMessage: vi.fn() };
  let sent;
  handlers.message({
    data: { type: 'one-click-unsubscribe', url },
    ports: [port],
    source: from,
    waitUntil: (promise) => {
      sent = promise;
    },
  });
  await sent;
  return port.postMessage.mock.calls[0]?.[0];
}

describe('service worker one-click unsubscribe', () => {
  it('sends the RFC 8058 POST without cookies or a referrer', async () => {
    const fetch = vi.fn(async () => ({ type: 'opaque' }));
    const handlers = loadServiceWorker(fetch);

    expect(await ask(handlers, URL_ONE_CLICK)).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(URL_ONE_CLICK);
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
  });

  it('only for a top-level window of the app, never a message frame', async () => {
    const fetch = vi.fn(async () => ({ type: 'opaque' }));
    const handlers = loadServiceWorker(fetch);

    for (const from of [
      // (the email reader is a srcdoc iframe that shares this worker)
      { ...appWindow, frameType: 'nested' },
      { ...appWindow, url: 'https://evil.example/' },
      { type: 'worker', url: `${ORIGIN}/assets/sync.js` },
      null,
    ]) {
      expect(await ask(handlers, URL_ONE_CLICK, from)).toEqual({ ok: false });
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  it('only to an https URL on a public host name', async () => {
    const fetch = vi.fn(async () => ({ type: 'opaque' }));
    const handlers = loadServiceWorker(fetch);

    for (const url of [
      'http://news.example.com/u',
      'https://user:pass@news.example.com/u',
      'https://news.example.com:8443/u',
      'https://192.168.1.1/u',
      'https://2130706433/u',
      'https://[::1]/u',
      'https://localhost/u',
      'https://router.local/u',
      'https://nas.home.arpa/u',
      'https://intranet/u',
      `https://news.example.com/${'a'.repeat(3000)}`,
      'javascript:alert(1)',
      42,
    ]) {
      expect(await ask(handlers, url), String(url)).toEqual({ ok: false });
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  it('one request at a time, and a server that cannot be reached is not sent', async () => {
    let finish;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const handlers = loadServiceWorker(fetch);

    const first = ask(handlers, URL_ONE_CLICK);
    expect(await ask(handlers, URL_ONE_CLICK)).toEqual({ ok: false });
    finish({ type: 'opaque' });
    expect(await first).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await ask(handlers, URL_ONE_CLICK)).toEqual({ ok: false });
  });
});
