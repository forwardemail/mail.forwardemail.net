import { expect, test } from '@playwright/test';

// Opening a push notification, end to end. Every kind of tap (APNs on iOS,
// FCM and UnifiedPush on Android, web push) ends in the same router
// (utils/notification-open.ts) with a target: the account, the folder and the
// message. A web build has no native queue to tap, so the tap arrives the way
// the service worker delivers a clicked notification to an open window.
// Two accounts are signed in; the API answers each with its own mail, by the
// credentials on the request.

const PIN = '135790';

const ACCOUNTS = {
  'alice@example.com': 'alice@example.com:pw-alice',
  'bob@example.com': 'bob@example.com:pw-bob',
};

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

const message = (id, subject, from, hours, extra = {}) => ({
  id,
  Uid: id,
  folder: 'INBOX',
  folder_path: 'INBOX',
  Subject: subject,
  subject,
  From: { Email: from.address, Display: from.name },
  from: { text: `${from.name} <${from.address}>`, value: [from] },
  to: [{ address: 'me@example.com', name: '' }],
  snippet: `${subject} (snippet)`,
  Date: hoursAgo(hours),
  date: hoursAgo(hours),
  flags: ['\\Seen'],
  has_attachment: false,
  ...extra,
});

const carol = { address: 'carol@example.com', name: 'Carol' };
const dave = { address: 'dave@example.com', name: 'Dave' };

const MAIL = {
  'alice@example.com': {
    list: [
      message('a-1', 'Project kickoff', carol, 1, { thread_id: 'thread-kickoff' }),
      message('a-2', 'Re: Project kickoff', dave, 2, { thread_id: 'thread-kickoff' }),
      message('a-3', 'Lunch on Friday', carol, 3),
      message('a-4', 'Lunch on Friday', { ...dave, name: 'Dave Today' }, 4, { flags: [] }),
      // read, so not the one just delivered, though newer
      message('a-6', 'Lunch on Friday', { ...dave, name: 'Dave Archive' }, 2),
      message('a-5', 'Lunch on Friday', carol, 30),
    ],
    // Not in the first page of the list.
    extra: [message('a-9', 'Server alert overnight', dave, 0.1)],
  },
  'bob@example.com': {
    list: [message('b-1', 'Invoice for September', dave, 1)],
    extra: [message('b-9', 'Contract signed today', carol, 0.1)],
  },
};

const basicToAccount = (header) => {
  const value = String(header || '').replace(/^Basic\s+/i, '');
  let decoded = '';
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
  return Object.keys(ACCOUNTS).find((email) => ACCOUNTS[email] === decoded) || '';
};

/** Sign in alice@example.com (on screen) and bob@example.com; route the API per account. */
async function setup(page) {
  await page.addInitScript((accounts) => {
    try {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem(
        'webmail_accounts',
        JSON.stringify(
          Object.entries(accounts).map(([email, aliasAuth]) => ({ email, aliasAuth })),
        ),
      );
      localStorage.setItem('webmail_active_account', 'alice@example.com');
      localStorage.setItem('webmail_email', 'alice@example.com');
      localStorage.setItem('webmail_alias_auth', accounts['alice@example.com']);
      localStorage.setItem('webmail_authToken', 'token-alice');
    } catch {
      // the sandboxed email frame has no storage
    }
  }, ACCOUNTS);

  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );

  // Each account's connection authenticates as its own alias, as the server
  // does ({ event: 'connected', aliasId }).
  await page.routeWebSocket(/\/v1\/ws/, (ws) => {
    ws.onMessage((raw) => {
      let frame = null;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame?.event !== 'auth') return;
      const aliasId = frame.username === 'bob@example.com' ? 'alias-b' : 'alias-a';
      ws.send(JSON.stringify({ event: 'connected', aliasId }));
    });
  });

  const requests = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const account =
      basicToAccount(request.headers().authorization) ||
      (request.headers().authorization ? '' : 'alice@example.com');
    requests.push({ path, account });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/v1/folders')) {
      return json([
        { path: 'INBOX', name: 'Inbox', count: 5, level: 0 },
        { path: 'Sent', name: 'Sent', count: 0, level: 0 },
        { path: 'Trash', name: 'Trash', count: 0, level: 0 },
      ]);
    }
    const single = path.match(/\/v1\/messages\/([^/]+)$/);
    if (single && request.method() === 'GET') {
      const id = decodeURIComponent(single[1]);
      const mail = MAIL[account];
      const found = mail && [...mail.list, ...mail.extra].find((m) => m.id === id);
      if (!found) return json({ message: 'Not found' }, 404);
      return json({
        Result: {
          ...found,
          html: `<p>Body of ${found.subject}</p>`,
          attachments: [],
        },
      });
    }
    if (path.includes('/v1/messages') && request.method() === 'GET') {
      return json(MAIL[account]?.list || []);
    }
    return json({});
  });
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"Result":{}}' }),
  );
  return requests;
}

