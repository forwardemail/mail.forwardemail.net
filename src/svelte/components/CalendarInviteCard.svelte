<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import Clock from '@lucide/svelte/icons/clock';
  import MapPin from '@lucide/svelte/icons/map-pin';
  import Users from '@lucide/svelte/icons/users';
  import CheckCircle2 from '@lucide/svelte/icons/check-circle-2';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import { onMount } from 'svelte';
  import { Remote } from '../../utils/remote';
  import { Local } from '../../utils/storage';
  import { db } from '../../utils/db';
  import { queueEmail } from '../../utils/outbox-service';
  import {
    normalizeIcsForCalendar,
    buildReplyIcs,
    findMatchingCachedEvent,
    findConflictingEvents,
    type ParsedInvite,
    type RsvpStatus,
  } from '../../utils/ics-parser';

  interface Props {
    invite: ParsedInvite;
    onAdded?: () => void;
  }

  let { invite, onAdded }: Props = $props();

  let saving = $state(false);
  let added = $state(false);
  let removed = $state(false);
  let rsvpSending = $state<RsvpStatus | null>(null);
  let rsvpSent = $state<RsvpStatus | null>(null);
  let error = $state('');
  let cachedEventMatch = $state<Record<string, unknown> | null>(null);
  let conflicts = $state<Array<Record<string, unknown>>>([]);

  const isCancel = $derived(invite.method === 'CANCEL');

  const userEmail = $derived.by(() => {
    const aliasAuth = Local.get('alias_auth') || '';
    const aliasEmail = aliasAuth.includes(':') ? aliasAuth.split(':')[0] : aliasAuth;
    return (aliasEmail || Local.get('email') || '').toLowerCase();
  });

  const userIsOrganizer = $derived(
    !!(invite.organizer?.email && invite.organizer.email.toLowerCase() === userEmail),
  );

  const acceptedCount = $derived(
    invite.attendees.filter((a) => (a.partstat || '').toUpperCase() === 'ACCEPTED').length,
  );

  const partstatLabel = (p?: string): string => {
    switch ((p || '').toUpperCase()) {
      case 'ACCEPTED':
        return 'Yes';
      case 'DECLINED':
        return 'No';
      case 'TENTATIVE':
        return 'Maybe';
      case 'NEEDS-ACTION':
        return 'Pending';
      default:
        return p || '';
    }
  };

  const formatRange = (start: Date | null, end: Date | null, allDay: boolean): string => {
    if (!start) return '';
    const dateOpts: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    };
    const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    if (allDay || !end) {
      return start.toLocaleDateString(undefined, dateOpts);
    }
    const sameDay = start.toDateString() === end.toDateString();
    const startStr = `${start.toLocaleDateString(undefined, dateOpts)} · ${start.toLocaleTimeString(undefined, timeOpts)}`;
    if (sameDay) {
      return `${startStr} – ${end.toLocaleTimeString(undefined, timeOpts)}`;
    }
    return `${startStr} – ${end.toLocaleDateString(undefined, dateOpts)} ${end.toLocaleTimeString(undefined, timeOpts)}`;
  };

  const getCalId = (cal: unknown): string =>
    ((cal as Record<string, unknown>)?.id ||
      (cal as Record<string, unknown>)?.calendar_id ||
      (cal as Record<string, unknown>)?.uid ||
      '') as string;

  const getCalLabel = (cal: unknown): string =>
    ((cal as Record<string, unknown>)?.summary ||
      (cal as Record<string, unknown>)?.name ||
      (cal as Record<string, unknown>)?.label ||
      '') as string;

  const extractList = (response: unknown): unknown[] => {
    if (Array.isArray(response)) return response;
    const r = response as { Result?: unknown[]; calendars?: unknown[] };
    return r?.Result || r?.calendars || [];
  };

  const extractEventsList = (response: unknown): unknown[] => {
    if (Array.isArray(response)) return response;
    const r = response as { Result?: unknown[]; events?: unknown[] };
    return r?.Result || r?.events || [];
  };

  // Walks the server's paginated event list looking for a matching UID.
  // The server auto-imports incoming text/calendar invites, so a cache-only
  // lookup misses the freshly-imported event and would create a duplicate.
  const fetchEventByUid = async (uid: string): Promise<Record<string, unknown> | null> => {
    if (!uid) return null;
    const target = uid.toLowerCase();
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let resp: unknown;
      try {
        resp = await Remote.request('CalendarEvents', { page, limit: PAGE_SIZE });
      } catch {
        return null;
      }
      const list = extractEventsList(resp) as Array<Record<string, unknown>>;
      const match = list.find((ev) => {
        const candidates = [ev.uid, ev.UID, ev.id, ev.event_id];
        return candidates.some((c) => typeof c === 'string' && c.toLowerCase() === target);
      });
      if (match) return match;
      if (list.length < PAGE_SIZE) return null;
    }
    return null;
  };

  const pickCalendarId = (list: unknown[]): string => {
    if (!Array.isArray(list) || list.length === 0) return '';
    const preferred = list.find((c) => getCalLabel(c) === 'Calendar');
    return getCalId(preferred || list[0]);
  };

  const accountKey = (): string => (Local.get('email') as string) || 'default';

  onMount(async () => {
    try {
      const all = await db.meta.get(`calendar_events_${accountKey()}_all`);
      const events = (all?.value as Array<Record<string, unknown>>) || [];
      cachedEventMatch = findMatchingCachedEvent(invite, events);
      conflicts = findConflictingEvents(invite, events);
    } catch {
      // cache miss is fine — Phase 1 still works
    }
  });

  const dispatchCalendarChange = (action: 'created' | 'updated' | 'deleted') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('webmail:calendar-events-changed', {
        detail: { uid: invite.uid, action },
      }),
    );
  };

  const persistAddedToCache = async (calendarId: string, response: Record<string, unknown>) => {
    try {
      const cacheKey = `calendar_events_${accountKey()}_all`;
      const cached = await db.meta.get(cacheKey);
      const list = ((cached?.value as Array<Record<string, unknown>>) || []).filter(
        (ev) => String(ev.uid || ev.id || '') !== invite.uid,
      );
      const newId =
        (response?.id as string) ||
        (response?.uid as string) ||
        (response?.event_id as string) ||
        invite.uid;
      const newEntry: Record<string, unknown> = {
        id: newId,
        uid: invite.uid,
        title: invite.summary,
        start: invite.startDate?.toISOString() || '',
        end: invite.endDate?.toISOString() || '',
        calendarId,
        location: invite.location,
        url: invite.url,
        raw: response || { uid: invite.uid },
      };
      await db.meta.put({
        key: cacheKey,
        value: [...list, newEntry],
        updatedAt: Date.now(),
      });
      cachedEventMatch = newEntry;
    } catch {
      // cache write failures don't break the flow
    }
  };

  const handleAdd = async () => {
    if (saving || added) return;
    saving = true;
    error = '';
    try {
      const calendarsResp = await Remote.request('Calendars', {});
      const list = extractList(calendarsResp);
      const calendarId = pickCalendarId(list);
      if (!calendarId) {
        error = 'No calendar found. Open the Calendar page first.';
        saving = false;
        return;
      }
      const ical = normalizeIcsForCalendar(invite.raw);

      // Authoritative server-side UID check: catches both a stale local cache
      // and the server's own auto-import of incoming invites. Without this,
      // clicking "Add" after the server has already imported produces a duplicate.
      const remoteMatch = await fetchEventByUid(invite.uid);
      const matchId =
        (remoteMatch?.id as string) ||
        (remoteMatch?.uid as string) ||
        (cachedEventMatch?.id as string) ||
        '';
      const wasUpdate = !!matchId;
      if (remoteMatch) cachedEventMatch = remoteMatch;

      let response: Record<string, unknown> = {};
      if (wasUpdate) {
        response =
          ((await Remote.request(
            'CalendarEventUpdate',
            { id: matchId, calendar_id: calendarId, ical },
            { method: 'PUT', pathOverride: `/v1/calendar-events/${matchId}` },
          )) as Record<string, unknown>) || {};
      } else {
        response =
          ((await Remote.request(
            'CalendarEventCreate',
            { calendar_id: calendarId, ical },
            { method: 'POST' },
          )) as Record<string, unknown>) || {};
      }
      await persistAddedToCache(calendarId, response);
      dispatchCalendarChange(wasUpdate ? 'updated' : 'created');
      added = true;
      onAdded?.();
    } catch (err) {
      error = (err as Error)?.message || 'Failed to add event.';
    } finally {
      saving = false;
    }
  };

  const handleRemove = async () => {
    if (saving || removed) return;
    if (!cachedEventMatch?.id) {
      error = 'No matching event found on your calendar.';
      return;
    }
    saving = true;
    error = '';
    try {
      const persistId = String(cachedEventMatch.id);
      const calendarId =
        (cachedEventMatch.calendarId as string) || (cachedEventMatch.calendar_id as string) || '';
      await Remote.request(
        'CalendarEventDelete',
        { calendar_id: calendarId },
        { method: 'DELETE', pathOverride: `/v1/calendar-events/${persistId}` },
      );
      try {
        const cacheKey = `calendar_events_${accountKey()}_all`;
        const cached = await db.meta.get(cacheKey);
        const list = ((cached?.value as Array<Record<string, unknown>>) || []).filter(
          (ev) => String(ev.id || '') !== persistId && String(ev.uid || '') !== invite.uid,
        );
        await db.meta.put({ key: cacheKey, value: list, updatedAt: Date.now() });
      } catch {
        // cache update failure is non-fatal
      }
      cachedEventMatch = null;
      removed = true;
      dispatchCalendarChange('deleted');
    } catch (err) {
      error = (err as Error)?.message || 'Failed to remove event.';
    } finally {
      saving = false;
    }
  };

  const sendRsvp = async (partstat: RsvpStatus) => {
    if (rsvpSending || rsvpSent) return;
    if (!userEmail || !invite.organizer?.email) {
      error = 'Cannot send RSVP — missing organizer or account email.';
      return;
    }
    rsvpSending = partstat;
    error = '';
    try {
      const replyIcs = buildReplyIcs(invite, userEmail, partstat);
      if (!replyIcs) {
        error = 'Failed to build RSVP.';
        rsvpSending = null;
        return;
      }
      const verb =
        partstat === 'ACCEPTED' ? 'Accepted' : partstat === 'DECLINED' ? 'Declined' : 'Tentative';
      const subject = `${verb}: ${invite.summary || 'Event'}`;
      const text = `${verb} the invitation: ${invite.summary || 'Event'}.`;
      const html = `<p>${verb} the invitation: <strong>${invite.summary || 'Event'}</strong>.</p>`;
      const filename = (invite.summary || 'invite').replace(/[^a-z0-9]/gi, '_') || 'invite';
      const base64 = btoa(unescape(encodeURIComponent(replyIcs)));
      await queueEmail({
        from: userEmail,
        to: [invite.organizer.email],
        subject,
        text,
        html,
        attachments: [
          {
            filename: `${filename}.ics`,
            contentType: 'text/calendar; method=REPLY; charset=UTF-8',
            content: base64,
            encoding: 'base64',
          },
        ],
        has_attachment: true,
        save_sent: true,
      });
      rsvpSent = partstat;
    } catch (err) {
      error = (err as Error)?.message || 'Failed to send RSVP.';
    } finally {
      rsvpSending = null;
    }
  };
