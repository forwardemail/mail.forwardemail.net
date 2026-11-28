import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// The details under a message's header ("Show details"): its size, and the
// SPF, DKIM and DMARC results Forward Email's servers recorded for it, each
// in the colour of its result.

// The headers of a message as the API returns them: parsed, and as received.
const headersFor = (lines) => ({
  headers: Object.fromEntries(lines.map(([key, value]) => [key.toLowerCase(), value])),
  headerLines: lines.map(([key, value]) => ({
    key: key.toLowerCase(),
    line: `${key}: ${value}`,
  })),
});

const HEADERS = {
  // Signed by nobody the server could verify, and failing DMARC
  'msg-2': [
    ['Received', 'from mail.example.org by mx1.forwardemail.net with ESMTPS (version=TLSv1.3)'],
    [
      'Authentication-Results',
      'mx1.forwardemail.net; dkim=fail header.d=example.org; spf=softfail smtp.mailfrom=example.org; dmarc=fail header.from=example.org',
    ],
  ],
  // A sender vouching for itself, above the server's own verdict
  'msg-3': [
    ['Authentication-Results', 'mx.example.org; dkim=pass; spf=pass; dmarc=pass'],
    ['Authentication-Results', 'mx2.forwardemail.net; dkim=pass; spf=pass; dmarc=none'],
  ],
  // A sender vouching for itself, with no verdict from the server at all
  'msg-4': [['Authentication-Results', 'mx.example.org; dkim=pass; spf=pass; dmarc=pass']],
};

const reader = (page) => page.locator('.fe-reader');
const security = (page) => page.getByTestId('reader-security');
const part = (page, text) => security(page).locator('[data-tone]', { hasText: text });

// Opens a message and its details. Whether the details stay open from one
// message to the next is not what these tests are about, so both are handled.
async function openDetails(page, subject) {
  await row(page, subject).click();
  await expect(reader(page).getByText(subject).first()).toBeVisible();
  const toggle = reader(page).getByRole('button', { name: /^(Show|Hide) details$/ });
  if ((await toggle.getAttribute('aria-label')) === 'Show details') await toggle.click();
  await expect(page.getByTestId('reader-message-size')).toBeVisible();
}

test.describe('Message details', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop reader layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    // Classic keeps the list beside the reader, to go from message to message
    await page.addInitScript(() => {
      try {
        localStorage.setItem('webmail_layout_mode', 'classic');
      } catch {
        // sandboxed frame
      }
    });
    await installMailServer(page, {
      messages: [
        buildMessage(1),
        buildMessage(2, { subject: 'Invoice overdue', size: 3_355_443 }),
        buildMessage(3, { subject: 'Newsletter' }),
        buildMessage(4, { subject: 'Self certified' }),
      ],
      detailBody: (msg) => ({
        nodemailer: {
          text: msg.snippet,
          html: `<p>${msg.snippet}</p>`,
          attachments: [],
          ...headersFor(HEADERS[msg.id] || []),
        },
      }),
    });
  });

  test('shows the size of the message', async ({ page }) => {
    await openMailbox(page, 'Message 0001');
    await openDetails(page, 'Invoice overdue');
    await expect(page.getByTestId('reader-message-size')).toHaveText(/size:\s*3\.2 MB/);
  });

  test('a failed check is not shown as a pass', async ({ page }) => {
    await openMailbox(page, 'Message 0001');
    await openDetails(page, 'Invoice overdue');

    await expect(part(page, 'DKIM: Fail')).toHaveAttribute('data-tone', 'fail');
    await expect(part(page, 'DMARC: Fail')).toHaveAttribute('data-tone', 'fail');
    await expect(part(page, 'SPF: Softfail')).toHaveAttribute('data-tone', 'caution');
    await expect(security(page).locator('[data-tone="pass"]')).toHaveCount(0);

    // And they are drawn differently: a failure in the danger colour, not
    // the colour of a pass.
    const failColor = await part(page, 'DKIM: Fail').evaluate((el) => getComputedStyle(el).color);
    await openDetails(page, 'Newsletter');
    await expect(part(page, 'DKIM: Pass')).toHaveAttribute('data-tone', 'pass');
    const passColor = await part(page, 'DKIM: Pass').evaluate((el) => getComputedStyle(el).color);
    expect(failColor).not.toBe(passColor);
  });

  test('reads the results from the server, not from what the sender wrote', async ({ page }) => {
    await openMailbox(page, 'Message 0001');
    await openDetails(page, 'Newsletter');
    // The sender's header says dmarc=pass; the server recorded dmarc=none.
    await expect(part(page, 'DMARC: None')).toHaveAttribute('data-tone', 'caution');
    await expect(security(page)).not.toContainText('DMARC: Pass');

    await openDetails(page, 'Self certified');
    await expect(security(page)).toHaveCount(0);
  });
});
