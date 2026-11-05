import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  expectBadge,
  installSharedMailServer,
  installSharedSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// Two people signed in to one support inbox, in two browsers. Whatever one of
// them does (or a third client, like Thunderbird) has to show up for the other
// without a reload. The app shows cached folders without asking the server
// while the WebSocket keeps them current, so these also pin the cases where
// the socket cannot: a folder changed while not on screen, and a connection
// that dropped while changes were made.

function seed() {
  return [
    ...[1, 2, 3, 4, 5, 6].map((n) => buildMessage(n, { unread: n <= 3 })),
    buildMessage(101, { folder: 'Archive', subject: 'Archived earlier' }),
    buildMessage(201, { folder: 'Sent Mail', subject: 'Sent earlier' }),
  ];
}

async function openFolder(page, path) {
  await page.locator(`[data-testid="folder-item"][data-folder-path="${path}"] > button`).click();
}

async function archive(page, subject) {
  await row(page, subject).click({ button: 'right' });
  await page
    .locator('[data-context-menu]')
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
}

// List requests a page sends for one folder, the sync worker's included.
function countListRequests(page, folder) {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET') return;
    const url = new URL(req.url());
    if (url.pathname === '/v1/messages' && url.searchParams.get('folder') === folder) {
      seen.push({ at: Date.now(), limit: url.searchParams.get('limit') });
    }
  });
  return {
    count: () => seen.length,
    // The sync worker's first pass over the folder is over: its backfill,
    // which pages 100 at a time, comes after the folder's metadata pages. On
    // a busy runner it can start more than a quiet spell after them, and
    // then landed in the middle of the measurement.
    synced: async () => {
      await expect.poll(() => seen.some((r) => r.limit === '100'), { timeout: 30_000 }).toBe(true);
    },
    // No list request for this folder in the last `ms`.
    quiet: async (ms = 1500) => {
      await expect
        .poll(() => Date.now() - (seen.at(-1)?.at || 0), { timeout: 20_000 })
        .toBeGreaterThan(ms);
    },
  };
}

