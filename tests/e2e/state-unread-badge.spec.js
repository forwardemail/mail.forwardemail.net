import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  expectBadge,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// The folder badge is the server's unseen_count plus the changes made on this
// device that the server has not counted yet. These specs pin the three ways
// that went wrong: counting cached rows instead, subtracting a read twice once
// the server's count included it, and a move not carrying its unread message
// from one badge to the other.

// 300 messages in the inbox. The first list page (100) holds three unread
// ones; the other 20 unread are older, on pages the background sync is held
// back from, so this device has only 3 of the 23 unread messages cached.
// Archive has two unread messages of its own.
const UNREAD_ON_FIRST_PAGE = [2, 5, 9];
function seedMessages() {
  const inbox = Array.from({ length: 300 }, (_, i) => {
    const n = i + 1;
    const unread = UNREAD_ON_FIRST_PAGE.includes(n) || (n > 100 && n % 10 === 0);
    return buildMessage(n, { unread });
  });
  const archive = [
    buildMessage(1001, { folder: 'Archive', unread: true }),
    buildMessage(1002, { folder: 'Archive', unread: true }),
    buildMessage(1003, { folder: 'Archive' }),
  ];
  return [...inbox, ...archive];
}

// Hold every PUT to one message until `release` is called, so a spec can check
// what the badge shows before the server has answered.
async function holdChangesTo(page, id) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(new RegExp(`/v1/messages/${id}(\\?|$)`), async (route) => {
    if (route.request().method() === 'PUT') await gate;
    return route.fallback();
  });
  return () => release();
}

// Ask the app for a fresh folder list the way the server does when a mailbox
// changes, and wait for that list to be served.
async function serverSendsFolderList(page, socket, server) {
  const before = server.folderLists().length;
  const served = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/folders' && r.request().method() === 'GET',
  );
  socket.send({ event: 'mailboxCreated' });
  await served;
  expect(server.folderLists().length).toBeGreaterThan(before);
}

// The badge must hold `count` for a while after a folder list, not just reach
// it: a double subtraction shows up once the recount after the list runs.
async function expectBadgeToStay(page, path, count, ms = 2000) {
  await expectBadge(page, path, count);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await expectBadge(page, path, count);
    await page.waitForTimeout(100);
  }
}

test.describe('Unread badge', () => {
  let server;
  let socket;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'The folder sidebar is desktop only');
    await setupAuthenticatedMailbox(page);
    socket = await installMockSocket(page);
    server = await installMailServer(page, { messages: seedMessages(), holdListPages: 1 });
    await openMailbox(page, 'Message 0001');
  });

  test('shows the server unseen_count, not the number of cached unread rows', async ({ page }) => {
    expect(server.unreadIn('INBOX')).toBe(23);
    await expectBadge(page, 'INBOX', 23);
    await expectBadge(page, 'Archive', 2);
    // The premise: this device only has the first page's unread messages.
    await expect(page.locator('[data-conversation-row][data-unread="true"]')).toHaveCount(
      UNREAD_ON_FIRST_PAGE.length,
    );
    await expectBadgeToStay(page, 'INBOX', 23);
  });

  // The badge follows the read at once, without waiting for the server.
  test('opening an unread message lowers the badge before the server answers', async ({ page }) => {
    await expectBadge(page, 'INBOX', 23);
    const release = await holdChangesTo(page, 'msg-2');
    await row(page, 'Message 0002').click();
    await expect(page.locator('.fe-reader').getByText('Message 0002').first()).toBeVisible();
    await expectBadge(page, 'INBOX', 22);
    expect(server.changesFor('msg-2')).toHaveLength(0);
    release();
  });

  test('opening an unread message lowers the badge by one, and the next folder list does not lower it again', async ({
    page,
  }) => {
    await expectBadge(page, 'INBOX', 23);
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().includes('/v1/messages/msg-2'),
    );
    await row(page, 'Message 0002').click();
    await expect(page.locator('.fe-reader').getByText('Message 0002').first()).toBeVisible();
    await answered;
    await expectBadge(page, 'INBOX', 22);
    expect(server.get('msg-2').flags).toContain('\\Seen');
    expect(server.changesFor('msg-2')).toHaveLength(1);
    expect(server.unreadIn('INBOX')).toBe(22);

    // The server's next folder list already counts the read: 22, not 21.
    await serverSendsFolderList(page, socket, server);
    await expectBadgeToStay(page, 'INBOX', 22);
    expect(server.changesFor('msg-2')).toHaveLength(1);
  });

  test('moving an unread message carries it from one badge to the other', async ({ page }) => {
    await expectBadge(page, 'INBOX', 23);
    await expectBadge(page, 'Archive', 2);

    await row(page, 'Message 0005').click({ button: 'right' });
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Archive' }).click();

    await expect(row(page, 'Message 0005')).toHaveCount(0);
    await expectBadge(page, 'INBOX', 22);
    await expectBadge(page, 'Archive', 3);

    // It reached the server as a move and stayed unread there.
    await expect.poll(() => server.get('msg-5').folder_path).toBe('Archive');
    expect(server.get('msg-5').flags).not.toContain('\\Seen');
    expect(server.changesFor('msg-5')).toHaveLength(1);

    await serverSendsFolderList(page, socket, server);
    await expectBadgeToStay(page, 'INBOX', 22);
    await expectBadge(page, 'Archive', 3);
  });
});

test.describe('Unread badge on a fresh load', () => {
  test.skip(({ isMobile }) => isMobile, 'The folder sidebar is desktop only');

  // Loading the app straight into an unread message (a reload while reading,
  // a notification, a shared link) with a warm cache reads it while the first
  // folder list is on its way. That list can already count the read, and the badge must not
  // take it off a second time.
  // The read's PUT can reach the server before that list is served, while it
  // settles here only after the list was requested; a fresh list fetched once
  // it settles puts the badge back on the server's number.
  test('opening an unread message from the URL on load leaves the badge at the server count', async ({
    page,
  }) => {
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    const server = await installMailServer(page, { messages: seedMessages(), holdListPages: 1 });
    // A first visit fills the cache, as on any device that has used the app.
    await openMailbox(page, 'Message 0001');
    await expectBadge(page, 'INBOX', 23);
    await page.goto('about:blank');

    const answered = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().includes('/v1/messages/msg-2'),
    );
    await page.goto('/mailbox#INBOX/msg-2');
    await expect(page.locator('.fe-reader').getByText('Message 0002').first()).toBeVisible({
      timeout: 15_000,
    });
    await answered;
    expect(server.unreadIn('INBOX')).toBe(22);
    await expectBadgeToStay(page, 'INBOX', 22);
  });
});
