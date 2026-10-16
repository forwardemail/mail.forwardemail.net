import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  expectBadge,
  installMailServer,
  installMockSocket,
  openMailbox,
} from '../fixtures/state-helpers.js';

// "Mark all as read" has to reach every unread message the server has in the
// folder, not only the ones this device happens to have cached. Here the
// device has cached the newest 100 messages (3 unread); the other 20 unread
// messages are older and only reachable through the server's unread listing.

const UNREAD_CACHED = [2, 5, 9];
const UNREAD_UNCACHED = Array.from({ length: 20 }, (_, i) => 110 + i * 10);

function seedMessages() {
  return Array.from({ length: 300 }, (_, i) => {
    const n = i + 1;
    return buildMessage(n, { unread: UNREAD_CACHED.includes(n) || UNREAD_UNCACHED.includes(n) });
  });
}

test.describe('Mark all as read', () => {
  test.skip(({ isMobile }) => isMobile, 'The folder context menu is desktop only');

  test('marks every unread message the server lists, cached or not, and clears the badge', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await setupAuthenticatedMailbox(page);
    const socket = await installMockSocket(page);
    const server = await installMailServer(page, { messages: seedMessages(), holdListPages: 1 });
    await openMailbox(page, 'Message 0001');
    await expectBadge(page, 'INBOX', 23);

    await page
      .locator('[data-testid="folder-item"][data-folder-path="INBOX"]')
      .click({ button: 'right' });
    await page.getByTestId('folder-mark-all-as-read').click();

    await expectBadge(page, 'INBOX', 0);
    await expect.poll(() => server.unreadIn('INBOX'), { timeout: 15_000 }).toBe(0);

    // The older unread messages were found through the unread listing.
    const unreadListings = server
      .requests({ method: 'GET', path: '/v1/messages' })
      .filter((r) => r.params.folder === 'INBOX' && r.params.is_unread === 'true');
    expect(unreadListings.length).toBeGreaterThan(0);

    // One \Seen change per unread message, and nothing sent to messages that
    // were already read.
    const puts = server.requests({ method: 'PUT' });
    const ids = puts.map((r) => decodeURIComponent(r.path.split('/').pop()));
    const expected = [...UNREAD_CACHED, ...UNREAD_UNCACHED].map((n) => `msg-${n}`);
    expect([...ids].sort()).toEqual([...expected].sort());
    for (const put of puts) expect(put.body.flags_add).toEqual(['\\Seen']);

    // A folder list from the server afterwards agrees, and the badge stays gone.
    const served = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/v1/folders' && r.request().method() === 'GET',
    );
    socket.send({ event: 'mailboxCreated' });
    await served;
    await expectBadge(page, 'INBOX', 0);
    await expect(page.locator('[data-conversation-row][data-unread="true"]')).toHaveCount(0);
  });
});
