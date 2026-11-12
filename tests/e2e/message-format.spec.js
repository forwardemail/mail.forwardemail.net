import { expect, test } from '@playwright/test';
import {
  goBackToList,
  isMobileProject,
  setupAuthenticatedMailbox,
} from '../fixtures/mailbox-helpers.js';
import {
  ACCOUNT,
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// A service worker answers fetches before page.route sees them (WebKit).
test.use({ serviceWorkers: 'block' });

// Settings > Appearance > Message format (issue #26): formatted, the sender's
// plain-text version when there is one, or always plain text. The reader shows
// which it used and switches one message back and forth.

const headers = (msg) => [
  `From: ${msg.from[0].name} <${msg.from[0].address}>`,
  `To: ${ACCOUNT}`,
  `Subject: ${msg.subject}`,
  `Date: ${new Date(msg.date).toUTCString()}`,
  `Message-ID: <${msg.id}@example.org>`,
  'MIME-Version: 1.0',
];

const alternative = (msg) =>
  [
    ...headers(msg),
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The sender wrote this plain version.',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p><b>The sender designed this formatted version.</b></p>',
    '--b1--',
    '',
  ].join('\r\n');

const htmlOnly = (msg) =>
  [
    ...headers(msg),
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Only a <i>formatted</i> version exists.</p>',
    '',
  ].join('\r\n');

const body = (page) => page.locator('.fe-reader').frameLocator('iframe.fe-email-iframe').first();
const formatBar = (page) => page.getByTestId('message-format-bar');

async function setup(page, format) {
  await setupAuthenticatedMailbox(page);
  await installMockSocket(page);
  if (format) {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('webmail_message_format', value);
      } catch {
        // sandboxed email frame
      }
    }, format);
  }
  await installMailServer(page, {
    messages: [
      buildMessage(1, { subject: 'Both versions' }),
      buildMessage(2, { subject: 'Formatted only' }),
    ],
    detailBody: (msg) => ({ raw: msg.id === 'msg-1' ? alternative(msg) : htmlOnly(msg) }),
  });
}

async function open(page, subject) {
  await row(page, subject).click();
  await expect(page.locator('.fe-reader').getByText(subject).first()).toBeVisible();
}

test.describe('Message format', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop reader layout');
  });

  test('formatted by default, with no format bar', async ({ page }) => {
    await setup(page);
    await openMailbox(page, 'Both versions');
    await open(page, 'Both versions');
    await expect(body(page).getByText('The sender designed this formatted version.')).toBeVisible();
    await expect(formatBar(page)).toHaveCount(0);
  });

  test('plain text when available, and one message switched back', async ({ page }) => {
    await setup(page, 'text-first');
    await openMailbox(page, 'Both versions');
    await open(page, 'Both versions');

    await expect(body(page).getByText('The sender wrote this plain version.')).toBeVisible();
    await expect(formatBar(page)).toContainText('Shown as plain text.');

    await formatBar(page).getByRole('button', { name: 'Show formatting' }).click();
    await expect(body(page).getByText('The sender designed this formatted version.')).toBeVisible();
    await expect(formatBar(page)).toContainText('Shown with formatting.');

    // A message with no plain-text version is shown formatted.
    await goBackToList(page);
    await open(page, 'Formatted only');
    await expect(body(page).getByText('Only a formatted version exists.')).toBeVisible();
    await expect(body(page).locator('i')).toHaveText('formatted');
    await expect(formatBar(page)).toHaveCount(0);
  });

  test('plain text only converts a formatted-only message', async ({ page }) => {
    await setup(page, 'text');
    await openMailbox(page, 'Formatted only');
    await open(page, 'Formatted only');
    await expect(body(page).getByText('Only a formatted version exists.')).toBeVisible();
    await expect(body(page).locator('i')).toHaveCount(0);
    await expect(formatBar(page)).toContainText('Shown as plain text.');
  });

  test('choosing a format in Settings applies to the next message opened', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await page.goto('/mailbox/settings#appearance');
    const group = page.getByRole('radiogroup', { name: 'Message format' });
    await expect(group.getByRole('radio', { name: /Formatted \(Recommended\)/ })).toBeChecked();
    await group.getByRole('radio', { name: /Plain text when available/ }).check();
    await expect(page.getByText('Messages: Plain text when available')).toBeVisible();

    await page.goto('/mailbox#INBOX');
    await open(page, 'Both versions');
    await expect(body(page).getByText('The sender wrote this plain version.')).toBeVisible();
  });
});
