<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Readable, Unsubscriber } from 'svelte/store';
  import { ScheduleXCalendar } from '@schedule-x/svelte';
  import { createCalendar, viewDay, viewMonthGrid, viewWeek } from '@schedule-x/calendar';
  import '@schedule-x/theme-default/dist/index.css';
  import { Local } from '../utils/storage';
  import { Remote } from '../utils/remote';
  import { db } from '../utils/db';
  import { normalizeEmail } from '../utils/address';
  import { queueEmail } from '../utils/outbox-service';
  import { effectiveTheme } from '../stores/settingsStore';
  import { currentAccount } from '../stores/mailboxActions';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Alert from '$lib/components/ui/alert';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Select from '$lib/components/ui/select';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Separator } from '$lib/components/ui/separator';

  interface ToastApi {
    show?: (message: string, type?: string) => void;
  }

  interface CalendarApi {
    open?: () => void;
    refresh?: () => void;
  }

  interface Props {
    navigate?: (path: string) => void;
    toasts?: ToastApi | null;
    registerApi?: (api: CalendarApi) => void;
    active?: boolean | Readable<boolean>;
  }

  let { navigate = () => {}, toasts = null, registerApi = () => {}, active = false }: Props = $props();

  // Handle active as either a boolean or a store
  let isActive = $state(typeof active === 'boolean' ? active : false);
  let activeUnsub: Unsubscriber | null = null;
  let accountUnsub: Unsubscriber | null = null;

  onMount(() => {
    if (active && typeof active === 'object' && 'subscribe' in active) {
      activeUnsub = active.subscribe((val: boolean) => { isActive = val; });
    }

    // Account change subscription (replaced $effect to avoid loops)
    accountUnsub = currentAccount.subscribe((acct) => {
      if (acct !== lastAccount) {
        lastAccount = acct || '';
        resetCalendarState();
        if (hasMounted && isActive) {
          load(true);
        }
      }
    });
  });

  onDestroy(() => {
    activeUnsub?.();
    accountUnsub?.();
  });

  let loading = $state(false);
  let error = $state('');
  let calendars = $state<unknown[]>([]);
  let selectedCalendarIds = $state<string[]>([]);
  let activeCalendarId = $state('');
  let events = $state<unknown[]>([]);
  let allEvents = $state<unknown[]>([]);
  let eventsScope = $state('none');
  let eventsScopeCalendarId = $state('');
  let calendarInstance = $state<ReturnType<typeof createCalendar> | null>(null);
  let hasMounted = $state(false);
  let calendarsLoaded = $state(false);
  let lastAccount = Local.get('email') || '';
  let loadRequestId = 0;
  let prefersDark = $state(false);
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

  const MOBILE_BREAKPOINT = 768;
  const isMobile = $derived(viewportWidth <= MOBILE_BREAKPOINT);

  // On mobile, show all calendars; on desktop, use the user's selection
  const effectiveSelectedCalendarIds = $derived(
    isMobile ? calendars.map((c) => getCalendarId(c)).filter(Boolean) as string[] : selectedCalendarIds
  );

  const theme = $derived($effectiveTheme || 'system');
  const calendarIsDark = $derived(theme === 'dark' || (theme === 'system' && prefersDark));
  const activeEmail = $derived($currentAccount || Local.get('email') || '');
  const calendarFilterLabel = $derived(
    calendars.length > 1
      ? `Calendars (${selectedCalendarIds.length}/${calendars.length})`
      : 'Calendar');

  const getAccountKey = () => $currentAccount || Local.get('email') || 'default';
  const getActiveFromAddress = () => {
    const aliasAuth = Local.get('alias_auth') || '';
    const aliasEmail = aliasAuth.includes(':') ? aliasAuth.split(':')[0] : aliasAuth;
    return aliasEmail || activeEmail || Local.get('email') || '';
  };
  const getCalendarsCacheKey = (accountKey: string) => `calendars_${accountKey}`;
  const getEventsCacheKey = (accountKey: string, calendarId: string) =>
    `calendar_events_${accountKey}_${calendarId}`;
  const getAllEventsCacheKey = (accountKey: string) => `calendar_events_${accountKey}_all`;
  const getCalendarPrefsKey = (accountKey: string) => `calendar_prefs_${accountKey}`;
  const getCalendarId = (cal: unknown) => (cal as Record<string, unknown>)?.id || (cal as Record<string, unknown>)?.calendar_id || (cal as Record<string, unknown>)?.uid || '';

  // Map Apple CalDAV internal constants to user-friendly display names
  // These are static variable names that Apple iOS/macOS CalDAV uses internally
  const mapCalendarDisplayName = (name: string): string => {
    if (!name) return 'Calendar';
    if (name === 'DEFAULT_TASK_CALENDAR_NAME') return 'Tasks';
    if (name === 'DEFAULT_CALENDAR_NAME') return 'Calendar';
    return name;
  };

  const getCalendarLabel = (cal: unknown) => {
    const rawName = (cal as Record<string, unknown>)?.name || (cal as Record<string, unknown>)?.displayName || '';
    return mapCalendarDisplayName(String(rawName)) || 'Calendar';
  };

  const normalizeHexColor = (value: unknown) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(lower)) {
      return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`;
    }
    if (/^#[0-9a-f]{6}$/.test(lower)) return lower;
    if (/^[0-9a-f]{3}$/.test(lower)) {
      return `#${lower[0]}${lower[0]}${lower[1]}${lower[1]}${lower[2]}${lower[2]}`;
    }
    if (/^[0-9a-f]{6}$/.test(lower)) return `#${lower}`;
    return '';
  };

  const blendHex = (hex: string, targetHex: string, amount: number) => {
    const parse = (color: string) => ({
      r: parseInt(color.slice(1, 3), 16),
      g: parseInt(color.slice(3, 5), 16),
      b: parseInt(color.slice(5, 7), 16),
    });
    const clamp = (val: number) => Math.max(0, Math.min(255, val));
    const a = parse(hex);
    const b = parse(targetHex);
    const mix = (start: number, end: number) => Math.round(start + (end - start) * amount);
    const toHex = (val: number) => clamp(val).toString(16).padStart(2, '0');
    return `#${toHex(mix(a.r, b.r))}${toHex(mix(a.g, b.g))}${toHex(mix(a.b, b.b))}`;
  };

  const calendarColorPalette = ['#1c7ed6', '#f59f00', '#d6336c', '#2f9e44', '#5f3dc4', '#0ca678'];
  const resolveCalendarColor = (cal: unknown, index: number) =>
    normalizeHexColor((cal as Record<string, unknown>)?.color) || calendarColorPalette[index % calendarColorPalette.length];

const ensureSafeMutationObserver = () => {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
  if ((MutationObserver.prototype as Record<string, unknown>).__sxSafeObservePatched) return;
  const originalObserve = MutationObserver.prototype.observe;
  MutationObserver.prototype.observe = function (target, options) {
    if (typeof Node === 'undefined' || !(target instanceof Node)) return;
    return originalObserve.call(this, target, options);
  };
  (MutationObserver.prototype as Record<string, unknown>).__sxSafeObservePatched = true;
};

let newEventModal = $state(false);
  let editEventModal = $state(false);
  let showDeleteConfirm = $state(false);
  let showNewStartPicker = $state(false);
  let showNewEndPicker = $state(false);
  let showEditStartPicker = $state(false);
  let showEditEndPicker = $state(false);
  let optionalFieldsExpanded = $state(false);
  let filterMenuOpen = $state(false);
  let modalDirty = $state(false);
  let savingEvent = $state(false);
  let descriptionRef = $state<HTMLTextAreaElement | null>(null);
  let newEventModalRef = $state<HTMLDivElement | null>(null);
  let titleError = $state('');
  let lastDurationMinutes = 60;
  let modalAnnouncement = $state('');

let newEvent = $state({
  calendarId: '',
  title: '',
  date: '',
  startTime: '',
  startMeridiem: 'AM',
  endTime: '',
  endMeridiem: 'AM',
  allDay: false,
  description: '',
  location: '',
  url: '',
  timezone: '',
  attendees: '',
  notify: 0,
});

let editEvent = $state({
  id: '',
  calendarId: '',
  title: '',
  date: '',
  startTime: '',
  startMeridiem: 'AM',
  endTime: '',
  endMeridiem: 'AM',
  allDay: false,
  description: '',
  location: '',
  url: '',
  timezone: '',
  attendees: '',
  notify: 0,
});

const timeOptions = Array.from({ length: 12 * 4 }, (_, idx) => {
  const hour12 = Math.floor(idx / 4) + 1;
  const minute = (idx % 4) * 15;
  const m = String(minute).padStart(2, '0');
  const h = String(hour12).padStart(2, '0');
  return { display: `${hour12}:${m}`, value: `${h}:${m}` };
});