test.describe('Shared inbox', () => {
  let a;
  let b;
  let contexts;
  let server;
  let socket;

  test.beforeEach(async ({ browser }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Uses the desktop sidebar and row context menu');
    test.setTimeout(90_000);
    const { baseURL } = testInfo.project.use;
    // Tall enough that the row context menu opens below the row. At 720 px it
    // flips up for lower rows and is cut off at the top of the window.
    const viewport = { width: 1280, height: 1000 };
    contexts = [
      await browser.newContext({ baseURL, viewport }),
      await browser.newContext({ baseURL, viewport }),
    ];
    a = await contexts[0].newPage();
    b = await contexts[1].newPage();
    for (const page of [a, b]) await setupAuthenticatedMailbox(page);
    socket = await installSharedSocket([a, b]);
    server = await installSharedMailServer([a, b], {
      messages: seed(),
      onChange: (event) => socket.send(event),
    });
    await openMailbox(a, 'Message 0001');
    await openMailbox(b, 'Message 0001');
    await expect.poll(() => socket.connected(b)).toBeGreaterThan(0);
  });

  test.afterEach(async () => {
    socket?.stop();
    for (const context of contexts || []) await context.close();
  });

  test('a message one person reads shows as read for the other', async () => {
    await expect(b.locator('[data-conversation-row][data-unread="true"]')).toHaveCount(3);
    await expectBadge(b, 'INBOX', 3);

    await row(a, 'Message 0001').click();
    await expect(a.locator('.fe-reader').getByText('Message 0001').first()).toBeVisible();
    await expect.poll(() => server.get('msg-1').flags).toContain('\\Seen');

    await expect(row(b, 'Message 0001')).not.toHaveAttribute('data-unread', 'true');
    await expectBadge(b, 'INBOX', 2);
  });

  test('a reply sent from another client shows as replied, and its copy shows in Sent', async () => {
    // Sent is cached here first, so the reply has to make it stale.
    await openFolder(b, 'Sent Mail');
    await expect(row(b, 'Sent earlier')).toBeVisible();
    await openFolder(b, 'INBOX');
    await expect(row(b, 'Message 0002')).toBeVisible();

    server.applyChange('msg-2', { flags_add: ['\\Answered'] });
    server.add(buildMessage(202, { folder: 'Sent Mail', subject: 'Re: Message 0002' }));

    await expect(row(b, 'Message 0002').locator('path[d="M9 17l-5-5 5-5"]').first()).toBeVisible();
    await openFolder(b, 'Sent Mail');
    await expect(row(b, 'Re: Message 0002')).toBeVisible();
  });

  test('a move shows in both folders for the other person', async () => {
    await openFolder(b, 'Archive');
    await expect(row(b, 'Archived earlier')).toBeVisible();
    await openFolder(b, 'INBOX');
    await expect(row(b, 'Message 0003')).toBeVisible();

    await archive(a, 'Message 0003');
    await expect.poll(() => server.get('msg-3').folder_path).toBe('Archive');

    await expect(row(b, 'Message 0003')).toHaveCount(0);
    await openFolder(b, 'Archive');
    await expect(row(b, 'Message 0003')).toBeVisible();
  });

  test('changes made while one connection was down show once it is back', async () => {
    await openFolder(b, 'Archive');
    await expect(row(b, 'Archived earlier')).toBeVisible();
    await openFolder(b, 'INBOX');
    await expect(row(b, 'Message 0006')).toBeVisible();

    // B's laptop sleeps: its socket goes, and these events never reach it.
    // Stars from another client change no folder count, so nothing but the
    // dropped connection tells B its cached folders are out of date.
    socket.drop(b);
    server.applyChange('msg-6', { flags_add: ['\\Flagged'] });
    server.applyChange('msg-101', { flags_add: ['\\Flagged'] });
    await expect(row(a, 'Message 0006').getByRole('button', { name: 'Unstar' })).toBeVisible();

    // It wakes up and reconnects. The reconnect catch-up refreshes the folder
    // list and the folder on screen; wait for it, so opening Archive after it
    // is down to whether Archive's cached copy is still trusted.
    const caughtUp = b.waitForResponse(
      (r) => new URL(r.url()).pathname === '/v1/folders' && r.request().method() === 'GET',
      { timeout: 30_000 },
    );
    socket.restore(b);
    await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => socket.connected(b), { timeout: 30_000 }).toBeGreaterThan(0);
    await caughtUp;
    await expect(row(b, 'Message 0006').getByRole('button', { name: 'Unstar' })).toBeVisible({
      timeout: 15_000,
    });
    await b.waitForTimeout(1000);

    await openFolder(b, 'Archive');
    await expect(row(b, 'Archived earlier').getByRole('button', { name: 'Unstar' })).toBeVisible();
  });

  test('opening a folder the socket kept current does not ask the server again', async () => {
    const archiveLists = countListRequests(b, 'Archive');
    await openFolder(b, 'Archive');
    await expect(row(b, 'Archived earlier')).toBeVisible();
    await openFolder(b, 'INBOX');
    await expect(row(b, 'Message 0001')).toBeVisible();
    await archiveLists.synced();
    await archiveLists.quiet();
    const before = archiveLists.count();
    expect(before).toBeGreaterThan(0);

    await openFolder(b, 'Archive');
    await expect(row(b, 'Archived earlier')).toBeVisible();
    await b.waitForTimeout(1500);
    expect(archiveLists.count()).toBe(before);

    // A change to it from the other person, and the next open asks again.
    await archive(a, 'Message 0005');
    await expect(row(b, 'Message 0005')).toBeVisible();
    await openFolder(b, 'INBOX');
    await openFolder(b, 'Archive');
    await expect(row(b, 'Message 0005')).toBeVisible();
    expect(archiveLists.count()).toBeGreaterThan(before);
  });
});
