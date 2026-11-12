/**
 * Web Push alerts are drawn by the service worker with no page to ask, so the
 * notification privacy setting (issue #113) has to reach it. This runs the
 * real public/sw-sync.js in a service-worker-shaped context.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'public/sw-sync.js'), 'utf8');

function loadServiceWorker(windows = []) {
  const handlers = {};
  const cache = new Map();
  const caches = {
    open: async () => ({
      put: async (key, response) => cache.set(key, await response.text()),
      match: async (key) => (cache.has(key) ? new Response(cache.get(key)) : undefined),
    }),
  };
  const self = {
    addEventListener: (type, handler) => {
      (handlers[type] ||= []).push(handler);
    },
    location: { origin: 'https://mail.example.com' },
    registration: { scope: 'https://mail.example.com/', showNotification: vi.fn(async () => {}) },
    // Safari: always draws a notification, focused window or not
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15' },
    clients: {
      matchAll: vi.fn(async () => windows),
      get: vi.fn(async (id) => windows.find((w) => w.id === id)),
    },
  };
  vm.runInNewContext(source, {
    self,
    caches,
    Response,
    URL,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: {},
  });
  const dispatch = async (type, event) => {
    let pending = [];
    for (const handler of handlers[type] || []) {
      handler({ ...event, waitUntil: (promise) => pending.push(promise) });
    }
    await Promise.all(pending);
  };
  return { self, dispatch };
}

const appWindow = { id: 'window-1', url: 'https://mail.example.com/mailbox' };

const share = (sw, preview, source = appWindow) =>
  sw.dispatch('message', { source, data: { type: 'push-preview', preview } });

const mailPush = {
  event: 'newMessage',
  title: 'Alex Rivera',
  body: 'Lunch on Friday?\nAre you free at noon',
  subject: 'Lunch on Friday?',
  message_id: 'm-1',
};

const push = (sw, data = mailPush) => sw.dispatch('push', { data: { json: () => data } });
const shown = (sw) => {
  const [title, options] = sw.self.registration.showNotification.mock.calls.at(-1);
  return { title, body: options.body };
};

describe('service worker push preview', () => {
  it('shows sender and subject, without the preview, before the page says anything', async () => {
    const sw = loadServiceWorker();
    await push(sw);
    expect(shown(sw)).toEqual({ title: 'Alex Rivera', body: 'Lunch on Friday?' });
  });

  it('follows the levels the page shares', async () => {
    const sw = loadServiceWorker([appWindow]);
    await share(sw, { unlocked: 'full', locked: 'none', lockEnabled: false, lockedNow: false });
    await push(sw);
    // Line breaks become spaces in a notification body.
    expect(shown(sw)).toEqual({
      title: 'Alex Rivera',
      body: 'Lunch on Friday? Are you free at noon',
    });
  });

  it('uses the locked level while the app is locked', async () => {
    const sw = loadServiceWorker([appWindow]);
    await share(sw, { unlocked: 'full', locked: 'sender', lockEnabled: true, lockedNow: true });
    await push(sw);
    expect(shown(sw)).toEqual({ title: 'Alex Rivera', body: '' });
  });

  it('does not trust "unlocked" from a window that has since closed', async () => {
    const sw = loadServiceWorker([]);
    await share(sw, { unlocked: 'full', locked: 'none', lockEnabled: true, lockedNow: false });
    await push(sw);
    expect(shown(sw)).toEqual({ title: 'New email', body: '' });
  });

  it('shows the unlocked level while the unlocked window is open', async () => {
    const sw = loadServiceWorker([appWindow]);
    await share(sw, { unlocked: 'sender', locked: 'none', lockEnabled: true, lockedNow: false });
    await push(sw);
    expect(shown(sw)).toEqual({ title: 'Alex Rivera', body: '' });
  });

  it('treats a closed app with App Lock as locked', async () => {
    const sw = loadServiceWorker([]);
    await share(sw, { unlocked: 'full', locked: 'none', lockEnabled: true, lockedNow: false });
    await push(sw);
    expect(shown(sw)).toEqual({ title: 'New email', body: '' });
  });

  it('takes the subject from the first line when the push names none', async () => {
    const sw = loadServiceWorker();
    await push(sw, { ...mailPush, subject: undefined });
    expect(shown(sw)).toEqual({ title: 'Alex Rivera', body: 'Lunch on Friday?' });
  });

  it('keeps calendar text, and hides it when the level is nothing', async () => {
    const sw = loadServiceWorker([appWindow]);
    const event = { event: 'calendarEventCreated', title: 'Event added', body: 'Standup' };
    await share(sw, { unlocked: 'sender', locked: 'none', lockEnabled: false, lockedNow: false });
    await push(sw, event);
    expect(shown(sw)).toEqual({ title: 'Event added', body: 'Standup' });
    await share(sw, { unlocked: 'none', locked: 'none', lockEnabled: false, lockedNow: false });
    await push(sw, event);
    expect(shown(sw)).toEqual({ title: 'Calendar updated', body: '' });
  });
});
