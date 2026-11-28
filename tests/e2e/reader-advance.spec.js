import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// Settings > Appearance > Reading > "After archive, delete or move" decides
// what the reader shows once the open message is gone: a neighbouring
// message, or nothing (back to the list), so that no message is opened, and
// marked read, without being chosen.

const SEEN = '\\Seen';

// Newest first in the list: 1, 2, 3, 4. Messages 3 and 4 are unread.
function seedMessages() {
  return [
    buildMessage(1),
    buildMessage(2, { subject: 'Quarterly report' }),
    buildMessage(3, { subject: 'Team lunch', unread: true }),
    buildMessage(4, { subject: 'Budget review', unread: true }),
  ];
}

async function setLocal(page, key, value) {
  await page.addInitScript(
    ([k, v]) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // sandboxed frame
      }
    },
    [`webmail_${key}`, value],
  );
}

const reader = (page) => page.locator('.fe-reader');
const archive = (page) => page.getByTestId('reader-header-archive');
const isRead = (server, id) => (server.get(id).flags || []).includes(SEEN);

async function openRow(page, subject) {
  await row(page, subject).click();
  await expect(reader(page).getByText(subject).first()).toBeVisible();
}

test.describe('After archive, delete or move', () => {
  let server;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop reader and settings layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    server = await installMailServer(page, { messages: seedMessages() });
  });

  test('by default the reader moves on to a neighbouring message', async ({ page }) => {
    await setLocal(page, 'layout_mode', 'classic');
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await archive(page).click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');
    await expect(reader(page).getByText('Team lunch').first()).toBeVisible();
  });

  test('"Open the message above" goes up the list, even past an unread message below', async ({
    page,
  }) => {
    await setLocal(page, 'layout_mode', 'classic');
    await setLocal(page, 'reader_advance', 'above');
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await archive(page).click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');
    await expect(reader(page).getByText('Message 0001').first()).toBeVisible();
    // The unread message below was not opened, so it is still unread.
    expect(isRead(server, 'msg-3')).toBe(false);
  });

  test('"Go back to the message list" empties the Classic reading pane and opens nothing', async ({
    page,
  }) => {
    await setLocal(page, 'layout_mode', 'classic');
    await setLocal(page, 'reader_advance', 'list');
    await openMailbox(page, 'Message 0001');
    // Classic does not open the first message by itself with this choice.
    await expect(archive(page)).toHaveCount(0);

    await openRow(page, 'Quarterly report');
    await archive(page).click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');

    await expect(row(page, 'Quarterly report')).toHaveCount(0);
    await expect(archive(page)).toHaveCount(0);
    await expect(reader(page).getByText('Team lunch')).toHaveCount(0);
    // The rest of the list is where it was, and nothing in it was marked read.
    await expect(row(page, 'Team lunch')).toBeVisible();
    expect(isRead(server, 'msg-3')).toBe(false);
    expect(isRead(server, 'msg-4')).toBe(false);
  });

  test('"Go back to the message list" also applies to Delete and Move', async ({ page }) => {
    await setLocal(page, 'layout_mode', 'classic');
    await setLocal(page, 'reader_advance', 'list');
    await openMailbox(page, 'Message 0001');

    await openRow(page, 'Quarterly report');
    await page.getByTestId('reader-header-delete').click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Trash');
    await expect(archive(page)).toHaveCount(0);

    await openRow(page, 'Message 0001');
    await page.getByTestId('reader-header-move').click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await expect.poll(() => server.get('msg-1').folder_path).toBe('Archive');
    await expect(archive(page)).toHaveCount(0);

    expect(isRead(server, 'msg-3')).toBe(false);
    expect(isRead(server, 'msg-4')).toBe(false);
  });

  test('in Full Screen, "Go back to the message list" closes the message', async ({ page }) => {
    await setLocal(page, 'layout_mode', 'full');
    await setLocal(page, 'reader_advance', 'list');
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await expect(page.locator('.fe-reader-toolbar')).toBeVisible();

    await archive(page).click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');

    await expect(page.locator('.fe-reader-toolbar')).toHaveCount(0);
    await expect(row(page, 'Team lunch')).toBeVisible();
    await expect(page).toHaveURL(/#INBOX$/);
    expect(isRead(server, 'msg-3')).toBe(false);
  });

  test('the choice is made in Settings and kept', async ({ page }) => {
    await page.goto('/');
    await page.goto('/mailbox/settings#appearance');
    const select = page.getByTestId('reader-advance-select');
    await expect(select).toContainText('Open the next message, unread first');
    await select.click();
    await page.getByRole('option', { name: 'Go back to the message list' }).click();
    await expect(select).toContainText('Go back to the message list');

    await page.reload();
    await expect(page.getByTestId('reader-advance-select')).toContainText(
      'Go back to the message list',
    );
  });
});
