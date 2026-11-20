/**
 * The invitation card on a message, for an account on a custom mail server.
 *
 * That account has no calendar in this app: the calendar is Forward Email's
 * API. The card must still show the event and answer the organizer, and it
 * must not ask the Forward Email API for anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const h = vi.hoisted(() => ({
  remoteRequest: vi.fn(),
  queueEmail: vi.fn(),
  downloadFile: vi.fn(),
  metaGet: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? 'me@example.org' : null) },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/db', () => ({
  db: { meta: { get: (...a: unknown[]) => h.metaGet(...a), put: vi.fn() } },
}));
vi.mock('../../src/utils/outbox-service', () => ({
  queueEmail: (...a: unknown[]) => h.queueEmail(...a),
}));
vi.mock('../../src/utils/download', () => ({
  downloadFile: (...a: unknown[]) => h.downloadFile(...a),
}));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoBlockedError: () => false }));

import CalendarInviteCard from '../../src/svelte/components/CalendarInviteCard.svelte';
import { parseIcs } from '../../src/utils/ics-parser';

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example Corp//Calendar//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:quarterly-review-2026@example.com',
  'DTSTAMP:20261110T090000Z',
  'DTSTART:20261203T150000Z',
  'DTEND:20261203T160000Z',
  'SUMMARY:Quarterly review',
  'LOCATION:Room 4',
  'ORGANIZER;CN=Dana Whitfield:mailto:dana@example.com',
  'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.org',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

let card: ReturnType<typeof mount> | null = null;
const show = async (calendar: boolean) => {
  const invite = parseIcs(ICS);
  if (!invite) throw new Error('the fixture did not parse');
  card = mount(CalendarInviteCard, { target: document.body, props: { invite, calendar } });
  for (let i = 0; i < 5; i += 1) await tick();
  flushSync();
  return invite;
};
const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await tick();
  flushSync();
};

beforeEach(() => {
  h.remoteRequest.mockReset().mockResolvedValue([]);
  h.queueEmail.mockReset().mockResolvedValue({ id: 'outbox_1' });
  h.downloadFile.mockReset().mockReturnValue(true);
  h.metaGet.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (card) unmount(card);
  card = null;
  document.body.innerHTML = '';
});

describe('with no calendar for the account', () => {
  it('shows the event without asking the Forward Email API', async () => {
    await show(false);

    expect(document.body.textContent).toContain('Quarterly review');
    expect(document.body.textContent).toContain('Room 4');
    expect(button('Add to calendar')).toBeUndefined();
    expect(h.remoteRequest).not.toHaveBeenCalled();
    expect(h.metaGet).not.toHaveBeenCalled();
  });

  it('offers the event as a file for the user’s own calendar app', async () => {
    const invite = await show(false);
    button('Save event file (.ics)')?.click();
    await settle();

    expect(h.downloadFile).toHaveBeenCalledWith(
      invite.raw,
      'Quarterly_review.ics',
      'text/calendar',
    );
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('answers the organizer by email, from the account’s own address', async () => {
    await show(false);
    button('Yes')?.click();
    await settle();

    expect(h.queueEmail).toHaveBeenCalledTimes(1);
    const [email] = h.queueEmail.mock.calls[0] as [Record<string, unknown>];
    expect(email).toMatchObject({
      from: 'me@example.org',
      to: ['dana@example.com'],
      subject: 'Accepted: Quarterly review',
    });
    const [reply] = email.attachments as Array<{ content: string; contentType: string }>;
    expect(reply.contentType).toContain('method=REPLY');
    const ics = atob(reply.content);
    expect(ics).toContain('METHOD:REPLY');
    expect(ics).toMatch(/ATTENDEE[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*me@example\.org/i);
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });
});

describe('with a calendar (a Forward Email account)', () => {
  it('still offers to add the event, and loads the calendar list for it', async () => {
    await show(true);
    expect(button('Add to calendar')).toBeDefined();
    expect(button('Save event file (.ics)')).toBeUndefined();
    expect(h.remoteRequest).toHaveBeenCalledWith('Calendars', {});
  });
});
