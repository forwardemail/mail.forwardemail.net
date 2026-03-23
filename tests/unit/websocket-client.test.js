import { describe, it, expect } from 'vitest';
import { WS_EVENTS } from '../../src/utils/websocket-client.js';

/**
 * Tests for the WebSocket client event constants.
 *
 * The Forward Email WebSocket API defines 20 distinct event types.
 * These tests ensure the client-side WS_EVENTS map stays in sync
 * with the server API specification.
 */

// The canonical list of all 21 events from the server API.
// Source: https://forwardemail.net/en/email-api#tag/websockets
const API_EVENTS = {
  // IMAP (8)
  newMessage: 'newMessage',
  messagesMoved: 'messagesMoved',
  messagesCopied: 'messagesCopied',
  flagsUpdated: 'flagsUpdated',
  messagesExpunged: 'messagesExpunged',
  mailboxCreated: 'mailboxCreated',
  mailboxDeleted: 'mailboxDeleted',
  mailboxRenamed: 'mailboxRenamed',
  // CalDAV (6)
  calendarCreated: 'calendarCreated',
  calendarUpdated: 'calendarUpdated',
  calendarDeleted: 'calendarDeleted',
  calendarEventCreated: 'calendarEventCreated',
  calendarEventUpdated: 'calendarEventUpdated',
  calendarEventDeleted: 'calendarEventDeleted',
  // CardDAV (5)
  contactCreated: 'contactCreated',
  contactUpdated: 'contactUpdated',
  contactDeleted: 'contactDeleted',
  addressBookCreated: 'addressBookCreated',
  addressBookDeleted: 'addressBookDeleted',
  // Broadcast (1)
  newRelease: 'newRelease',
};

describe('WS_EVENTS', () => {
  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(WS_EVENTS)).toBe(true);
  });

  it('contains exactly 20 event types', () => {
    expect(Object.keys(WS_EVENTS)).toHaveLength(20);
  });

  it('includes all 8 IMAP events', () => {
    expect(WS_EVENTS.NEW_MESSAGE).toBe('newMessage');
    expect(WS_EVENTS.MESSAGES_MOVED).toBe('messagesMoved');
    expect(WS_EVENTS.MESSAGES_COPIED).toBe('messagesCopied');
    expect(WS_EVENTS.FLAGS_UPDATED).toBe('flagsUpdated');
    expect(WS_EVENTS.MESSAGES_EXPUNGED).toBe('messagesExpunged');
    expect(WS_EVENTS.MAILBOX_CREATED).toBe('mailboxCreated');
    expect(WS_EVENTS.MAILBOX_DELETED).toBe('mailboxDeleted');
    expect(WS_EVENTS.MAILBOX_RENAMED).toBe('mailboxRenamed');
  });

  it('includes all 6 CalDAV events', () => {
    expect(WS_EVENTS.CALENDAR_CREATED).toBe('calendarCreated');
    expect(WS_EVENTS.CALENDAR_UPDATED).toBe('calendarUpdated');
    expect(WS_EVENTS.CALENDAR_DELETED).toBe('calendarDeleted');
    expect(WS_EVENTS.CALENDAR_EVENT_CREATED).toBe('calendarEventCreated');
    expect(WS_EVENTS.CALENDAR_EVENT_UPDATED).toBe('calendarEventUpdated');
    expect(WS_EVENTS.CALENDAR_EVENT_DELETED).toBe('calendarEventDeleted');
  });

  it('includes all 5 CardDAV events', () => {
    expect(WS_EVENTS.ADDRESS_BOOK_CREATED).toBe('addressBookCreated');
    expect(WS_EVENTS.ADDRESS_BOOK_DELETED).toBe('addressBookDeleted');
    expect(WS_EVENTS.CONTACT_CREATED).toBe('contactCreated');
    expect(WS_EVENTS.CONTACT_UPDATED).toBe('contactUpdated');
    expect(WS_EVENTS.CONTACT_DELETED).toBe('contactDeleted');
  });

  it('includes the broadcast newRelease event', () => {
    expect(WS_EVENTS.NEW_RELEASE).toBe('newRelease');
  });

  it('has values matching every event in the server API specification', () => {
    const clientValues = new Set(Object.values(WS_EVENTS));
    for (const [, value] of Object.entries(API_EVENTS)) {
      expect(clientValues.has(value)).toBe(true);
    }
  });

  it('does not contain any events not in the server API specification', () => {
    const apiValues = new Set(Object.values(API_EVENTS));
    for (const value of Object.values(WS_EVENTS)) {
      expect(apiValues.has(value)).toBe(true);
    }
  });
});
