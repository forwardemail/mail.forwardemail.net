// @vitest-environment node
/**
 * The WebSocket client against a real local server that behaves like
 * api.forwardemail.net: credentials in the URL are rejected with 400, and a
 * `?auth=message` connection is authenticated by its first message.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EMAIL = 'me@example.com';
const PASSWORD = 'generated:pass';

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function textFrame(text) {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function closeFrame(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

// Read one masked client frame from `buffer`; null until it is complete.
function readClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    return null; // not needed here
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload };
}

function startServer() {
  const state = {
    // close codes to answer the next first messages with
    failNext: [],
    // close codes to close the next sockets with after they are accepted
    closeNext: [],
    upgrades: [],
    // first frames received: { opcode, text }
    authMessages: [],
    sockets: new Set(),
  };

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    state.sockets.add(socket);
    socket.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    state.upgrades.push(url);
    if (
      url.searchParams.has('username') ||
      url.searchParams.has('password') ||
      url.searchParams.has('token') ||
      req.headers.authorization
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
        '',
        '',
      ].join('\r\n'),
    );
    if (url.searchParams.get('auth') !== 'message') {
      socket.write(textFrame(JSON.stringify({ event: 'connected', broadcastOnly: true })));
      return;
    }

    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk) => {
      if (answered) return;
      buffer = Buffer.concat([buffer, chunk]);
      const frame = readClientFrame(buffer);
      if (!frame) return;
      answered = true;
      const text = frame.payload.toString('utf8');
      state.authMessages.push({ opcode: frame.opcode, text });
      const failure = state.failNext.shift();
      if (failure) {
        socket.end(closeFrame(failure));
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        socket.end(closeFrame(4400));
        return;
      }
      if (
        frame.opcode !== 1 ||
        message.event !== 'auth' ||
        message.username !== EMAIL ||
        message.password !== PASSWORD
      ) {
        socket.end(closeFrame(4401));
        return;
      }
      socket.write(textFrame(JSON.stringify({ event: 'connected', aliasId: 'alias1' })));
      const closeCode = state.closeNext.shift();
      if (closeCode) socket.end(closeFrame(closeCode));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

function once(client, event) {
  return new Promise((resolve) => {
    const off = client.on(event, (payload) => {
      off();
      resolve(payload);
    });
  });
}

describe('websocket client first-message authentication', () => {
  let ctx;
  let client;

  beforeEach(async () => {
    globalThis.window = globalThis.window || {
      addEventListener() {},
      removeEventListener() {},
    };
    ctx = await startServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    client?.destroy();
    client = null;
    for (const socket of ctx.state.sockets) socket.destroy();
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
  });

  async function create(extra = {}) {
    const { createWebSocketClient } = await import('../../src/utils/websocket-client.js');
    client = createWebSocketClient({
      email: EMAIL,
      password: PASSWORD,
      apiBase: `http://localhost:${ctx.port}`,
      ...extra,
    });
    return client;
  }

  it('sends the credentials as the first message, never in the URL', async () => {
    await create();
    const authenticated = once(client, '_authenticated');
    client.connect();

    await expect(authenticated).resolves.toEqual({ aliasId: 'alias1' });
    expect(ctx.state.upgrades).toHaveLength(1);
    const [url] = ctx.state.upgrades;
    expect(url.pathname).toBe('/v1/ws');
    expect(url.searchParams.get('auth')).toBe('message');
    expect(url.search).not.toContain(encodeURIComponent(PASSWORD));
    expect(url.search).not.toContain('me%40example.com');
    expect(ctx.state.authMessages).toEqual([
      {
        opcode: 1,
        text: JSON.stringify({ event: 'auth', username: EMAIL, password: PASSWORD }),
      },
    ]);
  });

  it('sends the credentials as a JSON text frame in msgpackr mode too', async () => {
    await create({ useMsgpackr: true });
    const authenticated = once(client, '_authenticated');
    client.connect();

    await expect(authenticated).resolves.toEqual({ aliasId: 'alias1' });
    expect(ctx.state.authMessages[0].opcode).toBe(1);
  });

  it('connects without credentials as broadcast-only and sends nothing', async () => {
    const { createWebSocketClient } = await import('../../src/utils/websocket-client.js');
    client = createWebSocketClient({ apiBase: `http://localhost:${ctx.port}` });
    const broadcastOnly = once(client, '_broadcastOnly');
    client.connect();

    await broadcastOnly;
    expect(ctx.state.upgrades[0].searchParams.has('auth')).toBe(false);
    expect(ctx.state.authMessages).toHaveLength(0);
  });

  for (const code of [4400, 4401, 4403]) {
    it(`stops without reconnecting when the server closes with ${code}`, async () => {
      // no jitter: a retry would come after exactly one second
      vi.spyOn(Math, 'random').mockReturnValue(0);
      ctx.state.failNext.push(code);
      await create();
      const failed = once(client, '_authFailed');
      client.connect();

      await expect(failed).resolves.toEqual({ code });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(ctx.state.upgrades).toHaveLength(1);
    });
  }

  it('retries with backoff when the server asks to try again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    ctx.state.failNext.push(1013, 4429);
    await create();
    const authenticated = once(client, '_authenticated');
    client.connect();

    await expect(authenticated).resolves.toEqual({ aliasId: 'alias1' });
    expect(ctx.state.upgrades).toHaveLength(3);
    expect(ctx.state.authMessages).toHaveLength(3);
  });

  it('reconnects and authenticates again when the server revokes the socket', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    ctx.state.closeNext.push(4001);
    await create();
    const disconnected = once(client, '_disconnected');
    client.connect();
    await expect(disconnected).resolves.toMatchObject({ code: 4001 });

    const again = once(client, '_authenticated');
    await expect(again).resolves.toEqual({ aliasId: 'alias1' });
    expect(ctx.state.upgrades).toHaveLength(2);
    expect(ctx.state.authMessages).toHaveLength(2);
  });

  it('reconnects with the new credentials when they change', async () => {
    await create();
    const first = once(client, '_authenticated');
    client.connect();
    await first;

    const failed = once(client, '_authFailed');
    client.updateCredentials(EMAIL, 'new password');
    await expect(failed).resolves.toEqual({ code: 4401 });
    expect(JSON.parse(ctx.state.authMessages[1].text).password).toBe('new password');
  });

  it('sends nothing when destroyed before the socket opens', async () => {
    await create();
    client.connect();
    client.destroy();
    client = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ctx.state.authMessages).toHaveLength(0);
  });
});
