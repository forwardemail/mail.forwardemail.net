import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
} from '../fixtures/state-helpers.js';

// A feedback report carries the local database's health: whether the db
// worker answers, what it and the sync worker are waiting on, and how many
// bodies are cached. This runs the real workers, so it checks the plumbing the
// unit tests mock out.

test.describe('Feedback database health', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop settings layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, { messages: [buildMessage(1)] });
  });

  test('the report preview says the database is answering', async ({ page }) => {
    await openMailbox(page, 'Message 0001');
    await page.goto('/mailbox/settings#help');
    await page.getByRole('button', { name: 'Send Feedback' }).click();
    await page.locator('#consent-system').click();
    await page.getByText('Preview what will be sent').click();

    const preview = page.locator('pre code');
    await expect(preview).toContainText('"database"', { timeout: 10_000 });
    const payload = JSON.parse(await preview.innerText());
    const { database } = payload.systemInfo;

    expect(database.dbWorker).toMatchObject({ engine: 'worker', answered: true });
    expect(database.dbWorker.served).toBeGreaterThan(0);
    expect(Array.isArray(database.dbWorker.inFlight)).toBe(true);
    expect(database.syncWorker).toMatchObject({ connected: true, timeouts: 0, reconnects: 0 });
    expect(typeof database.cachedBodies).toBe('number');
  });
});