const formatDateTimeLocal = (date: Date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

const to12Hour = (hhmm: string) => {
  if (!hhmm) return { time: '', meridiem: 'AM' };
  const [hStr, m = '00'] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return { time: '', meridiem: 'AM' };
  const meridiem = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const time = `${String(h).padStart(2, '0')}:${m.padStart(2, '0')}`;
  return { time, meridiem };
};

const to24Hour = (hhmm: string, meridiem = 'AM') => {
  if (!hhmm) return '';
  const [hStr, m = '00'] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return '';
  if (meridiem === 'PM' && h < 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m.padStart(2, '0')}`;
};

const isEndAfterStart = (startTime: string, startMeridiem: string, endTime: string, endMeridiem: string) => {
  const start24 = to24Hour(startTime, startMeridiem);
  const end24 = to24Hour(endTime, endMeridiem);
  if (!start24 || !end24) return true;
  const [sh, sm] = start24.split(':').map(Number);
  const [eh, em] = end24.split(':').map(Number);
  return eh * 60 + em > sh * 60 + sm;
};

const getDurationMinutes = (startTime: string, startMeridiem: string, endTime: string, endMeridiem: string) => {
  const start24 = to24Hour(startTime, startMeridiem);
  const end24 = to24Hour(endTime, endMeridiem);
  if (!start24 || !end24) return 60;

  const [sh, sm] = start24.split(':').map(Number);
  const [eh, em] = end24.split(':').map(Number);
  const startMins = sh * 60 + sm;
  let endMins = eh * 60 + em;

  if (endMins <= startMins) {
    endMins += 24 * 60;
  }

  return endMins - startMins;
};

const addMinutesToTime = (hhmm: string, meridiem: string, minutes: number) => {
  const time24 = to24Hour(hhmm, meridiem);
  if (!time24) return { time: hhmm, meridiem };

  const [h, m] = time24.split(':').map(Number);
  let totalMins = h * 60 + m + minutes;

  while (totalMins >= 24 * 60) totalMins -= 24 * 60;
  while (totalMins < 0) totalMins += 24 * 60;

  const newH = Math.floor(totalMins / 60);
  const newM = totalMins % 60;
  const newTime24 = `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;

  return to12Hour(newTime24);
};

const roundTime = (date: Date, intervalMins = 30) => {
  const minutes = date.getMinutes();
  const rounded = Math.round(minutes / intervalMins) * intervalMins;
  const newDate = new Date(date);
  newDate.setMinutes(rounded);
  newDate.setSeconds(0);
  newDate.setMilliseconds(0);
  return newDate;
};

const escapeHtml = (value: string) =>
  (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Sanitize data for Web Worker postMessage (removes non-cloneable properties)
const sanitizeForWorker = <T>(data: T): T => {
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
};

const parseAttendeeEmails = (value: string) => {
  if (!value) return [];
  const rawList = value.split(/[,;]/).map((item) => normalizeEmail(item)).filter(Boolean);
  return Array.from(new Set(rawList));
};

const toBase64 = (value: string) => {
  try {
    return btoa(unescape(encodeURIComponent(value)));
  } catch {
    return btoa(value);
  }
};

const formatInviteDateRange = (start: Date, end: Date, allDay = false) => {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return '';
  if (allDay) {
    return start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const format = (date: Date) =>
    date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) return format(start);
  return `${format(start)} - ${format(end)}`;
};

const buildInviteMessage = (eventDetails: { title?: string; start: Date; end: Date; allDay?: boolean; location?: string; url?: string; description?: string; organizer?: string }) => {
  const { title, start, end, allDay, location, url, description, organizer } = eventDetails;
  const dateRange = formatInviteDateRange(start, end, allDay);
  const safeDescription = (description || '').trim();
  const textLines = [`You are invited to: ${title || 'Event'}`, '', `When: ${dateRange}`];
  if (location) textLines.push(`Where: ${location}`);
  if (url) textLines.push(`URL: ${url}`);
  if (organizer) textLines.push(`Organizer: ${organizer}`);
  if (safeDescription) {
    textLines.push('', 'Notes:', safeDescription);
  }
  textLines.push('', 'This invite includes a calendar attachment (.ics).');

  const htmlLines = [
    `<p>You are invited to: <strong>${escapeHtml(title || 'Event')}</strong></p>`,
    `<p><strong>When:</strong> ${escapeHtml(dateRange)}</p>`,
  ];
  if (location) htmlLines.push(`<p><strong>Where:</strong> ${escapeHtml(location)}</p>`);
  if (url) htmlLines.push(`<p><strong>URL:</strong> ${escapeHtml(url)}</p>`);
  if (organizer) htmlLines.push(`<p><strong>Organizer:</strong> ${escapeHtml(organizer)}</p>`);
  if (safeDescription) {
    const notes = escapeHtml(safeDescription).replace(/\r?\n/g, '<br>');
    htmlLines.push(`<p><strong>Notes:</strong><br>${notes}</p>`);
  }
  htmlLines.push('<p>This invite includes a calendar attachment (.ics).</p>');

  return {
    text: textLines.join('\n'),
    html: htmlLines.join(''),
  };
};

const focusTitleInput = () => {
  setTimeout(() => {
    const input = document.getElementById('event-title') as HTMLInputElement | null;
    input?.focus();
  }, 50);
};

const announceModal = (message: string) => {
  modalAnnouncement = message;
  setTimeout(() => {
    if (modalAnnouncement === message) modalAnnouncement = '';
  }, 1000);
};

const getFocusableElements = (container: HTMLElement | null) => {
  if (!container) return [];
  const focusables = container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(focusables).filter((el) =>
    !el.hasAttribute('aria-hidden') && ((el as HTMLElement).offsetParent !== null || el === document.activeElement)
  );
};

const trapFocus = (event: KeyboardEvent, container: HTMLElement | null) => {
  if (event.key !== 'Tab') return;
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) return;
  const first = focusables[0] as HTMLElement;
  const last = focusables[focusables.length - 1] as HTMLElement;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

const parseNaturalLanguage = (input: string) => {
  if (!input) return null;

  const result: { title: string; date?: string; startTime?: string; startMeridiem?: string; endTime?: string; endMeridiem?: string } = { title: input };

  const tomorrowMatch = input.match(/\btomorrow\b/i);
  const todayMatch = input.match(/\btoday\b/i);

  if (tomorrowMatch) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    result.date = tomorrow.toISOString().split('T')[0];
    result.title = input.replace(/\btomorrow\b/i, '').trim();
  } else if (todayMatch) {
    result.date = new Date().toISOString().split('T')[0];
    result.title = input.replace(/\btoday\b/i, '').trim();
  }

  const timeMatch = input.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);

  if (timeMatch) {
    const [full, h1, m1 = '00', mer1, h2, m2 = '00', mer2] = timeMatch;

    let startH = parseInt(h1, 10);
    const startM = m1;
    let startMer = (mer1 || '').toUpperCase();

    if (!startMer) {
      startMer = startH >= 7 && startH <= 11 ? 'AM' : startH >= 12 ? 'PM' : 'AM';
    }

    if (startH > 12) {
      startMer = startH >= 12 ? 'PM' : 'AM';
      startH = startH > 12 ? startH - 12 : startH;
    }

    result.startTime = `${String(startH).padStart(2, '0')}:${startM}`;
    result.startMeridiem = startMer;

    if (h2) {
      let endH = parseInt(h2, 10);
      const endM = m2;
      let endMer = (mer2 || mer1 || '').toUpperCase();

      if (!endMer) {
        endMer = endH >= 12 ? 'PM' : startMer;
      }

      if (endH > 12) {
        endMer = 'PM';
        endH = endH - 12;
      }

      result.endTime = `${String(endH).padStart(2, '0')}:${endM}`;
      result.endMeridiem = endMer;
    }

    result.title = input.replace(timeMatch[0], '').trim();
  }

  result.title = result.title.replace(/\s+/g, ' ').trim();

  return result;
};

