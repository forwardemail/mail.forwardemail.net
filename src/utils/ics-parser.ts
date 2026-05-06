import ICAL from 'ical.js';

export interface InviteAttendee {
  name?: string;
  email: string;
  partstat?: string;
  role?: string;
  rsvp?: boolean;
}

export interface InviteOrganizer {
  name?: string;
  email?: string;
}

export interface ParsedInvite {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  organizer: InviteOrganizer | null;
  attendees: InviteAttendee[];
  startDate: Date | null;
  endDate: Date | null;
  allDay: boolean;
  method: string;
  recurrence: string | null;
  raw: string;
}

const stripMailto = (value: unknown): string => {
  const s = typeof value === 'string' ? value : '';
  return s.replace(/^mailto:/i, '').trim();
};

const readPersonProperty = (
  prop: ICAL.Property | null | undefined,
): { name?: string; email: string } | null => {
  if (!prop) return null;
  const email = stripMailto(prop.getFirstValue());
  if (!email) return null;
  const name = (prop.getParameter('cn') as string | undefined) || undefined;
  return name ? { name, email } : { email };
};

const decodeDataUrlIcs = (href: string): string | null => {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(href);
  if (!match) return null;
  const [, , base64Flag, payload] = match;
  try {
    if (base64Flag) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
};

export const isCalendarAttachment = (att: {
  contentType?: string;
  filename?: string;
  name?: string;
}): boolean => {
  const ct = (att.contentType || '').toLowerCase();
  if (ct.startsWith('text/calendar') || ct.includes('application/ics')) return true;
  const filename = (att.filename || att.name || '').toLowerCase();
  return filename.endsWith('.ics') || filename.endsWith('.ical') || filename.endsWith('.ifb');
};

export const fetchAttachmentText = async (href: string): Promise<string | null> => {
  if (!href) return null;
  if (href.startsWith('data:')) return decodeDataUrlIcs(href);
  try {
    const res = await fetch(href);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
};

export const parseIcs = (ics: string): ParsedInvite | null => {
  if (!ics || typeof ics !== 'string') return null;
  let comp: ICAL.Component;
  try {
    const jcal = ICAL.parse(ics);
    comp = new ICAL.Component(jcal);
  } catch {
    return null;
  }

  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return null;

  let event: ICAL.Event;
  try {
    event = new ICAL.Event(vevent);
  } catch {
    return null;
  }

  const organizer = readPersonProperty(vevent.getFirstProperty('organizer'));

  const attendees: InviteAttendee[] = vevent.getAllProperties('attendee').map((prop) => {
    const email = stripMailto(prop.getFirstValue());
    const name = (prop.getParameter('cn') as string | undefined) || undefined;
    const partstat = (prop.getParameter('partstat') as string | undefined) || undefined;
    const role = (prop.getParameter('role') as string | undefined) || undefined;
    const rsvpRaw = prop.getParameter('rsvp');
    const rsvp = typeof rsvpRaw === 'string' ? rsvpRaw.toUpperCase() === 'TRUE' : undefined;
    const a: InviteAttendee = { email };
    if (name) a.name = name;
    if (partstat) a.partstat = partstat;
    if (role) a.role = role;
    if (typeof rsvp === 'boolean') a.rsvp = rsvp;
    return a;
  });

  const startTime = event.startDate || null;
  const endTime = event.endDate || null;
  const startDate = startTime ? startTime.toJSDate() : null;
  const endDate = endTime ? endTime.toJSDate() : null;
  const allDay = !!(startTime && startTime.isDate);

  const rrule = vevent.getFirstPropertyValue('rrule');
  const recurrence = rrule ? rrule.toString() : null;

  const method = (comp.getFirstPropertyValue('method') as string) || '';

  return {
    uid: (event.uid as string) || '',
    summary: (event.summary as string) || '',
    description: (event.description as string) || '',
    location: (event.location as string) || '',
    url: (vevent.getFirstPropertyValue('url') as string) || '',
    organizer,
    attendees,
    startDate,
    endDate,
    allDay,
    method: method.toUpperCase(),
    recurrence,
    raw: ics,
  };
};

const VIDEO_CONFERENCE_HOSTS = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'zoom.us',
  'zoom.com',
  'webex.com',
  'gotomeeting.com',
  'whereby.com',
  'jit.si',
  'meet.jit.si',
];

const isVideoConferenceUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    return VIDEO_CONFERENCE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
};

