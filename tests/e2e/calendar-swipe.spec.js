import { expect, test } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';

// A sideways swipe across the calendar moves it a period. On a phone, whose
// month view is the month agenda, it moved a week, so the month on screen
// stayed. And a touch the system takes over (the home indicator, Control
// Center) ends in touchcancel rather than touchend, which moved it as well,
// as the user left the app.

test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

// A real touch, through Chromium's input pipeline, ended by `end`.
async function swipeLeft(page, end) {
  const area = await page.getByTestId('calendar-ready').boundingBox();
  const y = area.y + area.height * 0.55;
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await send('touchStart', [{ x: area.x + area.width * 0.8, y }]);
  for (let i = 1; i <= 10; i += 1) {
    await send('touchMove', [{ x: area.x + area.width * (0.8 - 0.06 * i), y }]);
  }
  await send(end, []);
  await cdp.detach();
}

test.beforeEach(async ({ page }) => {
  await setupAuthenticatedSession(page);
  await mockApi(page);
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });
});

// "November 2026" and a number of months on, in the same form.
function monthsAfter(heading, months) {
  const [name, year] = heading.trim().split(/\s+/);
  const date = new Date(`${name} 1, ${year}`);
  date.setMonth(date.getMonth() + months);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

test('each swipe to the left shows the next month', async ({ page }) => {
  const heading = page.locator('.sx__range-heading');
  // (the heading is filled in a frame after the calendar appears)
  await expect(heading).toHaveText(/\S/);
  const month = await heading.textContent();

  await swipeLeft(page, 'touchEnd');
  await expect(heading).toHaveText(monthsAfter(month, 1));
  // (a grid that starts in the month before: a month on from its first day
  // was the same month)
  await swipeLeft(page, 'touchEnd');
  await expect(heading).toHaveText(monthsAfter(month, 2));
});

test('a swipe the system takes over moves nothing', async ({ page }) => {
  const heading = page.locator('.sx__range-heading');
  // (the heading is filled in a frame after the calendar appears)
  await expect(heading).toHaveText(/\S/);
  const month = await heading.textContent();
  await swipeLeft(page, 'touchCancel');
  await page.waitForTimeout(500);

  await expect(heading).toHaveText(month);
});
