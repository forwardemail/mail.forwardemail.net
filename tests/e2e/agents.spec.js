import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
} from '../fixtures/mailbox-helpers.js';

// Agent mode runs against the in-page mock backend until the server ships,
// so these specs cover the client flows only.

const enableAgentMode = (page) =>
  page.addInitScript(() => {
    try {
      localStorage.setItem('webmail_agent_mode', 'true');
    } catch {
      // sandboxed frame
    }
  });

test.describe('Agent mode — off by default', () => {
  test('no Mail | Agents switch, and /agents falls back to the mailbox', async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
    await expect(page.getByTestId('mode-switch')).toHaveCount(0);

    await page.goto('/agents');
    await expect(page.getByTestId('agents-shell')).toBeHidden();
  });
});

test.describe('Agent mode — supervision', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await enableAgentMode(page);
  });

  test('switches from Mail to Agents and approves a card', async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'sidebar switch is desktop chrome');
    await navigateToMailbox(page);
    const sidebar = page.getByTestId('mailbox-sidebar');
    await sidebar.getByRole('button', { name: /Agents/ }).click();

    await expect(page.getByRole('heading', { name: 'Waiting on you' })).toBeVisible();
    const card = page.getByRole('listitem', { name: /billing-agent to billing@initech\.dev/ });
    await expect(card).toBeVisible();
    await expect(card.getByText('First contact with a new domain needs a human')).toBeVisible();

    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('agents-live')).toContainText('approved and sent');
  });

  test('shows "already handled on another device" instead of overwriting', async ({ page }) => {
    await page.goto('/');
    await page.goto('/agents');
    const card = page.getByRole('listitem', { name: /billing-agent to ap@acme-supply\.com/ });
    await card.getByRole('button', { name: 'Review' }).click();

    await page.getByRole('button', { name: 'approve this on another device' }).click();
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Already handled on another device' }),
    ).toBeVisible();
  });

  test('keyboard: a does nothing until j picks a card', async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'keyboard shortcuts are desktop only');
    await page.goto('/');
    await page.goto('/agents');
    const cards = page.getByTestId('decision-card');
    await expect(cards).toHaveCount(3);
    await page.keyboard.press('a');
    await expect(cards).toHaveCount(3);
    await page.keyboard.press('j');
    await page.keyboard.press('a');
    await expect(cards).toHaveCount(2);
    await expect(page.getByTestId('agents-live')).toContainText(
      'Q4 renewal quote: approved and sent',
    );
  });

  test('pause all needs one confirmation and shows a banner', async ({ page }) => {
    await page.goto('/');
    await page.goto('/agents');
    await page.getByTestId('kill-switch').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pause all' }).click();
    await expect(page.getByText('All agents are paused.')).toBeVisible();

    await page.getByTestId('kill-switch').click();
    await expect(page.getByText('All agents are paused.')).toBeHidden();
  });

  test('pause all is disabled offline rather than queued', async ({ page, context }) => {
    await page.goto('/');
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Waiting on you' })).toBeVisible();
    // The app verifies "offline" with a probe to /v1/, which the mailbox mock
    // would otherwise answer. Fail it the way a dead network would.
    await page.route('**/v1/', (route) => route.abort('internetdisconnected'));
    await context.setOffline(true);
    await expect(page.getByTestId('kill-switch')).toBeDisabled({ timeout: 10_000 });
    await expect(page.getByTestId('kill-switch')).toContainText('Connect to pause agents');
    await context.setOffline(false);
  });

  test('revoke asks first and leaves the history', async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'agent list sits in the drawer on mobile');
    await page.goto('/');
    await page.goto('/agents');
    await page.getByRole('link', { name: /scheduling-agent/ }).click();
    await page.getByRole('button', { name: 'Revoke' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('It stops sending and receiving immediately.');
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText(/^Revoked/)).toBeVisible();
    await expect(page.getByLabel('Audit trail for scheduling-agent')).toContainText('revoked');
  });
});
