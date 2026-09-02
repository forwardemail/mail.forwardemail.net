import {
  mockCalendars,
  mockContacts,
  mockEvents,
  mockFolders,
  mockMessageBodies,
  mockMessages,
} from '../fixtures/mockData.js';

const jsonResponse = (route, payload, status = 200, headers = {}) =>
  route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

const paginateItems = (items, url, fallbackLimit = items.length || 1) => {
  const page = Number(url.searchParams.get('page') || '1');
  const limit = Number(url.searchParams.get('limit') || String(fallbackLimit));
  const start = Math.max(page - 1, 0) * limit;
  const end = start + limit;
  return items.slice(start, end);
};

export async function mockApi(page, overrides = {}) {
  const folders = structuredClone(overrides.folders || mockFolders);
  const messages = structuredClone(overrides.messages || mockMessages);
  const messageBodies = structuredClone(overrides.messageBodies || mockMessageBodies);
  const contacts = structuredClone(overrides.contacts || mockContacts);
  const calendars = structuredClone(overrides.calendars || mockCalendars);
  const events = structuredClone(overrides.events || mockEvents);

  // Nothing may escape to the real API. The seeded session uses fake
  // credentials, so any request that fell through came back as a genuine
  // 401 from api.forwardemail.net; three of those trip the app's
  // fe:auth-expired interception and it signs the test out mid-flow, with
  // real network latency deciding which test gets hit. Playwright consults
  // routes newest-first, so this catch-all is registered before the
  // specific handlers below and only sees what they don't claim. A 404
  // keeps an unmocked endpoint loud without looking like an auth failure.
  await page.route('**/v1/**', (route) =>
    jsonResponse(route, { message: `e2e mock: ${route.request().url()} is not mocked` }, 404),
  );

  // Boot-time calls the app always makes; shapes mirror the demo interceptor.
  await page.route('**/v1/account**', (route) => {
    if (route.request().method() === 'GET') {
      return jsonResponse(route, {
        id: 'e2e-account-id',
        email: 'test@example.com',
        plan: 'enhanced-protection',
        storage_used: 15728640,
        storage_quota: 10737418240,
        locale: 'en',
        timezone: 'UTC',
      });
    }
    return jsonResponse(route, { Result: { success: true } });
  });
  await page.route('**/v1/labels**', (route) => jsonResponse(route, []));

  await page.route('**/v1/folders**', (route) => jsonResponse(route, { Result: folders }));

  await page.route('**/v1/messages**', (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const parts = url.pathname.split('/').filter(Boolean);
    const maybeId = parts[parts.length - 1];
    const isDetail = parts.length > 2;

    if (method === 'GET' && isDetail) {
      const body = messageBodies[maybeId] || { html: '<p>Mock message</p>', attachments: [] };
      return jsonResponse(route, { Result: body });
    }

    if (method === 'GET') {
      return jsonResponse(route, { Result: messages });
    }

    // PUT/DELETE etc. just acknowledge
    return jsonResponse(route, { Result: { success: true } });
  });

  await page.route('**/v1/contacts**', (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const contactId = parts[parts.length - 1];

    if (method === 'GET') {
      return jsonResponse(route, { Result: paginateItems(contacts, url, contacts.length || 500) });
    }

    if (method === 'POST') {
      const postData = route.request().postDataJSON();
      const newContact = {
        id: `contact-${Date.now()}`,
        full_name: postData.full_name || '',
        emails: postData.emails || [],
        phone_numbers: postData.phone_numbers || [],
        content: postData.content || '',
        ...postData,
      };
      contacts.push(newContact);
      return jsonResponse(route, newContact, 201);
    }

    if (method === 'PUT' && contactId !== 'contacts') {
      const updateData = route.request().postDataJSON();
      const index = contacts.findIndex((c) => c.id === contactId);
      if (index >= 0) {
        contacts[index] = { ...contacts[index], ...updateData };
        return jsonResponse(route, contacts[index]);
      }
      return jsonResponse(route, { error: 'Contact not found' }, 404);
    }

    if (method === 'DELETE' && contactId !== 'contacts') {
      const index = contacts.findIndex((c) => c.id === contactId);
      if (index >= 0) {
        contacts.splice(index, 1);
        return jsonResponse(route, { Result: { success: true } });
      }
      return jsonResponse(route, { error: 'Contact not found' }, 404);
    }

    return jsonResponse(route, { Result: { success: true } });
  });

  await page.route('**/v1/calendars**', (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const calendarId = parts[parts.length - 1];
    const isDetail = parts.length > 2;

    if (method === 'GET' && isDetail && calendarId !== 'calendars') {
      const calendar = calendars.find((c) => c.id === calendarId);
      if (!calendar) return jsonResponse(route, { error: 'Calendar not found' }, 404);
      return jsonResponse(route, { Result: calendar });
    }

    if (method === 'GET') {
      return jsonResponse(route, { Result: paginateItems(calendars, url, calendars.length || 50) });
    }

    if (method === 'POST') {
      const postData = route.request().postDataJSON();
      const newCalendar = {
        id: postData.calendar_id || `calendar-${Date.now()}`,
        name: postData.name || 'New Calendar',
        color: postData.color || '#1c7ed6',
        description: postData.description || '',
        timezone: postData.timezone || 'UTC',
        ...postData,
      };
      calendars.push(newCalendar);
      return jsonResponse(route, { Result: newCalendar }, 201);
    }

    if (method === 'PUT' && isDetail && calendarId !== 'calendars') {
      const updateData = route.request().postDataJSON();
      const index = calendars.findIndex((c) => c.id === calendarId);
      if (index >= 0) {
        calendars[index] = { ...calendars[index], ...updateData };
        return jsonResponse(route, { Result: calendars[index] });
      }
      return jsonResponse(route, { error: 'Calendar not found' }, 404);
    }

    if (method === 'DELETE' && isDetail && calendarId !== 'calendars') {
      const index = calendars.findIndex((c) => c.id === calendarId);
      if (index >= 0) {
        calendars.splice(index, 1);
        return jsonResponse(route, { Result: { success: true } });
      }
      return jsonResponse(route, { error: 'Calendar not found' }, 404);
    }

    return jsonResponse(route, { Result: { success: true } });
  });
  await page.route('**/v1/calendar-events**', (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const eventId = parts[parts.length - 1];

    if (method === 'GET') {
      const calendarId = url.searchParams.get('calendar_id') || '';
      const scopedEvents = calendarId
        ? events.filter((event) => event.calendar_id === calendarId)
        : events;
      return jsonResponse(route, {
        Result: paginateItems(scopedEvents, url, scopedEvents.length || 500),
      });
    }

    if (method === 'POST') {
      const postData = route.request().postDataJSON();
      const newEvent = {
        id: `evt-${Date.now()}`,
        uid: `evt-${Date.now()}`,
        calendar_id: postData.calendar_id || 'default',
        summary: 'New Event',
        title: 'New Event',
        start: new Date().toISOString(),
        end: new Date(Date.now() + 3600000).toISOString(),
        start_date: new Date().toISOString(),
        end_date: new Date(Date.now() + 3600000).toISOString(),
        dtstart: new Date().toISOString(),
        dtend: new Date(Date.now() + 3600000).toISOString(),
        description: '',
        location: '',
        url: '',
        timezone: '',
        attendees: '',
        notify: 0,
        reminder: 0,
        ...postData,
      };
      events.push(newEvent);
      return jsonResponse(route, { Result: newEvent }, 201);
    }

    if (method === 'PUT' && eventId !== 'calendar-events') {
      const updateData = route.request().postDataJSON();
      const index = events.findIndex((e) => e.id === eventId || e.uid === eventId);
      if (index >= 0) {
        events[index] = { ...events[index], ...updateData };
        return jsonResponse(route, { Result: events[index] });
      }
      return jsonResponse(route, { error: 'Event not found' }, 404);
    }

    if (method === 'DELETE' && eventId !== 'calendar-events') {
      const index = events.findIndex((e) => e.id === eventId || e.uid === eventId);
      if (index >= 0) {
        events.splice(index, 1);
        return jsonResponse(route, { Result: { success: true } });
      }
      return jsonResponse(route, { error: 'Event not found' }, 404);
    }

    return jsonResponse(route, { Result: { success: true } });
  });

  // Non-API requests (the app itself, fonts, workers) still pass through to
  // the preview server; only /v1/** is fenced off above.
}