const applyParsedTitle = () => {
  if (!newEvent.title) return false;

  const parsed = parseNaturalLanguage(newEvent.title);
  if (!parsed) return false;

  const nextEvent = { ...newEvent };
  let updated = false;
  const parsedTitle = (parsed.title || '').trim();

  if (parsedTitle && parsedTitle !== newEvent.title) {
    nextEvent.title = parsedTitle;
    updated = true;
  }
  if (parsed.date && parsed.date !== newEvent.date) {
    nextEvent.date = parsed.date;
    updated = true;
  }
  if (parsed.startTime) {
    nextEvent.startTime = parsed.startTime;
    nextEvent.startMeridiem = parsed.startMeridiem || nextEvent.startMeridiem;
    updated = true;
  }
  if (parsed.endTime) {
    nextEvent.endTime = parsed.endTime;
    nextEvent.endMeridiem = parsed.endMeridiem || nextEvent.endMeridiem;
    updated = true;
  }

  if (parsed.startTime && !parsed.endTime) {
    const startMeridiem = parsed.startMeridiem || nextEvent.startMeridiem;
    const newEnd = addMinutesToTime(parsed.startTime, startMeridiem, lastDurationMinutes || 60);
    nextEvent.endTime = newEnd.time;
    nextEvent.endMeridiem = newEnd.meridiem;
    updated = true;
  }

  if (parsed.startTime && parsed.endTime) {
    const startMeridiem = parsed.startMeridiem || nextEvent.startMeridiem;
    const endMeridiem = parsed.endMeridiem || nextEvent.endMeridiem;
    lastDurationMinutes = getDurationMinutes(parsed.startTime, startMeridiem, parsed.endTime, endMeridiem);
  }

  if (updated) {
    newEvent = nextEvent;
    modalDirty = true;
    if (titleError && newEvent.title?.trim()) titleError = '';
  }

  return updated;
};

  const generateICalEvent = (event: { summary?: string; description?: string; location?: string; start?: string; end?: string; uid?: string; reminder?: number; url?: string; attendees?: string; timezone?: string }, options: { method?: string; organizer?: string; attendeeEmails?: string[] | null; rsvp?: boolean } = {}) => {
    const {
      summary,
      description,
      location,
      start,
      end,
      uid,
      reminder,
      url,
      attendees,
      timezone,
    } = event;
    const {
      method = 'PUBLISH',
      organizer = '',
      attendeeEmails = null,
      rsvp = false,
    } = options || {};
    const formatICalDate = (d: string | undefined) => {
      if (!d) return '';
      const date = new Date(d);
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };
    const dtstart = formatICalDate(start);
    const dtend = formatICalDate(end);
    const dtstamp = formatICalDate(new Date().toISOString());
    const eventUid = uid || `${Date.now()}@forwardemail.net`;
    const escape = (val: string) =>
      (val || '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Forward Email//Webmail//EN',
      'CALSCALE:GREGORIAN',
      `METHOD:${method}`,
      'BEGIN:VEVENT',
      `UID:${eventUid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${dtstart}`,
      `DTEND:${dtend}`,
      `SUMMARY:${escape(summary || 'Untitled Event')}`,
    ];
    if (description) lines.push(`DESCRIPTION:${escape(description)}`);
    if (location) lines.push(`LOCATION:${escape(location)}`);
    if (url) lines.push(`URL:${escape(url)}`);
    if (timezone) lines.push(`TZID:${escape(timezone)}`);
    if (organizer) lines.push(`ORGANIZER;CN=${escape(organizer)}:mailto:${organizer}`);
    const attendeeList = attendeeEmails?.length
      ? attendeeEmails
      : attendees
        ? attendees.split(/[,;]/).map((e) => e.trim()).filter(Boolean)
        : [];
    if (attendeeList.length) {
      attendeeList.forEach((email) => {
        const rsvpParams = rsvp ? ';ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE' : '';
        lines.push(`ATTENDEE;CN=${email}${rsvpParams}:mailto:${email}`);
      });
    }
    if (reminder && reminder > 0) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escape(summary || 'Event reminder')}`,
        `TRIGGER:-PT${reminder}M`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
  };

  const exportEventAsICS = (event: Record<string, unknown> | undefined) => {
    if (!event) return;
    const icalContent = generateICalEvent({
      summary: event.title as string,
      description: (event.description as string) || '',
      location: (event.location as string) || '',
      url: (event.url as string) || '',
      timezone: (event.timezone as string) || '',
      attendees: (event.attendees as string) || '',
      start: event.start as string,
      end: event.end as string,
      uid: event.id as string,
      reminder: Number(event.notify) || 0,
    });
    const blob = new Blob([icalContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = ((event.title as string) || 'event').replace(/[^a-z0-9]/gi, '_');
    a.download = `${filename}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toasts?.show?.('Event exported', 'success');
  };

  const queueEventInvites = async ({
    title,
    start,
    end,
    allDay,
    description,
    location,
    url,
    timezone,
    attendees,
    uid,
  }: { title?: string; start: Date; end: Date; allDay?: boolean; description?: string; location?: string; url?: string; timezone?: string; attendees?: string; uid?: string }) => {
    const attendeeEmails = parseAttendeeEmails(attendees || '');
    if (!attendeeEmails.length) return { queued: 0 };
    const organizer = getActiveFromAddress();
    if (!organizer) return { queued: 0 };

    const inviteTitle = title || 'Event';
    const inviteUid = uid || `${Date.now()}@forwardemail.net`;
    const { text, html } = buildInviteMessage({
      title: inviteTitle,
      start,
      end,
      allDay,
      location,
      url,
      description,
      organizer,
    });
    const filename = inviteTitle.replace(/[^a-z0-9]/gi, '_') || 'event';

    await Promise.all(
      attendeeEmails.map(async (email) => {
        const icalContent = generateICalEvent(
          {
            summary: inviteTitle,
            description: description || '',
            location: location || '',
            url: url || '',
            timezone: timezone || '',
            attendees: '',
            start: start?.toISOString?.() || '',
            end: end?.toISOString?.() || '',
            uid: inviteUid,
          },
          {
            method: 'REQUEST',
            organizer,
            attendeeEmails: [email],
            rsvp: true,
          },
        );
        const payload = {
          from: organizer,
          to: [email],
          subject: `Invitation: ${inviteTitle}`,
          text,
          html,
          attachments: [
            {
              filename: `${filename}.ics`,
              contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
              content: toBase64(icalContent),
              encoding: 'base64',
            },
          ],
          has_attachment: true,
          save_sent: true,
        };
        await queueEmail(payload);
      }),
    );

    return { queued: attendeeEmails.length };
  };

  const duplicateEvent = () => {
    const { title, date, startTime, startMeridiem, endTime, endMeridiem, description, location, url, timezone, attendees, notify, allDay } = editEvent;
    newEvent = {
      calendarId: editEvent.calendarId || resolveActiveCalendarId(),
      title: `${title} (Copy)`,
      date,
      startTime,
      startMeridiem,
      endTime,
      endMeridiem,
      allDay,
      description,
      location,
      url,
      timezone,
      attendees,
      notify,
    };
    editEventModal = false;
    newEventModal = true;
    optionalFieldsExpanded = false;
    modalDirty = false;
    lastDurationMinutes = getDurationMinutes(startTime, startMeridiem, endTime, endMeridiem);
    titleError = '';
    announceModal('New event dialog opened');
    focusTitleInput();
  };

  const importICS = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;

    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      toasts?.show?.('File too large. Maximum size is 5MB.', 'error');
      target.value = '';
      return;
    }

    try {
      const content = await file.text();
      const eventBlocks = content.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];

      let imported = 0;
      let updated = 0;
      const calendar = activeCalendar();
      if (!calendar) {
        toasts?.show?.('No calendar selected.', 'error');
        return;
      }
      const calendarId = getCalendarId(calendar);
      if (!eventBlocks.length) {
        toasts?.show?.('No events found in calendar file.', 'error');
        return;
      }
      const calendarShell = content.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n?/gi, '');
      const endIndex = calendarShell.search(/END:VCALENDAR/i);
      const hasCalendarShell = /BEGIN:VCALENDAR/i.test(calendarShell) && endIndex !== -1;
      const calendarPrefix = hasCalendarShell ? calendarShell.slice(0, endIndex) : '';
      const calendarSuffix = hasCalendarShell ? calendarShell.slice(endIndex) : '';
      const useRawContent =
        eventBlocks.length === 1 &&
        /BEGIN:VCALENDAR/i.test(content) &&
        /END:VCALENDAR/i.test(content);
      const buildIcalPayload = (eventBlock: string) => {
        if (useRawContent) return content;
        if (hasCalendarShell) return `${calendarPrefix}${eventBlock}\r\n${calendarSuffix}`;
        return [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Forward Email//Webmail//EN',
          'CALSCALE:GREGORIAN',
          'METHOD:PUBLISH',
          eventBlock,
          'END:VCALENDAR',
        ].join('\r\n');
      };
      for (const eventBlock of eventBlocks) {
        const rawUid = eventBlock.match(/^UID:(.+)$/m)?.[1]?.trim();
        const existing = rawUid ? events.find((ev) => (ev as Record<string, unknown>).id === rawUid || (ev as Record<string, unknown>).uid === rawUid) : null;
        const icalPayload = buildIcalPayload(eventBlock);

        if (existing) {
          try {
            const payload = { id: (existing as Record<string, unknown>).id, calendar_id: calendarId, ical: icalPayload };
            await Remote.request('CalendarEventUpdate', payload, {
              method: 'PUT',
              pathOverride: `/v1/calendar-events/${(existing as Record<string, unknown>).id}`,
            });
            updated++;
          } catch (err) {
            console.error('Failed to update event:', err);
          }
        } else {
          try {
            const payload = { calendar_id: calendarId, ical: icalPayload };
            await Remote.request('CalendarEventCreate', payload, { method: 'POST' });
            imported++;
          } catch (err) {
            console.error('Failed to create event:', err);
          }
        }
      }

      if (imported + updated > 0) {
        await loadEventsForSelection(true);
      }

      const msg = imported > 0 && updated > 0
        ? `Imported ${imported} and updated ${updated} events`
        : imported > 0
          ? `Imported ${imported} event${imported > 1 ? 's' : ''}`
          : updated > 0
            ? `Updated ${updated} event${updated > 1 ? 's' : ''}`
            : 'No events imported';
      toasts?.show?.(msg, 'success');
    } catch (err) {
      toasts?.show?.('Failed to import calendar: ' + ((err as Error)?.message || 'Unknown error'), 'error');
    } finally {
      target.value = '';
    }
  };

  const setError = (msg: string) => {
    error = msg || '';
    if (msg) {
      setTimeout(() => {
        error = '';
      }, 5000);
    }
  };

  const setSuccess = (msg: string) => {
    if (msg) toasts?.show?.(msg, 'success');
  };

  const resetCalendarState = () => {
    loadRequestId += 1;
    calendars = [];
    selectedCalendarIds = [];
    activeCalendarId = '';
    events = [];
    allEvents = [];
    eventsScope = 'none';
    eventsScopeCalendarId = '';
    calendarsLoaded = false;
    loading = false;
    error = '';
    newEventModal = false;
    editEventModal = false;
    showDeleteConfirm = false;
    showNewStartPicker = false;
    showNewEndPicker = false;
    showEditStartPicker = false;
    showEditEndPicker = false;
    optionalFieldsExpanded = false;
    filterMenuOpen = false;
    modalDirty = false;
    savingEvent = false;
    titleError = '';
    modalAnnouncement = '';
  };

  const uniqueIds = (list: string[]) => Array.from(new Set((list || []).filter(Boolean)));

  const getCalendarById = (id: string) => calendars.find((c) => getCalendarId(c) === id);

  const resolveActiveCalendarId = () =>
    activeCalendarId || selectedCalendarIds[0] || getCalendarId(calendars[0]) || '';

  const activeCalendar = () => getCalendarById(resolveActiveCalendarId());

  const parseCalendarPrefs = (value: unknown): { selectedIds: string[]; activeId: string } | null => {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return parseCalendarPrefs(JSON.parse(value));
      } catch {
        return null;
      }
    }
    if (typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const selectedIds = Array.isArray(v.selectedIds)
      ? (v.selectedIds as string[]).filter(Boolean)
      : Array.isArray(v.selectedCalendarIds)
        ? (v.selectedCalendarIds as string[]).filter(Boolean)
        : v.selectedCalendarId
          ? [v.selectedCalendarId as string]
          : [];
    const activeId =
      typeof v.activeId === 'string'
        ? v.activeId
        : typeof v.selectedCalendarId === 'string'
          ? v.selectedCalendarId
          : '';
    return { selectedIds, activeId };
  };

  const readCalendarPrefs = async (accountKey: string) => {
    const key = getCalendarPrefsKey(accountKey);
    const localPrefs = parseCalendarPrefs(Local.get(key));
    if (localPrefs) return localPrefs;
    try {
      const record = await db.meta.get(key);
      return parseCalendarPrefs(record?.value);
    } catch {
      return null;
    }
  };

  const persistCalendarPrefs = async (accountKey: string, selectedIds: string[]) => {
    const key = getCalendarPrefsKey(accountKey);
    const payload = {
      selectedIds: uniqueIds(selectedIds),
    };
    try {
      Local.set(key, JSON.stringify(payload));
    } catch {
      // ignore local storage failures
    }
    try {
      await db.meta.put({ key, value: payload, updatedAt: Date.now() });
    } catch {
      // ignore meta persistence failures
    }
  };

  const reconcileCalendarSelection = (list: unknown[], prefs: { selectedIds: string[]; activeId: string } | null) => {
    const listIds = uniqueIds((list || []).map(getCalendarId) as string[]);
    const listSet = new Set(listIds);
    let selectedIds = uniqueIds((prefs?.selectedIds || []).filter((id) => listSet.has(id)));
    if (!selectedIds.length && listIds.length) selectedIds = listIds;
    // Always default to the "Calendar" calendar (not Tasks or other custom calendars)
    const defaultId = selectedIds.find((id) => {
      const cal = list.find((c) => getCalendarId(c) === id);
      const label = cal ? getCalendarLabel(cal) : '';
      return label === 'Calendar';
    });
    const activeId = defaultId || selectedIds[0] || '';
    if (activeId && !selectedIds.includes(activeId)) selectedIds = uniqueIds([...selectedIds, activeId]);
    selectedCalendarIds = selectedIds;
    activeCalendarId = activeId;
    return { selectedIds, activeId };
  };

  const isDesktopViewport = () => typeof window !== 'undefined' && window.innerWidth > 900;

  const resolveDefaultView = () => {
    const view = isDesktopViewport() ? viewMonthGrid : viewWeek;
    return (view as { name?: string })?.name || view;
  };

  const toDate = (input: unknown): Date | null => {
    if (!input) return null;
    if (input instanceof Date) return input;
    if (typeof input === 'object') {
      const o = input as Record<string, unknown>;
      const year = o?.year as number;
      const month = o?.month as number;
      const day = o?.day as number;
      if ([year, month, day].every((val) => Number.isFinite(val))) {
        return new Date(year, month - 1, day);
      }
    }
    if (typeof input === 'string') {
      // If the string ends with Z or has a timezone offset, parse using native Date
      // which correctly handles UTC/timezone conversion to local time
      if (input.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(input)) {
        const d = new Date(input);
        if (!Number.isNaN(d.getTime())) return d;
      }
      // Date-only strings: parse as local midnight
      const dateOnlyMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        return new Date(Number(year), Number(month) - 1, Number(day));
      }
      // Date-time strings without timezone: parse components as local time
      const dateTimeMatch = input.match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
      );
      if (dateTimeMatch) {
        const [, year, month, day, hour, minute, second = '0'] = dateTimeMatch;
        return new Date(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        );
      }
      const d = new Date(input);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof input === 'object' && (input as { toString?: () => string })?.toString) {
      const d = new Date((input as { toString: () => string }).toString());
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  };

const applySelectedEvents = () => {
  const selectedSet = new Set(effectiveSelectedCalendarIds);
  if (!selectedSet.size) {
    events = [];
    return;
  }
  events = (allEvents || []).filter((ev) => {
    const e = ev as Record<string, unknown>;
    return selectedSet.has((e.calendarId || e.calendar_id || (e.raw as Record<string, unknown>)?.calendar_id) as string);
  });
};

