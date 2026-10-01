/**
 * A message the client drops (too large, or past the rate limit) may have
 * been an event, so the client reports it and the updater refreshes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSocketClient } from '../../src/utils/websocket-client.js';

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  async emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    for (const fn of this.listeners.get(type) || []) await fn(event);
  }
}

let originalWebSocket;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

async function connectedClient() {
  const client = createWebSocketClient({
    email: 'me@example.com',
    password: 'secret',
    apiBase: 'https://api.example.com',
  });
  const dropped = vi.fn();
  const events = vi.fn();
  client.on('_messageDropped', dropped);
  client.on('flagsUpdated', events);
  await client.connect();
  const ws = FakeWebSocket.instances.at(-1);
  await ws.emit('open');
  await ws.emit('message', { data: JSON.stringify({ event: 'connected', aliasId: 'a1' }) });
  return { client, ws, dropped, events };
}

describe('websocket client dropped messages', () => {
  it('reports an oversized message', async () => {
    const { client, ws, dropped } = await connectedClient();

    await ws.emit('message', { data: 'x'.repeat(65 * 1024) });

    expect(dropped).toHaveBeenCalledWith({ reason: 'size' });
    client.destroy();
  });

  it('reports messages past the rate limit once per window', async () => {
    const { client, ws, dropped, events } = await connectedClient();
    const event = JSON.stringify({ event: 'flagsUpdated', mailbox: 'm', uids: [1] });

    for (let i = 0; i < 205; i++) await ws.emit('message', { data: event });

    expect(events).toHaveBeenCalledTimes(199);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledWith({ reason: 'rate-limit' });
    client.destroy();
  });
});
