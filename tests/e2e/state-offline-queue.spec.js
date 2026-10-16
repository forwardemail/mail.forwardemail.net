import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  expectBadge,
  goOffline,
  goOnline,
  installMailServer,
  installMockSocket,
  openMailbox,
  queuedMutations,
  row,
} from '../fixtures/state-helpers.js';

// Changes made offline go into a queue and are sent once the connection is
// back. The server must get each change exactly once (the tab and the service
// worker both drain the queue), and a later change to the same message must
// win over an older one still waiting.

const SEEN = '\\Seen';

function seedMessages() {
  return Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return buildMessage(n, { unread: n >= 2 && n <= 4 });
  });
}

async function contextAction(page, subject, name) {
  await row(page, subject).click({ button: 'right' });
  await page.locator('[data-context-menu]').getByRole('button', { name, exact: true }).click();
}

// Back online, then wait for the queue to empty. After that nothing should
// still be on its way; the short watch catches a second sender (the service
// worker's Background Sync) replaying the same entry.
async function reconnectAndDrain(page, server) {
  await goOnline(page, server);
  await expect.poll(() => queuedMutations(page), { timeout: 45_000 }).toEqual([]);
  await page.waitForTimeout(1500);
}

// A fresh load of the inbox list. Not page.reload(): opening a message puts
// it in the URL, and reloading that would open (and mark read) the message.
// Going through about:blank makes it a real load and not a hash change.
async function reopenInbox(page) {
  await page.goto('about:blank');
  await page.goto('/mailbox#INBOX');
  await expect(row(page, 'Message 0001')).toBeVisible({ timeout: 15_000 });
}

test.describe('Offline queue', () => {
  let server;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Uses the desktop row context menu');
    test.setTimeout(90_000);
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    server = await installMailServer(page, { messages: seedMessages() });
    await openMailbox(page, 'Message 0001');
    await expectBadge(page, 'INBOX', 3);
  });

  test('a read made offline reaches the server once and survives a reload', async ({ page }) => {
    await goOffline(page, server);
    await contextAction(page, 'Message 0002', 'Mark Read');
    await expect(row(page, 'Message 0002')).toHaveAttribute('data-unread', 'false');

    await expect
      .poll(() => queuedMutations(page), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ type: 'toggleRead' })]);
    expect(server.changesFor('msg-2')).toHaveLength(0);

    await reconnectAndDrain(page, server);
    const changes = server.changesFor('msg-2');
    expect(changes).toHaveLength(1);
    expect(changes[0].body.flags_add).toEqual([SEEN]);
    expect(server.get('msg-2').flags).toContain(SEEN);

    await reopenInbox(page);
    await expect(row(page, 'Message 0002')).toHaveAttribute('data-unread', 'false');
    await expectBadge(page, 'INBOX', 2);
    expect(server.changesFor('msg-2')).toHaveLength(1);
  });

  // A read made offline moves the badge while it waits in the queue, and the
  // badge stays right once the queue has sent it.
  test('a read made offline lowers the badge, offline and after it is sent', async ({ page }) => {
    await goOffline(page, server);
    await contextAction(page, 'Message 0002', 'Mark Read');
    await expect
      .poll(() => queuedMutations(page), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ type: 'toggleRead' })]);
    await expectBadge(page, 'INBOX', 2);
    await reconnectAndDrain(page, server);
    expect(server.unreadIn('INBOX')).toBe(2);
    await expectBadge(page, 'INBOX', 2);
  });

  test('read then unread while offline: the stale read is never sent', async ({ page }) => {
    await goOffline(page, server);
    await contextAction(page, 'Message 0003', 'Mark Read');
    await expect(row(page, 'Message 0003')).toHaveAttribute('data-unread', 'false');
    await expect
      .poll(() => queuedMutations(page), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ type: 'toggleRead' })]);

    await contextAction(page, 'Message 0003', 'Mark Unread');
    await expect(row(page, 'Message 0003')).toHaveAttribute('data-unread', 'true');
    // The unread replaces the queued read instead of queuing behind it.
    await expect
      .poll(() => queuedMutations(page), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({
          type: 'toggleRead',
          payload: expect.objectContaining({ isUnread: false }),
        }),
      ]);

    await reconnectAndDrain(page, server);
    const changes = server.changesFor('msg-3');
    expect(changes.length).toBeLessThanOrEqual(1);
    for (const change of changes) expect(change.body.flags_add || []).not.toContain(SEEN);
    expect(server.get('msg-3').flags).not.toContain(SEEN);

    await reopenInbox(page);
    await expect(row(page, 'Message 0003')).toHaveAttribute('data-unread', 'true');
    await expectBadge(page, 'INBOX', 3);
  });

  test('a move made offline reaches the server once and survives a reload', async ({ page }) => {
    await goOffline(page, server);
    await contextAction(page, 'Message 0004', 'Archive');
    await expect(row(page, 'Message 0004')).toHaveCount(0);
    await expect
      .poll(() => queuedMutations(page), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ type: 'move' })]);
    expect(server.changesFor('msg-4')).toHaveLength(0);

    await reconnectAndDrain(page, server);
    const changes = server.changesFor('msg-4');
    expect(changes).toHaveLength(1);
    expect(changes[0].body.folder).toBe('Archive');
    expect(server.get('msg-4').folder_path).toBe('Archive');

    await reopenInbox(page);
    await expect(row(page, 'Message 0004')).toHaveCount(0);
    await expectBadge(page, 'INBOX', 2);
    await expectBadge(page, 'Archive', 1);
    expect(server.changesFor('msg-4')).toHaveLength(1);
  });
});
