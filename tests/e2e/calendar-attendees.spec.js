import { expect, test } from '@playwright/test';

import { openNewEventModal, setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { mockApi } from './mockApi.js';

// Event attendees: suggested from Contacts and from everyone mail was sent
// to, checked as they are added, and never dropped on Save. And every dialog
// stays above a phone's on-screen keyboard, Save button included.

const contacts = [
  { id: 'c-avery', full_name: 'Avery Contact', emails: [{ value: 'avery@contacts.test' }] },
];
const sentMessages = [
  {
    id: 's1',
    folder: 'SENT',
    subject: 'Hi',
    from: { value: [{ address: 'test@example.com', name: 'Test' }] },
    to: [{ address: 'riley@sent.test', name: 'Riley Sentwell' }],
    date: new Date().toISOString(),
    flags: ['\\Seen'],
  },
];

test.use({ serviceWorkers: 'block' });

async function openCalendar(page, posts = []) {
  await setupAuthenticatedSession(page);
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await mockApi(page, {
    contacts,
    calendars: [{ id: 'calendar', calendar_id: 'calendar', name: 'Calendar' }],
    events: [],
  });
  await page.route('**/v1/messages**', (route) => {
    const folder = new URL(route.request().url()).searchParams.get('folder') || '';
    if (route.request().method() === 'GET' && folder.toUpperCase() === 'SENT') {
      return route.fulfill({ json: sentMessages });
    }
    return route.fallback();
  });
  await page.route('**/v1/calendar-events**', (route) => {
    if (route.request().method() === 'POST') posts.push(route.request().postData() || '');
    return route.fallback();
  });
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 15_000 });
}

async function openAttendees(page) {
  const dialog = await openNewEventModal(page);
  await dialog.getByRole('button', { name: 'More details' }).click();
  const input = dialog.locator('#new-event-attendee-input');
  await expect(input).toBeVisible();
  return { dialog, input };
}

const attendeeRows = (dialog) => dialog.getByRole('button', { name: /^Remove / });

test.describe('event attendees', () => {
  test('suggests people from Contacts and from Sent mail', async ({ page }) => {
    await openCalendar(page);
    const { input } = await openAttendees(page);
    await expect(input).toHaveAttribute('list', 'attendee-suggestions');
    await expect
      .poll(() =>
        page.$$eval('#attendee-suggestions option', (options) => options.map((o) => o.value)),
      )
      .toEqual(expect.arrayContaining(['avery@contacts.test', 'riley@sent.test']));
  });

  test('adds pasted addresses once each and refuses what is not an address', async ({ page }) => {
    await openCalendar(page);
    const { dialog, input } = await openAttendees(page);

    await input.fill('a@example.org b@example.org; Jane Doe <JANE@example.org>');
    await input.press('Enter');
    await expect(attendeeRows(dialog)).toHaveCount(3);
    for (const email of ['a@example.org', 'b@example.org', 'jane@example.org']) {
      await expect(dialog.getByText(email, { exact: true })).toBeVisible();
    }

    // The same address in another case is not added twice.
    await input.fill('A@EXAMPLE.ORG');
    await input.press('Enter');
    await expect(attendeeRows(dialog)).toHaveCount(3);

    await input.fill('not-an-address');
    await input.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('not-an-address');
    await expect(input).toHaveValue('not-an-address');
    await expect(attendeeRows(dialog)).toHaveCount(3);

    // A comma ends an address as it is typed.
    await input.fill('');
    await input.pressSequentially('c@example.org,');
    await expect(attendeeRows(dialog)).toHaveCount(4);
    await expect(input).toHaveValue('');
  });

  test('Save includes an attendee typed but not added', async ({ page }) => {
    const posts = [];
    await openCalendar(page, posts);
    const { dialog, input } = await openAttendees(page);
    await dialog.getByLabel('Title').fill('Planning');
    await input.fill('late@example.org');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => posts.join('\n')).toContain('late@example.org');
  });

  test('an attendee typed in a cancelled dialog is not added to the next event', async ({
    page,
  }) => {
    const posts = [];
    await openCalendar(page, posts);
    let { dialog, input } = await openAttendees(page);
    await input.fill('left-behind@example.org');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();

    ({ dialog, input } = await openAttendees(page));
    await expect(input).toHaveValue('');
    await dialog.getByLabel('Title').fill('Another');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).not.toContain('left-behind@example.org');
  });

  test('Save stops on an attendee that is not an address', async ({ page }) => {
    const posts = [];
    await openCalendar(page, posts);
    const { dialog, input } = await openAttendees(page);
    await dialog.getByLabel('Title').fill('Planning');
    await input.fill('riley');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('riley');
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    expect(posts).toEqual([]);
  });
});

// Shrinks the visual viewport the way an on-screen keyboard does on iOS and
// on Android Chrome 108+, where the layout viewport stays full height.
async function showKeyboard(page, visibleHeight) {
  await page.evaluate((height) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => height });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, visibleHeight);
}

for (const size of [
  { name: 'small phone 320x568', width: 320, height: 568 },
  { name: 'phone 390x844', width: 390, height: 844 },
  { name: 'phone landscape 844x390', width: 844, height: 390 },
  { name: 'tablet 768x1024', width: 768, height: 1024 },
]) {
  test.describe(`dialogs above the keyboard at ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: true,
      isMobile: true,
    });

    test('the dialog, the focused field and Save stay in the visible area', async ({ page }) => {
      await openCalendar(page);
      const { dialog, input } = await openAttendees(page);
      // A title, so Save is enabled (a disabled button takes no taps).
      await dialog.getByLabel('Title').fill('Planning');
      await input.tap();
      const visible = Math.round(size.height * (size.width > size.height ? 0.45 : 0.55));
      await showKeyboard(page, visible);

      await expect
        .poll(async () => {
          const box = await dialog.boundingBox();
          return box.y >= -1 && box.y + box.height <= visible + 1;
        })
        .toBe(true);
      // The focused field is in view.
      await expect
        .poll(async () => {
          const field = await input.boundingBox();
          return field.y >= 0 && field.y + field.height <= visible + 1;
        })
        .toBe(true);
      // Save is reachable inside the dialog and nothing covers it.
      const save = dialog.getByRole('button', { name: 'Save', exact: true });
      await save.scrollIntoViewIfNeeded();
      const reachable = await save.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return button.contains(hit) && rect.bottom <= window.visualViewport.height + 1;
      });
      expect(reachable).toBe(true);
    });
  });
}
