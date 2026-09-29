/**
 * Clicking a web notification (drawn by the service worker) has to open the
 * message it is about. The service worker had no notificationclick handler,
 * so a click only closed the notification. This runs the real
 * public/sw-sync.js in a service-worker-shaped context.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'public/sw-sync.js'), 'utf8');

function loadServiceWorker(windows) {
  const handlers = {};
  const self = {
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    location: { origin: 'https://mail.example.com' },
    registration: { scope: 'https://mail.example.com/' },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
  };
  vm.runInNewContext(source, {
    self,
    URL,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: {},
  });
  return { self, handlers };
}

async function click(handlers, data) {
  let done;
  const notification = { data, close: vi.fn() };
  handlers.notificationclick({
    notification,
    waitUntil: (promise) => {
      done = promise;
    },
  });
  await done;
  return notification;
}

const target = { account: 'bob@example.com', folder: 'INBOX', messageId: 'm-1' };

describe('service worker notificationclick', () => {
  it('focuses an open app window and tells it what to open', async () => {
    const client = {
      url: 'https://mail.example.com/mailbox#INBOX',
      focus: vi.fn(async () => {}),
      postMessage: vi.fn(),
    };
    const { self, handlers } = loadServiceWorker([client]);

    const notification = await click(handlers, { target });

    expect(notification.close).toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'notification-click', target });
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window with the target in its URL when none is open', async () => {
    const { self, handlers } = loadServiceWorker([]);

    await click(handlers, { target });

    expect(self.clients.openWindow).toHaveBeenCalledTimes(1);
    const url = new URL(self.clients.openWindow.mock.calls[0][0]);
    expect(url.origin).toBe('https://mail.example.com');
    expect(url.pathname).toBe('/mailbox');
    expect(JSON.parse(url.searchParams.get('fe_notify'))).toEqual(target);
  });

  it('ignores windows from other origins', async () => {
    const other = {
      url: 'https://elsewhere.example.net/',
      focus: vi.fn(),
      postMessage: vi.fn(),
    };
    const { self, handlers } = loadServiceWorker([other]);

    await click(handlers, { target });

    expect(other.postMessage).not.toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalled();
  });
});
