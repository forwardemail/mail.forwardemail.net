import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// Settings > Appearance > Layout > Customize message view chooses which actions sit
// beside the folder badge in the reader header. Reply alone is the default;
// whatever is left out stays in the "…" menu.

function seedMessages() {
  return [
    buildMessage(1),
    buildMessage(2, { subject: 'Quarterly report' }),
    buildMessage(3, { subject: 'Team lunch' }),
    // One conversation of two messages
    buildMessage(5, { subject: 'Re: Trip plans', thread_id: 'thread-trip' }),
    buildMessage(6, { subject: 'Trip plans', thread_id: 'thread-trip' }),
  ];
}

// Classic keeps the list beside the reader, and has no full-screen toolbar,
// so the header is the only row of buttons.
async function useClassicLayout(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('webmail_layout_mode', 'classic');
    } catch {
      // sandboxed frame
    }
  });
}

async function useHeaderActions(page, actions) {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('webmail_reader_header_actions', value);
    } catch {
      // sandboxed frame
    }
  }, JSON.stringify(actions));
}

const reader = (page) => page.locator('.fe-reader');
const headerButton = (page, id) => page.getByTestId(`reader-header-${id}`);
const settingBox = (page, id) => page.getByTestId(`reader-header-action-${id}`);

async function openRow(page, subject) {
  await row(page, subject).click();
  await expect(reader(page).getByText(subject).first()).toBeVisible();
}

test.describe('Message view quick actions', () => {
  let server;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop reader and settings layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await useClassicLayout(page);
    server = await installMailServer(page, { messages: seedMessages() });
  });

  test('by default the header shows Reply alone', async ({ page }) => {
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await expect(headerButton(page, 'reply')).toBeVisible();
    for (const id of ['archive', 'reportSpam', 'delete', 'move', 'toggleRead']) {
      await expect(headerButton(page, id)).toHaveCount(0);
    }
  });

  test('chosen in Settings, Archive and Report spam appear and Archive archives the message', async ({
    page,
  }) => {
    await page.goto('/');
    await page.goto('/mailbox/settings#appearance');
    // Collapsed under Layout until opened
    await expect(settingBox(page, 'reply')).toHaveCount(0);
    await page.getByTestId('customize-message-view-toggle').click();
    await expect(settingBox(page, 'reply')).toHaveAttribute('data-state', 'checked');
    await settingBox(page, 'archive').click();
    await settingBox(page, 'reportSpam').click();
    await settingBox(page, 'move').click();
    await expect(settingBox(page, 'archive')).toHaveAttribute('data-state', 'checked');

    // Kept across a reload.
    await page.reload();
    await page.getByTestId('customize-message-view-toggle').click();
    for (const id of ['reply', 'archive', 'reportSpam', 'move']) {
      await expect(settingBox(page, id)).toHaveAttribute('data-state', 'checked');
    }
    await expect(settingBox(page, 'delete')).toHaveAttribute('data-state', 'unchecked');

    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    for (const [id, name] of [
      ['reply', /^Reply/],
      ['archive', 'Archive'],
      ['reportSpam', 'Report spam'],
      ['move', 'Move to'],
    ]) {
      await expect(headerButton(page, id)).toBeVisible();
      await expect(headerButton(page, id)).toHaveAccessibleName(name);
    }

    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');
  });

  test('Move to in the header moves the open message to the folder picked', async ({ page }) => {
    await useHeaderActions(page, ['move']);
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Team lunch');
    await headerButton(page, 'move').click();
    await page.getByRole('menuitem', { name: 'Trash' }).click();
    await expect.poll(() => server.get('msg-3').folder_path).toBe('Trash');
  });

  test('Archive in the header archives a whole conversation', async ({ page }) => {
    await useHeaderActions(page, ['archive']);
    await openMailbox(page, 'Message 0001');
    await row(page, 'Trip plans').click();
    await expect(reader(page).getByText('Trip plans').first()).toBeVisible();
    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-5').folder_path).toBe('Archive');
    await expect.poll(() => server.get('msg-6').folder_path).toBe('Archive');
  });

  test('Archive works again on the message the reader moves to after an archive', async ({
    page,
  }) => {
    await useHeaderActions(page, ['archive']);
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');

    // The reader moves on to the next message; its Archive must act on it.
    await expect(reader(page).getByText('Team lunch').first()).toBeVisible();
    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-3').folder_path).toBe('Archive');
  });

  test('Archive acts on the message the list opened by itself, not the last one clicked', async ({
    page,
  }) => {
    await useHeaderActions(page, ['archive']);
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');

    // Leave and come back: Classic opens the first message by itself, without
    // a click, so the last conversation clicked can stay selected behind it.
    await page.locator('[data-testid="folder-item"][data-folder-path="Archive"] > button').click();
    await page.locator('[data-testid="folder-item"][data-folder-path="INBOX"] > button').click();
    await expect(reader(page).getByText('Message 0001').first()).toBeVisible();

    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-1').folder_path).toBe('Archive');
    expect(server.get('msg-2').folder_path).toBe('INBOX');
  });

  test('Archive acts on the message Classic opens by itself on load', async ({ page }) => {
    await useHeaderActions(page, ['archive']);
    await openMailbox(page, 'Message 0001');
    // No click: Classic opens the newest message, and no row is selected.
    await expect(reader(page).getByText('Message 0001').first()).toBeVisible();

    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-1').folder_path).toBe('Archive');
    await expect(row(page, 'Message 0001')).toHaveCount(0);
  });

  test('in Full Screen the header shows the chosen buttons too', async ({ page }) => {
    // Runs after beforeEach's Classic script, so Full Screen wins
    await page.addInitScript(() => {
      try {
        localStorage.setItem('webmail_layout_mode', 'full');
      } catch {
        // sandboxed frame
      }
    });
    await useHeaderActions(page, ['reply', 'archive', 'reportSpam']);
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await expect(page.locator('.fe-reader-toolbar')).toBeVisible();
    for (const id of ['reply', 'archive', 'reportSpam']) {
      await expect(headerButton(page, id)).toBeVisible();
    }

    await headerButton(page, 'archive').click();
    await expect.poll(() => server.get('msg-2').folder_path).toBe('Archive');
  });

  test('an action left out of the header is still in the … menu', async ({ page }) => {
    // Reply turned off, Archive on
    await useHeaderActions(page, ['archive']);
    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Quarterly report');
    await expect(headerButton(page, 'archive')).toBeVisible();
    await expect(headerButton(page, 'reply')).toHaveCount(0);
    await expect(headerButton(page, 'reportSpam')).toHaveCount(0);

    await reader(page).getByRole('button', { name: 'Message actions' }).click();
    await expect(page.getByTestId('action-menu-reply')).toBeVisible();
    await expect(page.getByTestId('action-menu-report-spam')).toBeVisible();
  });
});
