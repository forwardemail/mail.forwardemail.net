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
      return jsonResponse(route, { Result: newContact }, 201);
    }

    if (method === 'PUT' && contactId !== 'contacts') {
      const updateData = route.request().postDataJSON();
      const index = contacts.findIndex((c) => c.id === contactId);
      if (index >= 0) {
        contacts[index] = { ...contacts[index], ...updateData };
        return jsonResponse(route, { Result: contacts[index] });
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
    const url = new URL(route.request().url());
    return jsonResponse(route, { Result: paginateItems(calendars, url, calendars.length || 50) });
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

  // No catch-all needed; unhandled requests will pass through by default.
}