/** A clicked notification, as the service worker hands it to the window. */
async function tap(page, target) {
  await page.evaluate((data) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'notification-click', target: data } }),
    );
  }, target);
}

async function openInbox(page) {
  await page.goto('/mailbox#INBOX');
  await expect(page.locator('[data-conversation-row]').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
}

const reader = (page) => page.locator('.fe-reader');
const activeAccount = (page) => page.evaluate(() => localStorage.getItem('webmail_email'));

async function enableAppLock(page) {
  await page.goto('/mailbox/settings#privacy');
  await page.getByRole('button', { name: 'Enable App Lock' }).click();
  await page.getByPlaceholder(/Enter \d-digit PIN/).fill(PIN);
  await page.getByPlaceholder('Confirm PIN').fill(PIN);
  await page.getByRole('button', { name: 'Set PIN & Enable' }).click();
  await expect(page.getByText('App lock enabled successfully')).toBeVisible({ timeout: 30_000 });
}

async function typePin(page) {
  const pad = page.getByRole('group', { name: 'PIN keypad' });
  for (const digit of PIN) {
    await pad.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByText('Enter your PIN to unlock')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('Opening a push notification', () => {
  test('switches to the account the notification is for and opens the message', async ({
    page,
  }) => {
    await setup(page);
    await openInbox(page);

    await tap(page, { account: 'bob@example.com', folder: 'INBOX', messageId: 'b-9' });

    await expect(reader(page)).toContainText('Contract signed today', { timeout: 15_000 });
    expect(await activeAccount(page)).toBe('bob@example.com');
  });

  test('opens the tapped message, not the thread that was open before', async ({ page }) => {
    await setup(page);
    await openInbox(page);
    await page.locator('[data-conversation-row]', { hasText: 'Project kickoff' }).first().click();
    await expect(reader(page)).toContainText('Project kickoff');

    await tap(page, { account: 'alice@example.com', folder: 'INBOX', messageId: 'a-9' });

    await expect(reader(page)).toContainText('Server alert overnight', { timeout: 15_000 });
    await expect(reader(page)).not.toContainText('Project kickoff');
  });

  test('opens mail delivered to temporary storage by its subject and sender', async ({ page }) => {
    await setup(page);
    await openInbox(page);

    // Mail in temporary storage has no id yet; the notification names its
    // subject and sender. Three other messages share the subject, one of them
    // from the same sender.
    await tap(page, {
      account: 'alice@example.com',
      folder: 'INBOX',
      subject: 'Lunch on Friday',
      sender: 'Dave <dave@example.com>',
    });

    await expect(reader(page)).toContainText('Lunch on Friday', { timeout: 15_000 });
    await expect(reader(page)).toContainText('Dave Today');
    await expect(reader(page)).not.toContainText('Dave Archive');
    await expect(reader(page)).not.toContainText('carol@example.com');
  });

  test('learns which account each push alias id belongs to from its connection', async ({
    page,
  }) => {
    await setup(page);
    await openInbox(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => JSON.parse(localStorage.getItem('webmail_alias_accounts') || '{}')),
        { timeout: 15_000 },
      )
      .toEqual({ 'alias-a': 'alice@example.com', 'alias-b': 'bob@example.com' });
  });
});

test.describe('Opening a push notification with App Lock', () => {
  test.setTimeout(150_000);

  test('a tap after the lock timeout ran out while suspended locks first, then opens', async ({
    page,
  }) => {
    await page.clock.install();
    await setup(page);
    await openInbox(page);
    await enableAppLock(page);
    await openInbox(page);

    // The app sits in the background past the lock timeout. Its page is
    // suspended (iOS, Android, a sleeping laptop), so the lock timer has not
    // fired; only the clock has moved on.
    const now = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(now + 10 * 60 * 1000);

    await tap(page, { account: 'bob@example.com', folder: 'INBOX', messageId: 'b-9' });

    await expect(page.getByText('Enter your PIN to unlock')).toBeVisible({ timeout: 10_000 });
    await expect(reader(page)).toHaveCount(0);
    await typePin(page);

    await expect(reader(page)).toContainText('Contract signed today', { timeout: 20_000 });
    expect(await activeAccount(page)).toBe('bob@example.com');
  });

  test('a tap waiting behind the lock screen survives a reload of the page', async ({ page }) => {
    await setup(page);
    await openInbox(page);
    await enableAppLock(page);
    await openInbox(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fe:lock-app')));
    await expect(page.getByText('Enter your PIN to unlock')).toBeVisible();

    // The tap waits for the PIN.
    await tap(page, { account: 'bob@example.com', folder: 'INBOX', messageId: 'b-9' });
    await page.waitForTimeout(500);

    // The page is reloaded before the PIN is entered (on iOS the system ends
    // the page's process and the app reloads it).
    await page.reload();
    await expect(page.getByText('Enter your PIN to unlock')).toBeVisible({ timeout: 20_000 });
    await typePin(page);

    await expect(reader(page)).toContainText('Contract signed today', { timeout: 20_000 });
    expect(await activeAccount(page)).toBe('bob@example.com');
  });
});
