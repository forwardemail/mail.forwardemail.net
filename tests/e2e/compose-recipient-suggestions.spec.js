import { expect, test } from '@playwright/test';

import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { waitForAppBoot } from '../fixtures/mailbox-helpers.js';
import { mockApi } from './mockApi.js';

// Compose suggests recipients from Contacts and from everyone mail was sent to
// (the Sent folder), and the list stays where it can be seen and tapped: above
// a phone's on-screen keyboard, inside the compose body, at every screen size.

const contacts = [
  { id: 'c-avery', full_name: 'Avery Contact', emails: [{ value: 'avery@contacts.test' }] },
  { id: 'c-sam', full_name: 'Sam Both', emails: [{ value: 'sam@both.test' }] },
  // Also in Sent: the team fills the list past its height either way.
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `c-team-${i + 1}`,
    full_name: `Teammate ${String(i + 1).padStart(2, '0')}`,
    emails: [{ value: `teammate${i + 1}@team.test` }],
  })),
];

const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();
const sentMessage = (id, fields, age) => ({
  id,
  uid: Number(id.replace(/\D/g, '')) || 1,
  folder: 'SENT',
  subject: `Sent ${id}`,
  from: { value: [{ address: 'test@example.com', name: 'Test' }] },
  date: hoursAgo(age),
  internal_date: hoursAgo(age),
  flags: ['\\Seen'],
  ...fields,
});

const sentMessages = [
  sentMessage('s1', { to: [{ address: 'riley@sent.test', name: 'Riley Sentwell' }] }, 1),
  sentMessage('s2', { to: 'Morgan Sentry <morgan@sent.test>', cc: 'Sam B <sam@both.test>' }, 2),
  sentMessage('s3', { to: 'dev@team.test', bcc: 'riley@sent.test' }, 3),
  // Enough people on one team to fill the list past its height.
  sentMessage(
    's4',
    {
      to: Array.from({ length: 10 }, (_, i) => ({
        address: `teammate${i + 1}@team.test`,
        name: `Teammate ${String(i + 1).padStart(2, '0')}`,
      })),
    },
    4,
  ),
];

// Requests a service worker makes are not seen by page.route in WebKit, so a
// send could slip past the mocks to the real API.
test.use({ serviceWorkers: 'block' });

const isTouch = (testInfo) => Boolean(testInfo.project.use?.hasTouch);

// The page parameter of every Sent list request, per page under test.
const sentPageRequests = new WeakMap();

async function bootMailbox(page) {
  const pages = [];
  sentPageRequests.set(page, pages);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/v1/messages') && url.searchParams.get('folder') === 'SENT') {
      pages.push(url.searchParams.get('page'));
    }
  });
  await setupAuthenticatedSession(page);
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await mockApi(page, { contacts });
  // Registered after mockApi, so it is consulted first.
  await page.route('**/v1/messages**', (route) => {
    const url = new URL(route.request().url());
    const folder = url.searchParams.get('folder') || '';
    if (route.request().method() === 'GET' && folder.toUpperCase() === 'SENT') {
      return route.fulfill({ json: sentMessages });
    }
    return route.fallback();
  });
  await page.goto('/');
  await waitForAppBoot(page);
  await page.goto('/mailbox#INBOX');
  await expect(page.locator('[data-conversation-row]').first()).toBeVisible({ timeout: 15_000 });
}

async function openCompose(page) {
  const tabbar = page.locator('.fe-mobile-tabbar');
  if (await tabbar.isVisible().catch(() => false)) {
    await tabbar.getByLabel('Compose').click();
  } else {
    await page.getByRole('button', { name: 'Compose' }).first().click();
  }
  const compose = page.getByTestId('compose-modal');
  await expect(compose).toBeVisible();
  // The To input, found by placeholder before any chip is added.
  const to = compose.locator('input[placeholder="To"], [data-recipient-field="to"] input').first();
  await expect(to).toBeVisible();
  return { compose, to };
}

async function focusField(input, testInfo) {
  if (isTouch(testInfo)) await input.tap();
  else await input.click();
}

