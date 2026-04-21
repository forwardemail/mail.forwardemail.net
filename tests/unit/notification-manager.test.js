/**
 * Notification Manager – componentType-aware label tests
 *
 * Verifies that calendar notifications use "Task" for VTODO
 * and "Event" for VEVENT (or when componentType is absent).
 */

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  notify: vi.fn(() => Promise.resolve()),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));

vi.mock('../../src/utils/tauri-bridge.js', () => ({
  setBadgeCount: vi.fn(),
}));

vi.mock('../../src/utils/favicon-badge.js', () => ({
  updateFaviconBadge: vi.fn(),
}));

vi.mock('../../src/utils/remote.js', () => ({
  Remote: { request: vi.fn() },
}));

vi.mock('../../src/utils/sync-helpers.ts', () => ({
  extractFromField: vi.fn(() => ''),
}));

vi.mock('../../src/utils/websocket-client', () => ({
  WS_EVENTS: {
    NEW_MESSAGE: 'newMessage',
    MESSAGES_MOVED: 'messagesMoved',
    MESSAGES_COPIED: 'messagesCopied',
    FLAGS_UPDATED: 'flagsUpdated',
    MESSAGES_EXPUNGED: 'messagesExpunged',
    MAILBOX_CREATED: 'mailboxCreated',
    MAILBOX_DELETED: 'mailboxDeleted',
    MAILBOX_RENAMED: 'mailboxRenamed',
    CALENDAR_CREATED: 'calendarCreated',
    CALENDAR_UPDATED: 'calendarUpdated',
    CALENDAR_DELETED: 'calendarDeleted',
    CALENDAR_EVENT_CREATED: 'calendarEventCreated',
    CALENDAR_EVENT_UPDATED: 'calendarEventUpdated',
    CALENDAR_EVENT_DELETED: 'calendarEventDeleted',
    ADDRESS_BOOK_CREATED: 'addressBookCreated',
    ADDRESS_BOOK_DELETED: 'addressBookDeleted',
    CONTACT_CREATED: 'contactCreated',
    CONTACT_UPDATED: 'contactUpdated',
    CONTACT_DELETED: 'contactDeleted',
    NEW_RELEASE: 'newRelease',
  },
}));

import { notify } from '../../src/utils/notification-bridge.js';
import {
  connectNotifications,
  requestNotificationPermission,
} from '../../src/utils/notification-manager.js';

// ── Helpers ───────────────────────────────────────────────────────────────

// Capture event handlers registered via connectNotifications
function createMockWsClient() {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return vi.fn(); // unsub
    }),
    handlers,
    emit(event, data) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) fn(data);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('notification-manager calendar labels', () => {
  let wsClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Grant notification permission
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    connectNotifications(wsClient);
  });

  it('shows "Calendar Task Created" for VTODO componentType', async () => {
    wsClient.emit('calendarEventCreated', {
      id: 'todo-001',
      summary: 'Buy groceries',
      componentType: 'VTODO',
    });

    // Wait for async showNotification
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Task Created');
    expect(call.body).toContain('Buy groceries');
  });

  it('shows "Calendar Event Created" for VEVENT componentType', async () => {
    wsClient.emit('calendarEventCreated', {
      id: 'evt-001',
      summary: 'Team Meeting',
      componentType: 'VEVENT',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Event Created');
    expect(call.body).toContain('Team Meeting');
  });

  it('defaults to "Calendar Event Created" when componentType is absent', async () => {
    wsClient.emit('calendarEventCreated', {
      id: 'evt-002',
      summary: 'Lunch',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Event Created');
  });

  it('shows "Calendar Task Updated" for VTODO componentType', async () => {
    wsClient.emit('calendarEventUpdated', {
      id: 'todo-002',
      summary: 'Buy groceries (updated)',
      componentType: 'VTODO',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Task Updated');
    expect(call.body).toContain('Buy groceries (updated)');
  });

  it('shows "Calendar Event Updated" for VEVENT componentType', async () => {
    wsClient.emit('calendarEventUpdated', {
      id: 'evt-003',
      summary: 'Team Meeting (rescheduled)',
      componentType: 'VEVENT',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Event Updated');
    expect(call.body).toContain('Team Meeting (rescheduled)');
  });

  it('defaults to "Calendar Event Updated" when componentType is absent', async () => {
    wsClient.emit('calendarEventUpdated', {
      id: 'evt-004',
      summary: 'Some event',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Event Updated');
  });

  it('uses "New task" as default body for VTODO without summary', async () => {
    wsClient.emit('calendarEventCreated', {
      id: 'todo-003',
      componentType: 'VTODO',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Task Created');
    expect(call.body).toContain('New task');
  });

  it('uses "New event" as default body for VEVENT without summary', async () => {
    wsClient.emit('calendarEventCreated', {
      id: 'evt-005',
      componentType: 'VEVENT',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Event Created');
    expect(call.body).toContain('New event');
  });

  it('uses "Task updated" as default body for VTODO update without summary', async () => {
    wsClient.emit('calendarEventUpdated', {
      id: 'todo-004',
      componentType: 'VTODO',
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.title).toBe('Calendar Task Updated');
    expect(call.body).toContain('Task updated');
  });
});

describe('notification-manager new message routing payloads', () => {
  let wsClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    connectNotifications(wsClient);
  });

  it('includes both a mailbox hash path and a Forward Email deep-link URL', async () => {
    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: {
        id: 42,
        uid: 42,
        subject: 'Quarterly update',
        from: {
          text: 'Alice Example <alice@example.com>',
        },
      },
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const call = vi.mocked(notify).mock.calls[0][0];
    expect(call.data.path).toBe('#inbox/42');
    expect(call.data.url).toBe('forwardemail://mailbox#inbox/42');
    expect(call.title).toContain('Alice Example');
  });
});
