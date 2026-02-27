/**
 * Forward Email – Demo Mode Manager
 *
 * Provides a complete sandboxed demo experience. When demo mode is active:
 *   1. All API requests are intercepted and served from fake data
 *   2. Write operations (send, move, delete, etc.) show a toast notification
 *      linking to https://forwardemail.net for sign-up
 *   3. The user can exit demo mode at any time
 *
 * Demo mode is activated via the "Try Demo" button on the Login page and
 * persisted in localStorage so it survives page reloads within the same session.
 */

import {
  DEMO_EMAIL,
  DEMO_STORAGE_KEY,
  generateFolders,
  generateMessages,
  generateContacts,
  generateCalendarEvents,
  generateAccountInfo,
  generateLabels,
} from './demo-data';
import { Local, Accounts } from './storage';

// ── State ─────────────────────────────────────────────────────────────────

let _active = false;
let _toasts = null;

const SIGN_UP_URL = 'https://forwardemail.net';
const BLOCKED_MSG = 'Action not available in demo account. Sign up at https://forwardemail.net';

// Actions that are read-only and should return fake data
const READ_ACTIONS = new Set([
  'Folders',
  'FolderGet',
  'MessageList',
  'Message',
  'Contacts',
  'Calendars',
  'Calendar',
  'CalendarEvents',
  'Labels',
  'Account',
]);

// Write actions that are silently blocked (no toast) — background ops like mark-as-read
const SILENT_WRITE_ACTIONS = new Set(['MessageUpdate']);

// Actions that are write operations and should be blocked with toast
const WRITE_ACTIONS = new Set([
  'Emails',
  'EmailCancel',
  'FolderCreate',
  'FolderUpdate',
  'FolderDelete',
  'MessageDelete',
  'ContactsCreate',
  'ContactsUpdate',
  'ContactsDelete',
  'CalendarUpdate',
  'CalendarEventCreate',
  'CalendarEventUpdate',
  'CalendarEventDelete',
  'LabelsCreate',
  'LabelsUpdate',
  'AccountUpdate',
]);

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Check if demo mode is currently active.
 */
