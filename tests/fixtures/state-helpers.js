import { expect } from '@playwright/test';

// A small in-memory stand-in for the Forward Email API, used by the state-*
// specs. It keeps one copy of every message with its folder and flags, so the
// folder list, the message lists and the unread listing all agree with each
// other and with every change the app has sent, the way the real server does.
// Every request is logged so a spec can count exactly what reached the server.

export const ACCOUNT = 'test@example.com';
export const PASSWORD = 'mock-password';

const SEEN = '\\Seen';

const DEFAULT_FOLDERS = [
  { path: 'INBOX', name: 'INBOX', special_use: '\\Inbox' },
  { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' },
  { path: 'Sent Mail', name: 'Sent Mail', special_use: '\\Sent' },
  { path: 'Archive', name: 'Archive', special_use: '\\Archive' },
  { path: 'Spam', name: 'Spam', special_use: '\\Junk' },
  { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
];

const BASE_DATE = Date.UTC(2026, 9, 1, 12, 0, 0);

// One message as the API lists it. `n` orders them: 1 is the newest.
export function buildMessage(n, { folder = 'INBOX', unread = false, subject, ...rest } = {}) {
  return {
    id: `msg-${n}`,
    uid: n,
    folder_path: folder,
    subject: subject || `Message ${String(n).padStart(4, '0')}`,
    from: [{ address: `sender${n % 7}@example.org`, name: `Sender ${n % 7}` }],
    to: [{ address: ACCOUNT, name: '' }],
    cc: [],
    date: new Date(BASE_DATE - n * 60_000).toISOString(),
    header_date: new Date(BASE_DATE - n * 60_000).toISOString(),
    flags: unread ? [] : [SEEN],
    labels: [],
    size: 2048,
    has_attachment: false,
    snippet: `Body of message ${n}`,
    ...rest,
  };
}

const isUnread = (msg) => !(msg.flags || []).includes(SEEN);

const listItem = (msg) => ({
  ...msg,
  is_unread: isUnread(msg),
  is_flagged: (msg.flags || []).includes('\\Flagged'),
});

const rawFor = (msg) =>
  [
    `From: ${msg.from[0].name} <${msg.from[0].address}>`,
    `To: ${ACCOUNT}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date(msg.date).toUTCString()}`,
    `Message-ID: <${msg.id}@example.org>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    msg.snippet,
    '',
  ].join('\r\n');

const json = (route, payload, { status = 200, headers = {} } = {}) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(payload),
  });

/**
 * Serve folders and messages from in-memory state. Register it after
 * setupAuthenticatedMailbox so these routes win over the generic ones there.
 *
 * Options:
 *   messages      the server's messages (buildMessage rows)
 *   folders       folder rows ({ path, name, special_use })
 *   holdListPages list requests (not the unread listing) for pages above this
 *                 number wait until server.releaseListPages() is called. Use it
 *                 to keep background sync from caching the whole folder.
 *   listDelay     (params) => milliseconds to wait before answering a list
 *                 request, to give the server some latency
 *   detailBody    (msg) => extra fields for the message detail response
 *   indexLag      milliseconds a moved message keeps showing in the list of
 *                 the folder it left, as the real API does while its indexer
 *                 catches up (10-30 seconds in production)
 */
export async function installMailServer(page, options = {}) {
  const server = createMailServer(options);
  await routeApi(page, server.handle, () => server.offline);
  return server;
}

/**
 * One server per signed-in account, picked by the credentials each request
 * carries, as the real API does. `accounts` maps an email to its password and
 * the installMailServer options for its mailbox. Requests with credentials
 * for no account get a 401.
 */
export async function installAccountServers(page, accounts) {
  const servers = {};
  const byAuth = new Map();
  for (const [email, { password, ...options }] of Object.entries(accounts)) {
    servers[email] = createMailServer(options);
    const basic = Buffer.from(`${email}:${password}`).toString('base64');
    byAuth.set(`Basic ${basic}`, servers[email]);
  }
  const handle = (route) => {
    const server = byAuth.get(route.request().headers().authorization || '');
    if (!server) return json(route, { message: 'Invalid credentials' }, { status: 401 });
    return server.handle(route);
  };
  await routeApi(page, handle, () => false);
  return servers;
}

async function routeApi(page, handle, isOffline) {
  await page.route('**/v1/folders**', handle);
  await page.route('**/v1/messages**', handle);
  // The service worker sends queued changes itself when the tab is gone or
  // Background Sync fires. Page routes do not see its requests; context
  // routes do, so the same server answers them and counts them too.
  const context = page.context();
  await context.route('**/v1/folders**', handle);
  await context.route('**/v1/messages**', handle);

  // Playwright still fulfils routed requests while the context is offline, so
  // the API mocks would keep answering. This guard is registered last, which
  // makes it the first route consulted: while offline every API request fails
  // the way it does on a real dropped connection.
  const offlineGuard = (route) =>
    isOffline() ? route.abort('internetdisconnected') : route.fallback();
  await page.route('**/v1/**', offlineGuard);
  await context.route('**/v1/**', offlineGuard);
}

function createMailServer({
  messages = [],
  folders = DEFAULT_FOLDERS,
  holdListPages = null,
  listDelay = null,
  detailBody = null,
  indexLag = 0,
} = {}) {
  const state = new Map(messages.map((m) => [m.id, structuredClone(m)]));
  // id -> { folder, until }: the folder lists still report until `until`
  const lagging = new Map();
  const listedFolder = (m) => {
    const lag = lagging.get(m.id);
    return lag && Date.now() < lag.until ? lag.folder : m.folder_path;
  };
  const log = [];
  let releaseHeld;
  const held = new Promise((resolve) => {
    releaseHeld = resolve;
  });

  const server = {
    offline: false,
    log,
    messages: state,
    get(id) {
      return state.get(id);
    },
    unreadIn(path) {
      return [...state.values()].filter((m) => m.folder_path === path && isUnread(m)).length;
    },
    requests(filter = {}) {
      return log.filter(
        (entry) =>
          (!filter.method || entry.method === filter.method) &&
          (!filter.path || entry.path === filter.path || filter.path.test?.(entry.path)),
      );
    },
    // PUT and DELETE requests for one message.
    changesFor(id) {
      return log.filter(
        (entry) =>
          (entry.method === 'PUT' || entry.method === 'DELETE') &&
          entry.path === `/v1/messages/${encodeURIComponent(id)}`,
      );
    },
    folderLists() {
      return log.filter((entry) => entry.method === 'GET' && entry.path === '/v1/folders');
    },
    releaseListPages() {
      releaseHeld();
    },
  };

  const folderRows = () =>
    folders.map((f, i) => {
      const inFolder = [...state.values()].filter((m) => m.folder_path === f.path);
      return {
        id: `folder-${i + 1}`,
        path: f.path,
        name: f.name,
        special_use: f.special_use,
        subscribed: true,
        total: inFolder.length,
        unseen_count: inFolder.filter(isUnread).length,
      };
    });

  const sorted = (list) => list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const handle = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const entry = {
      method,
      path,
      params: Object.fromEntries(url.searchParams),
      body,
      auth: request.headers().authorization || '',
    };
    log.push(entry);

    if (path === '/v1/folders' && method === 'GET') return json(route, folderRows());

    if (path === '/v1/messages' && method === 'GET') {
      const folder = url.searchParams.get('folder');
      const unreadOnly = url.searchParams.get('is_unread') === 'true';
      const limit = Number(url.searchParams.get('limit') || 50);
      const pageNo = Number(url.searchParams.get('page') || 1);
      if (holdListPages != null && !unreadOnly && pageNo > holdListPages) await held;
      const delay = listDelay ? listDelay(entry.params) : 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      let list = [...state.values()];
      if (folder) list = list.filter((m) => listedFolder(m) === folder);
      if (unreadOnly) list = list.filter(isUnread);
      sorted(list);
      // A lagging row is reported as the stale copy, still in its old folder
      const slice = list
        .slice((pageNo - 1) * limit, pageNo * limit)
        .map((m) => listItem({ ...m, folder_path: listedFolder(m) }));
      return json(route, slice, { headers: { 'X-Item-Count': String(list.length) } });
    }

    const detail = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      const msg = state.get(id);
      if (!msg) return json(route, { message: 'Message does not exist' }, { status: 404 });
      if (method === 'GET') {
        const extra = detailBody ? detailBody(msg) : null;
        return json(route, {
          ...listItem(msg),
          raw: rawFor(msg),
          nodemailer: {
            text: msg.snippet,
            html: `<p>${msg.snippet}</p>`,
            attachments: [],
          },
          ...extra,
        });
      }
      if (method === 'PUT') {
        const change = body || {};
        let flags = [...(msg.flags || [])];
        if (Array.isArray(change.flags_add) || Array.isArray(change.flags_remove)) {
          for (const f of change.flags_add || []) if (!flags.includes(f)) flags.push(f);
          flags = flags.filter((f) => !(change.flags_remove || []).includes(f));
        } else if (Array.isArray(change.flags)) {
          flags = [...change.flags];
        }
        msg.flags = flags;
        if (typeof change.folder === 'string' && change.folder) {
          if (indexLag && change.folder !== msg.folder_path) {
            lagging.set(id, { folder: msg.folder_path, until: Date.now() + indexLag });
          }
          msg.folder_path = change.folder;
        }
        if (Array.isArray(change.labels)) msg.labels = [...change.labels];
        return json(route, listItem(msg));
      }
      if (method === 'DELETE') {
        state.delete(id);
        return json(route, { success: true });
      }
    }

    return route.fallback();
  };

  server.handle = handle;
  return server;
}

/**
 * Stand in for the API's WebSocket. It accepts the credentials message the
 * app sends first and confirms the connection the way the server does, so
 * events pushed with `send` reach the app's realtime handlers.
 */
export async function installMockSocket(page) {
  const sockets = [];
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      let parsed = null;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (parsed?.event === 'auth') {
        ws.send(JSON.stringify({ event: 'connected', aliasId: 'alias-e2e' }));
      }
    });
  });
  return {
    connectedCount: () => sockets.length,
    send(payload) {
      const frame = JSON.stringify({ timestamp: Date.now(), ...payload });
      for (const ws of sockets) ws.send(frame);
    },
  };
}

// The unread badge on a folder in the sidebar. It is not rendered at all when
// the count is zero.
export function folderBadge(page, path) {
  return page.locator(
    `[data-testid="folder-item"][data-folder-path="${path}"] > button > span.rounded-full`,
  );
}

export async function expectBadge(page, path, count) {
  const badge = folderBadge(page, path);
  if (count === 0) await expect(badge).toHaveCount(0);
  else await expect(badge).toHaveText(String(count));
}

export function row(page, subject) {
  return page.locator('[data-conversation-row]', { hasText: subject }).first();
}

// Wait for the app to finish loading the mailbox with the inbox list on
// screen. No fixed sleep: the first row of the server's newest message is the
// signal.
export async function openMailbox(page, firstSubject) {
  await page.goto('/');
  await page.goto('/mailbox#INBOX');
  await expect(row(page, firstSubject)).toBeVisible({ timeout: 15_000 });
}

// The offline queue as the app stored it (the `meta` row the mutation queue
// keeps per account). Read straight from IndexedDB so a spec can wait for a
// change to be queued before it reconnects, without a fixed sleep.
export async function queuedMutations(page, account = ACCOUNT) {
  return page.evaluate(async (key) => {
    const dbs = (await indexedDB.databases()).filter((d) => d.name?.startsWith('webmail-cache'));
    for (const info of dbs) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(info.name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        if (!db.objectStoreNames.contains('meta')) continue;
        const row = await new Promise((resolve, reject) => {
          const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (row) {
          return (Array.isArray(row.value) ? row.value : [])
            .filter((m) => m.status !== 'completed')
            .map((m) => ({ type: m.type, payload: m.payload, status: m.status }));
        }
      } finally {
        db.close();
      }
    }
    return [];
  }, `mutation_queue_${account}`);
}

export async function goOffline(page, server) {
  server.offline = true;
  await page.context().setOffline(true);
  await expect(page.getByText("You're offline.")).toBeVisible();
}

export async function goOnline(page, server) {
  server.offline = false;
  await page.context().setOffline(false);
  await expect(page.getByText("You're offline.")).toBeHidden();
}