const hydrateEventsFromCache = async (requestId: number, accountKey: string, selectedIds: string[]) => {
  if (!selectedIds?.length) return;
  if (selectedIds.length > 1) {
    const cached = await db.meta.get(getAllEventsCacheKey(accountKey));
    if (requestId !== loadRequestId) return;
    if (cached?.value) {
      allEvents = cached.value as unknown[];
      eventsScope = 'all';
      eventsScopeCalendarId = '';
      applySelectedEvents();
    }
    return;
  }
  const calendarId = selectedIds[0];
  const cached = await db.meta.get(getEventsCacheKey(accountKey, calendarId));
  if (requestId !== loadRequestId) return;
  if (cached?.value) {
    allEvents = cached.value as unknown[];
    eventsScope = 'calendar';
    eventsScopeCalendarId = calendarId;
    applySelectedEvents();
  }
};

// Parse time string and return as ISO string, preserving the intended time
const normalizeEventTime = (timeValue: unknown): string => {
  if (!timeValue) return '';
  const str = String(timeValue);

  // If it's already an ISO string with Z (UTC), keep it as-is
  if (str.endsWith('Z')) return str;

  // If it has timezone offset like +00:00 or -08:00, parse and convert to ISO
  if (/[+-]\d{2}:\d{2}$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString();
    return str;
  }

  // For any other format, just return as-is and let formatForScheduleX handle it
  // This preserves the original time value from the API
  return str;
};

const mapCalendarEvents = (list: unknown[], defaultCalendarId = '') =>
  (list || []).map((ev) => {
    const e = ev as Record<string, unknown>;
    return {
      id: e.id || e.uid || e.event_id,
      title: e.summary || e.title || e.name || 'Event',
      start: normalizeEventTime(e.start || e.start_date || e.dtstart || e.start_time),
      end: normalizeEventTime(e.end || e.end_date || e.dtend || e.end_time),
      calendarId: e.calendar_id || e.calendarId || defaultCalendarId,
      description: e.description || e.notes || '',
      location: e.location || '',
      url: e.url || '',
      timezone: e.timezone || '',
      attendees: e.attendees || '',
      notify: e.notify || e.reminder || 0,
      raw: ev,
    };
  });

const fetchAllEvents = async (requestId: number, accountKey: string, attempt = 1): Promise<void> => {
  try {
    const res = await Remote.request('CalendarEvents', { limit: 500 });
    if (requestId !== loadRequestId) return;
    const list = Array.isArray(res) ? res : (res as Record<string, unknown>)?.Result || (res as Record<string, unknown>)?.events || [];
    const mapped = mapCalendarEvents(list as unknown[]);
    allEvents = mapped;
    eventsScope = 'all';
    eventsScopeCalendarId = '';
    await db.meta.put({
      key: getAllEventsCacheKey(accountKey),
      value: mapped,
      updatedAt: Date.now(),
    });
  } catch (err) {
    if (attempt < 3) {
      return fetchAllEvents(requestId, accountKey, attempt + 1);
    }
    if (requestId !== loadRequestId) return;
    setError((err as Error)?.message || 'Unable to load events.');
    const cached = await db.meta.get(getAllEventsCacheKey(accountKey));
    if (requestId !== loadRequestId) return;
    if (cached?.value) {
      allEvents = cached.value as unknown[];
      eventsScope = 'all';
      eventsScopeCalendarId = '';
    }
  }
};

const fetchEventsForCalendar = async (requestId: number, accountKey: string, calendarId: string, attempt = 1): Promise<void> => {
  if (!calendarId) {
    events = [];
    return;
  }
  try {
    const res = await Remote.request('CalendarEvents', { calendar_id: calendarId, limit: 500 });
    if (requestId !== loadRequestId) return;
    const list = Array.isArray(res) ? res : (res as Record<string, unknown>)?.Result || (res as Record<string, unknown>)?.events || [];
    const mapped = mapCalendarEvents(list as unknown[], calendarId);
    allEvents = mapped;
    eventsScope = 'calendar';
    eventsScopeCalendarId = calendarId;
    await db.meta.put({
      key: getEventsCacheKey(accountKey, calendarId),
      value: mapped,
      updatedAt: Date.now(),
    });
  } catch (err) {
    if (attempt < 3) {
      return fetchEventsForCalendar(requestId, accountKey, calendarId, attempt + 1);
    }
    if (requestId !== loadRequestId) return;
    setError((err as Error)?.message || 'Unable to load events.');
    const cached = await db.meta.get(getEventsCacheKey(accountKey, calendarId));
    if (requestId !== loadRequestId) return;
    if (cached?.value) {
      allEvents = cached.value as unknown[];
      eventsScope = 'calendar';
      eventsScopeCalendarId = calendarId;
    }
  }
};

const loadEventsForSelection = async (force = false) => {
  const requestId = loadRequestId;
  const accountKey = getAccountKey();
  const selectedIds = uniqueIds(selectedCalendarIds);
  if (!selectedIds.length) {
    events = [];
    return;
  }

  if (!force && eventsScope === 'all') {
    applySelectedEvents();
    return;
  }

  if (selectedIds.length > 1) {
    await fetchAllEvents(requestId, accountKey);
    if (requestId !== loadRequestId) return;
    applySelectedEvents();
    return;
  }

  const calendarId = selectedIds[0];
  if (!force && eventsScope === 'calendar' && eventsScopeCalendarId === calendarId) {
    applySelectedEvents();
    return;
  }
  await fetchEventsForCalendar(requestId, accountKey, calendarId);
  if (requestId !== loadRequestId) return;
  applySelectedEvents();
};

const fetchCalendars = async (attempt = 1): Promise<void> => {
  const requestId = loadRequestId;
  const accountKey = getAccountKey();
  const calendarsCacheKey = getCalendarsCacheKey(accountKey);
  const storedPrefs = await readCalendarPrefs(accountKey);

  const cached = await db.meta.get(calendarsCacheKey);
  if (requestId !== loadRequestId) return;
  if (cached?.value && (cached.value as unknown[])?.length) {
    calendars = cached.value as unknown[];
    const prefsSnapshot = selectedCalendarIds.length
      ? { selectedIds: selectedCalendarIds, activeId: activeCalendarId }
      : storedPrefs;
    const { selectedIds, activeId } = reconcileCalendarSelection(cached.value as unknown[], prefsSnapshot);
    await hydrateEventsFromCache(requestId, accountKey, selectedIds);
    if (requestId !== loadRequestId) return;
    await persistCalendarPrefs(accountKey, selectedIds);
  }

  try {
    const res = await Remote.request('Calendars', { limit: 50 });
    if (requestId !== loadRequestId) return;
    const list = Array.isArray(res) ? res : (res as Record<string, unknown>)?.Result || (res as Record<string, unknown>)?.calendars || [];
    const finalList =
      list && (list as unknown[]).length
        ? list
        : [
            {
              id: 'default',
              calendar_id: 'default',
              name: 'My Calendar',
              displayName: 'My Calendar',
            },
          ];
    calendars = finalList as unknown[];
    await db.meta.put({ key: calendarsCacheKey, value: finalList, updatedAt: Date.now() });
    if (requestId !== loadRequestId) return;
    const prefsSnapshot = selectedCalendarIds.length
      ? { selectedIds: selectedCalendarIds, activeId: activeCalendarId }
      : storedPrefs;
    const { selectedIds, activeId } = reconcileCalendarSelection(finalList as unknown[], prefsSnapshot);
    await persistCalendarPrefs(accountKey, selectedIds);
    if (requestId !== loadRequestId) return;
    await loadEventsForSelection(true);
  } catch (err) {
    if (attempt < 3) {
      return fetchCalendars(attempt + 1);
    }
    setError((err as Error)?.message || 'Unable to load calendars.');
    if (!calendars.length) {
      calendars = [
        {
          id: 'default',
          calendar_id: 'default',
          name: 'My Calendar',
          displayName: 'My Calendar',
        },
      ];
      const { selectedIds, activeId } = reconcileCalendarSelection(calendars, storedPrefs);
      await persistCalendarPrefs(accountKey, selectedIds);
      await loadEventsForSelection(true);
    }
  }
};

const setCalendarSelection = async (nextSelectedIds: string[], nextActiveId: string, options: { reloadEvents?: boolean } = {}) => {
  const { reloadEvents = true } = options;
  const cleaned = uniqueIds(nextSelectedIds);
  if (!cleaned.length && calendars.length) {
    cleaned.push(getCalendarId(calendars[0]) as string);
  }
  const activeId = nextActiveId || cleaned[0] || '';
  const finalSelected = activeId && !cleaned.includes(activeId) ? uniqueIds([...cleaned, activeId]) : cleaned;
  selectedCalendarIds = finalSelected;
  activeCalendarId = activeId;
  await persistCalendarPrefs(getAccountKey(), selectedCalendarIds);
  if (reloadEvents) {
    await loadEventsForSelection();
  }
};

const toggleCalendarSelection = async (calendarId: string) => {
  if (!calendarId) return;
  const isSelected = selectedCalendarIds.includes(calendarId);
  const nextSelected = isSelected
    ? selectedCalendarIds.filter((id) => id !== calendarId)
    : [...selectedCalendarIds, calendarId];
  if (!nextSelected.length) {
    toasts?.show?.('Select at least one calendar.', 'error');
    return;
  }
  const nextActive = nextSelected.includes(activeCalendarId)
    ? activeCalendarId
    : nextSelected[0];
  if (newEventModal && newEvent.calendarId && !nextSelected.includes(newEvent.calendarId)) {
    newEvent = { ...newEvent, calendarId: nextActive };
  }
  if (editEventModal && editEvent.calendarId && !nextSelected.includes(editEvent.calendarId)) {
    editEvent = { ...editEvent, calendarId: nextActive };
  }
  await setCalendarSelection(nextSelected, nextActive);
};

const setActiveCalendarId = async (calendarId: string) => {
  if (!calendarId) return;
  const nextSelected = selectedCalendarIds.includes(calendarId)
    ? selectedCalendarIds
    : [...selectedCalendarIds, calendarId];
  await setCalendarSelection(nextSelected, calendarId, { reloadEvents: nextSelected.length > 1 });
};

