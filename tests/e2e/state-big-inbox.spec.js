import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
} from '../fixtures/state-helpers.js';

// A 3000 message inbox of PGP encrypted mail. While background sync is still
// filling in the folder, opening a message nothing has fetched yet (from a
// link, so not by scrolling to it) must still show its reader quickly. Before
// the fix the reader waited behind the backfill's database writes for most of
// a minute.

const TOTAL = 3000;
const READY_WITHIN_MS = 5000;

const PGP_RAW = [
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
  'From: Sender <sender@example.org>',
  'To: test@example.com',
  'Subject: Encrypted',
  'MIME-Version: 1.0',
  '',
  '--b',
  'Content-Type: application/pgp-encrypted',
  '',
  'Version: 1',
  '--b',
  'Content-Type: application/octet-stream',
  '',
  '-----BEGIN PGP MESSAGE-----',
  '',
  'hQEMA0dummydummydummyAQf/dummy',
  '=abcd',
  '-----END PGP MESSAGE-----',
  '--b--',
].join('\r\n');

// The background backfill pages through the folder 100 at a time. Each page
// takes a little while, as on a real connection, so it is still running when
// the messages are opened.
const isBackfillPage = (params) =>
  params.folder === 'INBOX' && params.limit === '100' && !params.is_unread;

test.describe('Big PGP inbox', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only');

  test('an uncached PGP message opens quickly while the backfill runs', async ({ page }) => {
    test.setTimeout(120_000);
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    const messages = Array.from({ length: TOTAL }, (_, i) =>
      buildMessage(i + 1, { unread: (i + 1) % 5 === 0 }),
    );
    const server = await installMailServer(page, {
      messages,
      listDelay: (params) => (isBackfillPage(params) && params.page !== '1' ? 250 : 0),
      detailBody: () => ({ raw: PGP_RAW, nodemailer: null }),
    });
    const backfillPages = () =>
      server
        .requests({ method: 'GET', path: '/v1/messages' })
        .filter((r) => isBackfillPage(r.params));
    const furthestBackfillPage = () =>
      Math.max(0, ...backfillPages().map((r) => Number(r.params.page)));

    await openMailbox(page, 'Message 0001');
    // Wait until the backfill is past its first page and writing to the cache.
    await expect.poll(() => backfillPages().length, { timeout: 30_000 }).toBeGreaterThan(2);

    for (const n of [1500, 2200, 2900]) {
      const id = `msg-${n}`;
      // Not fetched yet: no body request for it, and the backfill has not
      // reached its page.
      expect(server.requests({ method: 'GET', path: `/v1/messages/${id}` })).toHaveLength(0);
      expect(furthestBackfillPage()).toBeLessThan(Math.ceil(n / 100));

      const started = Date.now();
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, `#INBOX/${id}`);
      await expect(
        page
          .locator('.fe-reader')
          .getByText(/PGP encrypted (and could not be decrypted|\. Enter your passphrase)/)
          .first(),
      ).toBeVisible({ timeout: READY_WITHIN_MS });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(READY_WITHIN_MS);
      await expect(
        page
          .locator('.fe-reader')
          .getByText(`Message ${String(n).padStart(4, '0')}`)
          .first(),
      ).toBeVisible();

      await page.evaluate(() => {
        window.location.hash = '#INBOX';
      });
      await expect(page.locator('[data-conversation-row]').first()).toBeVisible();
    }

    // All three opened before the backfill was done.
    expect(furthestBackfillPage()).toBeLessThan(TOTAL / 100);
  });
});