async function pick(locator, testInfo) {
  if (isTouch(testInfo)) await locator.tap();
  else await locator.click();
}

const suggestions = (page) => page.locator('.contact-suggestions');
const options = (page) => suggestions(page).locator('[role="option"], button');
const option = (page, name) => options(page).filter({ hasText: name });
// Shrinks the visual viewport the way an on-screen keyboard does on iOS,
// where the layout viewport (and position: fixed) stays full height.
async function showKeyboard(page, visibleHeight) {
  await page.evaluate((height) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => height });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, visibleHeight);
}

/**
 * The list must sit inside the visible viewport (above the keyboard), show at
 * least one full row, and its first row must be what a tap at its centre
 * lands on: nothing clips it or is drawn over it.
 */
async function expectSuggestionsUsable(page) {
  await expect(suggestions(page)).toBeVisible();
  await expect
    .poll(async () =>
      suggestions(page).evaluate((list) => {
        const rect = list.getBoundingClientRect();
        const vv = window.visualViewport;
        const vvTop = vv ? vv.offsetTop : 0;
        const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
        const top = Math.max(vvTop, 0);
        const bottom = Math.min(vvBottom, window.innerHeight);
        const first = list.querySelector('[role="option"], button');
        const fr = first.getBoundingClientRect();
        const hit = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
        const problems = [];
        if (rect.top < top - 1) problems.push(`top ${rect.top} < ${top}`);
        if (rect.bottom > bottom + 1) problems.push(`bottom ${rect.bottom} > ${bottom}`);
        if (rect.left < -1 || rect.right > window.innerWidth + 1) problems.push('overflows x');
        if (rect.height < 44) problems.push(`height ${rect.height}`);
        if (getComputedStyle(list).visibility !== 'visible') problems.push('hidden');
        if (!first.contains(hit)) problems.push('first option covered');
        return problems.join('; ') || 'ok';
      }),
    )
    .toBe('ok');
}