export const normalizeIcsForCalendar = (ics: string): string => {
  let cal: ICAL.Component;
  try {
    cal = new ICAL.Component(ICAL.parse(ics));
  } catch {
    return ics
      .replace(/^METHOD:[^\r\n]*\r?\n?/im, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '\r\n');
  }

  const methodProp = cal.getFirstProperty('method');
  if (methodProp) cal.removeProperty(methodProp);

  cal.getAllSubcomponents('vevent').forEach((vevent) => {
    const locationProp = vevent.getFirstProperty('location');
    const urlProp = vevent.getFirstProperty('url');
    if (locationProp && !urlProp) {
      const loc = locationProp.getFirstValue();
      if (isVideoConferenceUrl(loc)) {
        vevent.addPropertyWithValue('url', String(loc).trim());
        vevent.removeProperty(locationProp);
      }
    }
  });

  return cal.toString();
};

export type RsvpStatus = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';

const findUserAttendee = (invite: ParsedInvite, userEmail: string): InviteAttendee | undefined => {
  const target = userEmail.toLowerCase();
  return invite.attendees.find((a) => (a.email || '').toLowerCase() === target);
};

export const buildReplyIcs = (
  invite: ParsedInvite,
  userEmail: string,
  partstat: RsvpStatus,
): string => {
  if (!invite?.raw || !userEmail) return '';
  const jcal = ICAL.parse(invite.raw);
  const cal = new ICAL.Component(jcal);

  const methodProp = cal.getFirstProperty('method');
  if (methodProp) methodProp.setValue('REPLY');
  else cal.addPropertyWithValue('method', 'REPLY');

  const vevent = cal.getFirstSubcomponent('vevent');
  if (!vevent) return '';

  vevent.getAllProperties('attendee').forEach((p) => vevent.removeProperty(p));
  ['description', 'attach', 'x-alt-desc', 'valarm'].forEach((name) => {
    vevent.getAllProperties(name).forEach((p) => vevent.removeProperty(p));
  });
  vevent.getAllSubcomponents('valarm').forEach((sub) => vevent.removeSubcomponent(sub));

  const attendeeProp = new ICAL.Property('attendee', vevent);
  attendeeProp.setParameter('partstat', partstat);
  const matched = findUserAttendee(invite, userEmail);
  if (matched?.name) attendeeProp.setParameter('cn', matched.name);
  attendeeProp.setValue(`mailto:${userEmail}`);
  vevent.addProperty(attendeeProp);

  const dtstamp = ICAL.Time.fromJSDate(new Date(), true);
  const dtstampProp = vevent.getFirstProperty('dtstamp');
  if (dtstampProp) dtstampProp.setValue(dtstamp);
  else vevent.addPropertyWithValue('dtstamp', dtstamp);

  return cal.toString();
};

export const findMatchingCachedEvent = (
  invite: ParsedInvite,
  cachedEvents: Array<Record<string, unknown>>,
): Record<string, unknown> | null => {
  if (!invite.uid || !Array.isArray(cachedEvents)) return null;
  const target = invite.uid.toLowerCase();
  return (
    cachedEvents.find((ev) => {
      const candidates = [
        ev.uid,
        ev.UID,
        ev.id,
        ev.event_id,
        (ev.raw as Record<string, unknown>)?.uid,
        (ev.raw as Record<string, unknown>)?.UID,
        (ev.raw as Record<string, unknown>)?.id,
      ];
      return candidates.some((c) => typeof c === 'string' && c.toLowerCase() === target);
    }) || null
  );
};

export const findConflictingEvents = (
  invite: ParsedInvite,
  cachedEvents: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  if (!invite.startDate || !invite.endDate || !Array.isArray(cachedEvents)) return [];
  const inviteStart = invite.startDate.getTime();
  const inviteEnd = invite.endDate.getTime();
  if (!Number.isFinite(inviteStart) || !Number.isFinite(inviteEnd)) return [];
  const target = (invite.uid || '').toLowerCase();
  return cachedEvents.filter((ev) => {
    const uid = (ev.uid as string) || '';
    if (typeof uid === 'string' && uid.toLowerCase() === target) return false;
    const startRaw = (ev.start || ev.startDate || ev.dtstart) as string | number | Date | undefined;
    const endRaw = (ev.end || ev.endDate || ev.dtend) as string | number | Date | undefined;
    const start = startRaw ? new Date(startRaw).getTime() : NaN;
    const end = endRaw ? new Date(endRaw).getTime() : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return start < inviteEnd && end > inviteStart;
  });
};
