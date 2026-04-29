/**
 * Forward Email — Task Reminders (Phase 1, client-side)
 *
 * Schedules local notifications (Tauri or Web) for VTODO tasks based on
 * VALARM blocks stored on each task's ICS.  Reads upcoming triggers, sets
 * a setTimeout per task, and fires `notify()` from notification-bridge
 * when due.
 *
 * Scope (Phase 1):
 *   - Only fires while the app is running. Web push and OS-level scheduled
 *     notifications are deferred to Phase 2.
 *   - Browser caveat: Chromium throttles setTimeout in backgrounded tabs
 *     (clamped to ~1/min after 5 min hidden, suspended after longer). To
 *     compensate, we listen for `visibilitychange` and on visible we fire
 *     any reminders whose trigger time has passed since we went hidden.
 *     This means notifications may be delivered late (when you return to
 *     the tab) rather than not at all — but they still get delivered.
 *   - Single VALARM per task (the chip selector emits one).  The parser
 *     here grabs the first VALARM TRIGGER it finds.
 *   - Skips completed tasks and tasks whose trigger time is more than
 *     1 hour in the past (avoids notification spam after a long sleep).
 *
 * TODO Phase 2 (server-side):
 *   - Backend extracts VALARM into a queryable `alarms[]` field on the
 *     CalendarEvents model (parked code at caldav-server.js:622+).
 *   - Bree job ticks every minute, finds alarms whose next_trigger_at
 *     falls in (last_tick, now], fans out to per-device push subscriptions
 *     (Web Push for browser/desktop, FCM/APNs for mobile, WS for live
 *     clients).
 *   - This client module then dedupes against server-delivered reminders
 *     (idempotency key = `task_uid + trigger_offset`) so the user sees one
 *     notification regardless of which transport won the race.
 */

import { notify, requestPermission } from './notification-bridge.js';

type TaskLike = Record<string, unknown>;

// Grace window for past triggers — we still fire reminders up to 1 hour
// late. Necessary because backgrounded tabs throttle/suspend setTimeout,
// so the visibility-regain catch-up may run well after the trigger time.
const PAST_GRACE_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout max (~24.8 days)

// Set localStorage `debug:reminders` to '1' to log scheduling activity.
const debug = (...args: unknown[]) => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('debug:reminders') === '1') {
      console.info('[task-reminders]', ...args);
    }
  } catch {
    /* ignore */
  }
};

interface ScheduledReminder {
  timeoutId: ReturnType<typeof setTimeout>;
  triggerAt: number;
  task: TaskLike;
  due: Date;
}

const scheduled = new Map<string, ScheduledReminder>();
const fired = new Set<string>(); // dedupe across re-schedule cycles

let permissionRequested = false;
let visibilityHandlerInstalled = false;

function getComponentType(item: TaskLike): 'VTODO' | 'VEVENT' | '' {
  const t = String(item.componentType || '').toUpperCase();
  return t === 'VTODO' || t === 'VEVENT' ? t : '';
}

function isCompleted(task: TaskLike): boolean {
  const status = String(task.status || '').toUpperCase();
  if (status === 'COMPLETED') return true;
  if (Number(task.percentComplete || 0) >= 100) return true;
  if (task.completedAt) return true;
  return false;
}

// Anchor time the VALARM trigger is relative to:
//   VTODO  → DUE (we store endISO as the DUE)
//   VEVENT → DTSTART
function getAnchorDate(item: TaskLike): Date | null {
  const componentType = getComponentType(item);
  const raw =
    componentType === 'VEVENT' ? item.start || item.dtstart : item.end || item.due || item.start;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw as string);
  return Number.isFinite(d.getTime()) ? d : null;
}

function getTaskUid(task: TaskLike): string {
  return String(task.id || task.uid || (task.raw as TaskLike | undefined)?.uid || '');
}

// Parse first VALARM TRIGGER from the ICS (VTODO or VEVENT) into
// minutes-before-anchor. Mirrors the parser in Calendar.svelte.
function parseReminderMinutes(ical: unknown, kind: 'VTODO' | 'VEVENT' = 'VTODO'): number {
  if (typeof ical !== 'string' || !ical) return 0;
  const re = kind === 'VEVENT' ? /BEGIN:VEVENT[\s\S]*?END:VEVENT/ : /BEGIN:VTODO[\s\S]*?END:VTODO/;
  const compMatch = ical.match(re);
  if (!compMatch) return 0;
  const triggerMatch = compMatch[0].match(/TRIGGER[^:\r\n]*:(-?P[^\r\n]+)/i);
  if (!triggerMatch) return 0;
  const dur = triggerMatch[1] ? triggerMatch[1].toUpperCase() : '';
  if (!dur) return 0;
  const negative = dur.startsWith('-');
  const body = dur.replace(/^[-+]?P/, '');
  const dayMatch = body.match(/(\d+)D/);
  const hourMatch = body.match(/(\d+)H/);
  const minMatch = body.match(/(\d+)M/);
  const total =
    (dayMatch ? Number(dayMatch[1]) * 1440 : 0) +
    (hourMatch ? Number(hourMatch[1]) * 60 : 0) +
    (minMatch ? Number(minMatch[1]) : 0);
  return negative ? total : 0;
}

function getReminderMinutes(item: TaskLike): number {
  const explicit = Number(item.notify || item.reminder || 0);
  if (explicit > 0) return explicit;
  const ical = (item.raw as TaskLike | undefined)?.ical || (item as TaskLike).ical;
  const kind = getComponentType(item) || 'VTODO';
  return parseReminderMinutes(ical, kind);
}