const formatForScheduleX = (isoDate: string | undefined) => {
  if (!isoDate) return '';
  // Use toDate for robust parsing that handles UTC (Z suffix) and local times correctly
  const d = toDate(isoDate);
  if (!d || isNaN(d.getTime())) return '';
  // Schedule-X expects local time in format "YYYY-MM-DD HH:mm"
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  // Using space format as per Schedule-X documentation
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

const buildScheduleCalendars = (list: unknown[]) => {
  const entries: Record<string, unknown> = {};
  (list || []).forEach((cal, index) => {
    const id = getCalendarId(cal);
    if (!id) return;
    const base = resolveCalendarColor(cal, index);
    const lightContainer = blendHex(base, '#ffffff', 0.85);
    const darkContainer = blendHex(base, '#0f172a', 0.7);
    entries[id as string] = {
      colorName: id,
      lightColors: {
        main: base,
        container: lightContainer,
        onContainer: '#0f172a',
      },
      darkColors: {
        main: blendHex(base, '#ffffff', 0.35),
        onContainer: '#ffffff',
        container: darkContainer,
      },
    };
  });
  if (!Object.keys(entries).length) {
    entries.default = {
      colorName: 'default',
      lightColors: {
        main: '#1c7ed6',
        container: '#e7f5ff',
        onContainer: '#1864ab',
      },
      darkColors: {
        main: '#74c0fc',
        onContainer: '#ffffff',
        container: '#1e3a8a',
      },
    };
  }
  return entries;
};

let lastEventCount = -1;
let calendarCreated = false;
$effect(() => {
  if (isActive && events && calendars.length) {
    const eventCount = events?.length || 0;
    if (eventCount === lastEventCount && calendarCreated) return;
    lastEventCount = eventCount;
    const mapped = events
      .map((ev) => {
        const e = ev as Record<string, unknown>;
        return {
          id: e.id || e.uid,
          title: e.title || e.summary || e.name || 'Event',
          start: formatForScheduleX((e.start || e.startDate || e.start_time) as string),
          end: formatForScheduleX((e.end || e.endDate || e.end_time) as string),
          calendarId: e.calendarId || e.calendar_id || 'default',
        };
      })
      .filter((ev) => ev.start && ev.end);
    const safeEvents = mapped.length ? mapped : [];

    if (calendarInstance?.events) {
      try {
        calendarInstance.events.set(safeEvents);
      } catch (err) {
        console.warn('Failed to update calendar events:', err);
      }
    } else {
      ensureSafeMutationObserver();
      const isDark = calendarIsDark;
      calendarInstance = createCalendar({
        locale: 'en-US',
        views: [viewDay, viewWeek, viewMonthGrid],
        defaultView: resolveDefaultView(),
        events: safeEvents,
        isDark,
        defaultCalendarId: resolveActiveCalendarId() || 'default',
        calendars: buildScheduleCalendars(calendars),
        callbacks: {
          onClickDate: (date: string) => {
            openNewEvent(date);
          },
          onClickDateTime: (dateTime: string) => {
            openNewEvent(dateTime);
          },
          onEventClick: (ev: unknown) => openEditEvent(ev),
        },
      });
      calendarCreated = true;
    }
  }
});

const load = async (force = false) => {
  if (loading) return;
  const requestId = loadRequestId;
  loading = true;
  error = '';
  try {
    if (!calendarsLoaded || force) {
      await fetchCalendars();
      if (requestId !== loadRequestId) return;
      calendarsLoaded = true;
    }
  } catch (err) {
    if (requestId !== loadRequestId) return;
    setError((err as Error)?.message || 'Unable to load calendar.');
  } finally {
    if (requestId === loadRequestId) {
      loading = false;
    }
  }
};

const ensureEndAfterStart = (date: string, startTime: string, startMeridiem: string, endTime: string, endMeridiem: string) => {
  // Parse date components explicitly to avoid timezone parsing issues
  const [year, month, day] = date.split('-').map(Number);
  const startTime24 = to24Hour(startTime, startMeridiem);
  const endTime24 = to24Hour(endTime, endMeridiem);
  if (!startTime24 || !endTime24) return null;

  const [startHour, startMin] = startTime24.split(':').map(Number);
  const [endHour, endMin] = endTime24.split(':').map(Number);

  // Create dates using local time components explicitly
  const start = new Date(year, month - 1, day, startHour, startMin, 0, 0);
  const end = new Date(year, month - 1, day, endHour, endMin, 0, 0);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return null;
  return { start, end };
};

const openNewEvent = (dateInput: unknown) => {
  const dateObj = toDate(dateInput) || new Date();
  const roundedStart = roundTime(dateObj, 30);
  const startLocal = formatDateTimeLocal(roundedStart);
  const datePart = startLocal.split('T')[0];
  const timePart = startLocal.split('T')[1];

  const endDate = new Date(roundedStart.getTime() + 60 * 60000);
  const endTimePart = formatDateTimeLocal(endDate).split('T')[1];
  const startSplit = to12Hour(timePart);
  const endSplit = to12Hour(endTimePart);

  newEvent = {
    calendarId: resolveActiveCalendarId(),
    title: '',
    date: datePart,
    startTime: startSplit.time,
    startMeridiem: startSplit.meridiem,
    endTime: endSplit.time,
    endMeridiem: endSplit.meridiem,
    allDay: false,
    description: '',
    location: '',
    url: '',
    timezone: '',
    attendees: '',
    notify: 0,
  };
  optionalFieldsExpanded = false;
  modalDirty = false;
  savingEvent = false;
  newEventModal = true;
  showNewStartPicker = false;
  showNewEndPicker = false;
  optionalFieldsExpanded = false;
  modalDirty = false;
  lastDurationMinutes = 60;
  titleError = '';
  announceModal('New event dialog opened');
  focusTitleInput();
};

const handleTitleBlur = () => {
  applyParsedTitle();
};

const handleStartTimeChange = () => {
  if (!newEvent.startTime) return;

  const newEnd = addMinutesToTime(
    newEvent.startTime,
    newEvent.startMeridiem,
    lastDurationMinutes || 60
  );
  newEvent.endTime = newEnd.time;
  newEvent.endMeridiem = newEnd.meridiem;
  modalDirty = true;
};

const handleEndTimeChange = () => {
  if (!newEvent.startTime || !newEvent.endTime) return;

  if (!isEndAfterStart(newEvent.startTime, newEvent.startMeridiem, newEvent.endTime, newEvent.endMeridiem)) {
    const newEnd = addMinutesToTime(
      newEvent.startTime,
      newEvent.startMeridiem,
      lastDurationMinutes || 60
    );
    newEvent.endTime = newEnd.time;
    newEvent.endMeridiem = newEnd.meridiem;
  } else {
    lastDurationMinutes = getDurationMinutes(
      newEvent.startTime,
      newEvent.startMeridiem,
      newEvent.endTime,
      newEvent.endMeridiem
    );
  }
  modalDirty = true;
};

const isNewEventValid = $derived.by(() => {
  const hasTitle = !!newEvent.title?.trim();
  const hasDate = !!newEvent.date;
  const hasTimes = newEvent.allDay || (!!newEvent.startTime && !!newEvent.endTime);
  return hasTitle && hasDate && hasTimes;
});

const attemptSaveNewEvent = () => {
  titleError = '';
  if (!newEvent.title?.trim()) {
    titleError = 'Title is required.';
    const input = document.getElementById('event-title') as HTMLInputElement | null;
    input?.focus();
    return;
  }
  if (!isNewEventValid) return;
  saveNewEvent();
};

const prefillQuickEvent = (email?: string) => {
  const startDate = new Date(Date.now() + 10 * 60 * 1000);
  const startLocal = formatDateTimeLocal(startDate);
  const datePart = startLocal.split('T')[0];
  const timePart = startLocal.split('T')[1];
  const endDate = new Date(startDate.getTime() + 60 * 60000);
  const endTimePart = formatDateTimeLocal(endDate).split('T')[1];
  const startSplit = to12Hour(timePart);
  const endSplit = to12Hour(endTimePart);
  newEvent = {
    calendarId: resolveActiveCalendarId(),
    title: email ? `Meeting with ${email}` : 'New event',
    date: datePart,
    startTime: startSplit.time,
    startMeridiem: startSplit.meridiem,
    endTime: endSplit.time,
    endMeridiem: endSplit.meridiem,
    allDay: false,
    description: email ? `Follow up with ${email}` : '',
    location: '',
    url: '',
    timezone: '',
    attendees: '',
    notify: 0,
  };
  newEventModal = true;
  showNewStartPicker = false;
  showNewEndPicker = false;
  lastDurationMinutes = 60;
  titleError = '';
  announceModal('New event dialog opened');
  focusTitleInput();
};

const saveNewEvent = async () => {
  const title = newEvent.title?.trim() || 'Event';

  const calendarId = newEvent.calendarId || resolveActiveCalendarId();
  const calendar = getCalendarById(calendarId);
  if (!calendarId || !calendar) {
    setError('No calendar selected.');
    return;
  }

  if (!newEvent.date) {
    setError('Date is required.');
    return;
  }

  savingEvent = true;
  const resolvedCalendarId = getCalendarId(calendar);

  try {
    let range;

    if (newEvent.allDay) {
      const startDate = new Date(newEvent.date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(newEvent.date);
      endDate.setHours(23, 59, 59, 999);
      range = { start: startDate, end: endDate };
    } else {
      const { date, startTime, startMeridiem, endTime, endMeridiem } = newEvent;
      if (!startTime || !endTime || !startMeridiem || !endMeridiem) {
        setError('Start and end times are required.');
        savingEvent = false;
        return;
      }
      range = ensureEndAfterStart(date, startTime, startMeridiem, endTime, endMeridiem);
      if (!range) {
        setError('End time must be after start time.');
        savingEvent = false;
        return;
      }
    }

    const { description, location, url, timezone, attendees, notify, allDay } = newEvent;

    const icalData = generateICalEvent({
      summary: title,
      description: description || '',
      location: location || '',
      url: url || '',
      timezone: timezone || '',
      attendees: attendees || '',
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      reminder: Number(notify) || 0,
    });

    const payload = { calendar_id: resolvedCalendarId, ical: icalData };
    const created = await Remote.request('CalendarEventCreate', payload, { method: 'POST' }) as Record<string, unknown>;
    const createdEvent = {
      id: created?.id || created?.uid || created?.event_id || `${Date.now()}`,
      title,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      calendarId: resolvedCalendarId,
      description,
      location,
      url,
      timezone,
      attendees,
      notify: Number(notify) || 0,
      raw: created ? JSON.parse(JSON.stringify(created)) : null,
    };
    allEvents = [...allEvents, createdEvent];
    applySelectedEvents();

    // Close modal immediately after successful API call
    newEventModal = false;
    modalDirty = false;
    setError('');
    setSuccess('Event created successfully');

    // Cache in background (don't block on this) - sanitize to avoid postMessage clone errors
    const eventsToCache = sanitizeForWorker(
      allEvents.filter((ev) => ((ev as Record<string, unknown>).calendarId || (ev as Record<string, unknown>).calendar_id) === resolvedCalendarId)
    );
    db.meta.put({
      key: getEventsCacheKey(getAccountKey(), resolvedCalendarId as string),
      value: eventsToCache,
      updatedAt: Date.now(),
    }).catch((e) => console.warn('[Calendar] Failed to cache events:', e));

    if (eventsScope === 'all') {
      db.meta.put({
        key: getAllEventsCacheKey(getAccountKey()),
        value: sanitizeForWorker(allEvents),
        updatedAt: Date.now(),
      }).catch((e) => console.warn('[Calendar] Failed to cache all events:', e));
    }

    // Queue invites in background
    if (attendees && attendees.trim()) {
      queueEventInvites({
        title,
        start: range.start,
        end: range.end,
        allDay,
        description,
        location,
        url,
        timezone,
        attendees,
        uid: (created?.uid || created?.id || created?.event_id || createdEvent.id) as string,
      }).then((inviteResult) => {
        if (inviteResult?.queued) {
          const count = inviteResult.queued;
          toasts?.show?.(
            `Invite${count === 1 ? '' : 's'} queued for ${count} attendee${count === 1 ? '' : 's'}.`,
            'success',
          );
        }
      }).catch((inviteErr) => {
        console.error('[Calendar] Failed to queue invites:', inviteErr);
        toasts?.show?.(
          'Failed to queue invites. You can export the event and share the .ics.',
          'warning',
        );
      });
    }
  } catch (err) {
    setError((err as Error)?.message || 'Unable to create event.');
  } finally {
    savingEvent = false;
  }
};

const openEditEvent = (calendarEvent: unknown) => {
  const eventId = (calendarEvent as Record<string, unknown>)?.id;
  const fullEvent = events.find((ev) => ((ev as Record<string, unknown>).id || (ev as Record<string, unknown>).uid) === eventId) as Record<string, unknown> | undefined;
  if (!fullEvent) return;
  const startDate = new Date(fullEvent.start as string);
  const endDate = new Date(fullEvent.end as string);
  const startLocal = formatDateTimeLocal(startDate);
  const endLocal = formatDateTimeLocal(endDate);
  const datePart = startLocal.split('T')[0];
  const startSplit = to12Hour(startLocal.split('T')[1]);
  const endSplit = to12Hour(endLocal.split('T')[1]);
  editEvent = {
    id: fullEvent.id as string,
    calendarId: (fullEvent.calendarId || fullEvent.calendar_id || resolveActiveCalendarId()) as string,
    title: (fullEvent.title as string) || '',
    date: datePart,
    startTime: startSplit.time,
    startMeridiem: startSplit.meridiem,
    endTime: endSplit.time,
    endMeridiem: endSplit.meridiem,
    allDay: false,
    description: (fullEvent.description as string) || '',
    location: (fullEvent.location as string) || '',
    url: (fullEvent.url as string) || '',
    timezone: (fullEvent.timezone as string) || '',
    attendees: (fullEvent.attendees as string) || '',
    notify: (fullEvent.notify as number) || 0,
  };
  optionalFieldsExpanded = !!(fullEvent.location || fullEvent.url || fullEvent.timezone || fullEvent.attendees);
  editEventModal = true;
  showDeleteConfirm = false;
  showEditStartPicker = false;
  showEditEndPicker = false;
};

const updateEvent = async () => {
  const {
    id,
    calendarId,
    title,
    date,
    startTime,
    startMeridiem,
    endTime,
    endMeridiem,
    description,
    location,
    url,
    timezone,
    attendees,
    notify,
  } = editEvent;
  if (!title || !date || !startTime || !endTime || !startMeridiem || !endMeridiem) {
    setError('Title, date, and times are required.');
    return;
  }
  const range = ensureEndAfterStart(date, startTime, startMeridiem, endTime, endMeridiem);
  if (!range) {
    setError('End time must be after start time.');
    return;
  }
  try {
    const previousCalendarId =
      (allEvents.find((ev) => ((ev as Record<string, unknown>).id || (ev as Record<string, unknown>).uid) === id) as Record<string, unknown> | undefined)?.calendarId || '';
    const icalData = generateICalEvent({
      summary: title,
      description: description || '',
      location: location || '',
      url: url || '',
      timezone: timezone || '',
      attendees: attendees || '',
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      uid: id,
      reminder: Number(notify) || 0,
    });
    const payload = { id, calendar_id: calendarId, ical: icalData };
    await Remote.request('CalendarEventUpdate', payload, {
      method: 'PUT',
      pathOverride: `/v1/calendar-events/${id}`,
    });
    allEvents = allEvents.map((ev) =>
      (ev as Record<string, unknown>).id === id
        ? {
            ...ev,
            title,
            start: range.start.toISOString(),
            end: range.end.toISOString(),
            calendarId,
            description,
            location,
            url,
            timezone,
            attendees,
            notify: Number(notify) || 0,
          }
        : ev,
    );
    applySelectedEvents();

    // Close modal immediately after successful API call
    setError('');
    setSuccess('Event updated successfully');
    editEventModal = false;

    // Cache in background (don't block on this) - sanitize to avoid postMessage clone errors
    db.meta.put({
      key: getEventsCacheKey(getAccountKey(), calendarId),
      value: sanitizeForWorker(allEvents.filter((ev) => ((ev as Record<string, unknown>).calendarId || (ev as Record<string, unknown>).calendar_id) === calendarId)),
      updatedAt: Date.now(),
    }).catch((e) => console.warn('[Calendar] Failed to cache events:', e));

    if (previousCalendarId && previousCalendarId !== calendarId) {
      db.meta.put({
        key: getEventsCacheKey(getAccountKey(), previousCalendarId as string),
        value: sanitizeForWorker(allEvents.filter((ev) => ((ev as Record<string, unknown>).calendarId || (ev as Record<string, unknown>).calendar_id) === previousCalendarId)),
        updatedAt: Date.now(),
      }).catch((e) => console.warn('[Calendar] Failed to cache previous calendar events:', e));
    }
    if (eventsScope === 'all') {
      db.meta.put({
        key: getAllEventsCacheKey(getAccountKey()),
        value: sanitizeForWorker(allEvents),
        updatedAt: Date.now(),
      }).catch((e) => console.warn('[Calendar] Failed to cache all events:', e));
    }
  } catch (err) {
    setError((err as Error)?.message || 'Unable to update event.');
  }
};

const deleteEvent = async () => {
  const { id, calendarId } = editEvent;
  if (!id) {
    setError('No event selected.');
    return;
  }
  try {
    await Remote.request(
      'CalendarEventDelete',
      { calendar_id: calendarId },
      { method: 'DELETE', pathOverride: `/v1/calendar-events/${id}` },
    );
    allEvents = allEvents.filter((ev) => (ev as Record<string, unknown>).id !== id);
    applySelectedEvents();

    // Close modals immediately after successful API call
    setError('');
    setSuccess('Event deleted successfully');
    editEventModal = false;
    showDeleteConfirm = false;

    // Cache in background (don't block on this) - sanitize to avoid postMessage clone errors
    db.meta.put({
      key: getEventsCacheKey(getAccountKey(), calendarId),
      value: sanitizeForWorker(allEvents.filter((ev) => ((ev as Record<string, unknown>).calendarId || (ev as Record<string, unknown>).calendar_id) === calendarId)),
      updatedAt: Date.now(),
    }).catch((e) => console.warn('[Calendar] Failed to cache events:', e));

    if (eventsScope === 'all') {
      db.meta.put({
        key: getAllEventsCacheKey(getAccountKey()),
        value: sanitizeForWorker(allEvents),
        updatedAt: Date.now(),
      }).catch((e) => console.warn('[Calendar] Failed to cache all events:', e));
    }
  } catch (err) {
    setError((err as Error)?.message || 'Unable to delete event.');
  }
};

const closeModals = (force = false) => {
  if (!force && modalDirty && newEventModal) {
    if (!confirm('Discard changes?')) {
      return;
    }
  }

  newEventModal = false;
  editEventModal = false;
  showDeleteConfirm = false;
  showNewStartPicker = false;
  showNewEndPicker = false;
  showEditStartPicker = false;
  showEditEndPicker = false;
  modalDirty = false;
};

const handleModalKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Tab') {
    trapFocus(e, newEventModalRef);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModals();
  } else if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
    if ((e.target as HTMLElement).id === 'event-title') {
      e.preventDefault();
      applyParsedTitle();
      attemptSaveNewEvent();
    }
  }
};

