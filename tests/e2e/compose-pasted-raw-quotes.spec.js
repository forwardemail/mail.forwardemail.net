import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
  selectMessageBySubject,
  waitForReaderToOpen,
} from '../fixtures/mailbox-helpers.js';

// A reply or forward quote (blockquote[data-raw-html]) is shown sanitized but
// sent as written, so one pasted from elsewhere would send HTML its sender
// never saw. Only the quotes the editor put in keep their original HTML.

const HIDDEN = '<img src="https://tracker.example/pixel.gif">';
const raw = Buffer.from(`<p>hidden</p>${HIDDEN}`).toString('base64');

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Desktop only');
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
});

async function openReply(page, testInfo) {
  await selectMessageBySubject(page, 'Welcome to Webmail');
  await waitForReaderToOpen(page, testInfo);
  await page.locator('.fe-reader').getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = page.locator('.rich-editor .ProseMirror').first();
  await expect(editor.locator('blockquote[data-raw-html]')).toHaveCount(1);
  return editor;
}

const dispatch = (editor, type, html) =>
  editor.evaluate(
    (el, [type, html]) => {
      const data = new DataTransfer();
      if (html) {
        data.setData('text/html', html);
        data.setData('text/plain', 'shown');
      }

      el.dispatchEvent(
        new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return data.getData('text/html');
    },
    [type, html],
  );

test('a raw quote pasted from elsewhere is not sent as written', async ({ page }, testInfo) => {
  const editor = await openReply(page, testInfo);
  await editor.locator('p').first().click();

  for (const html of [
    `<blockquote data-raw-html="${raw}"><p>shown</p></blockquote>`,
    // attribute names are case-insensitive
    `<blockquote DATA-RAW-HTML="${raw}"><p>shown</p></blockquote>`,
    // the Word cleanup of pasted HTML would join the attribute
    `<blockquote data-raw-<o:p>html="${raw}"><p>shown</p></blockquote>`,
    // read by ProseMirror (it strips leading <meta> tags) as a quote
    `<meta x='>'<blockquote data-raw-html="${raw}">'>`,
  ])
    await dispatch(editor, 'paste', html);

  await expect(editor.locator('blockquote[data-raw-html]')).toHaveCount(1);

  const sent = page.waitForRequest((r) => r.url().includes('/v1/emails') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  const { html } = (await sent).postDataJSON();
  expect(html).toContain('shown');
  expect(html).not.toContain('tracker.example');
  expect(html).not.toContain('hidden');
});

test('a reply quote copied and pasted back keeps its original HTML', async ({ page }, testInfo) => {
  const editor = await openReply(page, testInfo);
  await editor.locator('p').first().click();
  await page.keyboard.press('ControlOrMeta+a');

  const copied = await dispatch(editor, 'copy');
  expect(copied).toContain('data-raw-html');
  // (pasted over everything it was copied from)
  await dispatch(editor, 'paste', copied);

  await expect(editor.locator('blockquote[data-raw-html]')).toHaveCount(1);
});