function clearAllScheduled(): void {
  for (const { timeoutId } of scheduled.values()) {
    clearTimeout(timeoutId);
  }
  scheduled.clear();
}

function scheduleOne(task: TaskLike): void {
  const componentType = getComponentType(task);
  if (!componentType) {
    debug('skip: unknown component type', { uid: getTaskUid(task) });
    return;
  }
  // Tasks: skip when completed. Events: no completion concept.
  if (componentType === 'VTODO' && isCompleted(task)) {
    debug('skip: completed task', { uid: getTaskUid(task) });
    return;
  }
  const due = getAnchorDate(task);
  if (!due) {
    debug('skip: no anchor date', {
      uid: getTaskUid(task),
      kind: componentType,
      title: task.title,
    });
    return;
  }
  const minutes = getReminderMinutes(task);
  if (minutes <= 0) {
    debug('skip: no reminder set', { uid: getTaskUid(task), title: task.title });
    return;
  }

  const triggerAt = due.getTime() - minutes * 60 * 1000;
  const now = Date.now();
  const delta = triggerAt - now;

  // Past trigger beyond grace window — drop silently (user shouldn't be
  // pinged hours late on app reload).
  if (delta < -PAST_GRACE_MS) {
    debug('skip: trigger in the past', {
      uid: getTaskUid(task),
      title: task.title,
      triggerAt: new Date(triggerAt).toISOString(),
      minutesLate: Math.round(-delta / 60000),
    });
    return;
  }

  const uid = getTaskUid(task);
  if (!uid) return;
  const key = `${uid}:${minutes}:${triggerAt}`;

  if (fired.has(key)) {
    debug('skip: already fired', { key });
    return;
  }
  if (scheduled.has(key)) return;

  // Clamp to setTimeout's max (~24.8 days). For tasks beyond that horizon,
  // refreshTaskReminders will reschedule on next app load / event change.
  const fireDelay = Math.max(0, Math.min(delta, MAX_TIMEOUT_MS));
  debug('schedule', {
    uid,
    title: task.title,
    due: due.toISOString(),
    triggerAt: new Date(triggerAt).toISOString(),
    minutesUntilFire: Math.round(delta / 60000),
  });
  const timeoutId = setTimeout(() => {
    fired.add(key);
    scheduled.delete(key);
    fire(task, due);
  }, fireDelay);

  scheduled.set(key, { timeoutId, triggerAt, task, due });
}

// On visibility regain, any timer that should have fired during the
// background window may have been throttled/suspended by the browser.
// Walk all scheduled entries and fire those whose triggerAt has passed.
function catchUpOnVisibility(): void {
  if (typeof document === 'undefined' || document.hidden) return;
  const now = Date.now();
  let fireCount = 0;
  for (const [key, entry] of scheduled.entries()) {
    if (entry.triggerAt <= now && !fired.has(key)) {
      fired.add(key);
      scheduled.delete(key);
      clearTimeout(entry.timeoutId);
      fire(entry.task, entry.due);
      fireCount++;
    }
  }
  if (fireCount > 0) debug(`catch-up fired ${fireCount} reminder(s)`);
}

function ensureVisibilityHandler(): void {
  if (visibilityHandlerInstalled || typeof document === 'undefined') return;
  visibilityHandlerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) catchUpOnVisibility();
  });
}

function fire(item: TaskLike, anchor: Date): void {
  const kind = getComponentType(item);
  const title = String(
    item.title || item.summary || (kind === 'VEVENT' ? 'Event reminder' : 'Task reminder'),
  );
  const anchorLabel = anchor.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const uid = getTaskUid(item);
  const verb = kind === 'VEVENT' ? 'Starts' : 'Due';
  debug('fire', { uid, kind, title, anchor: anchor.toISOString() });
  notify({
    title,
    body: `${verb} ${anchorLabel}`,
    tag: `cal-reminder:${uid}`,
    data: {
      uid,
      path:
        kind === 'VEVENT'
          ? `/calendar#event=${encodeURIComponent(uid)}`
          : `/calendar#task=${encodeURIComponent(uid)}`,
    },
  });
}

/**
 * Refresh scheduled reminders against the current task list.
 * Call after task load, mutate, and on WS calendar-event-changed.
 *
 * Idempotent: cancels existing timers and reschedules from the latest
 * task state.  Already-fired reminders stay deduped via the `fired` set.
 */
export function refreshTaskReminders(events: TaskLike[] | undefined): void {
  if (!Array.isArray(events)) return;

  // Best-effort permission ask on first call. Doesn't block scheduling —
  // notify() itself silently no-ops when permission is denied.
  if (!permissionRequested) {
    permissionRequested = true;
    requestPermission()
      .then((p: unknown) => debug('permission', p))
      .catch((err: unknown) => debug('permission error', err));
  }

  ensureVisibilityHandler();
  clearAllScheduled();

  const reminded = events.filter((ev) => {
    const kind = getComponentType(ev);
    if (!kind) return false;
    if (kind === 'VTODO' && isCompleted(ev)) return false;
    return true;
  });
  debug(`refresh: ${reminded.length} item(s) of ${events.length} considered`);
  for (const item of reminded) {
    scheduleOne(item);
  }
}

/**
 * Tear everything down (e.g., on sign-out).
 */
export function clearTaskReminders(): void {
  clearAllScheduled();
  fired.clear();
  permissionRequested = false;
}
