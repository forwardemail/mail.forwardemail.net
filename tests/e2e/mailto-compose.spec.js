import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox, navigateToMailbox } from '../fixtures/mailbox-helpers.js';

// A mailto: body is plain text (RFC 6068). Compose used to load it as editor
// HTML, so a mailto link in a received message could place live links and
// markup of the sender's choosing into a new message.

async function openMailto(page, url) {
  await page.evaluate((mailto) => {
    window.dispatchEvent(new CustomEvent('app:deep-link', { detail: { url: mailto } }));
  }, url);
}

test.describe('Compose from mailto: links', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('prefills recipient, subject and body as plain text', async ({ page }) => {
    const body = '<a href="https://phish.example">Verify account</a>\nSecond line';
    await openMailto(
      page,
      `mailto:alice@example.com?subject=${encodeURIComponent('Hello')}&body=${encodeURIComponent(body)}`,
    );

    await expect(page.getByPlaceholder('Subject').first()).toHaveValue('Hello');
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText('<a href="https://phish.example">Verify account</a>');
    await expect(editor).toContainText('Second line');
    // The markup is text, not an element.
    await expect(editor.locator('a')).toHaveCount(0);
  });

  test('ignores a malformed percent-escape instead of breaking', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openMailto(page, 'mailto:bob@example.com?subject=Bad%E0%A4%A&body=ok');

    await expect(page.getByPlaceholder('Subject').first()).toBeVisible();
    await expect(page.locator('[contenteditable="true"]').first()).toContainText('ok');
    expect(errors).toEqual([]);
  });
});