const autoExpand = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
};

const closeTimePickers = (event: FocusEvent) => {
  if ((event?.target as HTMLElement)?.closest?.('.time-dropdown')) return;
  showNewStartPicker = false;
  showNewEndPicker = false;
  showEditStartPicker = false;
  showEditEndPicker = false;
};

const setNewEventTime = (field: string, value: string) => {
  newEvent = { ...newEvent, [field]: value };
};

const setEditEventTime = (field: string, value: string) => {
  editEvent = { ...editEvent, [field]: value };
};

onMount(() => {
  hasMounted = true;

  const handleResize = () => {
    viewportWidth = window.innerWidth;
  };
  window.addEventListener('resize', handleResize);

  const mediaQuery =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  const handleThemePreference = (event: MediaQueryListEvent | MediaQueryList) => {
    prefersDark = event?.matches ?? mediaQuery?.matches ?? false;
  };
  if (mediaQuery) {
    handleThemePreference(mediaQuery);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleThemePreference);
    }
  }

  registerApi?.({
    reload: load,
    prefillQuickEvent,
  } as unknown as CalendarApi);
  if (isActive) {
    load();
  }

  return () => {
    window.removeEventListener('resize', handleResize);
    if (mediaQuery) {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleThemePreference);
      }
    }
  };
});

let lastThemeSet = '';
$effect(() => {
  if (calendarInstance) {
    const themeVal = calendarIsDark ? 'dark' : 'light';
    if (themeVal !== lastThemeSet) {
      lastThemeSet = themeVal;
      calendarInstance.setTheme(themeVal);
    }
  }
});

let initialLoadTriggered = false;
$effect(() => {
  if (hasMounted && isActive && !loading && !calendarsLoaded && !initialLoadTriggered) {
    initialLoadTriggered = true;
    load();
  }
});
</script>

