import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// When opening a message marks it read: at once (the default), after it has
// stayed open for a while, or never. And only a message the reader shows is
// opened: a search selects its top result without showing it.

const SEEN = '\\Seen';

function seedMessages() {
  return [
    buildMessage(1),
    buildMessage(2, { unread: true, subject: 'Quarterly report' }),
    buildMessage(3, { unread: true, subject: 'Team lunch' }),
    buildMessage(4, { subject: 'Weekly digest' }),
    // One conversation of two unread messages
    buildMessage(5, { unread: true, subject: 'Re: Trip plans', thread_id: 'thread-trip' }),
    buildMessage(6, { unread: true, subject: 'Trip plans', thread_id: 'thread-trip' }),
  ];
}

// The setting as Settings stores it on this device.
async function useMarkReadDelay(page, value) {
  await page.addInitScript((delay) => {
    try {
      localStorage.setItem('webmail_mark_read_delay', delay);
    } catch {
      // sandboxed frame
    }
  }, String(value));
}

const reader = (page) => page.locator('.fe-reader');

async function openRow(page, subject) {
  await row(page, subject).click();
  await expect(reader(page).getByText(subject).first()).toBeVisible();
}

// The reader toolbar's read toggle offers Mark read while the open message is
// unread. The full screen reader covers the list, so it is the place to look.
const readToggle = (page) => reader(page).getByRole('button', { name: /^Mark (read|unread)$/ });
const shownInReader = (page) => async () =>
  (await readToggle(page).getAttribute('aria-label')) === 'Mark read' ? 'unread' : 'read';
const shownInList = (page, subject) => async () =>
  (await row(page, subject).getAttribute('data-unread')) === 'true' ? 'unread' : 'read';

// Until `until` (a timestamp) the message must show as unread and the server
// must not hear otherwise. A read is optimistic and its PUT follows right away,
// so a message still unread then was not read.
async function expectStaysUnread(page, server, id, shown, until = Date.now() + 1500) {
  while (Date.now() < until) {
    expect(await shown()).toBe('unread');
    await page.waitForTimeout(100);
  }
  expect(server.changesFor(id)).toHaveLength(0);
  expect(server.get(id).flags).not.toContain(SEEN);
}

test.describe('Mark as read', () => {
  let server;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop reader and settings layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    server = await installMailServer(page, { messages: seedMessages() });
  });

  test('a search does not mark its top result read while the reader is closed', async ({
    page,
  }) => {
    await openMailbox(page, 'Message 0001');
    const loaded = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/v1/messages/msg-2'),
    );
    await page.getByPlaceholder('Search mail').fill('Quarterly');
    await expect(page.locator('[data-conversation-row]')).toHaveCount(1);
    // The top result is selected, and its body loaded, behind the closed reader.
    await loaded;
    await expect(reader(page)).toHaveCount(0);
    await expectStaysUnread(page, server, 'msg-2', shownInList(page, 'Quarterly report'));

    // Opening it is what reads it.
    await openRow(page, 'Quarterly report');
    await expect(readToggle(page)).toHaveAttribute('aria-label', 'Mark unread');
    await expect.poll(() => server.get('msg-2').flags).toContain(SEEN);
  });

  test('set to Never in Settings, opening a message leaves it unread until marked by hand', async ({
    page,
  }) => {
    await page.goto('/');
    await page.goto('/mailbox/settings#appearance');
    await page.locator('#mark-read-select').click();
    await page.getByRole('option', { name: 'Never' }).click();
    await expect(page.locator('#mark-read-select')).toHaveText('Never');

    // Kept across a reload.
    await page.reload();
    await expect(page.locator('#mark-read-select')).toHaveText('Never');

    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await expectStaysUnread(page, server, 'msg-2', shownInReader(page));

    await readToggle(page).click();
    await expect(readToggle(page)).toHaveAttribute('aria-label', 'Mark unread');
    await expect.poll(() => server.get('msg-2').flags).toContain(SEEN);
  });

  test('with a delay, a message is marked read once it has been open that long', async ({
    page,
  }) => {
    await useMarkReadDelay(page, 5000);
    await openMailbox(page, 'Message 0001');
    const clickedAt = Date.now();
    await openRow(page, 'Quarterly report');
    await expectStaysUnread(page, server, 'msg-2', shownInReader(page), clickedAt + 3000);

    await expect(readToggle(page)).toHaveAttribute('aria-label', 'Mark unread', {
      timeout: 8000,
    });
    expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(5000);
    await expect.poll(() => server.get('msg-2').flags).toContain(SEEN);
  });

  test('with a delay, marking read and unread from the keyboard is not undone by the delay', async ({
    page,
  }) => {
    await useMarkReadDelay(page, 6000);
    await openMailbox(page, 'Message 0001');
    const clickedAt = Date.now();
    await openRow(page, 'Quarterly report');

    // M toggles read: read, then unread again, both before the delay is up.
    await page.keyboard.press('m');
    await expect(readToggle(page)).toHaveAttribute('aria-label', 'Mark unread');
    await page.keyboard.press('m');
    await expect(readToggle(page)).toHaveAttribute('aria-label', 'Mark read');
    expect(Date.now() - clickedAt).toBeLessThan(6000);
    await expect.poll(() => server.changesFor('msg-2').length).toBe(2);

    // Well past the delay, it is still unread.
    while (Date.now() < clickedAt + 8000) {
      expect(await shownInReader(page)()).toBe('unread');
      await page.waitForTimeout(100);
    }
    expect(server.changesFor('msg-2')).toHaveLength(2);
    expect(server.get('msg-2').flags).not.toContain(SEEN);
  });

  test('with a delay, a conversation is marked read as a whole once open that long', async ({
    page,
  }) => {
    await useMarkReadDelay(page, 3000);
    await openMailbox(page, 'Message 0001');
    const clickedAt = Date.now();
    await row(page, 'Trip plans').click();
    await expect(reader(page).getByText('Trip plans').first()).toBeVisible();
    await expectStaysUnread(page, server, 'msg-5', shownInReader(page), clickedAt + 2000);
    expect(server.changesFor('msg-6')).toHaveLength(0);

    await expect(readToggle(page)).toHaveAttribute('aria-label', 'Mark unread', {
      timeout: 6000,
    });
    expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(3000);
    await expect.poll(() => server.get('msg-5').flags).toContain(SEEN);
    await expect.poll(() => server.get('msg-6').flags).toContain(SEEN);
  });

  test('with a delay, a message left before the delay stays unread', async ({ page }) => {
    await useMarkReadDelay(page, 6000);
    // Classic keeps the list beside the reader, so the next row is a click away.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('webmail_layout_mode', 'classic');
      } catch {
        // sandboxed frame
      }
    });
    await openMailbox(page, 'Message 0001');
    const clickedAt = Date.now();
    await openRow(page, 'Quarterly report');
    await openRow(page, 'Weekly digest');
    expect(Date.now() - clickedAt).toBeLessThan(6000);
    await expectStaysUnread(
      page,
      server,
      'msg-2',
      shownInList(page, 'Quarterly report'),
      clickedAt + 8000,
    );
  });
});