</script>

<Card.Root class={isCancel ? 'border-destructive/50' : 'border-primary/40'}>
  <Card.Header class="pb-3">
    <div class="flex items-start gap-3">
      <CalendarIcon
        class="mt-0.5 h-5 w-5 shrink-0 {isCancel ? 'text-destructive' : 'text-primary'}"
      />
      <div class="min-w-0 flex-1">
        <Card.Title class="truncate text-base">
          {#if isCancel}Cancelled:
          {/if}{invite.summary || 'Calendar invite'}
        </Card.Title>
        {#if invite.organizer?.email}
          <Card.Description class="truncate">
            From {invite.organizer.name || invite.organizer.email}
          </Card.Description>
        {/if}
      </div>
      {#if invite.method && invite.method !== 'PUBLISH'}
        <Badge variant={isCancel ? 'destructive' : 'secondary'} class="shrink-0 text-xs">
          {invite.method}
        </Badge>
      {/if}
    </div>
  </Card.Header>

  <Card.Content class="space-y-2 text-sm">
    {#if invite.startDate}
      <div class="flex items-start gap-2">
        <Clock class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span>{formatRange(invite.startDate, invite.endDate, invite.allDay)}</span>
      </div>
    {/if}
    {#if invite.location}
      <div class="flex items-start gap-2">
        <MapPin class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="break-words">{invite.location}</span>
      </div>
    {/if}
    {#if invite.attendees.length}
      <div class="flex items-start gap-2">
        <Users class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="text-muted-foreground">
          {invite.attendees.length} attendee{invite.attendees.length === 1 ? '' : 's'}
          {#if acceptedCount > 0}
            · {acceptedCount} accepted
          {/if}
        </span>
      </div>
    {/if}
    {#if invite.recurrence}
      <div class="text-xs text-muted-foreground">Recurring: {invite.recurrence}</div>
    {/if}
    {#if conflicts.length > 0 && !isCancel}
      <div
        class="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          You have {conflicts.length} other event{conflicts.length === 1 ? '' : 's'} at this time.
        </span>
      </div>
    {/if}
  </Card.Content>

  <Card.Footer class="flex flex-col gap-3 pt-3">
    {#if isCancel}
      {#if removed}
        <div class="flex w-full items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 class="h-4 w-4" />
          Removed from your calendar
        </div>
      {:else if cachedEventMatch}
        <Button
          variant="destructive"
          onclick={handleRemove}
          disabled={saving}
          class="w-full sm:w-auto"
        >
          {saving ? 'Removing…' : 'Remove from calendar'}
        </Button>
      {:else}
        <span class="text-xs text-muted-foreground">
          This invitation was cancelled by the organizer.
        </span>
      {/if}
    {:else}
      <div class="flex w-full flex-wrap items-center gap-2">
        {#if added}
          <span class="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 class="h-4 w-4" />
            {cachedEventMatch ? 'Updated on your calendar' : 'Added to your calendar'}
          </span>
        {:else}
          <Button onclick={handleAdd} disabled={saving} class="flex-1 sm:flex-none">
            {#if saving}
              {cachedEventMatch ? 'Updating…' : 'Adding…'}
            {:else}
              {cachedEventMatch ? 'Update event' : 'Add to calendar'}
            {/if}
          </Button>
        {/if}
      </div>

      {#if !userIsOrganizer && invite.organizer?.email && userEmail}
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            RSVP
          </span>
          <div class="flex flex-wrap gap-2">
            <Button
              variant={rsvpSent === 'ACCEPTED' ? 'default' : 'outline'}
              size="sm"
              disabled={!!rsvpSent || !!rsvpSending}
              onclick={() => sendRsvp('ACCEPTED')}
            >
              {rsvpSending === 'ACCEPTED' ? 'Sending…' : 'Yes'}
            </Button>
            <Button
              variant={rsvpSent === 'TENTATIVE' ? 'default' : 'outline'}
              size="sm"
              disabled={!!rsvpSent || !!rsvpSending}
              onclick={() => sendRsvp('TENTATIVE')}
            >
              {rsvpSending === 'TENTATIVE' ? 'Sending…' : 'Maybe'}
            </Button>
            <Button
              variant={rsvpSent === 'DECLINED' ? 'default' : 'outline'}
              size="sm"
              disabled={!!rsvpSent || !!rsvpSending}
              onclick={() => sendRsvp('DECLINED')}
            >
              {rsvpSending === 'DECLINED' ? 'Sending…' : 'No'}
            </Button>
          </div>
          {#if rsvpSent}
            <span class="text-xs text-muted-foreground">
              Reply queued: {partstatLabel(rsvpSent)}
            </span>
          {/if}
        </div>
      {/if}
    {/if}

    {#if error}
      <p class="text-xs text-destructive">{error}</p>
    {/if}
  </Card.Footer>
</Card.Root>