<Tooltip.Provider>
<div class="calendar-page flex flex-col h-full">
<div class="flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-3 shrink-0">
  <div class="flex items-center gap-3 min-w-0">
    <Button
      variant="ghost"
      size="icon"
      onclick={() => navigate?.('/mailbox')}
      aria-label="Back"
    >
      <LucideChevronLeft class="h-5 w-5" />
    </Button>
    <div class="min-w-0">
      <h1 class="text-lg font-semibold truncate">Calendar</h1>
      <span class="text-xs text-muted-foreground truncate block" title="Events stored privately for this account">
        {activeEmail || getCalendarLabel(activeCalendar())}
      </span>
    </div>
  </div>
  <div class="flex items-center gap-2">
    {#if !isMobile && calendars.length > 1}
      <DropdownMenu.Root bind:open={filterMenuOpen}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button variant="ghost" class="calendar-filter gap-1.5" {...props}>
              <span>{calendarFilterLabel}</span>
              <LucideChevronDown class="h-4 w-4" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="min-w-[220px] max-h-[280px] overflow-y-auto">
          {#each calendars as cal, index}
            {@const calId = getCalendarId(cal)}
            {#if calId}
              <DropdownMenu.CheckboxItem
                checked={selectedCalendarIds.includes(calId as string)}
                onCheckedChange={() => toggleCalendarSelection(calId as string)}
              >
                <span class="mr-2 h-2.5 w-2.5 shrink-0 rounded-full" style="background: {resolveCalendarColor(cal, index)}"></span>
                <span class="truncate">{getCalendarLabel(cal)}</span>
              </DropdownMenu.CheckboxItem>
            {/if}
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
    <Tooltip.Root>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Import calendar"
          class="import-menu"
          onclick={() => document.getElementById('import-ics-input')?.click()}
        >
          <LucideImport class="h-4 w-4" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>Import calendar (.ics)</p>
      </Tooltip.Content>
    </Tooltip.Root>
    <input
      id="import-ics-input"
      type="file"
      accept=".ics,text/calendar"
      onchange={importICS}
      class="hidden"
    />
    <Button onclick={() => openNewEvent(new Date())}>
      + New Event
    </Button>
  </div>
</div>

{#if error}
  <Alert.Root variant="destructive" class="mx-4 mt-3">
    <LucideAlertTriangle class="h-4 w-4" />
    <Alert.Description>{error}</Alert.Description>
  </Alert.Root>
{/if}

<div class="calendar-content flex-1 flex flex-col overflow-hidden p-4 min-h-0">
  {#if loading}
    <div class="flex items-center justify-center h-64 text-muted-foreground">
      Loading calendar...
    </div>
  {:else if calendarInstance}
    <div class="sx-wrapper border border-border" class:is-dark={calendarIsDark}>
      <ScheduleXCalendar calendarApp={calendarInstance} />
    </div>
    <div class="mt-4 flex items-center gap-2 bg-muted/50 p-3 text-xs text-muted-foreground shrink-0">
      <Info class="h-3.5 w-3.5 shrink-0" />
      <span>Privacy: Your calendar data is stored privately and never shared.</span>
    </div>
  {:else}
    <div class="flex items-center justify-center h-64 text-muted-foreground">
      Initializing calendar...
    </div>
  {/if}
</div>
</div>

<Dialog.Root bind:open={newEventModal}>
  <Dialog.Content class="sm:max-w-[520px]" onkeydown={handleModalKeydown}>
    <div class="sr-only" aria-live="polite" aria-atomic="true">{modalAnnouncement}</div>
    <Dialog.Header>
      <Dialog.Title>New event</Dialog.Title>
    </Dialog.Header>
    <div class="space-y-4 py-4" bind:this={newEventModalRef} onfocusin={closeTimePickers}>
      {#if calendars.length > 1}
        <div class="space-y-2">
          <Label>Calendar</Label>
          <Select.Root
            type="single"
            value={{ value: newEvent.calendarId, label: getCalendarLabel(getCalendarById(newEvent.calendarId)) as string }}
            onValueChange={(v) => {
              if (v) {
                newEvent.calendarId = v.value;
                modalDirty = true;
                setActiveCalendarId(v.value);
              }
            }}
          >
            <Select.Trigger class="w-full">
              {getCalendarLabel(getCalendarById(newEvent.calendarId)) || 'Select calendar'}
            </Select.Trigger>
            <Select.Content>
              {#each calendars as cal}
                {@const calId = getCalendarId(cal)}
                {#if calId}
                  <Select.Item value={calId as string}>{getCalendarLabel(cal)}</Select.Item>
                {/if}
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}
      <div class="space-y-2">
        <Label for="event-title">Title</Label>
        <Input
          id="event-title"
          type="text"
          placeholder="e.g., Lunch with Alex tomorrow 12-1"
          bind:value={newEvent.title}
          onblur={handleTitleBlur}
          oninput={() => { modalDirty = true; if (titleError) titleError = ''; }}
          autocomplete="off"
          aria-invalid={!!titleError}
        />
        {#if titleError}
          <p class="text-xs text-destructive">{titleError}</p>
        {/if}
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="event-date">Date</Label>
          <Input
            id="event-date"
            type="date"
            bind:value={newEvent.date}
            onchange={() => (modalDirty = true)}
          />
        </div>
        <div class="flex items-end pb-2">
          <label class="flex items-center gap-2 cursor-pointer text-sm">
            <Checkbox
              checked={newEvent.allDay}
              onCheckedChange={(v) => { newEvent.allDay = !!v; modalDirty = true; }}
            />
            <span>All-day</span>
          </label>
        </div>
      </div>
      {#if !newEvent.allDay}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-2">
            <Label>Start time</Label>
            <div class="flex gap-2">
              <div class="relative flex-1">
                <Input
                  type="text"
                  placeholder="12:00"
                  value={newEvent.startTime}
                  onfocus={() => { showNewStartPicker = true; showNewEndPicker = false; }}
                  oninput={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    setNewEventTime('startTime', val);
                    modalDirty = true;
                  }}
                  onblur={() => {
                    setTimeout(() => { showNewStartPicker = false; }, 150);
                    handleStartTimeChange();
                  }}
                />
                {#if showNewStartPicker}
                  <div class="time-dropdown absolute top-full left-0 right-0 mt-1 max-h-[220px] overflow-y-auto border border-border bg-popover shadow-lg z-20">
                    {#each timeOptions as opt}
                      <button
                        type="button"
                        class="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                        onmousedown={(e) => {
                          e.preventDefault();
                          setNewEventTime('startTime', opt.value);
                          handleStartTimeChange();
                          showNewStartPicker = false;
                        }}
                      >
                        {opt.display}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <select
                class="h-9 border border-input bg-background px-3 text-sm"
                bind:value={newEvent.startMeridiem}
                onchange={handleStartTimeChange}
              >
                <option>AM</option>
                <option>PM</option>
              </select>
            </div>
          </div>
          <div class="space-y-2">
            <Label>End time</Label>
            <div class="flex gap-2">
              <div class="relative flex-1">
                <Input
                  type="text"
                  placeholder="1:00"
                  value={newEvent.endTime}
                  onfocus={() => { showNewEndPicker = true; showNewStartPicker = false; }}
                  oninput={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    setNewEventTime('endTime', val);
                    modalDirty = true;
                  }}
                  onblur={() => {
                    setTimeout(() => { showNewEndPicker = false; }, 150);
                    handleEndTimeChange();
                  }}
                />
                {#if showNewEndPicker}
                  <div class="time-dropdown absolute top-full left-0 right-0 mt-1 max-h-[220px] overflow-y-auto border border-border bg-popover shadow-lg z-20">
                    {#each timeOptions as opt}
                      <button
                        type="button"
                        class="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                        onmousedown={(e) => {
                          e.preventDefault();
                          setNewEventTime('endTime', opt.value);
                          showNewEndPicker = false;
                          handleEndTimeChange();
                        }}
                      >
                        {opt.display}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <select
                class="h-9 border border-input bg-background px-3 text-sm"
                bind:value={newEvent.endMeridiem}
                onchange={handleEndTimeChange}
              >
                <option>AM</option>
                <option>PM</option>
              </select>
            </div>
          </div>
        </div>
      {/if}
      <div class="space-y-2">
        <Label for="event-description">Description</Label>
        <Textarea
          id="event-description"
          rows={3}
          placeholder="Add notes or details"
          bind:value={newEvent.description}
          bind:this={descriptionRef}
          oninput={(e) => { autoExpand(e.currentTarget as HTMLTextAreaElement); modalDirty = true; }}
          class="min-h-[60px] max-h-[200px] resize-none"
        />
      </div>

      <Separator />

      <button
        type="button"
        class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        onclick={() => (optionalFieldsExpanded = !optionalFieldsExpanded)}
      >
        {#if optionalFieldsExpanded}
          <LucideChevronDown class="h-4 w-4" />
        {:else}
          <LucideChevronRight class="h-4 w-4" />
        {/if}
        <span>More details</span>
        {#if !optionalFieldsExpanded && (newEvent.location || newEvent.url || newEvent.timezone || newEvent.attendees)}
          <span class="ml-1 text-primary">•</span>
        {/if}
      </button>

      {#if optionalFieldsExpanded}
        <div class="space-y-4 pl-6">
          <div class="space-y-2">
            <Label>Location</Label>
            <Input type="text" placeholder="Add location" bind:value={newEvent.location} oninput={() => (modalDirty = true)} />
          </div>
          <div class="space-y-2">
            <Label>URL / Video link</Label>
            <Input type="url" placeholder="https://" bind:value={newEvent.url} oninput={() => (modalDirty = true)} />
          </div>
          <div class="space-y-2">
            <Label>Time zone</Label>
            <Input type="text" placeholder="e.g., America/Chicago" bind:value={newEvent.timezone} oninput={() => (modalDirty = true)} />
          </div>
          <div class="space-y-2">
            <Label>Attendees</Label>
            <Input type="text" placeholder="Comma-separated emails" bind:value={newEvent.attendees} oninput={() => (modalDirty = true)} />
          </div>
        </div>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => closeModals()} disabled={savingEvent}>Cancel</Button>
      <Button onclick={attemptSaveNewEvent} disabled={!isNewEventValid || savingEvent}>
        {savingEvent ? 'Saving...' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editEventModal}>
  <Dialog.Content class="sm:max-w-[520px]" onfocusin={closeTimePickers}>
    <Dialog.Header>
      <Dialog.Title>Edit event</Dialog.Title>
    </Dialog.Header>
    <div class="space-y-4 py-4">
      {#if calendars.length > 1}
        <div class="space-y-2">
          <Label>Calendar</Label>
          <Select.Root
            type="single"
            value={{ value: editEvent.calendarId, label: getCalendarLabel(getCalendarById(editEvent.calendarId)) as string }}
            onValueChange={(v) => {
              if (v) {
                editEvent.calendarId = v.value;
                modalDirty = true;
                setActiveCalendarId(v.value);
              }
            }}
          >
            <Select.Trigger class="w-full">
              {getCalendarLabel(getCalendarById(editEvent.calendarId)) || 'Select calendar'}
            </Select.Trigger>
            <Select.Content>
              {#each calendars as cal}
                {@const calId = getCalendarId(cal)}
                {#if calId}
                  <Select.Item value={calId as string}>{getCalendarLabel(cal)}</Select.Item>
                {/if}
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}
      <div class="space-y-2">
        <Label>Title</Label>
        <Input type="text" bind:value={editEvent.title} />
      </div>
      <div class="space-y-2">
        <Label>Date</Label>
        <Input type="date" bind:value={editEvent.date} />
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label>Start time</Label>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <Input
                type="text"
                placeholder="12:00"
                value={editEvent.startTime}
                onfocus={() => { showEditStartPicker = true; showEditEndPicker = false; }}
                oninput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setEditEventTime('startTime', val);
                  modalDirty = true;
                }}
                onblur={() => {
                  setTimeout(() => { showEditStartPicker = false; }, 150);
                }}
              />
              {#if showEditStartPicker}
                <div class="time-dropdown absolute top-full left-0 right-0 mt-1 max-h-[220px] overflow-y-auto border border-border bg-popover shadow-lg z-20">
                  {#each timeOptions as opt}
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                      onmousedown={(e) => {
                        e.preventDefault();
                        setEditEventTime('startTime', opt.value);
                        showEditStartPicker = false;
                      }}
                    >
                      {opt.display}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <select class="h-9 border border-input bg-background px-3 text-sm" bind:value={editEvent.startMeridiem}>
              <option>AM</option>
              <option>PM</option>
            </select>
          </div>
        </div>
        <div class="space-y-2">
          <Label>End time</Label>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <Input
                type="text"
                placeholder="1:00"
                value={editEvent.endTime}
                onfocus={() => { showEditEndPicker = true; showEditStartPicker = false; }}
                oninput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setEditEventTime('endTime', val);
                  modalDirty = true;
                }}
                onblur={() => {
                  setTimeout(() => { showEditEndPicker = false; }, 150);
                }}
              />
              {#if showEditEndPicker}
                <div class="time-dropdown absolute top-full left-0 right-0 mt-1 max-h-[220px] overflow-y-auto border border-border bg-popover shadow-lg z-20">
                  {#each timeOptions as opt}
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                      onmousedown={(e) => {
                        e.preventDefault();
                        setEditEventTime('endTime', opt.value);
                        showEditEndPicker = false;
                      }}
                    >
                      {opt.display}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <select class="h-9 border border-input bg-background px-3 text-sm" bind:value={editEvent.endMeridiem}>
              <option>AM</option>
              <option>PM</option>
            </select>
          </div>
        </div>
      </div>
      <div class="space-y-2">
        <Label>Description</Label>
        <Textarea rows={5} bind:value={editEvent.description} />
      </div>

      <Separator />

      <button
        type="button"
        class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        onclick={() => (optionalFieldsExpanded = !optionalFieldsExpanded)}
      >
        {#if optionalFieldsExpanded}
          <LucideChevronDown class="h-4 w-4" />
        {:else}
          <LucideChevronRight class="h-4 w-4" />
        {/if}
        <span>More details</span>
        {#if !optionalFieldsExpanded && (editEvent.location || editEvent.url || editEvent.timezone || editEvent.attendees)}
          <span class="ml-1 text-primary">•</span>
        {/if}
      </button>

      {#if optionalFieldsExpanded}
        <div class="space-y-4 pl-6">
          <div class="space-y-2">
            <Label>Location</Label>
            <Input type="text" placeholder="Add location" bind:value={editEvent.location} />
          </div>
          <div class="space-y-2">
            <Label>URL / Video link</Label>
            <Input type="url" placeholder="https://" bind:value={editEvent.url} />
          </div>
          <div class="space-y-2">
            <Label>Time zone</Label>
            <Input type="text" placeholder="e.g., America/Chicago" bind:value={editEvent.timezone} />
          </div>
          <div class="space-y-2">
            <Label>Attendees</Label>
            <Input type="text" placeholder="Comma-separated emails" bind:value={editEvent.attendees} />
          </div>
        </div>
      {/if}
    </div>
    <Dialog.Footer class="flex-col sm:flex-row gap-2">
      <div class="hidden sm:flex gap-2 mr-auto">
        <Tooltip.Root>
          <Tooltip.Trigger>
            <Button variant="outline" size="icon" onclick={() => duplicateEvent()}>
              <LucideCopy class="h-4 w-4" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>Duplicate</p>
          </Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            <Button variant="outline" size="icon" onclick={() => exportEventAsICS(events.find(e => (e as Record<string, unknown>).id === editEvent.id) as Record<string, unknown>)}>
              <LucideDownload class="h-4 w-4" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>Export as .ics</p>
          </Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            <Button variant="outline" size="icon" class="text-destructive hover:text-destructive" onclick={() => (showDeleteConfirm = true)}>
              <LucideTrash2 class="h-4 w-4" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>Delete</p>
          </Tooltip.Content>
        </Tooltip.Root>
      </div>
      <div class="flex gap-2">
        <Button variant="ghost" onclick={() => closeModals()}>Cancel</Button>
        <Button onclick={updateEvent}>Update</Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showDeleteConfirm}>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title class="text-destructive">Delete event?</Dialog.Title>
    </Dialog.Header>
    <p class="text-sm text-muted-foreground py-4">
      This event will be permanently removed. This can't be undone.
    </p>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (showDeleteConfirm = false)}>Cancel</Button>
      <Button variant="destructive" onclick={deleteEvent}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
</Tooltip.Provider>

<style>
  .calendar-page {
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  /* Calendar content area - explicit height calculation */
  .calendar-content {
    height: calc(100vh - 65px);
    height: calc(100dvh - 65px);
  }

  .sx-wrapper {
    width: 100%;
    max-width: 100%;
    /* Explicit height calculation: viewport - header (65px) - padding (32px) - privacy notice (~52px) */
    height: calc(100vh - 150px);
    height: calc(100dvh - 150px);
    min-height: 400px;
    overflow: hidden; /* Only hide overflow at this level, scrolling happens inside */
  }

  /* The ScheduleXCalendar component adds an extra div wrapper */
  .sx-wrapper > :global(div) {
    height: 100% !important;
  }

  /* Make all schedule-x containers fill available height */
  .sx-wrapper :global(.sx-svelte-calendar-wrapper) {
    height: 100% !important;
  }

  .sx-wrapper :global(.sx__calendar-wrapper) {
    height: 100% !important;
  }

  .sx-wrapper :global(.sx__calendar) {
    height: 100% !important;
    display: flex;
    flex-direction: column;
  }

  .sx-wrapper :global(.sx__calendar-header) {
    flex-shrink: 0;
  }

  .sx-wrapper :global(.sx__view-container) {
    flex: 1 1 0% !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
  }

  /* Month view - make weeks fill the grid evenly */
  .sx-wrapper :global(.sx__month-grid-wrapper) {
    height: 100% !important;
    display: flex;
    flex-direction: column;
  }

  .sx-wrapper :global(.sx__month-grid-week) {
    flex: 1;
    min-height: 0;
  }

  .sx-wrapper :global(.sx__month-grid-day) {
    height: 100% !important;
  }

  /* Week and Day views - set CSS variables for proper height */
  .sx-wrapper :global(.sx__week-wrapper),
  .sx-wrapper :global(.sx__day-wrapper) {
    --sx-week-grid-hour-height: 60px !important;
    --sx-week-grid-height: 1440px !important; /* 24 hours * 60px */
    position: relative !important;
  }

  .sx-wrapper :global(.sx__week-header),
  .sx-wrapper :global(.sx__week-grid__date-axis) {
    position: sticky !important;
    top: 0 !important;
    z-index: 10 !important;
    background: inherit !important;
  }

  /* Week grid - needs explicit height for content */
  .sx-wrapper :global(.sx__week-grid) {
    height: var(--sx-week-grid-height, 1440px) !important;
    min-height: 1440px !important;
    overflow: visible !important;
  }

  /* Time axis styling */
  .sx-wrapper :global(.sx__week-grid__time-axis) {
    height: var(--sx-week-grid-height, 1440px) !important;
  }

  .sx-wrapper :global(.sx__week-grid__hour) {
    height: var(--sx-week-grid-hour-height, 60px) !important;
  }

  /* Time grid day columns */
  .sx-wrapper :global(.sx__time-grid-day) {
    height: var(--sx-week-grid-height, 1440px) !important;
    min-height: 1440px !important;
  }

  /* All-day events section should not grow */
  .sx-wrapper :global(.sx__all-day-wrapper) {
    flex-shrink: 0 !important;
    max-height: 100px;
    overflow-y: auto;
  }

  /* Override schedule-x primary colors */
  .sx-wrapper :global(.sx__time-grid-event),
  .sx-wrapper :global(.sx__month-grid-event) {
    --sx-color-primary: #1c7ed6 !important;
    --sx-color-primary-container: #e7f5ff !important;
    --sx-color-on-primary-container: #1864ab !important;
  }

  /* Dark mode overrides - event labels with better visibility */
  .sx-wrapper.is-dark :global(.sx__time-grid-event),
  .sx-wrapper.is-dark :global(.sx__month-grid-event) {
    --sx-color-primary: #60a5fa !important;
    --sx-color-primary-container: #1e40af !important;
    --sx-color-on-primary-container: #e0f2fe !important;
  }

  /* Dark mode calendar background and text colors */
  .sx-wrapper.is-dark {
    --sx-color-surface: oklch(0.129 0.042 264.695) !important;
    --sx-color-on-surface: #e2e8f0 !important;
    --sx-color-surface-container-low: oklch(0.178 0.042 265.755) !important;
    --sx-color-on-surface-variant: #94a3b8 !important;
    --sx-color-outline: #334155 !important;
    --sx-color-outline-variant: #334155 !important;
    background: oklch(0.129 0.042 264.695) !important;
    color: #e2e8f0 !important;
  }

  .sx-wrapper.is-dark :global(.sx__calendar-wrapper),
  .sx-wrapper.is-dark :global(.sx__month-grid-wrapper),
  .sx-wrapper.is-dark :global(.sx__week-grid),
  .sx-wrapper.is-dark :global(.sx__time-grid-wrapper) {
    background: oklch(0.129 0.042 264.695) !important;
  }

  .sx-wrapper.is-dark :global(.sx__calendar-header),
  .sx-wrapper.is-dark :global(.sx__date-grid-wrapper) {
    background: oklch(0.178 0.042 265.755) !important;
    border-color: #334155 !important;
  }

  .sx-wrapper.is-dark :global(.sx__month-grid-day),
  .sx-wrapper.is-dark :global(.sx__time-grid-day) {
    border-color: #334155 !important;
  }

  .sx-wrapper.is-dark :global(.sx__month-grid-cell) {
    border-color: #334155 !important;
  }

  .sx-wrapper.is-dark :global(button),
  .sx-wrapper.is-dark :global(.sx__date-grid-day) {
    color: #e2e8f0 !important;
  }

  .sx-wrapper.is-dark :global(.sx__time-grid-event),
  .sx-wrapper.is-dark :global(.sx__month-grid-event) {
    background: #1e40af !important;
    color: #e0f2fe !important;
    border-left: 3px solid #60a5fa !important;
  }

  /* Calendar Grid Hover States */
  .sx-wrapper :global(.sx__time-grid-day:hover) {
    background: rgba(59, 130, 246, 0.03);
    transition: background 0.15s ease;
  }

  .sx-wrapper.is-dark :global(.sx__time-grid-day:hover) {
    background: rgba(96, 165, 250, 0.08);
  }

  .sx-wrapper :global(.sx__month-grid-cell:hover) {
    background: rgba(59, 130, 246, 0.05);
    transition: background 0.15s ease;
    cursor: pointer;
  }

  .sx-wrapper.is-dark :global(.sx__month-grid-cell:hover) {
    background: rgba(96, 165, 250, 0.1);
  }

  .sx-wrapper :global(.sx__time-grid-event),
  .sx-wrapper :global(.sx__month-grid-event) {
    border-radius: 6px;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .sx-wrapper :global(.sx__time-grid-event:hover),
  .sx-wrapper :global(.sx__month-grid-event:hover) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    cursor: pointer;
  }

  .sx-wrapper.is-dark :global(.sx__time-grid-event:hover),
  .sx-wrapper.is-dark :global(.sx__month-grid-event:hover) {
    background: #2563eb !important;
    box-shadow: 0 4px 16px rgba(96, 165, 250, 0.25);
  }

  .sx-wrapper :global(.sx__date-grid-cell.sx__is-today) {
    font-weight: 700;
  }

  .sx-wrapper.is-dark :global(.sx__date-grid-cell.sx__is-today) {
    color: #60a5fa !important;
  }

  .sx-wrapper :global(.sx__month-grid-cell:focus-visible) {
    outline: 2px solid #3b82f6;
    outline-offset: -2px;
    background: rgba(59, 130, 246, 0.1);
  }

  .sx-wrapper.is-dark :global(.sx__month-grid-cell:focus-visible) {
    outline-color: #60a5fa;
    background: rgba(96, 165, 250, 0.15);
  }

  /* Fix view selector dropdown z-index - needs to be above sticky headers */
  .sx-wrapper :global(.sx__view-selection),
  .sx-wrapper :global(.sx__view-selection__item),
  .sx-wrapper :global(.sx__range-heading),
  .sx-wrapper :global([class*="view-selection"]) {
    z-index: 100 !important;
    position: relative;
  }

  .sx-wrapper :global(.sx__calendar-header) {
    z-index: 50 !important;
    position: relative;
  }
</style>
