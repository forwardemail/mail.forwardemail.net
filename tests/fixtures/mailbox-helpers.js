import { expect } from '@playwright/test';
import { mockFolders, mockMessages, mockMessageBodies } from './mockData.js';

/**
 * Set up authenticated session with mock API routes.
 * Intercepts API calls so tests run without a real backend.
 */
export async function setupAuthenticatedMailbox(page) {
  // Set auth tokens in localStorage before navigating
  // Uses the webmail_ prefix that the storage layer expects
  await page.addInitScript(() => {
    localStorage.setItem('webmail_authToken', 'mock-auth-token-12345');
    localStorage.setItem('webmail_email', 'test@example.com');
    localStorage.setItem('webmail_alias_auth', 'test@example.com:mock-password');
    // Tab-scoped keys (also checked via sessionStorage)
    sessionStorage.setItem('alias_auth', 'test@example.com:mock-password');
    sessionStorage.setItem('email', 'test@example.com');
    sessionStorage.setItem('authToken', 'mock-auth-token-12345');
  });

  // Mock API endpoints — the app calls https://api.forwardemail.net/v1/...
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    // Folders
    if (path.includes('/v1/folders') || path.includes('/Folders')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockFolders),
      });
    }

    // Messages list
    if (
      path.includes('/v1/messages') &&
      method === 'GET' &&
      !path.match(/\/v1\/messages\/[^/]+$/)
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMessages),
      });
    }

    // Single message body
    if (path.match(/\/v1\/messages\/([^/]+)$/) && method === 'GET') {
      const id = path.split('/').pop();
      const body = mockMessageBodies[id] || { html: '<p>Message body</p>', attachments: [] };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }

    // Message mutations (PUT - toggle read/star, DELETE)
    if (path.includes('/v1/messages') && (method === 'PUT' || method === 'DELETE')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }

    // Send message
    if (path.includes('/v1/messages') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'sent-msg-1', success: true }),
      });
    }

    // Settings
    if (path.includes('/v1/settings')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    }

    // Search
    if (path.includes('/v1/search')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMessages),
      });
    }

    // Default: pass through or return empty
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Also mock the Remote.request pattern (JMAP-style)
  await page.route('**/api/**', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ Result: {} }),
    });
  });
}

/**
 * Navigate to mailbox and wait for messages to load.
 */
export async function navigateToMailbox(page) {
  // First go to the root to let addInitScript set localStorage
  await page.goto('/');
  // Then navigate to mailbox — the app should see the auth tokens
  await page.goto('/mailbox#INBOX');
  // Wait for the message list to render — or at least the mailbox shell
  await page.waitForSelector(
    '[data-conversation-row], .fe-message-list-wrapper, .fe-mailbox-wrapper',
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1000);
}

/**
 * Check if we're in mobile viewport.
 */
export function isMobileProject(testInfo) {
  return testInfo.project.name.startsWith('mobile');
}

/**
 * Select a message by subject text.
 */
export async function selectMessageBySubject(page, subject) {
  const row = page.locator(`[data-conversation-row]`, { hasText: subject }).first();
  await expect(row).toBeVisible();
  await row.click();
  return row;
}

/**
 * Wait for the reader/message body to appear.
 */
export async function waitForReaderToOpen(page, testInfo) {
  if (isMobileProject(testInfo)) {
    // Mobile: reader takes over the screen
    await page.waitForSelector('.mobile-reader .fe-reader, .fe-reader', { timeout: 5_000 });
  } else {
    // Desktop: reader panel appears alongside the list
    await page.waitForSelector('.fe-reader', { timeout: 5_000 });
  }
}

/**
 * Open compose modal.
 */
export async function openCompose(page, testInfo) {
  if (isMobileProject(testInfo)) {
    // Mobile: use the tab bar compose button
    const composeBtn = page.locator('.fe-mobile-tab', { hasText: 'Compose' });
    if (await composeBtn.isVisible()) {
      await composeBtn.click();
    } else {
      // Fallback: FAB
      await page.getByLabel('Compose').click();
    }
  } else {
    // Desktop: Cmd+N or button
    await page.keyboard.press('Meta+n');
  }
  // Wait for compose modal
  await page.waitForSelector('[class*="inset-0"][class*="flex-col"]', { timeout: 5_000 });
}

/**
 * Fill and send a compose message.
 */
export async function composeAndSend(page, { to, subject, body }) {
  // Fill To field
  const toInput = page.locator('input[placeholder*="To"], input[type="email"]').first();
  await toInput.fill(to);
  await toInput.press('Enter');

  // Fill subject
  const subjectInput = page.locator('input[placeholder*="Subject"]').first();
  await subjectInput.fill(subject);

  // Fill body (TipTap editor)
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.fill(body);

  // Click send
  await page.getByRole('button', { name: /Send/i }).first().click();
}

/**
 * Go back from reader to list (mobile).
 */
export async function goBackToList(page) {
  const backBtn = page.getByLabel('Back to list');
  if (await backBtn.isVisible()) {
    await backBtn.click();
  }
}

/**
 * Click the reply button in the reader toolbar.
 */
export async function clickReplyButton(page) {
  // The reply button may be in the reader backbar or toolbar
  const replyBtn = page.getByLabel(/Reply(?! All)/i).first();
  await replyBtn.click();
  // Wait for compose to open
  await page.waitForTimeout(500);
}

/**
 * Click the forward button in the reader toolbar.
 */
export async function clickForwardButton(page) {
  const fwdBtn = page.getByLabel(/Forward/i).first();
  await fwdBtn.click();
  await page.waitForTimeout(500);
}

/**
 * Toggle star on a message row by subject.
 */
export async function toggleStarBySubject(page, subject) {
  const row = page.locator('[data-conversation-row]', { hasText: subject }).first();
  await expect(row).toBeVisible();
  return row;
}

/**
 * Click the delete button in the reader toolbar.
 */
export async function clickDeleteInReader(page) {
  const deleteBtn = page.getByLabel(/Delete/i).first();
  await deleteBtn.click();
  await page.waitForTimeout(300);
}

/**
 * Click the archive button in the reader toolbar.
 */
export async function clickArchiveInReader(page) {
  const archiveBtn = page.getByLabel(/Archive/i).first();
  await archiveBtn.click();
  await page.waitForTimeout(300);
}

/**
 * Enter selection mode by clicking the Select toolbar button.
 */
export async function enterSelectionMode(page) {
  await page.getByLabel('Enter selection mode').click();
  await page.waitForTimeout(300);
}

/**
 * Select a specific message row checkbox (after entering selection mode).
 */
export async function selectRowCheckbox(page, subject) {
  const row = page.locator('[data-conversation-row]', { hasText: subject }).first();
  const checkbox = row.getByLabel(/Select/i).first();
  await checkbox.click();
  await page.waitForTimeout(200);
}

/**
 * Open compose via the sidebar Compose button.
 */
export async function openComposeFromSidebar(page) {
  await page.getByRole('button', { name: 'Compose' }).first().click();
  await page.waitForTimeout(500);
}