export function isDemoMode() {
  if (_active) return true;
  try {
    return localStorage.getItem(DEMO_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Activate demo mode. Sets up fake credentials in storage so the
 * rest of the app thinks a real user is logged in.
 */
export function activateDemoMode() {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, '1');
  } catch {
    // localStorage unavailable
  }

  _active = true;
}

/**
 * Deactivate demo mode and clean up all demo state.
 */
export function deactivateDemoMode() {
  _active = false;
  try {
    localStorage.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Set the toast host reference so we can show notifications.
 * Called from main.ts after the toast host is created.
 */
export function setDemoToasts(toasts) {
  _toasts = toasts;
}

/**
 * Show the "not available in demo" toast with a sign-up action button.
 * If the user clicks the action, we log them out and open the sign-up page.
 */
export function showDemoBlockedToast(actionLabel) {
  if (!_toasts) {
    console.warn('[demo] Toast host not available');
    return;
  }

  const label = actionLabel
    ? `"${actionLabel}" is not available in demo mode. Sign up at forwardemail.net`
    : BLOCKED_MSG;

  _toasts.show(label, 'warning', {
    duration: 15000,
    action: {
      label: 'Sign Up',
      callback: () => {
        exitDemoAndRedirect();
      },
    },
  });
}

/**
 * Exit demo mode, clear credentials, and redirect to sign-up page.
 */
export function exitDemoAndRedirect() {
  deactivateDemoMode();

  // Clear demo credentials from storage
  try {
    Accounts.remove(DEMO_EMAIL);
    Local.remove('email');
    Local.remove('alias_auth');
    Local.remove('api_token');
  } catch {
    // Best effort cleanup
  }

  // Clear tab-scoped session keys
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }

  // Open sign-up page
  window.open(SIGN_UP_URL, '_blank', 'noopener,noreferrer');

  // Navigate to login
  window.location.hash = '#/login';
  window.location.reload();
}

/**
 * Intercept a Remote.request() call in demo mode.
 * Returns { handled: true, result: ... } if we handled it,
 * or { handled: false } if the real API should be called.
 */
export function interceptDemoRequest(action, params = {}, options = {}) {
  if (!isDemoMode()) return { handled: false };

  // Extract message ID from pathOverride if present (e.g. /v1/messages/demo-1?folder=INBOX)
  if (action === 'Message' && options?.pathOverride) {
    const match = options.pathOverride.match(/\/v1\/messages\/([^?]+)/);
    if (match) params = { ...params, id: decodeURIComponent(match[1]) };
    const folderMatch = options.pathOverride.match(/folder=([^&]+)/);
    if (folderMatch) params = { ...params, folder: decodeURIComponent(folderMatch[1]) };
  }

  // Handle read actions with fake data
  if (READ_ACTIONS.has(action)) {
    return { handled: true, result: getDemoData(action, params) };
  }

  // Silently block background write actions (no toast, no error)
  if (SILENT_WRITE_ACTIONS.has(action)) {
    return { handled: true, result: { ok: true, demo: true } };
  }

  // Block write actions with toast
  if (WRITE_ACTIONS.has(action)) {
    const friendlyName = getFriendlyActionName(action);
    showDemoBlockedToast(friendlyName);
    // Return handled with a special demo marker so Remote.request can
    // return without making a real API call.  The toast is the feedback.
    return { handled: true, result: { ok: false, demo: true, blocked: true } };
  }

  // Unknown action — let it through (it will likely fail with fake auth,
  // which is fine since the user is in demo mode)
  return { handled: false };
}

// ── Data Generators ───────────────────────────────────────────────────────

function getDemoData(action, params) {
  switch (action) {
    case 'Folders':
      return generateFolders();

    case 'FolderGet': {
      const folders = generateFolders();
      const id = params?.id || params?.path;
      return folders.find((f) => f.id === id || f.path === id) || folders[0];
    }

    case 'MessageList':
    case 'Message': {
      const folder = params?.folder || params?.mailbox || params?.path || 'INBOX';
      const page = Number(params?.page) || 1;
      const messages = generateMessages(folder, page);
      if (action === 'Message' && params?.id) {
        return messages.find((m) => m.id === params.id) || messages[0] || null;
      }

      // Return in the format expected by mailboxStore.ts:
      // source === 'main' path reads: res?.Result?.List || res?.Result || res || []
      // So we return the array directly so `res || []` gives the array.
      return messages;
    }

    case 'Contacts':
      return generateContacts();

    case 'Calendars':
    case 'Calendar':
      return [
        { id: 'demo-calendar', name: 'Personal', color: '#3b82f6', description: 'Demo calendar' },
      ];

    case 'CalendarEvents':
      return generateCalendarEvents();

    case 'Labels':
      return generateLabels();

    case 'Account':
      return generateAccountInfo();

    default:
      return null;
  }
}

function getFriendlyActionName(action) {
  const names = {
    Emails: 'Send email',
    EmailCancel: 'Cancel email',
    FolderCreate: 'Create folder',
    FolderUpdate: 'Update folder',
    FolderDelete: 'Delete folder',
    MessageUpdate: 'Update message',
    MessageDelete: 'Delete message',
    ContactsCreate: 'Create contact',
    ContactsUpdate: 'Update contact',
    ContactsDelete: 'Delete contact',
    CalendarUpdate: 'Update calendar',
    CalendarEventCreate: 'Create event',
    CalendarEventUpdate: 'Update event',
    CalendarEventDelete: 'Delete event',
    LabelsCreate: 'Create label',
    LabelsUpdate: 'Update label',
    AccountUpdate: 'Update account',
  };
  return names[action] || action;
}