test.describe('Compose recipient suggestions', () => {
  test.beforeEach(async ({ page }) => {
    await bootMailbox(page);
  });

  test('suggests people from Sent mail who are not in Contacts', async ({ page }, testInfo) => {
    const { compose, to } = await openCompose(page);
    await focusField(to, testInfo);
    await to.pressSequentially('riley');

    const riley = option(page, /Riley Sentwell.*riley@sent\.test/);
    await expect(riley).toBeVisible();
    await expectSuggestionsUsable(page);
    await pick(riley, testInfo);

    await expect(suggestions(page)).toHaveCount(0);
    await expect(compose.getByText('riley@sent.test', { exact: true })).toBeVisible();
    await expect(to).toHaveValue('');
    // The field keeps focus (and a phone keeps its keyboard) for the next one.
    await expect(to).toBeFocused();
  });

  test('Sent is cached without opening it, so suggestions work when the server is unreachable', async ({
    page,
  }, testInfo) => {
    // Opening the Inbox caches Sent in the background.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const names = (await indexedDB.databases()).map((d) => d.name);
          for (const name of names) {
            const opened = await new Promise((resolve) => {
              const req = indexedDB.open(name);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(null);
            });
            if (!opened || !opened.objectStoreNames.contains('messages')) continue;
            const count = await new Promise((resolve) => {
              const tx = opened.transaction('messages', 'readonly');
              const req = tx.objectStore('messages').index('folder').count('SENT');
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(0);
            });
            opened.close();
            if (count) return count;
          }
          return 0;
        }),
      )
      .toBe(sentMessages.length);
    // Fetched by the Sent cache (it pages), not by opening the folder.
    expect(sentPageRequests.get(page)).toContain('1');
    // From now on Sent cannot be fetched: suggestions must come from the cache.
    await page.route('**/v1/messages**', (route) => {
      const folder = new URL(route.request().url()).searchParams.get('folder') || '';
      if (folder.toUpperCase() === 'SENT') return route.abort();
      return route.fallback();
    });
    const { to } = await openCompose(page);
    await focusField(to, testInfo);
    await to.pressSequentially('riley');
    await expect(option(page, /Riley Sentwell.*riley@sent\.test/)).toBeVisible();
  });

  test('lists a contact who is also in Sent once, under the contact name', async ({
    page,
  }, testInfo) => {
    const { to } = await openCompose(page);
    await focusField(to, testInfo);
    await to.pressSequentially('sam');
    await expect(options(page)).toHaveCount(1);
    await expect(option(page, /Sam Both.*sam@both\.test/)).toBeVisible();

    await to.fill('');
    await to.pressSequentially('avery');
    await expect(option(page, /Avery Contact.*avery@contacts\.test/)).toBeVisible();
  });

  test('a name typed with spaces keeps searching instead of becoming a chip', async ({
    page,
  }, testInfo) => {
    const { compose, to } = await openCompose(page);
    await focusField(to, testInfo);
    // A phone keyboard that completes a word adds a space after it.
    await to.pressSequentially('riley ');
    await expect(option(page, /Riley Sentwell/)).toBeVisible();
    await to.pressSequentially('sent');
    await expect(to).toHaveValue('riley sent');
    await expect(option(page, /Riley Sentwell/)).toBeVisible();
    await expect(compose.getByText('riley', { exact: true })).toHaveCount(0);
  });

  test('a comma after a name adds the best match', async ({ page }, testInfo) => {
    const { compose, to } = await openCompose(page);
    await focusField(to, testInfo);
    await to.pressSequentially('morgan,');
    await expect(compose.getByText('morgan@sent.test', { exact: true })).toBeVisible();
    await expect(to).toHaveValue('');
  });

  test('a comma after a name that matches several people keeps the text', async ({
    page,
  }, testInfo) => {
    const { compose, to } = await openCompose(page);
    await focusField(to, testInfo);
    await to.pressSequentially('teammate,');
    await expect(to).toHaveValue('teammate');
    // No chip was added: chips are the only things with a Remove button.
    await expect(compose.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(options(page).first()).toBeVisible();
  });

  test('pasting several addresses adds each one', async ({ page }, testInfo) => {
    const { compose, to } = await openCompose(page);
    await focusField(to, testInfo);
    // A quoted name with a comma in it, as mail apps copy it, stays one entry.
    await to.fill(
      'one@example.org two@example.org, Three <three@example.org>, "Sentwell, Riley" <rs@example.org>,',
    );
    for (const email of [
      'one@example.org',
      'two@example.org',
      'three@example.org',
      'rs@example.org',
    ]) {
      await expect(compose.getByText(email, { exact: true })).toBeVisible();
    }
    await expect(to).toHaveValue('');
  });

  test('keyboard: arrows, Enter and Escape', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), 'Hardware keyboard');
    const { compose, to } = await openCompose(page);
    await to.click();
    await to.pressSequentially('sent.test');
    await expect(options(page)).toHaveCount(2);
    await expect(to).toHaveAttribute('aria-expanded', 'true');
    const second = await options(page).nth(1).textContent();
    await to.press('ArrowDown');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await to.press('Enter');
    const email = second.match(/[\w.+-]+@[\w.-]+/)[0];
    await expect(compose.getByText(email, { exact: true })).toBeVisible();

    await to.pressSequentially('team');
    await expect(suggestions(page)).toBeVisible();
    await to.press('Escape');
    await expect(suggestions(page)).toHaveCount(0);
  });

  test('Enter adds a full address as typed, not a longer suggestion', async ({
    page,
  }, testInfo) => {
    test.skip(isTouch(testInfo), 'Hardware keyboard');
    const { compose, to } = await openCompose(page);
    await to.click();
    await to.pressSequentially('dev@team.te');
    await expect(option(page, /dev@team\.test/)).toBeVisible();
    await to.press('Enter');
    await expect(compose.getByText('dev@team.te', { exact: true })).toBeVisible();
    await expect(compose.getByText('dev@team.test', { exact: true })).toHaveCount(0);
  });

  test('Send includes an address still being typed', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), 'Desktop send flow');
    const sends = [];
    await page.route('**/v1/emails**', async (route) => {
      sends.push(route.request().postDataJSON());
      await route.fulfill({ json: { id: 'e1' } });
    });
    const { compose, to } = await openCompose(page);
    await compose.getByPlaceholder('Subject').fill('Both of them');
    await compose.locator('.ProseMirror').first().click();
    await page.keyboard.type('Hello');
    await to.click();
    await to.fill('first@example.org');
    await to.press('Enter');
    // Typed but not yet a chip when Send is pressed.
    await to.pressSequentially('second@example.org');
    await compose.getByRole('button', { name: 'Send', exact: true }).first().click();

    await expect.poll(() => sends.length).toBeGreaterThan(0);
    expect(sends[0].to).toEqual(['first@example.org', 'second@example.org']);
  });

  test('suggests Sent recipients when forwarding a message', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), 'Desktop context menu');
    await page.locator('[data-conversation-row]').first().click({ button: 'right' });
    await page.getByRole('button', { name: 'Forward', exact: true }).first().click();
    const compose = page.getByTestId('compose-modal');
    const to = compose.getByPlaceholder('To', { exact: true });
    await expect(to).toBeVisible();
    await to.click();
    await to.pressSequentially('morg');
    await expect(option(page, /Morgan Sentry.*morgan@sent\.test/)).toBeVisible();
    await expectSuggestionsUsable(page);
  });

  test('stays above the keyboard on this device', async ({ page }, testInfo) => {
    const { to } = await openCompose(page);
    await focusField(to, testInfo);
    await to.pressSequentially('team');
    await expect(options(page)).toHaveCount(8);
    await expectSuggestionsUsable(page);

    const { height } = page.viewportSize();
    await showKeyboard(page, Math.round(height * 0.45));
    await expectSuggestionsUsable(page);
    await pick(option(page, /Teammate 01/), testInfo);
    await expect(page.getByTestId('compose-modal').getByText('teammate1@team.test')).toBeVisible();
  });
});

