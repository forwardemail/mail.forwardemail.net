import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
  selectMessageBySubject,
  waitForReaderToOpen,
} from '../fixtures/mailbox-helpers.js';

// A reply marks the message it answers with \Answered on the server, which is
// where IMAP clients such as Thunderbird read it. The in-page compose was
// never told which message it answered, so it never sent that change.

const ANSWERED = '\\Answered';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Desktop only');
  // page.route does not cover WebSockets; without this the app connects to
  // the real server with the mock credentials.
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
});

const isAnswered = (body) => Boolean(body?.flags_add?.includes(ANSWERED));

// Flag changes the app sends (PUT /v1/messages/:id). While `server.down` is
// true, changes that add \Answered get a server error.
async function recordFlagChanges(page, server = { down: false }) {
  const changes = [];
  await page.route(/\/v1\/messages\/[^/?]+(\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const body = request.postDataJSON();
    const failed = server.down && isAnswered(body);
    changes.push({ path: new URL(request.url()).pathname, body, failed });
    await route.fulfill({
      status: failed ? 503 : 200,
      contentType: 'application/json',
      body: failed ? '{"message":"Service Unavailable"}' : '{"success":true}',
    });
  });
  return changes;
}

async function replyAndSend(page, testInfo, subject, text) {
  await selectMessageBySubject(page, subject);
  await waitForReaderToOpen(page, testInfo);
  await page.locator('.fe-reader').getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
}

const answeredChanges = (changes) => changes.filter((change) => isAnswered(change.body));

test('a reply flags the message it answers as answered on the server', async ({
  page,
}, testInfo) => {
  const changes = await recordFlagChanges(page);
  const sent = page.waitForRequest((r) => r.url().includes('/v1/emails') && r.method() === 'POST');

  await replyAndSend(page, testInfo, 'Welcome to Webmail', 'Thanks, received.');
  await sent;

  await expect.poll(() => answeredChanges(changes).length).toBe(1);
  // and only once
  await page.waitForTimeout(1500);
  expect(answeredChanges(changes)).toHaveLength(1);
  const [change] = answeredChanges(changes);
  // the message that was opened, which opening marked read
  const read = changes.find((c) => c.body?.flags_add?.includes('\\Seen'));
  expect(change.path).toBe(read.path);
  // Only the addition: the server keeps every other flag the message has.
  expect(change.body.flags_add).toEqual([ANSWERED]);
  expect(change.body.flags_remove).toBeUndefined();
  expect(change.body.flags).toContain(ANSWERED);
});

test('a flag change that keeps failing is queued and sent again', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const server = { down: true };
  const changes = await recordFlagChanges(page, server);

  await replyAndSend(page, testInfo, 'Welcome to Webmail', 'Thanks again.');

  // The request and both of its automatic retries fail; after that only the
  // queue sends it again.
  await expect
    .poll(() => answeredChanges(changes).filter((change) => change.failed).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(3);
  server.down = false;

  await expect
    .poll(() => answeredChanges(changes).some((change) => !change.failed), { timeout: 20_000 })
    .toBe(true);
  const sent = answeredChanges(changes).find((change) => !change.failed);
  expect(sent.path).toBe(answeredChanges(changes)[0].path);
  expect(sent.body.flags_add).toEqual([ANSWERED]);
});

test('a reply minimized to the dock still flags the message it answers', async ({
  page,
}, testInfo) => {
  const changes = await recordFlagChanges(page);

  await selectMessageBySubject(page, 'Welcome to Webmail');
  await waitForReaderToOpen(page, testInfo);
  await page.locator('.fe-reader').getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('Back to this in a moment.');

  await page.locator('button:has(svg.lucide-minus)').first().click();
  const docked = page.getByRole('button', { name: /Re: Welcome to Webmail/ });
  await expect(docked).toBeVisible();
  await docked.click();

  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await expect.poll(() => answeredChanges(changes).length).toBe(1);
  const read = changes.find((c) => c.body?.flags_add?.includes('\\Seen'));
  expect(answeredChanges(changes)[0].path).toBe(read.path);
});
