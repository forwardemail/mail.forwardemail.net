import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  ACCOUNT,
  buildMessage,
  installMailServer,
  installMockSocket,
  row,
} from '../fixtures/state-helpers.js';

// What a message looks like in the editor is what is sent, in both of its
// parts. The draft here is the kind the API or a text-only client writes: one
// text part, no HTML. The API returns no HTML rendering for it.

const TEXT = [
  'Hi,',
  '',
  'JMAP is a separate protocol, not a variation of IMAP.',
  'It defines its own API.',
  '',
  'We do not support JMAP today.',
  '',
  'Best,',
  'Forward Email Support',
].join('\n');

const rawDraft = (msg) =>
  [
    `From: ${ACCOUNT}`,
    'To: a@example.org',
    `Subject: ${msg.subject}`,
    `Message-ID: <${msg.id}@example.org>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    TEXT.replace(/\n/g, '\r\n'),
    '',
  ].join('\r\n');

async function openDraft(page, layout) {
  await page.addInitScript((mode) => {
    try {
      localStorage.setItem('webmail_layout_mode', mode);
      localStorage.setItem('webmail_layout_mode_test@example.com', mode);
    } catch {
      // sandboxed frame
    }
  }, layout);
  await setupAuthenticatedMailbox(page);
  await installMockSocket(page);
  await installMailServer(page, {
    messages: [
      buildMessage(1),
      buildMessage(2, {
        folder: 'Drafts',
        subject: 'Re: JMAP',
        from: [{ address: ACCOUNT, name: '' }],
        to: [{ address: 'a@example.org', name: '' }],
        flags: ['\\Seen', '\\Draft'],
        snippet: 'Hi, JMAP is a separate protocol',
      }),
    ],
    detailBody: (msg) =>
      msg.id === 'msg-2'
        ? { raw: rawDraft(msg), nodemailer: { text: TEXT, html: false, attachments: [] } }
        : null,
  });
  await page.route('**/v1/emails**', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'sent-1' }),
        })
      : route.fallback(),
  );
  await page.goto('/');
  await page.goto('/mailbox#Drafts');
  await expect(row(page, 'Re: JMAP')).toBeVisible({ timeout: 15_000 });
  await row(page, 'Re: JMAP').click();
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toContainText('Forward Email Support', { timeout: 10_000 });
  return editor;
}

async function send(page) {
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/v1\/emails(\?|$)/.test(r.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^Send/ }).first().click();
  return (await sent).postDataJSON();
}

// The lines of an HTML body as a mail client lays them out: one per
// paragraph or line break, '' for a blank one.
const renderedLines = (page, html) =>
  page.evaluate((markup) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;white-space:normal';
    host.innerHTML = markup;
    document.body.append(host);
    const lines = host.innerText.replace(/\n+$/, '').split('\n');
    host.remove();
    return lines;
  }, html);

// How far apart a mail client with no stylesheet of its own draws the
// paragraphs: the gap from the bottom of each to the top of the next, and the
// height of each. The app's own pages reset paragraph margins, so this is
// measured on a bare page.
async function paragraphLayout(page, html) {
  const bare = await page.context().newPage();
  await bare.setContent(`<!doctype html><html><body>${html}</body></html>`);
  const layout = await bare.evaluate(() => {
    const boxes = [...document.querySelectorAll('body > p')].map((p) => p.getBoundingClientRect());
    return {
      gaps: boxes.slice(1).map((box, i) => Math.round(box.top - boxes[i].bottom)),
      heights: boxes.map((box) => Math.round(box.height)),
    };
  });
  await bare.close();
  return layout;
}

test.describe('Sent message formatting', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(isMobileProject(testInfo), 'Desktop compose');
  });

  for (const layout of ['classic', 'full']) {
    test(`a text draft sent as it was opened keeps its lines (${layout})`, async ({ page }) => {
      const editor = await openDraft(page, layout);
      // Paragraphs in the editor, not one code block.
      await expect(editor.locator('pre')).toHaveCount(0);
      await expect(editor.locator('p')).toHaveCount(9);

      const body = await send(page);
      expect(body.text).toBe(TEXT);
      // Nothing of the reader's own markup goes out with it.
      expect(body.html).not.toMatch(/fe-message-canvas|fe-remote-images|<pre/);
      expect(body.html).not.toMatch(/<p[^>]*><\/p>/);
      // A blank line is a paragraph holding a line break, which has height.
      expect(body.html.match(/<p[^>]*><br><\/p>/g)).toHaveLength(3);
      // In a mail client each paragraph sits right under the one before it
      // and a blank one is exactly one line tall, as in the editor. With the
      // client's own paragraph margins a typed blank line arrived as three.
      const { gaps, heights } = await paragraphLayout(page, body.html);
      expect(gaps).toHaveLength(8);
      expect(new Set(gaps)).toEqual(new Set([0]));
      expect(new Set(heights).size).toBe(1);
      expect(heights[0]).toBeGreaterThan(10);
    });
  }

  test('an edited draft sends what the editor shows, blank lines included', async ({ page }) => {
    const editor = await openDraft(page, 'full');
    await editor.click();
    // Put the caret at the end of the last line.
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.lastElementChild);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('PS: see <https://forwardemail.net> & reply');

    const body = await send(page);
    const expected = `${TEXT}\n\nPS: see <https://forwardemail.net> & reply`;
    expect(body.text).toBe(expected);
    // The HTML part lays out as the same lines, the blank ones too. An
    // empty <p> has no height, so innerText reports no line for it.
    const lines = await renderedLines(page, body.html);
    expect(lines.filter((l) => l).join('\n')).toBe(expected.replace(/\n\n/g, '\n'));
    expect(body.html.match(/<p[^>]*><br><\/p>/g)).toHaveLength(4);
  });
});