// Every screen size from a small phone to a large desktop, in both
// orientations, with and without an on-screen keyboard taking the bottom.
const sizes = [
  { name: 'small phone 320x568', width: 320, height: 568, touch: true },
  { name: 'phone 375x667', width: 375, height: 667, touch: true },
  { name: 'phone 390x844', width: 390, height: 844, touch: true },
  { name: 'large phone 430x932', width: 430, height: 932, touch: true },
  { name: 'Android 412x915', width: 412, height: 915, touch: true },
  { name: 'phone landscape 844x390', width: 844, height: 390, touch: true },
  { name: 'small phone landscape 568x320', width: 568, height: 320, touch: true },
  { name: 'tablet 768x1024', width: 768, height: 1024, touch: true },
  { name: 'tablet landscape 1180x820', width: 1180, height: 820, touch: true },
  { name: 'laptop 1280x720', width: 1280, height: 720, touch: false },
  { name: 'desktop 1440x900', width: 1440, height: 900, touch: false },
  { name: 'large desktop 1920x1080', width: 1920, height: 1080, touch: false },
  { name: 'short desktop window 1024x600', width: 1024, height: 600, touch: false },
];

for (const size of sizes) {
  test.describe(`recipient suggestions at ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
      isMobile: size.touch,
    });

    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'web-chromium', 'Size matrix runs on desktop Chromium');
      await bootMailbox(page);
    });

    test('list is fully visible and tappable, with and without a keyboard', async ({ page }) => {
      const { compose, to } = await openCompose(page);
      const tap = (locator) => (size.touch ? locator.tap() : locator.click());
      await tap(to);
      await to.pressSequentially('team');
      await expect(options(page)).toHaveCount(8);
      await expectSuggestionsUsable(page);

      if (size.touch) {
        // Keyboards take 35-60% of the screen; the most on a phone on its side.
        const keyboard = size.width > size.height ? 0.55 : 0.42;
        await showKeyboard(page, Math.round(size.height * (1 - keyboard)));
        await expectSuggestionsUsable(page);
      }

      await tap(option(page, /Teammate 03/));
      await expect(compose.getByText('teammate3@team.test', { exact: true })).toBeVisible();
      await expect(to).toBeFocused();
    });
  });
}
