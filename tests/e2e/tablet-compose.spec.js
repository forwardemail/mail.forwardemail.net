import { expect, test } from '@playwright/test';
import {
  isMobileProject,
  navigateToMailbox,
  setupAuthenticatedMailbox,
} from '../fixtures/mailbox-helpers.js';

// On a tablet the composer opened as the desktop's 560px panel in a corner,
// with the on-screen keyboard over half of it. And wider than a phone with
// the sidebar shut (an iPad in portrait), Compose was out of sight, and the
// sidebar stayed shut after turning the iPad to landscape. Touch tablets now
// get the full-screen composer, the header has Compose while the sidebar is
// shut, and the sidebar comes back in landscape. A mouse keeps the panel.

const touchTablet = (width, height) => ({
  viewport: { width, height },
  hasTouch: true,
  isMobile: true,
});

async function expectFillsViewport(page, locator) {
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize();
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.y).toBeCloseTo(0, 0);
  expect(box.width).toBeCloseTo(width, 0);
  expect(box.height).toBeCloseTo(height, 0);
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Sets its own tablet and desktop viewports');
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
  await expect(page.locator('[data-conversation-row]').first()).toBeVisible();
});

test.describe('touch tablet in portrait', () => {
  test.use(touchTablet(820, 1180));

  test('Compose in the header opens a full-screen composer', async ({ page }) => {
    await page.getByTestId('header-compose-button').tap();

    const compose = page.getByTestId('compose-modal');
    await expect(compose).toBeVisible();
    await expectFillsViewport(page, compose);
    // Full screen has no smaller size to switch to.
    await expect(compose.getByRole('button', { name: /^Expand/ })).toHaveCount(0);
    await expect(compose.getByRole('button', { name: 'Close' }).last()).toBeVisible();
  });
});

test.describe('touch tablet in landscape', () => {
  test.use(touchTablet(1180, 820));

  test('the sidebar Compose opens a full-screen composer', async ({ page }) => {
    // The sidebar is inline here, so the header does not repeat Compose.
    await expect(page.getByTestId('header-compose-button')).toHaveCount(0);
    await page.getByTestId('compose-button').tap();

    const compose = page.getByTestId('compose-modal');
    await expect(compose).toBeVisible();
    await expectFillsViewport(page, compose);
  });
});

test.describe('larger tablet in portrait', () => {
  // Wider than the drawer, but the sidebar is shut for the list at this width.
  test.use(touchTablet(834, 1194));

  test('Compose in the header opens a full-screen composer', async ({ page }) => {
    await expect(page.getByTestId('compose-button')).toBeHidden();
    await page.getByTestId('header-compose-button').tap();

    const compose = page.getByTestId('compose-modal');
    await expect(compose).toBeVisible();
    await expectFillsViewport(page, compose);
  });

  test('turning it to landscape brings the sidebar back', async ({ page }) => {
    await expect(page.getByTestId('compose-button')).toBeHidden();
    await page.setViewportSize({ width: 1194, height: 834 });

    await expect(page.getByTestId('compose-button')).toBeVisible();
    await expect(page.getByTestId('header-compose-button')).toHaveCount(0);
  });
});

test.describe('desktop with a mouse', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test('keeps the floating composer and its size controls', async ({ page }) => {
    await expect(page.getByTestId('header-compose-button')).toHaveCount(0);
    await page.getByTestId('compose-button').click();

    const compose = page.getByTestId('compose-modal');
    await expect(compose).toBeVisible();
    expect((await compose.boundingBox()).width).toBeCloseTo(560, 0);
    await expect(compose.getByLabel('Expand', { exact: true })).toBeVisible();
  });
});
